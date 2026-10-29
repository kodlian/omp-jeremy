"""Beads task persistence and legacy migration; execution state stays local to Orchestrator."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from runtime import now_iso, write_atomic

PREFIX = "KB"
ACTOR = "kanboard"
CUSTOM_STATUSES = "todo:active,review:wip"
STATUS_FOR_COLUMN = {"backlog": "open", "todo": "todo", "doing": "in_progress", "review": "review", "done": "closed"}
COLUMN_FOR_STATUS = {**{s: c for c, s in STATUS_FOR_COLUMN.items()},
                     "blocked": "backlog", "deferred": "backlog", "pinned": "backlog", "hooked": "doing"}
CONFIG_KEYS = ("repo", "checkout", "base", "branch", "branchEdited", "merge", "planningMode")
FIELDS = ("title", "description", "plan", "column", "dependsOn", "parent", "ticket") + CONFIG_KEYS
RUNTIME_KEYS = ("order", "spawn", "worktree", "presentation", "execution", "pr", "merged", "planningOutcome", "origin",
                "briefed", "updatedAt", "planUpdatedAt")
# Before managed agent hosts, a started task's agent ran directly in the cmux workspace its record names.
LEGACY_RUNTIME_KEYS = ("order", "spawn", "worktree", "workspace", "pr", "merged", "planningOutcome", "origin", "briefed",
                       "updatedAt", "planUpdatedAt")
LEGACY_FILES = ("task.json", "plan.md", "plan.prev.md")
RESERVED_KEY = "kanboardReserved"
CONFLICT_EXIT = 13
BD_TIMEOUT = 60.0
IMPORT_TIMEOUT = 600.0


class BeadsError(Exception):
    """A bd command failed; the message is bd's own explanation."""


class BeadsConflict(BeadsError):
    """A guarded bd update found the issue changed (bd exit code 13)."""


def column_for(status: Optional[str]) -> str:
    return COLUMN_FOR_STATUS.get(status or "", "backlog")


def blocks_deps(bead: Dict[str, Any]) -> List[str]:
    """`blocks` dependency ids, from `bd list` edges or from the dependency issues `bd show` embeds."""
    deps = []
    for d in bead.get("dependencies") or []:
        if "depends_on_id" in d:
            if d.get("type") == "blocks" and d.get("issue_id") == bead["id"]:
                deps.append(d["depends_on_id"])
        elif d.get("dependency_type") == "blocks" and d.get("id"):
            deps.append(d["id"])
    return deps


def parent_of(bead: Dict[str, Any]) -> Optional[str]:
    """The `parent-child` parent id, from the `parent` bd reports or the dependency edges."""
    if bead.get("parent"):
        return bead["parent"]
    for d in bead.get("dependencies") or []:
        if d.get("type") == "parent-child" and d.get("issue_id") == bead["id"] and d.get("depends_on_id"):
            return d["depends_on_id"]
        if d.get("dependency_type") == "parent-child" and d.get("id"):
            return d["id"]
    return None


def fields(bead: Dict[str, Any]) -> Dict[str, Any]:
    """The task fields a bead holds, plus its bookkeeping (status, createdAt, updatedAt, metadata)."""
    metadata = bead.get("metadata") if isinstance(bead.get("metadata"), dict) else {}
    config = metadata.get("kanboard") if isinstance(metadata.get("kanboard"), dict) else {}
    result = {
        "title": bead.get("title") or "",
        "description": bead.get("description") or "",
        "plan": bead.get("design") or "",
        "column": column_for(bead.get("status")),
        "dependsOn": blocks_deps(bead),
        "parent": parent_of(bead),
        "ticket": bead.get("external_ref") or None,
        "status": bead.get("status") or "open",
        "createdAt": bead.get("created_at") or now_iso(),
        "updatedAt": bead.get("updated_at") or bead.get("created_at") or now_iso(),
        "metadata": metadata,
    }
    for key in CONFIG_KEYS:
        result[key] = config.get(key)
    return result


def differs(key: str, a: Any, b: Any) -> bool:
    if key == "dependsOn":
        return set(a or []) != set(b or [])
    return a != b


