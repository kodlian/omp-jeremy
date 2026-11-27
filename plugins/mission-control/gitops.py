"""Git queries and worktree commands the board runs on project repositories."""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from runtime import run

CREATED_FROM = re.compile(r"\tbranch: Created from (\S+)")
COMMIT = re.compile(r"[0-9a-f]{7,40}")


def git_toplevel(path: str) -> Optional[str]:
    code, out, _ = run(["git", "-C", path, "rev-parse", "--show-toplevel"], timeout=10)
    return out.strip() if code == 0 and out.strip() else None


def has_ref(cwd: str, ref: str) -> bool:
    return run(["git", "-C", cwd, "show-ref", "--verify", "--quiet", ref], timeout=10)[0] == 0


def default_branch(cwd: str) -> str:
    code, out, _ = run(["git", "-C", cwd, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], timeout=10)
    if code == 0 and "/" in out.strip():
        return out.strip().split("/", 1)[1]
    return next((name for name in ("main", "master") if has_ref(cwd, f"refs/heads/{name}")), "main")


def checkout_info(path: str) -> Optional[Dict[str, str]]:
    """For a path inside a git checkout: its root, the repository's main checkout and the branch checked out there."""
    top = git_toplevel(path)
    if not top:
        return None
    code, common, _ = run(["git", "-C", top, "rev-parse", "--path-format=absolute", "--git-common-dir"], timeout=10)
    repo = os.path.dirname(common.strip()) if code == 0 and common.strip() else top
    code, branch, _ = run(["git", "-C", top, "symbolic-ref", "-q", "--short", "HEAD"], timeout=10)
    return {"checkout": top, "repo": repo, "base": branch.strip() if code == 0 and branch.strip() else default_branch(top)}


def base_ref(cwd: str, base: str) -> str:
    """The ref a branch made from `base` is compared with: the newer of origin/<base> and <base>."""
    remote, local = has_ref(cwd, f"refs/remotes/origin/{base}"), has_ref(cwd, f"refs/heads/{base}")
    if remote and local:
        behind = run(["git", "-C", cwd, "merge-base", "--is-ancestor", f"origin/{base}", base], timeout=10)[0] != 0
        return f"origin/{base}" if behind else base
    return f"origin/{base}" if remote else base


def merge_base(cwd: str, base: str) -> Tuple[str, str]:
    ref = base_ref(cwd, base)
    code, out, _ = run(["git", "-C", cwd, "merge-base", "HEAD", ref], timeout=10)
    return ref, (out.strip() if code == 0 and out.strip() else ref)


def registered_worktrees(repo: str) -> List[Tuple[str, Optional[str]]]:
    """The worktrees git has registered for `repo`, main checkout first, with the branch each has checked out; one
    deleted by hand stays registered until it is removed or pruned. Empty when git can't list them."""
    code, out, _ = run(["git", "-C", repo, "worktree", "list", "--porcelain"], timeout=15)
    entries: List[Tuple[str, Optional[str]]] = []
    for line in out.splitlines() if code == 0 else []:
        if line.startswith("worktree "):
            entries.append((line[len("worktree "):], None))
        elif line.startswith("branch refs/heads/") and entries:
            entries[-1] = (entries[-1][0], line[len("branch refs/heads/"):])
    return entries


def find_worktree(repo: str, branch: str) -> Optional[str]:
    """The worktree that has `branch` checked out; a registered one whose directory is gone doesn't count."""
    return next((path for path, name in registered_worktrees(repo) if name == branch and os.path.isdir(path)), None)


def drop_missing_worktrees(repo: str, branch: str, path: Optional[str] = None) -> str:
    """Unregisters only the worktrees of `branch` (or at `path`) whose directory was deleted by hand, so they can be
    checked out again; their branch and commits stay, and no other worktree is touched. Returns a log."""
    target = os.path.realpath(path) if path else None
    log = ""
    for index, (registered, name) in enumerate(registered_worktrees(repo)):
        if index == 0 or os.path.lexists(registered) or (name != branch and os.path.realpath(registered) != target):
            continue
        code, out, err = run(["git", "-C", repo, "worktree", "remove", registered], timeout=60)
        if code != 0:
            raise RuntimeError(f"Could not unregister the deleted worktree {registered}: {(err or out).strip()}")
        log += f"Unregistered the deleted worktree {registered}\n"
    return log


def prepare_branch(repo: str, branch: str, base: str) -> str:
    """Creates `branch` from `base` (after fetching origin) unless it exists here or on origin; returns a log."""
    if has_ref(repo, f"refs/heads/{branch}"):
        return f"Using the existing branch {branch}\n"
    log = ""
    if run(["git", "-C", repo, "remote", "get-url", "origin"], timeout=10)[0] == 0:
        code, out, err = run(["git", "-C", repo, "fetch", "origin", "--prune", "--quiet"], timeout=300)
        log += out + err
    if has_ref(repo, f"refs/remotes/origin/{branch}"):
        return log + f"Using origin/{branch}\n"
    ref = base_ref(repo, base)
    code, out, err = run(["git", "-C", repo, "branch", "--no-track", branch, ref], timeout=30)
    if code != 0:
        raise RuntimeError(f"Could not create {branch} from {ref}: {(err or out).strip()}")
    return log + f"Created {branch} from {ref}\n"


def creation_record(repo: str, branch: str) -> str:
    """The reflog git keeps for `branch`, oldest entry first; empty when it has none."""
    code, common, _ = run(["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], timeout=10)
    try:
        return (Path(common.strip()) / "logs" / "refs" / "heads" / branch).read_text(encoding="utf-8") if code == 0 else ""
    except OSError:
        return ""


def created_commit(repo: str, branch: str) -> Optional[str]:
    """The commit `branch` pointed at when it was created; None without its reflog."""
    fields = creation_record(repo, branch).split("\n", 1)[0].split()
    return fields[1] if len(fields) > 1 and COMMIT.fullmatch(fields[1]) else None


def branch_base(repo: str, branch: str, default: str) -> str:
    """The branch `branch` was made from, as cmux's sidebar nests it: its `branch.<name>.nestUnder` setting (empty for
    the top level), else the branch its creation record names; `default` when neither names an existing branch. Read only."""
    code, out, _ = run(["git", "-C", repo, "config", "--get", f"branch.{branch}.nestUnder"], timeout=10)
    if code == 0:
        return out.strip() if out.strip() and has_ref(repo, f"refs/heads/{out.strip()}") else default
    m = CREATED_FROM.search(creation_record(repo, branch))
    name = m[1] if m else ""
    for prefix in ("refs/heads/", "refs/remotes/origin/", "origin/"):
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    if name and name not in (branch, "HEAD") and not COMMIT.fullmatch(name) and has_ref(repo, f"refs/heads/{name}"):
        return name
    return default
