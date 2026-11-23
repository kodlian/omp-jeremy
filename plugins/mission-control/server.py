#!/usr/bin/env python3
"""Mission Control server: every worktree of a project, its omp agent, its links and its pull request."""
from __future__ import annotations

import copy
import fnmatch
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
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import detach
import import_orchestrator
import lease
import sessions
import screen
from cmux import cmux_config, ghostty_cli, terminal_appearance
from gitops import (base_ref, branch_base, checkout_info, default_branch, drop_missing_worktrees, find_worktree, git_toplevel,
                    has_ref, merge_base, prepare_branch, registered_worktrees, unmerged_files)
from integrations import PACKAGE_ROOT, terminals
from runtime import ANSI, now_iso, plain, run, same_dir, tail, which, within, write_atomic

ROOT = Path(__file__).resolve().parent
HOME = Path(os.environ.get("MISSION_CONTROL_HOME", "~/.mission-control")).expanduser()
TASKS_DIR = HOME / "tasks"
HOST = "127.0.0.1"
PORT = int(os.environ.get("MISSION_CONTROL_PORT", "4747"))
BRANCH_PREFIX = os.environ.get("MISSION_CONTROL_BRANCH_PREFIX", "feature/")
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

COLUMNS = [("planning", "Planning"), ("waiting", "Waiting"), ("doing", "In Progress"), ("review", "Review"),
           ("pr", "Pull Request"), ("done", "Done")]
COLUMN_IDS = [c for c, _ in COLUMNS]
MOVABLE_COLUMNS = ("waiting", "doing", "done")
MOVE_GUARDED_AGENT_STATES = {"planning", "thinking", "working", "needs_input", "plan_ready", "disconnected"}
PAUSED_COLUMNS = ("waiting",)
CONTROL_TIMEOUT = 10.0
STOP_TIMEOUT = 8.0
RESUME_GRACE = float(os.environ.get("MISSION_CONTROL_RESUME_GRACE", "180"))
RESUME_TEXT = "Mission Control moved {id} back to In Progress: continue where you stopped."
LANDED_TEXT = ("Mission Control: what {id} waited for has landed. Rebase on {base} if it moved, then implement the "
               "approved plan.")
PR_TEXT = "Commit everything, push {branch} and open a pull request into {base}."
DEFAULT_BRANCH_TTL = 60.0
TITLE_LIMIT = 60
INTENT_BACKOFF = (2.0, 5.0, 15.0, 60.0)
INTENT_ATTEMPTS = 4
INTENT_WAIT = 15.0
MERGE_WAIT = 600.0
SCREEN_LINES = 500
VERB = {"start": "starting", "resume": "resuming", "stop": "stopping", "merge": "merging",
        "remove": "removing its worktree", "delete": "being deleted"}
CONTROL_SET_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
CONTROL_SETS_LIMIT = 200_000
SPAWN_LOG_LIMIT = 6000
PRESENTATION_INTERVAL = 30.0
SWEEP_INTERVAL = 60.0
WORKTREES_INTERVAL = 30.0
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


def prompt_title(prompt: str) -> str:
    """A task's title from its prompt: the first line, cut at a word boundary to TITLE_LIMIT characters."""
    line = prompt.strip().splitlines()[0].strip()
    if len(line) <= TITLE_LIMIT:
        return line
    head = line[:TITLE_LIMIT + 1]
    return (head.rsplit(" ", 1)[0].rstrip(" ,;:-") if " " in head else "") or line[:TITLE_LIMIT]


def project_id(repo: str) -> str:
    """A project's id: its main checkout's folder name, with a hash of its path when another registered project has that
    name."""
    name = os.path.basename(repo)
    if any(os.path.basename(p["repo"]) == name and not same_dir(p["repo"], repo) for p in store.projects):
        return f"{name}-{hashlib.sha1(os.path.realpath(repo).encode()).hexdigest()[:6]}"
    return name


DEFAULT_BRANCHES: Dict[str, Tuple[float, str]] = {}


def repo_default_branch(repo: str) -> str:
    """The repository's default branch, read again at most every DEFAULT_BRANCH_TTL seconds."""
    cached = DEFAULT_BRANCHES.get(repo)
    if cached and time.time() - cached[0] < DEFAULT_BRANCH_TTL:
        return cached[1]
    branch = default_branch(repo) if Path(repo).is_dir() else "main"
    DEFAULT_BRANCHES[repo] = (time.time(), branch)
    return branch


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
    return {"MISSION_CONTROL_TASK": t["id"], "MISSION_CONTROL_REPO": t["repo"], "MISSION_CONTROL_BRANCH": t["branch"],
            "MISSION_CONTROL_BASE": t["base"], "MISSION_CONTROL_WORKTREE": worktree}


# --- event hub ------------------------------------------------------------------

def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


class Hub:
    """Fans server-sent events out to every connected board and omp session; snapshots are coalesced. A task's omp session
    also takes commands (pause, message, control decisions, stop) and answers each one."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.subscribers: Dict["queue.Queue[str]", Dict[str, Any]] = {}
        self.dirty = threading.Event()
        self.answers: Dict[str, Dict[str, Any]] = {}

    def subscribe(self, meta: Dict[str, Any]) -> "queue.Queue[str]":
        """`meta`: the stream's session, project, task (a task's own session) and validated terminal context (each
        optional)."""
        q: "queue.Queue[str]" = queue.Queue(maxsize=2000)
        with self.lock:
            self.subscribers[q] = {**meta, "at": time.time()}
        return q

    def unsubscribe(self, q: "queue.Queue[str]") -> None:
        with self.lock:
            self.subscribers.pop(q, None)

    def project_live(self, project: str) -> bool:
        with self.lock:
            return any(m.get("project") == project for m in self.subscribers.values())

    def project_terminal(self, project: str) -> Optional[Dict[str, Any]]:
        """The terminal context of the most recently connected omp session streaming for `project`."""
        with self.lock:
            streams = sorted((m for m in self.subscribers.values() if m.get("project") == project and m.get("terminal")),
                             key=lambda m: m["at"], reverse=True)
        return streams[0]["terminal"] if streams else None

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
                                    "current Mission Control plugin")
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
RECORD_FILE = "task.json"
RECORD_KEYS = ("id", "title", "description", "column", "held", "dependsOn", "parent", "ticket", "tags", "notes", "repo",
               "base", "branch", "controlSet", "number", "createdAt", "updatedAt", "order", "spawn", "worktree", "presentation",
               "execution", "pr", "merged", "origin", "keptWorktree", "intent", "lastOperation", "resumedAt",
               "planned")
NEW_ID = re.compile(r"MC-(\d+)")


def new_intent(op: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """An operation the board's reconciler drives to its end, stage by stage, across board restarts."""
    return {"id": uuid.uuid4().hex, "op": op, "at": now_iso(), "stage": None, "params": params, "attempt": 0,
            "retryAt": None, "lastError": None, "log": ""}