def metadata_with(seen_metadata: Dict[str, Any], t: Dict[str, Any]) -> Dict[str, Any]:
    """The bead metadata for `t`: its foreign keys kept, kanboard's routing replaced."""
    return {**(seen_metadata or {}), "kanboard": {k: t.get(k) for k in CONFIG_KEYS}}


def runtime_record(t: Dict[str, Any]) -> Dict[str, Any]:
    return {k: t.get(k) for k in RUNTIME_KEYS}


def upgrade_runtime(record: Dict[str, Any], legacy_context: Callable[..., Dict[str, Any]],
                    legacy_attachment: Callable[[Dict[str, Any], str], Optional[Dict[str, Any]]]) -> bool:
    """Moves a record from before managed agents onto presentation and execution, once: its cmux workspace becomes a
    legacy presentation, a started task's agent a legacy execution (its terminal owns it; never restarted unasked) and
    its origin's workspace/surface a terminal context. True when it changed."""
    changed = False
    if "workspace" in record and "execution" not in record:
        workspace, worktree = record.pop("workspace"), record.get("worktree")
        presentation = None
        if isinstance(workspace, dict) and isinstance(worktree, str) and worktree:
            presentation = legacy_attachment({**workspace, "alive": False}, worktree)
        record["presentation"] = presentation
        record["execution"] = {"kind": "legacy", "session": None, "stopped": False} if worktree else None
        changed = True
    origin = record.get("origin")
    if isinstance(origin, dict) and "terminal" not in origin:
        record["origin"] = {"session": origin.get("session"), "terminal": legacy_context(origin=origin)} \
            if isinstance(origin.get("session"), str) and origin["session"] else None
        changed = True
    return changed


