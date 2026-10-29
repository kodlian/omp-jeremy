#!/usr/bin/env python3
"""Orchestrator server: a local board whose tasks are triaged, optionally planned and implemented by omp in worktrees."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import queue
import re
import shlex
import shutil
import signal
import sys
import threading
import time
import unicodedata
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import agent_host
import beads_store as beads
from cmux import ghostty_cli, terminal_appearance
from gitops import (base_ref, checkout_info, default_branch, drop_missing_worktrees, find_worktree, git_toplevel,
                    has_ref, merge_base, prepare_branch, unmerged_files)
from integrations import PACKAGE_ROOT, terminals
from runtime import ANSI, child_env, now_iso, plain, run, same_dir, tail, which, within, write_atomic

ROOT = Path(__file__).resolve().parent
HOME = Path(os.environ.get("KANBOARD_HOME", "~/.kanboard")).expanduser()
TASKS_DIR = HOME / "tasks"
HOSTS_DIR = HOME / "hosts"
HOST = "127.0.0.1"
PORT = int(os.environ.get("KANBOARD_PORT", "4747"))
BRANCH_PREFIX = os.environ.get("KANBOARD_BRANCH_PREFIX", "feature/")
APPEARANCE_TTL = 30.0
THEME_COLOR = re.compile(r"#(?:[0-9a-fA-F]{3}){1,2}")
THEME_VARS = {"--bg", "--fg", "--accent", "--accent-fg", "--muted", "--add", "--remove", "--warning", "--cyan"}
STARTED = time.time()


def code_mtime() -> float:
    """The newest Python source of the server and of the shared package, so an update of either restarts the server."""
    newest = max(path.stat().st_mtime for path in ROOT.glob("*.py"))
    for dirpath, dirnames, filenames in os.walk(PACKAGE_ROOT):
        dirnames[:] = [d for d in dirnames if d != "node_modules" and not d.startswith(".")]
        newest = max([newest] + [os.stat(os.path.join(dirpath, f)).st_mtime for f in filenames if f.endswith(".py")])
    return newest


CODE_MTIME = code_mtime()

COLUMNS = [("backlog", "Backlog"), ("todo", "Todo"), ("doing", "In Progress"), ("review", "Review"), ("done", "Done")]
COLUMN_IDS = [c for c, _ in COLUMNS]
LIVE_COLUMNS = {"todo", "doing", "review"}
MOVE_GUARDED_AGENT_STATES = {"planning", "thinking", "working", "needs_input", "plan_ready", "disconnected"}
PAUSED_COLUMNS = ("todo", "backlog")
CONTROL_TIMEOUT = 10.0
STOP_TIMEOUT = 8.0
RESUME_GRACE = 180.0
RESUME_TEXT = "Orchestrator moved {id} back to In Progress: continue where you stopped."
PLANNING_MODES = {"auto", "plan", "fast"}
SPAWN_LOG_LIMIT = 6000
PRESENTATION_INTERVAL = 30.0
LEGACY_PROBE_INTERVAL = 30.0
MESSAGE_LIMIT = 2000
TERMINAL_LIMIT = 4096
DIFF_LIMIT = 500_000
CONTEXT_KINDS = ("finding", "outcome")
CONTEXT_ENTRY_LIMIT = 4000
HANDOFF_LIMIT = 3000
HANDOFF_FINDINGS = 3
CONTEXT_HEADER = re.compile(r"^### (finding|outcome) · (\S+) · (\S+) · (\S+)[ \t]*$", re.M)


class ApiError(Exception):
    def __init__(self, status: int, message: str, extra: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}


# --- helpers ------------------------------------------------------------------


def slugify(text: str, limit: int = 40) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    slug = ""
    for word in re.findall(r"[a-z0-9]+", ascii_text):
        candidate = f"{slug}-{word}" if slug else word
        if len(candidate) > limit:
            break
        slug = candidate
    return slug or "task"


def initial_context() -> Dict[str, str]:
    for candidate in (os.environ.get("KANBOARD_REPO"), os.getcwd()):
        if candidate and Path(candidate).expanduser().is_dir():
            info = checkout_info(str(Path(candidate).expanduser()))
            if info:
                return info
    return {"checkout": os.getcwd(), "repo": os.getcwd(), "base": "main"}


def flow_id(repo: str, base: str) -> str:
    return f"{os.path.basename(repo)}@{base}"


def checkout_exists(path: Optional[str]) -> bool:
    """Whether `path` is still a git checkout: a repository, or a linked worktree whose git directory remains."""
    if not path:
        return False
    dot_git = Path(path) / ".git"
    if dot_git.is_dir():
        return True
    try:
        text = dot_git.read_text(encoding="utf-8")
    except OSError:
        return False
    return text.startswith("gitdir:") and (Path(path) / text[len("gitdir:"):].strip()).is_dir()


CONFIG_FILE = HOME / "config.json"
SCRIPT_KEYS = ("setupScript", "teardownScript")


def read_config() -> Dict[str, Any]:
    """config.json as an object; {} when it doesn't exist."""
    try:
        text = CONFIG_FILE.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as e:
        raise ApiError(500, f"Invalid {CONFIG_FILE}: {e.strerror or e}")
    try:
        config = json.loads(text)
    except ValueError as e:
        raise ApiError(500, f"Invalid {CONFIG_FILE}: {e}")
    if not isinstance(config, dict):
        raise ApiError(500, f"Invalid {CONFIG_FILE}: it must be an object")
    return config


def config_object(container: Dict[str, Any], key: str, label: str) -> Dict[str, Any]:
    value = container.get(key)
    if not isinstance(value, (dict, type(None))):
        raise ApiError(500, f"Invalid {CONFIG_FILE}: {label} must be an object")
    return value or {}


def hook(name: str) -> Optional[str]:
    """The command config.json sets for `name`, or None to use the built-in behavior."""
    command = config_object(read_config(), "commands", "commands").get(name)
    if command is not None and not isinstance(command, str):
        raise ApiError(500, f"Invalid {CONFIG_FILE}: commands.{name} must be a string")
    return command if command and command.strip() else None


def project_scripts(project: str, config: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """A project's scripts as written: its own value unless absent or null (empty means none), else the default."""
    config = read_config() if config is None else config
    defaults = config_object(config, "defaults", "defaults")
    own = config_object(config_object(config, "projects", "projects"), project, f"projects.{project}")
    scripts = {}
    for key in SCRIPT_KEYS:
        value = own.get(key)
        if value is None:
            value = defaults.get(key)
        if not isinstance(value, (str, type(None))):
            raise ApiError(500, f"Invalid {CONFIG_FILE}: {key} must be a string")
        scripts[key] = (value or "").strip()
    return scripts


def run_hook(name: str, command: str, cwd: str, timeout: float, env: Dict[str, str]) -> Tuple[int, str, str]:
    """Runs a configured command through /bin/sh; returns (exit code, output, failure message)."""
    code, out, err = run(["/bin/sh", "-c", command], cwd=cwd, timeout=timeout, env=env)
    output = plain(ANSI.sub("", out + err))
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return code, output, lines[-1] if lines else f"{name} exited with code {code}"


def run_script(label: str, script: str, cwd: str, timeout: float, env: Dict[str, str]) -> str:
    """Runs a project script with bash in cwd and returns its log; a failure is logged, never raised."""
    path = os.path.expanduser(script)
    code, out, err = run(["bash", path], cwd=cwd, timeout=timeout, env=env)
    output = plain(ANSI.sub("", out + err)).strip()
    status = "finished" if code == 0 else f"failed with exit code {code}"
    return f"{label} {path} {status}\n" + (f"{output}\n" if output else "")


def script_env(t: Dict[str, Any], worktree: str) -> Dict[str, str]:
    return {"KANBOARD_TASK": t["id"], "KANBOARD_REPO": t["repo"], "KANBOARD_BRANCH": t["branch"],
            "KANBOARD_BASE": t["base"], "KANBOARD_WORKTREE": worktree}


# --- event hub ------------------------------------------------------------------

def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


class Hub:
    """Fans server-sent events out to every connected board and omp session; snapshots are coalesced. A task's omp session
    also takes commands (pause, resume, message, plan review, stop) and answers each one."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.subscribers: Dict["queue.Queue[str]", Dict[str, Any]] = {}
        self.dirty = threading.Event()
        self.answers: Dict[str, Dict[str, Any]] = {}
        self.queued: Dict[str, Dict[str, Any]] = {}

    def subscribe(self, meta: Dict[str, Any]) -> "queue.Queue[str]":
        """`meta`: the stream's session, flow, task (a task's own session) and validated terminal context (each optional)."""
        q: "queue.Queue[str]" = queue.Queue(maxsize=2000)
        with self.lock:
            self.subscribers[q] = {**meta, "at": time.time()}
            waiting = self.queued.get(meta.get("task") or "")
            if waiting:
                q.put_nowait(sse("control", waiting))
        return q

    def unsubscribe(self, q: "queue.Queue[str]") -> None:
        with self.lock:
            self.subscribers.pop(q, None)

    def flow_live(self, flow: str) -> bool:
        with self.lock:
            return any(m.get("flow") == flow for m in self.subscribers.values())

    def flow_session(self, flow: str, preferred: Optional[str]) -> Optional[Dict[str, Any]]:
        """The stream of `preferred` with `flow`, else the most recently connected stream with `flow`."""
        with self.lock:
            streams = sorted((m for m in self.subscribers.values() if m.get("flow") == flow and m.get("session")),
                             key=lambda m: m["at"], reverse=True)
        return next((m for m in streams if m["session"] == preferred), None) or next(iter(streams), None)

    def publish(self, event: str, data: Any, session: Optional[str] = None) -> bool:
        """Sends to every stream, or only to `session`'s; returns whether any stream got it."""
        payload = sse(event, data)
        sent = False
        with self.lock:
            for q, meta in list(self.subscribers.items()):
                if session is not None and meta.get("session") != session:
                    continue
                try:
                    q.put_nowait(payload)
                    sent = True
                except queue.Full:
                    pass
        return sent

    def task_stream(self, task_id: str) -> Optional["queue.Queue[str]"]:
        """The stream of the omp session that connected last for `task_id` (call under self.lock)."""
        streams = [(meta["at"], q) for q, meta in self.subscribers.items() if meta.get("task") == task_id]
        return max(streams, key=lambda s: s[0])[1] if streams else None

    def task_live(self, task_id: str) -> bool:
        with self.lock:
            return self.task_stream(task_id) is not None

    def session_terminal(self, session: str) -> Optional[Dict[str, Any]]:
        """The terminal context of `session`'s most recently connected stream."""
        with self.lock:
            streams = sorted((m for m in self.subscribers.values() if m.get("session") == session and m.get("terminal")),
                             key=lambda m: m["at"], reverse=True)
        return streams[0]["terminal"] if streams else None

    def wait_gone(self, task_id: str, timeout: float) -> None:
        """Waits until no omp session of `task_id` is connected, or `timeout` passes."""
        deadline = time.time() + timeout
        while self.task_live(task_id) and time.time() < deadline:
            time.sleep(0.2)

    def control(self, task_id: str, action: str, payload: Optional[Dict[str, Any]] = None) -> str:
        """Has `task_id`'s omp session carry out `action` and returns its answer; raises when no session is connected,
        none answers in time, or it refuses."""
        cid = uuid.uuid4().hex
        answer: Dict[str, Any] = {"done": threading.Event()}
        with self.lock:
            q = self.task_stream(task_id)
            if q is None:
                raise ApiError(409, f"{task_id}'s omp session isn't connected to the board; restart it to load the "
                                    "current Orchestrator plugin")
            self.answers[cid] = answer
            q.put_nowait(sse("control", {"id": cid, "task": task_id, "action": action, **(payload or {})}))
        try:
            if not answer["done"].wait(CONTROL_TIMEOUT):
                raise ApiError(504, f"{task_id}'s omp session didn't answer")
        finally:
            with self.lock:
                self.answers.pop(cid, None)
        if not answer["ok"]:
            raise ApiError(409, answer["message"] or f"{task_id}'s omp session refused to {action}")
        return answer["message"]

    def queue_control(self, task_id: str, action: str, payload: Dict[str, Any],
                      then: Callable[[bool, str], None]) -> None:
        """Sends `action` to `task_id`'s omp session now, and again whenever one connects until one answers; `then` gets the
        answer. Replaces the command already waiting for that task."""
        data = {"id": uuid.uuid4().hex, "task": task_id, "action": action, **payload}
        with self.lock:
            replaced = self.queued.pop(task_id, None)
            if replaced:
                self.answers.pop(replaced["id"], None)
            self.queued[task_id] = data
            self.answers[data["id"]] = {"task": task_id, "then": then}
            q = self.task_stream(task_id)
            if q is not None:
                q.put_nowait(sse("control", data))

    def cancel_queued(self, task_id: str) -> None:
        with self.lock:
            waiting = self.queued.pop(task_id, None)
            if waiting:
                self.answers.pop(waiting["id"], None)

    def answer(self, cid: str, ok: bool, message: str) -> bool:
        """Delivers a session's answer to command `cid`; False when nothing waits for it."""
        with self.lock:
            answer = self.answers.pop(cid, None)
            if answer and "task" in answer:
                self.queued.pop(answer["task"], None)
        if not answer:
            return False
        if "done" in answer:
            answer.update(ok=ok, message=message)
            answer["done"].set()
        else:
            answer["then"](ok, message)
        return True

    def changed(self) -> None:
        self.dirty.set()

    def run_snapshots(self) -> None:
        while True:
            self.dirty.wait()
            time.sleep(0.15)
            self.dirty.clear()
            self.publish("snapshot", store.board())


hub = Hub()


# --- store ----------------------------------------------------------------------

BOARD_FILE = HOME / "board.json"


def beads_api_error(e: beads.BeadsError) -> ApiError:
    if isinstance(e, beads.BeadsConflict):
        return ApiError(409, f"{e}; the board shows the Beads version on its next refresh")
    return ApiError(502, str(e))