class Store:
    """Tasks, one JSON record each (tasks/<id>/task.json), the registered projects (board.json) and live status: agents,
    git and pull requests of tasks, and the worktrees no task owns."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.tasks: Dict[str, Dict[str, Any]] = {}
        self.next_id = 1
        self.projects: List[Dict[str, Any]] = []
        self.worktrees: List[Dict[str, Any]] = []
        self.activity: Dict[str, Dict[str, Any]] = {}
        self.reports: Dict[str, Dict[str, Any]] = {}
        self.others: Dict[str, List[Dict[str, Any]]] = {}
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
        self.projects = [{"repo": p["repo"],
                          "controlSets": p.get("controlSets") if valid_set_summaries(p.get("controlSets")) else None,
                          "hidden": valid_hidden(p.get("hidden")), "tagRules": valid_tag_rules(p.get("tagRules"))}
                         for p in saved.get("projects") or [] if isinstance(p, dict) and isinstance(p.get("repo"), str)]
        next_id = saved.get("nextId")
        self.next_id = next_id if isinstance(next_id, int) and not isinstance(next_id, bool) and next_id > 0 else 1
        with self.lock:
            for folder in sorted(TASKS_DIR.iterdir()):
                m = NEW_ID.fullmatch(folder.name)
                if m:
                    self.next_id = max(self.next_id, int(m[1]) + 1)
                path = folder / RECORD_FILE
                if not path.is_file():
                    continue
                try:
                    t = json.loads(path.read_text(encoding="utf-8"))
                    if not isinstance(t, dict) or not isinstance(t.get("repo"), str):
                        raise ValueError("not a task record")
                except (OSError, ValueError) as e:
                    print(f"mission-control: skipped {path}: {e}", file=sys.stderr)
                    continue
                t["id"] = folder.name
                self.adopt(t)
        self.sweep_hosts()

    def adopt(self, t: Dict[str, Any]) -> None:
        """Takes a task record in as a card, with defaults for what it lacks (call under self.lock)."""
        for key, default in (("title", ""), ("description", ""), ("notes", ""), ("branch", ""), ("held", False)):
            if not isinstance(t.get(key), type(default)):
                t[key] = default
        for key in ("dependsOn", "tags"):
            t[key] = [v for v in t[key] if isinstance(v, str)] if isinstance(t.get(key), list) else []
        t["column"] = t.get("column") if t.get("column") in COLUMN_IDS else COLUMN_IDS[0]
        t["base"] = t.get("base") or default_branch(t["repo"])
        t["controlSet"] = t["controlSet"] if isinstance(t.get("controlSet"), str) and CONTROL_SET_ID.fullmatch(t["controlSet"]) else None
        t["createdAt"] = t.get("createdAt") or now_iso()
        t["updatedAt"] = t.get("updatedAt") or t["createdAt"]
        if not isinstance(t.get("spawn"), dict):
            t["spawn"] = {"state": "none", "error": None, "log": ""}
        if t["spawn"].get("state") == "running" and not t.get("intent"):
            t["intent"] = new_intent("start", {})
        if not isinstance(t.get("order"), (int, float)):
            t["order"] = self.next_order(t["column"])
        t.update(agent=None, git=None)
        self.tasks[t["id"]] = t

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
                    self.save(t)

    def task_dir(self, task_id: str) -> Path:
        return TASKS_DIR / task_id

    def save(self, t: Dict[str, Any]) -> None:
        """Writes a task's record (call under self.lock)."""
        t["updatedAt"] = now_iso()
        write_atomic(self.task_dir(t["id"]) / RECORD_FILE, json.dumps({k: t.get(k) for k in RECORD_KEYS}, indent=2))

    def create(self, t: Dict[str, Any]) -> None:
        """Gives a new task its id, MC-<n>, and writes it (call under self.lock)."""
        t["id"] = f"MC-{self.next_id}"
        self.next_id += 1
        self.save_board()
        self.tasks[t["id"]] = t
        self.save(t)

    def delete(self, task_id: str) -> None:
        """Deletes a card and its folder; the cards that depended on it or sat under it lose those links (call under
        self.lock)."""
        self.tasks.pop(task_id, None)
        self.activity.pop(task_id, None)
        self.others.pop(task_id, None)
        self.facts.pop(task_id, None)
        for other in self.tasks.values():
            if task_id in other["dependsOn"] or other.get("parent") == task_id:
                other["dependsOn"] = [d for d in other["dependsOn"] if d != task_id]
                if other.get("parent") == task_id:
                    other["parent"] = None
                self.save(other)
        shutil.rmtree(self.task_dir(task_id), ignore_errors=True)

    def save_board(self) -> None:
        write_atomic(BOARD_FILE, json.dumps({"nextId": self.next_id, "projects": self.projects}, indent=2))

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
            "base": t["base"],
            "controlSet": t.get("controlSet"),
            "tags": list(t["tags"]),
            "dependsOn": list(t["dependsOn"]),
            "parent": t.get("parent"),
            "children": children(t["id"]),
            "blockedBy": blocked_by(t),
            "paused": paused(t),
            "held": bool(t.get("held")),
            "planned": t.get("planned"),
            "moveRequiresConfirmation": move_requires_confirmation(t),
            "merged": t.get("merged"),
            "number": task_number(t),
            "intent": {k: intent.get(k) for k in ("op", "stage", "at", "attempt", "lastError")} if intent else None,
            "lastOperation": t.get("lastOperation"),
            "createdAt": t["createdAt"],
            "updatedAt": t["updatedAt"],
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
            "agents": self.others.get(t["id"], []),
            "git": t.get("git"),
            "pr": t.get("pr"),
            "land": land(t),
            "project": project_id(t["repo"]),
            "origin": t.get("origin"),
        }

    def project_list(self) -> List[Dict[str, Any]]:
        """Registered projects and projects that have tasks, while their main checkout exists or an omp session streams for
        them (call under self.lock)."""
        registered = {project_id(p["repo"]): p for p in self.projects}
        repos = {pid: p["repo"] for pid, p in registered.items()}
        owners = {t["id"]: project_id(t["repo"]) for t in self.tasks.values()}
        for t in self.tasks.values():
            repos.setdefault(owners[t["id"]], t["repo"])
        try:
            config = read_config()
        except ApiError:
            config = {}
        listed = []
        for pid, repo in repos.items():
            live = hub.project_live(pid)
            if not live and not Path(repo).is_dir():
                continue
            own = [t for t in self.tasks.values() if owners[t["id"]] == pid]
            trees = [w for w in self.worktrees if w["project"] == pid]
            entry = {"id": pid, "name": os.path.basename(repo), "repo": repo, "defaultBranch": repo_default_branch(repo),
                     "counts": {c: sum(1 for t in own if t["column"] == c) for c in COLUMN_IDS}, "live": live,
                     "controlSets": (registered.get(pid) or {}).get("controlSets"),
                     "hidden": list((registered.get(pid) or {}).get("hidden") or []),
                     "tagRules": copy.deepcopy((registered.get(pid) or {}).get("tagRules") or []),
                     "tags": sorted({tag for x in [*own, *trees] for tag in x["tags"]})}
            try:
                entry.update(project_scripts(entry["name"], config))
            except ApiError:
                entry.update(dict.fromkeys(SCRIPT_KEYS, ""))
            listed.append(entry)
        return sorted(listed, key=lambda p: p["id"])

    def board(self) -> Dict[str, Any]:
        with self.lock:
            tasks = sorted(self.tasks.values(),
                           key=lambda t: (COLUMN_IDS.index(t["column"]), t["order"], t["createdAt"]))
            return {
                "version": 2,
                "columns": [{"id": c, "title": title} for c, title in COLUMNS],
                "projects": self.project_list(),
                "themeVersion": self.theme_version,
                "tasks": [self.view(t) for t in tasks],
                "worktrees": sorted(self.worktrees, key=lambda w: (w["project"], w["branch"] or "", w["path"])),
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


# A card id in prose; one inside a path or name (tasks/MC-1, mc-MC-1) stays as it is.
TASK_REF = re.compile(r"(?<![\w/-])(?:MC|KB)-\d+(?:\.\d+)*\b")


def task_number(t: Dict[str, Any]) -> str:
    """The number people know a card by, counted per project."""
    return str(t.get("number") or t["id"])


def label(task_id: str) -> str:
    return f"#{task_number(store.tasks[task_id])}" if task_id in store.tasks else task_id


def with_numbers(text: str) -> str:
    """`text` with each card id replaced by its number (reads store.tasks without its lock, as errors can be raised under
    other locks)."""
    return TASK_REF.sub(lambda m: label(m[0]), text) if "store" in globals() else text


def next_number(repo: str) -> int:
    """One past the highest card number in the project at `repo`; its first card is 1 (call under store.lock)."""
    numbers = [int(n) for c in store.tasks.values() if same_dir(c["repo"], repo) for n in [task_number(c)] if n.isdigit()]
    return max(numbers, default=0) + 1


def has_started(t: Dict[str, Any]) -> bool:
    return spawned(t) or bool(t.get("merged")) or t.get("spawn", {}).get("state") in ("running", "done")


def paused(t: Dict[str, Any]) -> bool:
    """A started task in Waiting: its worktree and omp session stay, but its agent is stopped or idle."""
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
    """The open dependencies of a task and of each task above it in its parent tree."""
    found: List[str] = []
    for owner in [t, *(store.tasks[a] for a in ancestors(t.get("parent")) if a in store.tasks)]:
        for d in owner["dependsOn"]:
            if d not in found and d in store.tasks and store.tasks[d]["column"] != "done":
                found.append(d)
    return found


def registered_project(repo: str) -> Optional[Dict[str, Any]]:
    return next((p for p in store.projects if same_dir(p["repo"], repo)), None)


def move_requires_confirmation(t: Dict[str, Any]) -> bool:
    state = (t.get("agent") or {}).get("state")
    return t["column"] == "doing" or state in MOVE_GUARDED_AGENT_STATES


def land(t: Dict[str, Any]) -> Dict[str, Any]:
    """How a task's work lands: merged into its base when that is another task's branch (stacked), and through a pull
    request unless one is open; nothing once it is done."""
    pr = (t.get("pr") or {}).get("state")
    if t.get("merged") or t["column"] == "done" or pr == "merged":
        return {"mergeInto": None, "pr": False}
    return {"mergeInto": t["base"] if t["base"] != repo_default_branch(t["repo"]) else None,
            "pr": pr not in ("open", "draft")}


TAG = re.compile(r"[a-z0-9][a-z0-9._-]{0,31}")
TAGS_LIMIT = 8
TAGS_ERROR = "Tags are up to 8 short words: lowercase letters, digits, . _ -"


def validate_tags(value: Any) -> List[str]:
    """A task's tags: at most TAGS_LIMIT short lowercase words, deduplicated in order."""
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ApiError(400, TAGS_ERROR)
    tags = list(dict.fromkeys(v.strip().lower() for v in value))
    if len(tags) > TAGS_LIMIT or not all(TAG.fullmatch(v) for v in tags):
        raise ApiError(400, TAGS_ERROR)
    return tags


TAG_RULES_LIMIT = 50
TAG_RULES_ERROR = "Tag rules are up to 50 branch patterns, each followed by 1 to 8 tags"


def validate_tag_rules(value: Any) -> List[Dict[str, Any]]:
    """A project's tag rules: a branch-name pattern and the tags it gives, at most TAG_RULES_LIMIT of them."""
    if not isinstance(value, list) or len(value) > TAG_RULES_LIMIT:
        raise ApiError(400, TAG_RULES_ERROR)
    rules = []
    for rule in value:
        pattern = rule["pattern"].strip() if isinstance(rule, dict) and isinstance(rule.get("pattern"), str) else ""
        if not pattern or len(pattern) > 200 or any(c.isspace() for c in pattern):
            raise ApiError(400, TAG_RULES_ERROR)
        tags = validate_tags(rule.get("tags"))
        if not tags:
            raise ApiError(400, TAG_RULES_ERROR)
        rules.append({"pattern": pattern, "tags": tags})
    return rules


def valid_tag_rules(value: Any) -> List[Dict[str, Any]]:
    try:
        return validate_tag_rules(value)
    except ApiError:
        return []


def valid_hidden(value: Any) -> List[str]:
    return [b for b in value if isinstance(b, str) and b] if isinstance(value, list) else []


def rule_tags(repo: str, branch: str, path: Optional[str] = None) -> List[str]:
    """The tags a project's rules give a branch: those of every rule whose pattern matches the branch's name or its
    worktree's folder name, ignoring case."""
    names = [branch.lower()] + ([os.path.basename(path.rstrip("/")).lower()] if path else [])
    found: List[str] = []
    for rule in (registered_project(repo) or {}).get("tagRules", []):
        if any(fnmatch.fnmatchcase(name, rule["pattern"].lower()) for name in names):
            found += [x for x in rule["tags"] if x not in found]
    return found


def with_rule_tags(tags: List[str], repo: str, branch: str, path: Optional[str] = None) -> List[str]:
    """`tags`, then the tags the project's rules give `branch` and its worktree, while there are fewer than TAGS_LIMIT."""
    out = list(tags)
    for x in rule_tags(repo, branch, path):
        if x not in out and len(out) < TAGS_LIMIT:
            out.append(x)
    return out


def validate_control_set(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not CONTROL_SET_ID.fullmatch(value):
        raise ApiError(400, "Controls must be a control set id: lowercase letters, digits and dashes")
    return value


def depends_on(task_id: str, target: str) -> bool:
    """Whether `task_id` reaches `target` through dependencies or parent links, a graph the board keeps acyclic (call under
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


def validate_deps(task_id: str, value: Any, repo: str, parent: Optional[str]) -> List[str]:
    """A task's dependencies: existing task ids of the same repository, deduplicated, without the task itself, a cycle,
    or a task above or below it in the parent tree."""
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
        if dep in ancestors(parent):
            raise ApiError(400, f"{dep} is a parent of {task_id or 'this task'}, whose children already wait for what it waits for")
        if task_id and task_id in ancestors(d.get("parent")):
            raise ApiError(400, f"{dep} is a child of {task_id}; a task can't depend on its own children")
        if depends_on(dep, task_id):
            raise ApiError(400, f"{dep} already depends on {task_id}")
    return deps


def validate_parent(task_id: str, value: Any, repo: str, deps: List[str]) -> Optional[str]:
    """A task's parent (None clears it): an existing task of the same repository, neither under the task nor depending on
    it, whose parent tree holds none of the task's dependencies."""
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
    if task_id and depends_on(value, task_id):
        raise ApiError(400, f"{value} is under {task_id} or depends on it")
    clash = next((d for d in deps if d in ancestors(value)), None)
    if clash:
        raise ApiError(400, f"{task_id or 'This task'} depends on {clash}, which would be its parent or above it; "
                            "remove that dependency first")
    return value


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


def free_branch(repo: str, branch: str) -> str:
    """`branch`, else `branch-2`, `branch-3`… while a branch of that name exists or another task of the repository has it
    (call under store.lock)."""
    taken = {o["branch"] for o in store.tasks.values() if same_dir(o["repo"], repo)}
    candidate, n = branch, 1
    while candidate in taken or has_ref(repo, f"refs/heads/{candidate}"):
        n += 1
        candidate = f"{branch}-{n}"
    return candidate


# --- task mutations ---------------------------------------------------------------

def create_task(body: Dict[str, Any]) -> Dict[str, Any]:
    """Creates a task and starts it at once: its worktree branched from `base` (or from the branch of the task it comes
    `after`, which it then depends on), and its omp planning the prompt."""
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        raise ApiError(400, "A task needs a prompt")
    info = checkout_info(str(Path(str(body.get("repo") or "")).expanduser())) if body.get("repo") else None
    if not info:
        raise ApiError(400, f"{body.get('repo') or 'A task'} is not a git repository" if body.get("repo")
                       else "A task needs the repository it works in")
    origin = validate_origin(body["origin"]) if body.get("origin") is not None else None
    control_set = validate_control_set(body.get("controlSet"))
    tags = validate_tags(body.get("tags") or [])
    title = str(body.get("title") or "").strip() or prompt_title(prompt)
    repo = info["repo"]
    with store.lock:
        deps = body.get("dependsOn") or []
        if body.get("after"):
            after = store.get(str(body["after"]))
            if not same_dir(after["repo"], repo):
                raise ApiError(400, f"{after['id']} belongs to {os.path.basename(after['repo'])}, not "
                                    f"{os.path.basename(repo)}")
            base = after["branch"]
            deps = [*deps, after["id"]] if isinstance(deps, list) else deps
        elif body.get("base"):
            base = validate_branch(str(body["base"]))
            if not (has_ref(repo, f"refs/heads/{base}") or has_ref(repo, f"refs/remotes/origin/{base}")):
                raise ApiError(400, f"No branch {base} in {repo}")
        else:
            base = info["base"]
        stamp = now_iso()
        t: Dict[str, Any] = {
            "id": None, "title": title, "description": prompt, "column": "planning", "order": store.next_order("planning"),
            "held": False, "ticket": normalize_ticket(body.get("ticket")), "tags": tags, "notes": "", "repo": repo,
            "base": base, "branch": "", "controlSet": control_set, "createdAt": stamp, "updatedAt": stamp,
            "spawn": {"state": "none", "error": None, "log": ""}, "worktree": None, "presentation": None,
            "execution": None, "agent": None, "git": None, "pr": None, "merged": None, "origin": origin, "planned": None,
        }
        t["parent"] = validate_parent("", body.get("parent"), repo, deps if isinstance(deps, list) else [])
        t["dependsOn"] = validate_deps("", deps, repo, t["parent"])
        t["branch"] = validate_branch(str(body["branch"])) if body.get("branch") else free_branch(repo, store.suggest_branch(t))
        t["tags"] = with_rule_tags(tags, repo, t["branch"])
        t["number"] = next_number(repo)
        remember_project(repo)
        store.create(t)
        start_task(t)
        hub.changed()
        return store.view(t)


def validate_origin(value: Any) -> Dict[str, Any]:
    """The omp session a task was created from, with that session's terminal context."""
    if not isinstance(value, dict) or not isinstance(value.get("session"), str) or not value["session"].strip():
        raise ApiError(400, "origin needs a session")
    try:
        terminal = terminals.normalize_context(value["terminal"]) if value.get("terminal") is not None else {"kind": "plain"}
    except ValueError as e:
        raise ApiError(400, f"origin.terminal: {e}")
    return {"session": value["session"], "terminal": terminal}


def remember_project(repo: str) -> Dict[str, Any]:
    """The registered project of the main checkout `repo`, registering it first (call under store.lock)."""
    found = registered_project(repo)
    if not found:
        found = {"repo": repo, "controlSets": None, "hidden": [], "tagRules": []}
        store.projects.append(found)
        store.save_board()
    return found


def listed_project(project: Any) -> Dict[str, Any]:
    """The project the board lists as `project` (call under store.lock)."""
    found = next((p for p in store.project_list() if p["id"] == project), None)
    if not found:
        raise ApiError(404, f"Unknown project {project}")
    return found


def register_project(body: Dict[str, Any]) -> Dict[str, Any]:
    """Registers the repository containing `path` as a project, so it shows up before it has tasks."""
    path = str(body.get("path") or "")
    info = checkout_info(str(Path(path).expanduser()))
    if not info:
        raise ApiError(400, f"{path} is not a git repository")
    with store.lock:
        remember_project(info["repo"])
        project = listed_project(project_id(info["repo"]))
    hub.changed()
    return {"ok": True, "project": project}


def set_project_scripts(body: Dict[str, Any]) -> Dict[str, Any]:
    """Saves a project's scripts in config.json, keeping every other key; a value equal to the default follows it."""
    values = {}
    for key in SCRIPT_KEYS:
        if not isinstance(body.get(key), str):
            raise ApiError(400, f"{key} must be a string; empty means none")
        values[key] = body[key].strip()
    with store.lock:
        name = listed_project(body.get("id"))["name"]
        config = read_config()
        project_scripts(name, config)  # refuses malformed script settings before rewriting the file
        defaults = config_object(config, "defaults", "defaults")
        projects = dict(config_object(config, "projects", "projects"))
        own = dict(config_object(projects, name, f"projects.{name}"))
        for key, value in values.items():
            if value == (defaults.get(key) or "").strip():
                own.pop(key, None)
            else:
                own[key] = value
        if own:
            projects[name] = own
        else:
            projects.pop(name, None)
        if projects or "projects" in config:
            config["projects"] = projects
        write_atomic(CONFIG_FILE, json.dumps(config, indent=2, ensure_ascii=False) + "\n")
        project = listed_project(body.get("id"))
    hub.changed()
    return {"ok": True, "project": project}


def set_project_hidden(body: Dict[str, Any]) -> Dict[str, Any]:
    """Hides a branch's card or worktree from the project's page, or shows it again."""
    branch, hidden = body.get("branch"), body.get("hidden")
    if not isinstance(branch, str) or not branch.strip() or not isinstance(hidden, bool):
        raise ApiError(400, "Hiding needs a branch and hidden: true or false")
    with store.lock:
        project = remember_project(listed_project(body.get("id"))["repo"])
        project["hidden"] = [b for b in project["hidden"] if b != branch] + ([branch] if hidden else [])
        store.save_board()
        listed = listed_project(body.get("id"))
    hub.changed()
    return {"ok": True, "project": listed}


def set_project_tag_rules(body: Dict[str, Any]) -> Dict[str, Any]:
    """Saves a project's tag rules, then gives its open tasks and listed worktrees the tags their branch now matches."""
    rules = validate_tag_rules(body.get("rules"))
    with store.lock:
        project = remember_project(listed_project(body.get("id"))["repo"])
        project["tagRules"] = rules
        store.save_board()
        for t in store.tasks.values():
            if t["column"] != "done" and t.get("branch") and same_dir(t["repo"], project["repo"]):
                tags = with_rule_tags(t["tags"], t["repo"], t["branch"], t.get("worktree"))
                if tags != t["tags"]:
                    t["tags"] = tags
                    store.save(t)
        for w in store.worktrees:
            w["tags"] = rule_tags(w["repo"], w["branch"] or "", w["path"])
        listed = listed_project(body.get("id"))
    hub.changed()
    return {"ok": True, "project": listed}


def epoch(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def set_theme(body: Dict[str, Any]) -> Dict[str, Any]:
    """Records the omp theme of a session in `project` (in memory); the page shows that project in its colors."""
    project, scheme, colors = body.get("project"), body.get("scheme"), body.get("vars")
    if scheme not in ("dark", "light"):
        raise ApiError(400, "scheme must be dark or light")
    if not isinstance(colors, dict) or not all(k in THEME_VARS and isinstance(v, str) and THEME_COLOR.fullmatch(v)
                                               for k, v in colors.items()):
        raise ApiError(400, f"vars must map {', '.join(sorted(THEME_VARS))} to hex colors")
    theme = {"scheme": scheme, "vars": colors}
    with store.lock:
        listed_project(project)
        if store.themes.get(project) == theme:
            return {"ok": True}
        store.themes.pop(project, None)
        store.themes[project] = theme
        store.theme_version += 1
    hub.changed()
    return {"ok": True}


def update_task(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Changes a card's title, ticket, tags, dependencies or parent; its prompt and control set are fixed once it exists."""
    with store.lock:
        t = store.get(task_id)
        if "description" in body:
            raise ApiError(409, "The prompt is fixed once the task exists: send the agent a message")
        if "controlSet" in body:
            raise ApiError(409, "The control set is fixed once the task starts")
        if (t["column"] == "done" or t.get("merged")) and "title" in body:
            raise ApiError(409, f"{task_id} is done; create a new card")
        changes: Dict[str, Any] = {}
        if "title" in body:
            changes["title"] = str(body["title"] or "").strip()
            if not changes["title"]:
                raise ApiError(400, "A task needs a title")
        if "ticket" in body:
            changes["ticket"] = normalize_ticket(body["ticket"])
        if "tags" in body:
            changes["tags"] = validate_tags(body["tags"])
        wanted = body["dependsOn"] if "dependsOn" in body else t["dependsOn"]
        if "parent" in body:
            changes["parent"] = validate_parent(task_id, body["parent"], t["repo"],
                                                wanted if isinstance(wanted, list) else [])
        if "dependsOn" in body:
            changes["dependsOn"] = validate_deps(task_id, wanted, t["repo"], changes.get("parent", t.get("parent")))
        t.update(changes)
        store.save(t)
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
    """Starts a task: its start intent sets up its worktree and its omp, which plans first (call under store.lock)."""
    t["spawn"] = {"state": "running", "error": None, "log": ""}
    set_intent(t, "start", {})


def move_task(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Moves a card where a person may: Waiting pauses its agent (it stays held there until moved back), In Progress
    resumes a paused or stopped agent (or starts again a task whose start failed) once nothing it depends on is open,
    Done records it as done. Every other column is reached on its own. A card can't change column while an operation on
    it runs, except a resume that a pause turns into a stop."""
    column = body.get("column")
    if column not in COLUMN_IDS:
        raise ApiError(400, f"Unknown column {column!r}")
    if column not in MOVABLE_COLUMNS:
        raise ApiError(409, f"Cards reach {dict(COLUMNS)[column]} on their own")
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
        previous = t["column"]
        if column != previous and move_requires_confirmation(t) and body.get("confirmWorking") is not True:
            raise ApiError(409, f"{task_id} may still be working; confirm before moving it to {dict(COLUMNS)[column]}",
                           {"requiresConfirmation": "workingTask"})
        blockers = blocked_by(t) if column == "doing" else []
        if blockers and not body.get("force"):
            raise ApiError(409, f"{task_id} waits for {', '.join(blockers)}: move it with force to resume it now",
                           {"blockedBy": blockers})
        was_paused = paused(t)
        start = column == "doing" and not spawned(t) and t["spawn"]["state"] in ("none", "failed")
        # A task paused while it planned plans on.
        target = "planning" if start or (column == "doing" and previous == "waiting" and not t.get("planned")) else column
        if start and not Path(t["repo"]).is_dir():
            raise ApiError(400, f"Repository {t['repo']} not found")
        running = bool(facts and facts["agent_running"])
        resume = column == "doing" and spawned(t) and not t.get("merged") and (was_paused or not running)
        pause = column == "waiting" and not was_paused and spawned(t) and not t.get("merged")
        order = body.get("order")
        t["column"] = target
        t["order"] = float(order) if isinstance(order, (int, float)) else store.next_order(target)
        if column != "done":
            t["held"] = column == "waiting"
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
        if target == "done" and previous != "done":
            retarget_stacked(t)
        hub.changed()
        snapshot, view = dict(t), store.view(t)
    if pause:
        view["note"] = pause_agent(snapshot)
    poller.kick()
    return view


def planned_task(task_id: str) -> Dict[str, Any]:
    """Records that a task's plan was approved in its omp. A planning task goes In Progress, unless what it depends on is
    open: then it waits, and the reply tells its omp to hold until the board resumes it."""
    with store.lock:
        t = store.get(task_id)
        t["planned"] = now_iso()
        hold: Optional[List[str]] = None
        if t["column"] in ("planning", "doing"):
            blockers = blocked_by(t)
            if blockers:
                hold = blockers
                t["column"], t["order"], t["held"] = "waiting", store.next_order("waiting"), False
            elif t["column"] == "planning":
                t["column"], t["order"] = "doing", store.next_order("doing")
        store.save(t)
        waiting_for = [label(b) for b in hold or []]
    hub.changed()
    poller.kick()
    return {"hold": False} if hold is None else {"hold": True, "waitingFor": waiting_for}


def retarget_stacked(t: Dict[str, Any]) -> None:
    """Moves the unfinished tasks that branch from a task that just became done onto that task's own base, where its work
    landed (call under store.lock)."""
    for o in store.tasks.values():
        if o is not t and o["column"] != "done" and o["base"] == t["branch"] and same_dir(o["repo"], t["repo"]):
            o["base"] = t["base"]
            store.save(o)


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
    intent = new_intent(op, params)
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
        store.save(t)
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
        store.save(t)
    print(f"mission-control: {label(task_id)} {VERB[intent['op']]}, retrying: {error}", file=sys.stderr)
    hub.changed()


def fail_intent(task_id: str, intent: Dict[str, Any], error: str) -> None:
    """Gives an intent up: a start shows as failed, a resume holds its card in Waiting."""
    def failed(current: Dict[str, Any]) -> None:
        if intent["op"] == "start":
            current["spawn"] = {"state": "failed", "error": error,
                                "log": tail(current["intent"]["log"] + error, SPAWN_LOG_LIMIT)}
        elif intent["op"] == "resume":
            current["resumedAt"] = None
            if current["column"] == "doing":
                current["column"], current["order"], current["held"] = "waiting", store.next_order("waiting"), True
    with store.lock:
        log = ((store.tasks.get(task_id) or {}).get("intent") or {}).get("log") or ""
    if finish_intent(task_id, intent["id"], False, output=log, error=error, apply=failed):
        print(f"mission-control: {label(task_id)} gave up {VERB[intent['op']]}: {error}", file=sys.stderr)


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
    lines.append(f"Branch: {t['branch']} (from {t['base']})")
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
        lines += ["", "Read a sibling with mission_control_tasks when your work touches it; don't do its part."]
    if handoffs:
        lines += ["", "## Dependency handoffs", "",
                  "What the tasks this one depends on recorded, at the revision shown. Read the latest with mission_control_context."]
        for h in handoffs:
            lines += ["", handoff_text(h)]
    lines += ["", "## Prompt", "", t.get("description") or "(none)", ""]
    path = store.task_dir(t["id"]) / name
    write_atomic(path, with_numbers("\n".join(lines)))
    return path


def context_revision(notes: str) -> str:
    return hashlib.sha1(notes.encode("utf-8")).hexdigest()[:12]


def context_entries(notes: str) -> List[Dict[str, Any]]:
    """The entries in a task's notes, oldest first; text before the first entry is a note."""
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
    """A task's shared context: the entries of its notes."""
    with store.lock:
        notes = store.get(task_id)["notes"]
    entries = context_entries(notes)
    return {"id": task_id, "revision": context_revision(notes),
            "updatedAt": next((e["at"] for e in reversed(entries) if e["at"]), None), "entries": entries}


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
    """Appends a finding or outcome to a task's notes, stamped with its time, source task and branch@commit."""
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
    entry = f"### {kind} · {now_iso()} · {source} · {commit_ref(t)}\n{text}\n"
    with store.lock:
        current = store.get(task_id)
        notes = current["notes"].rstrip("\n")
        current["notes"] = f"{notes}\n\n{entry}" if notes else entry
        store.save(current)
    hub.changed()
    return task_context(task_id)


def dependency_handoffs(deps: List[str]) -> List[Dict[str, Any]]:
    """The shared context of a task's dependencies, for its brief; one deleted meanwhile is left out."""
    handoffs = []
    for d in deps:
        try:
            handoffs.append(task_context(d))
        except ApiError:
            continue
    return handoffs


def handoff_text(h: Dict[str, Any]) -> str:
    """A dependency's handoff: its latest outcome and latest findings, cut to HANDOFF_LIMIT characters."""
    title = store.tasks[h["id"]]["title"] if h["id"] in store.tasks else ""
    head = f"### {h['id']}: {title}" if title else f"### {h['id']}"
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
    text = f"{head} (revision {h['revision']}{more})\n\n" + "\n\n".join(blocks)
    if len(text) > HANDOFF_LIMIT:
        text = text[:HANDOFF_LIMIT].rstrip() + f"\n\n[cut; mission_control_context {h['id']} has all of it]"
    return text


def finish_text(t: Dict[str, Any]) -> str:
    """How a task's agent finishes: tell the user when it merges into another task's branch, else open a pull request."""
    if land(t)["mergeInto"]:
        return f"When the work is complete and verified, tell me; do not push: /land merges this branch into {t['base']}. "
    return f"When the work is complete and verified, commit it, push the branch and open a pull request into {t['base']}. "


def start_args(t: Dict[str, Any], brief: Path, config: Path) -> List[str]:
    """omp's arguments for a task's first start: its config (plan mode), its brief and the prompt to plan it (call under
    store.lock)."""
    blockers = blocked_by(t)
    wait = (f"It builds on {', '.join(label(b) for b in blockers)}, which haven't landed: once I approve your plan the "
            "board pauses you and resumes you when they have. ") if blockers else ""
    prompt = (f"Plan the task in the attached brief ({label(t['id'])}) before changing any file: explore the code, then "
              "propose the plan with xd://propose for my review. You are in a dedicated git worktree on branch "
              f"{t['branch']}, made from {t['base']}. {wait}{finish_text(t)}Ask me if anything in the brief is unclear.")
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
    omp finds the message it continues with in MISSION_CONTROL_RESUME_FILE."""
    omp = which("omp")
    if not omp:
        raise RuntimeError("omp isn't on the board's PATH")
    task_dir = store.task_dir(t["id"])
    env = [("MISSION_CONTROL_TASK", t["id"]), ("MISSION_CONTROL_PORT", str(PORT)), ("MISSION_CONTROL_HOME", str(HOME)),
           ("COLORTERM", "truecolor"), ("OMP_TERMINAL_PRESENTER", str(task_dir / "presenter.json"))]
    if os.environ.get("MISSION_CONTROL_LEASE_DIR"):
        env.append(("MISSION_CONTROL_LEASE_DIR", os.environ["MISSION_CONTROL_LEASE_DIR"]))
    if resume:
        env.append(("MISSION_CONTROL_RESUME_FILE", str(task_dir / "resume.json")))
    if t.get("controlSet"):
        env += [("OMP_CONTROL_SET", t["controlSet"]), ("OMP_CONTROL_BASE", t["base"])]
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
    env = {"MISSION_CONTROL_TASK": t["id"], "MISSION_CONTROL_TITLE": t["title"], "MISSION_CONTROL_REPO": t["repo"],
           "MISSION_CONTROL_BRANCH": t["branch"], "MISSION_CONTROL_BASE": t["base"],
           "MISSION_CONTROL_AGENT_COMMAND": f"/bin/sh {shlex.quote(str(launcher))}",
           "MISSION_CONTROL_SETUP_SCRIPT": os.path.expanduser(setup)}
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
        config = task_dir / "omp.yml"
        write_atomic(config, "plan:\n  defaultOnStartup: true\n")
        with store.lock:
            current = store.get(task_id)
            brief = write_brief(current, "brief.md", handoffs)
            args = start_args(current, brief, config)
            context = presentation_context(current)
        try:
            validate_branch(branch)
            agent_script(t, "launch.sh", args)
            if ex.get("kind") == "tmux" and detach.alive(ex):
                server = {k: ex.get(k) for k in ("server", "label", "socket")}
            else:
                server = detach.choose_server(context, detach_mode())
        except (RuntimeError, ApiError, detach.DetachError) as e:
            return "fail", error_text(e)
        (task_dir / "screen.ans").unlink(missing_ok=True)
        # Recorded before anything can start the agent, so its first stream and reports find their task.
        progress(task_id, iid, stage="worktree",
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
                    with store.lock:
                        # A task made after another branches from that task's branch, which its start creates.
                        base_starting = any(o["branch"] == base and (o.get("intent") or {}).get("op") == "start"
                                            and same_dir(o["repo"], repo) for o in store.tasks.values())
                    if base_starting and not has_ref(repo, f"refs/heads/{base}"):
                        return "wait", None
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


def agent_detail(report: Dict[str, Any], state: Optional[str]) -> Dict[str, Any]:
    """The run clock, to-do progress, latest sentence and question of a report, while they mean something."""
    active = state in STEP_STATES
    return {"startedAt": report.get("startedAt") if active else None, "todo": report.get("todo") if active else None,
            "said": report.get("said") if active else None,
            "question": report.get("question") if state == "needs_input" else None}


def agent_state(t: Dict[str, Any], connected: bool, running: bool) -> Dict[str, Any]:
    """What a started task's agent does: its omp's own report while its session is connected; disconnected while its
    process runs unconnected; else stopped."""
    activity = store.activity.get(t["id"]) or {}
    message = activity.get("message")
    if connected:
        state = activity.get("state") or "idle"
        return {"state": state, "message": message, "step": activity.get("step") if state in STEP_STATES else None,
                "since": activity.get("since"), **agent_detail(activity, state)}
    return {"state": "disconnected" if running else "stopped", "message": message, "step": None, "since": None,
            **agent_detail({}, None)}


def reported_detail(body: Dict[str, Any]) -> Dict[str, Any]:
    """The run clock (Unix seconds), to-do progress, latest sentence and question an omp reports, validated."""
    started = body.get("startedAt")
    valid_start = isinstance(started, int) and not isinstance(started, bool) and 0 < started <= time.time() + 60
    todo = body.get("todo")
    counts = [todo.get(k) for k in ("done", "total")] if isinstance(todo, dict) else []
    valid_todo = len(counts) == 2 and all(isinstance(n, int) and not isinstance(n, bool) for n in counts) \
        and 0 <= counts[0] <= counts[1] and counts[1] > 0
    line = lambda value, limit: plain(str(value or "").strip())[:limit] or None
    return {"startedAt": datetime.fromtimestamp(started, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            if valid_start else None,
            "todo": {"done": counts[0], "total": counts[1], "current": line(todo.get("current"), 200)} if valid_todo else None,
            "said": line(body.get("said"), 300), "question": line(body.get("question"), 300)}


def own_session(t: Dict[str, Any], session_id: str) -> bool:
    """Whether `session_id` is the task's own omp: its recorded session, or any while that one doesn't run (call under
    store.lock)."""
    recorded = ((t.get("execution") or {}).get("session") or {}).get("id")
    return not recorded or recorded == session_id or not lease.held(recorded)


def reporting_checkout(path: str) -> Tuple[Optional[Dict[str, Any]], str]:
    """The task whose worktree holds `path` with that worktree, else the listed worktree or registered main checkout that
    holds it; 404 outside them (call under store.lock)."""
    owners = [t for t in store.tasks.values() if t.get("worktree") and within(path, t["worktree"])]
    if owners:
        t = max(owners, key=lambda t: len(os.path.realpath(t["worktree"])))
        return t, t["worktree"]
    roots = [r for r in [*(w["path"] for w in store.worktrees), *(p["repo"] for p in store.projects)] if within(path, r)]
    if not roots:
        raise ApiError(404, f"No task or listed worktree at {path}")
    return None, max(roots, key=lambda r: len(os.path.realpath(r)))


def report_agent(body: Dict[str, Any]) -> Dict[str, Any]:
    """Records what an omp reports, by its session: its state, step, run clock, to-do progress, latest sentence, question
    and latest prompt. A task's own omp (the one the board started, else its recorded session while that runs) also
    drives the task's agent and goes in its execution record; `exited` marks a clean exit, which a later resume continues
    with --resume. Any other omp in a task's worktree, a listed worktree or a main checkout is listed beside it. A named
    task still starting is accepted before its worktree is recorded."""
    state = body.get("state")
    if state not in AGENT_STATES and state != "exited":
        raise ApiError(400, "State must be planning, thinking, working, plan_ready, needs_input, idle or exited")
    step = (plain(str(body.get("step") or "").strip())[:200] or None) if state in STEP_STATES else None
    message = submitted_text(body["message"][:MESSAGE_LIMIT]) if isinstance(body.get("message"), str) else None
    detail = reported_detail(body)
    session_id = text_field(body.get("sessionId"), 200)
    session_file = text_field(body.get("sessionFile"), 4096)
    session_file = session_file if session_file and os.path.isabs(session_file) else None
    title = (sessions.head(Path(session_file)) or {}).get("title") if session_file else None
    path = str(body.get("path") or "")
    named = text_field(body.get("task"), 100)
    with store.lock:
        if named:
            t = store.tasks.get(named)
            if not t or not (within(path, t["worktree"]) if t.get("worktree") else t["spawn"]["state"] == "running"):
                raise ApiError(404, f"{named} has no agent at {path}")
            checkout = t.get("worktree") or path
        else:
            t, checkout = reporting_checkout(path)
        task_id = t["id"] if t else None
        report = store.reports.get(session_id or "") or {}
        if session_id and state == "exited":
            store.reports.pop(session_id, None)
        elif session_id:
            store.reports[session_id] = {"checkout": checkout, "task": task_id, "title": title, "state": state, "step": step,
                                         "since": now_iso() if report.get("state") != state else report.get("since"),
                                         "message": message if message is not None else report.get("message"), **detail}
        if not t or not (named or not session_id or own_session(t, session_id)):
            if report.get("state") != state:
                poller.kick()
            return {"ok": True, "id": task_id}
        previous = store.activity.get(task_id) or {}
        if state == "exited":
            if t.get("execution"):
                t["execution"]["cleanExit"] = True
            store.activity[task_id] = {"state": None, "step": None, "since": None, "message": previous.get("message")}
            t["agent"] = agent_state(t, False, False)
            store.save(t)
            changed = prompted = True
            stepped = detailed = False
        else:
            changed = previous.get("state") != state
            prompted = message is not None and message != previous.get("message")
            detailed = any(previous.get(k) != v for k, v in detail.items())
            store.activity[task_id] = {"state": state, "step": step,
                                       "since": now_iso() if changed else previous.get("since"),
                                       "message": message if message is not None else previous.get("message"), **detail}
            agent = t.get("agent")
            stepped = not changed and previous.get("step") != step and bool(agent) and agent.get("state") == state
            if stepped:
                agent["step"] = step
    note_session(task_id, session_id, session_file)
    if changed or prompted or detailed:
        poller.kick()
    elif stepped:
        hub.publish("step", {"taskId": task_id, "step": step})
    return {"ok": True, "id": task_id}


def checkout_agents(path: str, running: List[Dict[str, Any]], exclude: Optional[str] = None) -> List[Dict[str, Any]]:
    """Every omp running in the checkout at `path` but session `exclude`: the sessions of its folder whose lease is held,
    newest first, then any other running session that reports from inside it, each with what it last reported (call
    without store.lock)."""
    with store.lock:
        reported = {sid: dict(r) for sid, r in store.reports.items() if same_dir(r["checkout"], path)}
    listed = {s["session"]["id"]: s for s in running}
    held = lease.held_any([sid for sid in reported if sid not in listed])
    out = []
    for sid in [*listed, *(sid for sid in reported if sid in held)]:
        if sid == exclude:
            continue
        r = reported.get(sid) or {}
        state = r.get("state") or "running"
        out.append({"id": sid, "title": listed[sid]["title"] if sid in listed else r.get("title"), "state": state,
                    "step": r.get("step") if state in STEP_STATES else None, "since": r.get("since"),
                    "message": r.get("message"), **agent_detail(r, state)})
    return out


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
            store.save(t)
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
    its project's latest session; plain without one (call under store.lock)."""
    origin = t.get("origin") or {}
    live = hub.session_terminal(origin["session"]) if origin.get("session") else None
    if live:
        return live
    if origin.get("terminal"):
        return origin["terminal"]
    return hub.project_terminal(project_id(t["repo"])) or {"kind": "plain"}


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
    and no terminal is ever closed. Returns the presentation and a note."""
    cwd = t["worktree"]
    shown = current if current and terminals.alive(current) else terminals.find_terminal(context, cwd)
    if shown and detach.status(ex)["attached"] > 0:
        presentation = {**shown, "alive": True}
        if focus and presentation.get("capabilities", {}).get("focus") and not terminals.focus(presentation):
            return presentation, "Its terminal didn't come forward"
        return presentation, None
    if shown and shown.get("kind") == "cmux" and detach.attach_in_cmux(ex, shown["cmux"], focus):
        return {**shown, "alive": True}, None
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
    """Brings forward the terminal showing a started task's agent, else one already in its worktree; never opens,
    attaches, closes, resumes or starts anything. Without one, the reply has the command attaching to its running agent
    and the path to cd to."""
    with store.lock:
        t = copy.deepcopy(store.get(task_id))
        path = require_spawned(t)
        context = presentation_context(t)
    ex, presentation = t.get("execution") or {}, t.get("presentation")
    found = presentation if presentation and terminals.alive(presentation) else terminals.find_terminal(context, path)
    if found:
        terminals.focus(found)
        return {"ok": True, "opened": True, "presentation": {**found, "alive": True}, "attachCommand": None}
    attach = detach.attach_command(ex) if ex.get("kind") == "tmux" and observe(t)["agent_running"] else None
    return {"ok": True, "opened": False, "presentation": None, "attachCommand": attach, "cd": f"cd {shlex.quote(path)}"}


def open_worktree(task_id: str) -> Dict[str, Any]:
    """Brings forward a terminal already in a started task's worktree (its agent's, or any surface in it); never opens,
    starts, resumes or closes anything. Without one, the reply has the path to cd to."""
    with store.lock:
        t = store.get(task_id)
        path = require_spawned(t)
        context, presentation = presentation_context(t), t.get("presentation")
    if not Path(path).is_dir():
        raise ApiError(409, f"The worktree {path} no longer exists")
    found = presentation if presentation and terminals.alive(presentation) else terminals.find_terminal(context, path)
    if found:
        terminals.focus(found)
    return {"ok": True, "worktree": path, "cd": f"cd {shlex.quote(path)}", "opened": bool(found)}


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


def valid_set_summaries(sets: Any) -> bool:
    return isinstance(sets, list) and len(sets) <= 100 and len(json.dumps(sets)) <= CONTROL_SETS_LIMIT and all(
        isinstance(s, dict) and isinstance(s.get("id"), str) and CONTROL_SET_ID.fullmatch(s["id"]) is not None
        and isinstance(s.get("name"), str) and isinstance(s.get("description"), str)
        and isinstance(s.get("controls"), list) and all(isinstance(c, str) for c in s["controls"])
        and s.get("approval") in ("apply", "ask")
        for s in sets)


def set_project_control_sets(body: Dict[str, Any]) -> Dict[str, Any]:
    """Records the Control sets a project's omp offers, so its new tasks can pick one; null clears them."""
    sets = body.get("sets")
    if sets is not None and not valid_set_summaries(sets):
        raise ApiError(400, "sets must be null or at most 100 control set summaries (id, name, description, controls, approval)")
    with store.lock:
        remember_project(listed_project(body.get("id"))["repo"])["controlSets"] = sets
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
    """Puts a resumed task's agent back to work: a running agent gets the resume message now; a stopped one restarts in
    tmux (continuing its omp session) and its omp sends the message itself from MISSION_CONTROL_RESUME_FILE, then posts
    /resumed. An agent that can't restart holds the card in Waiting."""
    task_id, iid, params = t["id"], intent["id"], intent["params"]
    stage = intent["stage"] or "launch"
    if stage == "launch":
        facts = observe(t)
        if not facts["worktree_present"]:
            return "fail", f"{label(task_id)} has no worktree"
        with store.lock:
            current = store.get(task_id)
            text = (LANDED_TEXT if params.get("landed") else RESUME_TEXT).format(id=label(task_id), base=current["base"])
            snapshot = copy.deepcopy(current)
        write_atomic(store.task_dir(task_id) / "resume.json", json.dumps({"text": text}))
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
    """A resumed task's omp delivered its resume message."""
    with store.lock:
        store.get(task_id)
        (store.task_dir(task_id) / "resume.json").unlink(missing_ok=True)
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
    """Ends a started task's agent and closes its terminal, keeping its worktree, branch and omp session; a planning or
    In Progress card is held in Waiting (Review and Pull Request cards stay). Moving it to In Progress resumes it."""
    with store.lock:
        t = store.get(task_id)
        require_spawned(t)
        if t["column"] == "done" or t.get("merged"):
            raise ApiError(409, f"{task_id} is done")
        intent = set_intent(t, "stop", {})
        # Held first: while omp exits, an idle In Progress card would otherwise read as ready for Review.
        if t["column"] in ("planning", "doing"):
            t["column"], t["order"], t["held"] = "waiting", store.next_order("waiting"), True
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
        env = {"MISSION_CONTROL_TASK": task_id, "MISSION_CONTROL_REPO": repo, "MISSION_CONTROL_BRANCH": branch,
               "MISSION_CONTROL_WORKTREE": path, "MISSION_CONTROL_TEARDOWN_SCRIPT": os.path.expanduser(teardown)}
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
    then closes every terminal left in it (the requester's own once replied) and ends its tmux session. A done card then
    forgets the worktree; an unfinished one, or with `delete` any, is deleted."""
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
    with store.lock:
        current = store.tasks.get(task_id)
        finished = bool(current) and (bool(current.get("merged")) or current["column"] == "done")
    if finished and not delete:
        def forgotten(current: Dict[str, Any]) -> None:
            forget_worktree(current)
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
    """Removes a started task's worktree and branch as a remove intent, deleting the card unless it is done; the reply
    says whether it is still pending."""
    requester = request_terminal(body)
    with store.lock:
        path = require_spawned(store.get(task_id))
    refuse_dirty_removal(path)
    with store.lock:
        intent = set_intent(store.get(task_id), "remove", {"requester": requester})
    await_intent(task_id, intent["id"], INTENT_WAIT)
    with store.lock:
        t = store.tasks.get(task_id)
        pending = t is not None and (t.get("intent") or {}).get("id") == intent["id"]
        last = {} if pending or t is None else (t.get("lastOperation") or {})
    if last and not last.get("ok"):
        raise ApiError(409, last.get("error") or f"{label(task_id)}'s worktree wasn't removed",
                       {"output": last.get("output") or ""})
    after_reply(lambda: replied_or_close(task_id, path, requester))
    if t is None:
        return {"ok": True, "output": DELETED_OUTPUT.pop(intent["id"], "").strip(), "pending": False, "deleted": True}
    return {"ok": True, "output": (last.get("output") or "").strip(), "pending": pending}


def forget_worktree(t: Dict[str, Any]) -> None:
    """Drops a done task's worktree, agent and terminal records and its live state (call under store.lock)."""
    task_id = t["id"]
    t.update(worktree=None, presentation=None, execution=None, agent=None, git=None)
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
    """Refuses to remove a card for its missing worktree unless it is unfinished and its recorded worktree is gone (call
    under store.lock)."""
    task_id = t["id"]
    path = require_spawned(t)
    if t["column"] == "done" or t.get("merged"):
        raise ApiError(409, f"{task_id} is done")
    if t["spawn"]["state"] == "running":
        raise ApiError(409, f"{task_id} is still starting")
    if Path(path).is_dir():
        raise ApiError(409, f"{task_id}'s worktree {path} still exists; stop the task, or clean it up to remove it")


def recover_task(task_id: str) -> Dict[str, Any]:
    """Removes the card of a started task whose worktree was deleted outside the board. It never stops, starts or resumes
    an agent, so one that still runs is refused."""
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
        store.delete(task_id)
    if ex.get("kind") == "external" and ex.get("dir"):
        shutil.rmtree(ex["dir"], ignore_errors=True)
    hub.changed()
    poller.kick()
    return {"ok": True, "deleted": True}


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
    subject = f"Task {task_number(store.tasks[task_id])}: {' '.join(plain(title).splitlines()).strip() or 'Mission Control task'}"
    code, out, error = run(["git", "-C", path, "commit", "-m", subject], timeout=120)
    if code != 0:
        raise ApiError(409, "Could not commit the task changes", {"output": (out + error).strip()})
    code, sha, error = run(["git", "-C", path, "rev-parse", "--short", "HEAD"], timeout=10)
    if code != 0 or not sha.strip():
        raise ApiError(500, "Committed the task changes but could not read the commit", {"output": error.strip()})
    return sha.strip()


MERGE_LOCK = threading.Lock()


def merge_task(task_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Merges a stacked task into its base (another task's branch) as a merge intent, then (as the intent it chains into)
    removes its worktree with `cleanup`, else stops its agent and closes its worktree's terminals. Replies once the merge
    itself is over. A task from the default branch lands through a pull request instead."""
    requester = request_terminal(body)
    with store.lock:
        t = store.get(task_id)
        path = require_spawned(t)
        if not t.get("merged") and t["base"] == repo_default_branch(t["repo"]):
            raise ApiError(409, f"{task_id} branches from {t['base']}, the default branch: it lands through a pull request")
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
            retarget_stacked(current)
    after = new_intent("remove" if params.get("cleanup") else "stop",
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
    repo, branch, base, title = t["repo"], t["branch"], t["base"], t["title"]
    commit_sha = None
    rebased = False
    with MERGE_LOCK:
        target = find_worktree(repo, base)
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
            # A merge that landed without being recorded (an interrupted /land) finishes the task instead of failing.
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
                    f"`/land` found a merge conflict and started `git rebase {base}`. "
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
                    message += "; resolve them in the task worktree, then retry /land"
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


def failure(output: str, fallback: str) -> str:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return lines[-1] if lines else fallback


def create_pr(task_id: str) -> Dict[str, Any]:
    """Opens a task's pull request into its base: its live agent is asked to (it commits and pushes what it has), else the
    board pushes the committed branch and runs gh pr create."""
    with store.lock:
        t = copy.deepcopy(store.get(task_id))
    path = require_spawned(t)
    pr = t.get("pr") or {}
    if pr.get("state") in ("open", "draft"):
        raise ApiError(409, f"{task_id} already has pull request #{pr['number']}")
    if not which("gh"):
        raise ApiError(409, "gh isn't installed")
    branch, base = t["branch"], t["base"]
    if hub.task_live(task_id) and not paused(t) and (t.get("agent") or {}).get("state") not in HELD_STATES:
        message_agent(task_id, {"text": PR_TEXT.format(branch=branch, base=base)})
        return {"ok": True, "via": "agent"}
    if not Path(path).is_dir():
        raise ApiError(409, f"The worktree {path} no longer exists")
    _, status, _ = run(["git", "-C", path, "status", "--porcelain"], timeout=30)
    if status.strip():
        raise ApiError(409, "Commit the uncommitted changes first", {"output": status})
    _, mb = merge_base(path, base)
    _, ahead, _ = run(["git", "-C", path, "rev-list", "--count", f"{mb}..HEAD"], timeout=15)
    if not ahead.strip().isdigit() or int(ahead) == 0:
        raise ApiError(409, "Nothing to open a pull request for")
    if run(["git", "-C", path, "ls-remote", "--exit-code", "--heads", "origin", base], timeout=30)[0] != 0:
        raise ApiError(409, f"Push {base} first: it isn't on origin")
    code, out, err = run(["git", "-C", path, "push", "-u", "origin", branch], timeout=120)
    if code != 0:
        raise ApiError(409, failure(out + err, "git push failed"), {"output": tail(out + err, SPAWN_LOG_LIMIT)})
    code, out, err = run(["gh", "pr", "create", "--base", base, "--head", branch, "--fill"], cwd=path, timeout=60)
    if code != 0:
        raise ApiError(409, failure(out + err, "gh pr create failed"), {"output": tail(out + err, SPAWN_LOG_LIMIT)})
    poller.kick(full=True)
    return {"ok": True, "via": "gh", "url": failure(out, "")}


PR_FIELDS = "number,state,url,title,isDraft,headRefName,baseRefName"
CHECK_FAILED = {"FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}


def checks_state(rollup: Any) -> Optional[str]:
    """A pull request's checks in one word, from gh's statusCheckRollup: failing, pending, passing, or None without any."""
    items = [i for i in rollup if isinstance(i, dict)] if isinstance(rollup, list) else []
    if any(i.get("conclusion") in CHECK_FAILED or i.get("state") in ("FAILURE", "ERROR") for i in items):
        return "failing"
    if any(i.get("status") not in (None, "COMPLETED") or i.get("state") in ("PENDING", "EXPECTED") for i in items):
        return "pending"
    return "passing" if items else None


def pr_record(found: Dict[str, Any], detailed: bool) -> Dict[str, Any]:
    state = str(found["state"]).lower()
    if state == "open" and found.get("isDraft"):
        state = "draft"
    record = {"number": found["number"], "state": state, "url": found["url"], "title": found["title"],
              "base": found.get("baseRefName"), "review": None, "checks": None, "conflicts": False, "unresolved": 0}
    if detailed:
        record.update(review=str(found.get("reviewDecision") or "").lower() or None,
                      checks=checks_state(found.get("statusCheckRollup")), conflicts=found.get("mergeable") == "CONFLICTING")
    return record


def fetch_prs(repo: str) -> Optional[Dict[str, Dict[str, Any]]]:
    """The pull requests of `repo` by head branch: open ones with their review, checks and conflicts, then the latest of
    any state for the other branches; None when gh can't list them."""
    lists = []
    for state, limit, fields in (("open", "100", PR_FIELDS + ",reviewDecision,mergeable,statusCheckRollup"),
                                 ("all", "200", PR_FIELDS)):
        code, out, _ = run(["gh", "pr", "list", "--state", state, "--limit", limit, "--json", fields], cwd=repo, timeout=45)
        if code != 0:
            return None
        try:
            lists.append(json.loads(out))
        except ValueError:
            return None
    prs: Dict[str, Dict[str, Any]] = {}
    for detailed, found in ((True, lists[0]), (False, lists[1])):
        for pr in found if isinstance(found, list) else []:
            try:
                prs.setdefault(pr["headRefName"], pr_record(pr, detailed))
            except (KeyError, TypeError):
                continue
    for branch, count in unresolved_threads(repo).items():
        if (prs.get(branch) or {}).get("state") in ("open", "draft"):
            prs[branch]["unresolved"] = count
    return prs


REVIEW_THREADS_QUERY = """query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { headRefName reviewThreads(first: 100) { nodes { isResolved } } }
    }
  }
}"""


def unresolved_threads(repo: str) -> Dict[str, int]:
    """The unresolved review threads on `repo`'s open pull requests, by head branch; empty when gh can't tell."""
    code, out, _ = run(["gh", "api", "graphql", "-F", "owner={owner}", "-F", "name={repo}",
                        "-f", "query=" + REVIEW_THREADS_QUERY], cwd=repo, timeout=45)
    try:
        nodes = json.loads(out)["data"]["repository"]["pullRequests"]["nodes"] if code == 0 else []
        return {n["headRefName"]: sum(1 for x in n["reviewThreads"]["nodes"] if not x.get("isResolved")) for n in nodes}
    except (ValueError, KeyError, TypeError):
        return {}


def pr_column(column: str, pr: Optional[Dict[str, Any]]) -> str:
    """Where a task belongs by its pull request: Done once merged, Pull Request while open, back In Progress when it was
    closed or is gone."""
    state = (pr or {}).get("state")
    if state == "merged":
        return "done"
    if state in ("open", "draft") and column in ("planning", "waiting", "doing", "review"):
        return "pr"
    if column == "pr" and state not in ("open", "draft"):
        return "doing"
    return column


def worktree_column(pr: Optional[Dict[str, Any]]) -> str:
    """The column of a worktree no task owns: Done once its pull request merged, Pull Request while one is open."""
    state = (pr or {}).get("state")
    return "done" if state == "merged" else "pr" if state in ("open", "draft") else "doing"


def adopt_worktree(body: Dict[str, Any]) -> Dict[str, Any]:
    """Tracks a linked worktree as a task: the task that owns it, else a new card for it, planned already. An omp running
    there becomes its agent; else `session` names one of its omp sessions that moving the card In Progress reopens, and
    without one that starts omp --continue there."""
    path = str(body.get("path") or "")
    top = git_toplevel(str(Path(path).expanduser())) if path else None
    info = checkout_info(top) if top else None
    code, branch, _ = run(["git", "-C", top, "symbolic-ref", "-q", "--short", "HEAD"], timeout=10) if top else (1, "", "")
    branch = branch.strip()
    if not info or same_dir(info["repo"], top) or code != 0 or not branch:
        raise ApiError(400, f"{path} is not a linked worktree on a branch")
    title = str(body.get("title") or "").strip() or branch
    tags = validate_tags(body.get("tags") or [])
    repo = info["repo"]
    base = branch_base(repo, branch, repo_default_branch(repo))
    pr = (poller.prs.get(repo) or {}).get(branch)
    agent = sessions.agent(top)
    execution = None
    if agent["state"] == "running":
        execution = external_execution(agent["session"])
    elif body.get("session"):
        chosen = sessions.find(top, str(body["session"]))
        if not chosen:
            raise ApiError(400, f"{top} has no omp session {body['session']}")
        # Reopened as it was left, never continuing an interrupted turn on its own.
        execution = {**external_execution({"id": sessions.session_id(chosen), "file": str(chosen)}), "cleanExit": True}
    with store.lock:
        owner = next((t for t in store.tasks.values() if same_dir(t.get("worktree"), top)), None)
        if owner:
            return store.view(owner)
        remember_project(repo)
        stamp, column = now_iso(), worktree_column(pr)
        t: Dict[str, Any] = {
            "id": None, "title": title, "description": "", "column": column, "order": store.next_order(column),
            "held": False, "ticket": None, "tags": with_rule_tags(tags, repo, branch, top), "notes": "", "repo": repo,
            "base": base, "branch": branch,
            "controlSet": None, "createdAt": stamp, "updatedAt": stamp, "spawn": {"state": "done", "error": None, "log": ""},
            "worktree": top, "presentation": None, "execution": execution, "agent": None, "git": None, "pr": pr,
            "merged": None, "origin": None, "planned": stamp, "dependsOn": [], "parent": None, "number": next_number(repo),
        }
        store.create(t)
        store.worktrees = [w for w in store.worktrees if not same_dir(w["path"], top)]
        view = store.view(t)
    hub.changed()
    poller.kick(full=True)
    return view


def listed_worktree(path: str) -> Dict[str, Any]:
    """A copy of the worktree no task owns that the board lists at `path` (call under store.lock); 404 without one."""
    found = next((w for w in store.worktrees if path and same_dir(w["path"], path)), None)
    if not found:
        raise ApiError(404, f"{path} isn't a worktree the board lists without a task")
    return copy.deepcopy(found)


def open_listed_worktree(body: Dict[str, Any]) -> Dict[str, Any]:
    """Brings forward a terminal already in a checkout no task owns (the one its omp runs in, or any surface in it),
    without making it a card; never opens, starts or stops anything. Without one, the reply has the path to cd to."""
    with store.lock:
        w = listed_worktree(str(body.get("path") or ""))
        context = hub.project_terminal(w["project"]) or {"kind": "plain"}
    path = w["path"]
    found = terminals.find_terminal(context, path)
    if found:
        terminals.focus(found)
    return {"ok": True, "worktree": path, "cd": f"cd {shlex.quote(path)}", "opened": bool(found)}


def resume_listed_worktree(body: Dict[str, Any]) -> Dict[str, Any]:
    """Reopens one of a listed checkout's omp sessions in a new terminal there, without a card (the main checkout and a
    worktree on a detached HEAD can't be one). Plain opens nothing and returns the command to run."""
    with store.lock:
        w = listed_worktree(str(body.get("path") or ""))
        context = hub.project_terminal(w["project"]) or {"kind": "plain"}
    path = w["path"]
    if sessions.agent(path)["state"] == "running":
        raise ApiError(409, f"omp already runs in {path}")
    chosen = sessions.find(path, str(body.get("session") or ""))
    if not chosen:
        raise ApiError(400, f"{path} has no omp session {body.get('session') or ''}".rstrip())
    omp = which("omp")
    if not omp:
        raise ApiError(500, "omp isn't on the board's PATH")
    command = shlex.join([omp, "--resume", str(chosen)])
    run_here = f"cd {shlex.quote(path)} && {command}"
    try:
        terminal = terminals.open_terminal(context, w["branch"] or os.path.basename(path), path, command)
        if terminal["kind"] != "plain":
            terminals.focus(terminal)
    except (RuntimeError, OSError, KeyError, ValueError) as e:
        raise ApiError(500, f"Couldn't open a terminal in {path} ({e}); run: {run_here}")
    poller.kick()
    return {"ok": True, "command": run_here, "kind": terminal["kind"], "opened": terminal["kind"] != "plain"}


def remove_listed_worktree(body: Dict[str, Any]) -> Dict[str, Any]:
    """Removes a worktree on a detached HEAD that no task owns, and closes the terminals in it; refused while omp runs
    there or it has uncommitted changes. A worktree on a branch is removed through its card, with its branch."""
    with store.lock:
        w = listed_worktree(str(body.get("path") or ""))
        contexts = [c for c in (hub.project_terminal(w["project"]),) if c]
    path = w["path"]
    if w.get("main"):
        raise ApiError(409, f"{path} is the project's main checkout")
    if w["branch"]:
        raise ApiError(409, f"{path} is on {w['branch']}: track it as a task to remove it with its branch")
    if sessions.agent(path)["state"] == "running":
        raise ApiError(409, f"omp runs in {path}: end it first")
    _, status, _ = run(["git", "-C", path, "status", "--porcelain"], timeout=30)
    if status.strip():
        raise ApiError(409, f"{path} has uncommitted changes")
    code, out, err = run(["git", "-C", w["repo"], "worktree", "remove", path], timeout=120)
    if code != 0:
        raise ApiError(500, (err or out).strip() or f"git worktree remove exited with code {code}")
    terminals.close_terminals(path, contexts)
    with store.lock:
        store.worktrees = [x for x in store.worktrees if not same_dir(x["path"], path)]
    hub.changed()
    poller.kick(full=True)
    return {"ok": True}


STEPS: Dict[str, Callable[[Dict[str, Any], Dict[str, Any]], Outcome]] = {
    "start": step_start, "resume": step_resume, "stop": step_stop, "merge": step_merge, "remove": step_remove,
    "delete": step_delete}


# --- status poller --------------------------------------------------------------------

def recently_failed_removal(t: Dict[str, Any]) -> bool:
    last = t.get("lastOperation") or {}
    return last.get("op") == "remove" and not last.get("ok") and time.time() - epoch(last["at"]) < 3600


def git_stats(path: str, base: str) -> Optional[Dict[str, Any]]:
    """A worktree's work since it left `base`: lines added and removed, files, commits, uncommitted files and its newest
    own commit (subject and time); None once the worktree is gone."""
    if not Path(path).is_dir():
        return None
    _, mb = merge_base(path, base)
    added = removed = files = 0
    code, out, _ = run(["git", "-C", path, "diff", "--numstat", mb], timeout=30)
    for line in out.splitlines() if code == 0 else []:
        a, r, _name = (line.split("\t", 2) + ["", ""])[:3]
        files += 1
        added += int(a) if a.isdigit() else 0
        removed += int(r) if r.isdigit() else 0
    _, commits, _ = run(["git", "-C", path, "rev-list", "--count", f"{mb}..HEAD"], timeout=15)
    _, status, _ = run(["git", "-C", path, "status", "--porcelain"], timeout=30)
    code, newest, _ = run(["git", "-C", path, "log", "-1", "--format=%s%x00%cI", f"{mb}..HEAD"], timeout=15)
    subject, _, at = newest.strip().partition("\0")
    return {"added": added, "removed": removed, "files": files,
            "commits": int(commits.strip()) if commits.strip().isdigit() else 0,
            "dirty": len([l for l in status.splitlines() if l.strip()]),
            "last": {"subject": subject, "at": at} if code == 0 and subject and at else None}


class Poller:
    """Keeps spawned tasks' agent, git and PR status current, moves cards on approval, local readiness and PR state,
    resumes the waiting tasks whose dependencies are done, and runs a worker for each pending intent."""

    def __init__(self) -> None:
        self.wake = threading.Event()
        self.forced = False
        self.last_git = 0.0
        self.last_pr = 0.0
        self.last_presentation = 0.0
        self.last_sweep = 0.0
        self.last_worktrees = 0.0
        self.prs: Dict[str, Dict[str, Dict[str, Any]]] = {}

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
                print(f"mission-control: poll failed: {e!r}", file=sys.stderr)

    def tick(self, forced: bool) -> None:
        changed = False
        with store.lock:
            tracked = [dict(t) for t in store.tasks.values() if spawned(t)]
        self.prune_reports()
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
        if forced or now - self.last_worktrees >= WORKTREES_INTERVAL:
            self.last_worktrees = now
            changed |= self.check_worktrees()
        else:
            changed |= self.check_worktree_agents()
        changed |= self.check_waiting()
        sweep = forced or now - self.last_sweep >= SWEEP_INTERVAL
        if sweep:
            self.last_sweep = now
            self.sweep_leftovers()
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

    def check_waiting(self) -> bool:
        """Resumes the waiting tasks whose plan is approved, that no person holds and whose dependencies are done."""
        with store.lock:
            ready = [t for t in store.tasks.values() if t["column"] == "waiting" and not t.get("intent")
                     and not t.get("held") and t.get("planned") and spawned(t) and not blocked_by(t)]
            for t in ready:
                t["column"], t["order"] = "doing", store.next_order("doing")
                set_intent(t, "resume", {"landed": True})
        return bool(ready)

    def check_agents(self, tracked: List[Dict[str, Any]]) -> bool:
        """Agent state from what runs (observe: the omp session lease, the tmux pane) and from each task's own omp session
        (its stream and reports); terminals are only asked now and then whether they are still open, which never decides
        the agent's state. An agent that exited leaves its last screen, then its tmux session ends."""
        facts = {s["id"]: observe(s) for s in tracked}
        others = {s["id"]: checkout_agents(s["worktree"], sessions.agent(s["worktree"])["running"],
                                           ((s.get("execution") or {}).get("session") or {}).get("id"))
                  for s in tracked if s.get("worktree") and Path(s["worktree"]).is_dir()}
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
                if others.get(task_id, []) != store.others.get(task_id, []):
                    store.others[task_id] = others.get(task_id, [])
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
        """Each worktree's work; a planning task with no open dependency that already commits or edits files moves In
        Progress (its plan mode was left in its omp)."""
        results = {t["id"]: git_stats(t["worktree"], t["base"]) for t in tracked}
        changed = False
        with store.lock:
            for task_id, git in results.items():
                t = store.tasks.get(task_id)
                if not t:
                    continue
                if t.get("git") != git:
                    t["git"] = git
                    changed = True
                if t["column"] == "planning" and git and (git["dirty"] or git["commits"]) and not t.get("intent") \
                        and not blocked_by(t):
                    t["column"], t["order"] = "doing", store.next_order("doing")
                    store.save(t)
                    changed = True
        return changed

    def check_ready(self, tracked: List[Dict[str, Any]]) -> bool:
        """Moves In Progress tasks to Review once their agent stopped with committed work and a clean worktree."""
        changed = False
        with store.lock:
            for snapshot in tracked:
                t = store.tasks.get(snapshot["id"])
                if not t or t["column"] != "doing" or t.get("intent") or (t.get("pr") or {}).get("state") in ("open", "draft"):
                    continue
                if t.get("resumedAt"):
                    # A resumed agent reads idle or closed until it picks up its resume message.
                    active = (t.get("agent") or {}).get("state") in ACTIVE_STATES
                    if active or time.time() - epoch(t["resumedAt"]) >= RESUME_GRACE:
                        t["resumedAt"] = None
                        store.save(t)
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
        """The pull requests of every project, then each task's, and the column it puts the task in."""
        with store.lock:
            repos = {p["repo"] for p in store.project_list()}
        if not repos or not which("gh"):
            return False
        for repo in repos:
            prs = fetch_prs(repo)
            if prs is not None:
                self.prs[repo] = prs
        changed = False
        with store.lock:
            for snapshot in tracked:
                t = store.tasks.get(snapshot["id"])
                prs = self.prs.get(snapshot["repo"])
                if not t or prs is None:
                    continue
                pr = prs.get(t["branch"])
                column = pr_column(t["column"], pr)
                if pr == t.get("pr") and column == t["column"]:
                    continue
                done = column == "done" and t["column"] != "done"
                if column != t["column"]:
                    t["column"], t["order"] = column, store.next_order(column)
                t["pr"] = pr
                store.save(t)
                if done:
                    retarget_stacked(t)
                    if spawned(t) and not t.get("intent"):
                        set_intent(t, "stop", {})
                changed = True
        return changed

    def check_worktrees(self) -> bool:
        """The checkouts that no task owns, of every project: its main checkout and its linked worktrees, on a branch or
        a detached HEAD, with their work, pull request and every omp running there."""
        with store.lock:
            repos = [p["repo"] for p in store.project_list()]
            owned = [t["worktree"] for t in store.tasks.values() if t.get("worktree")]
        found = []
        for repo in repos:
            default = repo_default_branch(repo)
            for i, (path, branch) in enumerate(registered_worktrees(repo)):
                if not os.path.isdir(path) or any(same_dir(path, o) for o in owned):
                    continue
                detached = None
                if not branch:
                    code, head, _ = run(["git", "-C", path, "rev-parse", "--short", "HEAD"], timeout=10)
                    if code != 0 or not head.strip():
                        continue
                    detached = head.strip()
                base = branch_base(repo, branch, default) if branch and i else default
                pr = (self.prs.get(repo) or {}).get(branch) if branch and i else None
                agent = sessions.agent(path)
                found.append({"path": path, "project": project_id(repo), "repo": repo, "branch": branch, "main": i == 0,
                              "detached": detached, "base": base, "git": git_stats(path, base), "pr": pr,
                              "column": worktree_column(pr), "agent": {k: v for k, v in agent.items() if k != "running"},
                              "agents": checkout_agents(path, agent["running"])})
        with store.lock:
            for w in found:
                w["tags"] = rule_tags(w["repo"], w["branch"] or "", w["path"])
            changed = found != store.worktrees
            store.worktrees = found
        return changed

    def check_worktree_agents(self) -> bool:
        """Each listed checkout's omp, between full scans: those running there now, else its latest session."""
        with store.lock:
            paths = [w["path"] for w in store.worktrees]
        agents = {path: sessions.agent(path) for path in paths}
        views = {path: checkout_agents(path, a["running"]) for path, a in agents.items()}
        changed = False
        with store.lock:
            for w in store.worktrees:
                if w["path"] not in agents:
                    continue
                agent = {k: v for k, v in agents[w["path"]].items() if k != "running"}
                if agent != w.get("agent") or views[w["path"]] != w.get("agents"):
                    w["agent"], w["agents"] = agent, views[w["path"]]
                    changed = True
        return changed

    def prune_reports(self) -> None:
        """Forgets the reports of omp sessions that no longer run."""
        with store.lock:
            ids = list(store.reports)
        held = lease.held_any(ids)
        with store.lock:
            for sid in ids:
                if sid not in held:
                    store.reports.pop(sid, None)


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


def appearance_css(project: str) -> str:
    """The terminal's colors and font under `project`'s omp theme (else the latest sent); the theme's background only when
    its scheme differs."""
    base = appearance()
    with store.lock:
        theme = store.themes.get(project) or next(reversed(store.themes.values()), None)
    if not theme:
        return base["css"]
    own_bg = base["scheme"] != theme["scheme"] and "--bg" in theme["vars"]
    decls = ([f"color-scheme: {theme['scheme']}"] if own_bg else []) + \
        [f"{k}: {v}" for k, v in theme["vars"].items() if own_bg or k not in ("--bg", "--fg")]
    return base["css"] + ":root {\n" + "".join(f"  {d};\n" for d in decls) + "}\n"


# --- HTTP ---------------------------------------------------------------------------------

STATIC_ASSETS = {"/design-system.css", "/markdown.js", "/graph-layout.js", "/pipeline.js", "/pipeline.css", "/workbench.js",
                 "/workbench.css", "/links.js", "/links.css"}


def refresh() -> Dict[str, Any]:
    poller.kick(full=True)
    return {"ok": True}


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
    ("POST", r"/api/tasks", lambda m, b: create_task(b)),
    ("PATCH", r"/api/tasks/([\w.-]+)", lambda m, b: update_task(m[1], b)),
    ("DELETE", r"/api/tasks/([\w.-]+)", lambda m, b: delete_task(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/move", lambda m, b: move_task(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/planned", lambda m, b: planned_task(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/open", lambda m, b: open_task(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/worktree/open", lambda m, b: open_worktree(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/message", lambda m, b: message_agent(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/stop", lambda m, b: stop_task(m[1])),
    ("GET", r"/api/tasks/([\w.-]+)/screen", lambda m, b: read_screen(m[1])),
    ("GET", r"/api/tasks/([\w.-]+)/diff", lambda m, b: task_diff(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/diff/open", lambda m, b: present_diff(m[1])),
    ("GET", r"/api/tasks/([\w.-]+)/context", lambda m, b: task_context(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/context", lambda m, b: publish_context(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/merge", lambda m, b: merge_task(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/pr", lambda m, b: create_pr(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/cleanup", lambda m, b: cleanup_task(m[1], b)),
    ("POST", r"/api/tasks/([\w.-]+)/resumed", lambda m, b: resumed_task(m[1])),
    ("POST", r"/api/tasks/([\w.-]+)/recover", lambda m, b: recover_task(m[1])),
    ("POST", r"/api/refresh", lambda m, b: refresh()),
    ("POST", r"/api/worktrees/adopt", lambda m, b: adopt_worktree(b)),
    ("POST", r"/api/worktrees/open", lambda m, b: open_listed_worktree(b)),
    ("POST", r"/api/worktrees/resume", lambda m, b: resume_listed_worktree(b)),
    ("POST", r"/api/worktrees/remove", lambda m, b: remove_listed_worktree(b)),
    ("POST", r"/api/restart", lambda m, b: restart()),
    ("POST", r"/api/projects", lambda m, b: register_project(b)),
    ("PATCH", r"/api/projects/scripts", lambda m, b: set_project_scripts(b)),
    ("PATCH", r"/api/projects/hidden", lambda m, b: set_project_hidden(b)),
    ("PATCH", r"/api/projects/tag-rules", lambda m, b: set_project_tag_rules(b)),
    ("PATCH", r"/api/projects/control-sets", lambda m, b: set_project_control_sets(b)),
    ("POST", r"/api/agent", lambda m, b: report_agent(b)),
    ("POST", r"/api/control/([\w-]+)", lambda m, b: answer_control(m[1], b)),
    ("POST", r"/api/appearance", lambda m, b: set_theme(b)),
    ("GET", r"/api/state", lambda m, b: store.board()),
    ("GET", r"/api/health", lambda m, b: {"ok": True, "pid": os.getpid(), "started": STARTED, "codeMtime": CODE_MTIME}),
]


class Handler(BaseHTTPRequestHandler):
    server_version = "mission-control"

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
            if self.command == "GET" and path in STATIC_ASSETS:
                asset = ROOT / path.lstrip("/")
                content_type = "text/javascript" if path.endswith(".js") else "text/css"
                return self.serve_bytes(asset.read_bytes(), content_type + "; charset=utf-8")
            if self.command == "GET" and path == "/appearance.css":
                project = parse_qs(urlparse(self.path).query).get("project", [""])[0]
                return self.serve_bytes(appearance_css(project).encode(), "text/css; charset=utf-8")
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
            print(f"mission-control: {self.command} {self.path} failed: {e!r}", file=sys.stderr)
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
                print(f"mission-control: after {self.command} {self.path}: {e!r}", file=sys.stderr)

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
        meta: Dict[str, Any] = {k: (query.get(k) or [None])[0] or None for k in ("session", "project", "task")}
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
    request_queue_size = 128  # a page load opens a dozen connections at once; the default backlog is 5

    def handle_error(self, request: Any, client_address: Any) -> None:
        if not isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
            super().handle_error(request, client_address)


def prepare() -> None:
    """`server.py --prepare`: readies the board's folder, importing the previous board's started cards once."""
    HOME.mkdir(parents=True, exist_ok=True)
    if import_orchestrator.wanted(HOME):
        import_orchestrator.run(HOME)


def main() -> None:
    if sys.argv[1:] == ["--prepare"]:
        prepare()
        return
    # Commands run without an explicit cwd inherit the server's; a launch from inside a task worktree would break every one of
    # them (git included) once that worktree is removed on merge.
    HOME.mkdir(parents=True, exist_ok=True)
    os.chdir(HOME)
    store.load()
    threading.Thread(target=hub.run_snapshots, daemon=True).start()
    threading.Thread(target=poller.run, daemon=True).start()
    global SERVER
    SERVER = Server((HOST, PORT), Handler)
    print(f"mission-control: http://{HOST}:{PORT} (data in {HOME})", file=sys.stderr, flush=True)
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
