#!/usr/bin/env python3
"""A stand-in `cmux` CLI for lifecycle tests: one window whose workspaces live in the JSON file $FAKE_CMUX_STATE.
A workspace created with --close-waits-for <file> records whether that file existed when it closed (waiting for it a
while), so a test can tell a close after the board's reply from one before it."""
import fcntl
import json
import os
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

STATE = Path(os.environ["FAKE_CMUX_STATE"])
WINDOW = "00000000-0000-4000-8000-000000000001"
WAIT = 3.0


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


def create(args):
    with state() as data:
        wid = str(uuid.uuid4()).upper()
        data["workspaces"][wid] = {"ref": f"workspace:{len(data['log']) + len(data['workspaces']) + 1}",
                                   "title": option(args, "--name", ""), "cwd": option(args, "--cwd", os.getcwd()),
                                   "surface": str(uuid.uuid4()).upper(), "command": option(args, "--command"),
                                   "waitsFor": option(args, "--close-waits-for")}
    print(f"OK {wid}")


def close(args):
    handle = option(args, "--workspace") or (args[-1] if args else None)
    with state() as data:
        wid = find(data, handle)
        waits = data["workspaces"][wid]["waitsFor"] if wid else None
    if not wid:
        sys.exit(f"Error: workspace {handle} not found")
    deadline = time.time() + WAIT
    while waits and not os.path.exists(waits) and time.time() < deadline:
        time.sleep(0.05)
    with state() as data:
        data["workspaces"].pop(wid, None)
        data["log"].append({"op": "close", "workspace": wid, "afterReply": os.path.exists(waits) if waits else None})
    print("OK")


def main(argv):
    args, rest = [], iter(argv)
    for arg in rest:
        if arg in ("--socket", "--id-format"):
            next(rest, None)
        elif arg != "--json":
            args.append(arg)
    command = args[:2] if args[:1] == ["workspace"] else args[:1]
    tail = args[len(command):]
    if command == ["list-windows"]:
        with state() as data:
            print(json.dumps([{"id": WINDOW, "index": 0, "workspace_count": len(data["workspaces"])}]))
    elif command in (["list-workspaces"], ["workspace", "list"]):
        with state() as data:
            print(json.dumps({"window_id": WINDOW, "workspaces": [
                {"id": i, "ref": ws["ref"], "title": ws["title"], "current_directory": ws["cwd"]}
                for i, ws in data["workspaces"].items()]}))
    elif command == ["list-panels"]:
        with state() as data:
            wid = find(data, option(tail, "--workspace"))
            if not wid:
                sys.exit("Error: workspace not found")
            print(json.dumps({"workspace_id": wid, "window_id": WINDOW,
                              "surfaces": [{"id": data["workspaces"][wid]["surface"], "index": 0}]}))
    elif command in (["new-workspace"], ["workspace", "create"]):
        create(tail)
    elif command in (["close-workspace"], ["workspace", "close"]):
        close(tail)
    elif command in (["select-workspace"], ["focus-panel"], ["workspace", "select"]):
        print("OK")
    else:
        sys.exit(f"fake cmux: unsupported {' '.join(argv)}")


main(sys.argv[1:])
