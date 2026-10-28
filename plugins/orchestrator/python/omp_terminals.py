"""Terminal presentation adapters (cmux workspace, tmux window, plain attach command); standard library only."""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import webbrowser
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple
from urllib.parse import urlsplit

KINDS = ("cmux", "tmux", "plain")
OVERRIDES = ("auto",) + KINDS
OVERRIDE_ENVS = ("OMP_TERMINAL",)
DEFAULT_CMUX_SOCKET = str(Path.home() / ".local/state/cmux/cmux.sock")
CMUX_HANDLE = re.compile(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|(?:workspace|surface|window):\d+")
CMUX_BUNDLED = re.compile(r"\.app/Contents/Resources/bin/cmux$")
TMUX_PANE = re.compile(r"%\d+")
TMUX_WINDOW = re.compile(r"@\d+")
TMUX_SESSION = re.compile(r"\$\d+")
NAME_LIMIT = 200
EXTRA_PATH = ["/Applications/cmux.app/Contents/Resources/bin", "/opt/homebrew/bin", "/usr/local/bin"]
# Caller identity a command could fall back on instead of its explicit target.
CALLER_ENV = re.compile(r"(CMUX_(?!SOCKET_PASSWORD$).*|TMUX|TMUX_PANE)")


def _env() -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not CALLER_ENV.fullmatch(k)}
    parts = [p for p in env.get("PATH", "").split(":") if p]
    env["PATH"] = ":".join(parts + [p for p in EXTRA_PATH if p not in parts])
    return env


def _which(name: str) -> Optional[str]:
    return shutil.which(name, path=_env()["PATH"])


