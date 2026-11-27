#!/usr/bin/env python3
"""Mission Control server: every checkout of a project, every omp running in it, and its pull request."""
from __future__ import annotations

import copy
import fnmatch
import hashlib
import json
import math
import os
import queue
import re
import shlex
import signal
import sys
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import lease
import sessions
from cmux import cmux_config, ghostty_cli, terminal_appearance
from gitops import (base_ref, branch_base, checkout_info, created_commit, default_branch, drop_missing_worktrees,
                    find_worktree, has_ref, merge_base, prepare_branch, registered_worktrees)
from integrations import PACKAGE_ROOT, terminals
from runtime import ANSI, now_iso, plain, run, same_dir, which, write_atomic

ROOT = Path(__file__).resolve().parent
HOME = Path(os.environ.get("MISSION_CONTROL_HOME", "~/.mission-control")).expanduser()
HOST = "127.0.0.1"
PORT = int(os.environ.get("MISSION_CONTROL_PORT", "4747"))
STARTED = time.time()
BRANCH_PREFIX = os.environ.get("MISSION_CONTROL_BRANCH_PREFIX", "feature/")
APPEARANCE_TTL = 30.0
THEME_COLOR = re.compile(r"#(?:[0-9a-fA-F]{3}){1,2}")
THEME_VARS = {"--bg", "--fg", "--accent", "--accent-fg", "--muted", "--add", "--remove", "--warning", "--cyan"}
DEFAULT_BRANCH_TTL = 60.0
SCAN_INTERVAL = 15.0
PR_INTERVAL = 60.0
SCAN_WORKERS = 8
LIVE_SECONDS = 120.0
MESSAGE_LIMIT = 2000
AGENT_STATES = ("planning", "thinking", "working", "plan_ready", "needs_input", "waiting", "idle")
STEP_STATES = ("planning", "thinking", "working", "needs_input")
FILE_ATTACHMENT = re.compile(r'^\s*<file name="[^"]*">.*?</file>\s*', re.S)


def code_mtime() -> float:
    """The newest Python source of the server and of the shared package, so an update of either restarts the server."""
    newest = max(path.stat().st_mtime for path in ROOT.glob("*.py"))
    for dirpath, dirnames, filenames in os.walk(PACKAGE_ROOT):
        dirnames[:] = [d for d in dirnames if d != "node_modules" and not d.startswith(".")]
        newest = max([newest] + [os.stat(os.path.join(dirpath, f)).st_mtime for f in filenames if f.endswith(".py")])
    return newest


CODE_MTIME = code_mtime()


class ApiError(Exception):
    def __init__(self, status: int, message: str, extra: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}


# --- projects and config -------------------------------------------------------------

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


def run_hook(name: str, command: str, cwd: str, timeout: float, env: Dict[str, str],
             stdin: Optional[str] = None) -> Tuple[int, str, str]:
    """Runs a configured command through /bin/sh; returns (exit code, output, failure message)."""
    code, out, err = run(["/bin/sh", "-c", command], cwd=cwd, timeout=timeout, env=env, stdin=stdin)
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


# --- tags ------------------------------------------------------------------------

TAG = re.compile(r"[a-z0-9][a-z0-9._-]{0,31}")
TAGS_LIMIT = 8
TAG_RULES_LIMIT = 50
TAG_RULES_ERROR = "Tag rules are up to 50 branch patterns, each followed by 1 to 8 tags"
TAGS_ERROR = "Tags are up to 8 short words: lowercase letters, digits, . _ -"


def validate_tags(value: Any) -> List[str]:
    """A checkout's own tags: at most TAGS_LIMIT short lowercase words, deduplicated in order."""
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ApiError(400, TAGS_ERROR)
    tags = list(dict.fromkeys(v.strip().lower() for v in value))
    if len(tags) > TAGS_LIMIT or not all(TAG.fullmatch(v) for v in tags):
        raise ApiError(400, TAGS_ERROR)
    return tags


def valid_own_tags(value: Any) -> Dict[str, List[str]]:
    """Each checkout's own tags by key, from board.json; what doesn't validate is dropped."""
    found: Dict[str, List[str]] = {}
    for key, tags in value.items() if isinstance(value, dict) else []:
        try:
            if isinstance(key, str) and key and validate_tags(tags):
                found[key] = validate_tags(tags)
        except ApiError:
            continue
    return found


def validate_tag_rules(value: Any) -> List[Dict[str, Any]]:
    """A project's tag rules: a branch-name pattern and the 1 to 8 tags it gives, at most TAG_RULES_LIMIT of them."""
    if not isinstance(value, list) or len(value) > TAG_RULES_LIMIT:
        raise ApiError(400, TAG_RULES_ERROR)
    rules = []
    for rule in value:
        pattern = rule["pattern"].strip() if isinstance(rule, dict) and isinstance(rule.get("pattern"), str) else ""
        tags = rule.get("tags") if isinstance(rule, dict) else None
        if not pattern or len(pattern) > 200 or any(c.isspace() for c in pattern) or not isinstance(tags, list):
            raise ApiError(400, TAG_RULES_ERROR)
        tags = list(dict.fromkeys(str(t).strip().lower() for t in tags))
        if not 1 <= len(tags) <= TAGS_LIMIT or not all(TAG.fullmatch(t) for t in tags):
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


def valid_links(value: Any) -> List[Dict[str, str]]:
    """A project's dependency links between checkouts, by key: `to` depends on `from`."""
    return [{"from": x["from"], "to": x["to"]} for x in value if isinstance(x, dict) and isinstance(x.get("from"), str)
            and isinstance(x.get("to"), str) and x["from"] and x["to"] and x["from"] != x["to"]] if isinstance(value, list) else []


def valid_position(value: Any) -> Optional[Dict[str, float]]:
    """A node's place on the Graph canvas; None when it isn't two finite numbers."""
    if not isinstance(value, dict):
        return None
    xy = [value.get(c) for c in ("x", "y")]
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and abs(v) < 1e7 for v in xy):
        return None
    return {"x": float(xy[0]), "y": float(xy[1])}


def valid_positions(value: Any) -> Dict[str, Dict[str, float]]:
    if not isinstance(value, dict):
        return {}
    return {k: p for k, v in value.items() if isinstance(k, str) and k and (p := valid_position(v))}


def depends_on(links: List[Dict[str, str]], key: str, other: str) -> bool:
    """Whether checkout `key` depends on `other`, directly or through others."""
    seen, stack = set(), [key]
    while stack:
        current = stack.pop()
        if current == other:
            return True
        if current not in seen:
            seen.add(current)
            stack.extend(x["from"] for x in links if x["to"] == current)
    return False


