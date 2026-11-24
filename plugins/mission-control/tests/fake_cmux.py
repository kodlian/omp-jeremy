#!/usr/bin/env python3
"""A stand-in `cmux` CLI for tests: one window whose workspaces live in the JSON file $FAKE_CMUX_STATE, with a log of
what was created, selected, focused and closed."""
import fcntl
import json
import os
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

STATE = Path(os.environ["FAKE_CMUX_STATE"])
WINDOW = "00000000-0000-4000-8000-000000000001"


@contextmanager
def state():
    with open(STATE.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = json.loads(STATE.read_text()) if STATE.exists() else {"workspaces": {}, "log": []}
        yield data
        STATE.write_text(json.dumps(data))


def option(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


def find(data, handle):
    return next((i for i, ws in data["workspaces"].items() if handle in (i, ws["ref"])), None)


def main(argv):
    args, rest = [], iter(argv)
    for arg in rest:
        if arg in ("--socket", "--id-format"):
            next(rest, None)
        elif arg != "--json":
            args.append(arg)
    command = args[:2] if args[:1] == ["workspace"] else args[:1]
    tail = args[len(command):]
    with state() as data:
        if command == ["list-windows"]:
            print(json.dumps([{"id": WINDOW, "index": 0, "workspace_count": len(data["workspaces"])}]))
        elif command in (["list-workspaces"], ["workspace", "list"]):
            print(json.dumps({"window_id": WINDOW, "workspaces": [
                {"id": i, "ref": ws["ref"], "title": ws["title"], "current_directory": ws["cwd"]}
                for i, ws in data["workspaces"].items()]}))
        elif command == ["list-panels"]:
            wid = find(data, option(tail, "--workspace"))
            if not wid:
                sys.exit("Error: workspace not found")
            print(json.dumps({"workspace_id": wid, "window_id": WINDOW,
                              "surfaces": [{"id": data["workspaces"][wid]["surface"], "index": 0}]}))
        elif command in (["new-workspace"], ["workspace", "create"]):
            wid = str(uuid.uuid4()).upper()
            data["workspaces"][wid] = {"ref": f"workspace:{len(data['log']) + len(data['workspaces']) + 1}",
                                       "title": option(tail, "--name", ""), "cwd": option(tail, "--cwd", os.getcwd()),
                                       "surface": str(uuid.uuid4()).upper(), "command": option(tail, "--command")}
            data["log"].append({"op": "create", "workspace": wid, "command": option(tail, "--command")})
            print(f"OK {wid}")
        elif command in (["close-workspace"], ["workspace", "close"]):
            wid = find(data, option(tail, "--workspace") or (tail[-1] if tail else None))
            if not wid:
                sys.exit("Error: workspace not found")
            data["workspaces"].pop(wid)
            data["log"].append({"op": "close", "workspace": wid})
            print("OK")
        elif command in (["select-workspace"], ["workspace", "select"]):
            wid = find(data, option(tail, "--workspace"))
            if not wid:
                sys.exit("Error: workspace not found")
            data["log"].append({"op": "select", "workspace": wid})
            print("OK")
        elif command == ["focus-panel"]:
            data["log"].append({"op": "focus", "panel": option(tail, "--panel")})
            print("OK")
        else:
            sys.exit(f"fake cmux: unsupported {' '.join(argv)}")


main(sys.argv[1:])