class Store:
    """Tasks in Beads (beads_store) plus their runtime record (tasks/<id>/execution.json) and live status.

    The board's context is the checkout `orchestrator` was started from: new tasks branch from its branch (`base`)
    and their pull requests target it.
    """

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.tasks: Dict[str, Dict[str, Any]] = {}
        self.workspace = beads.Workspace(HOME, child_env())
        self.seen: Dict[str, Dict[str, Any]] = {}
        self.persisted: Dict[str, Dict[str, Any]] = {}
        self.synced: Optional[Tuple[Any, ...]] = None
        self.writes = 0
        self.native_blocked: Dict[str, List[str]] = {}
        self.blocked_at: Optional[Tuple[Any, ...]] = None
        self.context: Dict[str, str] = {}
        self.flows: List[Dict[str, Any]] = []
        self.activity: Dict[str, str] = {}
        self.resuming: Dict[str, float] = {}
        self.hosts: Dict[str, Dict[str, Any]] = {}
        self.themes: Dict[str, Dict[str, Any]] = {}
        self.theme_version = 0

    # persistence

    def load(self) -> None:
        TASKS_DIR.mkdir(parents=True, exist_ok=True)
        try:
            saved = json.loads(BOARD_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            saved = {}
        context = saved.get("context") or {}
        self.context = context if Path(context.get("checkout") or "/nonexistent").is_dir() else initial_context()
        self.flows = [f for f in saved.get("flows") or []
                      if isinstance(f, dict) and Path(f.get("checkout") or "/nonexistent").is_dir()]
        for flow in self.flows:
            limit = flow.get("concurrencyLimit")
            flow["concurrencyLimit"] = limit if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0 else None
        self.workspace.require_binary()
        if not self.workspace.prepared():
            raise beads.BeadsError(f"{self.workspace.root} isn't prepared: run python3 {ROOT / 'server.py'} --prepare")
        fingerprint = self.workspace.fingerprint()
        found = self.workspace.list_all()
        blocked = self.workspace.blocked()
        with self.lock:
            self.synced = fingerprint
            self.native_blocked, self.blocked_at = blocked, fingerprint
            self.reconcile(found)
        self.load_hosts()

    def load_hosts(self) -> None:
        """Reads every managed host's status; removes host directories no task references once their agent is gone (a
        running orphan, e.g. of a card deleted without cleanup, stays attachable)."""
        referenced = set()
        for t in self.tasks.values():
            directory = host_dir(t)
            if directory:
                referenced.add(os.path.realpath(directory))
                self.hosts[t["id"]] = agent_host.status(directory)
        for path in sorted(HOSTS_DIR.iterdir()) if HOSTS_DIR.is_dir() else []:
            if path.is_dir() and os.path.realpath(path) not in referenced and not agent_host.status(path)["alive"]:
                shutil.rmtree(path, ignore_errors=True)

    def sync(self) -> bool:
        """Takes in task edits made in Beads outside the board; True when the board changed."""
        fingerprint = self.workspace.fingerprint()
        if fingerprint is not None and fingerprint == self.synced:
            return False
        with self.lock:
            writes = self.writes
        try:
            found = self.workspace.list_all()
            blocked = self.workspace.blocked()
        except beads.BeadsError as e:
            raise beads_api_error(e)
        with self.lock:
            # A board write during the listing makes it stale; the next tick lists again.
            if self.writes != writes:
                return False
            self.synced = fingerprint
            changed = blocked != self.native_blocked
            self.native_blocked, self.blocked_at = blocked, fingerprint
            return self.reconcile(found) or changed

    def fresh_blocked(self) -> bool:
        """Re-reads Beads' blockers unless Beads is unchanged since the last read, before the board starts or resumes
        work; a failed read raises rather than start on stale blockers (call under self.lock). True when they changed."""
        fingerprint = self.workspace.fingerprint()
        if fingerprint is not None and fingerprint == self.blocked_at:
            return False
        try:
            blocked = self.workspace.blocked()
        except beads.BeadsError as e:
            raise beads_api_error(e)
        changed = blocked != self.native_blocked
        self.native_blocked, self.blocked_at = blocked, fingerprint
        return changed

    def blockers_after_write(self) -> None:
        """Re-reads Beads' blockers after a parent or dependency write, so the reply shows them; the write already landed,
        so a failed read only leaves the next sync to catch up (call under self.lock)."""
        try:
            self.fresh_blocked()
        except ApiError as e:
            print(f"orchestrator: couldn't re-read Beads' blockers: {e.message}", file=sys.stderr)

    def reconcile(self, found: List[Dict[str, Any]]) -> bool:
        """Brings the cards in line with the listed beads (call under self.lock)."""
        listed = {b["id"]: b for b in found if b.get("id")}
        changed = False
        for task_id in [i for i in self.tasks if i not in listed]:
            print(f"orchestrator: {task_id} was deleted in Beads; its card is gone, any worktree stays", file=sys.stderr)
            self.forget(task_id)
            changed = True
        for task_id, bead in listed.items():
            f = beads.fields(bead)
            if task_id not in self.tasks:
                changed |= self.adopt(task_id, f)
                continue
            seen = self.seen[task_id]
            if f["status"] != seen["status"] or f["metadata"] != seen["metadata"] or f["updatedAt"] != seen["updatedAt"] \
                    or any(beads.differs(k, f[k], seen.get(k)) for k in beads.FIELDS):
                self.apply(self.tasks[task_id], f)
                changed = True
        return changed

    def adopt(self, task_id: str, f: Dict[str, Any]) -> bool:
        """Builds the card of a bead the board doesn't hold; ones new from bd join the context flow."""
        try:
            runtime = json.loads(self.runtime_path(task_id).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            runtime = {}
        upgraded = beads.upgrade_runtime(runtime, terminals.legacy_context, terminals.legacy_attachment)
        column = runtime.get("seenColumn") if runtime.get("seenColumn") in COLUMN_IDS else "backlog"
        t: Dict[str, Any] = {k: runtime.get(k) for k in beads.RUNTIME_KEYS}
        t.update({k: copy.deepcopy(f[k]) for k in beads.FIELDS})
        t.update(id=task_id, column=column, createdAt=f["createdAt"], agent=None, git=None)
        if not isinstance(t["spawn"], dict):
            t["spawn"] = {"state": "none", "error": None, "log": ""}
        if t["spawn"].get("state") == "running":
            t["spawn"].update(state="failed", error="Interrupted: the board server restarted")
        if not t["repo"]:
            t.update(self.context)
            t.update(branchEdited=False, planningMode="auto")
            t["merge"] = default_merge(t)
            t["branch"] = self.suggest_branch(t)
        t["checkout"] = t["checkout"] or t["repo"]
        t["base"] = t["base"] or default_branch(t["repo"])
        t["merge"] = t["merge"] if t["merge"] in ("pr", "local") else "pr"
        t["branchEdited"] = bool(t["branchEdited"])
        t["planningMode"] = t["planningMode"] if t["planningMode"] in PLANNING_MODES else "plan"
        outcome = t.get("planningOutcome") if t.get("planningOutcome") in ("plan", "fast") else None
        if outcome is None and t["planningMode"] in ("plan", "fast") and t.get("worktree"):
            outcome = t["planningMode"]
        t["planningOutcome"] = outcome
        if not isinstance(t.get("order"), (int, float)):
            t["order"] = self.next_order(column)
        t["updatedAt"] = max(t.get("updatedAt") or "", f["updatedAt"])
        self.tasks[task_id] = t
        self.seen[task_id] = {**copy.deepcopy(f), "column": column}
        self.persisted[task_id] = copy.deepcopy(runtime)
        if not self.apply(t, f) and not t.get("repo"):
            self.tasks.pop(task_id, None)
            self.seen.pop(task_id, None)
            self.persisted.pop(task_id, None)
            return False
        if upgraded:
            # Once: the record moves onto presentation and execution, keeping its ids, paths and queue position.
            self.write_record(t)
        return True

    def apply(self, t: Dict[str, Any], f: Dict[str, Any]) -> bool:
        """Takes a bead's outside edits into its card, writing back moves that would start or shift started work."""
        task_id = t["id"]
        seen = self.seen[task_id]
        started = has_started(t)
        kept: Dict[str, Any] = {}
        moved = False
        for key in beads.FIELDS:
            if not beads.differs(key, f[key], seen.get(key)) or not beads.differs(key, f[key], t.get(key)):
                continue
            if key == "column":
                if started or f["column"] in LIVE_COLUMNS:
                    kept[key] = t[key]
                    continue
                t["column"], t["order"] = f["column"], self.next_order(f["column"])
                moved = True
            elif key in beads.CONFIG_KEYS and started:
                kept[key] = t[key]
            else:
                t[key] = copy.deepcopy(f[key])
        plan_changed = beads.differs("plan", f["plan"], seen.get("plan"))
        if plan_changed:
            t["planUpdatedAt"] = f["updatedAt"]
            if spawned(t) and t["planningMode"] == "auto" and t.get("planningOutcome") is None and t["plan"].strip():
                t["planningOutcome"] = "plan"
        renamed = f["title"] != seen.get("title") or f["ticket"] != seen.get("ticket")
        if renamed and not started and not t.get("branchEdited") and f["branch"] == seen.get("branch"):
            t["branch"] = self.suggest_branch(t)
        self.seen[task_id] = copy.deepcopy(f)
        t["updatedAt"] = max(t.get("updatedAt") or "", f["updatedAt"])
        if kept:
            titles = dict(COLUMNS)
            what = ", ".join(f"column ({titles[t['column']]}, Beads says {f['status']})" if k == "column" else k
                             for k in kept)
            print(f"orchestrator: {task_id} keeps its board {what}: starting or changing a started task happens on the board",
                  file=sys.stderr)
        if not (kept or moved or plan_changed or any(beads.differs(k, t.get(k), f.get(k)) for k in beads.FIELDS)):
            return True
        try:
            self.save(t)
        except ApiError as e:
            t.update(kept)
            self.synced = None
            print(f"orchestrator: couldn't write {task_id}'s board values to Beads, retrying: {e.message}", file=sys.stderr)
            return False
        return True

    def task_dir(self, task_id: str) -> Path:
        return TASKS_DIR / task_id

    def runtime_path(self, task_id: str) -> Path:
        return self.task_dir(task_id) / "execution.json"

    def save(self, t: Dict[str, Any]) -> None:
        """Writes the fields the board changed to the bead, then the runtime record; reverts the card on failure."""
        task_id = t["id"]
        changes = [k for k in beads.FIELDS if beads.differs(k, t.get(k), self.seen[task_id].get(k))]
        if changes:
            try:
                self.push(t, changes)
            except beads.BeadsError as e:
                self.revert(t)
                raise beads_api_error(e)
        t["updatedAt"] = now_iso()
        self.write_record(t)

    def write_record(self, t: Dict[str, Any]) -> None:
        record = {**beads.runtime_record(t), "seenColumn": self.seen[t["id"]]["column"]}
        write_atomic(self.runtime_path(t["id"]), json.dumps(record, indent=2))
        self.persisted[t["id"]] = copy.deepcopy(record)

    def push(self, t: Dict[str, Any], changes: List[str]) -> None:
        task_id = t["id"]
        seen = self.seen[task_id]
        self.writes += 1
        fingerprint = self.workspace.fingerprint()
        if fingerprint is None or fingerprint != self.synced:
            current = beads.fields(self.workspace.show(task_id))
            stale = [k for k in changes if beads.differs(k, current[k], seen.get(k))]
            if stale:
                raise beads.BeadsConflict(f"{task_id}'s {', '.join(stale)} changed in Beads since the board read it")
        args: List[str] = []
        for key, flag in (("title", "--title"), ("description", "--description"), ("plan", "--design"),
                          ("ticket", "--external-ref"), ("parent", "--parent")):
            if key in changes:
                args += [flag, t.get(key) or ""]
        config = {k: t.get(k) for k in beads.CONFIG_KEYS}
        if any(k in changes for k in beads.CONFIG_KEYS):
            args += ["--metadata", json.dumps({"kanboard": config})]
        status = beads.STATUS_FOR_COLUMN[t["column"]]
        want = list(t["dependsOn"])
        # Removals go first: bd refuses a parent that the task still depends on.
        for dep in [d for d in seen["dependsOn"] if d not in want]:
            self.workspace.remove_dep(task_id, dep)
            seen["dependsOn"] = [d for d in seen["dependsOn"] if d != dep]
        if "column" in changes:
            args += ["--status", status] + (["--force"] if status == "closed" else [])
        if args:
            self.workspace.update(task_id, args, if_status=seen["status"] if "column" in changes else None)
            for key in changes:
                if key != "dependsOn":
                    seen[key] = copy.deepcopy(t.get(key))
            if "column" in changes:
                seen["status"] = status
            if any(k in changes for k in beads.CONFIG_KEYS):
                seen["metadata"] = {**seen["metadata"], "kanboard": config}
        for dep in [d for d in want if d not in seen["dependsOn"]]:
            self.workspace.add_dep(task_id, dep)
            seen["dependsOn"] = seen["dependsOn"] + [dep]

    def revert(self, t: Dict[str, Any]) -> None:
        seen = self.seen[t["id"]]
        for key in beads.FIELDS:
            t[key] = copy.deepcopy(seen.get(key))
        persisted = self.persisted.get(t["id"]) or {}
        for key in beads.RUNTIME_KEYS:
            if key in persisted:
                t[key] = copy.deepcopy(persisted[key])

    def create(self, t: Dict[str, Any]) -> None:
        """Creates the bead of a new task; bd assigns its KB-<n> id, or <parent>.<n> for a child (call under self.lock)."""
        self.writes += 1
        try:
            bead = self.workspace.create(t)
        except beads.BeadsError as e:
            raise beads_api_error(e)
        f = beads.fields(bead)
        t.update({k: copy.deepcopy(f[k]) for k in beads.FIELDS})
        t.update(id=bead["id"], createdAt=f["createdAt"])
        self.tasks[t["id"]] = t
        self.seen[t["id"]] = f
        self.save(t)
        if t.get("parent"):
            self.blockers_after_write()

    def delete(self, task_id: str) -> None:
        """Deletes a task's bead (bd drops its dependency links too), then its card (call under self.lock)."""
        self.writes += 1
        try:
            self.workspace.delete(task_id)
        except beads.BeadsError as e:
            raise beads_api_error(e)
        self.forget(task_id)

    def forget(self, task_id: str) -> None:
        self.tasks.pop(task_id, None)
        self.seen.pop(task_id, None)
        self.persisted.pop(task_id, None)
        self.activity.pop(task_id, None)
        self.resuming.pop(task_id, None)
        self.hosts.pop(task_id, None)
        self.native_blocked.pop(task_id, None)
        hub.cancel_queued(task_id)
        for other_id, other in self.tasks.items():
            if task_id in other["dependsOn"]:
                other["dependsOn"] = [d for d in other["dependsOn"] if d != task_id]
            seen = self.seen.get(other_id)
            if seen and task_id in seen["dependsOn"]:
                seen["dependsOn"] = [d for d in seen["dependsOn"] if d != task_id]
            # bd orphans a deleted parent's children.
            if other.get("parent") == task_id:
                other["parent"] = None
            if seen and seen.get("parent") == task_id:
                seen["parent"] = None
        shutil.rmtree(self.task_dir(task_id), ignore_errors=True)

    def save_board(self) -> None:
        write_atomic(BOARD_FILE, json.dumps({"context": self.context, "flows": self.flows}, indent=2))

    def write_plan(self, t: Dict[str, Any], text: str) -> None:
        t["plan"] = text
        t["planUpdatedAt"] = now_iso()

    def read_context(self, task_id: str) -> Dict[str, Any]:
        """A task's shared context: its bead's notes, read from Beads now (call without self.lock)."""
        with self.lock:
            self.get(task_id)
        try:
            bead = self.workspace.show(task_id)
        except beads.BeadsError as e:
            raise beads_api_error(e)
        return {"beadId": bead["id"], "notes": bead.get("notes") or "", "updatedAt": bead.get("updated_at")}

    def append_context(self, task_id: str, text: str) -> Dict[str, Any]:
        """Appends to a task's bead notes in one bd update, never rewriting what's there (call without self.lock)."""
        with self.lock:
            self.get(task_id)
        try:
            bead = self.workspace.append_notes(task_id, text)
        except beads.BeadsError as e:
            raise beads_api_error(e)
        return {"beadId": bead["id"], "notes": bead.get("notes") or "", "updatedAt": bead.get("updated_at")}

    # views

    def view(self, t: Dict[str, Any]) -> Dict[str, Any]:
        connected = hub.task_live(t["id"])
        host = self.hosts.get(t["id"])
        directory = host_dir(t)
        return {
            "id": t["id"],
            "title": t["title"],
            "description": t.get("description", ""),
            "column": t["column"],
            "order": t["order"],
            "ticket": t.get("ticket"),
            "branch": t.get("branch", ""),
            "repo": t["repo"],
            "checkout": t.get("checkout"),
            "base": t["base"],
            "merge": t["merge"],
            "planningMode": t["planningMode"],
            "planningOutcome": t.get("planningOutcome"),
            "dependsOn": list(t["dependsOn"]),
            "parent": t.get("parent"),
            "children": children(t["id"]),
            "blockedBy": blocked_by(t),
            "waitingForSlot": waiting_for_slot(t),
            "paused": paused(t),
            "moveRequiresConfirmation": move_requires_confirmation(t),
            "pendingUpdate": pending_update(t),
            "merged": t.get("merged"),
            "createdAt": t["createdAt"],
            "updatedAt": t["updatedAt"],
            "plan": t.get("plan", ""),
            "planUpdatedAt": t.get("planUpdatedAt"),
            "spawn": {
                "state": t["spawn"].get("state", "none"),
                "error": t["spawn"].get("error"),
                "log": t["spawn"].get("log", ""),
            },
            "worktree": t.get("worktree"),
            "health": {"worktreeMissing": worktree_missing(t)},
            "presentation": t.get("presentation"),
            "execution": execution_view(t, connected, host),
            "session": session_view(t, connected),
            "attachCommand": agent_host.command("attach", directory) if directory and (host or {}).get("alive") else None,
            "agent": t.get("agent"),
            "git": t.get("git"),
            "pr": t.get("pr"),
            "flow": flow_id(t["repo"], t["base"]),
            "origin": t.get("origin"),
        }

    def flow_list(self) -> List[Dict[str, Any]]:
        """Registered flows and flows that have tasks, while their checkout is still a git checkout or an omp session
        streams for them; the registered checkout wins. A flow whose checkout was deleted drops out, its tasks stay."""
        flows: Dict[str, Dict[str, Any]] = {}

        def entry(repo: str, base: str, checkout: Optional[str],
                  concurrency_limit: Optional[int] = None) -> Dict[str, Any]:
            fid = flow_id(repo, base)
            if fid not in flows:
                flows[fid] = {"id": fid, "name": os.path.basename(repo), "repo": repo, "base": base, "checkout": checkout,
                              "counts": {c: 0 for c in COLUMN_IDS}, "live": hub.flow_live(fid),
                              "concurrencyLimit": concurrency_limit}
            return flows[fid]

        checked: Dict[Tuple[str, Optional[str]], bool] = {}

        def active(repo: str, base: str, checkout: Optional[str]) -> bool:
            fid = flow_id(repo, base)
            if (fid, checkout) not in checked:
                checked[(fid, checkout)] = checkout_exists(checkout) or hub.flow_live(fid)
            return checked[(fid, checkout)]

        for f in self.flows:
            if active(f["repo"], f["base"], f["checkout"]):
                entry(f["repo"], f["base"], f["checkout"], f.get("concurrencyLimit"))
        shown = {flow_id(t["repo"], t["base"]) for t in self.tasks.values()
                 if active(t["repo"], t["base"], t.get("checkout"))}
        for t in self.tasks.values():
            fid = flow_id(t["repo"], t["base"])
            if fid in flows or fid in shown:
                entry(t["repo"], t["base"], t.get("checkout"))["counts"][t["column"]] += 1
        try:
            config = read_config()
        except ApiError:
            config = {}
        for f in flows.values():
            try:
                f.update(project_scripts(f["name"], config))
            except ApiError:
                f.update(dict.fromkeys(SCRIPT_KEYS, ""))
        return sorted(flows.values(), key=lambda f: (f["name"], f["base"]))

    def board(self) -> Dict[str, Any]:
        with self.lock:
            tasks = sorted(self.tasks.values(),
                           key=lambda t: (COLUMN_IDS.index(t["column"]), t["order"], t["createdAt"]))
            return {
                "version": 1,
                "repo": {"path": self.context["checkout"], "name": os.path.basename(self.context["repo"]),
                         "base": self.context["base"], "flow": flow_id(self.context["repo"], self.context["base"])},
                "columns": [{"id": c, "title": title} for c, title in COLUMNS],
                "flows": self.flow_list(),
                "themeVersion": self.theme_version,
                "tasks": [self.view(t) for t in tasks],
            }

    # access

    def get(self, task_id: str) -> Dict[str, Any]:
        t = self.tasks.get(task_id)
        if not t:
            raise ApiError(404, f"No task {task_id}")
        return t

    def next_order(self, column: str) -> float:
        orders = [t["order"] for t in self.tasks.values() if t["column"] == column]
        return (max(orders) if orders else 0.0) + 1000.0

    def suggest_branch(self, t: Dict[str, Any]) -> str:
        ticket = f"{t['ticket'].lower()}-" if t.get("ticket") else ""
        return f"{BRANCH_PREFIX}{ticket}{slugify(t['title'])}"


store = Store()


def spawned(t: Dict[str, Any]) -> bool:
    return bool(t.get("worktree"))


def has_started(t: Dict[str, Any]) -> bool:
    return spawned(t) or bool(t.get("merged")) or t.get("spawn", {}).get("state") in ("running", "done")


def paused(t: Dict[str, Any]) -> bool:
    """A started task in Todo or Backlog: its worktree and omp session stay, but its agent is stopped and holds no slot."""
    return spawned(t) and t["column"] in PAUSED_COLUMNS and not t.get("merged")


def worktree_missing(t: Dict[str, Any]) -> bool:
    """An unfinished started task whose recorded worktree was deleted outside the board: its agent can't resume there."""
    return spawned(t) and not t.get("merged") and t["column"] != "done" and not Path(t["worktree"]).is_dir()


def host_dir(t: Dict[str, Any]) -> Optional[Path]:
    """The directory of the managed host that runs (or ran) a task's agent; None without one."""
    ex = t.get("execution") or {}
    return Path(ex["dir"]) if ex.get("kind") == "managed" and ex.get("dir") else None


def legacy_unknown(t: Dict[str, Any]) -> bool:
    """A pre-host agent in a terminal the board doesn't own, neither connected nor seen to exit: it may still run."""
    ex = t.get("execution") or {}
    return ex.get("kind") == "legacy" and not ex.get("stopped") and not hub.task_live(t["id"])


def process_cwds() -> Optional[List[str]]:
    """The working directory of every running process that runs as this user, whatever its program (omp, a wrapper, a
    shell); None unless every one was read."""
    uid = str(os.geteuid())
    code, listed, _ = run(["ps", "-A", "-o", "pid=,uid=,stat="], timeout=10)
    if code != 0:
        return None
    _, out, _ = run([which("lsof") or "/usr/sbin/lsof", "-n", "-P", "-w", "-a", "-u", uid, "-d", "cwd", "-Fpn"],
                    timeout=20)
    cwds: Dict[str, str] = {}
    pid = None
    for line in out.splitlines():
        if line.startswith("p"):
            pid = line[1:]
        elif line.startswith("n") and pid:
            cwds[pid] = line[1:]
    if any(not os.path.isabs(c) or c.endswith(")") for c in cwds.values()):
        return None
    for fields in (line.split() for line in listed.splitlines()):
        if len(fields) != 3:
            return None
        if fields[1] != uid or fields[0] in cwds or fields[2].startswith("Z"):
            continue
        try:
            os.kill(int(fields[0]), 0)
        except ProcessLookupError:
            continue
        except (OSError, ValueError):
            pass
        return None
    return list(cwds.values())


def agent_live(t: Dict[str, Any]) -> bool:
    """Whether a started task's agent runs or may run: connected, its managed host running (last poll), or legacy unknown."""
    return hub.task_live(t["id"]) or bool(host_dir(t) and (store.hosts.get(t["id"]) or {}).get("alive")) \
        or legacy_unknown(t)


def execution_view(t: Dict[str, Any], connected: bool, host: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    ex = t.get("execution")
    if not ex:
        return None
    if ex.get("kind") == "managed":
        state = "running" if connected or (host or {}).get("alive") else "stopped"
        return {"kind": "managed", "state": state, "exitCode": (host or {}).get("exitCode")}
    state = "running" if connected else "stopped" if ex.get("stopped") else "unknown"
    return {"kind": "legacy", "state": state, "exitCode": None}


def session_view(t: Dict[str, Any], connected: bool) -> Optional[Dict[str, Any]]:
    if not has_started(t):
        return None
    session = (t.get("execution") or {}).get("session") or {}
    return {"id": session.get("id"), "file": session.get("file"), "connected": connected}


def briefing(t: Dict[str, Any]) -> Dict[str, str]:
    return {"title": t["title"], "description": t.get("description") or ""}


def note_briefing(t: Dict[str, Any]) -> None:
    """A task started before briefings were recorded: its agent knows the card as it is before this change."""
    if spawned(t) and not t.get("briefed"):
        t["briefed"] = briefing(t)


def pending_update(t: Dict[str, Any]) -> bool:
    """Whether a started task's title or description changed since its agent received them."""
    live = spawned(t) or t["spawn"].get("state") == "running"
    return (live and bool(t.get("briefed")) and t["column"] != "done" and not t.get("merged")
            and t["briefed"] != briefing(t))


def ancestors(parent: Optional[str]) -> List[str]:
    """`parent` and its own parents up the tree, nearest first (call under store.lock)."""
    chain: List[str] = []
    while parent and parent not in chain:
        chain.append(parent)
        parent = (store.tasks.get(parent) or {}).get("parent")
    return chain


def children(task_id: str) -> List[str]:
    kids = [o for o in store.tasks.values() if o.get("parent") == task_id]
    return [o["id"] for o in sorted(kids, key=lambda o: (o["createdAt"], o["id"]))]


def blocked_by(t: Dict[str, Any]) -> List[str]:
    """Direct open prerequisites plus Beads' effective blockers, including inherited parent blockers."""
    own = [d for d in t["dependsOn"] if d in store.tasks and store.tasks[d]["column"] != "done"]
    return own + [b for b in store.native_blocked.get(t["id"], []) if b not in own]


def flow_concurrency_limit(repo: str, base: str) -> Optional[int]:
    flow = next((f for f in store.flows if same_dir(f["repo"], repo) and f["base"] == base), None)
    return flow.get("concurrencyLimit") if flow else None


def active_task_count(repo: str, base: str) -> int:
    """The flow's tasks holding a slot: started ones In Progress and any still starting; paused ones don't."""
    return sum(1 for t in store.tasks.values()
               if same_dir(t["repo"], repo) and t["base"] == base
               and ((t["column"] == "doing" and spawned(t)) or t["spawn"]["state"] == "running"))


def has_task_slot(t: Dict[str, Any]) -> bool:
    limit = flow_concurrency_limit(t["repo"], t["base"])
    return limit is None or active_task_count(t["repo"], t["base"]) < limit


def waiting_for_slot(t: Dict[str, Any]) -> bool:
    queued = (paused(t) and not legacy_unknown(t)) or (not spawned(t) and t["spawn"]["state"] == "none")
    return t["column"] == "todo" and queued and not blocked_by(t) and not has_task_slot(t)


def move_requires_confirmation(t: Dict[str, Any]) -> bool:
    state = (t.get("agent") or {}).get("state")
    return t["column"] == "doing" or t["spawn"]["state"] == "running" or state in MOVE_GUARDED_AGENT_STATES


def default_merge(t: Dict[str, Any]) -> str:
    """How a new task lands: a pull request into the repository's default branch, else a local merge into its base."""
    return "pr" if t["base"] == default_branch(t["repo"]) else "local"


def validate_merge(value: Any) -> str:
    if value not in ("pr", "local"):
        raise ApiError(400, "Merge mode must be pr or local")
    return value


def validate_planning_mode(value: Any) -> str:
    if value not in PLANNING_MODES:
        raise ApiError(400, "Planning mode must be auto, plan or fast")
    return value


def depends_on(task_id: str, target: str) -> bool:
    """Whether `task_id` reaches `target` through dependencies or parent links, the graph Beads keeps acyclic (call under
    store.lock)."""
    seen, stack = set(), [task_id]
    while stack:
        current = stack.pop()
        if current == target:
            return True
        if current in seen or current not in store.tasks:
            continue
        seen.add(current)
        stack.extend(store.tasks[current]["dependsOn"])
        if store.tasks[current].get("parent"):
            stack.append(store.tasks[current]["parent"])
    return False


def validate_deps(task_id: str, value: Any, repo: str, base: str, parent: Optional[str]) -> List[str]:
    """A task's dependencies: existing task ids of the same flow, deduplicated, without the task itself, a cycle, or a
    task above or below it in the parent tree (Beads refuses those)."""
    if not isinstance(value, list) or not all(isinstance(d, str) for d in value):
        raise ApiError(400, "Dependencies must be a list of task ids")
    deps = list(dict.fromkeys(value))
    for dep in deps:
        if dep == task_id:
            raise ApiError(400, "A task can't depend on itself")
        if dep not in store.tasks:
            raise ApiError(400, f"Unknown task {dep}")
        d = store.tasks[dep]
        if not same_dir(d["repo"], repo):
            raise ApiError(400, f"{dep} belongs to {os.path.basename(d['repo'])}, not {os.path.basename(repo)}")
        if d["base"] != base:
            raise ApiError(400, f"{dep} merges into {d['base']}, not {base}")
        if dep in ancestors(parent):
            raise ApiError(400, f"{dep} is a parent of {task_id or 'this task'}, whose children already inherit its blockers")
        if task_id and task_id in ancestors(d.get("parent")):
            raise ApiError(400, f"{dep} is a child of {task_id}; a task can't depend on its own children")
        if depends_on(dep, task_id):
            raise ApiError(400, f"{dep} already depends on {task_id}")
    return deps


def validate_parent(task_id: str, value: Any, repo: str, base: str, deps: List[str]) -> Optional[str]:
    """A task's parent (None clears it): an existing task of the same flow, neither under the task nor depending on it,
    whose parent tree holds none of the task's dependencies."""
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ApiError(400, "parent must be a task id, or null to clear it")
    if value == task_id:
        raise ApiError(400, "A task can't be its own parent")
    if value not in store.tasks:
        raise ApiError(400, f"Unknown task {value}")
    p = store.tasks[value]
    if not same_dir(p["repo"], repo):
        raise ApiError(400, f"{value} belongs to {os.path.basename(p['repo'])}, not {os.path.basename(repo)}")
    if p["base"] != base:
        raise ApiError(400, f"{value} merges into {p['base']}, not {base}")
    if task_id and depends_on(value, task_id):
        raise ApiError(400, f"{value} is under {task_id} or depends on it")
    clash = next((d for d in deps if d in ancestors(value)), None)
    if clash:
        raise ApiError(400, f"{task_id or 'This task'} depends on {clash}, which would be its parent or above it; "
                            "remove that dependency first")
    return value


def refuse_split_family(t: Dict[str, Any]) -> None:
    """A task's parent and children stay in its flow (call under store.lock)."""
    for other in ([t["parent"]] if t.get("parent") else []) + children(t["id"]):
        o = store.tasks.get(other)
        if o and not (same_dir(o["repo"], t["repo"]) and o["base"] == t["base"]):
            raise ApiError(400, f"{other} stays in {flow_id(o['repo'], o['base'])}; clear the parent link before moving "
                                f"{t['id']} to {flow_id(t['repo'], t['base'])}")


def refuse_task_worktree(info: Dict[str, Any]) -> None:
    """Tasks branch from a parent checkout, never from another task's worktree (call under store.lock)."""
    owner = next((t["id"] for t in store.tasks.values() if same_dir(t.get("worktree"), info["checkout"])), None)
    if owner:
        raise ApiError(400, f"{owner}'s worktree can't have tasks of its own")


def require_spawned(t: Dict[str, Any]) -> str:
    if not spawned(t):
        raise ApiError(409, f"{t['id']} has no worktree yet")
    return t["worktree"]


def normalize_ticket(value: Any) -> Optional[str]:
    text = str(value or "").strip().upper()
    return text or None


def validate_branch(branch: str) -> str:
    branch = branch.strip()
    if not branch or run(["git", "check-ref-format", "--branch", branch], timeout=10)[0] != 0:
        raise ApiError(400, f"“{branch}” is not a valid branch name")
    return branch


# --- task mutations ---------------------------------------------------------------

def create_task(body: Dict[str, Any]) -> Dict[str, Any]:
    title = str(body.get("title") or "").strip()
    if not title:
        raise ApiError(400, "A task needs a title")
    plan = str(body.get("plan") or "")
    origin = validate_origin(body["origin"]) if body.get("origin") is not None else None
    planning_mode = validate_planning_mode(body.get("planningMode", "auto"))
    info = None
    if body.get("repo"):
        info = checkout_info(str(Path(str(body["repo"])).expanduser()))
        if not info:
            raise ApiError(400, f"{body['repo']} is not a git repository")
    with store.lock:
        stamp = now_iso()
        t: Dict[str, Any] = {
            "id": None, "title": title, "description": str(body.get("description") or ""),
            "column": "backlog", "order": store.next_order("backlog"),
            "ticket": normalize_ticket(body.get("ticket")), "branch": "", "branchEdited": False,
            "repo": store.context["repo"], "checkout": store.context["checkout"], "base": store.context["base"],
            "createdAt": stamp, "updatedAt": stamp, "plan": "", "planUpdatedAt": None,
            "spawn": {"state": "none", "error": None, "log": ""},
            "worktree": None, "presentation": None, "execution": None, "agent": None, "git": None, "pr": None,
            "merge": None, "planningMode": planning_mode, "planningOutcome": None,
            "dependsOn": [], "parent": None, "merged": None, "origin": origin,
        }
        if info:
            t.update(info)
        elif isinstance(body.get("parent"), str) and body["parent"] in store.tasks:
            p = store.tasks[body["parent"]]
            t.update(repo=p["repo"], checkout=p.get("checkout") or p["repo"], base=p["base"])
        refuse_task_worktree(t)
        t["parent"] = validate_parent("", body.get("parent"), t["repo"], t["base"], [])
        t["dependsOn"] = validate_deps("", body.get("dependsOn") or [], t["repo"], t["base"], t["parent"])
        t["merge"] = validate_merge(body["merge"]) if "merge" in body else default_merge(t)
        t["branch"] = store.suggest_branch(t)
        if plan:
            store.write_plan(t, plan)
        store.create(t)
        hub.changed()
        return store.view(t)


def validate_origin(value: Any) -> Dict[str, Any]:
    """The omp session a task was planned in, with that session's terminal context."""
    if not isinstance(value, dict) or not isinstance(value.get("session"), str) or not value["session"].strip():
        raise ApiError(400, "origin needs a session")
    try:
        terminal = terminals.normalize_context(value["terminal"]) if value.get("terminal") is not None else {"kind": "plain"}
    except ValueError as e:
        raise ApiError(400, f"origin.terminal: {e}")
    return {"session": value["session"], "terminal": terminal}


def validate_concurrency_limit(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ApiError(400, "Concurrent tasks must be a positive integer or null for unlimited")
    return value


def register_flow(body: Dict[str, Any]) -> Dict[str, Any]:
    """Registers the checkout containing `path` as a flow, so it shows up before it has tasks."""
    path = str(body.get("path") or "")
    info = checkout_info(str(Path(path).expanduser()))
    if not info:
        raise ApiError(400, f"{path} is not a git repository")
    with store.lock:
        refuse_task_worktree(info)
        previous = next((f for f in store.flows
                         if same_dir(f["repo"], info["repo"]) and f["base"] == info["base"]), None)
        registered = {**info, "concurrencyLimit": (previous or {}).get("concurrencyLimit")}
        store.flows = [f for f in store.flows if Path(f["checkout"]).is_dir()
                       and not (same_dir(f["repo"], info["repo"]) and f["base"] == info["base"])] + [registered]
        store.save_board()
        fid = flow_id(info["repo"], info["base"])
        flow = next(f for f in store.flow_list() if f["id"] == fid)
    hub.changed()
    return {"ok": True, "flow": flow}


def set_flow_concurrency(body: Dict[str, Any]) -> Dict[str, Any]:
    flow_id_value = str(body.get("id") or "")
    if "concurrencyLimit" not in body:
        raise ApiError(400, "concurrencyLimit is required")
    limit = validate_concurrency_limit(body["concurrencyLimit"])
    with store.lock:
        flow = next((f for f in store.flow_list() if f["id"] == flow_id_value), None)
        if not flow:
            raise ApiError(404, f"Unknown flow {flow_id_value}")
        if not flow.get("checkout") or not Path(flow["checkout"]).is_dir():
            raise ApiError(409, f"{flow_id_value} has no registered checkout")
        registered = {"repo": flow["repo"], "base": flow["base"], "checkout": flow["checkout"],
                      "concurrencyLimit": limit}
        store.flows = [f for f in store.flows
                       if not (same_dir(f["repo"], flow["repo"]) and f["base"] == flow["base"])] + [registered]
        store.save_board()
        updated = next(f for f in store.flow_list() if f["id"] == flow_id_value)
    hub.changed()
    poller.kick()
    return {"ok": True, "flow": updated}


def set_flow_scripts(body: Dict[str, Any]) -> Dict[str, Any]:
    """Saves a flow's project scripts in config.json, keeping every other key; a value equal to the default follows it."""
    flow_id_value = str(body.get("id") or "")
    values = {}
    for key in SCRIPT_KEYS:
        if not isinstance(body.get(key), str):
            raise ApiError(400, f"{key} must be a string; empty means none")
        values[key] = body[key].strip()
    with store.lock:
        flow = next((f for f in store.flow_list() if f["id"] == flow_id_value), None)
        if not flow:
            raise ApiError(404, f"Unknown flow {flow_id_value}")
        project = flow["name"]
        config = read_config()
        project_scripts(project, config)  # refuses malformed script settings before rewriting the file
        defaults = config_object(config, "defaults", "defaults")
        projects = dict(config_object(config, "projects", "projects"))
        own = dict(config_object(projects, project, f"projects.{project}"))
        for key, value in values.items():
            if value == (defaults.get(key) or "").strip():
                own.pop(key, None)
            else:
                own[key] = value
        if own:
            projects[project] = own
        else:
            projects.pop(project, None)
        if projects or "projects" in config:
            config["projects"] = projects
        write_atomic(CONFIG_FILE, json.dumps(config, indent=2, ensure_ascii=False) + "\n")
        updated = next(f for f in store.flow_list() if f["id"] == flow_id_value)
    hub.changed()
    return {"ok": True, "flow": updated}


def set_theme(body: Dict[str, Any]) -> Dict[str, Any]:
    """Records the omp theme of a session in `flow` (in memory); the board shows that flow in its colors."""
    flow, scheme, colors = body.get("flow"), body.get("scheme"), body.get("vars")
    if scheme not in ("dark", "light"):
        raise ApiError(400, "scheme must be dark or light")
    if not isinstance(colors, dict) or not all(k in THEME_VARS and isinstance(v, str) and THEME_COLOR.fullmatch(v)
                                               for k, v in colors.items()):
        raise ApiError(400, f"vars must map {', '.join(sorted(THEME_VARS))} to hex colors")
    theme = {"scheme": scheme, "vars": colors}
    with store.lock:
        if not any(f["id"] == flow for f in store.flow_list()):
            raise ApiError(404, f"Unknown flow {flow}")
        if store.themes.get(flow) == theme:
            return {"ok": True}
        store.themes.pop(flow, None)
        store.themes[flow] = theme
        store.theme_version += 1
    hub.changed()
    return {"ok": True}


def set_context(body: Dict[str, Any]) -> Dict[str, Any]:
    """Makes the checkout containing `path` the board's context: new tasks branch from its branch and target it."""
    info = checkout_info(str(Path(str(body.get("path") or "")).expanduser()))
    if not info:
        raise ApiError(400, f"{body.get('path')} is not inside a git checkout")
    with store.lock:
        refuse_task_worktree(info)
        store.context = info
        store.save_board()
    hub.changed()
    return store.board()["repo"]


def update_task(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    with store.lock:
        t = store.get(task_id)
        if (t["column"] == "done" or t.get("merged")) and ("title" in body or "description" in body):
            raise ApiError(409, f"{task_id} is done; create a new card")
        note_briefing(t)
        renamed = False
        try:
            if "title" in body:
                title = str(body["title"] or "").strip()
                if not title:
                    raise ApiError(400, "A task needs a title")
                renamed = title != t["title"]
                t["title"] = title
            if "description" in body:
                t["description"] = str(body["description"] or "")
            if "ticket" in body:
                ticket = normalize_ticket(body["ticket"])
                renamed = renamed or ticket != t.get("ticket")
                t["ticket"] = ticket
            if "branch" in body:
                if has_started(t):
                    raise ApiError(409, "The branch is fixed once the task starts")
                t["branch"] = validate_branch(str(body["branch"] or ""))
                t["branchEdited"] = t["branch"] != store.suggest_branch(t)
            if "repo" in body:
                if has_started(t):
                    raise ApiError(409, "The repository is fixed once the task starts")
                info = checkout_info(str(Path(str(body["repo"] or "")).expanduser()))
                if not info:
                    raise ApiError(400, f"{body['repo']} is not a git repository")
                refuse_task_worktree(info)
                t.update(info)
                if "merge" not in body:
                    t["merge"] = default_merge(t)
            if "base" in body:
                if has_started(t):
                    raise ApiError(409, "The base branch is fixed once the task starts")
                base = validate_branch(str(body["base"] or ""))
                if not (has_ref(t["repo"], f"refs/heads/{base}") or has_ref(t["repo"], f"refs/remotes/origin/{base}")):
                    raise ApiError(400, f"No branch {base} in {t['repo']}")
                t["base"] = base
            if "merge" in body:
                if has_started(t):
                    raise ApiError(409, "The merge mode is fixed once the task starts")
                t["merge"] = validate_merge(body["merge"])
            if "planningMode" in body:
                if has_started(t):
                    raise ApiError(409, "Planning mode is fixed once the task starts")
                t["planningMode"] = validate_planning_mode(body["planningMode"])
                t["planningOutcome"] = None
            wanted = body["dependsOn"] if "dependsOn" in body else t["dependsOn"]
            parent = validate_parent(task_id, body["parent"], t["repo"], t["base"],
                                     wanted if isinstance(wanted, list) else []) if "parent" in body else t.get("parent")
            deps = validate_deps(task_id, wanted, t["repo"], t["base"], parent) if "dependsOn" in body else t["dependsOn"]
            t["parent"], t["dependsOn"] = parent, deps
            if "repo" in body or "base" in body:
                refuse_split_family(t)
        except ApiError:
            store.revert(t)
            raise
        if renamed and not t.get("branchEdited") and not has_started(t):
            t["branch"] = store.suggest_branch(t)
        if "plan" in body:
            text = str(body["plan"] or "")
            store.write_plan(t, text)
            if spawned(t) and text.strip() and t["planningMode"] == "auto" and t.get("planningOutcome") is None:
                t["planningOutcome"] = "plan"
        store.save(t)
        if "parent" in body or "dependsOn" in body:
            store.blockers_after_write()
        hub.changed()
        return store.view(t)


def delete_task(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    with store.lock:
        t = store.get(task_id)
        if move_requires_confirmation(t) and body.get("confirmWorking") is not True:
            raise ApiError(409, f"{task_id} may still be working; confirm before deleting it",
                           {"requiresConfirmation": "workingTask"})
        remove_worktree = body.get("cleanup") is True and spawned(t)
        directory = host_dir(t)
    # With cleanup, the agent stops and the worktree goes first through the removeWorktree command or teardown script; a failure keeps the card.
    output = cleanup_task(task_id, body)["output"] if remove_worktree else ""
    note = None
    if not remove_worktree and directory and agent_host.status(directory)["alive"]:
        note = f"Its agent keeps running; attach with {agent_host.command('attach', directory)}"
    with store.lock:
        store.get(task_id)
        store.delete(task_id)
    hub.changed()
    return {"ok": True, "output": output, **({"note": note} if note else {})}


def start_task(t: Dict[str, Any]) -> None:
    """Marks a task as starting in Todo (call under store.lock, then run spawn_worker on a thread)."""
    t["column"] = "todo"
    t["spawn"] = {"state": "running", "error": None, "log": ""}
    t["planningOutcome"] = t["planningMode"] if t["planningMode"] in ("plan", "fast") else None
    store.save(t)


def move_task(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Moves a card. Starting it, or bringing a started card In Progress, needs a free task slot. A started card moved to
    Todo or Backlog pauses: its agent is interrupted and frees its slot; Todo resumes it on its turn, Backlog parks it.
    In Progress resumes a paused or stopped agent; one that may still run in a terminal the board doesn't own resumes
    only with confirmLegacy."""
    column = body.get("column")
    if column not in COLUMN_IDS:
        raise ApiError(400, f"Unknown column {column!r}")
    with store.lock:
        t = store.get(task_id)
        if column in ("todo", "doing") and not body.get("force"):
            store.fresh_blocked()
        previous_column = t["column"]
        if column != previous_column and move_requires_confirmation(t) and body.get("confirmWorking") is not True:
            raise ApiError(409, f"{task_id} may still be working; confirm before moving it to {dict(COLUMNS)[column]}",
                           {"requiresConfirmation": "workingTask"})
        was_paused = paused(t)
        if column == "doing" and was_paused and blocked_by(t) and not body.get("force"):
            column = "todo"
        entering = column == "doing" and previous_column != "doing" and spawned(t)
        if entering and not has_task_slot(t):
            raise ApiError(409, f"{flow_id(t['repo'], t['base'])} is at its concurrent-task limit")
        resume = column == "doing" and spawned(t) and not t.get("merged") and (was_paused or not agent_live(t))
        if resume and legacy_unknown(t):
            if body.get("confirmLegacy") is not True:
                raise ApiError(409, f"{task_id}'s agent ran in a terminal the board doesn't manage and may still run "
                                    "there; close that terminal, then confirm to resume it in a managed terminal",
                               {"requiresConfirmation": "legacySession"})
            t["execution"] = {**t["execution"], "stopped": True}
        pause = column in PAUSED_COLUMNS and not was_paused and spawned(t) and not t.get("merged")
        start = column in ("todo", "doing") and not spawned(t) and t["spawn"]["state"] in ("none", "failed")
        if start and not Path(t["repo"]).is_dir():
            raise ApiError(400, f"Repository {t['repo']} not found")
        order = body.get("order")
        t["column"] = column
        t["order"] = float(order) if isinstance(order, (int, float)) else store.next_order(column)
        if start and ((blocked_by(t) and not body.get("force")) or not has_task_slot(t)):
            t["column"] = "todo"
            t["spawn"] = {"state": "none", "error": None, "log": ""}
            start = False
        if resume:
            store.resuming[task_id] = time.time()
        if pause:
            store.resuming.pop(task_id, None)
        if start:
            start_task(t)
        else:
            store.save(t)
        hub.changed()
        snapshot, view = dict(t), store.view(t)
    if start:
        threading.Thread(target=spawn_worker, args=(task_id,), daemon=True).start()
    if resume:
        threading.Thread(target=resume_task, args=(task_id,), daemon=True).start()
    if pause:
        view["note"] = pause_agent(snapshot)
    poller.kick()
    return view


def reorder_task(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Places a task just before or after another card of its column; it never changes column or starts the task."""
    sides = [s for s in ("before", "after") if body.get(s)]
    if len(sides) != 1:
        raise ApiError(400, "Pass either before or after: the id of a card in the same column")
    side = sides[0]
    with store.lock:
        t = store.get(task_id)
        anchor = store.get(str(body[side]))
        if anchor is t:
            raise ApiError(400, f"{task_id} can't be placed {side} itself")
        if anchor["column"] != t["column"]:
            titles = dict(COLUMNS)
            raise ApiError(409, f"{anchor['id']} is in {titles[anchor['column']]}, not {titles[t['column']]}")
        column = sorted((o for o in store.tasks.values() if o["column"] == t["column"] and o is not t),
                        key=lambda o: (o["order"], o["createdAt"]))
        i = column.index(anchor)
        j = i - 1 if side == "before" else i + 1
        if 0 <= j < len(column):
            t["order"] = (anchor["order"] + column[j]["order"]) / 2
        else:
            t["order"] = anchor["order"] + (-1000.0 if side == "before" else 1000.0)
        store.save(t)
        hub.changed()
        return store.view(t)


# --- worktree + agent ---------------------------------------------------------------

def write_brief(t: Dict[str, Any], name: str, handoffs: List[Dict[str, Any]]) -> Path:
    lines = [f"# {t['id']}: {t['title']}", ""]
    if t.get("ticket"):
        lines.append(f"Ticket: {t['ticket']}")
    lands = "locally" if t["merge"] == "local" else "via pull request"
    lines.append(f"Branch: {t['branch']} (from {t['base']}; merges back {lands})")
    if t["dependsOn"]:
        names = [f"{d} ({store.tasks[d]['title']})" if d in store.tasks else d for d in t["dependsOn"]]
        lines.append("Depends on: " + ", ".join(names))
    if t.get("parent"):
        p = store.tasks.get(t["parent"])
        lines.append(f"Parent: {t['parent']}" + (f" ({p['title']})" if p else ""))
    kids = children(t["id"])
    if kids:
        lines.append("Children: " + ", ".join(f"{c} ({store.tasks[c]['title']})" for c in kids))
    siblings = [o for o in store.tasks.values()
                if o["id"] != t["id"] and same_dir(o["repo"], t["repo"]) and o["base"] == t["base"]]
    if siblings:
        titles = dict(COLUMNS)
        lines += ["", "## Sibling tasks", ""]
        for o in sorted(siblings, key=lambda o: (COLUMN_IDS.index(o["column"]), o["order"])):
            relation = " · this task depends on it" if o["id"] in t["dependsOn"] else \
                " · depends on this task" if t["id"] in o["dependsOn"] else \
                " · parent of this task" if o["id"] == t.get("parent") else \
                " · child of this task" if o.get("parent") == t["id"] else ""
            lines.append(f"- {o['id']} ({titles[o['column']]}): {o['title']}{relation}")
        lines += ["", "Read a sibling's description and plan with orchestrator_plan when your work touches it; don't do its part."]
    if handoffs:
        lines += ["", "## Dependency handoffs", "",
                  "What the tasks this one depends on recorded, at the revision shown. Read the latest with orchestrator_context."]
        for h in handoffs:
            lines += ["", handoff_text(h)]
    lines += ["", "## Description", "", t.get("description") or "(none)", ""]
    if t.get("plan"):
        lines += ["## Draft plan", "", t["plan"], ""]
    path = store.task_dir(t["id"]) / name
    write_atomic(path, "\n".join(lines))
    return path


def context_revision(notes: str) -> str:
    return hashlib.sha1(notes.encode("utf-8")).hexdigest()[:12]


def context_entries(notes: str) -> List[Dict[str, Any]]:
    """The entries in a bead's notes, oldest first; text before the first entry (written outside the board) is a note."""
    matches = list(CONTEXT_HEADER.finditer(notes))
    entries = []
    lead = notes[:matches[0].start()].strip() if matches else notes.strip()
    if lead:
        entries.append({"kind": "note", "at": None, "source": None, "ref": None, "text": lead})
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(notes)
        entries.append({"kind": m[1], "at": m[2], "source": m[3], "ref": m[4], "text": notes[m.end():end].strip()})
    return entries


def task_context(task_id: str) -> Dict[str, Any]:
    """A task's shared context, read from its bead's notes now."""
    ctx = store.read_context(task_id)
    notes = ctx["notes"] or ""
    return {"id": task_id, "beadId": ctx["beadId"], "revision": context_revision(notes), "updatedAt": ctx["updatedAt"],
            "entries": context_entries(notes)}


def commit_ref(t: Dict[str, Any]) -> str:
    """Where a task's work stands: its merge commit, else its branch at HEAD (+dirty with uncommitted changes)."""
    merged = t.get("merged")
    if merged:
        sha = str(merged.get("sha") or "")[:12]
        return f"{merged['into']}@{sha}" if sha else merged["into"]
    path = t.get("worktree")
    if path and Path(path).is_dir():
        code, out, _ = run(["git", "-C", path, "rev-parse", "--short=12", "HEAD"], timeout=10)
        if code == 0 and out.strip():
            dirty = run(["git", "-C", path, "status", "--porcelain"], timeout=15)[1].strip()
            return f"{t['branch']}@{out.strip()}{'+dirty' if dirty else ''}"
    return t["branch"]


def publish_context(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Appends a finding or outcome to a task's bead notes, stamped with its time, source task and branch@commit."""
    kind = body.get("kind")
    if kind not in CONTEXT_KINDS:
        raise ApiError(400, "kind must be finding or outcome")
    text = str(body.get("text") or "").strip()
    if not text:
        raise ApiError(400, "Nothing to publish")
    if len(text) > CONTEXT_ENTRY_LIMIT:
        raise ApiError(400, f"Keep it under {CONTEXT_ENTRY_LIMIT} characters: reusable findings and outcomes, not logs or transcripts")
    if CONTEXT_HEADER.search(text):
        raise ApiError(400, "The text can't contain a context entry header line")
    source = str(body.get("source") or task_id)
    if not re.fullmatch(r"[\w.-]+", source):
        raise ApiError(400, "source must be a task id or a single word")
    with store.lock:
        t = dict(store.get(task_id))
    store.append_context(task_id, f"### {kind} · {now_iso()} · {source} · {commit_ref(t)}\n{text}\n")
    return task_context(task_id)


def dependency_handoffs(deps: List[str]) -> List[Dict[str, Any]]:
    """The shared context of a task's dependencies, for its brief; a dependency Beads can't read now says so."""
    handoffs = []
    for d in deps:
        try:
            handoffs.append(task_context(d))
        except ApiError as e:
            if e.status != 404:
                handoffs.append({"id": d, "error": e.message})
    return handoffs


def handoff_text(h: Dict[str, Any]) -> str:
    """A dependency's handoff: its latest outcome and latest findings, cut to HANDOFF_LIMIT characters."""
    title = store.tasks[h["id"]]["title"] if h["id"] in store.tasks else ""
    head = f"### {h['id']}: {title}" if title else f"### {h['id']}"
    if "error" in h:
        return f"{head}\nNot readable when this brief was written ({h['error']}); try orchestrator_context {h['id']}."
    entries = h["entries"]
    if not entries:
        return f"{head} (revision {h['revision']})\nNothing recorded."
    outcomes = [i for i, e in enumerate(entries) if e["kind"] == "outcome"]
    others = [i for i, e in enumerate(entries) if e["kind"] != "outcome"][-HANDOFF_FINDINGS:]
    shown = sorted(set(outcomes[-1:] + others))
    blocks = []
    for i in shown:
        e = entries[i]
        stamp = " · ".join(x for x in (e["source"], e["ref"], e["at"]) if x)
        blocks.append(f"**{e['kind'].capitalize()}**{f' ({stamp})' if stamp else ''}\n{e['text']}")
    omitted = len(entries) - len(shown)
    more = f", {omitted} older not shown" if omitted else ""
    text = f"{head} (bead {h['beadId']}, revision {h['revision']}{more})\n\n" + "\n\n".join(blocks)
    if len(text) > HANDOFF_LIMIT:
        text = text[:HANDOFF_LIMIT].rstrip() + f"\n\n[cut; orchestrator_context {h['id']} has all of it]"
    return text


def start_args(t: Dict[str, Any], brief: Path, config: Path) -> List[str]:
    """omp's arguments for a task's first start: its config, its brief and the prompt for its planning mode."""
    if t["merge"] == "local":
        finish = ("When the work is complete and verified, tell me; do not push or open a pull request: "
                  f"/orchestrator done stages and commits pending changes, then the board merges this branch into {t['base']}. ")
    else:
        pr = f" for ticket {t['ticket']}" if t.get("ticket") else ""
        finish = ("When the work is complete and verified, "
                  f"commit it, push the branch and open a pull request into {t['base']}{pr}. ")
    if t["planningMode"] == "plan":
        approach = (f"Plan the task in the attached brief ({t['id']}) before changing any file: explore the code, then "
                    "propose the plan with xd://propose for my review; once I approve it, implement it.")
    elif t["planningMode"] == "fast":
        approach = (f"Implement the straightforward task in the attached brief ({t['id']}) directly. Read enough to make "
                    "the change safely, but do not request plan review unless I explicitly ask for one.")
    else:
        approach = (f"Briefly triage the task in the attached brief ({t['id']}) before changing any file. Inspect only "
                    "enough to decide the route: if the implementation and acceptance are clear, implement immediately "
                    "without plan review; if you find a product decision, unclear acceptance, architectural or migration "
                    "impact, or meaningful cross-cutting risk, propose a plan with xd://propose and wait for my review. "
                    "Keep this triage brief; it is not a planning phase.")
    draft = " The brief has a draft plan: use it as context and update it to the code as it is now." if t.get("plan") else ""
    prompt = (f"{approach}{draft} You are in a dedicated git worktree on branch {t['branch']}; follow the repository's "
              f"conventions. {finish}Ask me if anything in the brief is unclear.")
    return ["--config", str(config), "@" + str(brief), prompt]


def resume_args(t: Dict[str, Any]) -> List[str]:
    """omp's arguments to bring a task's agent back: its recorded session, else the worktree's latest one."""
    session = (t.get("execution") or {}).get("session") or {}
    if session.get("file") and Path(session["file"]).is_file():
        return ["--resume", session["file"]]
    if session.get("id"):
        return ["--resume", session["id"]]
    return ["--continue"]


def agent_script(t: Dict[str, Any], name: str, args: List[str]) -> Path:
    """Writes the script a task's host runs: the task's environment, then omp with `args`."""
    omp = which("omp")
    if not omp:
        raise RuntimeError("omp isn't on the board's PATH")
    exports = " ".join(f"{k}={shlex.quote(v)}" for k, v in
                       (("KANBOARD_TASK", t["id"]), ("KANBOARD_PORT", str(PORT)), ("KANBOARD_HOME", str(HOME)),
                        ("KANBOARD_PLANNING_MODE", t["planningMode"])))
    path = store.task_dir(t["id"]) / name
    write_atomic(path, f"#!/bin/sh\nexport {exports}\nexec {shlex.join([omp, *args])}\n")
    return path


def builtin_worktree(repo: str, branch: str) -> Tuple[str, str, bool]:
    """Checks the (prepared) branch out under <home>/worktrees/<repo>/<branch>, or reuses its worktree; returns (path, log, created)."""
    existing = find_worktree(repo, branch)
    if existing:
        return existing, f"Reusing {existing}\n", False
    path = str(HOME / "worktrees" / os.path.basename(repo) / branch)
    log = drop_missing_worktrees(repo, branch, path)
    if has_ref(repo, f"refs/heads/{branch}"):
        cmd = ["git", "-C", repo, "worktree", "add", "-q", path, branch]
    else:
        cmd = ["git", "-C", repo, "worktree", "add", "-q", "--track", "-b", branch, path, f"origin/{branch}"]
    code, out, err = run(cmd, timeout=300)
    if code != 0:
        raise RuntimeError(f"git worktree add failed: {(err or out).strip()}")
    return path, log + out + err + f"Created {path}\n", True


def checkout(t: Dict[str, Any], directory: Path) -> Tuple[str, str, bool]:
    """Checks the task branch out in a worktree: the createWorktree hook when configured (its terminal runs a launcher
    that starts the agent's host unless it runs, then attaches), else a built-in worktree and the setup script.
    Returns (path, log, whether the hook ran)."""
    repo, branch = t["repo"], t["branch"]
    hook_command = hook("createWorktree")
    setup = project_scripts(os.path.basename(repo))["setupScript"]
    if hook_command:
        env = {"KANBOARD_TASK": t["id"], "KANBOARD_TITLE": t["title"], "KANBOARD_REPO": repo,
               "KANBOARD_BRANCH": branch, "KANBOARD_BASE": t["base"],
               "KANBOARD_AGENT_COMMAND": agent_host.command("launch", directory),
               "KANBOARD_SETUP_SCRIPT": os.path.expanduser(setup)}
        dropped = drop_missing_worktrees(repo, branch)
        code, log, error = run_hook("createWorktree", hook_command, repo, 900, env)
        log = dropped + log
        path = find_worktree(repo, branch)
        if code != 0:
            # A hook failing after its terminal started the agent (e.g. in a later sidebar step) leaves a real host: adopt
            # it rather than report a failure whose retry would start a second agent; else no late launcher may start one.
            if not agent_host.status(directory)["alive"] and agent_host.abandon(directory):
                raise RuntimeError(error)
            path = path or agent_host.status(directory).get("cwd")
            log += f"createWorktree failed after its terminal started the agent; adopted it: {error}\n"
        if not path:
            raise RuntimeError("createWorktree finished but the branch has no worktree")
        return path, log, True
    path, log, created = builtin_worktree(repo, branch)
    if created and setup:
        log += run_script("Setup script", setup, path, 900, script_env(t, path))
    return path, log, False


def spawn_worker(task_id: str) -> None:
    with store.lock:
        deps = list(store.get(task_id)["dependsOn"])
    handoffs = dependency_handoffs(deps)
    with store.lock:
        t = store.get(task_id)
        snapshot = dict(t)
        repo, branch, base = t["repo"], t["branch"], t["base"]
        brief = write_brief(t, "brief.md", handoffs)
        t["briefed"] = briefing(t)
        config = store.task_dir(t["id"]) / "omp.yml"
        write_atomic(config, f"plan:\n  defaultOnStartup: {'true' if t['planningMode'] == 'plan' else 'false'}\n")
        directory = host_dir(t) or new_host_dir(task_id)
        context = presentation_context(t)
    try:
        validate_branch(branch)
        script = agent_script(snapshot, "launch.sh", start_args(snapshot, brief, config))
        agent_host.prepare(directory, {"task": task_id, "repo": repo, "branch": branch, "argv": ["/bin/sh", str(script)]})
        execution: Dict[str, Any] = {"kind": "managed", "dir": str(directory), "instance": None, "session": None}
        # Recorded before anything can start the agent, so its first stream and reports find their task.
        record_execution(task_id, execution)
        presentation, hooked = None, False
        status = agent_host.status(directory)
        if status["alive"]:
            path, log = status["cwd"], f"Adopted the agent already running in {status['cwd']}\n"
        elif hub.task_live(task_id):
            # An omp the board didn't start is connected for this task: adopt its session, never start a second agent.
            path, log = find_worktree(repo, branch), "Adopted the omp session already connected for this task\n"
            if not path:
                raise RuntimeError(f"An omp session is connected for {task_id}, but {branch} has no worktree")
            agent_host.abandon(directory)
            execution = {"kind": "legacy", "session": None, "stopped": False}
        else:
            log = prepare_branch(repo, branch, base)
            path, more, hooked = checkout(snapshot, directory)
            log += more
            status = agent_host.status(directory)
            if hooked and not status["alive"] and hub.task_live(task_id):
                log += "createWorktree started an omp the board doesn't run; adopted its session\n"
                agent_host.abandon(directory)
                execution = {"kind": "legacy", "session": None, "stopped": False}
            elif not status["alive"]:
                status = agent_host.ensure(directory, cwd=path)
        if execution["kind"] == "managed":
            execution["instance"] = status.get("instance")
            if not hooked:
                presentation, note = open_presentation(context, branch, path, directory)
                log += note
        with store.lock:
            t = store.tasks.get(task_id)
            if not t:
                return
            t["worktree"] = path
            t["presentation"] = presentation
            t["execution"] = {**execution, "session": (t.get("execution") or {}).get("session")}
            if execution["kind"] == "managed":
                store.hosts[task_id] = status
            t["spawn"] = {"state": "done", "error": None, "log": tail(log, SPAWN_LOG_LIMIT)}
            if t["column"] == "todo":
                t["column"] = "doing"
                t["order"] = store.next_order("doing")
            store.save(t)
    except (RuntimeError, ApiError, agent_host.HostError) as e:
        message = e.message if isinstance(e, ApiError) else str(e)
        with store.lock:
            t = store.tasks.get(task_id)
            if not t:
                return
            t["spawn"] = {"state": "failed", "error": message, "log": tail(message, SPAWN_LOG_LIMIT)}
            store.save(t)
    hub.changed()
    poller.kick()


AGENT_STATES = ("planning", "thinking", "working", "plan_ready", "needs_input", "idle")
ACTIVE_STATES = ("planning", "thinking", "working")
HELD_STATES = ("plan_ready", "needs_input")
STEP_STATES = ACTIVE_STATES + ("needs_input",)
FILE_ATTACHMENT = re.compile(r'^\s*<file name="[^"]*">.*?</file>\s*', re.S)


def submitted_text(message: Optional[str]) -> Optional[str]:
    """The typed part of a submitted message, without the files omp inlines for @-mentions."""
    text = message or ""
    while text.lstrip().startswith("<file name="):
        stripped = FILE_ATTACHMENT.sub("", text, count=1)
        if stripped == text:
            return None
        text = stripped
    return text.strip() or None


def agent_state(t: Dict[str, Any], connected: bool, host: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """What a started task's agent does: its omp's own report while its session is connected; disconnected while it may
    run unconnected (a running managed host, or a legacy terminal's agent not seen to exit); else stopped."""
    activity = store.activity.get(t["id"]) or {}
    message = activity.get("message")
    if connected:
        state = activity.get("state") or "idle"
        return {"state": state, "message": message, "step": activity.get("step") if state in STEP_STATES else None,
                "since": activity.get("since")}
    ex = t.get("execution") or {}
    running = (ex.get("kind") == "managed" and bool((host or {}).get("alive"))) or \
        (ex.get("kind") == "legacy" and not ex.get("stopped"))
    return {"state": "disconnected" if running else "stopped", "message": message, "step": None, "since": None}


def report_agent(body: Dict[str, Any]) -> Dict[str, Any]:
    """Records the state, step and latest prompt an omp reports for its task (in memory) and its session (in the task's
    execution record). A named task still starting is accepted before its worktree is recorded."""
    state = body.get("state")
    if state not in AGENT_STATES:
        raise ApiError(400, "State must be planning, thinking, working, plan_ready, needs_input or idle")
    step = (plain(str(body.get("step") or "").strip())[:200] or None) if state in STEP_STATES else None
    message = submitted_text(body["message"][:MESSAGE_LIMIT]) if isinstance(body.get("message"), str) else None
    session_id = text_field(body.get("sessionId"), 200)
    session_file = text_field(body.get("sessionFile"), 4096)
    session_file = session_file if session_file and os.path.isabs(session_file) else None
    path = str(body.get("path") or "")
    named = text_field(body.get("task"), 100)
    with store.lock:
        if named:
            t = store.tasks.get(named)
            if not t or not (within(path, t["worktree"]) if t.get("worktree") else t["spawn"]["state"] == "running"):
                raise ApiError(404, f"{named} has no agent at {path}")
        else:
            matches = [t for t in store.tasks.values() if t.get("worktree") and within(path, t["worktree"])]
            if not matches:
                raise ApiError(404, f"No task has a worktree at {path}")
            t = max(matches, key=lambda t: len(os.path.realpath(t["worktree"])))
        task_id = t["id"]
        previous = store.activity.get(task_id) or {}
        changed = previous.get("state") != state
        prompted = message is not None and message != previous.get("message")
        store.activity[task_id] = {"state": state, "step": step, "since": now_iso() if changed else previous.get("since"),
                                   "message": message if message is not None else previous.get("message")}
        agent = t.get("agent")
        stepped = not changed and previous.get("step") != step and bool(agent) and agent.get("state") == state
        if stepped:
            agent["step"] = step
    note_session(task_id, session_id, session_file)
    if changed or prompted:
        poller.kick()
    elif stepped:
        hub.publish("step", {"taskId": task_id, "step": step})
    return {"ok": True, "id": task_id}


def text_field(value: Any, limit: int) -> Optional[str]:
    return value if isinstance(value, str) and value.strip() and len(value) <= limit and "\n" not in value else None


def terminal_context(raw: Optional[str]) -> Optional[Dict[str, Any]]:
    """A stream's terminal context, validated at the boundary; a malformed one is dropped and the stream still serves."""
    if not raw or len(raw) > TERMINAL_LIMIT:
        return None
    try:
        return terminals.normalize_context(json.loads(raw))
    except ValueError:
        return None


def new_host_dir(task_id: str) -> Path:
    """A fresh host directory for a task: unique, so a reused task id never meets an older agent."""
    agent_host.private_dir(HOSTS_DIR)
    return HOSTS_DIR / f"{task_id}-{uuid.uuid4().hex[:8]}"


def record_execution(task_id: str, execution: Optional[Dict[str, Any]]) -> None:
    with store.lock:
        t = store.get(task_id)
        t["execution"] = execution
        store.save(t)


def note_session(task_id: str, session_id: Optional[str], session_file: Optional[str]) -> None:
    """Records the omp session a task's agent runs (from its stream and reports), so a resume continues exactly it."""
    if not (session_id or session_file):
        return
    with store.lock:
        t = store.tasks.get(task_id)
        ex = (t or {}).get("execution")
        if not t or not ex:
            return
        session = dict(ex.get("session") or {})
        updated = {"id": session_id, "file": None} if session_id and session_id != session.get("id") else dict(session)
        if session_file:
            updated["file"] = session_file
        if updated != session:
            ex["session"] = updated
            store.save(t)


def presentation_context(t: Dict[str, Any]) -> Dict[str, Any]:
    """Where a task's agent terminal opens: its origin session's terminal (live, else as recorded), else the terminal of
    its flow's latest session; plain without one (call under store.lock)."""
    origin = t.get("origin") or {}
    live = hub.session_terminal(origin["session"]) if origin.get("session") else None
    if live:
        return live
    if origin.get("terminal"):
        return origin["terminal"]
    flow = hub.flow_session(flow_id(t["repo"], t["base"]), None)
    return (flow or {}).get("terminal") or {"kind": "plain"}


def open_presentation(context: Dict[str, Any], name: str, cwd: str,
                      directory: Path) -> Tuple[Optional[Dict[str, Any]], str]:
    """Opens a terminal attached to a task's host in `context` (plain opens none); returns it and a log note. A failure
    leaves the agent running and attachable."""
    attach = agent_host.command("attach", directory)
    try:
        return terminals.open_terminal(context, name, cwd, attach), ""
    except (RuntimeError, OSError) as e:
        return None, f"Couldn't open the agent's terminal ({e}); attach with {attach}\n"


def present(task_id: str, focus: bool) -> Dict[str, Any]:
    """Shows a task's running managed agent: its presentation while a terminal is attached (focused on request), else a
    new terminal attached to its host in the task's terminal context; plain opens none. Never starts an agent."""
    with store.lock:
        t = store.get(task_id)
        directory = host_dir(t)
        current, context, name, cwd = t.get("presentation"), presentation_context(t), t["branch"], t["worktree"]
    if not directory:
        raise ApiError(409, f"The board doesn't manage {task_id}'s agent")
    status = agent_host.status(directory)
    if not status["alive"]:
        raise ApiError(409, f"{task_id}'s agent is stopped: move it to In Progress to resume it")
    note = None
    if current and status.get("clients") and terminals.alive(current):
        presentation = {**current, "alive": True}
        if focus and presentation.get("capabilities", {}).get("focus") and not terminals.focus(presentation):
            note = "Its terminal didn't come forward"
    else:
        # Nothing shows the agent now: a terminal left from an earlier host or a detach is replaced.
        if current and current.get("capabilities", {}).get("close") and terminals.alive(current):
            terminals.close(current)
        presentation, failed = open_presentation(context, name, cwd, directory)
        note = failed.strip() or None
        if presentation and focus and presentation.get("capabilities", {}).get("focus"):
            terminals.focus(presentation)
    with store.lock:
        t = store.tasks.get(task_id)
        if t:
            t["presentation"] = presentation
            store.save(t)
    hub.changed()
    return {"presentation": presentation, "attachCommand": agent_host.command("attach", directory),
            **({"note": note} if note else {})}


def ensure_agent(t: Dict[str, Any]) -> bool:
    """Brings back a started task's agent unless it runs: a managed host restarts omp in the worktree, continuing its
    recorded session. True when it restarted. A legacy agent that may still run in its own terminal never restarts."""
    task_id = t["id"]
    directory = host_dir(t)
    if hub.task_live(task_id) or (directory and agent_host.status(directory)["alive"]):
        return False
    if legacy_unknown(t):
        raise ApiError(409, f"{task_id}'s agent ran in a terminal the board doesn't manage and may still run there",
                       {"requiresConfirmation": "legacySession"})
    path = t["worktree"]
    if not Path(path).is_dir():
        raise ApiError(409, f"The worktree {path} no longer exists")
    directory = directory or new_host_dir(task_id)
    session = (t.get("execution") or {}).get("session")
    try:
        script = agent_script(t, "resume.sh", resume_args(t))
        agent_host.prepare(directory, {"task": task_id, "repo": t["repo"], "branch": t["branch"],
                                       "argv": ["/bin/sh", str(script)]})
        record_execution(task_id, {"kind": "managed", "dir": str(directory), "instance": None, "session": session})
        status = agent_host.ensure(directory, cwd=path)
    except (RuntimeError, agent_host.HostError) as e:
        raise ApiError(500, f"{task_id}'s agent didn't restart: {e}")
    with store.lock:
        current = store.tasks.get(task_id)
        if current and host_dir(current):
            current["execution"]["instance"] = status.get("instance")
            store.hosts[task_id] = status
            store.save(current)
    return True


def open_task(task_id: str) -> Dict[str, Any]:
    """Shows a started task's agent in a terminal; presentation only: a stopped agent resumes from In Progress."""
    with store.lock:
        t = store.get(task_id)
        require_spawned(t)
        ex, presentation = t.get("execution") or {}, t.get("presentation")
    if ex.get("kind") == "managed":
        result = present(task_id, focus=True)
        poller.kick()
        return {"ok": True, **result}
    if ex.get("kind") == "legacy" and presentation and terminals.alive(presentation):
        terminals.focus(presentation)
        return {"ok": True, "presentation": {**presentation, "alive": True}, "attachCommand": None}
    if ex.get("kind") == "legacy" and not ex.get("stopped"):
        raise ApiError(409, f"{task_id}'s agent runs in a terminal the board doesn't manage, and that terminal is closed")
    raise ApiError(409, f"{task_id}'s agent is stopped: move it to In Progress to resume it")


def open_worktree(task_id: str) -> Dict[str, Any]:
    """Shows a started task's worktree in a terminal: one already there (its agent's, or any surface in it), else a new
    shell; never starts, resumes or closes anything. Plain opens nothing and returns the path to cd to."""
    with store.lock:
        t = store.get(task_id)
        path = require_spawned(t)
        context, name, presentation = presentation_context(t), t["branch"], t.get("presentation")
    if not Path(path).is_dir():
        raise ApiError(409, f"The worktree {path} no longer exists")
    cd = f"cd {shlex.quote(path)}"
    try:
        found = presentation if presentation and terminals.alive(presentation) else terminals.find_terminal(context, path)
        terminal = found or terminals.open_terminal(context, name, path, 'exec "${SHELL:-/bin/sh}" -l')
        if terminal["kind"] != "plain":
            terminals.focus(terminal)
    except (RuntimeError, OSError, KeyError, ValueError) as e:
        raise ApiError(500, f"Couldn't open {path} in a terminal ({e}); run: {cd}")
    return {"ok": True, "worktree": path, "cd": cd, "kind": terminal["kind"], "reused": bool(found),
            "opened": terminal["kind"] != "plain"}


def prompt_task(body: Dict[str, Any]) -> Dict[str, Any]:
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ApiError(400, "Enter a task prompt")
    column = body.get("column", "backlog")
    if column not in COLUMN_IDS:
        raise ApiError(400, "Unknown column")
    relation = body.get("relation")
    if relation not in (None, "after", "before"):
        raise ApiError(400, "Unknown dependency direction")
    if relation and not isinstance(body.get("task"), str):
        raise ApiError(400, "Select a connected task")
    with store.lock:
        flow = next((f for f in store.flow_list() if f["id"] == body.get("flow")), None)
        if not flow:
            raise ApiError(400, "Select a flow")
        context = [f"Task request from Orchestrator for {flow['name']} ({flow['base']}).",
                   f"Requested column: {dict(COLUMNS)[column]}. This is placement intent, not evidence of completed work."]
        if relation:
            anchor = store.get(body.get("task"))
            if flow_id(anchor["repo"], anchor["base"]) != flow["id"]:
                raise ApiError(400, "The connected task belongs to another flow")
            context.append(f"The new task must depend on {anchor['id']}." if relation == "after" else
                           f"Create a prerequisite for {anchor['id']} and make {anchor['id']} depend on the new task.")
    target = hub.flow_session(flow["id"], None)
    if not target:
        raise ApiError(409, f"No main omp session is connected: run /orchestrator in {flow['checkout'] or flow['repo']}")
    cid = uuid.uuid4().hex
    answer: Dict[str, Any] = {"done": threading.Event()}
    with hub.lock:
        hub.answers[cid] = answer
    try:
        if not hub.publish("task_prompt", {"id": cid, "text": "\n".join(context) + "\n\n" + text.strip()},
                           session=target["session"]):
            raise ApiError(409, "The main omp session disconnected")
        if not answer["done"].wait(CONTROL_TIMEOUT):
            raise ApiError(504, "The main omp session did not acknowledge the prompt; reload its Orchestrator plugin")
        if not answer["ok"]:
            raise ApiError(409, answer["message"])
        return {"ok": True, "message": answer["message"]}
    finally:
        with hub.lock:
            hub.answers.pop(cid, None)


def discuss_task(task_id: str) -> Dict[str, Any]:
    """Brings the flow's orchestrator omp session to the front to discuss a not-started task."""
    with store.lock:
        t = store.get(task_id)
        if spawned(t):
            raise ApiError(409, f"{task_id} has started: talk to its omp in its terminal")
        flow = flow_id(t["repo"], t["base"])
        checkout_path = t.get("checkout") or t["repo"]
        origin = t.get("origin")
    target = hub.flow_session(flow, origin["session"] if origin else None)
    if not target:
        raise ApiError(409, f"No omp session has orchestrator mode on in {flow}: run /orchestrator in {checkout_path}")
    hub.publish("discuss", {"id": task_id}, session=target["session"])
    context = target.get("terminal")
    if context and terminals.capabilities(context)["focus"]:
        terminals.focus(context)
    return {"ok": True}


def require_agent(t: Dict[str, Any]) -> None:
    """Refuses a message for a started task's agent unless it can take one now (call under store.lock)."""
    task_id = t["id"]
    require_spawned(t)
    if paused(t):
        raise ApiError(409, f"{task_id} is paused: move it to In Progress to resume it")
    if not hub.task_live(task_id):
        raise ApiError(409, f"{task_id}'s omp session isn't connected to the board")
    state = (t.get("agent") or {}).get("state")
    if state in HELD_STATES:
        waits = "plan review" if state == "plan_ready" else "an answer"
        raise ApiError(409, f"{task_id}'s agent is waiting for {waits}")


def message_agent(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Has a started task's omp session take a message as if typed there: it starts a turn, or steers the running one."""
    text = str(body.get("text") or "").strip()
    if not text:
        raise ApiError(400, "The message is empty")
    with store.lock:
        require_agent(store.get(task_id))
    answer = hub.control(task_id, "message", {"text": text})
    poller.kick()
    return {"ok": True, "message": answer}


def review_plan(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Answers a started task's open plan review: approve runs the plan, refine sends feedback for another planning pass."""
    decision = body.get("decision")
    if decision not in ("approve", "refine"):
        raise ApiError(400, "Decision must be approve or refine")
    feedback = str(body.get("feedback") or "").strip()
    if decision == "refine" and not feedback:
        raise ApiError(400, "Refining needs feedback")
    with store.lock:
        t = store.get(task_id)
        require_spawned(t)
        if paused(t):
            raise ApiError(409, f"{task_id} is paused: move it to In Progress to resume it")
        if not hub.task_live(task_id):
            raise ApiError(409, f"{task_id}'s omp session isn't connected to the board")
    answer = hub.control(task_id, "review", {"decision": decision, "feedback": feedback})
    poller.kick()
    return {"ok": True, "message": answer}


def pause_agent(t: Dict[str, Any]) -> str:
    """Interrupts the agent of a task whose card just paused; returns what happened."""
    hub.cancel_queued(t["id"])
    if not hub.task_live(t["id"]):
        return "Its omp session isn't connected, so nothing was interrupted"
    try:
        return hub.control(t["id"], "pause")
    except ApiError as e:
        return f"Its agent wasn't interrupted: {e.message}"


def resume_task(task_id: str) -> None:
    """Puts a resumed task's agent back to work: restarts its stopped managed agent (continuing its omp session) and has
    it continue with the card's edits made while it was paused. An agent that can't restart parks the card in Backlog."""
    with store.lock:
        t = store.tasks.get(task_id)
        if not t or not spawned(t) or t["column"] != "doing":
            store.resuming.pop(task_id, None)
            return
        note_briefing(t)
        snapshot = dict(t)
        update = briefing(t) if pending_update(t) else None
        text = RESUME_TEXT.format(id=task_id)
        if update:
            text += "\n\n" + update_message(task_id, t["briefed"], update)
    try:
        restarted = ensure_agent(snapshot)
    except ApiError as e:
        print(f"orchestrator: {task_id} couldn't resume: {e.message}", file=sys.stderr)
        with store.lock:
            store.resuming.pop(task_id, None)
            t = store.tasks.get(task_id)
            if t and t["column"] == "doing":
                t["column"], t["order"] = "backlog", store.next_order("backlog")
                store.save(t)
        hub.changed()
        return
    if restarted:
        try:
            present(task_id, focus=False)
        except ApiError as e:
            print(f"orchestrator: {task_id}'s terminal didn't open: {e.message}", file=sys.stderr)
    hub.queue_control(task_id, "resume", {"text": text}, lambda ok, message: resumed(task_id, ok, message, update))


def resumed(task_id: str, ok: bool, message: str, update: Optional[Dict[str, str]]) -> None:
    """A resumed task's session answered; on success its agent knows the card as it is (check_ready forgets the resume once
    the agent works)."""
    with store.lock:
        t = store.tasks.get(task_id)
        if not ok:
            store.resuming.pop(task_id, None)
            print(f"orchestrator: {task_id} didn't resume: {message}", file=sys.stderr)
        elif t and update:
            t["briefed"] = update
            store.save(t)
    hub.changed()
    poller.kick()


def stop_agent(task_id: str) -> Optional[str]:
    """Ends a started task's agent: its omp session takes the board's stop command first, then a managed host still
    running is terminated and its terminal closed. A legacy agent counts as stopped only once its connected session
    acknowledged and left. Returns a note for the user, if any."""
    with store.lock:
        t = store.get(task_id)
        directory, presentation = host_dir(t), t.get("presentation")
        legacy = (t.get("execution") or {}).get("kind") == "legacy"
    notes: List[str] = []
    gone = False
    if hub.task_live(task_id):
        try:
            hub.control(task_id, "stop")
            hub.wait_gone(task_id, STOP_TIMEOUT)
            gone = not hub.task_live(task_id)
        except ApiError as e:
            notes.append(f"Its omp session didn't take the stop command ({e.message})")
    host = None
    if directory:
        try:
            # omp that acknowledged the stop finishes its own shutdown first; only a host still running then is signalled.
            deadline = time.time() + (STOP_TIMEOUT if gone else 0)
            while agent_host.status(directory)["alive"] and time.time() < deadline:
                time.sleep(0.2)
            if agent_host.status(directory)["alive"] and not agent_host.terminate(directory):
                notes.append("Its agent host didn't stop")
        except agent_host.HostError as e:
            notes.append(f"Its agent host didn't stop: {e}")
        host = agent_host.status(directory)
    elif legacy and not gone:
        notes.append("Its agent ran in a terminal the board doesn't manage and wasn't seen to exit; close that terminal "
                     "before resuming it")
    if presentation and presentation.get("capabilities", {}).get("close") and terminals.alive(presentation):
        terminals.close(presentation)
    with store.lock:
        t = store.tasks.get(task_id)
        if t:
            ex = t.get("execution")
            if ex and ex.get("kind") == "legacy" and gone:
                ex["stopped"] = True
            if t.get("presentation"):
                t["presentation"] = {**t["presentation"], "alive": False}
            if host is not None:
                store.hosts[task_id] = host
            t["agent"] = agent_state(t, hub.task_live(task_id), store.hosts.get(task_id))
            store.save(t)
    return "; ".join(notes) or None


def stop_task(task_id: str) -> Dict[str, Any]:
    """Ends a started task's agent and closes its terminal, keeping its worktree, branch and omp session; the card parks
    in Backlog (a Review card stays). Moving it back to Todo or In Progress resumes it."""
    with store.lock:
        t = store.get(task_id)
        require_spawned(t)
        if t["column"] == "done" or t.get("merged"):
            raise ApiError(409, f"{task_id} is done")
        if t["spawn"]["state"] == "running":
            raise ApiError(409, f"{task_id} is still starting; stop it once its agent runs")
        hub.cancel_queued(task_id)
        store.resuming.pop(task_id, None)
        # Parked first: while omp exits, an idle In Progress card would otherwise read as ready for Review.
        if t["column"] in ("todo", "doing"):
            t["column"], t["order"] = "backlog", store.next_order("backlog")
            store.save(t)
    hub.changed()
    note = stop_agent(task_id)
    with store.lock:
        view = store.view(store.get(task_id))
    hub.changed()
    poller.kick()
    if note:
        view["note"] = note
    return view


def answer_control(cid: str, body: Dict[str, Any]) -> Dict[str, Any]:
    if not hub.answer(cid, body.get("ok") is True, str(body.get("message") or "")):
        raise ApiError(404, "No command waits for this answer")
    return {"ok": True}


def amended_description(description: str, text: str) -> str:
    return f"{description.rstrip()}\n\nAdded: {text}" if description.strip() else text


def amend_task(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Adds same-subject work to a card; a started task's running agent also receives it as a message."""
    text = str(body.get("text") or "").strip()
    if not text:
        raise ApiError(400, "The addition is empty")
    with store.lock:
        t = store.get(task_id)
        if t["column"] == "done" or t.get("merged"):
            raise ApiError(409, f"{task_id} is done; create a new card")
        note_briefing(t)
        state = (t.get("agent") or {}).get("state")
        held = "paused" if paused(t) else state if has_started(t) and state in HELD_STATES else None
        if not has_started(t) or held:
            t["description"] = amended_description(t["description"], text)
            store.save(t)
            hub.changed()
            return {"id": task_id, "delivered": False, "held": held, "reopened": False}
        if t["spawn"]["state"] == "running":
            raise ApiError(409, f"{task_id} is still starting; add this once its agent is running")
    message_agent(task_id, {"text": f"Addition to {task_id} from the Orchestrator flow session: {text}"})
    with store.lock:
        t = store.get(task_id)
        t["description"] = amended_description(t["description"], text)
        t["briefed"]["description"] = amended_description(t["briefed"]["description"], text)
        reopened = resume_agent(t)
        store.save(t)
    hub.changed()
    return {"id": task_id, "delivered": True, "held": None, "reopened": reopened}


def resume_agent(t: Dict[str, Any]) -> bool:
    """A started task's agent was given more work: a Review card returns to In Progress and the agent shows thinking."""
    reopened = t["column"] == "review"
    if reopened:
        t["column"], t["order"] = "doing", store.next_order("doing")
    if (t.get("agent") or {}).get("state") not in ACTIVE_STATES:
        since = now_iso()
        store.activity[t["id"]] = {"state": "thinking", "step": None, "since": since}
        t["agent"] = {**(t.get("agent") or {}), "state": "thinking", "step": None, "since": since}
    return reopened


def update_message(task_id: str, briefed: Dict[str, str], current: Dict[str, str]) -> str:
    changed = [k for k in ("title", "description") if current[k] != briefed[k]]
    parts = [f"{task_id} was edited on the board; this replaces the {' and '.join(changed)} in your brief."]
    if "title" in changed:
        parts.append(f"Title: {current['title']}")
    if "description" in changed:
        parts.append("Description:\n" + (current["description"].strip() or "(none)"))
    parts.append("Adjust your work to the updated task, and ask me if anything is unclear.")
    return "\n\n".join(parts)


def send_update(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Sends a started task's agent the card's edited title and description; with dismiss, only marks them as known."""
    with store.lock:
        t = store.get(task_id)
        if not pending_update(t):
            raise ApiError(409, f"{task_id}'s agent already has its current title and description")
        current = briefing(t)
        if body.get("dismiss") is True:
            t["briefed"] = current
            store.save(t)
            hub.changed()
            return {"id": task_id, "delivered": False, "reopened": False}
        if t["spawn"]["state"] == "running":
            raise ApiError(409, f"{task_id} is still starting; send this once its agent is running")
        if paused(t):
            raise ApiError(409, f"{task_id} is paused; its agent gets the update when it resumes")
        state = (t.get("agent") or {}).get("state")
        if state in HELD_STATES:
            waits = "plan review" if state == "plan_ready" else "your answer"
            raise ApiError(409, f"{task_id}'s agent is waiting for {waits} in its workspace; send this once it resumes")
        text = update_message(task_id, t["briefed"], current)
    message_agent(task_id, {"text": text})
    with store.lock:
        t = store.get(task_id)
        t["briefed"] = current
        reopened = resume_agent(t)
        store.save(t)
    hub.changed()
    return {"id": task_id, "delivered": True, "reopened": reopened}


def read_screen(task_id: str) -> Dict[str, Any]:
    """The agent's terminal screen from its managed host, whether or not any terminal shows it."""
    with store.lock:
        t = store.get(task_id)
        require_spawned(t)
        directory = host_dir(t)
    if not directory:
        raise ApiError(409, f"{task_id}'s agent runs in a terminal the board doesn't manage; its screen shows only there")
    shown = agent_host.screen(directory, 120, styled=True)
    look = appearance()
    return agent_host.preview(shown["text"], shown.get("rows"), look["palette"], look["nerdFont"], 120)


def task_diff(task_id: str) -> Dict[str, Any]:
    with store.lock:
        t = store.get(task_id)
        path, base = require_spawned(t), t["base"]
    if not Path(path).is_dir():
        raise ApiError(409, f"The worktree {path} no longer exists")
    base, mb = merge_base(path, base)
    _, stat, _ = run(["git", "-C", path, "diff", "--stat", mb], timeout=30)
    code, diff, err = run(["git", "-C", path, "diff", mb], timeout=60)
    if code != 0:
        raise ApiError(500, err.strip() or "git diff failed")
    _, untracked, _ = run(["git", "-C", path, "ls-files", "--others", "--exclude-standard"], timeout=30)
    if untracked.strip():
        stat += "\nUntracked:\n" + "\n".join("  " + f for f in untracked.splitlines())
    return {"base": base, "stat": stat.rstrip(), "diff": diff[:DIFF_LIMIT], "truncated": len(diff) > DIFF_LIMIT}


def present_diff(task_id: str) -> Dict[str, Any]:
    """Opens the task's diff in its terminal's diff panel: its presentation's, else its terminal context's."""
    with store.lock:
        t = store.get(task_id)
        path, base = require_spawned(t), t["base"]
        presentation = t.get("presentation") or {}
        target = presentation if presentation.get("capabilities", {}).get("diff") else presentation_context(t)
    try:
        opened = terminals.open_diff(target, path, base_ref(path, base), f"{task_id} diff")
    except RuntimeError as e:
        raise ApiError(500, str(e))
    if not opened:
        raise ApiError(409, f"{task_id}'s terminal can't show a diff panel (it needs cmux)")
    return {"ok": True}


def cleanup_task(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Removes a started task's worktree and branch, stopping its agent first so nothing works in a deleted tree; an
    unfinished task can then start again."""
    with store.lock:
        t = store.get(task_id)
        path = require_spawned(t)
        repo, branch = t["repo"], t["branch"]
        task_env = script_env(t, path)
        directory = host_dir(t)
        if legacy_unknown(t) and body.get("confirmLegacy") is not True:
            raise ApiError(409, f"{task_id}'s agent may still run in a terminal the board doesn't manage; close that "
                                "terminal, then confirm removing the worktree", {"requiresConfirmation": "legacySession"})
    exists = Path(path).is_dir()
    command = hook("removeWorktree") if exists else None
    teardown = project_scripts(os.path.basename(repo))["teardownScript"] if exists else ""

    def refuse_dirty() -> None:
        _, status, _ = run(["git", "-C", path, "status", "--porcelain"], timeout=30)
        if status.strip():
            raise ApiError(409, "The worktree has uncommitted changes", {"output": status})

    if exists and not command:
        refuse_dirty()
    note = stop_agent(task_id)
    if hub.task_live(task_id) or (directory and agent_host.status(directory)["alive"]):
        raise ApiError(409, f"{task_id}'s agent is still running, so its worktree stays" + (f": {note}" if note else ""))
    if not exists:
        output = f"{path} was already removed"
    elif command:
        env = {"KANBOARD_TASK": task_id, "KANBOARD_REPO": repo, "KANBOARD_BRANCH": branch, "KANBOARD_WORKTREE": path,
               "KANBOARD_TEARDOWN_SCRIPT": os.path.expanduser(teardown)}
        code, output, error = run_hook("removeWorktree", command, path, 300, env)
        output = output.strip()
        if code != 0:
            raise ApiError(409, error, {"output": output})
    else:
        refuse_dirty()
        log = run_script("Teardown script", teardown, path, 300, task_env) if teardown else ""
        code, out, err = run(["git", "-C", repo, "worktree", "remove", "--force", path], timeout=120)
        if code != 0:
            raise ApiError(500, (err or out).strip())
        run(["git", "-C", repo, "branch", "-D", branch], timeout=30)
        output = log + f"Removed {path} and branch {branch}"
    with store.lock:
        t = store.tasks.get(task_id)
        if t:
            forget_worktree(t, park=("todo", "doing"))
    if directory:
        shutil.rmtree(directory, ignore_errors=True)
    hub.changed()
    return {"ok": True, "output": output}


def forget_worktree(t: Dict[str, Any], park: Tuple[str, ...]) -> None:
    """Drops a task's worktree, agent and terminal records and its live state (call under store.lock). An unfinished
    task is no longer started, so starting it checks its branch out anew; a card in `park` moves to Backlog."""
    task_id = t["id"]
    t.update(worktree=None, presentation=None, execution=None, agent=None, git=None)
    if not t.get("merged") and t["column"] != "done":
        t["spawn"] = {"state": "none", "error": None, "log": ""}
        if t["column"] in park:
            t["column"], t["order"] = "backlog", store.next_order("backlog")
    store.save(t)
    store.activity.pop(task_id, None)
    store.resuming.pop(task_id, None)
    store.hosts.pop(task_id, None)
    hub.cancel_queued(task_id)


def recoverable(t: Dict[str, Any]) -> Optional[Path]:
    """Refuses to return a task to Backlog unless it is unfinished, its recorded worktree is gone and no agent of it is
    connected or may run in a terminal the board doesn't manage (call under store.lock); returns its host directory."""
    task_id = t["id"]
    path = require_spawned(t)
    if t["column"] == "done" or t.get("merged"):
        raise ApiError(409, f"{task_id} is done")
    if t["spawn"]["state"] == "running":
        raise ApiError(409, f"{task_id} is still starting")
    if Path(path).is_dir():
        raise ApiError(409, f"{task_id}'s worktree {path} still exists; stop the task, or clean it up to remove it")
    if hub.task_live(task_id):
        raise ApiError(409, f"{task_id}'s omp session is still connected; stop it first")
    if legacy_unknown(t):
        raise ApiError(409, f"{task_id}'s agent ran in a terminal the board doesn't manage and wasn't seen to exit; "
                            "close that terminal, then try again")
    return host_dir(t)


def recover_task(task_id: str) -> Dict[str, Any]:
    """Returns a started task whose worktree was deleted outside the board to a restartable Backlog card: forgets its
    worktree, agent and terminal records, keeping the card, its notes and its branch. It never stops, starts or resumes
    an agent, so one that may still run is refused."""
    with store.lock:
        directory = recoverable(store.get(task_id))
    if directory and directory.is_dir():
        try:
            idle = agent_host.abandon(directory)
        except (OSError, agent_host.HostError) as e:
            raise ApiError(409, f"{task_id}'s agent host couldn't be checked ({e}); try again")
        if not idle:
            raise ApiError(409, f"{task_id}'s agent is still running; stop it first")
    with store.lock:
        t = store.get(task_id)
        if recoverable(t) != directory:
            raise ApiError(409, f"{task_id}'s agent changed meanwhile; try again")
        forget_worktree(t, park=("todo", "doing", "review"))
        view = store.view(t)
    if directory:
        shutil.rmtree(directory, ignore_errors=True)
    hub.changed()
    poller.kick()
    return view


def commit_task_changes(path: str, branch: str, task_id: str, title: str) -> Optional[str]:
    for ref, action in (("MERGE_HEAD", "merge"), ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert")):
        if run(["git", "-C", path, "rev-parse", "-q", "--verify", ref], timeout=10)[0] == 0:
            raise ApiError(409, f"The task worktree has a {action} in progress; finish or abort it first")
    _, git_dir, _ = run(["git", "-C", path, "rev-parse", "--absolute-git-dir"], timeout=10)
    if git_dir.strip() and any((Path(git_dir.strip()) / state).exists() for state in ("rebase-merge", "rebase-apply")):
        raise ApiError(409, "The task worktree has a rebase in progress; finish or abort it first")
    code, head, error = run(["git", "-C", path, "symbolic-ref", "-q", "--short", "HEAD"], timeout=10)
    if code != 0 or head.strip() != branch:
        current = head.strip() or "a detached HEAD"
        raise ApiError(409, f"The task worktree is on {current}, not {branch}", {"output": error})
    _, status, _ = run(["git", "-C", path, "status", "--porcelain"], timeout=30)
    if not status.strip():
        return None
    code, out, error = run(["git", "-C", path, "add", "--all"], timeout=120)
    if code != 0:
        raise ApiError(409, "Could not stage the task changes", {"output": (out + error).strip()})
    code, out, error = run(["git", "-C", path, "diff", "--cached", "--quiet"], timeout=30)
    if code == 0:
        raise ApiError(409, "The worktree has changes Git cannot commit", {"output": status})
    if code != 1:
        raise ApiError(409, "Could not inspect the staged task changes", {"output": (out + error).strip()})
    subject = f"{task_id}: {' '.join(plain(title).splitlines()).strip() or 'Orchestrator task'}"
    code, out, error = run(["git", "-C", path, "commit", "-m", subject], timeout=120)
    if code != 0:
        raise ApiError(409, "Could not commit the task changes", {"output": (out + error).strip()})
    code, sha, error = run(["git", "-C", path, "rev-parse", "--short", "HEAD"], timeout=10)
    if code != 0 or not sha.strip():
        raise ApiError(500, "Committed the task changes but could not read the commit", {"output": error.strip()})
    return sha.strip()


MERGE_LOCK = threading.Lock()


def merge_task(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Commits a task, rebases it after a conflict, and merges it into its base; `cleanup` removes the worktree."""
    with store.lock:
        t = store.get(task_id)
        path = require_spawned(t)
        repo, branch, base, checkout, title = t["repo"], t["branch"], t["base"], t["checkout"], t["title"]
    commit_sha = None
    rebased = False
    with MERGE_LOCK:
        target = checkout if Path(checkout).is_dir() and git_toplevel(checkout) else find_worktree(repo, base)
        if not target:
            raise ApiError(409, f"No checkout of {base} to merge into")
        _, head, _ = run(["git", "-C", target, "symbolic-ref", "-q", "--short", "HEAD"], timeout=10)
        if head.strip() != base:
            raise ApiError(409, f"{target} is on {head.strip() or 'a detached HEAD'}, not {base}")
        # A merge left in progress there is the user's: aborting ours below must never touch it.
        if run(["git", "-C", target, "rev-parse", "-q", "--verify", "MERGE_HEAD"], timeout=10)[0] == 0:
            raise ApiError(409, f"{target} has a merge in progress; finish or abort it first")
        if body.get("commit") is True:
            commit_sha = commit_task_changes(path, branch, task_id, title)
        _, status, _ = run(["git", "-C", path, "status", "--porcelain"], timeout=30)
        if status.strip():
            raise ApiError(409, "The worktree has uncommitted changes; commit them first", {"output": status})
        _, ahead, _ = run(["git", "-C", target, "rev-list", "--count", f"{base}..{branch}"], timeout=15)
        already = None
        if not ahead.strip().isdigit() or int(ahead) == 0:
            # A merge that landed without being recorded (an interrupted /orchestrator done) finishes the task instead of failing.
            _, already, _ = run(["git", "-C", target, "log", "-1", "--format=%H", "--fixed-strings",
                                 f"--grep=Merge {branch} ({task_id}:", base], timeout=15)
            if not already.strip():
                raise ApiError(409, f"Nothing to merge: {branch} has no commits that {base} lacks")
        # Already merged: `--ff-only` on an ancestor is a successful no-op, so the shared completion below records it.
        merge_command = ["git", "-C", target, "merge", "--ff-only", branch] if already else [
            "git", "-C", target, "merge", "--no-ff", "--no-edit", "-m",
            f"Merge {branch} ({task_id}: {title})", branch,
        ]
        code, out, err = run(merge_command, timeout=120)
        if code != 0:
            conflicts = unmerged_files(target)
            abort_code, abort_out, abort_err = run(["git", "-C", target, "merge", "--abort"], timeout=30)
            if conflicts and abort_code != 0:
                details = "\n".join(part for part in ((out + err).strip(), (abort_out + abort_err).strip()) if part)
                raise ApiError(409, f"Merge conflicted in {', '.join(conflicts)} and could not be aborted",
                               {"output": details})
            if not conflicts:
                raise ApiError(409, (err or out).strip() or "git merge failed", {"output": (out + err).strip()})
            rebase_code, rebase_out, rebase_err = run(
                ["git", "-C", path, "rebase", base],
                timeout=300,
                env={"GIT_EDITOR": "true", "GIT_SEQUENCE_EDITOR": "true"},
            )
            if rebase_code != 0:
                rebase_conflicts = unmerged_files(path)
                if not rebase_conflicts:
                    run(["git", "-C", path, "rebase", "--abort"], timeout=30)
                    raise ApiError(
                        409,
                        f"Merge conflicted and automatic rebase of {branch} onto {base} failed",
                        {"output": (rebase_out + rebase_err).strip()},
                    )
                names = ", ".join(rebase_conflicts)
                instruction = (
                    f"`/orchestrator done` found a merge conflict and started `git rebase {base}`. "
                    f"The rebase is paused on {names}. Resolve every conflict in this task worktree, "
                    "stage the resolved files, and continue the rebase until it completes. "
                    "Do not merge the base branch; report when the rebased task is ready."
                )
                notified = True
                try:
                    message_agent(task_id, {"text": instruction})
                except ApiError:
                    notified = False
                poller.kick(full=True)
                message = f"Automatic rebase stopped on conflicts in {names}"
                if notified:
                    message += "; the task agent was asked to resolve them"
                else:
                    message += "; resolve them in the task worktree, then retry /orchestrator done"
                details = "\n".join(
                    part for part in ((out + err).strip(), (rebase_out + rebase_err).strip()) if part
                )
                raise ApiError(
                    409,
                    message,
                    {
                        "output": details,
                        "conflicts": rebase_conflicts,
                        "agentNotified": notified,
                    },
                )
            rebased = True
            if commit_sha:
                sha_code, rebased_sha, _ = run(["git", "-C", path, "rev-parse", "--short", "HEAD"], timeout=10)
                if sha_code == 0 and rebased_sha.strip():
                    commit_sha = rebased_sha.strip()
            code, out, err = run(merge_command, timeout=120)
            if code != 0:
                retry_conflicts = unmerged_files(target)
                abort_code, abort_out, abort_err = run(["git", "-C", target, "merge", "--abort"], timeout=30)
                if retry_conflicts and abort_code != 0:
                    details = "\n".join(
                        part for part in ((out + err).strip(), (abort_out + abort_err).strip()) if part
                    )
                    raise ApiError(409, f"Merge conflicted after rebase in {', '.join(retry_conflicts)} "
                                       "and could not be aborted", {"output": details})
                if retry_conflicts:
                    message = f"Merge conflict after rebase in {', '.join(retry_conflicts)}"
                else:
                    message = (err or out).strip() or "git merge failed after rebase"
                raise ApiError(409, message, {"output": (out + err).strip()})
        _, sha, _ = run(["git", "-C", target, "rev-parse", "HEAD"], timeout=10)
    merged = {"at": now_iso(), "into": base, "sha": sha.strip(), "checkout": target}
    with store.lock:
        t = store.tasks.get(task_id)
        if t:
            t["merged"] = merged
            if t["column"] != "done":
                t["column"], t["order"] = "done", store.next_order("done")
            store.save(t)
    hub.changed()
    poller.kick(full=True)
    lines = []
    if commit_sha:
        lines.append(f"Committed pending changes on {branch} ({commit_sha})")
    if rebased:
        lines.append(f"Rebased {branch} onto {base}")
    lines.append(f"Merged {branch} into {base} ({merged['sha'][:7]})")
    output = "\n".join(lines)
    if body.get("cleanup"):
        try:
            output += "\n" + cleanup_task(task_id, {})["output"]
        except ApiError as e:
            return {"ok": True, "output": output, "merged": merged, "cleanupError": e.message}
    return {"ok": True, "output": output, "merged": merged}


# --- status poller --------------------------------------------------------------------

class Poller:
    """Keeps spawned tasks' agent, git and PR status current, moves cards on PR open/merge and local readiness,
    and starts or resumes the Todo tasks whose dependencies are done."""

    def __init__(self) -> None:
        self.wake = threading.Event()
        self.forced = False
        self.last_git = 0.0
        self.last_pr = 0.0
        self.last_presentation = 0.0
        self.last_legacy = 0.0

    def kick(self, full: bool = False) -> None:
        self.forced = self.forced or full
        self.wake.set()

    def run(self) -> None:
        while True:
            self.wake.wait(timeout=3)
            self.wake.clear()
            forced, self.forced = self.forced, False
            try:
                self.tick(forced)
            except Exception as e:  # keep polling through transient failures
                print(f"orchestrator: poll failed: {e!r}", file=sys.stderr)

    def tick(self, forced: bool) -> None:
        changed = self.check_beads()
        with store.lock:
            tracked = [dict(t) for t in store.tasks.values() if spawned(t)]
        if tracked:
            changed |= self.check_agents(tracked)
            now = time.time()
            if forced or now - self.last_git >= 10:
                self.last_git = now
                changed |= self.check_git([t for t in tracked if t["column"] != "done"])
            changed |= self.check_ready(tracked)
            if forced or now - self.last_pr >= 60:
                self.last_pr = now
                changed |= self.check_prs([t for t in tracked if t["column"] != "done" or not t.get("pr")])
        changed |= self.check_queue()
        if changed:
            hub.changed()

    def check_beads(self) -> bool:
        """Takes in task edits made with bd outside the board."""
        try:
            return store.sync()
        except ApiError as e:
            print(f"orchestrator: reading Beads failed: {e.message}", file=sys.stderr)
            return False

    def check_queue(self) -> bool:
        """Starts Todo tasks, and resumes paused ones, whose dependencies are done and whose flow has capacity."""
        with store.lock:
            refreshed = False
            if any(t["column"] == "todo" for t in store.tasks.values()):
                try:
                    refreshed = store.fresh_blocked()
                except ApiError as e:
                    print(f"orchestrator: reading Beads blockers failed, starting nothing: {e.message}", file=sys.stderr)
                    return False
            queued = sorted((t for t in store.tasks.values() if t["column"] == "todo" and not blocked_by(t) and (
                (paused(t) and not legacy_unknown(t))
                or (not spawned(t) and t["spawn"]["state"] == "none" and Path(t["repo"]).is_dir()))),
                            key=lambda t: (t["order"], t["createdAt"]))
            starting, resuming = [], []
            for t in queued:
                if not has_task_slot(t):
                    continue
                if paused(t):
                    t["column"], t["order"] = "doing", store.next_order("doing")
                    store.resuming[t["id"]] = time.time()
                    store.save(t)
                    resuming.append(t["id"])
                else:
                    start_task(t)
                    starting.append(t["id"])
        for task_id in starting:
            threading.Thread(target=spawn_worker, args=(task_id,), daemon=True).start()
        for task_id in resuming:
            threading.Thread(target=resume_task, args=(task_id,), daemon=True).start()
        return bool(starting or resuming) or refreshed

    def check_agents(self, tracked: List[Dict[str, Any]]) -> bool:
        """Agent state from each task's own omp session (its stream and reports) and its managed host; terminals are only
        asked now and then whether they are still open, which never decides the agent's state. A legacy agent that isn't
        connected counts as stopped once a complete scan finds no process of this user working in its worktree."""
        hosts = {s["id"]: agent_host.status(d) for s in tracked for d in [host_dir(s)] if d}
        opened: Dict[str, bool] = {}
        now = time.time()
        if now - self.last_presentation >= PRESENTATION_INTERVAL:
            self.last_presentation = now
            opened = {s["id"]: terminals.alive(s["presentation"]) for s in tracked
                      if (s.get("presentation") or {}).get("kind") in ("cmux", "tmux")}
        cwds: Optional[List[str]] = None
        if now - self.last_legacy >= LEGACY_PROBE_INTERVAL and any(legacy_unknown(s) for s in tracked):
            self.last_legacy = now
            cwds = process_cwds()
        changed = False
        with store.lock:
            for snapshot in tracked:
                t = store.tasks.get(snapshot["id"])
                if not t:
                    continue
                task_id, ex = t["id"], t.get("execution")
                connected = hub.task_live(task_id)
                persist = False
                host = hosts.get(task_id)
                if host is not None and host_dir(t):
                    if store.hosts.get(task_id) != host:
                        store.hosts[task_id] = host
                        changed = True
                    if host.get("instance") and ex.get("instance") != host["instance"]:
                        ex["instance"] = host["instance"]
                        persist = True
                if connected and not ex:
                    # A connected omp the board didn't start (run by hand in the worktree) is adopted, never duplicated.
                    t["execution"] = {"kind": "legacy", "session": None, "stopped": False}
                    persist = True
                elif connected and ex.get("kind") == "legacy" and ex.get("stopped"):
                    ex["stopped"] = False
                    persist = True
                elif cwds is not None and legacy_unknown(t) and not any(within(c, t["worktree"]) for c in cwds):
                    ex["stopped"] = True
                    persist = True
                    print(f"orchestrator: {task_id}'s legacy agent is gone: no process works in {t['worktree']}",
                          file=sys.stderr)
                activity = store.activity.get(task_id)
                if not connected and activity and activity.get("state"):
                    # A lost session's last report says nothing about whatever runs next.
                    store.activity[task_id] = {"state": None, "step": None, "since": None,
                                               "message": activity.get("message")}
                agent = agent_state(t, connected, store.hosts.get(task_id))
                if agent != t.get("agent"):
                    t["agent"] = agent
                    changed = True
                presentation = t.get("presentation")
                if task_id in opened and presentation and presentation.get("alive") != opened[task_id]:
                    t["presentation"] = {**presentation, "alive": opened[task_id]}
                    persist = True
                if persist:
                    store.save(t)
                    changed = True
        return changed

    def check_git(self, tracked: List[Dict[str, Any]]) -> bool:
        results = {}
        for t in tracked:
            path = t["worktree"]
            if not Path(path).is_dir():
                results[t["id"]] = None
                continue
            _, mb = merge_base(path, t["base"])
            added = removed = files = 0
            code, out, _ = run(["git", "-C", path, "diff", "--numstat", mb], timeout=30)
            for line in out.splitlines() if code == 0 else []:
                a, r, _name = (line.split("\t", 2) + ["", ""])[:3]
                files += 1
                added += int(a) if a.isdigit() else 0
                removed += int(r) if r.isdigit() else 0
            _, commits, _ = run(["git", "-C", path, "rev-list", "--count", f"{mb}..HEAD"], timeout=15)
            _, status, _ = run(["git", "-C", path, "status", "--porcelain"], timeout=30)
            results[t["id"]] = {"added": added, "removed": removed, "files": files,
                                "commits": int(commits.strip() or 0) if commits.strip().isdigit() else 0,
                                "dirty": len([l for l in status.splitlines() if l.strip()])}
        changed = False
        with store.lock:
            for task_id, git in results.items():
                t = store.tasks.get(task_id)
                if not t:
                    continue
                persist = False
                if t["planningMode"] == "auto" and t.get("planningOutcome") is None and git \
                        and (git["dirty"] > 0 or git["commits"] > 0):
                    t["planningOutcome"] = "fast"
                    persist = True
                if t.get("git") != git:
                    t["git"] = git
                    changed = True
                if persist:
                    store.save(t)
                    changed = True
        return changed

    def check_ready(self, tracked: List[Dict[str, Any]]) -> bool:
        """Moves local-merge tasks to Review once their agent stopped with committed work and a clean worktree."""
        changed = False
        with store.lock:
            for snapshot in tracked:
                t = store.tasks.get(snapshot["id"])
                if not t or t["merge"] != "local" or t["column"] != "doing" or t.get("pr"):
                    continue
                since = store.resuming.get(t["id"])
                if since is not None:
                    # A resumed agent reads idle or closed until it picks up its resume message.
                    if (t.get("agent") or {}).get("state") in ACTIVE_STATES or time.time() - since > RESUME_GRACE:
                        store.resuming.pop(t["id"], None)
                    continue
                agent, git = t.get("agent") or {}, t.get("git") or {}
                # Only the agent's own connected session saying idle counts: a lost terminal or connection never does.
                if agent.get("state") == "idle" and hub.task_live(t["id"]) and git.get("commits", 0) > 0 \
                        and git.get("dirty", 0) == 0:
                    t["column"], t["order"] = "review", store.next_order("review")
                    store.save(t)
                    changed = True
        return changed

    def check_prs(self, tracked: List[Dict[str, Any]]) -> bool:
        if not tracked or not which("gh"):
            return False
        by_repo: Dict[str, Dict[str, Dict[str, Any]]] = {}
        for repo in {t["repo"] for t in tracked}:
            code, out, _ = run(["gh", "pr", "list", "--state", "all", "--limit", "100", "--json",
                                "number,state,url,title,isDraft,headRefName"], cwd=repo, timeout=45)
            if code != 0:
                continue
            prs: Dict[str, Dict[str, Any]] = {}
            try:
                for pr in json.loads(out):
                    prs.setdefault(pr["headRefName"], pr)
            except (ValueError, KeyError, TypeError):
                continue
            by_repo[repo] = prs
        changed = False
        with store.lock:
            for snapshot in tracked:
                t = store.tasks.get(snapshot["id"])
                prs = by_repo.get(snapshot["repo"])
                if not t or prs is None:
                    continue
                found = prs.get(t["branch"])
                pr = None
                if found:
                    state = found["state"].lower()
                    if state == "open" and found.get("isDraft"):
                        state = "draft"
                    pr = {"number": found["number"], "state": state, "url": found["url"], "title": found["title"]}
                column = t["column"]
                if pr and pr["state"] == "merged" and column != "done":
                    column = "done"
                elif pr and pr["state"] in ("open", "draft") and column in ("todo", "doing"):
                    column = "review"
                if pr != t.get("pr") or column != t["column"]:
                    if column != t["column"]:
                        t["column"], t["order"] = column, store.next_order(column)
                    t["pr"] = pr
                    store.save(t)
                    changed = True
        return changed


poller = Poller()


# --- appearance -------------------------------------------------------------------------

appearance_cache: Dict[str, Any] = {"at": 0.0, "css": "", "nerdFont": False, "scheme": None, "palette": {}}


def appearance() -> Dict[str, Any]:
    """The terminal-derived appearance, re-read at most every APPEARANCE_TTL seconds."""
    if time.time() - appearance_cache["at"] < APPEARANCE_TTL:
        return appearance_cache
    css, nerd_font, scheme, palette = "", False, None, {}
    cli = ghostty_cli()
    if cli:
        code, out, _ = run([cli, "+show-config"], timeout=5)
        if code == 0:
            css, nerd_font, scheme, palette = terminal_appearance(out)
    appearance_cache.update(at=time.time(), css=css, nerdFont=nerd_font, scheme=scheme, palette=palette)
    return appearance_cache


def appearance_css(flow: str) -> str:
    """The terminal's colors and font under `flow`'s omp theme (else the latest sent); the theme's background only when its scheme differs."""
    base = appearance()
    with store.lock:
        theme = store.themes.get(flow) or next(reversed(store.themes.values()), None)
    if not theme:
        return base["css"]
    own_bg = base["scheme"] != theme["scheme"] and "--bg" in theme["vars"]
    decls = ([f"color-scheme: {theme['scheme']}"] if own_bg else []) + \
        [f"{k}: {v}" for k, v in theme["vars"].items() if own_bg or k not in ("--bg", "--fg")]
    return base["css"] + ":root {\n" + "".join(f"  {d};\n" for d in decls) + "}\n"


# --- HTTP ---------------------------------------------------------------------------------

NATIVE_TEXT_KEYS = ("description", "design", "notes", "acceptance_criteria", "metadata")
READINESS_DISCLAIMER = (
    "Beads ready means a bead in an open-category status (open, or todo here) with no open blocker; it starts nothing. "
    "The board starts a task only from Todo, once its dependencies are done and Beads no longer blocks its parent, and "
    "only while its flow has a free slot: a ready Backlog task waits for a move to Todo, and a paused task resumes from "
    "Todo the same way.")


def task_history(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """A task's native Beads history: its bead's commit snapshots, or with events its audit events, newest first."""
    limit = body.get("limit", 10)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
        raise ApiError(400, "limit must be a whole number from 1 to 50")
    events = body.get("events", False)
    if not isinstance(events, bool):
        raise ApiError(400, "events must be true or false")
    with store.lock:
        store.get(task_id)
    try:
        history = store.workspace.history(task_id, limit, events)
    except beads.BeadsError as e:
        raise beads_api_error(e)
    return {"id": task_id, "history": history or [], "events": events}


def board_readiness(t: Dict[str, Any]) -> Tuple[bool, str]:
    """Whether the board's queue would start or resume `t` now, and why or why not (call under store.lock)."""
    column = dict(COLUMNS)[t["column"]]
    blockers = blocked_by(t)
    startable = paused(t) or (not spawned(t) and t["spawn"]["state"] == "none" and Path(t["repo"]).is_dir())
    if t["column"] == "done":
        return False, "Done"
    if t["spawn"]["state"] == "running":
        return False, f"{column}: starting, its worktree and agent are being set up"
    if t["column"] in ("doing", "review"):
        return False, f"{column}: started, the queue no longer applies"
    if t["column"] == "backlog":
        return False, ("Backlog: paused; moving it to Todo queues its resume" if paused(t)
                       else "Backlog: never started automatically; moving it to Todo queues it")
    if blockers:
        own = [b for b in blockers if b in t["dependsOn"]]
        inherited = [b for b in blockers if b not in own]
        parts = ([f"waits for {', '.join(own)} to be done"] if own else []) + \
            ([f"inherits the block on its parent tree ({', '.join(inherited)})"] if inherited else [])
        return False, "Todo: " + " and ".join(parts)
    if paused(t) and legacy_unknown(t):
        return False, ("Todo: paused, but its agent ran in a terminal the board doesn't manage and may still run there; "
                       "close that terminal, then move it to In Progress confirming the resume")
    if not startable:
        if not Path(t["repo"]).is_dir():
            return False, f"Todo: its repository {t['repo']} is missing"
        error = t["spawn"].get("error")
        return False, f"Todo: its last start {t['spawn']['state']}" + (f" ({error})" if error else "") + \
            "; move it to start again"
    if not has_task_slot(t):
        limit = flow_concurrency_limit(t["repo"], t["base"])
        return True, f"Todo: waits for a free slot in {flow_id(t['repo'], t['base'])} " \
                     f"({active_task_count(t['repo'], t['base'])} of {limit} in use)"
    return True, "Todo: " + ("resumes" if paused(t) else "starts") + " on the board's next tick"


def readiness(body: Dict[str, Any]) -> Dict[str, Any]:
    """Beads' native ready/blocked explanation for the board's tasks in scope (one task, one flow, or the board), beside
    the board's own queue state; starts nothing."""
    flow, task_id = body.get("flow"), body.get("id")
    if any(v is not None and not isinstance(v, str) for v in (flow, task_id)):
        raise ApiError(400, "flow and id must be strings")
    with store.lock:
        if task_id:
            t = store.get(task_id)
            if flow and flow != flow_id(t["repo"], t["base"]):
                raise ApiError(400, f"{task_id} belongs to {flow_id(t['repo'], t['base'])}, not {flow}")
        elif flow and flow not in {f["id"] for f in store.flow_list()}:
            raise ApiError(404, f"No flow {flow}")
    try:
        native = store.workspace.ready_explained()
    except beads.BeadsError as e:
        raise beads_api_error(e)
    with store.lock:
        store.fresh_blocked()
        if task_id:
            t = store.get(task_id)
            scope, flow = [t], flow_id(t["repo"], t["base"])
        else:
            scope = [t for t in store.tasks.values() if t["column"] != "done"
                     and (not flow or flow_id(t["repo"], t["base"]) == flow)]
        ids = {t["id"] for t in scope}

        def rows(key: str) -> List[Dict[str, Any]]:
            return [{k: v for k, v in r.items() if k not in NATIVE_TEXT_KEYS} for r in native.get(key) or []
                    if isinstance(r, dict) and r.get("id") in ids]

        ready, blocked = rows("ready"), rows("blocked")
        listed = {r["id"]: ("ready", r) for r in ready}
        listed.update({r["id"]: ("blocked", r) for r in blocked})
        tasks = []
        for t in sorted(scope, key=lambda t: (COLUMN_IDS.index(t["column"]), t["order"], t["createdAt"])):
            state, row = listed.get(t["id"], (None, {}))
            status = row.get("status") or store.seen[t["id"]]["status"]
            native_blockers = [b["id"] for b in row.get("blocked_by") or [] if isinstance(b, dict) and b.get("id")]
            queued, why = board_readiness(t)
            if state == "ready":
                said = f"Beads: ready (status {status}, no open blocker)"
            elif state == "blocked":
                said = f"Beads: blocked by {', '.join(native_blockers)} (status {status})"
            else:
                said = f"Beads: neither ready nor blocked (status {status} isn't open work)"
            tasks.append({"id": t["id"], "title": t["title"], "column": t["column"], "status": status,
                          "queued": queued, "blockedBy": blocked_by(t), "waitingForSlot": waiting_for_slot(t),
                          "paused": paused(t), "native": state, "nativeBlockedBy": native_blockers,
                          "reason": f"{why}. {said}"})
    summary = {"total_ready": len(ready), "total_blocked": len(blocked),
               "cycle_count": (native.get("summary") or {}).get("cycle_count", 0)}
    return {"flow": flow or None, "native": {"ready": ready, "blocked": blocked, "summary": summary},
            "tasks": tasks, "disclaimer": READINESS_DISCLAIMER}


def refresh() -> Dict[str, Any]:
    poller.kick(full=True)
    return {"ok": True}


def project_memories(body: Dict[str, Any]) -> Dict[str, Any]:
    action = body.get("action")
    if action not in ("search", "read", "remember", "forget"):
        raise ApiError(400, "Memory action must be search, read, remember or forget")
    repo = body.get("repo")
    if not isinstance(repo, str) or not repo.strip():
        raise ApiError(400, "A memory needs a repository path")
    info = checkout_info(str(Path(repo).expanduser()))
    if not info:
        raise ApiError(400, f"{repo} is not a git repository")
    scope = os.path.realpath(info["repo"])
    prefix = f"kanboard.{hashlib.sha256(scope.encode()).hexdigest()[:16]}."
    key = body.get("key")
    if action != "search" and (not isinstance(key, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}", key)):
        raise ApiError(400, "Memory key must be 1–80 letters, digits, dots, underscores or hyphens, starting with a letter or digit")
    query = body.get("query", "")
    if not isinstance(query, str) or len(query) > 200:
        raise ApiError(400, "Memory query must be at most 200 characters")
    text = body.get("text")
    if action == "remember" and (not isinstance(text, str) or not text.strip() or len(text) > 4000):
        raise ApiError(400, "Memory text must be nonempty and at most 4000 characters")
    try:
        if action == "search":
            data = store.workspace.call(["memories", *(["--", query] if query else [])])
            entries = [{"key": k[len(prefix):], "text": v} for k, v in sorted(data.items())
                       if k.startswith(prefix) and isinstance(v, str)]
        elif action == "remember":
            store.workspace.call(["remember", "--key", prefix + key, "--", text.strip()])
            entries = [{"key": key, "text": text.strip()}]
        else:
            data = store.workspace.call(["memories", "--", prefix + key])
            if prefix + key not in data:
                raise ApiError(404, f"No shared memory {key} in {scope}")
            if action == "read":
                entries = [{"key": key, "text": data[prefix + key]}]
            else:
                store.workspace.call(["forget", prefix + key])
                entries = []
    except beads.BeadsError as e:
        raise beads_api_error(e)
    limit = 60000 if action == "read" else 16000
    result = []
    truncated = False
    for entry in entries:
        if len(result) == 20 or limit <= 0:
            truncated = True
            break
        value = entry["text"][:limit]
        truncated |= len(value) < len(entry["text"])
        result.append({"key": entry["key"], "text": value})
        limit -= len(value)
    return {"scope": scope, "memories": result, "truncated": truncated}


def stop(*_: Any) -> None:
    raise KeyboardInterrupt


ROUTES = [
    ("POST", r"/api/memories", lambda m, b: project_memories(b)),
    ("POST", r"/api/tasks", lambda m, b: create_task(b)),
    ("PATCH", r"/api/tasks/([\w.-]+)", lambda m, b: update_task(m[1], b)),
    ("DELETE", r"/api/tasks/([\w.-]+)", lambda m, b: delete_task(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/move", lambda m, b: move_task(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/reorder", lambda m, b: reorder_task(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/open", lambda m, b: open_task(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/worktree/open", lambda m, b: open_worktree(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/message", lambda m, b: message_agent(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/review", lambda m, b: review_plan(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/stop", lambda m, b: stop_task(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/amend", lambda m, b: amend_task(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/update", lambda m, b: send_update(m[1], b)),
    ("GET", r"/api/tasks/([\w.-]+)/screen", lambda m, b: read_screen(m[1])),
    ("GET", r"/api/tasks/([\w.-]+)/diff", lambda m, b: task_diff(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/diff/open", lambda m, b: present_diff(m[1])),
    ("GET", r"/api/tasks/([\w.-]+)/context", lambda m, b: task_context(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/context", lambda m, b: publish_context(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/merge", lambda m, b: merge_task(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/discuss", lambda m, b: discuss_task(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/cleanup", lambda m, b: cleanup_task(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/recover", lambda m, b: recover_task(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/history", lambda m, b: task_history(m[1], b)),
    ("POST", r"/api/readiness", lambda m, b: readiness(b)),
    ("POST", r"/api/refresh", lambda m, b: refresh()),
    ("POST", r"/api/context", lambda m, b: set_context(b)),
    ("POST", r"/api/flows", lambda m, b: register_flow(b)),
    ("POST", r"/api/flows/prompt", lambda m, b: prompt_task(b)),
    ("PATCH", r"/api/flows", lambda m, b: set_flow_concurrency(b)),
    ("PATCH", r"/api/flows/scripts", lambda m, b: set_flow_scripts(b)),
    ("POST", r"/api/agent", lambda m, b: report_agent(b)),
    ("POST", r"/api/control/([\w-]+)", lambda m, b: answer_control(m[1], b)),
    ("POST", r"/api/appearance", lambda m, b: set_theme(b)),
    ("GET", r"/api/state", lambda m, b: store.board()),
    ("GET", r"/api/health", lambda m, b: {"ok": True, "pid": os.getpid(), "started": STARTED, "codeMtime": CODE_MTIME}),
]


class Handler(BaseHTTPRequestHandler):
    server_version = "orchestrator"

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def send_json(self, status: int, data: Any) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def allowed_origins(self) -> set:
        return {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}

    def guard(self) -> None:
        """Only this machine's board may call the API: right Host (DNS rebinding) and no cross-site writes."""
        if self.headers.get("Host") not in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}:
            raise ApiError(403, "Unexpected Host header")
        if self.command in ("POST", "PATCH", "DELETE"):
            origin = self.headers.get("Origin")
            if origin and origin not in self.allowed_origins():
                raise ApiError(403, "Cross-origin request refused")
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                raise ApiError(403, "Cross-site request refused")
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                raise ApiError(415, "Send JSON")

    def body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length > 4_000_000:
            raise ApiError(413, "Request too large")
        if not length:
            return {}
        try:
            data = json.loads(self.rfile.read(length))
        except ValueError:
            raise ApiError(400, "Invalid JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "Expected a JSON object")
        return data

    def handle_any(self) -> None:
        try:
            self.guard()
            path = urlparse(self.path).path
            if self.command == "GET" and path in ("/", "/index.html"):
                page = ROOT / "index.html"
                if not page.exists():
                    raise ApiError(404, "index.html is missing")
                return self.serve_bytes(page.read_bytes(), "text/html; charset=utf-8")
            if self.command == "GET" and path in ("/markdown.js", "/graph-layout.js", "/pipeline.js", "/pipeline.css", "/workbench.js", "/workbench.css", "/native.js", "/native.css"):
                asset = ROOT / path.lstrip("/")
                content_type = "text/javascript" if path.endswith(".js") else "text/css"
                return self.serve_bytes(asset.read_bytes(), content_type + "; charset=utf-8")
            if self.command == "GET" and path == "/appearance.css":
                flow = parse_qs(urlparse(self.path).query).get("flow", [""])[0]
                return self.serve_bytes(appearance_css(flow).encode(), "text/css; charset=utf-8")
            if self.command == "GET" and path == "/api/events":
                return self.serve_events()
            for method, pattern, handler in ROUTES:
                m = re.fullmatch(pattern, path)
                if m and method == self.command:
                    return self.send_json(200, handler(m, self.body() if method != "GET" else {}))
            raise ApiError(404, f"No route {self.command} {path}")
        except ApiError as e:
            self.send_json(e.status, {"error": e.message, **e.extra})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            print(f"orchestrator: {self.command} {self.path} failed: {e!r}", file=sys.stderr)
            try:
                self.send_json(500, {"error": f"Internal error: {e}"})
            except OSError:
                pass

    do_GET = do_POST = do_PATCH = do_DELETE = handle_any

    def serve_bytes(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def serve_events(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        meta: Dict[str, Any] = {k: (query.get(k) or [None])[0] or None for k in ("session", "flow", "task")}
        meta["terminal"] = terminal_context((query.get("terminal") or [None])[0])
        session, task = meta["session"], meta["task"]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = hub.subscribe(meta)
        if session:
            hub.changed()
        if task:
            note_session(task, session, None)
            poller.kick()
        try:
            self.wfile.write(f"event: snapshot\ndata: {json.dumps(store.board())}\n\n".encode())
            self.wfile.flush()
            # A session stream pings often so a closed omp session stops reading as live within seconds.
            while True:
                try:
                    payload = q.get(timeout=3 if session else 15)
                except queue.Empty:
                    payload = ": ping\n\n"
                self.wfile.write(payload.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            hub.unsubscribe(q)
            if session:
                hub.changed()
            if task:
                poller.kick()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        if not isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
            super().handle_error(request, client_address)


def prepare() -> None:
    """`server.py --prepare`: readies the Beads workspace and imports legacy JSON tasks once."""
    HOME.mkdir(parents=True, exist_ok=True)
    try:
        beads.prepare(HOME, child_env(), default_branch, lambda line: print(line, file=sys.stderr, flush=True))
    except beads.BeadsError as e:
        print(f"orchestrator: {e}", file=sys.stderr, flush=True)
        sys.exit(1)


def main() -> None:
    if sys.argv[1:] == ["--prepare"]:
        prepare()
        return
    # Commands run without an explicit cwd inherit the server's; a launch from inside a task worktree would break every one of
    # them (git included) once that worktree is removed on merge.
    HOME.mkdir(parents=True, exist_ok=True)
    os.chdir(HOME)
    try:
        store.load()
    except (beads.BeadsError, ApiError) as e:
        print(f"orchestrator: {e.message if isinstance(e, ApiError) else e}", file=sys.stderr, flush=True)
        sys.exit(1)
    threading.Thread(target=hub.run_snapshots, daemon=True).start()
    threading.Thread(target=poller.run, daemon=True).start()
    server = Server((HOST, PORT), Handler)
    print(f"orchestrator: http://{HOST}:{PORT} (data in {HOME}; new tasks branch from "
          f"{store.context['base']} in {store.context['checkout']})", file=sys.stderr, flush=True)
    signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
