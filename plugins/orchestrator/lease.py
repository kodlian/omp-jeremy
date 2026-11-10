"""Whether an omp session's process runs: the live omp holds a lock on its session's lease file while it owns it."""
from __future__ import annotations

import fcntl
import json
import os
import struct
import sys
import time
from pathlib import Path
from typing import Dict, Optional, Tuple

from runtime import run, which

LEASE_DIR = Path(os.environ.get("ORCHESTRATOR_LEASE_DIR") or (
    os.path.join(os.environ["XDG_STATE_HOME"], "omp/run/session-owners") if os.environ.get("XDG_STATE_HOME")
    else "~/.omp/run/session-owners")).expanduser()
CACHE_SECONDS = 2.0
_cache: Dict[str, Tuple[float, bool]] = {}


def held(session_id: Optional[str]) -> bool:
    """Whether a process holds `session_id`'s lease now."""
    if not session_id:
        return False
    path = LEASE_DIR / f"{session_id}.lock"
    if not path.is_file():
        return False
    if sys.platform == "darwin":
        try:
            fd = os.open(path, os.O_RDONLY)
        except OSError:
            return False
        try:
            # macOS struct flock: l_start, l_len, l_pid, l_type, l_whence.
            probe = struct.pack("qqihh", 0, 0, 0, fcntl.F_WRLCK, 0)
            return struct.unpack("qqihh", fcntl.fcntl(fd, fcntl.F_GETLK, probe))[3] != fcntl.F_UNLCK
        except OSError:
            return False
        finally:
            os.close(fd)
    cached = _cache.get(session_id)
    if cached and time.time() - cached[0] < CACHE_SECONDS:
        return cached[1]
    omp = which("omp")
    result = False
    if omp:
        code, out, _ = run([omp, "session", "lease", "--json", "--", session_id], timeout=10)
        try:
            result = code == 0 and session_id in (json.loads(out).get("held") or [])
        except (ValueError, AttributeError):
            result = False
    _cache[session_id] = (time.time(), result)
    return result