def project_links(p: Dict[str, Any], trees: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """A project's links between its listed checkouts: the drawn ones, then each checkout made from another checkout's
    branch (`madeFrom`, which git records and only moving the branch changes)."""
    keys = {w["key"] for w in trees}
    default = repo_default_branch(p["repo"])
    by_branch = {w["branch"]: w["key"] for w in trees if w["branch"]}
    made = {(by_branch[w["base"]], w["key"]) for w in trees
            if w["branch"] and not w["main"] and w["base"] != default and by_branch.get(w["base"], w["key"]) != w["key"]}
    drawn = [{"from": x["from"], "to": x["to"], "madeFrom": (x["from"], x["to"]) in made} for x in p["links"]
             if x["from"] in keys and x["to"] in keys]
    seen = {(x["from"], x["to"]) for x in drawn}
    return drawn + [{"from": a, "to": b, "madeFrom": True} for a, b in sorted(made - seen)]


def rule_tags(repo: str, branch: str, path: str) -> List[str]:
    """The tags a project's rules give a checkout: those of every rule whose pattern matches its branch name or its
    folder name, ignoring case."""
    names = [branch.lower(), os.path.basename(path.rstrip("/")).lower()]
    found: List[str] = []
    for rule in (registered_project(repo) or {}).get("tagRules", []):
        if any(fnmatch.fnmatchcase(name, rule["pattern"].lower()) for name in names):
            found += [x for x in rule["tags"] if x not in found]
    return found[:TAGS_LIMIT]


# --- event hub -------------------------------------------------------------------

def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


class Hub:
    """Sends every connected page a snapshot of the board after each change, coalesced."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.subscribers: List["queue.Queue[str]"] = []
        self.dirty = threading.Event()

    def subscribe(self) -> "queue.Queue[str]":
        q: "queue.Queue[str]" = queue.Queue(maxsize=200)
        with self.lock:
            self.subscribers.append(q)
        return q

    def unsubscribe(self, q: "queue.Queue[str]") -> None:
        with self.lock:
            if q in self.subscribers:
                self.subscribers.remove(q)

    def changed(self) -> None:
        self.dirty.set()

    def run_snapshots(self) -> None:
        while True:
            self.dirty.wait()
            time.sleep(0.15)
            self.dirty.clear()
            payload = sse("snapshot", store.board())
            with self.lock:
                for q in self.subscribers:
                    try:
                        q.put_nowait(payload)
                    except queue.Full:
                        pass


hub = Hub()


# --- store -----------------------------------------------------------------------

BOARD_FILE = HOME / "board.json"


class Store:
    """The registered projects (board.json) and live state: their checkouts, what each omp session last reported, the
    newest terminal each project's omp reported, and omp themes."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.projects: List[Dict[str, Any]] = []
        self.worktrees: List[Dict[str, Any]] = []
        self.reports: Dict[str, Dict[str, Any]] = {}
        self.terminals: Dict[str, Dict[str, Any]] = {}
        self.themes: Dict[str, Dict[str, Any]] = {}
        self.theme_version = 0
        self.scanned = threading.Event()

    def load(self) -> None:
        try:
            saved = json.loads(BOARD_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            saved = {}
        self.projects = [{"repo": p["repo"], "hidden": valid_hidden(p.get("hidden")), "tagRules": valid_tag_rules(p.get("tagRules")),
                          "links": valid_links(p.get("links")), "positions": valid_positions(p.get("positions")),
                          "tags": valid_own_tags(p.get("tags"))}
                         for p in (saved.get("projects") if isinstance(saved, dict) else None) or []
                         if isinstance(p, dict) and isinstance(p.get("repo"), str)]

    def save_board(self) -> None:
        write_atomic(BOARD_FILE, json.dumps({"projects": self.projects}, indent=2))

    def project_list(self) -> List[Dict[str, Any]]:
        """The registered projects whose main checkout exists (call under self.lock)."""
        try:
            config = read_config()
        except ApiError:
            config = {}
        now = time.time()
        listed = []
        for p in self.projects:
            repo = p["repo"]
            if not Path(repo).is_dir():
                continue
            pid = project_id(repo)
            trees = [w for w in self.worktrees if w["project"] == pid]
            entry = {"id": pid, "name": os.path.basename(repo), "repo": repo, "defaultBranch": repo_default_branch(repo),
                     "live": any(r["project"] == pid and now - r["at"] < LIVE_SECONDS for r in self.reports.values()),
                     "hidden": list(p["hidden"]), "tagRules": copy.deepcopy(p["tagRules"]), "links": project_links(p, trees),
                     "positions": copy.deepcopy(p["positions"]),
                     "tags": sorted({t for w in trees for t in w["tags"]})}
            try:
                entry.update(project_scripts(entry["name"], config))
            except ApiError:
                entry.update(dict.fromkeys(SCRIPT_KEYS, ""))
            listed.append(entry)
        return sorted(listed, key=lambda p: p["id"])

    def board(self) -> Dict[str, Any]:
        """The board once the first scan has read every checkout, so a restarted server never shows an empty one."""
        self.scanned.wait(timeout=30)
        with self.lock:
            return {"version": 3, "themeVersion": self.theme_version, "projects": self.project_list(),
                    "worktrees": copy.deepcopy(self.worktrees)}


store = Store()


def registered_project(repo: str) -> Optional[Dict[str, Any]]:
    return next((p for p in store.projects if same_dir(p["repo"], repo)), None)


def remember_project(repo: str) -> Dict[str, Any]:
    """The registered project of the main checkout `repo`, registering it first (call under store.lock)."""
    found = registered_project(repo)
    if not found:
        found = {"repo": repo, "hidden": [], "tagRules": [], "links": [], "positions": {}, "tags": {}}
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
    """Registers the repository containing `path` as a project."""
    path = str(body.get("path") or "")
    info = checkout_info(str(Path(path).expanduser())) if path else None
    if not info:
        raise ApiError(400, f"{path or 'That folder'} is not a git repository")
    with store.lock:
        remember_project(info["repo"])
        project = listed_project(project_id(info["repo"]))
    poller.kick(full=True)
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
    """Hides a branch's checkout from the project's page, or shows it again."""
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
    """Saves a project's tag rules; its checkouts get the tags they now match."""
    rules = validate_tag_rules(body.get("rules"))
    with store.lock:
        project = remember_project(listed_project(body.get("id"))["repo"])
        project["tagRules"] = rules
        store.save_board()
        for w in store.worktrees:
            if same_dir(w["repo"], project["repo"]):
                w["tags"] = rule_tags(w["repo"], w["branch"] or "", w["path"])
        listed = listed_project(body.get("id"))
    hub.changed()
    return {"ok": True, "project": listed}


def set_project_link(body: Dict[str, Any]) -> Dict[str, Any]:
    """Makes checkout `to` depend on checkout `from` (both by key), or drops that link; refuses a cycle."""
    source, target, linked = body.get("from"), body.get("to"), body.get("linked")
    if not isinstance(source, str) or not isinstance(target, str) or not source or not target or not isinstance(linked, bool):
        raise ApiError(400, "A link needs from, to and linked: true or false")
    if source == target:
        raise ApiError(400, "A worktree can't depend on itself")
    with store.lock:
        listed = listed_project(body.get("id"))
        project = remember_project(listed["repo"])
        current = project_links(project, [w for w in store.worktrees if w["project"] == listed["id"]])
        if any(x["madeFrom"] and (x["from"], x["to"]) == (source, target) for x in current) and not linked:
            raise ApiError(409, f"{target} is made from {source}'s branch: that link comes from git")
        links = [x for x in project["links"] if (x["from"], x["to"]) != (source, target)]
        if linked:
            keys = {w["key"] for w in store.worktrees if w["project"] == listed["id"]}
            missing = next((k for k in (source, target) if k not in keys), None)
            if missing:
                raise ApiError(400, f"{listed['name']} has no checkout {missing}")
            if depends_on(current, source, target):
                raise ApiError(400, f"{source} already depends on {target}")
            links.append({"from": source, "to": target})
        project["links"] = links
        store.save_board()
        arrange()
        listed = listed_project(body.get("id"))
    hub.changed()
    return {"ok": True, "project": listed}


def set_project_positions(body: Dict[str, Any]) -> Dict[str, Any]:
    """Places checkouts on the Graph canvas by key (null forgets one); `reset` forgets every place first."""
    raw = body.get("positions") or {}
    if not isinstance(raw, dict) or len(raw) > 1000:
        raise ApiError(400, "positions must map checkout keys to {x, y} or null")
    with store.lock:
        project = remember_project(listed_project(body.get("id"))["repo"])
        positions = {} if body.get("reset") is True else dict(project["positions"])
        for key, value in raw.items():
            if value is None:
                positions.pop(key, None)
                continue
            place = valid_position(value)
            if not isinstance(key, str) or not key or not place:
                raise ApiError(400, f"Invalid place for {key}")
            positions[key] = place
        project["positions"] = positions
        store.save_board()
        listed = listed_project(body.get("id"))
    hub.changed()
    return {"ok": True, "project": listed}


def set_checkout_tags(body: Dict[str, Any]) -> Dict[str, Any]:
    """Sets a checkout's own tags, by key."""
    key, tags = body.get("key"), validate_tags(body.get("tags"))
    if not isinstance(key, str) or not key:
        raise ApiError(400, "Tags need the checkout's key")
    with store.lock:
        listed = listed_project(body.get("id"))
        if not any(w["key"] == key and w["project"] == listed["id"] for w in store.worktrees):
            raise ApiError(400, f"{listed['name']} has no checkout {key}")
        project = remember_project(listed["repo"])
        if tags:
            project["tags"][key] = tags
        else:
            project["tags"].pop(key, None)
        store.save_board()
        arrange()
        listed = listed_project(body.get("id"))
    hub.changed()
    return {"ok": True, "project": listed}


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


# --- agent reports ---------------------------------------------------------------

def submitted_text(message: Optional[str]) -> Optional[str]:
    """The typed part of a submitted message, without the files omp inlines for @-mentions."""
    text = message or ""
    while text.lstrip().startswith("<file name="):
        stripped = FILE_ATTACHMENT.sub("", text, count=1)
        if stripped == text:
            return None
        text = stripped
    return text.strip() or None


def text_field(value: Any, limit: int) -> Optional[str]:
    return value if isinstance(value, str) and value.strip() and len(value) <= limit and "\n" not in value else None


def line(value: Any, limit: int) -> Optional[str]:
    return plain(str(value or "").strip())[:limit] or None


def reported_detail(body: Dict[str, Any], state: str) -> Dict[str, Any]:
    """The run clock (Unix seconds), to-do progress, latest sentence and question an omp reports, validated; only while
    they mean something for `state`. Its running subagents count in any state, since a background job outlives the turn."""
    active = state in STEP_STATES
    started = body.get("startedAt")
    valid_start = isinstance(started, int) and not isinstance(started, bool) and 0 < started <= time.time() + 60
    todo = body.get("todo")
    counts = [todo.get(k) for k in ("done", "total")] if isinstance(todo, dict) else []
    valid_todo = len(counts) == 2 and all(isinstance(n, int) and not isinstance(n, bool) for n in counts) \
        and 0 <= counts[0] <= counts[1] and counts[1] > 0
    return {"step": line(body.get("step"), 200) if active else None,
            "startedAt": datetime.fromtimestamp(started, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            if active and valid_start else None,
            "todo": {"done": counts[0], "total": counts[1], "current": line(todo.get("current"), 200)}
            if active and valid_todo else None,
            "said": line(body.get("said"), 300) if active else None,
            "question": line(body.get("question"), 300) if state == "needs_input" else None,
            "waitingFor": [k for k in body.get("waitingFor") or [] if isinstance(k, str) and k][:50]
            if state == "waiting" and isinstance(body.get("waitingFor"), list) else [],
            "subagents": [{"name": line(s.get("name"), 60) or "subagent", "step": line(s.get("step"), 200)}
                          for s in body["subagents"] if isinstance(s, dict)][:6]
            if isinstance(body.get("subagents"), list) else []}


CHECKOUTS: Dict[str, Tuple[str, str]] = {}


def reporting_checkout(path: str) -> Tuple[str, str]:
    """The checkout holding `path` and its project, for a registered project; 404 otherwise."""
    real = os.path.realpath(path)
    if real not in CHECKOUTS:
        info = checkout_info(real) if os.path.isdir(real) else None
        if info:
            CHECKOUTS[real] = (info["checkout"], info["repo"])
    found = CHECKOUTS.get(real)
    with store.lock:
        if not found or not registered_project(found[1]):
            raise ApiError(404, f"{path} is in no checkout of a registered project")
        return found[0], project_id(found[1])


def report_agent(body: Dict[str, Any]) -> Dict[str, Any]:
    """Records what an omp session reports: its state, step, run clock, to-do progress, latest sentence, question,
    latest prompt and terminal. `exited` forgets the session."""
    state = body.get("state")
    if state not in AGENT_STATES and state != "exited":
        raise ApiError(400, "State must be planning, thinking, working, plan_ready, needs_input, idle or exited")
    session_id = text_field(body.get("sessionId"), 200)
    if not session_id:
        raise ApiError(400, "A report needs its sessionId")
    checkout, project = reporting_checkout(str(body.get("path") or ""))
    if state == "exited":
        with store.lock:
            store.reports.pop(session_id, None)
        poller.kick()
        return {"ok": True}
    session_file = text_field(body.get("sessionFile"), 4096)
    title = (sessions.head(Path(session_file)) or {}).get("title") if session_file and os.path.isabs(session_file) else None
    message = submitted_text(body["message"][:MESSAGE_LIMIT]) if isinstance(body.get("message"), str) else None
    terminal = None
    if body.get("terminal") is not None:
        try:
            terminal = terminals.normalize_context(body["terminal"])
        except ValueError:
            terminal = None
    with store.lock:
        previous = store.reports.get(session_id) or {}
        report = {"checkout": checkout, "project": project, "title": title or previous.get("title"), "state": state,
                  "since": now_iso() if previous.get("state") != state else previous.get("since"),
                  "message": message if message is not None else previous.get("message"),
                  "terminal": terminal if terminal and terminal["kind"] != "plain" else previous.get("terminal"),
                  **reported_detail(body, state)}
        changed = {k: v for k, v in report.items() if k != "at"} != {k: v for k, v in previous.items() if k != "at"}
        store.reports[session_id] = {**report, "at": time.time()}
        if report["terminal"]:
            store.terminals[project] = report["terminal"]
        known = refresh_reported(session_id)
    if not known:
        poller.kick()
    elif changed:
        hub.changed()
    return {"ok": True}


def agent_view(session_id: str, title: Optional[str], report: Dict[str, Any]) -> Dict[str, Any]:
    state = report.get("state") or "running"
    return {"id": session_id, "title": title or report.get("title"), "state": state, "step": report.get("step"),
            "since": report.get("since"), "startedAt": report.get("startedAt"), "todo": report.get("todo"),
            "said": report.get("said"), "question": report.get("question"), "message": report.get("message"),
            "terminal": bool(report.get("terminal")), "waitingFor": report.get("waitingFor") or [],
            "subagents": report.get("subagents") or []}


def refresh_reported(session_id: str) -> bool:
    """Updates the listed agent of `session_id` from its report; False when no listed checkout shows it yet (call under
    store.lock)."""
    report = store.reports[session_id]
    for w in store.worktrees:
        for i, a in enumerate(w["agents"]):
            if a["id"] == session_id:
                w["agents"][i] = agent_view(session_id, a["title"], report)
                arrange()
                return True
    return False


def checkout_agents(path: str, running: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Every omp running in the checkout at `path`: the sessions of its folder whose lease is held, newest first, then any
    other running session that reports from inside it, each with what it last reported (call without store.lock)."""
    with store.lock:
        reported = {sid: dict(r) for sid, r in store.reports.items() if same_dir(r["checkout"], path)}
    listed = {s["session"]["id"]: s for s in running}
    held = lease.held_any([sid for sid in reported if sid not in listed])
    return [agent_view(sid, listed[sid]["title"] if sid in listed else None, reported.get(sid) or {})
            for sid in [*listed, *(sid for sid in reported if sid in held)]]


# --- checkouts -------------------------------------------------------------------

def git_stats(path: str, base: str) -> Optional[Dict[str, Any]]:
    """A checkout's work since it left `base`: lines added and removed, files, commits, uncommitted files and its newest
    own commit (subject and time); None once the checkout is gone."""
    if not Path(path).is_dir():
        return None
    _, mb = merge_base(path, base)
    added = removed = files = 0
    code, out, _ = run(["git", "-C", path, "diff", "--numstat", mb], timeout=30)
    for row in out.splitlines() if code == 0 else []:
        a, r, _name = (row.split("\t", 2) + ["", ""])[:3]
        files += 1
        added += int(a) if a.isdigit() else 0
        removed += int(r) if r.isdigit() else 0
    _, commits, _ = run(["git", "-C", path, "rev-list", "--count", f"{mb}..HEAD"], timeout=15)
    _, status, _ = run(["git", "-C", path, "status", "--porcelain"], timeout=30)
    code, newest, _ = run(["git", "-C", path, "log", "-1", "--format=%s%x00%cI", f"{mb}..HEAD"], timeout=15)
    subject, _, at = newest.strip().partition("\0")
    return {"added": added, "removed": removed, "files": files,
            "commits": int(commits.strip()) if commits.strip().isdigit() else 0,
            "dirty": len([row for row in status.splitlines() if row.strip()]),
            "last": {"subject": subject, "at": at} if code == 0 and subject and at else None}


def landed(repo: str, branch: str, default: str) -> bool:
    """Whether `branch` moved since it was created and its tip is in the default branch."""
    tip_code, tip, _ = run(["git", "-C", repo, "rev-parse", f"refs/heads/{branch}"], timeout=10)
    created = created_commit(repo, branch)
    if tip_code != 0 or not created or tip.strip() == created:
        return False
    return run(["git", "-C", repo, "merge-base", "--is-ancestor", tip.strip(), base_ref(repo, default)], timeout=15)[0] == 0


def own_column(w: Dict[str, Any]) -> str:
    """A checkout's column from itself alone; arrange() adds what its dependencies make it wait for."""
    pr = (w["pr"] or {}).get("state")
    states = {a["state"] for a in w["agents"]}
    git = w["git"] or {}
    if not w["main"] and (pr == "merged" or w["landed"]) and not git.get("dirty") and not w["agents"]:
        return "done"
    if not w["main"] and pr in ("open", "draft"):
        return "pr"
    if "waiting" in states:
        return "waiting"
    if states & {"planning", "plan_ready"}:
        return "planning"
    if states & {"working", "thinking", "needs_input", "running"}:
        return "doing"
    if not w["main"] and git.get("dirty"):
        return "uncommitted"
    if w["branch"] and not w["main"] and git.get("commits"):
        return "paused"
    return "idle"


def arrange() -> None:
    """Every listed checkout's dependencies, tags, column and the actions every view offers on it (call under
    store.lock)."""
    for p in store.projects:
        pid = project_id(p["repo"])
        trees = {w["key"]: w for w in store.worktrees if w["project"] == pid}
        links = project_links(p, list(trees.values()))
        own = {key: own_column(w) for key, w in trees.items()}
        for key, w in trees.items():
            w["dependsOn"] = [x["from"] for x in links if x["to"] == key]
            w["neededBy"] = [x["to"] for x in links if x["from"] == key]
            held = [k for a in w["agents"] if a["state"] == "waiting" for k in a["waitingFor"]]
            w["waitingFor"] = list(dict.fromkeys([k for k in w["dependsOn"] if own[k] != "done"] + held))
            w["column"] = "waiting" if own[key] in ("uncommitted", "paused", "idle") and w["waitingFor"] else own[key]
            w["ownTags"] = list(p["tags"].get(key, []))
            w["tags"] = list(dict.fromkeys(w["ownTags"] + w["ruleTags"]))[:TAGS_LIMIT]
            running = bool(w["agents"])
            can_create = bool(w["branch"]) and not w["main"] and not w["landed"] and bool((w["git"] or {}).get("commits"))
            w["actions"] = {"open": True, "pr": "open" if w["pr"] else "create" if can_create else None,
                            "resume": not running and w["agent"]["state"] == "asleep",
                            "remove": not w["main"] and not running}


def naming(branch: Optional[str], main: bool, path: str) -> Tuple[str, str]:
    """A checkout's title and folder as the cmux kit names it: a linked worktree by its branch's last segment under the
    other segments, the main checkout by its whole branch, a detached one by its folder."""
    if not branch:
        return os.path.basename(path.rstrip("/")), ""
    if main:
        return branch, ""
    *folders, name = branch.split("/")
    return name, "/".join(folders)


def scan_checkout(repo: str, path: str, branch: Optional[str], main: bool) -> Optional[Dict[str, Any]]:
    """One checkout as the board lists it, but for its pull request; None when its HEAD can't be read."""
    default = repo_default_branch(repo)
    detached = None
    if not branch:
        code, head, _ = run(["git", "-C", path, "rev-parse", "--short", "HEAD"], timeout=10)
        if code != 0 or not head.strip():
            return None
        detached = head.strip()
    base = branch_base(repo, branch, default) if branch and not main else default
    agent = sessions.agent(path)
    title, folder = naming(branch, main, path)
    return {"path": path, "key": branch or path, "title": title, "folder": folder, "project": project_id(repo), "repo": repo,
            "branch": branch, "detached": detached, "main": main, "base": base,
            "landed": bool(branch) and not main and landed(repo, branch, default), "git": git_stats(path, base),
            "ruleTags": rule_tags(repo, branch or "", path), "agent": {k: v for k, v in agent.items() if k != "running"},
            "agents": checkout_agents(path, agent["running"])}


def listed_worktree(path: str) -> Dict[str, Any]:
    """A copy of the checkout the board lists at `path` (call under store.lock); 404 without one."""
    found = next((w for w in store.worktrees if path and same_dir(w["path"], path)), None)
    if not found:
        raise ApiError(404, f"{path} isn't a checkout the board lists")
    return copy.deepcopy(found)


def project_terminal(project: str) -> Dict[str, Any]:
    """Where a terminal for `project` opens: the newest one its omp sessions reported, else the board's own (call under
    store.lock)."""
    return store.terminals.get(project) or LAUNCH_TERMINAL


def focus_terminal(body: Dict[str, Any]) -> Dict[str, Any]:
    """Brings forward the terminal of omp `session` in a checkout, else of its newest reporting omp, else any terminal
    already there; never opens, attaches, closes or starts anything."""
    path = str(body.get("path") or "")
    with store.lock:
        w = listed_worktree(path)
        wanted = str(body.get("session") or "")
        order = sorted((a for a in w["agents"] if a["terminal"]), key=lambda a: a["id"] != wanted)
        targets = [store.reports[a["id"]]["terminal"] for a in order if a["id"] in store.reports]
        context = project_terminal(w["project"])
    found = None
    for target in targets:
        if terminals.focus(target):
            found = target
            break
    if not found:
        found = terminals.find_terminal(context, w["path"])
        if found:
            terminals.focus(found)
    return {"ok": True, "opened": bool(found), "cd": f"cd {shlex.quote(w['path'])}"}


def resume_session(body: Dict[str, Any]) -> Dict[str, Any]:
    """Opens a new terminal in a checkout running `omp --resume` on one of its sessions; refused while omp runs there. A
    plain terminal opens nothing and the reply has the command to run."""
    path = str(body.get("path") or "")
    with store.lock:
        w = listed_worktree(path)
        context = project_terminal(w["project"])
    if sessions.agent(w["path"])["state"] == "running":
        raise ApiError(409, f"omp already runs in {w['path']}")
    chosen = sessions.find(w["path"], str(body.get("session") or ""))
    if not chosen:
        raise ApiError(400, f"{w['path']} has no omp session {body.get('session') or ''}".rstrip())
    omp = which("omp")
    if not omp:
        raise ApiError(500, "omp isn't on the board's PATH")
    command = shlex.join([omp, "--resume", str(chosen)])
    run_here = f"cd {shlex.quote(w['path'])} && {command}"
    try:
        terminal = terminals.open_terminal(context, w["branch"] or os.path.basename(w["path"]), w["path"], command)
        if terminal["kind"] != "plain":
            terminals.focus(terminal)
    except (RuntimeError, OSError, KeyError, ValueError) as e:
        raise ApiError(500, f"Couldn't open a terminal in {w['path']} ({e}); run: {run_here}")
    poller.kick()
    return {"ok": True, "opened": terminal["kind"] != "plain", "command": run_here}


def validate_branch(branch: str) -> str:
    branch = branch.strip()
    if not branch or run(["git", "check-ref-format", "--branch", branch], timeout=10)[0] != 0:
        raise ApiError(400, f"“{branch}” is not a valid branch name")
    return branch


def slugify(text: str, limit: int = 40) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    slug = ""
    for word in re.findall(r"[a-z0-9]+", ascii_text):
        candidate = f"{slug}-{word}" if slug else word
        if len(candidate) > limit:
            break
        slug = candidate
    return slug or "work"


def free_branch(repo: str, prompt: str) -> str:
    """`feature/<slug of the prompt>`, else with `-2`, `-3`… while a branch of that name exists here or on origin."""
    name = BRANCH_PREFIX + slugify(prompt.strip().splitlines()[0])
    candidate, n = name, 1
    while has_ref(repo, f"refs/heads/{candidate}") or has_ref(repo, f"refs/remotes/origin/{candidate}"):
        n += 1
        candidate = f"{name}-{n}"
    return candidate


PLAN_CONFIG = HOME / "plan-on-startup.yml"


def agent_command(prompt: str, branch: str, base: str, waits_for: List[str]) -> str:
    """omp in plan mode on `prompt`, told where it works and what it builds on."""
    omp = which("omp")
    if not omp:
        raise ApiError(500, "omp isn't on the board's PATH")
    write_atomic(PLAN_CONFIG, "plan:\n  defaultOnStartup: true\n")
    wait = (f"It builds on {', '.join(waits_for)}, which haven't landed: once I approve your plan you wait until they "
            "have. ") if waits_for else ""
    text = (f"Plan this before changing any file: explore the code, then propose the plan for my review. You are in a "
            f"dedicated git worktree on branch {branch}, made from {base}. {wait}\n\n{prompt}")
    return shlex.join([omp, "--config", str(PLAN_CONFIG), text])


def new_worktree(body: Dict[str, Any]) -> Dict[str, Any]:
    """Creates a branch (from the default branch, `base`, or the branch of the checkout it comes `after`, which it then
    depends on) and checks it out in a new worktree: through the createWorktree hook (which opens its own terminal and
    agent), else under <home>/worktrees/<repo>/<branch> with the setup script. With a prompt, its omp starts in plan mode
    on it: the hook's agent command, else a new terminal there."""
    prompt = str(body.get("prompt") or "").strip()[:20_000]
    with store.lock:
        project = listed_project(body.get("project"))
        after = None
        if body.get("after"):
            after = next((copy.deepcopy(w) for w in store.worktrees
                          if w["project"] == project["id"] and w["key"] == body["after"]), None)
            if not after or not after["branch"]:
                raise ApiError(400, f"No checkout on a branch named {body['after']} in {project['name']}")
        context = project_terminal(project["id"])
    repo, default = project["repo"], project["defaultBranch"]
    base = after["branch"] if after else validate_branch(str(body["base"])) if body.get("base") else default
    if not (has_ref(repo, f"refs/heads/{base}") or has_ref(repo, f"refs/remotes/origin/{base}")):
        raise ApiError(400, f"No branch {base} in {project['name']}")
    if body.get("branch"):
        branch = validate_branch(str(body["branch"]))
    elif prompt:
        branch = free_branch(repo, prompt)
    else:
        raise ApiError(400, "A new worktree needs a branch or a prompt")
    if find_worktree(repo, branch):
        raise ApiError(409, f"{branch} already has a worktree")
    hook_command = hook("createWorktree")
    setup = os.path.expanduser(project["setupScript"]) if project["setupScript"] else ""
    path = str(HOME / "worktrees" / os.path.basename(repo) / branch)
    try:
        log = drop_missing_worktrees(repo, branch, None if hook_command else path) + prepare_branch(repo, branch, base)
    except RuntimeError as e:
        raise ApiError(500, str(e))
    if base != default:
        run(["git", "-C", repo, "config", f"branch.{branch}.nestUnder", base], timeout=10)
    if after:
        with store.lock:
            owner = remember_project(repo)
            owner["links"] = [x for x in owner["links"] if (x["from"], x["to"]) != (after["key"], branch)]
            owner["links"].append({"from": after["key"], "to": branch})
            store.save_board()
    waits = [after["title"]] if after and after["column"] != "done" else []
    command = agent_command(prompt, branch, base, waits) if prompt else ""
    opened = False
    if hook_command:
        env = {"MISSION_CONTROL_REPO": repo, "MISSION_CONTROL_BRANCH": branch, "MISSION_CONTROL_BASE": base,
               "MISSION_CONTROL_SETUP_SCRIPT": setup, "MISSION_CONTROL_AGENT_COMMAND": command}
        code, output, error = run_hook("createWorktree", hook_command, repo, 900, env)
        found = find_worktree(repo, branch)
        if code != 0 or not found:
            raise ApiError(500, error if code else "createWorktree finished but the branch has no worktree",
                           {"output": log + output})
        path, log, opened = found, log + output, bool(command)
    else:
        code, out, err = run(["git", "-C", repo, "worktree", "add", "-q", path, branch], timeout=300)
        if code != 0:
            raise ApiError(500, f"git worktree add failed: {(err or out).strip()}")
        log += f"Created {path}\n"
        if setup:
            log += run_script("Setup script", setup, path, 900,
                              {"MISSION_CONTROL_REPO": repo, "MISSION_CONTROL_BRANCH": branch, "MISSION_CONTROL_WORKTREE": path})
        if command:
            try:
                terminal = terminals.open_terminal(context, naming(branch, False, path)[0], path, command)
                opened = terminal["kind"] != "plain"
                if opened:
                    terminals.focus(terminal)
            except (RuntimeError, OSError, KeyError, ValueError) as e:
                log += f"Couldn't open a terminal there ({e})\n"
    poller.kick(full=True)
    return {"ok": True, "key": branch, "path": path, "output": log.strip(), "opened": opened,
            "command": f"cd {shlex.quote(path)} && {command}" if command and not opened else None}


def follow_down(w: Dict[str, Any]) -> None:
    """Moves every checkout made from a branch that just landed onto that branch's base, where its work went."""
    with store.lock:
        made_from = [d["branch"] for d in store.worktrees if d["project"] == w["project"] and d["branch"]
                     and not d["main"] and d["base"] == w["branch"] and d["column"] != "done"]
    for branch in made_from:
        run(["git", "-C", w["repo"], "config", f"branch.{branch}.nestUnder", w["base"]], timeout=10)
    if made_from:
        poller.kick(full=True)


def create_pr(body: Dict[str, Any]) -> Dict[str, Any]:
    """Pushes a checkout's branch and opens its pull request into the branch it was made from."""
    with store.lock:
        w = listed_worktree(str(body.get("path") or ""))
    branch = w["branch"]
    if not branch or w["main"]:
        raise ApiError(409, "Only a worktree on its own branch can have a pull request")
    if (w["pr"] or {}).get("state") in ("open", "draft"):
        raise ApiError(409, f"{branch} already has pull request #{w['pr']['number']}")
    if not which("gh"):
        raise ApiError(500, "gh isn't installed")
    code, out, err = run(["git", "-C", w["path"], "push", "-u", "origin", branch], timeout=120)
    if code != 0:
        raise ApiError(409, (err or out).strip() or "git push failed", {"output": out + err})
    code, out, err = run(["gh", "pr", "create", "--base", w["base"], "--head", branch, "--fill"], cwd=w["path"], timeout=60)
    if code != 0:
        raise ApiError(409, (err or out).strip() or "gh pr create failed", {"output": out + err})
    poller.kick(full=True)
    urls = [row for row in out.split() if row.startswith("https://")]
    return {"ok": True, "url": urls[-1] if urls else None}


def remove_worktree(body: Dict[str, Any]) -> Dict[str, Any]:
    """Removes a worktree and its branch: the removeWorktree hook (answered yes when forced), else the teardown script,
    `git worktree remove` and `git branch -D`. Refused for the main checkout, while omp runs there, and with uncommitted
    files unless forced."""
    with store.lock:
        w = listed_worktree(str(body.get("path") or ""))
        project = listed_project(w["project"])
    path, repo, branch, force = w["path"], w["repo"], w["branch"], body.get("force") is True
    if w["main"]:
        raise ApiError(409, f"{path} is the project's main checkout")
    if sessions.agent(path)["state"] == "running":
        raise ApiError(409, f"omp runs in {path}: end it first")
    _, status, _ = run(["git", "-C", path, "status", "--porcelain"], timeout=30)
    dirty = len([row for row in status.splitlines() if row.strip()])
    if dirty and not force:
        raise ApiError(409, f"{path} has uncommitted changes", {"dirty": dirty})
    teardown = os.path.expanduser(project["teardownScript"]) if project["teardownScript"] else ""
    command = hook("removeWorktree")
    if command:
        env = {"MISSION_CONTROL_REPO": repo, "MISSION_CONTROL_BRANCH": branch or "", "MISSION_CONTROL_WORKTREE": path,
               "MISSION_CONTROL_TEARDOWN_SCRIPT": teardown}
        code, log, error = run_hook("removeWorktree", command, path, 300, env, stdin="y\n" if force else "")
        if code != 0 or Path(path).exists():
            raise ApiError(500, error if code else f"removeWorktree left {path}", {"output": log})
    else:
        log = run_script("Teardown script", teardown, path, 300,
                         {"MISSION_CONTROL_REPO": repo, "MISSION_CONTROL_BRANCH": branch or "", "MISSION_CONTROL_WORKTREE": path}) \
            if teardown else ""
        code, out, err = run(["git", "-C", repo, "worktree", "remove", "--force", path], timeout=120)
        if code != 0:
            raise ApiError(500, (err or out).strip() or f"git worktree remove exited with code {code}", {"output": log})
        if branch:
            run(["git", "-C", repo, "branch", "-D", branch], timeout=30)
        log += f"Removed {path}" + (f" and branch {branch}\n" if branch else "\n")
    with store.lock:
        store.worktrees = [x for x in store.worktrees if not same_dir(x["path"], path)]
        owner = registered_project(repo)
        if owner:
            owner["links"] = [x for x in owner["links"] if w["key"] not in (x["from"], x["to"])]
            owner["positions"].pop(w["key"], None)
            owner["tags"].pop(w["key"], None)
            store.save_board()
        arrange()
    hub.changed()
    poller.kick(full=True)
    return {"ok": True, "output": log.strip()}


# --- pull requests ---------------------------------------------------------------

PR_FIELDS = "number,state,url,title,isDraft,headRefName,baseRefName"
CHECK_FAILED = {"FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}
REVIEW_THREADS_QUERY = """query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { headRefName reviewThreads(first: 100) { nodes { isResolved } } }
    }
  }
}"""


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


def unresolved_threads(repo: str) -> Dict[str, int]:
    """The unresolved review threads on `repo`'s open pull requests, by head branch; empty when gh can't tell."""
    code, out, _ = run(["gh", "api", "graphql", "-F", "owner={owner}", "-F", "name={repo}",
                        "-f", "query=" + REVIEW_THREADS_QUERY], cwd=repo, timeout=45)
    try:
        nodes = json.loads(out)["data"]["repository"]["pullRequests"]["nodes"] if code == 0 else []
        return {n["headRefName"]: sum(1 for x in n["reviewThreads"]["nodes"] if not x.get("isResolved")) for n in nodes}
    except (ValueError, KeyError, TypeError):
        return {}


def fetch_prs(repo: str) -> Optional[Dict[str, Dict[str, Any]]]:
    """The pull requests of `repo` by head branch: open ones with their review, checks, conflicts and unresolved review
    threads, then the latest of any state for the other branches; None when gh can't list them."""
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


# --- poller ----------------------------------------------------------------------

class Poller:
    """Keeps every checkout current: the full list with its work and pull request every SCAN_INTERVAL, which omp runs
    in it at every tick, pull requests every PR_INTERVAL."""

    def __init__(self) -> None:
        self.wake = threading.Event()
        self.forced = False
        self.last_scan = 0.0
        self.last_pr = 0.0
        self.prs: Dict[str, Dict[str, Dict[str, Any]]] = {}

    def kick(self, full: bool = False) -> None:
        self.forced = self.forced or full
        self.wake.set()

    def run(self) -> None:
        while True:
            forced, self.forced = self.forced, False
            try:
                self.tick(forced)
            except Exception as e:  # keep polling through transient failures
                print(f"mission-control: poll failed: {e!r}", file=sys.stderr)
            self.wake.wait(timeout=3)
            self.wake.clear()

    def tick(self, forced: bool) -> None:
        self.prune_reports()
        now = time.time()
        fetch = bool(which("gh")) and (forced or now - self.last_pr >= PR_INTERVAL)
        if fetch:
            self.last_pr = now
        if fetch or forced or now - self.last_scan >= SCAN_INTERVAL:
            self.last_scan = now
            changed = self.scan(fetch)
        else:
            changed = self.check_agents()
        if changed:
            hub.changed()

    def scan(self, fetch: bool) -> bool:
        """Every checkout of every registered project, its main checkout first, then its linked worktrees, read side by
        side; with `fetch`, the projects' pull requests alongside, so the board changes once with both."""
        with store.lock:
            repos = [p["repo"] for p in store.projects if Path(p["repo"]).is_dir()]
        jobs = [(repo, path, branch, i == 0) for repo in repos for i, (path, branch) in enumerate(registered_worktrees(repo))
                if os.path.isdir(path)]
        with ThreadPoolExecutor(SCAN_WORKERS) as pool:
            fetched = {repo: pool.submit(fetch_prs, repo) for repo in repos} if fetch else {}
            found = [w for w in pool.map(lambda job: scan_checkout(*job), jobs) if w]
            for repo, prs in fetched.items():
                if prs.result() is not None:
                    self.prs[repo] = prs.result()
        for w in found:
            w["pr"] = (self.prs.get(w["repo"]) or {}).get(w["branch"]) if w["branch"] and not w["main"] else None
        found.sort(key=lambda w: (w["project"], not w["main"], w["branch"] or "", w["path"]))
        with store.lock:
            previous = store.worktrees
            before = {w["key"]: w["column"] for w in previous}
            store.worktrees = found
            arrange()
            landed_now = [copy.deepcopy(w) for w in found if w["column"] == "done" and before.get(w["key"], "done") != "done"]
            changed = found != previous
        store.scanned.set()
        for w in landed_now:
            follow_down(w)
        return changed

    def check_agents(self) -> bool:
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
                if agent != w["agent"] or views[w["path"]] != w["agents"]:
                    w["agent"], w["agents"] = agent, views[w["path"]]
                    arrange()
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


# --- appearance ------------------------------------------------------------------

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


# --- HTTP ------------------------------------------------------------------------

STATIC_ASSETS = {"/design-system.css", "/app.js", "/app.css"}
SERVER: Optional["Server"] = None
REPLY = threading.local()


def after_reply(action: Callable[[], None]) -> None:
    """Runs `action` once the current request's reply is sent; at once outside a request."""
    actions = getattr(REPLY, "actions", None)
    if actions is None:
        action()
    else:
        actions.append(action)


def stop_serving() -> None:
    if SERVER is not None:
        threading.Thread(target=SERVER.shutdown, daemon=True).start()


RESTARTING = threading.Event()


def restart() -> Dict[str, Any]:
    RESTARTING.set()
    after_reply(stop_serving)
    return {"ok": True}


def refresh() -> Dict[str, Any]:
    poller.kick(full=True)
    return {"ok": True}


ROUTES = [
    ("GET", r"/api/state", lambda b: store.board()),
    ("GET", r"/api/health", lambda b: {"ok": True, "pid": os.getpid(), "started": STARTED, "codeMtime": CODE_MTIME}),
    ("POST", r"/api/projects", register_project),
    ("PATCH", r"/api/projects/scripts", set_project_scripts),
    ("PATCH", r"/api/projects/hidden", set_project_hidden),
    ("PATCH", r"/api/projects/tag-rules", set_project_tag_rules),
    ("PATCH", r"/api/projects/links", set_project_link),
    ("PATCH", r"/api/projects/positions", set_project_positions),
    ("PATCH", r"/api/projects/tags", set_checkout_tags),
    ("POST", r"/api/appearance", set_theme),
    ("POST", r"/api/agent", report_agent),
    ("POST", r"/api/worktrees/open", focus_terminal),
    ("POST", r"/api/worktrees/resume", resume_session),
    ("POST", r"/api/worktrees/new", new_worktree),
    ("POST", r"/api/worktrees/pr", create_pr),
    ("POST", r"/api/worktrees/remove", remove_worktree),
    ("POST", r"/api/refresh", lambda b: refresh()),
    ("POST", r"/api/restart", lambda b: restart()),
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

    def guard(self) -> None:
        """Only this machine's board may call the API: right Host (DNS rebinding) and no cross-site writes."""
        if self.headers.get("Host") not in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}:
            raise ApiError(403, "Unexpected Host header")
        if self.command in ("POST", "PATCH", "DELETE"):
            origin = self.headers.get("Origin")
            if origin and origin not in {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}:
                raise ApiError(403, "Cross-origin request refused")
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                raise ApiError(403, "Cross-site request refused")
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                raise ApiError(415, "Send JSON")

    def body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_000_000:
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
                return self.serve_bytes((ROOT / "index.html").read_bytes(), "text/html; charset=utf-8")
            if self.command == "GET" and path in STATIC_ASSETS:
                content_type = "text/javascript" if path.endswith(".js") else "text/css"
                return self.serve_bytes((ROOT / path.lstrip("/")).read_bytes(), content_type + "; charset=utf-8")
            if self.command == "GET" and path == "/appearance.css":
                project = parse_qs(urlparse(self.path).query).get("project", [""])[0]
                return self.serve_bytes(appearance_css(project).encode(), "text/css; charset=utf-8")
            if self.command == "GET" and path == "/api/events":
                return self.serve_events()
            for method, pattern, handler in ROUTES:
                if method == self.command and re.fullmatch(pattern, path):
                    REPLY.actions = []
                    try:
                        data = handler(self.body() if method != "GET" else {})
                    finally:
                        deferred, REPLY.actions = REPLY.actions, None
                    try:
                        return self.send_json(200, data)
                    finally:
                        for action in deferred:
                            action()
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

    do_GET = do_POST = do_PATCH = do_DELETE = handle_any

    def serve_bytes(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def serve_events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = hub.subscribe()
        try:
            self.wfile.write(sse("snapshot", store.board()).encode())
            self.wfile.flush()
            while True:
                try:
                    payload = q.get(timeout=15)
                except queue.Empty:
                    payload = ": ping\n\n"
                self.wfile.write(payload.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            hub.unsubscribe(q)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128  # a page load opens a dozen connections at once; the default backlog is 5

    def handle_error(self, request: Any, client_address: Any) -> None:
        if not isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
            super().handle_error(request, client_address)


def launch_terminal() -> Dict[str, Any]:
    """The terminal the board was started from, where a Resume opens before any omp of the project reported its own."""
    try:
        return terminals.detect_context(os.environ)
    except (ValueError, RuntimeError, OSError):
        return {"kind": "plain"}


LAUNCH_TERMINAL = launch_terminal()


def main() -> None:
    # Commands run without an explicit cwd inherit the server's; one inside a worktree would break once it is removed.
    HOME.mkdir(parents=True, exist_ok=True)
    os.chdir(HOME)
    store.load()
    threading.Thread(target=hub.run_snapshots, daemon=True).start()
    threading.Thread(target=poller.run, daemon=True).start()
    global SERVER
    SERVER = Server((HOST, PORT), Handler)
    print(f"mission-control: http://{HOST}:{PORT} (data in {HOME})", file=sys.stderr, flush=True)
    signal.signal(signal.SIGTERM, lambda *_: stop_serving())
    try:
        SERVER.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        SERVER.server_close()
    # A restart runs the server's current code again in this process, which keeps its pid, its log and its launcher.
    if RESTARTING.is_set():
        os.execv(sys.executable, [sys.executable, str(ROOT / "server.py")])


if __name__ == "__main__":
    main()
