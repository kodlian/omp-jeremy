"""Task agents in tmux sessions: the board's own `tmux -L <label>` server, or cmux's local-tmux server, so an agent outlives
the board and every terminal showing it."""
from __future__ import annotations

import json
import os
import re
import shlex
import signal as signals
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from runtime import agent_env, run, which

MODES = ("auto", "tmux", "cmux")
MISSING_TMUX = "tmux isn't installed (brew install tmux)"
# The board's server only: options cmux's server keeps for its own sessions are never changed globally.
SERVER_OPTIONS = [
    ["set-option", "-g", "default-terminal", "tmux-256color"],
    ["set-option", "-s", "terminal-features[90]", "*:RGB:extkeys"],
    ["set-option", "-s", "extended-keys", "on"],
    ["set-option", "-g", "remain-on-exit", "on"],
    ["set-option", "-g", "history-limit", "5000"],
    ["set-option", "-g", "status", "off"],
]


class DetachError(Exception):
    """A task's tmux session couldn't be started; the message says why."""


def label() -> str:
    return os.environ.get("ORCHESTRATOR_TMUX_LABEL", "orchestrator")


def session_name(task_id: str) -> str:
    """The tmux session of a task, lowercase so text that shows card ids by number never rewrites it."""
    return "orch-" + re.sub(r"[^a-z0-9_-]", "-", task_id.lower())


def server_args(ex: Dict[str, Any]) -> List[str]:
    return ["-S", ex["socket"]] if ex["server"] == "cmux" else ["-L", ex["label"]]


def tmux_run(ex: Dict[str, Any], args: List[str], timeout: float = 10) -> Tuple[int, str, str]:
    tmux = which("tmux")
    if not tmux:
        return 127, "", MISSING_TMUX
    return run([tmux, *server_args(ex), *args], timeout=timeout, env=agent_env(), inherit=False)


def sequence(commands: List[List[str]]) -> List[str]:
    """tmux commands run in order by one client, `;`-separated."""
    args: List[str] = []
    for command in commands:
        args += ([";"] if args else []) + command
    return args


def choose_server(context: Dict[str, Any], mode: str) -> Dict[str, Any]:
    """The tmux server a task's agent starts on: cmux's local-tmux in a cmux context (unless `mode` is tmux), else the
    board's own."""
    cmux = which("cmux")
    if mode != "tmux" and context.get("kind") == "cmux" and cmux:
        code, out, _ = run([cmux, "local-tmux", "list", "--json"], timeout=10)
        try:
            socket = json.loads(out).get("socket_path") if code == 0 else None
        except (ValueError, AttributeError):
            socket = None
        if isinstance(socket, str) and socket:
            return {"server": "cmux", "socket": socket, "label": None}
    if mode == "cmux":
        raise DetachError("cmux's local-tmux isn't available")
    if not which("tmux"):
        raise DetachError(MISSING_TMUX)
    return {"server": "board", "label": label(), "socket": None}


def start(ex: Dict[str, Any], cwd: str, script: Path) -> None:
    """Starts the task's tmux session running `script` in `cwd`, unless its agent runs; a session whose agent exited is
    replaced."""
    name = ex["name"]
    current = status(ex)
    if current["exists"] and not current["dead"]:
        return
    if current["exists"]:
        end(ex)
    if ex["server"] == "cmux":
        cmux = which("cmux")
        if not cmux:
            raise DetachError("cmux isn't on the board's PATH")
        command = [cmux, "local-tmux", "start", name, "--cwd", cwd, "--command", f"/bin/sh {shlex.quote(str(script))}",
                   "--detached"]
        code, out, err = run(command, timeout=30, env=agent_env(), inherit=False)
        if code != 0 and not alive(ex):
            # A registry entry bound to a session that is gone (its tmux server exited) makes cmux refuse the name.
            run([cmux, "local-tmux", "cleanup", "--prune"], timeout=15)
            code, out, err = run(command, timeout=30, env=agent_env(), inherit=False)
        if code != 0 and not alive(ex):
            raise DetachError((err or out).strip() or f"cmux local-tmux start exited with code {code}")
        tmux_run(ex, sequence([["set-option", "-w", "-t", f"={name}:", "remain-on-exit", "on"],
                               ["set-option", "-t", f"={name}:", "status", "off"]]))
        return
    new = ["new-session", "-d", "-s", name, "-c", cwd, "-x", "200", "-y", "50", "/bin/sh", str(script)]
    code, out, err = tmux_run(ex, sequence(SERVER_OPTIONS + [new]))
    if code != 0 and "duplicate session" not in err:
        raise DetachError((err or out).strip() or f"tmux exited with code {code}")


def status(ex: Dict[str, Any]) -> Dict[str, Any]:
    """The task's tmux session: whether it exists, whether its agent exited (with its exit code, 128 + the signal that
    killed it), its pid and how many clients show it."""
    code, out, _ = tmux_run(ex, ["list-panes", "-t", f"={ex['name']}:", "-F",
                                 "#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{pane_pid}\t#{session_attached}"])
    lines = out.splitlines()
    if code != 0 or not lines:
        return {"exists": False, "dead": False, "exitCode": None, "pid": None, "attached": 0}
    dead_flag, exit_status, killed_by, pid, attached = (lines[0].split("\t") + [""] * 5)[:5]
    dead = dead_flag == "1"
    exit_code = None
    if dead and exit_status.isdigit():
        exit_code = int(exit_status)
    elif dead and killed_by:
        number = int(killed_by) if killed_by.isdigit() else getattr(signals, "SIG" + killed_by.upper(), None)
        exit_code = 128 + int(number) if number is not None else None
    return {"exists": True, "dead": dead, "exitCode": exit_code, "pid": int(pid) if pid.isdigit() else None,
            "attached": int(attached) if attached.isdigit() else 0}


