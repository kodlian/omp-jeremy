"""Process, environment, file and path helpers shared by the server modules."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Private-use glyphs (Nerd Font icons) render as boxes outside the terminal.
PRIVATE_USE = re.compile("[\ue000-\uf8ff\U000f0000-\U0010ffff]")
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
# A caller's terminal identity must never become the implicit target of what the server runs.
CALLER_ENV = re.compile(r"CMUX_(?!SOCKET_PASSWORD$).*|TMUX|TMUX_PANE|MISSION_CONTROL_TERMINAL|OMP_TERMINAL"
                        r"|WT_INPLACE|WT_LAUNCHER|WT_CLOSE_ON_CANCEL")
EXTRA_PATH = ["/Applications/cmux.app/Contents/Resources/bin", "/opt/homebrew/bin", str(Path.home() / ".local/bin"),
              "/usr/local/bin"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def child_env(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not CALLER_ENV.fullmatch(k)}
    parts = [p for p in env.get("PATH", "").split(":") if p]
    env["PATH"] = ":".join(parts + [p for p in EXTRA_PATH if p not in parts])
    if extra:
        env.update(extra)
    return env


def which(name: str) -> Optional[str]:
    return shutil.which(name, path=child_env()["PATH"])


def run(cmd: List[str], cwd: Optional[str] = None, timeout: float = 30, env: Optional[Dict[str, str]] = None,
        stdin: Optional[str] = None) -> Tuple[int, str, str]:
    """Runs a command without a shell; returns (exit code, stdout, stderr). `env` adds to child_env(); `stdin` is the
    command's input, none without it."""
    try:
        p = subprocess.run(cmd, cwd=cwd, env=child_env(env), input=stdin, stdin=None if stdin is not None else subprocess.DEVNULL,
                           capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", f"{cmd[0]}: command not found"
    except subprocess.TimeoutExpired as e:
        out = e.stdout if isinstance(e.stdout, str) else ""
        return 124, out, f"{cmd[0]} timed out after {int(timeout)}s"
    except OSError as e:
        return 126, "", f"{cmd[0]}: {e}"


def plain(text: str) -> str:
    return PRIVATE_USE.sub("", text or "")


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def same_dir(a: Optional[str], b: Optional[str]) -> bool:
    if not a or not b:
        return False
    return os.path.realpath(a) == os.path.realpath(b)

