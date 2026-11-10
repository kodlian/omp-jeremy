#!/usr/bin/env python3
"""A stand-in `omp` for lifecycle tests: holds its session's lease like omp, streams its task's board events, reports idle,
and on the board's stop command answers, reports a clean exit and exits. Its worktree's name picks a behavior: `slow`
answers a stop without exiting, ignores SIGTERM and SIGHUP, and exits 16 s after it started; `selfmerge` commits and asks
the board to merge its own task, as /orchestrator done does, writing the reply to $HOME/selfmerge.out."""
import fcntl
import json
import os
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HOME = Path(os.environ["HOME"])
TASK = os.environ.get("ORCHESTRATOR_TASK", "")
PORT = int(os.environ["ORCHESTRATOR_PORT"])
CWD = os.getcwd()
SLOW = "slow" in CWD
busy = threading.Lock()


def session_id() -> str:
    args = sys.argv[1:]
    for flag in ("--resume", "--restore"):
        if flag in args and args.index(flag) + 1 < len(args):
            value = args[args.index(flag) + 1]
            return Path(value).stem.rsplit("_", 1)[-1] if "/" in value else value
    return f"fake-{TASK}-{os.getpid()}"


SID = session_id()


def post(path: str, body: dict) -> dict:
    request = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=700) as reply:
            return json.loads(reply.read() or b"{}")
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}")
    except OSError as e:
        return {"error": str(e)}


def exit_cleanly() -> None:
    with busy:
        post("/api/agent", {"task": TASK, "path": CWD, "state": "exited", "sessionId": SID})
        os._exit(0)


def on_control(command: dict) -> None:
    if command.get("action") == "stop" and not SLOW:
        post(f"/api/control/{command['id']}", {"ok": True, "message": "exiting"})
        exit_cleanly()
    post(f"/api/control/{command['id']}", {"ok": True, "message": "ignored" if SLOW else "done"})


def stream() -> None:
    """The task's board events, reconnecting while the board restarts."""
    while True:
        try:
            s = socket.create_connection(("127.0.0.1", PORT))
            s.sendall(f"GET /api/events?task={TASK}&session={SID} HTTP/1.0\r\nHost: 127.0.0.1:{PORT}\r\n\r\n".encode())
            buffer = ""
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buffer += chunk.decode("utf-8", "replace")
                while "\n\n" in buffer:
                    frame, buffer = buffer.split("\n\n", 1)
                    lines = frame.splitlines()
                    if "event: control" in lines:
                        data = next(line[len("data: "):] for line in lines if line.startswith("data: "))
                        threading.Thread(target=on_control, args=(json.loads(data),), daemon=True).start()
        except OSError:
            pass
        time.sleep(0.5)


def self_merge() -> None:
    time.sleep(2)
    os.system("git commit -q --allow-empty -m work")
    with busy:
        for _ in range(40):
            reply = post(f"/api/tasks/{TASK}/merge", {"cleanup": True, "commit": True})
            if " is still " not in str(reply.get("error") or ""):
                break
            time.sleep(0.5)
        (HOME / "selfmerge.out").write_text(json.dumps(reply))


def main() -> None:
    with open(HOME / "omp-args.log", "a") as log:
        log.write(json.dumps({"task": TASK, "argv": sys.argv[1:]}) + "\n")
    lease_dir = Path(os.environ["ORCHESTRATOR_LEASE_DIR"])
    lease_dir.mkdir(parents=True, exist_ok=True)
    lease = os.open(lease_dir / f"{SID}.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.lockf(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(3)
    (HOME / f"omp-{TASK}.pid").write_text(str(os.getpid()))
    if SLOW:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        threading.Timer(16, lambda: os._exit(0)).start()
    threading.Thread(target=stream, daemon=True).start()
    post("/api/agent", {"task": TASK, "path": CWD, "state": "idle", "sessionId": SID})
    if "selfmerge" in CWD:
        threading.Thread(target=self_merge, daemon=True).start()
    threading.Event().wait()


main()
