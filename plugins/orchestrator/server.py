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
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import beads_store as beads
import detach
import lease
import screen
from cmux import cmux_config, ghostty_cli, terminal_appearance
from gitops import (base_ref, checkout_info, default_branch, drop_missing_worktrees, find_worktree, git_toplevel,
                    has_ref, merge_base, prepare_branch, unmerged_files)
from integrations import PACKAGE_ROOT, terminals
from runtime import ANSI, child_env, now_iso, plain, run, same_dir, tail, which, within, write_atomic

ROOT = Path(__file__).resolve().parent
HOME = Path(os.environ.get("ORCHESTRATOR_HOME", "~/.orchestrator")).expanduser()
TASKS_DIR = HOME / "tasks"
HOST = "127.0.0.1"
PORT = int(os.environ.get("ORCHESTRATOR_PORT", "4747"))
BRANCH_PREFIX = os.environ.get("ORCHESTRATOR_BRANCH_PREFIX", "feature/")
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
RESUME_GRACE = float(os.environ.get("ORCHESTRATOR_RESUME_GRACE", "180"))
RESUME_TEXT = "Orchestrator moved {id} back to In Progress: continue where you stopped."
INTENT_BACKOFF = (2.0, 5.0, 15.0, 60.0)
INTENT_ATTEMPTS = 4
INTENT_WAIT = 15.0
MERGE_WAIT = 600.0
SCREEN_LINES = 500
BEADS_BACKOFF = (5.0, 15.0, 60.0)
VERB = {"start": "starting", "resume": "resuming", "stop": "stopping", "merge": "merging",
        "remove": "removing its worktree", "delete": "being deleted"}
PLANNING_MODES = {"auto", "plan", "fast"}
LOOP_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
CONTROL_VIEW_LIMIT = 262_144
CONTROL_LOOPS_LIMIT = 200_000
SPAWN_LOG_LIMIT = 6000
PRESENTATION_INTERVAL = 30.0
SWEEP_INTERVAL = 60.0
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
        # Errors reach people and agents, who know cards by number.
        self.message = with_numbers(message)
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
    for candidate in (os.environ.get("ORCHESTRATOR_REPO"), os.getcwd()):
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
    return {"ORCHESTRATOR_TASK": t["id"], "ORCHESTRATOR_REPO": t["repo"], "ORCHESTRATOR_BRANCH": t["branch"],
            "ORCHESTRATOR_BASE": t["base"], "ORCHESTRATOR_WORKTREE": worktree}


# --- event hub ------------------------------------------------------------------

def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


class Hub:
    """Fans server-sent events out to every connected board and omp session; snapshots are coalesced. A task's omp session
    also takes commands (pause, message, plan review, stop) and answers each one."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.subscribers: Dict["queue.Queue[str]", Dict[str, Any]] = {}
        self.dirty = threading.Event()
        self.answers: Dict[str, Dict[str, Any]] = {}

    def subscribe(self, meta: Dict[str, Any]) -> "queue.Queue[str]":
        """`meta`: the stream's session, flow, task (a task's own session) and validated terminal context (each optional)."""
        q: "queue.Queue[str]" = queue.Queue(maxsize=2000)
        with self.lock:
            self.subscribers[q] = {**meta, "at": time.time()}
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

    def task_meta(self, task_id: str) -> Optional[Dict[str, Any]]:
        """The meta of the omp session stream that connected last for `task_id`; None without one."""
        with self.lock:
            q = self.task_stream(task_id)
            return dict(self.subscribers[q]) if q is not None else None

    def task_live(self, task_id: str) -> bool:
        return self.task_meta(task_id) is not None

    def session_terminal(self, session: str) -> Optional[Dict[str, Any]]:
        """The terminal context of `session`'s most recently connected stream."""
        with self.lock:
            streams = sorted((m for m in self.subscribers.values() if m.get("session") == session and m.get("terminal")),
                             key=lambda m: m["at"], reverse=True)
        return streams[0]["terminal"] if streams else None

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

    def answer(self, cid: str, ok: bool, message: str) -> bool:
        """Delivers a session's answer to command `cid`; False when nothing waits for it."""
        with self.lock:
            answer = self.answers.pop(cid, None)
        if not answer:
            return False
        answer.update(ok=ok, message=message)
        answer["done"].set()
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
        self.activity: Dict[str, Dict[str, Any]] = {}
        self.facts: Dict[str, Dict[str, Any]] = {}
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
        self.sweep_hosts()

    def sweep_hosts(self) -> None:
        """Removes the directory an older board's agent host left for an external agent, once that agent is gone."""
        with self.lock:
            hosted = [t for t in self.tasks.values() if (t.get("execution") or {}).get("kind") == "external"
                      and t["execution"].get("dir")]
        for t in hosted:
            ex = t["execution"]
            if not detach.pid_alive(ex.get("pid"), ex.get("pidStarted")):
                shutil.rmtree(ex["dir"], ignore_errors=True)
                with self.lock:
                    ex["dir"] = None
                    self.write_record(t)

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
        if t["spawn"].get("state") == "running" and not t.get("intent"):
            t["intent"] = beads.new_intent("start", {})
            upgraded = True
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
        t["loop"] = t["loop"] if isinstance(t.get("loop"), str) and LOOP_ID.fullmatch(t["loop"]) else None
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
        # A column change waiting to reach Beads is retried by the poller, not written again here.
        pending_column = (t.get("beadsPending") or {}).get("column") == t["column"]
        if pending_column:
            kept.pop("column", None)
        if not (kept or moved or plan_changed or any(beads.differs(k, t.get(k), f.get(k)) for k in beads.FIELDS
                                                     if not (pending_column and k == "column"))):
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
        """Writes the runtime record and the fields the board changed to the bead. A column change Beads doesn't take now
        stays recorded as beadsPending for the poller to retry; any other failed field reverts and raises."""
        task_id = t["id"]
        changes = [k for k in beads.FIELDS if beads.differs(k, t.get(k), self.seen[task_id].get(k))]
        t["updatedAt"] = now_iso()
        if "column" not in changes:
            t["beadsPending"] = None
        elif (t.get("beadsPending") or {}).get("column") == t["column"]:
            # Already waiting for Beads: the poller retries it, so a slow Beads doesn't hold up every later save.
            changes.remove("column")
        else:
            t["beadsPending"] = {"column": t["column"]}
            self.write_record(t)
        if changes:
            try:
                self.push(t, changes)
            except beads.BeadsError as e:
                if changes != ["column"]:
                    for key in changes:
                        if key != "column":
                            t[key] = copy.deepcopy(self.seen[task_id].get(key))
                    self.write_record(t)
                    raise beads_api_error(e)
                print(f"orchestrator: {task_id}'s column reaches Beads later: {e}", file=sys.stderr)
                return
            if "column" in changes:
                t["beadsPending"] = None
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
            args += ["--metadata", json.dumps({beads.METADATA_KEY: config})]
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
                seen["metadata"] = {**seen["metadata"], beads.METADATA_KEY: config}
        for dep in [d for d in want if d not in seen["dependsOn"]]:
            self.workspace.add_dep(task_id, dep)
            seen["dependsOn"] = seen["dependsOn"] + [dep]
        if fingerprint is not None and fingerprint == self.synced:
            # Only the board's own write changed Beads since the last read: the next sync needn't list it again.
            self.synced = self.workspace.fingerprint()

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
        self.facts.pop(task_id, None)
        self.native_blocked.pop(task_id, None)
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
        running = (self.facts.get(t["id"]) or {}).get("agent_running", False)
        ex = t.get("execution") or {}
        intent = t.get("intent")
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
            "loop": t.get("loop"),
            "control": t.get("control"),
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
            "number": task_number(t),
            "intent": {k: intent.get(k) for k in ("op", "stage", "at", "attempt", "lastError")} if intent else None,
            "lastOperation": t.get("lastOperation"),
            "syncPending": bool(t.get("beadsPending")),
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
            "execution": execution_view(t, connected, running),
            "session": session_view(t, connected),
            "attachCommand": detach.attach_command(ex) if ex.get("kind") == "tmux" and running else None,
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

        def entry(repo: str, base: str, checkout: Optional[str], concurrency_limit: Optional[int] = None,
                  control_loops: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
            fid = flow_id(repo, base)
            if fid not in flows:
                flows[fid] = {"id": fid, "name": os.path.basename(repo), "repo": repo, "base": base, "checkout": checkout,
                              "counts": {c: 0 for c in COLUMN_IDS}, "live": hub.flow_live(fid),
                              "concurrencyLimit": concurrency_limit, "controlLoops": control_loops}
            return flows[fid]

        checked: Dict[Tuple[str, Optional[str]], bool] = {}

        def active(repo: str, base: str, checkout: Optional[str]) -> bool:
            fid = flow_id(repo, base)
            if (fid, checkout) not in checked:
                checked[(fid, checkout)] = checkout_exists(checkout) or hub.flow_live(fid)
            return checked[(fid, checkout)]

        for f in self.flows:
            if active(f["repo"], f["base"], f["checkout"]):
                entry(f["repo"], f["base"], f["checkout"], f.get("concurrencyLimit"), f.get("controlLoops"))
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


# A card id in prose; one inside a path or name (tasks/KB-1, orch-KB-1) stays as it is.
TASK_REF = re.compile(r"(?<![\w/-])KB-\d+(?:\.\d+)*\b")


def task_number(t: Dict[str, Any]) -> str:
    """The number people know a card by, counted per project: a child's is its parent's with its place under it, a card
    created since numbering went per project keeps the one it got, an older one the number in its Beads id."""
    parent = store.tasks.get(t.get("parent") or "")
    if parent and t["id"].startswith(parent["id"] + "."):
        return task_number(parent) + t["id"][len(parent["id"]):]
    if t.get("number"):
        return str(t["number"])
    return t["id"][3:] if TASK_REF.fullmatch(t["id"]) else t["id"]


def label(task_id: str) -> str:
    return f"#{task_number(store.tasks[task_id])}" if task_id in store.tasks else task_id


def with_numbers(text: str) -> str:
    """`text` with each card's Beads id replaced by its number (reads store.tasks without its lock, as errors can be raised
    under other locks)."""
    return TASK_REF.sub(lambda m: label(m[0]), text) if "store" in globals() else text


def next_number(repo: str) -> int:
    """One past the highest card number in the project at `repo`; its first card is 1 (call under store.lock)."""
    numbers = [int(n) for c in store.tasks.values() if same_dir(c["repo"], repo) for n in [task_number(c)] if n.isdigit()]
    return max(numbers, default=0) + 1


def has_started(t: Dict[str, Any]) -> bool:
    return spawned(t) or bool(t.get("merged")) or t.get("spawn", {}).get("state") in ("running", "done")


def paused(t: Dict[str, Any]) -> bool:
    """A started task in Todo or Backlog: its worktree and omp session stay, but its agent is stopped and holds no slot."""
    return spawned(t) and t["column"] in PAUSED_COLUMNS and not t.get("merged") \
        and (t.get("intent") or {}).get("op") != "start"


def worktree_missing(t: Dict[str, Any]) -> bool:
    """An unfinished started task whose recorded worktree was deleted outside the board: its agent can't resume there."""
    return spawned(t) and not t.get("merged") and t["column"] != "done" and not Path(t["worktree"]).is_dir()


def observe(t: Dict[str, Any]) -> Dict[str, Any]:
    """What runs for a task now, from its execution record and the system: its tmux session, whether its agent's process
    runs (its omp session lease, a live tmux pane, or an external agent's own process) and its newest omp stream, which
    talks to the agent but never decides whether it runs (call without store.lock)."""
    ex = t.get("execution") or {}
    session_id = (ex.get("session") or {}).get("id")
    tmux = detach.status(ex) if ex.get("kind") == "tmux" else None
    if tmux is not None:
        running = (tmux["exists"] and not tmux["dead"]) or lease.held(session_id)
    elif ex.get("kind") == "external":
        running = lease.held(session_id) or detach.pid_alive(ex.get("pid"), ex.get("pidStarted"))
    else:
        running = False
    return {"worktree_present": bool(t.get("worktree")) and Path(t["worktree"]).is_dir(), "tmux": tmux,
            "agent_running": running, "stream": hub.task_meta(t["id"])}


def refresh_facts(task_id: str) -> Dict[str, Any]:
    """Observes a task now and keeps it for its view, after something started or stopped its agent."""
    with store.lock:
        t = copy.deepcopy(store.tasks.get(task_id))
    if not t:
        return {"worktree_present": False, "tmux": None, "agent_running": False, "stream": None}
    facts = observe(t)
    with store.lock:
        if task_id in store.tasks:
            store.facts[task_id] = facts
    hub.changed()
    return facts


def execution_view(t: Dict[str, Any], connected: bool, running: bool) -> Optional[Dict[str, Any]]:
    ex = t.get("execution")
    if not ex:
        return None
    return {"kind": ex.get("kind"), "state": "running" if connected or running else "stopped",
            "exitCode": ex.get("exitCode")}


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
    queued = paused(t) or (not spawned(t) and t["spawn"]["state"] == "none")
    return t["column"] == "todo" and queued and not t.get("intent") and not blocked_by(t) and not has_task_slot(t)


def move_requires_confirmation(t: Dict[str, Any]) -> bool:
    state = (t.get("agent") or {}).get("state")
    return t["column"] == "doing" or state in MOVE_GUARDED_AGENT_STATES


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


def validate_loop(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not LOOP_ID.fullmatch(value):
        raise ApiError(400, "Loop must be a control loop id: lowercase letters, digits and dashes")
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
    loop = validate_loop(body.get("loop"))
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
            "merge": None, "planningMode": planning_mode, "planningOutcome": None, "loop": loop,
            "dependsOn": [], "parent": None, "merged": None, "origin": origin,
        }
        if info:
            t.update(info)
        elif isinstance(body.get("parent"), str) and body["parent"] in store.tasks:
            p = store.tasks[body["parent"]]
            t.update(repo=p["repo"], checkout=p.get("checkout") or p["repo"], base=p["base"])
        owner = next((o for o in store.tasks.values() if same_dir(o.get("worktree"), t["checkout"])), None)
        if owner:
            t.update(repo=owner["repo"], checkout=owner.get("checkout") or owner["repo"], base=owner["base"])
        t["parent"] = validate_parent("", body.get("parent"), t["repo"], t["base"], [])
        deps = body.get("dependsOn") if "dependsOn" in body else ([owner["id"]] if owner else [])
        t["dependsOn"] = validate_deps("", deps or [], t["repo"], t["base"], t["parent"])
        t["merge"] = validate_merge(body["merge"]) if "merge" in body else default_merge(t)
        t["branch"] = store.suggest_branch(t)
        t["number"] = None if t["parent"] else next_number(t["repo"])
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
        registered = {**info, "concurrencyLimit": (previous or {}).get("concurrencyLimit"),
                      "controlLoops": (previous or {}).get("controlLoops")}
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
                      "concurrencyLimit": limit, "controlLoops": flow.get("controlLoops")}
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