def _run(cmd: List[str], timeout: float = 10) -> Tuple[int, str, str]:
    """Runs a command without a shell or caller terminal identity; returns (exit code, stdout, stderr)."""
    try:
        p = subprocess.run(cmd, env=_env(), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", f"{cmd[0]}: command not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"{cmd[0]} timed out after {int(timeout)}s"
    except OSError as e:
        return 126, "", f"{cmd[0]}: {e}"


# --- validation

def _text(value: Any, what: str, pattern: Optional[re.Pattern] = None) -> str:
    if not isinstance(value, str) or not value or len(value) > 1024 or (pattern and not pattern.fullmatch(value)):
        raise ValueError(f"Invalid {what}")
    return value


def _socket(value: Any, what: str) -> str:
    path = _text(value, what)
    if not os.path.isabs(path):
        raise ValueError(f"{what} must be an absolute path")
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return path
    if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid():
        raise ValueError(f"{what} {path} isn't this user's socket")
    return path


def _cmux_cli(value: Any) -> str:
    path = _text(value, "cmux CLI")
    real = os.path.realpath(path)
    found = _which("cmux")
    trusted = CMUX_BUNDLED.search(real) or (found and real == os.path.realpath(found))
    if not os.path.isabs(path) or not trusted or not os.access(real, os.X_OK):
        raise ValueError(f"Untrusted cmux CLI {path}")
    return path


def _cmux_part(value: Any, terminal: bool) -> Dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError("cmux context must be an object")
    part = {"cli": _cmux_cli(value.get("cli")), "socket": _socket(value.get("socket"), "cmux socket"),
            "workspace": _text(value.get("workspace"), "cmux workspace", CMUX_HANDLE)}
    if value.get("surface") is not None or terminal:
        part["surface"] = _text(value.get("surface"), "cmux surface", CMUX_HANDLE)
    if value.get("window") is not None:
        part["window"] = _text(value.get("window"), "cmux window", CMUX_HANDLE)
    return part


def _tmux_part(value: Any) -> Dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError("tmux context must be an object")
    return {"socket": _socket(value.get("socket"), "tmux socket"), "pane": _text(value.get("pane"), "tmux pane", TMUX_PANE)}


def normalize_context(value: Any) -> Dict[str, Any]:
    """The validated terminal context of an omp session; raises ValueError."""
    if not isinstance(value, dict) or value.get("kind") not in KINDS:
        raise ValueError("Terminal context needs kind cmux, tmux or plain")
    kind = value["kind"]
    context: Dict[str, Any] = {"kind": kind}
    if value.get("cmux") is not None or kind == "cmux":
        context["cmux"] = _cmux_part(value.get("cmux"), kind == "cmux")
    if kind == "tmux":
        context["tmux"] = _tmux_part(value.get("tmux"))
    return context


def legacy_context(workspace: Any = None, origin: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """A context from bare cmux workspace/surface handles recorded before terminal contexts, else plain."""
    origin = origin or {}
    if isinstance(workspace, dict):
        workspace = workspace.get("id") or workspace.get("ref")
    cli = _which("cmux")
    handle = origin.get("workspace") or workspace
    if not cli or not handle:
        return {"kind": "plain"}
    try:
        part = {"cli": cli, "socket": DEFAULT_CMUX_SOCKET, "workspace": handle, "surface": origin.get("surface")}
        return normalize_context({"kind": "cmux" if part["surface"] else "plain", "cmux": part})
    except ValueError:
        return {"kind": "plain"}


def legacy_attachment(workspace: Dict[str, Any], cwd: str) -> Optional[Dict[str, Any]]:
    """An attachment for a cmux workspace record whose program runs directly in it; None when unusable."""
    cli = _which("cmux")
    handle = workspace.get("id") or workspace.get("ref")
    if not cli or not handle:
        return None
    try:
        part = _cmux_part({"cli": cli, "socket": DEFAULT_CMUX_SOCKET, "workspace": handle}, False)
    except ValueError:
        return None
    return _attachment("cmux", str(workspace.get("ref") or handle), cwd, None, bool(workspace.get("alive")), cmux=part)


def capabilities(target: Dict[str, Any]) -> Dict[str, bool]:
    """What a context or attachment can present: focus/close its terminal, a cmux diff panel, the board in cmux's browser."""
    kind = target.get("kind")
    browser = bool(target.get("cmux"))
    return {"focus": kind in ("cmux", "tmux"), "close": kind in ("cmux", "tmux"), "diff": browser, "board": browser}


def _attachment(kind: str, name: str, cwd: str, command: Optional[str], alive: bool, **parts: Any) -> Dict[str, Any]:
    att: Dict[str, Any] = {"kind": kind, "name": name, "cwd": cwd, "command": command, "alive": alive}
    att.update({k: v for k, v in parts.items() if v})
    att["capabilities"] = capabilities(att)
    return att


# --- cmux

def _cmux(part: Dict[str, str], args: List[str], timeout: float = 10) -> Tuple[int, str, str]:
    return _run([part["cli"], "--socket", part["socket"], *args], timeout=timeout)


def _cmux_panels(part: Dict[str, str], workspace: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """The exact workspace's panels (read-only); None when it isn't there."""
    code, out, _ = _cmux(part, ["--json", "--id-format", "both", "list-panels", "--workspace", workspace or part["workspace"]])
    if code != 0:
        return None
    try:
        data = json.loads(out)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _cmux_target(part: Dict[str, str]) -> Dict[str, Any]:
    """Validates the context's workspace and surface; returns its panels."""
    panels = _cmux_panels(part)
    if panels is None:
        raise RuntimeError(f"cmux workspace {part['workspace']} isn't open on {part['socket']}")
    surface = part.get("surface")
    if surface and not any(surface in (s.get("id"), s.get("ref")) for s in panels.get("surfaces") or []):
        raise RuntimeError(f"cmux surface {surface} isn't in workspace {part['workspace']}")
    return panels


def _created_workspace(out: str) -> Optional[str]:
    try:
        data = json.loads(out)
    except ValueError:
        data = None
    if isinstance(data, dict):
        for key in ("workspace_id", "workspace_ref", "workspace", "id", "ref"):
            if isinstance(data.get(key), str) and CMUX_HANDLE.fullmatch(data[key]):
                return data[key]
    m = re.search(CMUX_HANDLE.pattern, out)
    return m.group(0) if m else None


def _open_cmux(context: Dict[str, Any], name: str, cwd: str, command: str) -> Dict[str, Any]:
    part = context["cmux"]
    window = _cmux_target(part).get("window_id")
    args = ["--json", "--id-format", "uuids", "new-workspace", "--name", name, "--cwd", cwd, "--command", command,
            "--focus", "false"]
    if window:
        args += ["--window", window]
    code, out, err = _cmux(part, args, timeout=20)
    if code != 0:
        raise RuntimeError(f"cmux new-workspace failed: {(err or out).strip()}")
    handle = _created_workspace(out)
    created = _cmux_panels(part, handle) if handle else None
    if not created:
        raise RuntimeError(f"cmux didn't report the workspace it created: {out.strip()[:200]}")
    workspace = {"cli": part["cli"], "socket": part["socket"], "workspace": created.get("workspace_id") or handle}
    if created.get("window_id"):
        workspace["window"] = created["window_id"]
    return _attachment("cmux", name, cwd, command, True, cmux=workspace)


# --- tmux

def _tmux(part: Dict[str, str], args: List[str], timeout: float = 10) -> Tuple[int, str, str]:
    binary = _which("tmux")
    if not binary:
        return 127, "", "tmux isn't installed"
    return _run([binary, "-S", part["socket"], *args], timeout=timeout)


def _tmux_show(part: Dict[str, str], target: str, fmt: str) -> Optional[str]:
    code, out, _ = _tmux(part, ["display-message", "-p", "-t", target, fmt])
    return out.strip() if code == 0 else None


def _open_tmux(context: Dict[str, Any], name: str, cwd: str, command: str) -> Dict[str, Any]:
    part = context["tmux"]
    shown = _tmux_show(part, part["pane"], "#{pane_id} #{session_id}")
    if not shown or shown.split()[0] != part["pane"]:
        raise RuntimeError(f"tmux pane {part['pane']} isn't on {part['socket']}")
    session = shown.split()[1]
    code, out, err = _tmux(part, ["new-window", "-d", "-P", "-F", "#{session_id} #{window_id} #{pane_id}",
                                  "-t", f"{session}:", "-n", name, "-c", cwd, "/bin/sh", "-c", command])
    if code != 0:
        raise RuntimeError(f"tmux new-window failed: {(err or out).strip()}")
    ids = out.split()
    if len(ids) != 3 or not (TMUX_SESSION.fullmatch(ids[0]) and TMUX_WINDOW.fullmatch(ids[1]) and TMUX_PANE.fullmatch(ids[2])):
        raise RuntimeError(f"tmux didn't report the window it created: {out.strip()[:200]}")
    tmux = {"socket": part["socket"], "session": ids[0], "window": ids[1], "pane": ids[2]}
    return _attachment("tmux", name, cwd, command, True, tmux=tmux, cmux=context.get("cmux"))


def _tmux_alive(att: Dict[str, Any]) -> bool:
    part = att["tmux"]
    return _tmux_show(part, part["pane"], "#{window_id}") == part["window"]


# --- attachments

def open_terminal(context: Dict[str, Any], name: str, cwd: str, command: str) -> Dict[str, Any]:
    """Opens `command` in a new unfocused terminal of the context's presentation; plain opens nothing."""
    name = (name or "agent")[:NAME_LIMIT]
    if context["kind"] == "cmux":
        return _open_cmux(context, name, cwd, command)
    if context["kind"] == "tmux":
        return _open_tmux(context, name, cwd, command)
    return _attachment("plain", name, cwd, command, False, cmux=context.get("cmux"))


def attach_command(att: Dict[str, Any]) -> Optional[str]:
    """The shell command that attaches any terminal to the agent; None for a legacy attachment."""
    return f"cd {shlex.quote(att['cwd'])} && {att['command']}" if att.get("command") else None


def alive(att: Dict[str, Any]) -> bool:
    """Whether the attachment's terminal is still open; says nothing about the agent."""
    if att.get("kind") == "cmux":
        return _cmux_panels(att["cmux"]) is not None
    if att.get("kind") == "tmux":
        return _tmux_alive(att)
    return False


def focus(target: Dict[str, Any]) -> bool:
    """Brings an attachment's or a context's terminal forward, for an explicit user open."""
    if target.get("kind") == "cmux":
        part = target["cmux"]
        if _cmux(part, ["select-workspace", "--workspace", part["workspace"]])[0] != 0:
            return False
        return not part.get("surface") or _cmux(part, ["focus-panel", "--panel", part["surface"], "--workspace", part["workspace"]])[0] == 0
    if target.get("kind") == "tmux":
        part = target["tmux"]
        window = _tmux_show(part, part["pane"], "#{window_id}")
        if not window or window != part.get("window", window):
            return False
        return _tmux(part, ["select-window", "-t", window])[0] == 0 and _tmux(part, ["select-pane", "-t", part["pane"]])[0] == 0
    return False


def close(att: Dict[str, Any]) -> None:
    """Closes the attachment's terminal; a managed agent keeps running in its host."""
    if att.get("kind") == "cmux":
        _cmux(att["cmux"], ["workspace", "close", "--force", "--workspace", att["cmux"]["workspace"]])
    elif att.get("kind") == "tmux" and _tmux_alive(att):
        _tmux(att["tmux"], ["kill-window", "-t", att["tmux"]["window"]])


# --- browser panels

def _board_surface(part: Dict[str, str], url: str) -> Optional[str]:
    """The browser surface in the context's workspace that already shows this board."""
    split = urlsplit(url)
    prefix = f"{split.scheme}://{split.netloc}/"
    code, out, _ = _cmux(part, ["--json", "--id-format", "uuids", "tree", "--workspace", part["workspace"]])
    if code != 0:
        return None
    try:
        tree = json.loads(out)
    except ValueError:
        return None
    for window in tree.get("windows") or []:
        for workspace in window.get("workspaces") or []:
            for pane in workspace.get("panes") or []:
                for surface in pane.get("surfaces") or []:
                    if surface.get("type") == "browser" and str(surface.get("url") or "").startswith(prefix):
                        return surface.get("id") or surface.get("ref")
    return None


def open_board(context: Dict[str, Any], url: str, focus: bool = False) -> bool:
    """Shows the board in the context's cmux workspace (its board surface, else a new split); False without cmux."""
    part = context.get("cmux")
    if not part or _cmux_panels(part) is None:
        return False
    surface = _board_surface(part, url)
    if surface:
        if _cmux(part, ["browser", "--surface", surface, "navigate", url])[0] != 0:
            return False
        if focus:
            _cmux(part, ["focus-panel", "--panel", surface, "--workspace", part["workspace"]])
        return True
    return _cmux(part, ["browser", "open-split", url, "--workspace", part["workspace"], "--focus", str(focus).lower()])[0] == 0


def open_diff(target: Dict[str, Any], path: str, base: str, title: str) -> bool:
    """Opens cmux's diff panel for `path` against `base` in the target's cmux workspace; False when it has no cmux."""
    part = target.get("cmux")
    if not part:
        return False
    args = ["diff", "--source", "branch", "--cwd", path, "--base", base, "--title", title, "--workspace", part["workspace"],
            "--focus", "true"]
    code, out, err = _cmux(part, args, timeout=20)
    if code != 0:
        raise RuntimeError((err or out).strip() or "cmux diff failed")
    return True


# --- caller detection (runs in the caller's process, never in the server)

def _detect_cmux(environ: Mapping[str, str]) -> Tuple[Optional[Dict[str, str]], str]:
    workspace, surface = environ.get("CMUX_WORKSPACE_ID"), environ.get("CMUX_SURFACE_ID")
    if not workspace or not surface:
        return None, "this terminal isn't a cmux surface"
    cli = environ.get("CMUX_BUNDLED_CLI_PATH") or _which("cmux")
    try:
        part = _cmux_part({"cli": cli, "socket": environ.get("CMUX_SOCKET_PATH") or DEFAULT_CMUX_SOCKET,
                           "workspace": workspace, "surface": surface}, True)
        _cmux_target(part)
    except (ValueError, RuntimeError) as e:
        return None, str(e)
    return part, ""


def _detect_tmux(environ: Mapping[str, str]) -> Tuple[Optional[Dict[str, str]], str]:
    tmux, pane = environ.get("TMUX"), environ.get("TMUX_PANE")
    if not tmux or not pane:
        return None, "this terminal isn't a tmux pane"
    try:
        part = _tmux_part({"socket": tmux.rsplit(",", 2)[0], "pane": pane})
    except ValueError as e:
        return None, str(e)
    if _tmux_show(part, pane, "#{pane_id}") != pane:
        return None, f"tmux pane {pane} isn't on {part['socket']}"
    return part, ""


def detect_context(environ: Mapping[str, str], override_envs: Tuple[str, ...] = OVERRIDE_ENVS) -> Dict[str, Any]:
    """The calling terminal's context: nested tmux wins presentation, a valid cmux stays for the browser; the first set `override_envs` forces a kind."""
    name = next((n for n in override_envs if environ.get(n)), override_envs[0] if override_envs else "override")
    override = (environ.get(name) or "auto").strip().lower()
    if override not in OVERRIDES:
        raise ValueError(f"{name} must be one of {', '.join(OVERRIDES)}, not {override}")
    cmux, cmux_why = _detect_cmux(environ)
    tmux, tmux_why = _detect_tmux(environ) if override in ("auto", "tmux") else (None, "")
    if override == "cmux" and not cmux:
        raise ValueError(f"{name}=cmux, but {cmux_why}")
    if override == "tmux" and not tmux:
        raise ValueError(f"{name}=tmux, but {tmux_why}")
    kind = override if override != "auto" else "tmux" if tmux else "cmux" if cmux else "plain"
    context: Dict[str, Any] = {"kind": kind}
    if cmux:
        context["cmux"] = cmux
    if kind == "tmux":
        context["tmux"] = tmux
    return context


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="omp_terminals.py", description="Terminal presentation for the calling terminal.")
    parser.add_argument("--override-env", action="append", metavar="NAME",
                        help=f"env var forcing auto|cmux|tmux|plain, first set wins (repeatable; default {', '.join(OVERRIDE_ENVS)})")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("detect", help="print this terminal's validated context as JSON")
    board = sub.add_parser("board", help="open a URL in the terminal's cmux workspace, else the default browser")
    board.add_argument("url")
    board.add_argument("--focus", action=argparse.BooleanOptionalAction, default=True)
    board.add_argument("--context", help="a context JSON from detect, instead of detecting this terminal")
    args = parser.parse_args(argv)
    try:
        given = getattr(args, "context", None)
        envs = tuple(args.override_env) if args.override_env else OVERRIDE_ENVS
        context = normalize_context(json.loads(given)) if given else detect_context(os.environ, envs)
    except ValueError as e:
        print(f"terminals: {e}", file=sys.stderr)
        return 2
    if args.command == "detect":
        print(json.dumps(context))
        return 0
    if open_board(context, args.url, args.focus):
        return 0
    if webbrowser.open(args.url):
        return 0
    print(f"terminals: no browser to open; visit {args.url}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
