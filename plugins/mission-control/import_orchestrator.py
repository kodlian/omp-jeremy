"""The one-time import of the Orchestrator's started cards into a new Mission Control home (server.py --prepare)."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, NoReturn, Optional

from runtime import child_env, now_iso, write_atomic

OLD_HOME = Path(os.environ.get("ORCHESTRATOR_HOME") or "~/.orchestrator").expanduser()
OLD_PORT = os.environ.get("ORCHESTRATOR_PORT", "4747")
METADATA_KEY = "orchestrator"
COLUMN_FOR_STATUS = {"open": "backlog", "todo": "todo", "in_progress": "doing", "review": "review", "closed": "done",
                     "blocked": "backlog", "deferred": "backlog", "pinned": "backlog", "hooked": "doing"}
RUNTIME_KEYS = ("order", "spawn", "worktree", "presentation", "execution", "pr", "merged", "origin", "control",
                "keptWorktree", "intent", "lastOperation", "resumedAt")
TOP_ID = re.compile(r"KB-(\d+)")
BEADS_HINT = ("importing ~/.orchestrator needs Beads once (brew install beads), or set MISSION_CONTROL_IMPORT=skip to "
              "start empty")


def wanted(home: Path) -> bool:
    """Whether `home` is a new board and an Orchestrator board waits to be imported."""
    return os.environ.get("MISSION_CONTROL_IMPORT") != "skip" and not (home / "board.json").exists() \
        and (OLD_HOME / "beads").is_dir()


def stop(message: str) -> NoReturn:
    print(f"mission-control: {message}", file=sys.stderr, flush=True)
    sys.exit(1)


def old_board_running() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{OLD_PORT}/api/health", timeout=1) as reply:
            return reply.headers.get("Server", "").startswith("orchestrator")
    except OSError:
        return False


def list_beads() -> List[Dict[str, Any]]:
    """Every bead of the Orchestrator's Beads workspace, closed ones included."""
    env = {k: v for k, v in child_env().items() if not k.startswith(("BEADS_", "BD_", "GIT_", "DOLT_"))}
    env.update(BEADS_DIR=str(OLD_HOME / "beads" / ".beads"), BD_NON_INTERACTIVE="1", NO_COLOR="1")
    bd = shutil.which("bd", path=env.get("PATH"))
    if not bd:
        stop(BEADS_HINT)
    try:
        p = subprocess.run([bd, "--json", "list", "--all", "--limit", "0", "--flat"], cwd=OLD_HOME / "beads", env=env,
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        found = json.loads(p.stdout) if p.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        found = None
    if not isinstance(found, list):
        stop(BEADS_HINT)
    return [b for b in found if isinstance(b, dict) and isinstance(b.get("id"), str)]


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


def settings(bead: Dict[str, Any]) -> Dict[str, Any]:
    metadata = bead.get("metadata") if isinstance(bead.get("metadata"), dict) else {}
    return metadata.get(METADATA_KEY) if isinstance(metadata.get(METADATA_KEY), dict) else {}


def number(bead_id: str, beads: Dict[str, Dict[str, Any]]) -> str:
    """The number the Orchestrator showed for a card: a child's is its parent's with its place under it."""
    bead = beads.get(bead_id) or {}
    parent = parent_of(bead)
    if parent and bead_id.startswith(parent + "."):
        return number(parent, beads) + bead_id[len(parent):]
    if settings(bead).get("number"):
        return str(settings(bead)["number"])
    return bead_id[3:] if bead_id.startswith("KB-") else bead_id


def card(bead: Dict[str, Any], runtime: Dict[str, Any], beads: Dict[str, Dict[str, Any]], at: str) -> Dict[str, Any]:
    """The Mission Control record of a started Orchestrator card."""
    meta = settings(bead)
    column = COLUMN_FOR_STATUS.get(bead.get("status") or "open", "backlog")
    pr = runtime.get("pr") if isinstance(runtime.get("pr"), dict) else None
    if pr:
        pr = {"base": None, "review": None, "checks": None, "conflicts": False, **pr}
    t: Dict[str, Any] = {k: runtime.get(k) for k in RUNTIME_KEYS}
    t.update(id=bead["id"], title=bead.get("title") or "", description=bead.get("description") or "",
             ticket=bead.get("external_ref") or None, notes=bead.get("notes") or "", dependsOn=blocks_deps(bead),
             parent=parent_of(bead), repo=meta["repo"], base=meta.get("base"), branch=meta.get("branch") or "",
             loop=meta.get("loop"), number=number(bead["id"], beads), tags=[], planned=at, pr=pr,
             held=column in ("backlog", "todo"), createdAt=bead.get("created_at") or at, updatedAt=at,
             column={"doing": "doing", "review": "pr" if (pr or {}).get("state") in ("open", "draft") else "review"}
             .get(column, "waiting"))
    return t


def run(home: Path) -> None:
    """Imports the Orchestrator's open cards whose worktree remains into `home`, lists the others in not-imported.md, and
    carries its projects, settings and card counter over; ~/.orchestrator is only read."""
    if old_board_running():
        stop("stop the Orchestrator first (orchestrator stop)")
    beads = {b["id"]: b for b in list_beads()}
    at = now_iso()
    imported: Dict[str, Dict[str, Any]] = {}
    left: List[Dict[str, Any]] = []
    for bead_id, bead in beads.items():
        if bead.get("status") == "closed":
            continue
        try:
            runtime = json.loads((OLD_HOME / "tasks" / bead_id / "execution.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            runtime = {}
        runtime = runtime if isinstance(runtime, dict) else {}
        if runtime.get("merged"):
            continue
        worktree = runtime.get("worktree")
        if isinstance(worktree, str) and Path(worktree).is_dir() and isinstance(settings(bead).get("repo"), str):
            imported[bead_id] = card(bead, runtime, beads, at)
        else:
            left.append(bead)
    for t in imported.values():
        t["dependsOn"] = [d for d in t["dependsOn"] if d in imported]
        t["parent"] = t["parent"] if t["parent"] in imported else None
        source, target = OLD_HOME / "tasks" / t["id"], home / "tasks" / t["id"]
        if source.is_dir():
            shutil.copytree(source, target, ignore=shutil.ignore_patterns("execution.json"), dirs_exist_ok=True)
        write_atomic(target / "task.json", json.dumps(t, indent=2))
    if left:
        lines = ["# Orchestrator cards not imported", "", "They had no worktree, so Mission Control left them out.", ""]
        for bead in left:
            lines += [f"## #{number(bead['id'], beads)} {bead.get('title') or ''}", "",
                      (bead.get("description") or "").strip() or "(no description)", ""]
        write_atomic(home / "not-imported.md", "\n".join(lines))
    old_config = OLD_HOME / "config.json"
    if old_config.is_file() and not (home / "config.json").exists():
        write_atomic(home / "config.json", old_config.read_text(encoding="utf-8").replace("ORCHESTRATOR_", "MISSION_CONTROL_"))
    try:
        old_board = json.loads((OLD_HOME / "board.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        old_board = {}
    projects: List[Dict[str, Any]] = []
    for flow in old_board.get("flows") or [] if isinstance(old_board, dict) else []:
        if not isinstance(flow, dict) or not isinstance(flow.get("repo"), str):
            continue
        entry = next((p for p in projects if os.path.realpath(p["repo"]) == os.path.realpath(flow["repo"])), None)
        if not entry:
            entry = {"repo": flow["repo"], "concurrencyLimit": None, "controlLoops": None}
            projects.append(entry)
        for key in ("concurrencyLimit", "controlLoops"):
            if entry[key] is None and flow.get(key) is not None:
                entry[key] = flow[key]
    counters = [int(m[1]) for m in (TOP_ID.match(i) for i in beads) if m]
    write_atomic(home / "board.json", json.dumps({"nextId": max(counters, default=0) + 1, "projects": projects}, indent=2))
    print(f"mission-control: imported {len(imported)} cards from ~/.orchestrator ({len(left)} without a worktree listed in "
          "not-imported.md)", file=sys.stderr, flush=True)