SHORTSTAT = re.compile(r"(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?")
EXPORTS_DIR = HOME / "exports"
EXPORT_NAME = re.compile(r"[A-Za-z0-9._-]+\.html")
OMP_SESSIONS = Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".omp" / "agent") / "sessions"
IDLE_AFTER = 300


def merge_stats(repo: str, sha: str) -> Optional[Dict[str, int]]:
    """What a task's merge commit brought into its base: files, lines added and removed, and the task's commits."""
    code, out, _ = run(["git", "-C", repo, "rev-list", "--parents", "-n", "1", sha], timeout=15)
    parents = out.split()[1:] if code == 0 else []
    if len(parents) != 2:
        return None
    code, out, _ = run(["git", "-C", repo, "diff", "--shortstat", parents[0], sha], timeout=30)
    if code != 0:
        return None
    m = SHORTSTAT.search(out)
    code, count, _ = run(["git", "-C", repo, "rev-list", "--count", f"{parents[0]}..{parents[1]}"], timeout=15)
    return {"files": int(m[1]) if m else 0, "added": int(m[2] or 0) if m else 0, "removed": int(m[3] or 0) if m else 0,
            "commits": int(count) if code == 0 and count.strip().isdigit() else None}


def epoch(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def stamp(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def column_changes(task_id: str, created: Optional[str]) -> List[Dict[str, str]]:
    """The columns a task moved through with when, oldest first, from its bead's audit events."""
    changes: List[Dict[str, str]] = []
    for event in reversed(store.workspace.history(task_id, 500, True) or []):
        try:
            old, new = (json.loads(event.get(k) or "null") for k in ("old_value", "new_value"))
        except ValueError:
            continue
        if not isinstance(new, dict) or not new.get("status") or not event.get("created_at"):
            continue
        if not changes and created and isinstance(old, dict) and old.get("status"):
            changes.append({"at": created, "column": beads.column_for(old["status"])})
        changes.append({"at": event["created_at"], "column": beads.column_for(new["status"])})
    return changes


def agent_activity(branch: str, folders: List[Path], since: float, until: float) -> List[List[str]]:
    """When an agent worked on `branch`: its omp sessions' messages (omp names a session folder after its directory, which
    ends with the branch), merged into stretches that end after five minutes without one."""
    suffix = "-" + branch.replace("/", "-")
    times: List[float] = []
    for folder in folders:
        if not folder.name.rstrip("-").endswith(suffix):
            continue
        for path in folder.glob("*.jsonl"):
            if path.stat().st_mtime < since:
                continue
            with path.open(encoding="utf-8", errors="replace") as lines:
                for line in lines:
                    if '"type":"message"' not in line:
                        continue
                    try:
                        entry = json.loads(line)
                        at = epoch(entry["timestamp"])
                    except (ValueError, KeyError, TypeError):
                        continue
                    if since <= at <= until and (entry.get("message") or {}).get("role") in ("user", "assistant", "toolResult"):
                        times.append(at)
    spans: List[List[float]] = []
    for at in sorted(times):
        if spans and at - spans[-1][1] <= IDLE_AFTER:
            spans[-1][1] = at
        else:
            spans.append([at, at])
    return [[stamp(a), stamp(b)] for a, b in spans]


def flow_recap(body: Dict[str, Any]) -> Dict[str, Any]:
    """Per-task facts for a saved flow page: column changes, times and outcome notes from Beads, merge-commit stats from git,
    and when agents worked from the tasks' omp sessions."""
    flow = body.get("flow")
    with store.lock:
        tasks = [{"id": t["id"], "repo": t["repo"], "branch": t["branch"], "merged": t.get("merged") or {}}
                 for t in store.tasks.values() if flow_id(t["repo"], t["base"]) == flow]
    if not tasks:
        raise ApiError(404, f"No tasks in flow {flow}")
    folders = [p for p in OMP_SESSIONS.iterdir() if p.is_dir()] if OMP_SESSIONS.is_dir() else []

    def facts(t: Dict[str, Any], bead: Dict[str, Any], columns: List[Dict[str, str]]) -> Dict[str, Any]:
        began = next((c["at"] for c in columns if c["column"] in ("todo", "doing")), None) or bead.get("started_at")
        ended = bead.get("closed_at") or t["merged"].get("at")
        outcomes = [e["text"] for e in context_entries(bead.get("notes") or "") if e["kind"] == "outcome"]
        return {"startedAt": bead.get("started_at"), "closedAt": bead.get("closed_at"), "columns": columns,
                "activity": agent_activity(t["branch"], folders, epoch(began), epoch(ended) if ended else time.time()) if began else [],
                "outcome": "\n\n".join(outcomes) or None,
                "merge": merge_stats(t["repo"], t["merged"]["sha"]) if t["merged"].get("sha") else None}

    try:
        listed = {b["id"]: b for b in store.workspace.list_all() if b.get("id")}
        # One bd call at a time: concurrent calls only queue on the Beads database, delaying the board's own reads.
        columns = [column_changes(t["id"], (listed.get(t["id"]) or {}).get("created_at")) for t in tasks]
    except beads.BeadsError as e:
        raise beads_api_error(e)
    with ThreadPoolExecutor(max_workers=4) as pool:
        found = list(pool.map(lambda t, c: facts(t, listed.get(t["id"]) or {}, c), tasks, columns))
    return {"tasks": {t["id"]: f for t, f in zip(tasks, found)}}


def save_export(body: Dict[str, Any]) -> Dict[str, Any]:
    """Writes a saved flow page into the exports folder; the board serves it at /exports/<name>."""
    flow, page = body.get("flow"), body.get("html")
    if not isinstance(flow, str) or not flow.strip() or not isinstance(page, str) or not page.startswith("<!doctype html>"):
        raise ApiError(400, "Send the flow and its page")
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", flow).strip("-.") + time.strftime("-%Y-%m-%d-%H%M") + ".html"
    path = EXPORTS_DIR / name
    write_atomic(path, page)
    home = str(Path.home())
    shown = "~" + str(path)[len(home):] if str(path).startswith(home + os.sep) else str(path)
    return {"path": shown, "url": f"/exports/{name}"}


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
            if "loop" in body:
                if has_started(t):
                    raise ApiError(409, "Control loop is fixed once the task starts")
                t["loop"] = validate_loop(body["loop"])
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


def delete_task(task_id: str, body: Dict[str, Any]) -> Any:
    """Deletes a card. With cleanup, a started task's agent stops and its worktree goes first (the removeWorktree command
    or teardown script), as a delete intent the card waits for; without, a running agent keeps running."""
    requester = request_terminal(body)
    with store.lock:
        t = store.get(task_id)
        if move_requires_confirmation(t) and body.get("confirmWorking") is not True:
            raise ApiError(409, f"{task_id} may still be working; confirm before deleting it",
                           {"requiresConfirmation": "workingTask"})
        removing = body.get("cleanup") is True and spawned(t)
        pending = t.get("intent")
        if not removing and pending and pending["op"] != "stop":
            raise ApiError(409, f"{label(task_id)} is still {VERB[pending['op']]}")
        path, ex = t.get("worktree"), dict(t.get("execution") or {})
    if removing:
        refuse_dirty_removal(path)
        with store.lock:
            intent = set_intent(store.get(task_id), "delete", {"requester": requester})
        await_intent(task_id, intent["id"], INTENT_WAIT)
        with store.lock:
            t = store.tasks.get(task_id)
            if t is not None and (t.get("intent") or {}).get("id") != intent["id"]:
                last = t.get("lastOperation") or {}
                raise ApiError(409, last.get("error") or f"{label(task_id)} wasn't deleted",
                               {"output": last.get("output") or ""})
        after_reply(lambda: replied_or_close(task_id, path, requester))
        if t is not None:
            return 202, {"ok": True, "pending": True,
                         "message": f"{label(task_id)} is still stopping; the card is deleted once its worktree is gone"}
        return {"ok": True, "output": DELETED_OUTPUT.pop(intent["id"], "")}
    note = None
    if ex.get("kind") == "tmux" and detach.alive(ex):
        note = f"Its agent keeps running; attach with {detach.attach_command(ex)}"
    with store.lock:
        store.get(task_id)
        store.delete(task_id)
    hub.changed()
    return {"ok": True, "output": "", **({"note": note} if note else {})}


def start_task(t: Dict[str, Any]) -> None:
    """Starts a task: it shows as starting in Todo while its start intent sets up its worktree and agent (call under
    store.lock)."""
    t["column"] = "todo"
    t["spawn"] = {"state": "running", "error": None, "log": ""}
    t["planningOutcome"] = t["planningMode"] if t["planningMode"] in ("plan", "fast") else None
    set_intent(t, "start", {})


def move_task(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Moves a card. Starting it, or bringing a started card In Progress, needs a free task slot. A started card moved to
    Todo or Backlog pauses: its agent is interrupted and frees its slot; Todo resumes it on its turn, Backlog parks it.
    In Progress resumes a paused or stopped agent. A card can't change column while an operation on it runs, except a
    resume that a pause turns into a stop."""
    column = body.get("column")
    if column not in COLUMN_IDS:
        raise ApiError(400, f"Unknown column {column!r}")
    with store.lock:
        before = copy.deepcopy(store.get(task_id))
    facts = observe(before) if spawned(before) else None
    with store.lock:
        t = store.get(task_id)
        original = copy.deepcopy(t)
        pending = t.get("intent")
        if pending and column != t["column"] and (pending["op"] in ("start", "merge", "remove", "delete")
                                                  or (pending["op"] == "stop" and column == "doing")):
            raise ApiError(409, f"{label(task_id)} is still {VERB[pending['op']]}")
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
        running = bool(facts and facts["agent_running"])
        resume = column == "doing" and spawned(t) and not t.get("merged") and (was_paused or not running)
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
        try:
            if start:
                start_task(t)
            elif resume:
                set_intent(t, "resume", {})
            elif pause and pending and pending["op"] == "resume":
                set_intent(t, "stop", {})
                pause = False
            else:
                store.save(t)
        except ApiError:
            t.clear()
            t.update(original)
            raise
        hub.changed()
        snapshot, view = dict(t), store.view(t)
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


# --- intents ------------------------------------------------------------------------

# A step's outcome: ("next", None) once it moved to its next stage, ("wait", None) until a fact changes, ("retry", error)
# after a transient failure, ("fail", error) to give up, ("chained", output) once it replaced its intent with the next
# operation, ("finished", None) once it finished its intent itself.
Outcome = Tuple[str, Optional[str]]
REPLACEABLE = {("stop", "remove"), ("stop", "delete"), ("remove", "delete"), ("resume", "stop")}
RUNNING_INTENTS: set = set()  # tasks whose intent a worker drives now (under store.lock)
DRAINING = threading.Event()  # set once the board stops: no new worker starts
WAIT_POLL = 0.25
WAIT_SPAN = 2.0


def set_intent(t: Dict[str, Any], op: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """Records an operation for the reconciler to drive to its end (call under store.lock). A pending stop gives way to a
    removal or delete, a removal to a delete and a resume to a stop; the same operation pending is returned as it is;
    any other is refused while one runs."""
    pending = t.get("intent")
    if pending:
        if pending["op"] == op:
            return pending
        if (pending["op"], op) not in REPLACEABLE:
            raise ApiError(409, f"{label(t['id'])} is still {VERB[pending['op']]}")
    intent = beads.new_intent(op, params)
    t["intent"], t["lastOperation"] = intent, None
    store.save(t)
    hub.changed()
    poller.kick()
    return intent


def progress(task_id: str, intent_id: str, stage: Optional[str] = None, log: str = "",
             params: Optional[Dict[str, Any]] = None, **fields: Any) -> bool:
    """Records a worker's progress on its intent: its next stage, log, params and task fields; False when the intent was
    replaced or finished meanwhile."""
    with store.lock:
        t = store.tasks.get(task_id)
        intent = (t or {}).get("intent")
        if not t or not intent or intent["id"] != intent_id:
            return False
        if stage is not None:
            intent.update(stage=stage, attempt=0, retryAt=None, lastError=None)
        if log:
            intent["log"] = tail(intent["log"] + log, SPAWN_LOG_LIMIT)
        if params:
            intent["params"].update(params)
        t.update(fields)
        if fields:
            store.save(t)
        else:
            store.write_record(t)
    hub.changed()
    return True


def finish_intent(task_id: str, intent_id: str, ok: bool, output: str = "", error: Optional[str] = None,
                  next_intent: Optional[Dict[str, Any]] = None,
                  apply: Optional[Callable[[Dict[str, Any]], None]] = None) -> bool:
    """Ends an intent: `apply` updates the task, lastOperation records the result and `next_intent` (if any) follows."""
    with store.lock:
        t = store.tasks.get(task_id)
        intent = (t or {}).get("intent")
        if not t or not intent or intent["id"] != intent_id:
            return False
        if apply:
            apply(t)
        t["lastOperation"] = {"op": intent["op"], "at": now_iso(), "ok": ok, "error": error,
                              "output": tail(output, SPAWN_LOG_LIMIT)}
        t["intent"] = next_intent
        store.save(t)
    hub.changed()
    poller.kick()
    return True


def await_intent(task_id: str, intent_id: str, timeout: float) -> None:
    """Waits until a task's intent ended or was replaced, or `timeout` passes."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with store.lock:
            t = store.tasks.get(task_id)
            if not t or (t.get("intent") or {}).get("id") != intent_id:
                return
        time.sleep(0.1)


def retry_intent(task_id: str, intent: Dict[str, Any], error: str) -> None:
    """Backs an intent off after a transient failure; it fails once INTENT_ATTEMPTS ran out."""
    attempt = intent["attempt"] + 1
    if attempt >= INTENT_ATTEMPTS:
        fail_intent(task_id, intent, error)
        return
    with store.lock:
        t = store.tasks.get(task_id)
        current = (t or {}).get("intent")
        if not current or current["id"] != intent["id"]:
            return
        current.update(attempt=attempt, retryAt=time.time() + INTENT_BACKOFF[attempt - 1], lastError=error)
        store.write_record(t)
    print(f"orchestrator: {label(task_id)} {VERB[intent['op']]}, retrying: {error}", file=sys.stderr)
    hub.changed()


def fail_intent(task_id: str, intent: Dict[str, Any], error: str) -> None:
    """Gives an intent up: a start shows as failed, a resume parks its card in Backlog."""
    def failed(current: Dict[str, Any]) -> None:
        if intent["op"] == "start":
            current["spawn"] = {"state": "failed", "error": error,
                                "log": tail(current["intent"]["log"] + error, SPAWN_LOG_LIMIT)}
        elif intent["op"] == "resume":
            current["resumedAt"] = None
            if current["column"] == "doing":
                current["column"], current["order"] = "backlog", store.next_order("backlog")
    with store.lock:
        log = ((store.tasks.get(task_id) or {}).get("intent") or {}).get("log") or ""
    if finish_intent(task_id, intent["id"], False, output=log, error=error, apply=failed):
        print(f"orchestrator: {label(task_id)} gave up {VERB[intent['op']]}: {error}", file=sys.stderr)


def run_intent(task_id: str) -> None:
    """A worker: drives a task's intent stage by stage until it ends, waits on a fact for a while, or backs off."""
    waited = 0.0
    try:
        while True:
            with store.lock:
                t = store.tasks.get(task_id)
                intent = copy.deepcopy((t or {}).get("intent"))
                if not t or not intent:
                    return
                snapshot = copy.deepcopy(t)
            try:
                outcome, text = STEPS[intent["op"]](snapshot, intent)
            except Exception as e:
                outcome, text = "retry", error_text(e) if isinstance(e, ApiError) else repr(e)
            if outcome == "wait":
                if waited >= WAIT_SPAN or DRAINING.is_set():
                    return
                time.sleep(WAIT_POLL)
                waited += WAIT_POLL
                continue
            waited = 0.0
            if outcome == "retry":
                retry_intent(task_id, intent, text or "failed")
                return
            if outcome == "fail":
                fail_intent(task_id, intent, text or "failed")
                return
    finally:
        with store.lock:
            RUNNING_INTENTS.discard(task_id)
        hub.changed()


# --- worktree + agent ---------------------------------------------------------------

def write_brief(t: Dict[str, Any], name: str, handoffs: List[Dict[str, Any]]) -> Path:
    lines = [f"# Task {task_number(t)}: {t['title']}", ""]
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
    write_atomic(path, with_numbers("\n".join(lines)))
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
        approach = (f"Plan the task in the attached brief ({label(t['id'])}) before changing any file: explore the code, then "
                    "propose the plan with xd://propose for my review; once I approve it, implement it.")
    elif t["planningMode"] == "fast":
        approach = (f"Implement the straightforward task in the attached brief ({label(t['id'])}) directly. Read enough to make "
                    "the change safely, but do not request plan review unless I explicitly ask for one.")
    else:
        approach = (f"Briefly triage the task in the attached brief ({label(t['id'])}) before changing any file. Inspect only "
                    "enough to decide the route: if the implementation and acceptance are clear, implement immediately "
                    "without plan review; if you find a product decision, unclear acceptance, architectural or migration "
                    "impact, or meaningful cross-cutting risk, propose a plan with xd://propose and wait for my review. "
                    "Keep this triage brief; it is not a planning phase.")
    draft = " The brief has a draft plan: use it as context and update it to the code as it is now." if t.get("plan") else ""
    prompt = (f"{approach}{draft} You are in a dedicated git worktree on branch {t['branch']}; follow the repository's "
              f"conventions. {finish}Ask me if anything in the brief is unclear.")
    return ["--config", str(config), "@" + str(brief), prompt]


def resume_args(t: Dict[str, Any]) -> List[str]:
    """omp's arguments to bring a task's agent back: its recorded session, restored to what its last process left
    unfinished unless that process exited cleanly; else the worktree's latest session."""
    ex = t.get("execution") or {}
    session = ex.get("session") or {}
    flag = "--resume" if ex.get("cleanExit") else "--restore"
    if session.get("file") and Path(session["file"]).is_file():
        return [flag, session["file"]]
    if session.get("id"):
        return [flag, session["id"]]
    return ["--continue"]


def agent_script(t: Dict[str, Any], name: str, args: List[str], resume: bool = False) -> Path:
    """Writes the script a task's tmux session runs: the task's environment, then omp with `args`. A resumed agent's
    omp finds the message it continues with in ORCHESTRATOR_RESUME_FILE."""
    omp = which("omp")
    if not omp:
        raise RuntimeError("omp isn't on the board's PATH")
    task_dir = store.task_dir(t["id"])
    env = [("ORCHESTRATOR_TASK", t["id"]), ("ORCHESTRATOR_PORT", str(PORT)), ("ORCHESTRATOR_HOME", str(HOME)),
           ("ORCHESTRATOR_PLANNING_MODE", t["planningMode"]), ("COLORTERM", "truecolor"),
           ("OMP_TERMINAL_PRESENTER", str(task_dir / "presenter.json"))]
    if os.environ.get("ORCHESTRATOR_LEASE_DIR"):
        env.append(("ORCHESTRATOR_LEASE_DIR", os.environ["ORCHESTRATOR_LEASE_DIR"]))
    if resume:
        env.append(("ORCHESTRATOR_RESUME_FILE", str(task_dir / "resume.json")))
    if t.get("loop"):
        env += [("OMP_CONTROL_LOOP", t["loop"]), ("OMP_CONTROL_BASE", t["base"])]
    exports = " ".join(f"{k}={shlex.quote(v)}" for k, v in env)
    path = task_dir / name
    write_atomic(path, f"#!/bin/sh\nexport {exports}\nexec {shlex.join([omp, *args])}\n")
    return path


def write_presenter(task_id: str, presentation: Optional[Dict[str, Any]]) -> None:
    """Names the cmux terminal showing a task's agent for its omp (OMP_TERMINAL_PRESENTER), which has no terminal of its
    own: a page it opens goes to that cmux workspace."""
    part = (presentation or {}).get("cmux") or {}
    env = {k: part[key] for k, key in (("CMUX_WORKSPACE_ID", "workspace"), ("CMUX_SURFACE_ID", "surface"),
                                       ("CMUX_SOCKET_PATH", "socket"), ("CMUX_BUNDLED_CLI_PATH", "cli")) if part.get(key)}
    write_atomic(store.task_dir(task_id) / "presenter.json", json.dumps({"env": env}))


def detach_mode() -> str:
    """Where agents run (config.json's detach): auto (cmux's local-tmux in a cmux terminal, else the board's tmux), tmux or
    cmux."""
    mode = read_config().get("detach", "auto")
    if mode not in detach.MODES:
        raise ApiError(500, f"Invalid {CONFIG_FILE}: detach must be auto, tmux or cmux")
    return mode


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


def worktree_hook(t: Dict[str, Any], ex: Dict[str, Any], command: str, script: Path) -> Tuple[int, str, str]:
    """Runs the createWorktree hook for a task; the terminal it opens runs a launcher that starts the agent's tmux session
    with `script` unless it runs, then shows it. Returns (exit code, output, failure message)."""
    launcher = store.task_dir(t["id"]) / "agent.sh"
    detach.write_launcher(launcher, ex, script)
    setup = project_scripts(os.path.basename(t["repo"]))["setupScript"]
    env = {"ORCHESTRATOR_TASK": t["id"], "ORCHESTRATOR_TITLE": t["title"], "ORCHESTRATOR_REPO": t["repo"],
           "ORCHESTRATOR_BRANCH": t["branch"], "ORCHESTRATOR_BASE": t["base"],
           "ORCHESTRATOR_AGENT_COMMAND": f"/bin/sh {shlex.quote(str(launcher))}",
           "ORCHESTRATOR_SETUP_SCRIPT": os.path.expanduser(setup)}
    return run_hook("createWorktree", command, t["repo"], 900, env)


def checkout(t: Dict[str, Any], ex: Dict[str, Any], script: Path) -> Tuple[str, str, bool]:
    """Checks the task branch out in a worktree: the createWorktree hook when configured (worktree_hook), else a built-in
    worktree and the setup script. Returns (path, log, whether the hook ran)."""
    repo, branch = t["repo"], t["branch"]
    hook_command = hook("createWorktree")
    if hook_command:
        dropped = drop_missing_worktrees(repo, branch)
        code, log, error = worktree_hook(t, ex, hook_command, script)
        log = dropped + log
        path = find_worktree(repo, branch)
        if code != 0:
            # A hook failing after its terminal started the agent (e.g. in a later sidebar step) leaves a real agent: adopt
            # it rather than report a failure whose retry would start a second one; else no late launcher may start one.
            if not detach.alive(ex):
                (store.task_dir(t["id"]) / "agent.sh").unlink(missing_ok=True)
                raise RuntimeError(error)
            path = path or detach.cwd(ex)
            log += f"createWorktree failed after its terminal started the agent; adopted it: {error}\n"
        if not path:
            raise RuntimeError("createWorktree finished but the branch has no worktree")
        return path, log, True
    setup = project_scripts(os.path.basename(repo))["setupScript"]
    path, log, created = builtin_worktree(repo, branch)
    if created and setup:
        log += run_script("Setup script", setup, path, 900, script_env(t, path))
    return path, log, False


def external_execution(session: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The record of an agent the board doesn't run in tmux: an omp started by hand, or by a createWorktree hook."""
    return {"kind": "external", "pid": None, "pidStarted": None, "dir": None, "session": session, "cleanExit": False}


def step_start(t: Dict[str, Any], intent: Dict[str, Any]) -> Outcome:
    """Starts a task's agent: its brief and scripts, its worktree (reused, else checked out by the createWorktree hook or
    the board), its tmux session, then the terminal showing it. A started agent or connected omp is adopted, never
    doubled."""
    task_id, iid, stage = t["id"], intent["id"], intent["stage"]
    repo, branch, base = t["repo"], t["branch"], t["base"]
    task_dir = store.task_dir(task_id)
    ex = t.get("execution") or {}
    if stage is None:
        handoffs = dependency_handoffs(list(t["dependsOn"]))
        with store.lock:
            current = store.get(task_id)
            brief = write_brief(current, "brief.md", handoffs)
            briefed = briefing(current)
            context = presentation_context(current)
        config = task_dir / "omp.yml"
        write_atomic(config, f"plan:\n  defaultOnStartup: {'true' if t['planningMode'] == 'plan' else 'false'}\n")
        try:
            validate_branch(branch)
            agent_script(t, "launch.sh", start_args(t, brief, config))
            if ex.get("kind") == "tmux" and detach.alive(ex):
                server = {k: ex.get(k) for k in ("server", "label", "socket")}
            else:
                server = detach.choose_server(context, detach_mode())
        except (RuntimeError, ApiError, detach.DetachError) as e:
            return "fail", error_text(e)
        (task_dir / "screen.ans").unlink(missing_ok=True)
        # Recorded before anything can start the agent, so its first stream and reports find their task.
        progress(task_id, iid, stage="worktree", briefed=briefed,
                 execution={"kind": "tmux", **server, "name": detach.session_name(task_id),
                            "script": str(task_dir / "launch.sh"), "session": ex.get("session"), "cleanExit": False,
                            "exitCode": None, "startedAt": now_iso()})
        return "next", None
    if stage == "worktree":
        try:
            if ex.get("kind") == "tmux" and detach.alive(ex):
                path = detach.cwd(ex) or find_worktree(repo, branch)
                log = f"Adopted the agent already running in {path}\n"
            elif hub.task_live(task_id):
                path = find_worktree(repo, branch)
                if not path:
                    return "fail", f"An omp session is connected for {task_id}, but {branch} has no worktree"
                log = "Adopted the omp session already connected for this task\n"
                ex = external_execution(ex.get("session"))
            else:
                path = find_worktree(repo, branch)
                if path:
                    log = f"Reusing the worktree at {path}\n"
                else:
                    log = prepare_branch(repo, branch, base)
                    path, more, hooked = checkout(t, ex, task_dir / "launch.sh")
                    log += more
                    # The hook's own terminal shows the agent: the board opens none beside it.
                    progress(task_id, iid, params={"hooked": hooked})
        except (RuntimeError, ApiError) as e:
            return "fail", error_text(e)
        if not path:
            return "fail", f"{branch} has no worktree"
        progress(task_id, iid, stage="launch", log=log, worktree=path, execution=ex)
        return "next", None
    if stage == "launch":
        if ex.get("kind") == "tmux" and not detach.alive(ex):
            if hub.task_live(task_id):
                progress(task_id, iid, log="createWorktree started an omp the board doesn't run; adopted its session\n",
                         execution=external_execution(ex.get("session")))
            else:
                try:
                    detach.start(ex, t["worktree"], task_dir / "launch.sh")
                except detach.DetachError as e:
                    return "retry", str(e)
        refresh_facts(task_id)
        progress(task_id, iid, stage="present")
        return "next", None
    presentation, note = None, ""
    if ex.get("kind") == "tmux":
        with store.lock:
            context = presentation_context(store.get(task_id))
        if intent["params"].get("hooked"):
            # The hook's own terminal runs the launcher, which attaches to the session.
            presentation = terminals.find_terminal(context, t["worktree"])
        else:
            presentation, shown = show_agent(t, context, ex, t.get("presentation"), focus=False)
            note = f"{shown}\n" if shown else ""
        write_presenter(task_id, presentation)

    def started(current: Dict[str, Any]) -> None:
        current["presentation"] = presentation
        current["spawn"] = {"state": "done", "error": None, "log": tail(intent["log"] + note, SPAWN_LOG_LIMIT)}
        if current["column"] == "todo":
            current["column"], current["order"] = "doing", store.next_order("doing")
    finish_intent(task_id, iid, True, output=intent["log"] + note, apply=started)
    return "finished", None


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


def agent_state(t: Dict[str, Any], connected: bool, running: bool) -> Dict[str, Any]:
    """What a started task's agent does: its omp's own report while its session is connected; disconnected while its
    process runs unconnected; else stopped."""
    activity = store.activity.get(t["id"]) or {}
    message = activity.get("message")
    if connected:
        state = activity.get("state") or "idle"
        return {"state": state, "message": message, "step": activity.get("step") if state in STEP_STATES else None,
                "since": activity.get("since")}
    return {"state": "disconnected" if running else "stopped", "message": message, "step": None, "since": None}


def report_agent(body: Dict[str, Any]) -> Dict[str, Any]:
    """Records the state, step and latest prompt an omp reports for its task (in memory) and its session (in the task's
    execution record); `exited` marks a clean exit, which a later resume continues with --resume. A named task still
    starting is accepted before its worktree is recorded."""
    state = body.get("state")
    if state not in AGENT_STATES and state != "exited":
        raise ApiError(400, "State must be planning, thinking, working, plan_ready, needs_input, idle or exited")
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
        if state == "exited":
            if t.get("execution"):
                t["execution"]["cleanExit"] = True
            store.activity[task_id] = {"state": None, "step": None, "since": None, "message": previous.get("message")}
            t["agent"] = agent_state(t, False, False)
            store.save(t)
            changed = prompted = True
            stepped = False
        else:
            changed = previous.get("state") != state
            prompted = message is not None and message != previous.get("message")
            store.activity[task_id] = {"state": state, "step": step,
                                       "since": now_iso() if changed else previous.get("since"),
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


def request_terminal(body: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The requesting omp session's terminal context from a request body, validated; None when absent or malformed."""
    try:
        return terminals.normalize_context(body["terminal"]) if body.get("terminal") else None
    except ValueError:
        return None


REPLY = threading.local()


def after_reply(action: Callable[[], None]) -> None:
    """Runs `action` once the current request's successful reply is sent; at once outside a request."""
    actions = getattr(REPLY, "actions", None)
    if actions is None:
        action()
    else:
        actions.append(action)


def error_text(e: Exception) -> str:
    return e.message if isinstance(e, ApiError) else str(e)


def worktree_contexts(t: Dict[str, Any], requester: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The terminal servers that may show something in a task's worktree: its presentation's, its terminal context's and
    the requester's (call under store.lock)."""
    return [c for c in (t.get("presentation"), presentation_context(t), requester) if c]


def replied_or_close(task_id: str, path: Optional[str], requester: Optional[Dict[str, Any]]) -> None:
    """After a reply to a requester inside a worktree: its terminal closes now if the operation is over, else the
    operation closes it at its end."""
    if not requester or not path:
        return
    with store.lock:
        t = store.tasks.get(task_id)
        intent = (t or {}).get("intent")
        if intent and intent["op"] in ("stop", "remove", "delete"):
            intent["params"]["replied"] = True
            store.write_record(t)
            return
    terminals.close_terminals(path, [requester])


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
                      ex: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], str]:
    """Opens a terminal attached to a task's tmux session in `context` (plain opens none); returns it and a log note. A
    failure leaves the agent running and attachable."""
    attach = detach.attach_command(ex)
    try:
        return terminals.open_terminal(context, name, cwd, attach), ""
    except (RuntimeError, OSError) as e:
        return None, f"Couldn't open the agent's terminal ({e}); attach with {attach}\n"


def show_agent(t: Dict[str, Any], context: Dict[str, Any], ex: Dict[str, Any], current: Optional[Dict[str, Any]],
               focus: bool) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Shows a task's running agent: the terminal in its worktree while one is attached to its tmux session (focused on
    request); else, for a session on cmux's local-tmux server, the task's cmux workspace with the session attached in
    it; else the terminal the createWorktree hook opens again for the existing worktree, where the user's own setup places
    it; else a new terminal attached to it. A terminal that merely sits in the worktree never counts as showing the agent,
    and a board terminal that no longer shows it is replaced. Returns the presentation and a note."""
    cwd = t["worktree"]
    shown = current if current and terminals.alive(current) else terminals.find_terminal(context, cwd)
    if shown and detach.status(ex)["attached"] > 0:
        presentation = {**shown, "alive": True}
        if focus and presentation.get("capabilities", {}).get("focus") and not terminals.focus(presentation):
            return presentation, "Its terminal didn't come forward"
        return presentation, None
    if shown and shown.get("kind") == "cmux" and detach.attach_in_cmux(ex, shown["cmux"], focus):
        return {**shown, "alive": True}, None
    if current and current.get("capabilities", {}).get("close") and terminals.alive(current):
        terminals.close(current)
    note = None
    try:
        command = hook("createWorktree")
    except ApiError as e:
        command, note = None, e.message
    if command:
        script = Path(ex.get("script") or store.task_dir(t["id"]) / "resume.sh")
        code, _, error = worktree_hook(t, ex, command, script)
        opened = terminals.find_terminal(context, cwd) if code == 0 else None
        if opened:
            if focus and opened.get("capabilities", {}).get("focus"):
                terminals.focus(opened)
            return {**opened, "alive": True}, None
        note = f"createWorktree didn't open its terminal: {error}" if code else None
    presentation, failed = open_presentation(context, t["branch"], cwd, ex)
    if presentation and focus and presentation.get("capabilities", {}).get("focus"):
        terminals.focus(presentation)
    return presentation, "; ".join(n for n in (note, failed.strip()) if n) or None


def present(task_id: str, focus: bool) -> Dict[str, Any]:
    """Shows a task's running agent in a terminal (show_agent); plain opens none. Never starts an agent."""
    with store.lock:
        t = copy.deepcopy(store.get(task_id))
        context = presentation_context(t)
    ex, current = t.get("execution") or {}, t.get("presentation")
    if ex.get("kind") != "tmux":
        raise ApiError(409, f"The board doesn't manage {label(task_id)}'s agent")
    if not observe(t)["agent_running"]:
        raise ApiError(409, f"{label(task_id)}'s agent is stopped: move it to In Progress to resume it")
    presentation, note = show_agent(t, context, ex, current, focus)
    write_presenter(task_id, presentation)
    with store.lock:
        t = store.tasks.get(task_id)
        if t:
            t["presentation"] = presentation
            store.save(t)
    hub.changed()
    return {"presentation": presentation, "attachCommand": detach.attach_command(ex), **({"note": note} if note else {})}


def ensure_agent(t: Dict[str, Any]) -> None:
    """Restarts a started task's stopped agent in a new tmux session, continuing its recorded omp session."""
    task_id = t["id"]
    path = t["worktree"]
    if not Path(path).is_dir():
        raise ApiError(409, f"The worktree {path} no longer exists")
    with store.lock:
        context = presentation_context(store.get(task_id))
    old = t.get("execution") or {}
    server = detach.choose_server(context, detach_mode())
    script = agent_script(t, "resume.sh", resume_args(t), resume=True)
    ex = {"kind": "tmux", **server, "name": detach.session_name(task_id), "script": str(script),
          "session": old.get("session"), "cleanExit": False, "exitCode": None, "startedAt": now_iso()}
    record_execution(task_id, ex)
    (store.task_dir(task_id) / "screen.ans").unlink(missing_ok=True)
    detach.start(ex, path, script)
    refresh_facts(task_id)


def open_task(task_id: str) -> Dict[str, Any]:
    """Shows a started task's agent in a terminal; presentation only: a stopped agent resumes from In Progress."""
    with store.lock:
        t = copy.deepcopy(store.get(task_id))
        require_spawned(t)
    ex, presentation = t.get("execution") or {}, t.get("presentation")
    if ex.get("kind") == "tmux":
        result = present(task_id, focus=True)
        poller.kick()
        return {"ok": True, **result}
    if ex.get("kind") == "external" and presentation and terminals.alive(presentation):
        terminals.focus(presentation)
        return {"ok": True, "presentation": {**presentation, "alive": True}, "attachCommand": None}
    if ex.get("kind") == "external" and observe(t)["agent_running"]:
        raise ApiError(409, f"{label(task_id)}'s agent runs in a terminal the board doesn't manage, and that terminal is closed")
    raise ApiError(409, f"{label(task_id)}'s agent is stopped: move it to In Progress to resume it")


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
    text = with_numbers(str(body.get("text") or "").strip())
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


def report_control(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Records the live control loop view a task session's Control plugin reports, or clears it with null."""
    view = body.get("view")
    path = str(body.get("path") or "")
    if view is not None and not (isinstance(view, dict) and view.get("version") == 1
                                 and len(json.dumps(view)) <= CONTROL_VIEW_LIMIT):
        raise ApiError(400, "view must be a control run view (version 1, at most 256 KB) or null")
    with store.lock:
        t = store.get(task_id)
        if not t.get("worktree") or not within(path, t["worktree"]):
            raise ApiError(404, f"{task_id} has no agent at {path}")
        t["control"] = view
        store.write_record(t)
    hub.changed()
    return {"ok": True}


def require_live_session(task_id: str) -> None:
    with store.lock:
        require_spawned(store.get(task_id))
    if not hub.task_live(task_id):
        raise ApiError(409, f"{task_id}'s omp session isn't connected to the board")


def decide_control(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Hands the user's decisions on a task's control loop findings (or a pause) to its session."""
    raw = body.get("decisions") or {}
    if not isinstance(raw, dict) or len(raw) > 200:
        raise ApiError(400, "decisions must map at most 200 finding ids to decisions")
    decisions: Dict[str, Dict[str, str]] = {}
    for fid, d in raw.items():
        note = d.get("note") if isinstance(d, dict) else None
        if not isinstance(d, dict) or d.get("decision") not in ("fix", "dismiss") or \
                (note is not None and (not isinstance(note, str) or len(note) > 2000)):
            raise ApiError(400, f"Decision {fid} must be fix or dismiss, with an optional note of at most 2000 characters")
        decisions[str(fid)] = {"decision": d["decision"], **({"note": note} if note else {})}
    pause = body.get("pause") is True
    if not decisions and not pause:
        raise ApiError(400, "Decide at least one finding, or pause the loop")
    require_live_session(task_id)
    return {"ok": True, "message": hub.control(task_id, "control_decide", {"decisions": decisions, "pause": pause})}


def open_control(task_id: str) -> Dict[str, Any]:
    require_live_session(task_id)
    return {"ok": True, "message": hub.control(task_id, "control_open")}


def valid_loop_summaries(loops: Any) -> bool:
    def node(n: Any) -> bool:
        return isinstance(n, dict) and isinstance(n.get("id"), str) and isinstance(n.get("name"), str) \
            and n.get("kind") in ("check", "review")

    def stage(s: Any) -> bool:
        return isinstance(s, dict) and isinstance(s.get("nodes"), list) and all(node(n) for n in s["nodes"])

    return isinstance(loops, list) and len(loops) <= 100 and len(json.dumps(loops)) <= CONTROL_LOOPS_LIMIT and all(
        isinstance(l, dict) and isinstance(l.get("id"), str) and LOOP_ID.fullmatch(l["id"]) is not None
        and isinstance(l.get("name"), str) and isinstance(l.get("stages"), list) and all(stage(s) for s in l["stages"])
        for l in loops)


def set_flow_control_loops(body: Dict[str, Any]) -> Dict[str, Any]:
    """Records the Control loops a flow's omp offers, so cards in that flow can pick one; null clears them."""
    flow_id_value = str(body.get("id") or "")
    loops = body.get("loops")
    if loops is not None and not valid_loop_summaries(loops):
        raise ApiError(400, "loops must be null or at most 100 control loop summaries (id, name, stages of nodes)")
    with store.lock:
        flow = next((f for f in store.flow_list() if f["id"] == flow_id_value), None)
        if not flow:
            raise ApiError(404, f"Unknown flow {flow_id_value}")
        registered = next((f for f in store.flows
                           if same_dir(f["repo"], flow["repo"]) and f["base"] == flow["base"]), None)
        if registered:
            registered["controlLoops"] = loops
        else:
            store.flows.append({"repo": flow["repo"], "base": flow["base"], "checkout": flow["checkout"],
                                "concurrencyLimit": None, "controlLoops": loops})
        store.save_board()
    hub.changed()
    return {"ok": True}


def pause_agent(t: Dict[str, Any]) -> str:
    """Interrupts the agent of a task whose card just paused; returns what happened."""
    if not hub.task_live(t["id"]):
        return "Its omp session isn't connected, so nothing was interrupted"
    try:
        return hub.control(t["id"], "pause")
    except ApiError as e:
        return f"Its agent wasn't interrupted: {e.message}"


def step_resume(t: Dict[str, Any], intent: Dict[str, Any]) -> Outcome:
    """Puts a resumed task's agent back to work with the card's edits made while it was paused: a running agent gets the
    resume message now; a stopped one restarts in tmux (continuing its omp session) and its omp sends the message
    itself from ORCHESTRATOR_RESUME_FILE, then posts /resumed. An agent that can't restart parks the card in Backlog."""
    task_id, iid, params = t["id"], intent["id"], intent["params"]
    stage = intent["stage"] or "launch"
    if stage == "launch":
        facts = observe(t)
        if not facts["worktree_present"]:
            return "fail", f"{label(task_id)} has no worktree"
        with store.lock:
            current = store.get(task_id)
            note_briefing(current)
            update = briefing(current) if pending_update(current) else None
            text = RESUME_TEXT.format(id=label(task_id))
            if update:
                text += "\n\n" + update_message(task_id, current["briefed"], update)
            store.write_record(current)
            snapshot = copy.deepcopy(current)
        write_atomic(store.task_dir(task_id) / "resume.json", json.dumps({"text": text, "update": update}))
        # From the process, not a stream that can outlive it; remembered so a retry presents what a failed launch started.
        restarted = bool(params.get("restarted")) or not facts["agent_running"]
        if restarted and not facts["agent_running"]:
            progress(task_id, iid, params={"restarted": True})
            try:
                ensure_agent(snapshot)
            except (ApiError, RuntimeError, detach.DetachError) as e:
                return "retry", error_text(e)
        progress(task_id, iid, stage="present", params={"restarted": restarted, "streamed": bool(facts["stream"]),
                                                         "text": text})
        return "next", None
    if stage == "present":
        log = ""
        if params.get("restarted"):
            try:
                note = present(task_id, focus=False).get("note")
                log = f"{note}\n" if note else ""
            except ApiError as e:
                log = f"Its terminal didn't open: {e.message}\n"
        progress(task_id, iid, stage="nudge", log=log)
        return "next", None
    log = ""
    if not params.get("restarted") and params.get("streamed"):
        try:
            hub.control(task_id, "message", {"text": params["text"]})
            resumed_task(task_id)
        except ApiError as e:
            if e.status == 504:
                return "retry", e.message
            log = f"Its agent didn't take the resume message: {e.message}\n"
    finish_intent(task_id, iid, True, output=intent["log"] + log,
                  apply=lambda current: current.update(resumedAt=now_iso()))
    return "finished", None


def resumed_task(task_id: str) -> Dict[str, Any]:
    """A resumed task's omp delivered its resume message: its agent knows the card as it is now."""
    path = store.task_dir(task_id) / "resume.json"
    with store.lock:
        t = store.get(task_id)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"ok": True, "consumed": False}
        path.unlink(missing_ok=True)
        if isinstance(data, dict) and isinstance(data.get("update"), dict):
            t["briefed"] = data["update"]
            store.save(t)
    hub.changed()
    return {"ok": True}


def stopping(t: Dict[str, Any], intent: Dict[str, Any], prefix: str) -> Optional[Outcome]:
    """Drives the stages that end a task's agent (`prefix` + ask, wait, kill): its omp session takes the stop command
    first; one still running STOP_TIMEOUT later is sent SIGTERM, then its tmux session is killed. None once no agent
    runs."""
    task_id, iid, params = t["id"], intent["id"], intent["params"]
    stage = (intent["stage"] or prefix + "ask")[len(prefix):]
    facts = observe(t)
    if stage == "ask":
        if not facts["stream"]:
            progress(task_id, iid, stage=prefix + "kill")
            return "next", None
        log = ""
        try:
            hub.control(task_id, "stop")
        except ApiError as e:
            log = f"Its omp session didn't take the stop command ({e.message})\n"
        progress(task_id, iid, stage=prefix + "wait", log=log, params={"askedAt": time.time()})
        return "next", None
    if not facts["agent_running"]:
        return None
    if stage == "wait":
        if time.time() - params.get("askedAt", 0) < STOP_TIMEOUT:
            return "wait", None
        progress(task_id, iid, stage=prefix + "kill")
        return "next", None
    ex = t.get("execution") or {}
    signalled = params.get("signalledAt")
    if ex.get("kind") == "tmux":
        if signalled is None:
            detach.signal(ex, signal.SIGTERM)
            progress(task_id, iid, log="Its agent didn't exit; sent it SIGTERM\n", params={"signalledAt": time.time()})
            return "wait", None
        if time.time() - signalled < 5:
            return "wait", None
        if not detach.kill(ex):
            return "retry", "its tmux session didn't stop"
        return ("retry", "its agent is still running") if observe(t)["agent_running"] else None
    if ex.get("kind") == "external" and detach.pid_alive(ex.get("pid"), ex.get("pidStarted")):
        try:
            if signalled is None:
                os.killpg(ex["pid"], signal.SIGTERM)
                progress(task_id, iid, log="Its agent didn't exit; sent it SIGTERM\n", params={"signalledAt": time.time()})
                return "wait", None
            if time.time() - signalled < 5:
                return "wait", None
            os.killpg(ex["pid"], signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError as e:
            return "retry", f"its agent couldn't be stopped: {e}"
        return None
    progress(task_id, iid, log="Its agent runs outside the board's tmux; close it there\n")
    return None


def finish_closing(task_id: str, intent: Dict[str, Any], path: Optional[str], requester: Optional[Dict[str, Any]],
                   apply: Callable[[Dict[str, Any]], None]) -> Outcome:
    """Finishes an operation whose requester may sit in the worktree: its terminal closes once the reply reached it."""
    replied: List[bool] = []

    def done(current: Dict[str, Any]) -> None:
        replied.append(bool(current["intent"]["params"].get("replied")))
        apply(current)
    finish_intent(task_id, intent["id"], True, output=intent["log"], apply=done)
    if requester and path and any(replied):
        terminals.close_terminals(path, [requester])
    return "finished", None


def step_stop(t: Dict[str, Any], intent: Dict[str, Any]) -> Outcome:
    """Stops a task's agent and closes the terminal showing it (with `terminals`, every terminal in its worktree but the
    requester's), keeping its worktree, branch and omp session."""
    task_id, iid, params = t["id"], intent["id"], intent["params"]
    if intent["stage"] != "close":
        outcome = stopping(t, intent, "")
        if outcome:
            return outcome
        progress(task_id, iid, stage="close")
        return "next", None
    requester, path, presentation = params.get("requester"), t.get("worktree"), t.get("presentation")
    if params.get("terminals") and path:
        with store.lock:
            contexts = worktree_contexts(store.get(task_id), requester)
        terminals.close_terminals(path, contexts, spare=requester)
    elif presentation and presentation.get("capabilities", {}).get("close") and terminals.alive(presentation):
        terminals.close(presentation)
    if observe(t)["agent_running"]:
        return "retry", "its agent is still running"
    refresh_facts(task_id)

    def stopped(current: Dict[str, Any]) -> None:
        if current.get("presentation"):
            current["presentation"] = {**current["presentation"], "alive": False}
        current["agent"] = agent_state(current, False, False)
    return finish_closing(task_id, intent, path, requester, stopped)


def stop_task(task_id: str) -> Dict[str, Any]:
    """Ends a started task's agent and closes its terminal, keeping its worktree, branch and omp session; the card parks
    in Backlog (a Review card stays). Moving it back to Todo or In Progress resumes it."""
    with store.lock:
        t = store.get(task_id)
        require_spawned(t)
        if t["column"] == "done" or t.get("merged"):
            raise ApiError(409, f"{task_id} is done")
        intent = set_intent(t, "stop", {})
        # Parked first: while omp exits, an idle In Progress card would otherwise read as ready for Review.
        if t["column"] in ("todo", "doing"):
            t["column"], t["order"] = "backlog", store.next_order("backlog")
            store.save(t)
    hub.changed()
    await_intent(task_id, intent["id"], INTENT_WAIT)
    with store.lock:
        t = store.get(task_id)
        view = store.view(t)
        pending = (t.get("intent") or {}).get("id") == intent["id"]
        last = t.get("lastOperation") or {}
    view["pending"] = pending
    if not pending and last.get("op") == "stop" and not last.get("ok"):
        view["note"] = last.get("error")
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
    parts = [f"{label(task_id)} was edited on the board; this replaces the {' and '.join(changed)} in your brief."]
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
    """The agent's terminal screen from its tmux session, whether or not any terminal shows it; once the agent exited,
    the last screen the board kept."""
    with store.lock:
        t = store.get(task_id)
        require_spawned(t)
        ex = dict(t.get("execution") or {})
    if ex.get("kind") != "tmux":
        raise ApiError(409, f"{label(task_id)}'s agent runs outside the board's tmux; its screen shows only there")
    text = detach.capture(ex, 120)
    if text is None:
        kept = store.task_dir(task_id) / "screen.ans"
        if not kept.is_file():
            raise ApiError(409, f"{label(task_id)} has no screen to show")
        text = kept.read_text(encoding="utf-8", errors="replace")
    look = appearance()
    return screen.preview(screen.plain_text(text), screen.rows_from_ansi(text), look["palette"], look["nerdFont"], 120)


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
        opened = terminals.open_diff(target, path, base_ref(path, base), f"{label(task_id)} diff")
    except RuntimeError as e:
        raise ApiError(500, str(e))
    if not opened:
        raise ApiError(409, f"{task_id}'s terminal can't show a diff panel (it needs cmux)")
    return {"ok": True}


DELETED_OUTPUT: Dict[str, str] = {}  # the log of a delete intent whose card is gone, by intent id, for its request


def refuse_dirty_removal(path: Optional[str]) -> None:
    """Refuses removing a worktree with uncommitted changes before anything stops, unless removeWorktree decides."""
    if not path or not Path(path).is_dir() or hook("removeWorktree"):
        return
    _, status, _ = run(["git", "-C", path, "status", "--porcelain"], timeout=30)
    if status.strip():
        raise ApiError(409, "The worktree has uncommitted changes", {"output": status})


def remove_checkout(t: Dict[str, Any]) -> Outcome:
    """Removes a stopped task's worktree and branch: the removeWorktree command, else the teardown script and git."""
    task_id, path, repo, branch = t["id"], t.get("worktree"), t["repo"], t["branch"]
    if not path or not Path(path).is_dir():
        return "next", f"{path} was already removed\n" if path else ""
    try:
        command = hook("removeWorktree")
        teardown = project_scripts(os.path.basename(repo))["teardownScript"]
    except ApiError as e:
        return "fail", e.message
    if command:
        env = {"ORCHESTRATOR_TASK": task_id, "ORCHESTRATOR_REPO": repo, "ORCHESTRATOR_BRANCH": branch, "ORCHESTRATOR_WORKTREE": path,
               "ORCHESTRATOR_TEARDOWN_SCRIPT": os.path.expanduser(teardown)}
        code, output, error = run_hook("removeWorktree", command, path, 300, env)
        if code != 0:
            return "retry", error
        return "next", output.strip() + "\n" if output.strip() else ""
    _, status, _ = run(["git", "-C", path, "status", "--porcelain"], timeout=30)
    if status.strip():
        return "fail", "The worktree has uncommitted changes"
    log = run_script("Teardown script", teardown, path, 300, script_env(t, path)) if teardown else ""
    code, out, err = run(["git", "-C", repo, "worktree", "remove", "--force", path], timeout=120)
    if code != 0 and "is not a working tree" not in err:
        return "retry", (err or out).strip() or f"git worktree remove exited with code {code}"
    run(["git", "-C", repo, "branch", "-D", branch], timeout=30)
    return "next", log + f"Removed {path} and branch {branch}\n"


def removing(t: Dict[str, Any], intent: Dict[str, Any], delete: bool) -> Outcome:
    """Removes a started task's worktree: stops its agent first so nothing works in a deleted tree, removes the worktree,
    then closes every terminal left in it (the requester's own once replied) and ends its tmux session. The card then
    forgets the worktree, so an unfinished task can start again, or with `delete` is deleted."""
    task_id, iid, params = t["id"], intent["id"], intent["params"]
    stage = intent["stage"] or "stop:ask"
    if stage.startswith("stop:"):
        outcome = stopping(t, intent, "stop:")
        if outcome:
            return outcome
        progress(task_id, iid, stage="worktree")
        return "next", None
    if stage == "worktree":
        outcome, text = remove_checkout(t)
        if outcome != "next":
            return outcome, text
        progress(task_id, iid, stage="terminals", log=text)
        return "next", None
    requester, path, ex = params.get("requester"), t.get("worktree"), t.get("execution") or {}
    if path:
        # A removeWorktree hook runs without the caller's terminal identity, so the board closes what is left there.
        with store.lock:
            contexts = worktree_contexts(store.get(task_id), requester)
        terminals.close_terminals(path, contexts, spare=requester)
    if ex.get("kind") == "tmux":
        detach.kill(ex)
    elif ex.get("kind") == "external" and ex.get("dir"):
        shutil.rmtree(ex["dir"], ignore_errors=True)
    if not delete:
        def forgotten(current: Dict[str, Any]) -> None:
            forget_worktree(current, park=("todo", "doing"))
            current["control"] = None
        return finish_closing(task_id, intent, path, requester, forgotten)
    with store.lock:
        current = store.tasks.get(task_id)
        if not current or (current.get("intent") or {}).get("id") != iid:
            return "finished", None
        replied = bool(current["intent"]["params"].get("replied"))
        store.delete(task_id)
        DELETED_OUTPUT[iid] = intent["log"]
    hub.changed()
    if requester and path and replied:
        terminals.close_terminals(path, [requester])
    return "finished", None


def step_remove(t: Dict[str, Any], intent: Dict[str, Any]) -> Outcome:
    return removing(t, intent, delete=False)


def step_delete(t: Dict[str, Any], intent: Dict[str, Any]) -> Outcome:
    return removing(t, intent, delete=True)


def cleanup_task(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Removes a started task's worktree and branch as a remove intent; the reply says whether it is still pending."""
    requester = request_terminal(body)
    with store.lock:
        path = require_spawned(store.get(task_id))
    refuse_dirty_removal(path)
    with store.lock:
        intent = set_intent(store.get(task_id), "remove", {"requester": requester})
    await_intent(task_id, intent["id"], INTENT_WAIT)
    with store.lock:
        t = store.get(task_id)
        pending = (t.get("intent") or {}).get("id") == intent["id"]
        last = {} if pending else (t.get("lastOperation") or {})
    if last and not last.get("ok"):
        raise ApiError(409, last.get("error") or f"{label(task_id)}'s worktree wasn't removed",
                       {"output": last.get("output") or ""})
    after_reply(lambda: replied_or_close(task_id, path, requester))
    return {"ok": True, "output": (last.get("output") or "").strip(), "pending": pending}


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
    store.facts.pop(task_id, None)


def merged_leftover(t: Dict[str, Any]) -> bool:
    """A Done card's worktree that its local merge left behind and nobody chose to keep: clean, with its HEAD in the merge."""
    path, merged = t.get("worktree"), t.get("merged") or {}
    if t["column"] != "done" or not merged.get("sha") or t.get("keptWorktree") or not path or not Path(path).is_dir():
        return False
    code, status, _ = run(["git", "-C", path, "status", "--porcelain"], timeout=30)
    if code != 0 or status.strip():
        return False
    code, head, _ = run(["git", "-C", path, "rev-parse", "HEAD"], timeout=10)
    return code == 0 and run(["git", "-C", path, "merge-base", "--is-ancestor", head.strip(), merged["sha"]], timeout=15)[0] == 0


def recoverable(t: Dict[str, Any]) -> None:
    """Refuses to return a task to Backlog unless it is unfinished and its recorded worktree is gone (call under
    store.lock)."""
    task_id = t["id"]
    path = require_spawned(t)
    if t["column"] == "done" or t.get("merged"):
        raise ApiError(409, f"{task_id} is done")
    if t["spawn"]["state"] == "running":
        raise ApiError(409, f"{task_id} is still starting")
    if Path(path).is_dir():
        raise ApiError(409, f"{task_id}'s worktree {path} still exists; stop the task, or clean it up to remove it")


def recover_task(task_id: str) -> Dict[str, Any]:
    """Returns a started task whose worktree was deleted outside the board to a restartable Backlog card: forgets its
    worktree, agent and terminal records and any operation left on it, keeping the card, its notes and its branch. It
    never stops, starts or resumes an agent, so one that still runs is refused."""
    with store.lock:
        t = store.get(task_id)
        recoverable(t)
        snapshot = copy.deepcopy(t)
    facts = observe(snapshot)
    if facts["stream"]:
        raise ApiError(409, f"{label(task_id)}'s omp session is still connected; stop it first")
    if facts["agent_running"]:
        raise ApiError(409, f"{label(task_id)}'s agent is still running; stop it first")
    ex = snapshot.get("execution") or {}
    if ex.get("kind") == "tmux":
        detach.kill(ex)
    with store.lock:
        t = store.get(task_id)
        recoverable(t)
        if t.get("execution") != snapshot.get("execution"):
            raise ApiError(409, f"{label(task_id)}'s agent changed meanwhile; try again")
        t["intent"] = None
        forget_worktree(t, park=("todo", "doing", "review"))
        view = store.view(t)
    if ex.get("kind") == "external" and ex.get("dir"):
        shutil.rmtree(ex["dir"], ignore_errors=True)
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
    subject = f"Task {task_number(store.tasks[task_id])}: {' '.join(plain(title).splitlines()).strip() or 'Orchestrator task'}"
    code, out, error = run(["git", "-C", path, "commit", "-m", subject], timeout=120)
    if code != 0:
        raise ApiError(409, "Could not commit the task changes", {"output": (out + error).strip()})
    code, sha, error = run(["git", "-C", path, "rev-parse", "--short", "HEAD"], timeout=10)
    if code != 0 or not sha.strip():
        raise ApiError(500, "Committed the task changes but could not read the commit", {"output": error.strip()})
    return sha.strip()


MERGE_LOCK = threading.Lock()


def merge_task(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Merges a local task into its base as a merge intent, then (as the intent it chains into) removes its worktree with
    `cleanup`, else stops its agent and closes its worktree's terminals. Replies once the merge itself is over."""
    requester = request_terminal(body)
    with store.lock:
        t = store.get(task_id)
        path = require_spawned(t)
        intent = set_intent(t, "merge", {"cleanup": bool(body.get("cleanup")), "commit": body.get("commit") is True,
                                         "requester": requester})
    await_intent(task_id, intent["id"], MERGE_WAIT)
    with store.lock:
        t = store.get(task_id)
        current, last = t.get("intent"), t.get("lastOperation") or {}
        if current and current["id"] == intent["id"]:
            raise ApiError(504, f"{label(task_id)} is still merging; the board shows when it is done")
        if last.get("op") == "merge" and not last.get("ok"):
            raise ApiError(409, last.get("error") or "The merge failed", {"output": last.get("output") or ""})
        output = current["log"] if current else last.get("output") or ""
        merged = t.get("merged")
    after_reply(lambda: replied_or_close(task_id, path, requester))
    return {"ok": True, "output": output.strip(), "merged": merged, "pending": current is not None}


def step_merge(t: Dict[str, Any], intent: Dict[str, Any]) -> Outcome:
    """Merges a task into its base and records it, then chains into removing its worktree (`cleanup`) or stopping its
    agent with every terminal in its worktree."""
    task_id, params = t["id"], intent["params"]
    try:
        output, merged = merge_branch(t, params)
    except ApiError as e:
        progress(task_id, intent["id"], log=str(e.extra.get("output") or ""))
        return "fail", e.message
    output += "\n"

    def recorded(current: Dict[str, Any]) -> None:
        current["merged"] = merged
        current["keptWorktree"] = not params.get("cleanup")
        if current["column"] != "done":
            current["column"], current["order"] = "done", store.next_order("done")
    after = beads.new_intent("remove" if params.get("cleanup") else "stop",
                             {"requester": params.get("requester"), "terminals": True})
    after["log"] = output
    finish_intent(task_id, intent["id"], True, output=output, next_intent=after, apply=recorded)
    poller.kick(full=True)
    return "chained", output


def merge_branch(t: Dict[str, Any], body: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """Commits a task's pending changes (`commit`), rebases its branch after a conflict, and merges it into its base;
    returns the output and the merge record. A merge that landed without being recorded is recorded again."""
    task_id = t["id"]
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
                                 f"--grep=Merge {branch} (", base], timeout=15)
            if not already.strip():
                raise ApiError(409, f"Nothing to merge: {branch} has no commits that {base} lacks")
        # Already merged: `--ff-only` on an ancestor is a successful no-op, so the shared completion below records it.
        merge_command = ["git", "-C", target, "merge", "--ff-only", branch] if already else [
            "git", "-C", target, "merge", "--no-ff", "--no-edit", "-m",
            f"Merge {branch} (task {task_number(store.tasks[task_id])}: {title})", branch,
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
    lines = []
    if commit_sha:
        lines.append(f"Committed pending changes on {branch} ({commit_sha})")
    if rebased:
        lines.append(f"Rebased {branch} onto {base}")
    lines.append(f"Merged {branch} into {base} ({merged['sha'][:7]})")
    return "\n".join(lines), merged


STEPS: Dict[str, Callable[[Dict[str, Any], Dict[str, Any]], Outcome]] = {
    "start": step_start, "resume": step_resume, "stop": step_stop, "merge": step_merge, "remove": step_remove,
    "delete": step_delete}


# --- status poller --------------------------------------------------------------------

def recently_failed_removal(t: Dict[str, Any]) -> bool:
    last = t.get("lastOperation") or {}
    return last.get("op") == "remove" and not last.get("ok") and time.time() - epoch(last["at"]) < 3600


class Poller:
    """Keeps spawned tasks' agent, git and PR status current, moves cards on PR open/merge and local readiness, starts or
    resumes the Todo tasks whose dependencies are done, and runs a worker for each pending intent."""

    def __init__(self) -> None:
        self.wake = threading.Event()
        self.forced = False
        self.last_git = 0.0
        self.last_pr = 0.0
        self.last_presentation = 0.0
        self.last_sweep = 0.0
        self.beads_retry: Dict[str, Tuple[int, float]] = {}

    def kick(self, full: bool = False) -> None:
        self.forced = self.forced or full
        self.wake.set()

    def run(self) -> None:
        while True:
            with store.lock:
                busy = any(t.get("intent") for t in store.tasks.values())
            self.wake.wait(timeout=1 if busy else 3)
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
        now = time.time()
        if tracked:
            changed |= self.check_agents(tracked)
            if forced or now - self.last_git >= 10:
                self.last_git = now
                changed |= self.check_git([t for t in tracked if t["column"] != "done"])
            changed |= self.check_ready(tracked)
            if forced or now - self.last_pr >= 60:
                self.last_pr = now
                changed |= self.check_prs([t for t in tracked if t["column"] != "done" or not t.get("pr")])
        changed |= self.check_queue()
        sweep = forced or now - self.last_sweep >= SWEEP_INTERVAL
        if sweep:
            self.last_sweep = now
            self.sweep_leftovers()
        changed |= self.retry_beads(now)
        self.check_intents(now)
        if changed:
            hub.changed()

    def check_intents(self, now: float) -> None:
        """Starts a worker for each pending intent that is due and has none; none once the board stops."""
        if DRAINING.is_set():
            return
        with store.lock:
            due = [t["id"] for t in store.tasks.values() if t.get("intent") and t["id"] not in RUNNING_INTENTS
                   and (t["intent"].get("retryAt") or 0) <= now]
            RUNNING_INTENTS.update(due)
        for task_id in due:
            threading.Thread(target=run_intent, args=(task_id,), daemon=True).start()

    def sweep_leftovers(self) -> None:
        """Removes the worktrees local merges left behind; one whose removal just failed waits an hour."""
        with store.lock:
            candidates = [dict(t) for t in store.tasks.values() if t["column"] == "done" and t.get("worktree")
                          and not t.get("intent") and not recently_failed_removal(t)]
        for t in candidates:
            if not merged_leftover(t):
                continue
            with store.lock:
                current = store.tasks.get(t["id"])
                if current and not current.get("intent"):
                    set_intent(current, "remove", {})

    def retry_beads(self, now: float) -> bool:
        """Writes the column changes Beads didn't take, backing off after each failure."""
        changed = False
        with store.lock:
            for t in list(store.tasks.values()):
                task_id = t["id"]
                if not t.get("beadsPending"):
                    self.beads_retry.pop(task_id, None)
                    continue
                attempts, due = self.beads_retry.setdefault(task_id, (0, now + BEADS_BACKOFF[0]))
                if now < due or task_id in RUNNING_INTENTS:
                    continue
                if beads.differs("column", t["column"], store.seen[task_id].get("column")):
                    try:
                        store.push(t, ["column"])
                    except beads.BeadsError as e:
                        self.beads_retry[task_id] = (attempts + 1, now + BEADS_BACKOFF[min(attempts + 1, len(BEADS_BACKOFF) - 1)])
                        print(f"orchestrator: {task_id}'s column still doesn't reach Beads: {e}", file=sys.stderr)
                        continue
                t["beadsPending"] = None
                store.write_record(t)
                self.beads_retry.pop(task_id, None)
                changed = True
        return changed

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
            queued = sorted((t for t in store.tasks.values() if t["column"] == "todo" and not t.get("intent")
                             and not blocked_by(t) and (paused(t) or (not spawned(t) and t["spawn"]["state"] == "none"
                                                                      and Path(t["repo"]).is_dir()))),
                            key=lambda t: (t["order"], t["createdAt"]))
            moved = False
            for t in queued:
                if not has_task_slot(t):
                    continue
                if paused(t):
                    t["column"], t["order"] = "doing", store.next_order("doing")
                    set_intent(t, "resume", {})
                else:
                    start_task(t)
                moved = True
        return moved or refreshed

    def check_agents(self, tracked: List[Dict[str, Any]]) -> bool:
        """Agent state from what runs (observe: the omp session lease, the tmux pane) and from each task's own omp session
        (its stream and reports); terminals are only asked now and then whether they are still open, which never decides
        the agent's state. An agent that exited leaves its last screen, then its tmux session ends."""
        facts = {s["id"]: observe(s) for s in tracked}
        opened: Dict[str, bool] = {}
        now = time.time()
        if now - self.last_presentation >= PRESENTATION_INTERVAL:
            self.last_presentation = now
            opened = {s["id"]: terminals.alive(s["presentation"]) for s in tracked
                      if (s.get("presentation") or {}).get("kind") in ("cmux", "tmux")}
        exited: List[Tuple[str, Dict[str, Any]]] = []
        changed = False
        with store.lock:
            for snapshot in tracked:
                t = store.tasks.get(snapshot["id"])
                if not t:
                    continue
                task_id, ex, f = t["id"], t.get("execution"), facts[snapshot["id"]]
                connected = f["stream"] is not None
                seen = store.facts.get(task_id) or {}
                if (seen.get("agent_running"), seen.get("tmux")) != (f["agent_running"], f["tmux"]):
                    changed = True
                store.facts[task_id] = f
                persist = False
                tmux = f["tmux"] or {}
                if ex and ex.get("kind") == "tmux" and tmux.get("dead") and ex.get("exitCode") is None \
                        and ex.get("startedAt") == (snapshot.get("execution") or {}).get("startedAt"):
                    ex["exitCode"] = tmux.get("exitCode")
                    exited.append((task_id, dict(ex)))
                    persist = True
                if connected and not ex:
                    # A connected omp the board didn't start (run by hand in the worktree) is adopted, never duplicated.
                    t["execution"] = external_execution(None)
                    persist = True
                activity = store.activity.get(task_id)
                if connected:
                    if activity:
                        activity.pop("disconnectedAt", None)
                elif activity and activity.get("state"):
                    # A lost session's last report says nothing about whatever runs next, once a reconnect didn't follow.
                    if now - activity.setdefault("disconnectedAt", now) >= 3:
                        store.activity[task_id] = {"state": None, "step": None, "since": None,
                                                   "message": activity.get("message")}
                agent = agent_state(t, connected, f["agent_running"])
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
        for task_id, ex in exited:
            write_atomic(store.task_dir(task_id) / "screen.ans", detach.capture(ex, SCREEN_LINES) or "")
            detach.reap(ex)
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
                if not t or t["merge"] != "local" or t["column"] != "doing" or t.get("pr") or t.get("intent"):
                    continue
                if t.get("resumedAt"):
                    # A resumed agent reads idle or closed until it picks up its resume message.
                    active = (t.get("agent") or {}).get("state") in ACTIVE_STATES
                    if active or time.time() - epoch(t["resumedAt"]) >= RESUME_GRACE:
                        t["resumedAt"] = None
                        store.write_record(t)
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
                    merged = column == "done" and t["column"] != "done"
                    if column != t["column"]:
                        t["column"], t["order"] = column, store.next_order(column)
                    t["pr"] = pr
                    store.save(t)
                    if merged and spawned(t) and not t.get("intent"):
                        set_intent(t, "stop", {})
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
            css, nerd_font, scheme, palette = terminal_appearance(out + "\n" + cmux_config())
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
    if t.get("intent"):
        return False, f"{column}: {VERB[t['intent']['op']]}"
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
                          "reason": with_numbers(f"{why}. {said}")})
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
    prefix = f"{beads.MEMORY_PREFIX}{hashlib.sha256(scope.encode()).hexdigest()[:16]}."
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


SERVER: Optional["Server"] = None


def drain() -> None:
    """Stops taking requests and starting intent workers; main() exits once the running workers are done (at most 120 s),
    so a restart never cuts an operation short."""
    if DRAINING.is_set():
        return
    DRAINING.set()
    if SERVER is not None:
        threading.Thread(target=SERVER.shutdown, daemon=True).start()


def restart() -> Dict[str, Any]:
    after_reply(drain)
    return {"ok": True}


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
    ("POST", r"/api/tasks/([\w.-]+)/control", lambda m, b: report_control(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/control/decide", lambda m, b: decide_control(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/control/open", lambda m, b: open_control(m[1])),
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
    ("POST", r"/api/tasks/([\w.-]+)/resumed", lambda m, b: resumed_task(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/recover", lambda m, b: recover_task(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/history", lambda m, b: task_history(m[1], b)),
    ("POST", r"/api/readiness", lambda m, b: readiness(b)),
    ("POST", r"/api/refresh", lambda m, b: refresh()),
    ("POST", r"/api/restart", lambda m, b: restart()),
    ("POST", r"/api/context", lambda m, b: set_context(b)),
    ("POST", r"/api/flows", lambda m, b: register_flow(b)),
    ("POST", r"/api/flows/prompt", lambda m, b: prompt_task(b)),
    ("POST", r"/api/flows/recap", lambda m, b: flow_recap(b)),
    ("POST", r"/api/exports", lambda m, b: save_export(b)),
    ("PATCH", r"/api/flows", lambda m, b: set_flow_concurrency(b)),
    ("PATCH", r"/api/flows/scripts", lambda m, b: set_flow_scripts(b)),
    ("PATCH", r"/api/flows/control-loops", lambda m, b: set_flow_control_loops(b)),
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
            if self.command == "GET" and path in ("/design-system.css", "/markdown.js", "/graph-layout.js", "/pipeline.js", "/pipeline.css", "/workbench.js", "/workbench.css", "/native.js", "/native.css", "/control-view.js", "/control-view.css", "/flow-export.js", "/flow-export.css"):
                asset = ROOT / path.lstrip("/")
                content_type = "text/javascript" if path.endswith(".js") else "text/css"
                return self.serve_bytes(asset.read_bytes(), content_type + "; charset=utf-8")
            if self.command == "GET" and path == "/appearance.css":
                flow = parse_qs(urlparse(self.path).query).get("flow", [""])[0]
                return self.serve_bytes(appearance_css(flow).encode(), "text/css; charset=utf-8")
            if self.command == "GET" and path.startswith("/exports/"):
                name = path[len("/exports/"):]
                page = EXPORTS_DIR / name
                if not EXPORT_NAME.fullmatch(name) or not page.is_file():
                    raise ApiError(404, "No saved flow page with that name")
                # Saved pages run in an opaque origin: their script can't reach the board's API.
                return self.serve_bytes(page.read_bytes(), "text/html; charset=utf-8",
                                        {"Content-Security-Policy": "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox"})
            if self.command == "GET" and path == "/api/events":
                return self.serve_events()
            for method, pattern, handler in ROUTES:
                m = re.fullmatch(pattern, path)
                if m and method == self.command:
                    REPLY.actions = []
                    try:
                        data = handler(m, self.body() if method != "GET" else {})
                    finally:
                        deferred, REPLY.actions = REPLY.actions, None
                    status, data = data if isinstance(data, tuple) else (200, data)
                    try:
                        return self.send_json(status, data)
                    finally:
                        self.run_after_reply(deferred)
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

    def run_after_reply(self, actions: List[Callable[[], None]]) -> None:
        """Runs what a successful request deferred until its reply was sent (after_reply)."""
        for action in actions:
            try:
                action()
            except Exception as e:
                print(f"orchestrator: after {self.command} {self.path}: {e!r}", file=sys.stderr)

    do_GET = do_POST = do_PATCH = do_DELETE = handle_any

    def serve_bytes(self, body: bytes, content_type: str, headers: Optional[Dict[str, str]] = None) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
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


OLD_HOME = Path("~/.kanboard").expanduser()


def adopt_old_home() -> None:
    """Moves the board's data from its folder before the rename from Kanboard into HOME, once, with the paths and hook
    variable names recorded in it; worktrees the board created there are reconnected to their repositories. A HOME
    that exists without a Beads workspace (e.g. a config.json an installer wrote there first) takes the old entries
    over its own."""
    if "ORCHESTRATOR_HOME" in os.environ or (HOME / "beads").exists() or not OLD_HOME.is_dir():
        return
    if HOME.exists():
        for entry in OLD_HOME.iterdir():
            target = HOME / entry.name
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            elif target.exists() or target.is_symlink():
                target.unlink()
            os.rename(entry, target)
        OLD_HOME.rmdir()
    else:
        os.rename(OLD_HOME, HOME)
    old, new = str(OLD_HOME) + os.sep, str(HOME) + os.sep
    for path in [CONFIG_FILE, BOARD_FILE, *TASKS_DIR.glob("*/execution.json")]:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        moved = text.replace(old, new).replace("KANBOARD_", "ORCHESTRATOR_")
        if moved != text:
            write_atomic(path, moved)
    for record in TASKS_DIR.glob("*/execution.json"):
        try:
            worktree = json.loads(record.read_text(encoding="utf-8")).get("worktree")
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(worktree, str) and worktree.startswith(new) and Path(worktree).is_dir():
            run(["git", "-C", worktree, "worktree", "repair"], timeout=30)
    print(f"orchestrator: moved {OLD_HOME} to {HOME}", file=sys.stderr, flush=True)


def prepare() -> None:
    """`server.py --prepare`: readies the Beads workspace and imports legacy JSON tasks once."""
    adopt_old_home()
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
    global SERVER
    SERVER = Server((HOST, PORT), Handler)
    print(f"orchestrator: http://{HOST}:{PORT} (data in {HOME}; new tasks branch from "
          f"{store.context['base']} in {store.context['checkout']})", file=sys.stderr, flush=True)
    signal.signal(signal.SIGTERM, lambda *_: drain())
    try:
        SERVER.serve_forever()
    except KeyboardInterrupt:
        DRAINING.set()
    finally:
        deadline = time.time() + 120
        while time.time() < deadline:
            with store.lock:
                if not RUNNING_INTENTS:
                    break
            time.sleep(0.2)
        SERVER.server_close()


if __name__ == "__main__":
    main()
