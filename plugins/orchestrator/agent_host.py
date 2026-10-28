#!/usr/bin/env python3
"""Detached PTY host for a task agent: runs its interactive omp, outlives the board and every terminal, and serves
status, screen, terminate and attach on a private Unix socket in its directory."""
from __future__ import annotations

import argparse
import codecs
import fcntl
import json
import os
import re
import select
import selectors
import shlex
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
import tty
import unicodedata
import uuid
from collections import deque
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from typing import Any, Deque, Dict, Iterator, List, Optional, Tuple

from gitops import find_worktree
from runtime import agent_env, child_env, now_iso

SPEC, META, SOCKET, LOCK, LOG, SCREEN = "spec.json", "host.json", "agent.sock", "lock", "host.log", "screen.txt"
SCRIPT = str(Path(__file__).resolve())
ROWS, COLS = 48, 160
HISTORY = 2000
SCREEN_LINES = 500
FRAME_LIMIT = 1 << 20
CLIENT_BUFFER = 8 << 20
INPUT_BUFFER = 1 << 20
START_TIMEOUT = 20.0
REQUEST_TIMEOUT = 3.0
LOCK_TIMEOUT = 30.0
TERMINATE_GRACE = 5.0
DRAIN = 1.0
SOCKET_LIMIT = 103
LOG_LIMIT = 1 << 20
# Ctrl-\ as a byte, in the kitty keyboard protocol and as xterm modifyOtherKeys.
DETACH = (b"\x1c", b"\x1b[92;5u", b"\x1b[92;5:1u", b"\x1b[27;5;92~")
ALT_SCREEN = re.compile(rb"\x1b\[\?(?:1049|1047|47)([hl])")
RESTORE = ("\x1b[0m\x1b[r\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l"
           "\x1b[?1004l\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b[?7h\x1b[?25h\x1b[0 q")


class HostError(Exception):
    """An agent host couldn't be started, reached or stopped; the message says why."""


# --- files ------------------------------------------------------------------------------------------------------

def private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)