class Workspace:
    """The board's bd workspace, called with ambient beads/git routing scrubbed from the environment."""

    def __init__(self, home: Path, base_env: Dict[str, str]):
        self.root = home / "beads"
        self.dir = self.root / ".beads"
        self.marker = self.root / "prepared.json"
        env = {k: v for k, v in base_env.items() if not k.startswith(("BEADS_", "BD_", "GIT_", "DOLT_"))}
        env.update(BEADS_DIR=str(self.dir), BD_NON_INTERACTIVE="1", BD_NO_DEP_TYPE_WARNING="1", NO_COLOR="1",
                   BD_LAST_TOUCHED_FALLBACK="0")
        self.env = env
        self.binary = shutil.which("bd", path=env.get("PATH"))
        self.lock = threading.Lock()

    # commands

    def require_binary(self) -> str:
        if not self.binary:
            raise BeadsError("Orchestrator needs Beads (bd), which isn't installed: run brew install beads")
        return self.binary

    def call(self, args: List[str], stdin: Optional[str] = None, timeout: float = BD_TIMEOUT,
             json_out: bool = True) -> Any:
        cmd = [self.require_binary(), "--actor", ACTOR, *(["--json"] if json_out else []), *args]
        try:
            with self.lock:
                p = subprocess.run(cmd, cwd=self.root, env=self.env, input=stdin if stdin is not None else "",
                                   capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise BeadsError(f"bd {args[0]} timed out after {timeout:.0f}s (is another bd process holding the database?)")
        except OSError as e:
            raise BeadsError(f"bd {args[0]}: {e}")
        if p.returncode != 0:
            message = self.error_text(p.stdout, p.stderr) or f"exited with code {p.returncode}"
            error = BeadsConflict if p.returncode == CONFLICT_EXIT else BeadsError
            raise error(f"bd {args[0]}: {message}")
        if not json_out:
            return p.stdout
        try:
            return json.loads(p.stdout) if p.stdout.strip() else None
        except ValueError:
            raise BeadsError(f"bd {args[0]} printed no JSON: {p.stdout.strip()[:200]}")

    @staticmethod
    def error_text(stdout: str, stderr: str) -> str:
        try:
            data = json.loads(stdout)
        except ValueError:
            data = None
        if isinstance(data, dict):
            failed = data.get("failed")
            if isinstance(failed, list) and failed and isinstance(failed[0], dict) and failed[0].get("error"):
                return str(failed[0]["error"])
            if data.get("error"):
                return str(data["error"])
        lines = [l.strip() for l in stderr.splitlines()
                 if l.strip() and not l.lstrip().startswith(("warning:", "Fix:", "Or:", "Hint:"))]
        return lines[-1] if lines else stdout.strip()[-300:]

    def list_all(self) -> List[Dict[str, Any]]:
        data = self.call(["list", "--all", "--limit", "0", "--flat"])
        if not isinstance(data, list):
            raise BeadsError("bd list returned no issue list")
        return data

    def show(self, bead_id: str) -> Dict[str, Any]:
        data = self.call(["show", "--id", bead_id])
        bead = data[0] if isinstance(data, list) and data else data
        if not isinstance(bead, dict) or bead.get("id") != bead_id:
            raise BeadsError(f"bd show: no issue {bead_id}")
        return bead

    def create(self, t: Dict[str, Any]) -> Dict[str, Any]:
        args = ["create", "--title", t["title"], "--description", t.get("description") or "",
                "--design", t.get("plan") or "", "--type", "task", "--priority", "2",
                "--status", STATUS_FOR_COLUMN[t["column"]], "--metadata", json.dumps(metadata_with({}, t))]
        if t.get("ticket"):
            args += ["--external-ref", t["ticket"]]
        if t.get("dependsOn"):
            args += ["--deps", ",".join(t["dependsOn"])]
        if t.get("parent"):
            args += ["--parent", t["parent"]]
        bead = self.call(args)
        if not isinstance(bead, dict) or not bead.get("id"):
            raise BeadsError("bd create returned no issue")
        return self.show(bead["id"])

    def update(self, bead_id: str, args: List[str], if_status: Optional[str] = None) -> None:
        guard = ["--if-status", if_status] if if_status else []
        self.call(["update", bead_id, *args, *guard])

    def add_dep(self, bead_id: str, dep: str) -> None:
        self.call(["dep", "add", bead_id, dep, "--type", "blocks"])

    def remove_dep(self, bead_id: str, dep: str) -> None:
        self.call(["dep", "remove", bead_id, dep])

    def delete(self, bead_id: str) -> None:
        self.call(["delete", bead_id, "--force"])

    def history(self, bead_id: str, limit: int, events: bool) -> Any:
        return self.call(["history", bead_id, "--limit", str(limit), *(["--events"] if events else [])])

    def blocked(self) -> Dict[str, List[str]]:
        """Every issue Beads counts blocked, with the ids it reports blocking it (inherited parent blocks included)."""
        data = self.call(["blocked"])
        if not isinstance(data, list):
            raise BeadsError("bd blocked returned no issue list")
        return {b["id"]: [x for x in b.get("blocked_by") or [] if isinstance(x, str)] for b in data if b.get("id")}

    def ready_explained(self) -> Dict[str, Any]:
        data = self.call(["ready", "--explain", "--limit", "0"])
        if not isinstance(data, dict):
            raise BeadsError("bd ready --explain returned no explanation")
        return data

    def append_notes(self, bead_id: str, text: str) -> Dict[str, Any]:
        self.call(["update", bead_id, "--append-notes", text])
        return self.show(bead_id)

    # change detection

    def fingerprint(self) -> Optional[Tuple[Tuple[str, int, int], ...]]:
        """The embedded Dolt store's commit files (every bd write moves them); None when it isn't embedded Dolt."""
        try:
            metadata = json.loads((self.dir / "metadata.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if metadata.get("dolt_mode") != "embedded" or not metadata.get("dolt_database"):
            return None
        noms = self.dir / "embeddeddolt" / metadata["dolt_database"] / ".dolt" / "noms"
        stamps = []
        for name in ("manifest", "journal.idx"):
            try:
                st = (noms / name).stat()
            except OSError:
                continue
            stamps.append((name, st.st_mtime_ns, st.st_size))
        return tuple(stamps) or None

    # setup

    def initialized(self) -> bool:
        return (self.dir / "metadata.json").is_file()

    def prepared(self) -> bool:
        return self.initialized() and self.marker.is_file()

    def init(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        if not (self.root / ".git").exists():
            # Its own repository keeps bd from attaching the workspace to an enclosing checkout.
            p = subprocess.run(["git", "init", "-q"], cwd=self.root, env=self.env, capture_output=True, text=True)
            if p.returncode != 0:
                raise BeadsError(f"git init {self.root}: {p.stderr.strip()}")
        self.call(["init", "--non-interactive", "--prefix", PREFIX, "--skip-agents", "--skip-hooks",
                   "--role", "maintainer", "--quiet"], json_out=False, timeout=IMPORT_TIMEOUT)
        if not self.initialized():
            raise BeadsError(f"bd init left no workspace in {self.dir}")

    def configure(self) -> None:
        self.call(["config", "set", "status.custom", CUSTOM_STATUSES], json_out=False)
        self.call(["config", "set", "issue_id_mode", "counter"], json_out=False)
        mode = self.call(["config", "get", "issue_id_mode"], json_out=False).strip()
        if mode != "counter":
            raise BeadsError(f"bd kept issue_id_mode {mode!r}; Orchestrator needs sequential KB-<n> ids (counter)")

    def import_rows(self, rows: List[Dict[str, Any]]) -> Any:
        return self.call(["import", "-"], stdin="".join(json.dumps(r) + "\n" for r in rows), timeout=IMPORT_TIMEOUT)


# --- legacy migration ---------------------------------------------------------------

def legacy_tasks(tasks_dir: Path) -> List[Tuple[Path, Dict[str, Any], str]]:
    """(task dir, task.json, plan.md) of every legacy JSON task; unreadable ones stop the migration."""
    found = []
    for task_file in sorted(tasks_dir.glob("*/task.json")):
        try:
            t = json.loads(task_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise BeadsError(f"can't read legacy {task_file}: {e}")
        if not isinstance(t, dict) or not t.get("id") or t["id"] != task_file.parent.name:
            raise BeadsError(f"legacy {task_file} has no matching id")
        plan_file = task_file.with_name("plan.md")
        plan = plan_file.read_text(encoding="utf-8") if plan_file.is_file() else ""
        found.append((task_file.parent, t, plan))
    return found


def legacy_row(t: Dict[str, Any], plan: str, known: set, default_base: Callable[[str], str]) -> Dict[str, Any]:
    created = t.get("createdAt") or now_iso()
    status = STATUS_FOR_COLUMN.get(t.get("column"), "open")
    mode = t.get("planningMode")
    config = {
        "repo": t["repo"], "checkout": t.get("checkout") or t["repo"],
        "base": t.get("base") or default_base(t["repo"]), "branch": t.get("branch") or "",
        "branchEdited": bool(t.get("branchEdited")), "merge": t.get("merge") or "pr",
        "planningMode": mode if mode in ("auto", "plan", "fast") else "plan",
    }
    row: Dict[str, Any] = {
        "id": t["id"], "title": t.get("title") or t["id"], "description": t.get("description") or "",
        "design": plan, "status": status, "priority": 2, "issue_type": "task",
        "created_at": created, "updated_at": t.get("updatedAt") or created,
        "metadata": {"kanboard": config},
        "dependencies": [{"issue_id": t["id"], "depends_on_id": d, "type": "blocks"}
                         for d in dict.fromkeys(t.get("dependsOn") or []) if d in known and d != t["id"]],
    }
    if t.get("ticket"):
        row["external_ref"] = t["ticket"]
    if status == "closed":
        row["closed_at"] = (t.get("merged") or {}).get("at") or row["updated_at"]
    return row


def legacy_runtime(t: Dict[str, Any], plan_file: Path) -> Dict[str, Any]:
    record = {k: t.get(k) for k in LEGACY_RUNTIME_KEYS}
    record["seenColumn"] = column_for(STATUS_FOR_COLUMN.get(t.get("column"), "open"))
    if record["planUpdatedAt"] is None and plan_file.is_file():
        record["planUpdatedAt"] = datetime.fromtimestamp(plan_file.stat().st_mtime, timezone.utc) \
            .isoformat(timespec="seconds").replace("+00:00", "Z")
    return record


def id_number(bead_id: str) -> Optional[int]:
    m = re.fullmatch(rf"{PREFIX}-(\d+)", bead_id)
    return int(m.group(1)) if m else None


def reserve_ids(workspace: Workspace, floor: int, log: Callable[[str], None]) -> None:
    """Moves bd's id counter past `floor` and every existing KB-<n>, so no id the legacy board handed out is reused."""
    found = workspace.list_all()
    leftovers = [b["id"] for b in found if (b.get("metadata") or {}).get(RESERVED_KEY)]
    top = max([0] + [n for b in found if b["id"] not in leftovers for n in [id_number(b["id"])] if n is not None])
    if top >= floor and not leftovers:
        return
    floor = max(floor, top)
    log(f"orchestrator: reserving ids up to {PREFIX}-{floor}")
    reserved = list(leftovers)
    marker = json.dumps({RESERVED_KEY: True})
    if f"{PREFIX}-{floor}" not in {b["id"] for b in found}:
        workspace.call(["create", "--id", f"{PREFIX}-{floor}", "--title", "Reserved id", "--metadata", marker])
        reserved.append(f"{PREFIX}-{floor}")
    while True:
        bead = workspace.call(["create", "--title", "Reserved id", "--metadata", marker])
        reserved.append(bead["id"])
        if (id_number(bead["id"]) or 0) > floor:
            break
    workspace.call(["delete", *reserved, "--force"])



def prepare(home: Path, base_env: Dict[str, str], default_base: Callable[[str], str],
            log: Callable[[str], None]) -> None:
    """Readies <home> once: Beads workspace, legacy JSON import, id reservation; safe to rerun after interruption."""
    workspace = Workspace(home, base_env)
    workspace.require_binary()
    tasks_dir = home / "tasks"
    if workspace.prepared():
        log(f"orchestrator: {workspace.root} is ready")
        return
    if not workspace.initialized():
        log(f"orchestrator: creating the Beads workspace {workspace.root}")
        workspace.init()
    workspace.configure()
    legacy = legacy_tasks(tasks_dir)
    backup = None
    if legacy:
        backup = home / f"legacy-backup-{time.strftime('%Y%m%d-%H%M%S')}"
        log(f"orchestrator: backing up {len(legacy)} legacy tasks to {backup}")
        for task_dir, _, _ in legacy:
            for name in LEGACY_FILES:
                if (task_dir / name).is_file():
                    (backup / "tasks" / task_dir.name).mkdir(parents=True, exist_ok=True)
                    shutil.copy2(task_dir / name, backup / "tasks" / task_dir.name / name)
        if (home / "board.json").is_file():
            backup.mkdir(parents=True, exist_ok=True)
            shutil.copy2(home / "board.json", backup / "board.json")
        ids = {t["id"] for _, t, _ in legacy}
        known = ids | {b["id"] for b in workspace.list_all()}
        rows = [legacy_row(t, plan, known, default_base) for _, t, plan in legacy]
        log(f"orchestrator: importing {len(rows)} tasks into Beads")
        workspace.import_rows(rows)
        present = {b["id"] for b in workspace.list_all()}
        missing = sorted(ids - present, key=lambda i: (len(i), i))
        if missing:
            raise BeadsError(f"the import left out {', '.join(missing)}; legacy files kept, backup in {backup}")
        for task_dir, t, _ in legacy:
            write_atomic(task_dir / "execution.json", json.dumps(legacy_runtime(t, task_dir / "plan.md"), indent=2))
        for task_dir, _, _ in legacy:
            for name in LEGACY_FILES:
                (task_dir / name).unlink(missing_ok=True)
    try:
        next_id = int(json.loads((home / "board.json").read_text(encoding="utf-8")).get("nextId") or 1)
    except (OSError, ValueError, TypeError, AttributeError):
        next_id = 1
    reserve_ids(workspace, next_id - 1, log)
    write_atomic(workspace.marker, json.dumps({"preparedAt": now_iso(), "imported": [t["id"] for _, t, _ in legacy],
                                               "backup": str(backup) if backup else None}, indent=2))
    log(f"orchestrator: {workspace.root} is ready" + (f" ({len(legacy)} tasks imported)" if legacy else ""))