def alive(ex: Dict[str, Any]) -> bool:
    s = status(ex)
    return s["exists"] and not s["dead"]


def cwd(ex: Dict[str, Any]) -> Optional[str]:
    code, out, _ = tmux_run(ex, ["display-message", "-p", "-t", f"={ex['name']}:", "#{pane_start_path}"])
    return out.strip() or None if code == 0 else None


def capture(ex: Dict[str, Any], lines: int) -> Optional[str]:
    """The pane's last `lines` lines with their SGR styles; None when the session is gone."""
    code, out, _ = tmux_run(ex, ["capture-pane", "-p", "-e", "-t", f"={ex['name']}:", "-S", f"-{lines}"])
    return out if code == 0 else None


def end(ex: Dict[str, Any]) -> None:
    """Ends the task's tmux session. cmux's local-tmux server ends it through cmux, whose registry would otherwise keep
    the name bound to the gone session and refuse the next start; an entry cmux won't close is pruned."""
    cmux = which("cmux") if ex["server"] == "cmux" else None
    if cmux and run([cmux, "local-tmux", "close", ex["name"]], timeout=15)[0] == 0:
        return
    tmux_run(ex, ["kill-session", "-t", f"={ex['name']}"])
    if cmux:
        run([cmux, "local-tmux", "cleanup", "--prune"], timeout=15)


def kill(ex: Dict[str, Any]) -> bool:
    """Ends the task's tmux session and its agent; True once it is gone."""
    end(ex)
    return not status(ex)["exists"]


def attach_in_cmux(ex: Dict[str, Any], part: Dict[str, str], focus: bool) -> bool:
    """Shows a session on cmux's local-tmux server in the cmux workspace of `part`, as cmux shows its own local-tmux
    sessions; False for a session on the board's server, or when cmux refuses."""
    if ex["server"] != "cmux":
        return False
    code, _, _ = run([part["cli"], "--socket", part["socket"], "local-tmux", "attach", ex["name"],
                      "--workspace", part["workspace"], "--focus", "true" if focus else "false"], timeout=15)
    return code == 0


def reap(ex: Dict[str, Any]) -> None:
    """Ends the task's tmux session only while its agent has exited, never a session started anew meanwhile."""
    name = ex["name"]
    if ex["server"] == "cmux":
        if status(ex)["dead"]:
            end(ex)
        return
    tmux_run(ex, ["if-shell", "-F", "-t", f"={name}:", "#{pane_dead}", f"kill-session -t ={name}"])


def signal(ex: Dict[str, Any], sig: int) -> bool:
    """Sends `sig` to the agent of a live pane; False when none runs."""
    s = status(ex)
    if not s["exists"] or s["dead"] or not s["pid"]:
        return False
    try:
        os.kill(s["pid"], sig)
    except ProcessLookupError:
        return False
    return True


def attach_command(ex: Dict[str, Any]) -> str:
    """The shell command that attaches a terminal to the task's session. The exact-match target is always quoted: zsh
    expands an unquoted `=word` to the path of a command named word."""
    return shlex.join([which("tmux") or "tmux", *server_args(ex), "attach-session", "-t"]) + f" '={ex['name']}'"


def write_launcher(path: Path, ex: Dict[str, Any], script: Path) -> None:
    """The shell a createWorktree hook's terminal runs: starts the agent's tmux session unless it exists, then shows it."""
    tmux = which("tmux") or "tmux"
    server = shlex.join([tmux, *server_args(ex)])
    name = ex["name"]
    if ex["server"] == "cmux":
        cmux = shlex.quote(which("cmux") or "cmux")
        command = shlex.quote(f"/bin/sh {shlex.quote(str(script))}")
        launch = (f'{cmux} local-tmux start {shlex.quote(name)} --cwd "$wt" --command {command} --detached && '
                  f"{server} set-option -w -t {shlex.quote(f'={name}:')} remain-on-exit on \\; "
                  f"set-option -t {shlex.quote(f'={name}:')} status off")
    else:
        options = " \\; ".join(shlex.join(o) for o in SERVER_OPTIONS)
        launch = (f"{server} {options} \\; new-session -d -s {shlex.quote(name)} -c \"$wt\" -x 200 -y 50 "
                  f"/bin/sh {shlex.quote(str(script))}")
    text = ("#!/bin/sh\n"
            "# Starts the task's agent in its tmux session unless it already runs, then shows it in this terminal.\n"
            'wt="${ORCHESTRATOR_WORKTREE:-$PWD}"\n'
            f"{server} has-session -t {shlex.quote(f'={name}')} 2>/dev/null || {launch}\n"
            f"exec {attach_command(ex)}\n")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    os.chmod(path, 0o755)


def pid_alive(pid: Optional[int], started: Optional[str]) -> bool:
    """Whether process `pid` runs and is the one that started at `started` (ps lstart), not a reused pid."""
    if not pid or not started:
        return False
    code, out, _ = run(["ps", "-o", "lstart=", "-p", str(pid)], timeout=5)
    return code == 0 and out.strip() == started