def write_private(path: Path, data: Dict[str, Any]) -> None:
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def write_text_private(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def read_json(path: Path) -> Dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


@contextmanager
def locked(directory: Path, timeout: float = LOCK_TIMEOUT) -> Iterator[None]:
    """Serializes starts and final writes of the host in `directory` across processes."""
    fd = os.open(directory / LOCK, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise HostError(f"{directory} stayed busy: another start of this agent didn't finish")
                time.sleep(0.1)
        yield
    finally:
        os.close(fd)


# --- process identity ---------------------------------------------------------------------------------------------

def ps_field(pid: int, field: str) -> Optional[str]:
    try:
        out = subprocess.run(["ps", "-o", f"{field}=", "-p", str(pid)], capture_output=True, text=True, timeout=5,
                             stdin=subprocess.DEVNULL).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return out or None


def is_host(meta: Dict[str, Any], directory: Path) -> bool:
    """Whether meta's host process still runs: same start time and command, never just a reused pid."""
    pid = meta.get("pid")
    if not isinstance(pid, int) or pid <= 1 or not meta.get("started"):
        return False
    command = ps_field(pid, "command") or ""
    return ps_field(pid, "lstart") == meta["started"] and SCRIPT in command and str(directory) in command


def is_child(meta: Dict[str, Any]) -> bool:
    pid = meta.get("child")
    return isinstance(pid, int) and pid > 1 and bool(meta.get("childStarted")) and ps_field(pid, "lstart") == meta["childStarted"]


# --- protocol -----------------------------------------------------------------------------------------------------

def frame(kind: bytes, payload: bytes) -> bytes:
    return kind + struct.pack(">I", len(payload)) + payload


def read_frames(buffer: bytearray) -> Iterator[Tuple[bytes, bytes]]:
    """Pops the complete frames off `buffer`."""
    while len(buffer) >= 5:
        size = struct.unpack(">I", bytes(buffer[1:5]))[0]
        if size > FRAME_LIMIT:
            raise HostError("oversized frame")
        if len(buffer) < 5 + size:
            return
        kind, payload = bytes(buffer[:1]), bytes(buffer[5:5 + size])
        del buffer[:5 + size]
        yield kind, payload


def connect(directory: Path, timeout: float = REQUEST_TIMEOUT) -> socket.socket:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(str(directory / SOCKET))
    except OSError:
        sock.close()
        raise
    return sock


def request(directory: Path, message: Dict[str, Any], timeout: float = REQUEST_TIMEOUT) -> Dict[str, Any]:
    with connect(directory, timeout) as sock:
        sock.sendall(frame(b"H", json.dumps(message).encode()))
        buffer = bytearray()
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                raise HostError("the agent host closed the connection")
            buffer += chunk
            for kind, payload in read_frames(buffer):
                if kind == b"J":
                    reply = json.loads(payload)
                    if not isinstance(reply, dict):
                        raise HostError("the agent host sent a malformed reply")
                    return reply


# --- client API -----------------------------------------------------------------------------------------------------

def command(action: str, directory: Path) -> str:
    """The shell command running this script's `action` (attach, launch) for the host in `directory`."""
    return shlex.join([sys.executable, SCRIPT, action, str(directory)])


def recorded(meta: Dict[str, Any], alive: bool) -> Dict[str, Any]:
    keys = ("instance", "pid", "child", "cwd", "task", "startedAt", "exitCode", "exitedAt")
    return {**{k: meta.get(k) for k in keys}, "alive": alive, "answering": False}


def status(directory: Path) -> Dict[str, Any]:
    """The host's own report when it answers; else its last record, alive only while that exact process still runs."""
    meta = read_json(directory / META)
    try:
        reply = request(directory, {"op": "status"})
        if reply.get("ok"):
            return reply
    except (OSError, ValueError, HostError):
        pass
    return recorded(meta, bool(meta) and meta.get("exitCode") is None and is_host(meta, directory))


def output(directory: Path, lines: int) -> str:
    """The last `lines` lines of the agent's screen: live from its host, else as the host left it."""
    try:
        reply = request(directory, {"op": "output", "lines": lines})
        if reply.get("ok"):
            return str(reply.get("text") or "")
    except (OSError, ValueError, HostError):
        pass
    try:
        text = (directory / SCREEN).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return "\n".join(text.splitlines()[-lines:])


def prepare(directory: Path, spec: Dict[str, Any]) -> None:
    """Records how to start the agent (argv, repo, branch, optional cwd); a host already running keeps its own spec."""
    private_dir(directory)
    with locked(directory):
        write_private(directory / SPEC, spec)


def abandon(directory: Path) -> bool:
    """Withdraws the start spec unless a host runs, so a late launcher can't start one; True when none runs."""
    with locked(directory):
        if status(directory)["alive"]:
            return False
        (directory / SPEC).unlink(missing_ok=True)
        return True


def log_tail(directory: Path) -> str:
    try:
        lines = [line for line in (directory / LOG).read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
    except OSError:
        return ""
    return lines[-1] if lines else ""


def ensure(directory: Path, cwd: Optional[str] = None) -> Dict[str, Any]:
    """Starts the agent from the directory's spec unless its host already runs, and returns the host's status. Starts
    serialize on the directory's lock, so the board and a hook's launcher racing make one host."""
    private_dir(directory)
    with locked(directory):
        current = status(directory)
        if current["alive"]:
            return current
        if current.get("answering"):
            # Its agent exited and the host is finishing: let it go before the socket is reused.
            deadline = time.monotonic() + DRAIN + 2
            while status(directory).get("answering") and time.monotonic() < deadline:
                time.sleep(0.1)
        spec = read_json(directory / SPEC)
        if not isinstance(spec.get("argv"), list) or not spec["argv"]:
            raise HostError("Kanboard withdrew this agent's start; start the task again from the board")
        if not cwd:
            cwd = spec.get("cwd") or (find_worktree(spec["repo"], spec["branch"])
                                      if spec.get("repo") and spec.get("branch") else None)
        if not cwd or not os.path.isdir(cwd):
            raise HostError(f"No worktree of {spec.get('branch') or 'the task branch'} to run the agent in")
        if len(os.fsencode(str(directory / SOCKET))) > SOCKET_LIMIT:
            raise HostError(f"{directory} is too long a path for the agent's socket; use a shorter KANBOARD_HOME")
        write_private(directory / SPEC, {**spec, "cwd": cwd})
        log_path = directory / LOG
        if log_path.is_file() and log_path.stat().st_size > LOG_LIMIT:
            log_path.unlink()
        log = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            proc = subprocess.Popen([sys.executable, SCRIPT, "serve", str(directory)], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=log, cwd=str(directory), start_new_session=True,
                                    env=child_env())
        finally:
            os.close(log)
        try:
            code = proc.wait(START_TIMEOUT)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            raise HostError("The agent host didn't start in time")
        current = status(directory)
        if code != 0 or not current["alive"]:
            detail = output(directory, 5).strip() or log_tail(directory)
            raise HostError("The agent didn't start" + (f": {detail}" if detail else ""))
        return current


def terminate(directory: Path, instance: Optional[str] = None, timeout: float = 15.0) -> bool:
    """Ends the agent of the host in `directory` (only `instance`, when given): the host signals its own process
    group and exits. A host that doesn't answer is signalled only when its pid provably is that host. True once gone."""
    meta = read_json(directory / META)
    try:
        reply: Optional[Dict[str, Any]] = request(directory, {"op": "terminate", "instance": instance})
    except (OSError, ValueError, HostError):
        reply = None
    if reply is not None and not reply.get("ok"):
        raise HostError(str(reply.get("error") or "the agent host refused to stop"))
    if reply is None and meta.get("exitCode") is None and (instance is None or meta.get("instance") == instance) \
            and is_host(meta, directory):
        try:
            os.kill(meta["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not status(directory)["alive"]:
            return True
        time.sleep(0.2)
    meta = read_json(directory / META)
    if instance is None or meta.get("instance") == instance:
        try:
            if is_child(meta):
                os.killpg(meta["child"], signal.SIGKILL)
            if is_host(meta, directory):
                os.kill(meta["pid"], signal.SIGKILL)
        except ProcessLookupError:
            pass
        time.sleep(0.5)
    return not status(directory)["alive"]


# --- screen ---------------------------------------------------------------------------------------------------------

GROUND, ESC, CSI, CSI_SKIP, OSC, STRING, STRING_ESC, SKIP = range(8)
CONTROLS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
INTERMEDIATES = " !\"#$%&'()*+,-./"
BLANK = (" ", "")
REPLAY_MODES = (1, 12, 66, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004)
FLAGS = {1, 2, 3, 5, 6, 7, 8, 9, 53}
FLAG_RESETS = {22: (1, 2), 23: (3,), 25: (5, 6), 27: (7,), 28: (8,), 29: (9,), 55: (53,)}


@lru_cache(maxsize=4096)
def cell_width(ch: str) -> int:
    if unicodedata.combining(ch) or unicodedata.category(ch) in ("Mn", "Me", "Cf"):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


def row_text(row: List[Tuple[str, str]]) -> str:
    return "".join(cell[0] for cell in row).rstrip()


class Screen:
    """Enough of an xterm for omp's TUI: a readable screen with scrollback, and a snapshot that redraws it with its
    colors and input modes in a newly attached terminal."""

    def __init__(self, rows: int, cols: int) -> None:
        self.rows, self.cols = rows, cols
        self.history: Deque[str] = deque(maxlen=HISTORY)
        self.main = self.blank_rows(rows)
        self.alt = self.blank_rows(rows)
        self.grid = self.main
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.state = GROUND
        self.seq: List[str] = []
        self.reset_state()

    def reset_state(self) -> None:
        self.alt_on = False
        self.grid = self.main
        self.x = self.y = 0
        self.wrap = False
        self.top, self.bottom = 0, self.rows - 1
        self.flags: set = set()
        self.underline: Optional[str] = None
        self.fg: Optional[str] = None
        self.bg: Optional[str] = None
        self.ul: Optional[str] = None
        self.attr = ""
        self.saved: Optional[Tuple[Any, ...]] = None
        self.modes: Dict[int, bool] = {}
        self.autowrap = True
        self.origin = False
        self.cursor_visible = True
        self.cursor_style = 0
        self.keypad = False
        self.kitty: List[int] = []
        self.other_keys = 0
        self.tabs = set(range(8, self.cols, 8))

    def blank_rows(self, count: int, attr: str = "") -> List[List[Tuple[str, str]]]:
        cell = (" ", attr)
        return [[cell] * self.cols for _ in range(count)]

    def erase_cell(self) -> Tuple[str, str]:
        return (" ", self.bg) if self.bg else BLANK

    # input

    def feed(self, data: bytes) -> None:
        text = self.decoder.decode(data)
        i, n = 0, len(text)
        while i < n:
            if self.state == GROUND:
                m = CONTROLS.search(text, i)
                j = m.start() if m else n
                if j > i:
                    self.put(text[i:j])
                    i = j
                    continue
                ch = text[i]
                i += 1
                if ch == "\x1b":
                    self.state = ESC
                else:
                    self.control(ch)
            else:
                self.step(text[i])
                i += 1

    def step(self, ch: str) -> None:
        state = self.state
        if state == ESC:
            if ch == "[":
                self.state, self.seq = CSI, []
            elif ch == "]":
                self.state = OSC
            elif ch in "PX^_":
                self.state = STRING
            elif ch in "()*+-./ #%":
                self.state = SKIP
            else:
                self.state = GROUND
                self.esc(ch)
        elif state in (CSI, CSI_SKIP):
            o = ord(ch)
            if 0x40 <= o <= 0x7e:
                self.state = GROUND
                if state == CSI:
                    self.csi("".join(self.seq), ch)
            elif ch == "\x1b":
                self.state = ESC
            elif o < 0x20:
                self.control(ch)
            elif len(self.seq) < 64:
                self.seq.append(ch)
            else:
                self.state = CSI_SKIP
        elif state in (OSC, STRING):
            if ch == "\x1b":
                self.state = STRING_ESC
            elif ch == "\x07":
                self.state = GROUND
        elif state == STRING_ESC:
            if ch == "\\":
                self.state = GROUND
            else:
                self.state = ESC
                self.step(ch)
        else:
            self.state = GROUND

    def control(self, ch: str) -> None:
        if ch == "\r":
            self.x, self.wrap = 0, False
        elif ch in "\n\x0b\x0c":
            self.wrap = False
            self.index()
        elif ch == "\b":
            self.wrap = False
            self.x = max(0, self.x - 1)
        elif ch == "\t":
            self.wrap = False
            self.x = min([t for t in self.tabs if t > self.x] + [self.cols - 1])

    def esc(self, ch: str) -> None:
        if ch == "7":
            self.save_cursor()
        elif ch == "8":
            self.restore_cursor()
        elif ch == "D":
            self.index()
        elif ch == "E":
            self.x, self.wrap = 0, False
            self.index()
        elif ch == "M":
            self.reverse_index()
        elif ch == "H":
            self.tabs.add(self.x)
        elif ch == "c":
            self.main, self.alt = self.blank_rows(self.rows), self.blank_rows(self.rows)
            self.reset_state()
        elif ch == "=":
            self.keypad = True
        elif ch == ">":
            self.keypad = False

    def csi(self, body: str, final: str) -> None:
        prefix = body[0] if body and body[0] in "?><=" else ""
        rest = body[1:] if prefix else body
        inter = ""
        while rest and rest[-1] in INTERMEDIATES:
            inter, rest = rest[-1] + inter, rest[:-1]
        parts = rest.split(";") if rest else []
        nums = [int(p.split(":")[0]) if p.split(":")[0].isdigit() else 0 for p in parts]

        def arg(i: int, default: int) -> int:
            return nums[i] if i < len(nums) and nums[i] else default

        if inter:
            if inter == " " and final == "q":
                self.cursor_style = arg(0, 0)
            elif inter == "!" and final == "p":
                self.soft_reset()
            return
        if prefix == "?":
            if final in "hl":
                for mode in nums:
                    self.dec_mode(mode, final == "h")
            elif final == "J":
                self.erase_display(arg(0, 0))
            elif final == "K":
                self.erase_line(arg(0, 0))
            return
        if prefix == ">":
            if final == "u":
                self.kitty = (self.kitty + [arg(0, 0)])[-16:]
            elif final == "m" and nums and nums[0] == 4:
                self.other_keys = arg(1, 0)
            return
        if prefix == "<":
            if final == "u":
                del self.kitty[max(0, len(self.kitty) - arg(0, 1)):]
            return
        if prefix == "=":
            if final == "u":
                flags, how = arg(0, 0), arg(1, 1)
                current = self.kitty[-1] if self.kitty else 0
                value = flags if how == 1 else current | flags if how == 2 else current & ~flags
                self.kitty = (self.kitty[:-1] if self.kitty else []) + [value]
            return
        if final == "m":
            self.sgr(parts)
            return
        self.wrap = self.wrap and final in "hlmnrsu"
        if final == "@":
            self.insert_chars(arg(0, 1))
        elif final == "A":
            self.y = max(self.top if self.y >= self.top else 0, self.y - arg(0, 1))
        elif final in "Be":
            self.y = min(self.bottom if self.y <= self.bottom else self.rows - 1, self.y + arg(0, 1))
        elif final in "Ca":
            self.x = min(self.cols - 1, self.x + arg(0, 1))
        elif final == "D":
            self.x = max(0, self.x - arg(0, 1))
        elif final == "E":
            self.x = 0
            self.y = min(self.bottom if self.y <= self.bottom else self.rows - 1, self.y + arg(0, 1))
        elif final == "F":
            self.x = 0
            self.y = max(self.top if self.y >= self.top else 0, self.y - arg(0, 1))
        elif final in "G`":
            self.x = min(self.cols - 1, arg(0, 1) - 1)
        elif final in "Hf":
            self.move_to(arg(1, 1) - 1, arg(0, 1) - 1)
        elif final == "I":
            for _ in range(arg(0, 1)):
                self.control("\t")
        elif final == "J":
            self.erase_display(arg(0, 0))
        elif final == "K":
            self.erase_line(arg(0, 0))
        elif final == "L":
            self.insert_lines(arg(0, 1))
        elif final == "M":
            self.delete_lines(arg(0, 1))
        elif final == "P":
            self.delete_chars(arg(0, 1))
        elif final == "S":
            self.scroll_up(arg(0, 1))
        elif final == "T" and len(nums) <= 1:
            self.scroll_down(arg(0, 1))
        elif final == "X":
            row = self.grid[self.y]
            end = min(self.cols, self.x + arg(0, 1))
            row[self.x:end] = [self.erase_cell()] * (end - self.x)
        elif final == "Z":
            for _ in range(arg(0, 1)):
                self.x = max([t for t in self.tabs if t < self.x] + [0])
        elif final == "b" and self.x > 0:
            last = self.grid[self.y][self.x - 1][0]
            if last.strip():
                self.put(last * min(arg(0, 1), self.cols * self.rows))
        elif final == "d":
            self.move_to(self.x, arg(0, 1) - 1)
        elif final == "g":
            mode = arg(0, 0)
            if mode == 0:
                self.tabs.discard(self.x)
            elif mode == 3:
                self.tabs.clear()
        elif final == "r":
            top, bottom = arg(0, 1) - 1, min(arg(1, self.rows), self.rows) - 1
            if top < bottom:
                self.top, self.bottom = top, bottom
                self.move_to(0, 0)
        elif final == "s" and not nums:
            self.save_cursor()
        elif final == "u" and not nums:
            self.restore_cursor()

    def sgr(self, parts: List[str]) -> None:
        items = parts or ["0"]
        i = 0
        while i < len(items):
            item = items[i]
            if ":" in item:
                head = item.split(":")[0]
                if head in ("38", "48", "58"):
                    setattr(self, {"38": "fg", "48": "bg", "58": "ul"}[head], item)
                elif head == "4":
                    self.underline = None if item.split(":")[1] in ("", "0") else item
                i += 1
                continue
            n = int(item) if item.isdigit() else 0
            if n in (38, 48, 58):
                mode = items[i + 1] if i + 1 < len(items) else ""
                size = 3 if mode == "5" else 5 if mode == "2" else 0
                if size and i + size <= len(items):
                    setattr(self, {38: "fg", 48: "bg", 58: "ul"}[n], ";".join(items[i:i + size]))
                    i += size
                else:
                    i = len(items)
                continue
            if n == 0:
                self.flags, self.underline, self.fg, self.bg, self.ul = set(), None, None, None, None
            elif n in FLAGS:
                self.flags.add(n)
            elif n in FLAG_RESETS:
                self.flags.difference_update(FLAG_RESETS[n])
            elif n in (4, 21):
                self.underline = str(n)
            elif n == 24:
                self.underline = None
            elif 30 <= n <= 37 or 90 <= n <= 97:
                self.fg = str(n)
            elif n == 39:
                self.fg = None
            elif 40 <= n <= 47 or 100 <= n <= 107:
                self.bg = str(n)
            elif n == 49:
                self.bg = None
            elif n == 59:
                self.ul = None
            i += 1
        self.attr = ";".join([str(f) for f in sorted(self.flags)] +
                             [p for p in (self.underline, self.fg, self.bg, self.ul) if p])

    def dec_mode(self, mode: int, on: bool) -> None:
        if mode == 6:
            self.origin = on
            self.move_to(0, 0)
        elif mode == 7:
            self.autowrap = on
        elif mode == 25:
            self.cursor_visible = on
        elif mode in (47, 1047, 1049):
            if on and not self.alt_on:
                if mode == 1049:
                    self.save_cursor()
                self.alt = self.blank_rows(self.rows)
                self.grid, self.alt_on = self.alt, True
            elif not on and self.alt_on:
                self.grid, self.alt_on = self.main, False
                if mode == 1049:
                    self.restore_cursor()
        elif mode == 1048:
            self.save_cursor() if on else self.restore_cursor()
        else:
            self.modes[mode] = on

    def soft_reset(self) -> None:
        self.flags, self.underline, self.fg, self.bg, self.ul, self.attr = set(), None, None, None, None, ""
        self.top, self.bottom = 0, self.rows - 1
        self.autowrap, self.origin, self.cursor_visible, self.keypad = True, False, True, False
        self.modes.pop(1, None)
        self.saved = None

    # cursor and scrolling

    def move_to(self, x: int, y: int) -> None:
        if self.origin:
            y = min(max(y + self.top, self.top), self.bottom)
        self.x = min(max(x, 0), self.cols - 1)
        self.y = min(max(y, 0), self.rows - 1)
        self.wrap = False

    def save_cursor(self) -> None:
        self.saved = (self.x, self.y, self.wrap, set(self.flags), self.underline, self.fg, self.bg, self.ul, self.attr,
                      self.origin, self.autowrap)

    def restore_cursor(self) -> None:
        if self.saved is None:
            self.move_to(0, 0)
            return
        (x, y, wrap, flags, self.underline, self.fg, self.bg, self.ul, self.attr, self.origin,
         self.autowrap) = self.saved
        self.flags = set(flags)
        self.x, self.y, self.wrap = min(x, self.cols - 1), min(y, self.rows - 1), wrap

    def index(self) -> None:
        if self.y == self.bottom:
            self.scroll_up(1)
        elif self.y < self.rows - 1:
            self.y += 1

    def reverse_index(self) -> None:
        if self.y == self.top:
            self.scroll_down(1)
        elif self.y > 0:
            self.y -= 1

    def scroll_up(self, n: int) -> None:
        top, bottom = self.top, self.bottom
        n = min(n, bottom - top + 1)
        removed = self.grid[top:top + n]
        del self.grid[top:top + n]
        self.grid[bottom - n + 1:bottom - n + 1] = self.blank_rows(n, self.bg or "")
        if self.grid is self.main and top == 0:
            self.history.extend(row_text(row) for row in removed)

    def scroll_down(self, n: int) -> None:
        top, bottom = self.top, self.bottom
        n = min(n, bottom - top + 1)
        del self.grid[bottom - n + 1:bottom + 1]
        self.grid[top:top] = self.blank_rows(n, self.bg or "")

    def insert_lines(self, n: int) -> None:
        if self.top <= self.y <= self.bottom:
            n = min(n, self.bottom - self.y + 1)
            del self.grid[self.bottom - n + 1:self.bottom + 1]
            self.grid[self.y:self.y] = self.blank_rows(n, self.bg or "")
            self.x = 0

    def delete_lines(self, n: int) -> None:
        if self.top <= self.y <= self.bottom:
            n = min(n, self.bottom - self.y + 1)
            del self.grid[self.y:self.y + n]
            self.grid[self.bottom - n + 1:self.bottom - n + 1] = self.blank_rows(n, self.bg or "")
            self.x = 0

    # editing

    def erase_display(self, mode: int) -> None:
        blank = self.erase_cell()
        if mode == 0:
            self.erase_line(0)
            for y in range(self.y + 1, self.rows):
                self.grid[y] = [blank] * self.cols
        elif mode == 1:
            for y in range(self.y):
                self.grid[y] = [blank] * self.cols
            self.erase_line(1)
        elif mode == 2:
            for y in range(self.rows):
                self.grid[y] = [blank] * self.cols
        elif mode == 3 and self.grid is self.main:
            self.history.clear()

    def erase_line(self, mode: int) -> None:
        row, blank = self.grid[self.y], self.erase_cell()
        if mode == 0:
            row[self.x:] = [blank] * (self.cols - self.x)
            self.unsplit(row, self.x)
        elif mode == 1:
            row[:self.x + 1] = [blank] * (self.x + 1)
            self.unsplit(row, self.x + 1)
        elif mode == 2:
            row[:] = [blank] * self.cols

    def insert_chars(self, n: int) -> None:
        row = self.grid[self.y]
        n = min(n, self.cols - self.x)
        row[self.x:self.x] = [self.erase_cell()] * n
        del row[self.cols:]
        self.unsplit(row, self.x)

    def delete_chars(self, n: int) -> None:
        row = self.grid[self.y]
        n = min(n, self.cols - self.x)
        del row[self.x:self.x + n]
        row.extend([self.erase_cell()] * n)
        self.unsplit(row, self.x)

    def unsplit(self, row: List[Tuple[str, str]], x: int) -> None:
        """Blanks the halves of wide characters that an edit at column x cut apart."""
        if 0 < x < self.cols and row[x][0] == "":
            row[x] = BLANK
            row[x - 1] = BLANK

    # printing

    def wrap_line(self) -> None:
        self.x, self.wrap = 0, False
        self.index()

    def put(self, text: str) -> None:
        if text.isascii():
            attr = self.attr
            while text:
                if self.wrap:
                    self.wrap_line()
                room = self.cols - self.x
                if len(text) <= room or self.autowrap:
                    chunk, text = text[:room], text[room:]
                else:
                    chunk, text = text[:room - 1] + text[-1], ""
                row = self.grid[self.y]
                end = self.x + len(chunk)
                if row[self.x][0] == "" and self.x > 0:
                    row[self.x - 1] = BLANK
                if end < self.cols and row[end][0] == "":
                    row[end] = BLANK
                row[self.x:end] = [(c, attr) for c in chunk]
                if end >= self.cols:
                    self.x, self.wrap = self.cols - 1, self.autowrap
                else:
                    self.x = end
            return
        for ch in text:
            self.put_char(ch)

    def put_char(self, ch: str) -> None:
        width = cell_width(ch)
        row = self.grid[self.y]
        if width == 0:
            x = self.x if self.wrap else self.x - 1
            if x > 0 and row[x][0] == "":
                x -= 1
            if x >= 0:
                row[x] = (row[x][0] + ch, row[x][1])
            return
        if self.wrap:
            self.wrap_line()
            row = self.grid[self.y]
        if width == 2 and self.x == self.cols - 1:
            if not self.autowrap:
                return
            row[self.x] = self.erase_cell()
            self.wrap_line()
            row = self.grid[self.y]
        x = self.x
        if row[x][0] == "" and x > 0:
            row[x - 1] = BLANK
        if x + width < self.cols and row[x + width][0] == "":
            row[x + width] = BLANK
        row[x] = (ch, self.attr)
        if width == 2:
            row[x + 1] = ("", self.attr)
        if x + width >= self.cols:
            self.x, self.wrap = self.cols - 1, self.autowrap
        else:
            self.x = x + width

    # size

    def resize(self, rows: int, cols: int) -> None:
        if (rows, cols) == (self.rows, self.cols):
            return
        for grid in (self.main, self.alt):
            for row in grid:
                if cols < len(row):
                    del row[cols:]
                    if row and row[-1][0] and cell_width(row[-1][0][0]) == 2:
                        row[-1] = BLANK
                else:
                    row.extend([BLANK] * (cols - len(row)))
            excess = len(grid) - rows
            if excess > 0:
                cut = min(excess, max(0, self.y - rows + 1)) if grid is self.grid else 0
                if grid is self.main:
                    self.history.extend(row_text(row) for row in grid[:cut])
                del grid[:cut]
                del grid[rows:]
                if grid is self.grid:
                    self.y -= cut
            elif excess < 0:
                grid.extend([BLANK] * cols for _ in range(-excess))
        self.rows, self.cols = rows, cols
        self.top, self.bottom = 0, rows - 1
        self.x, self.y = min(self.x, cols - 1), min(max(self.y, 0), rows - 1)
        self.wrap = False
        self.tabs = set(range(8, cols, 8))

    # output

    def text(self, lines: int) -> str:
        rows = [row_text(row) for row in self.grid]
        if not self.alt_on:
            rows = list(self.history) + rows
        while rows and not rows[-1]:
            rows.pop()
        return "\n".join(rows[-lines:])

    def snapshot(self) -> bytes:
        """Escape sequences that redraw this screen, its modes and cursor in a terminal of the same size."""
        out = ["\x1b[0m\x1b[r"]
        if self.alt_on:
            out.append("\x1b[?1049h")
        out.append("\x1b[H\x1b[2J")
        for y, row in enumerate(self.grid):
            last = len(row) - 1
            while last >= 0 and row[last] == BLANK:
                last -= 1
            if last < 0:
                continue
            out.append(f"\x1b[{y + 1};1H")
            attr = ""
            for ch, a in row[:last + 1]:
                if not ch:
                    continue
                if a != attr:
                    out.append(f"\x1b[0;{a}m" if a else "\x1b[0m")
                    attr = a
                out.append(ch)
            if attr:
                out.append("\x1b[0m")
        if (self.top, self.bottom) != (0, self.rows - 1):
            out.append(f"\x1b[{self.top + 1};{self.bottom + 1}r")
        out += [f"\x1b[?{mode}h" for mode in REPLAY_MODES if self.modes.get(mode)]
        if not self.autowrap:
            out.append("\x1b[?7l")
        if self.keypad:
            out.append("\x1b=")
        if self.kitty and self.kitty[-1]:
            out.append(f"\x1b[>{self.kitty[-1]}u")
        if self.other_keys:
            out.append(f"\x1b[>4;{self.other_keys}m")
        if self.cursor_style:
            out.append(f"\x1b[{self.cursor_style} q")
        out.append(f"\x1b[{self.y + 1};{self.x + 1}H")
        out.append(f"\x1b[0;{self.attr}m" if self.attr else "\x1b[0m")
        out.append("\x1b[?25h" if self.cursor_visible else "\x1b[?25l")
        return "".join(out).encode("utf-8", "replace")


# --- host -------------------------------------------------------------------------------------------------------

class Client:
    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.inbox = bytearray()
        self.outbox = bytearray()
        self.attached = False
        self.greeted = False
        self.closing = False
        self.gone = False


class Host:
    """Owns the agent process and its PTY; one per directory, started by `ensure` through `serve`."""

    def __init__(self, directory: Path) -> None:
        self.dir = directory
        self.spec = read_json(directory / SPEC)
        self.instance = uuid.uuid4().hex
        self.rows = int(self.spec.get("rows") or ROWS)
        self.cols = int(self.spec.get("cols") or COLS)
        self.screen = Screen(self.rows, self.cols)
        self.selector = selectors.DefaultSelector()
        self.clients: Dict[socket.socket, Client] = {}
        self.pending = bytearray()
        self.child = 0
        self.master = -1
        self.pty_open = False
        self.exit_code: Optional[int] = None
        self.exited_at: Optional[str] = None
        self.kill_at: Optional[float] = None
        self.drain_until = 0.0
        self.signals: List[int] = []
        self.started_at = now_iso()
        self.started: Optional[str] = None
        self.child_started: Optional[str] = None
        self.socket_inode = 0

    def start(self) -> None:
        argv, cwd = self.spec.get("argv"), self.spec.get("cwd")
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv) or not os.path.isabs(argv[0]):
            raise HostError("the start spec has no runnable argv")
        if not isinstance(cwd, str) or not os.path.isdir(cwd):
            raise HostError(f"the agent's directory {cwd} doesn't exist")
        path = self.dir / SOCKET
        path.unlink(missing_ok=True)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        previous = os.umask(0o177)
        try:
            self.listener.bind(str(path))
        finally:
            os.umask(previous)
        os.chmod(path, 0o600)
        self.socket_inode = path.stat().st_ino
        self.listener.listen(16)
        self.listener.setblocking(False)
        env = agent_env({"PWD": cwd})
        pid, fd = os.forkpty()
        if pid == 0:
            try:
                fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.cols, 0, 0))
                os.chdir(cwd)
                os.execve(argv[0], argv, env)
            except BaseException as e:
                os.write(2, f"kanboard: couldn't run the agent: {e}\r\n".encode())
            os._exit(127)
        self.child, self.master, self.pty_open = pid, fd, True
        os.set_blocking(fd, False)
        self.started = ps_field(os.getpid(), "lstart")
        self.child_started = ps_field(pid, "lstart")
        self.write_meta()
        print(f"{now_iso()} agent host {self.instance} started {shlex.join(argv)} in {cwd}", file=sys.stderr, flush=True)

    def meta(self) -> Dict[str, Any]:
        return {"instance": self.instance, "pid": os.getpid(), "started": self.started, "child": self.child,
                "childStarted": self.child_started, "cwd": self.spec.get("cwd"), "task": self.spec.get("task"),
                "argv": self.spec.get("argv"), "startedAt": self.started_at, "exitCode": self.exit_code,
                "exitedAt": self.exited_at}

    def write_meta(self) -> None:
        write_private(self.dir / META, self.meta())

    def reply(self, client: Client, data: Dict[str, Any]) -> None:
        self.send(client, frame(b"J", json.dumps(data).encode()))

    def status(self) -> Dict[str, Any]:
        return {"ok": True, "instance": self.instance, "pid": os.getpid(), "child": self.child,
                "alive": self.exit_code is None, "answering": True, "exitCode": self.exit_code,
                "exitedAt": self.exited_at, "cwd": self.spec.get("cwd"), "task": self.spec.get("task"),
                "startedAt": self.started_at, "rows": self.rows, "cols": self.cols,
                "clients": sum(1 for c in self.clients.values() if c.attached),
                "terminating": self.kill_at is not None}

    # loop

    def on_signal(self, signum: int, _frame: Any) -> None:
        self.signals.append(signum)

    def run(self) -> None:
        wake_r, wake_w = os.pipe()
        os.set_blocking(wake_r, False)
        os.set_blocking(wake_w, False)
        signal.set_wakeup_fd(wake_w)
        for sig in (signal.SIGCHLD, signal.SIGTERM):
            signal.signal(sig, self.on_signal)
        for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGQUIT):
            signal.signal(sig, signal.SIG_IGN)
        self.selector.register(self.listener, selectors.EVENT_READ, "listen")
        self.selector.register(self.master, selectors.EVENT_READ, "pty")
        self.selector.register(wake_r, selectors.EVENT_READ, "wake")
        while True:
            now = time.monotonic()
            deadlines = [d for d in (self.kill_at, self.drain_until if self.exit_code is not None else None) if d]
            timeout = max(0.0, min(deadlines) - now) if deadlines else None
            for key, events in self.selector.select(timeout):
                if key.data == "listen":
                    self.accept()
                elif key.data == "pty":
                    if events & selectors.EVENT_READ:
                        self.read_pty()
                    if events & selectors.EVENT_WRITE:
                        self.write_pty()
                elif key.data == "wake":
                    try:
                        os.read(wake_r, 256)
                    except BlockingIOError:
                        pass
                else:
                    self.serve_client(key.data, events)
            self.handle_signals()
            self.reap()
            now = time.monotonic()
            if self.kill_at is not None and now >= self.kill_at and self.exit_code is None:
                self.kill_at = None
                self.signal_group(signal.SIGKILL)
            if self.exit_code is not None and (not self.pty_open or now >= self.drain_until):
                break
        self.finish()

    def handle_signals(self) -> None:
        while self.signals:
            if self.signals.pop() == signal.SIGTERM:
                self.terminate()

    def reap(self) -> None:
        if self.exit_code is not None:
            return
        try:
            pid, st = os.waitpid(self.child, os.WNOHANG)
        except ChildProcessError:
            pid, st = self.child, 0
        if pid == 0:
            return
        self.exit_code = os.waitstatus_to_exitcode(st)
        self.exited_at = now_iso()
        self.kill_at = None
        self.drain_until = time.monotonic() + DRAIN
        self.signal_group(signal.SIGHUP)

    def signal_group(self, sig: int) -> None:
        try:
            os.killpg(self.child, sig)
        except OSError:
            pass

    def terminate(self) -> None:
        if self.exit_code is None and self.kill_at is None:
            self.signal_group(signal.SIGHUP)
            self.signal_group(signal.SIGTERM)
            self.kill_at = time.monotonic() + TERMINATE_GRACE

    # pty

    def read_pty(self) -> None:
        try:
            data = os.read(self.master, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            self.selector.unregister(self.master)
            self.pty_open = False
            self.pending.clear()
            return
        try:
            self.screen.feed(data)
        except Exception as e:  # an emulation gap must never cost the agent its host
            print(f"{now_iso()} agent host screen reset after {e!r}", file=sys.stderr, flush=True)
            self.screen = Screen(self.rows, self.cols)
        out = frame(b"O", data)
        for client in list(self.clients.values()):
            if client.attached:
                self.send(client, out)

    def write_pty(self) -> None:
        try:
            written = os.write(self.master, self.pending)
        except BlockingIOError:
            written = 0
        except OSError:
            self.pending.clear()
            written = 0
        del self.pending[:written]
        self.watch_pty()

    def watch_pty(self) -> None:
        if self.pty_open:
            events = selectors.EVENT_READ | (selectors.EVENT_WRITE if self.pending else 0)
            self.selector.modify(self.master, events, "pty")

    def resize(self, rows: int, cols: int) -> None:
        if (rows, cols) == (self.rows, self.cols):
            return
        self.rows, self.cols = rows, cols
        self.screen.resize(rows, cols)
        if self.pty_open:
            try:
                fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            except OSError:
                pass

    # clients

    def accept(self) -> None:
        try:
            sock, _ = self.listener.accept()
        except (BlockingIOError, InterruptedError):
            return
        sock.setblocking(False)
        client = Client(sock)
        self.clients[sock] = client
        self.selector.register(sock, selectors.EVENT_READ, client)

    def drop(self, client: Client) -> None:
        if client.gone:
            return
        client.gone = True
        self.clients.pop(client.sock, None)
        try:
            self.selector.unregister(client.sock)
        except (KeyError, ValueError):
            pass
        client.sock.close()

    def send(self, client: Client, data: bytes) -> None:
        if client.gone:
            return
        client.outbox += data
        if len(client.outbox) > CLIENT_BUFFER:
            self.drop(client)
            return
        self.selector.modify(client.sock, selectors.EVENT_READ | selectors.EVENT_WRITE, client)

    def serve_client(self, client: Client, events: int) -> None:
        if events & selectors.EVENT_WRITE and client.outbox:
            try:
                sent = client.sock.send(client.outbox)
            except (BlockingIOError, InterruptedError):
                sent = 0
            except OSError:
                self.drop(client)
                return
            del client.outbox[:sent]
            if not client.outbox:
                if client.closing:
                    self.drop(client)
                    return
                self.selector.modify(client.sock, selectors.EVENT_READ, client)
        if events & selectors.EVENT_READ and not client.gone:
            try:
                data = client.sock.recv(65536)
            except (BlockingIOError, InterruptedError):
                return
            except OSError:
                data = b""
            if not data:
                self.drop(client)
                return
            client.inbox += data
            try:
                for kind, payload in read_frames(client.inbox):
                    self.handle(client, kind, payload)
                    if client.gone or client.closing:
                        break
            except Exception:  # a misbehaving client only loses its own connection
                self.drop(client)

    def handle(self, client: Client, kind: bytes, payload: bytes) -> None:
        if not client.greeted:
            if kind != b"H":
                raise HostError("expected a hello")
            client.greeted = True
            message = json.loads(payload)
            op = message.get("op") if isinstance(message, dict) else None
            if op == "status":
                self.reply(client, self.status())
            elif op == "output":
                lines = message.get("lines")
                lines = lines if isinstance(lines, int) and 0 < lines <= 10000 else 120
                self.reply(client, {"ok": True, "instance": self.instance, "text": self.screen.text(lines)})
            elif op == "terminate":
                wanted = message.get("instance")
                if wanted is not None and wanted != self.instance:
                    self.reply(client, {"ok": False, "error": f"this host is {self.instance}, not {wanted}"})
                else:
                    self.terminate()
                    self.reply(client, {"ok": True, "instance": self.instance, "terminating": self.exit_code is None})
            elif op == "attach" and self.exit_code is None:
                rows, cols = message.get("rows"), message.get("cols")
                if isinstance(rows, int) and isinstance(cols, int) and 2 <= rows <= 1000 and 2 <= cols <= 1000:
                    self.resize(rows, cols)
                client.attached = True
                self.reply(client, {"ok": True, "instance": self.instance, "task": self.spec.get("task"),
                                    "alt": self.screen.alt_on})
                self.send(client, frame(b"O", self.screen.snapshot()))
                return
            else:
                self.reply(client, {"ok": False, "error": "the agent exited" if op == "attach" else f"unknown op {op}"})
            client.closing = True
            return
        if not client.attached:
            raise HostError("not attached")
        if kind == b"I":
            if self.exit_code is None and self.pty_open and len(self.pending) + len(payload) <= INPUT_BUFFER:
                self.pending += payload
                self.watch_pty()
        elif kind == b"W":
            size = json.loads(payload)
            rows, cols = (size.get("rows"), size.get("cols")) if isinstance(size, dict) else (None, None)
            if isinstance(rows, int) and isinstance(cols, int) and 2 <= rows <= 1000 and 2 <= cols <= 1000:
                self.resize(rows, cols)

    # exit

    def finish(self) -> None:
        print(f"{now_iso()} agent host {self.instance} ends: exit code {self.exit_code}", file=sys.stderr, flush=True)
        goodbye = frame(b"X", json.dumps({"code": self.exit_code}).encode())
        for client in list(self.clients.values()):
            if client.attached:
                client.outbox += goodbye
            try:
                client.sock.settimeout(0.5)
                if client.outbox:
                    client.sock.sendall(bytes(client.outbox))
            except OSError:
                pass
            self.drop(client)
        self.listener.close()
        try:
            with locked(self.dir, timeout=LOCK_TIMEOUT):
                write_text_private(self.dir / SCREEN, self.screen.text(SCREEN_LINES) + "\n")
                # A host started after this one exited owns the directory now: leave its socket and record alone.
                if read_json(self.dir / META).get("instance") == self.instance:
                    self.write_meta()
                    path = self.dir / SOCKET
                    if path.exists() and path.stat().st_ino == self.socket_inode:
                        path.unlink()
        except (HostError, OSError) as e:
            print(f"{now_iso()} agent host {self.instance} couldn't record its exit: {e}", file=sys.stderr, flush=True)


def serve(directory: Path) -> int:
    """Forks the host into its own session and returns once it serves (0) or failed (1)."""
    ready_r, ready_w = os.pipe()
    if os.fork():
        os.close(ready_w)
        ready = select.select([ready_r], [], [], START_TIMEOUT)[0]
        return 0 if ready and os.read(ready_r, 2) == b"ok" else 1
    os.close(ready_r)
    os.setsid()
    os.umask(0o077)
    try:
        host = Host(directory)
        host.start()
    except Exception as e:
        print(f"{now_iso()} agent host couldn't start: {e}", file=sys.stderr, flush=True)
        os._exit(1)
    os.write(ready_w, b"ok")
    os.close(ready_w)
    try:
        host.run()
    except Exception as e:
        print(f"{now_iso()} agent host failed: {e!r}", file=sys.stderr, flush=True)
        host.terminate()
        os._exit(1)
    os._exit(0)


# --- terminal clients ---------------------------------------------------------------------------------------------

def detach_at(data: bytes) -> Optional[int]:
    found = [i for i in (data.find(key) for key in DETACH) if i >= 0]
    return min(found) if found else None


def terminal_size() -> Tuple[int, int]:
    size = os.get_terminal_size(sys.stdout.fileno())
    return size.lines, size.columns


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def attach(directory: Path) -> int:
    """Shows the agent in this terminal and sends it this terminal's keys; Ctrl-\\ detaches and omp keeps running."""
    if not (os.isatty(0) and os.isatty(1)):
        print("attach needs a terminal", file=sys.stderr)
        return 2
    try:
        sock = connect(directory)
    except OSError:
        print(f"The agent of {directory} isn't running", file=sys.stderr)
        return 1
    rows, cols = terminal_size()
    sock.sendall(frame(b"H", json.dumps({"op": "attach", "rows": rows, "cols": cols}).encode()))
    sock.settimeout(None)
    wake_r, wake_w = os.pipe()
    os.set_blocking(wake_r, False)
    os.set_blocking(wake_w, False)
    signal.set_wakeup_fd(wake_w)
    signal.signal(signal.SIGWINCH, lambda *_: None)
    saved = termios.tcgetattr(0)
    tty.setraw(0)
    buffer = bytearray()
    alt, code, detached, refused = False, None, False, None
    try:
        while code is None and refused is None:
            ready = select.select([0, sock, wake_r], [], [])[0]
            if wake_r in ready:
                try:
                    woke = os.read(wake_r, 256)
                except BlockingIOError:
                    woke = b""
                if signal.SIGWINCH in woke:
                    rows, cols = terminal_size()
                    sock.sendall(frame(b"W", json.dumps({"rows": rows, "cols": cols}).encode()))
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:
                    break
                cut = detach_at(data)
                if cut is not None:
                    if cut:
                        sock.sendall(frame(b"I", data[:cut]))
                    detached = True
                    break
                sock.sendall(frame(b"I", data))
            if sock in ready:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                buffer += chunk
                for kind, payload in read_frames(buffer):
                    if kind == b"J":
                        hello = json.loads(payload)
                        if not hello.get("ok"):
                            refused = str(hello.get("error") or "the agent host refused")
                            break
                        alt = bool(hello.get("alt"))
                    elif kind == b"O":
                        write_all(1, payload)
                        for m in ALT_SCREEN.finditer(payload):
                            alt = m.group(1) == b"h"
                    elif kind == b"X":
                        code = json.loads(payload).get("code")
    except (OSError, HostError, ValueError) as e:
        refused = str(e)
    finally:
        termios.tcsetattr(0, termios.TCSADRAIN, saved)
        sock.close()
        write_all(1, (("\x1b[?1049l" if alt else "") + RESTORE).encode())
    if refused:
        print(f"\r\nkanboard: {refused}", file=sys.stderr)
        return 1
    if code is not None:
        print(f"\r\n[the agent exited with code {code}]")
    elif detached:
        print("\r\n[detached: omp keeps running]")
    else:
        print("\r\n[disconnected from the agent host]")
    return 0


def hold() -> None:
    """Keeps a message readable in a terminal that a hook opened just for this command."""
    if os.isatty(0):
        try:
            input("Press Enter to close")
        except (EOFError, KeyboardInterrupt):
            pass


def launch(directory: Path) -> int:
    """Starts the task's agent unless its host already runs (never a second omp), then attaches this terminal."""
    try:
        ensure(directory)
    except HostError as e:
        print(f"kanboard: {e}", file=sys.stderr)
        hold()
        return 1
    return attach(directory)


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="agent_host.py", description="A Kanboard task agent's detached terminal host.")
    actions = parser.add_subparsers(dest="action", required=True)
    for name, text in (("attach", "show the agent in this terminal; Ctrl-\\ detaches, omp keeps running"),
                       ("launch", "start the agent unless it runs, then attach"),
                       ("status", "print the host's status as JSON"),
                       ("output", "print the agent's recent screen"),
                       ("terminate", "stop the agent and its host"),
                       ("serve", argparse.SUPPRESS)):
        action = actions.add_parser(name, help=text)
        action.add_argument("dir", help="the host directory")
        if name == "output":
            action.add_argument("--lines", type=int, default=120)
    args = parser.parse_args(argv)
    directory = Path(args.dir).expanduser().absolute()
    if args.action == "serve":
        return serve(directory)
    if args.action == "attach":
        return attach(directory)
    if args.action == "launch":
        return launch(directory)
    if args.action == "status":
        print(json.dumps(status(directory), indent=2))
        return 0
    if args.action == "output":
        print(output(directory, max(1, args.lines)))
        return 0
    try:
        gone = terminate(directory)
    except HostError as e:
        print(f"kanboard: {e}", file=sys.stderr)
        return 1
    print("stopped" if gone else "still running")
    return 0 if gone else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
