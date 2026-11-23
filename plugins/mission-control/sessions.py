"""A directory's omp sessions, from omp's session files: the one running there (its lease is held), else the latest one
to resume."""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import lease

SESSIONS_DIR = Path(os.environ.get("MISSION_CONTROL_SESSIONS_DIR") or "~/.omp/agent/sessions").expanduser()
HEAD_LIMIT = 65536


def bucket(cwd: str) -> Path:
    """omp's session folder for `cwd`: `-<path>` under home, `-tmp-<path>` under the temp root, else `--<path>--`."""
    real = os.path.realpath(cwd)
    for root, prefix in ((os.path.realpath(Path.home()), "-"), (os.path.realpath(tempfile.gettempdir()), "-tmp-")):
        if real.startswith(root + os.sep):
            return SESSIONS_DIR / (prefix + os.path.relpath(real, root).replace(os.sep, "-"))
    return SESSIONS_DIR / ("--" + real.strip(os.sep).replace(os.sep, "-") + "--")


def session_id(file: Path) -> str:
    """The session id a file is named after: `<timestamp>_<id>.jsonl`."""
    return file.stem.rsplit("_", 1)[-1]


def files(cwd: str) -> List[Path]:
    """The directory's session files, newest first."""
    try:
        found = [f for f in bucket(cwd).iterdir() if f.suffix == ".jsonl" and f.is_file()]
    except OSError:
        return []
    return sorted(found, key=lambda f: f.stat().st_mtime, reverse=True)


def head(file: Path) -> Optional[Dict[str, Any]]:
    """A session file's title and whether anything follows its header; None when it can't be read as a session."""
    try:
        with file.open("rb") as f:
            title: Optional[str] = None
            for _ in range(2):
                line = f.readline(HEAD_LIMIT)
                entry = json.loads(line) if line.strip() else None
                if not isinstance(entry, dict):
                    return None
                if entry.get("type") == "title":
                    title = entry.get("title") or None
                elif entry.get("type") == "session":
                    return {"title": title or entry.get("title") or None, "used": f.tell() < os.fstat(f.fileno()).st_size}
                else:
                    return None
    except (OSError, ValueError):
        return None
    return None


def entry(file: Path, info: Dict[str, Any]) -> Dict[str, Any]:
    at = datetime.fromtimestamp(file.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
    return {"session": {"id": session_id(file), "file": str(file)}, "title": info["title"], "at": at.replace("+00:00", "Z")}


def agent(cwd: str) -> Dict[str, Any]:
    """What omp has in `cwd`: `running` with the sessions whose lease is held (`running`, newest first, the newest one
    as its session), `asleep` with the newest session that has any entry, else `none`. `count` is how many session files
    it has."""
    found = files(cwd)
    held = lease.held_any([session_id(f) for f in found])
    running = [entry(f, info) for f in found if session_id(f) in held and (info := head(f))]
    if running:
        return {"state": "running", **running[0], "count": len(found), "running": running}
    for file in found:
        info = head(file)
        if info and info["used"]:
            return {"state": "asleep", **entry(file, info), "count": len(found), "running": []}
    return {"state": "none", "session": None, "title": None, "at": None, "count": len(found), "running": []}


def find(cwd: str, sid: str) -> Optional[Path]:
    """The directory's session file named `sid`; None when it has none."""
    return next((f for f in files(cwd) if session_id(f) == sid), None)
