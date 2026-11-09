import { type Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// The board also looks for Beads in Homebrew's directories when they aren't on PATH.
const BD = Bun.which("bd", { PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` });
const CALLER = /^(CMUX_|TMUX|OMP_TERMINAL|KANBOARD_|WT_)/;

type Workspace = { ref: string; title: string; cwd: string; surface: string; waitsFor: string | null };
type FakeCmux = { workspaces: Record<string, Workspace>; log: { op: string; workspace: string; afterReply: boolean | null }[] };
type Task = {
	id: string;
	worktree: string | null;
	spawn: { state: string; error: string | null };
	presentation: { kind: string; cmux?: { workspace: string } } | null;
	cleanupPending?: string | null;
};
type Context = { kind: "cmux"; cmux: { cli: string; socket: string; workspace: string; surface: string } };

let dir = "";
let bin = "";
let port = 0;
let env: Record<string, string> = {};
let server: Subprocess | undefined;
let origin: Context;

const HOOKS = {
	wt: `#!/bin/sh
set -e
wt="$FAKE_WT_ROOT/$KANBOARD_BRANCH"
git -C "$KANBOARD_REPO" worktree add -q "$wt" "$KANBOARD_BRANCH"
cmux new-workspace --name "$KANBOARD_BRANCH" --cwd "$wt" --command "$KANBOARD_AGENT_COMMAND"
`,
	// Like cmuxkit's wt-rm: it closes workspaces only with the caller's cmux identity, which the board never passes.
	// $HOME/wt-rm-fails makes it fail once, as when the worktree is busy.
	"wt-rm": `#!/bin/sh
set -e
if [ -f "$HOME/wt-rm-fails" ]; then rm "$HOME/wt-rm-fails"; echo "worktree busy" >&2; exit 1; fi
root=$(git rev-parse --show-toplevel)
repo=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
branch=$(git symbolic-ref --short -q HEAD)
cd "$repo"
git worktree remove --force --force "$root"
git branch -D -q "$branch"
if [ -n "\${CMUX_WORKSPACE_ID:-}" ]; then cmux workspace close --force --workspace "$CMUX_WORKSPACE_ID"; fi
`,
	// An agent in a "slow" task's worktree keeps a session connected after its host is stopped, as omp does while it exits.
	omp: '#!/bin/sh\ncase "$PWD" in *slow*) linger ;; esac\nexec sleep 600\n',
	linger: `#!/usr/bin/env python3
import os, socket, sys, time
if os.fork():
    sys.exit(0)
os.setsid()
port, task = os.environ["KANBOARD_PORT"], os.environ["KANBOARD_TASK"]
s = socket.create_connection(("127.0.0.1", int(port)))
s.sendall(f"GET /api/events?task={task}&session=slow HTTP/1.0\\r\\nHost: 127.0.0.1:{port}\\r\\n\\r\\n".encode())
s.settimeout(1)
end = time.time() + 20
while time.time() < end:
    try:
        s.recv(65536)
    except socket.timeout:
        pass
`,
};

async function card(id: string): Promise<Task> {
	return (await api<{ tasks: Task[] }>("GET", "/api/state")).tasks.find((t) => t.id === id)!;
}

function run(cmd: string[], cwd = dir): string {
	const p = Bun.spawnSync(cmd, { cwd, env });
	if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

function cmux(): FakeCmux {
	return JSON.parse(readFileSync(join(dir, "cmux.json"), "utf8"));
}

function openWorkspace(cwd: string, waitsFor?: string): string {
	return run([join(bin, "cmux"), "new-workspace", "--name", "shell", "--cwd", cwd, ...(waitsFor ? ["--close-waits-for", waitsFor] : [])]).split(" ")[1];
}

function context(workspace: string): Context {
	return { kind: "cmux", cmux: { cli: join(bin, "cmux"), socket: join(dir, "cmux.sock"), workspace, surface: cmux().workspaces[workspace].surface } };
}

function inside(state: FakeCmux, path: string): string[] {
	return Object.entries(state.workspaces).filter(([, ws]) => ws.cwd === path || ws.cwd.startsWith(`${path}/`)).map(([id]) => id);
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		keepalive: false,
		headers: method === "GET" ? {} : { "Content-Type": "application/json" },
		body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
	return data as T;
}

function useHooks(hooks: boolean): void {
	const commands = hooks ? { createWorktree: join(bin, "wt"), removeWorktree: join(bin, "wt-rm") } : {};
	writeFileSync(join(dir, "board", "config.json"), JSON.stringify({ commands }));
}

/** A started card with a commit to merge; `from` is the omp session terminal it was created in, if any. The board starts
 * and closes terminals in its own process, so the test polls its state rather than awaiting a signal. */
async function startedTask(title: string, from?: Context): Promise<Task & { worktree: string }> {
	const created = await api<Task>("POST", "/api/tasks", { title, merge: "local", ...(from ? { origin: { session: "lifecycle", terminal: from } } : {}) });
	await api("POST", `/api/tasks/${created.id}/move`, { column: "todo" });
	for (const deadline = Date.now() + 30_000; Date.now() < deadline; await Bun.sleep(100)) {
		const t = (await api<{ tasks: Task[] }>("GET", "/api/state")).tasks.find((x) => x.id === created.id)!;
		if (t.spawn.state === "failed") throw new Error(`${t.id} didn't start: ${t.spawn.error}`);
		if (t.spawn.state === "done" && t.worktree) {
			run(["git", "-C", t.worktree, "commit", "-q", "--allow-empty", "-m", `${title} work`]);
			return t as Task & { worktree: string };
		}
	}
	throw new Error(`${created.id} didn't start in time`);
}

describe.skipIf(!BD)("a done task's terminals", () => {
	beforeAll(async () => {
		// /tmp, not the per-user temp directory: an agent host's socket path must stay under 104 bytes.
		dir = realpathSync(mkdtempSync("/tmp/orchestrator-lifecycle-"));
		bin = join(dir, "bin");
		for (const sub of ["bin", "home", "board", "repo", "worktrees"]) mkdirSync(join(dir, sub));
		copyFileSync(join(import.meta.dir, "fake_cmux.py"), join(bin, "cmux"));
		for (const [name, text] of Object.entries(HOOKS)) writeFileSync(join(bin, name), text);
		for (const name of ["cmux", ...Object.keys(HOOKS)]) chmodSync(join(bin, name), 0o755);
		writeFileSync(join(dir, "home", ".gitconfig"), "[user]\n\tname = Lifecycle\n\temail = lifecycle@example.com\n");
		env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !CALLER.test(k))) as Record<string, string>;
		const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		port = probe.port;
		probe.stop(true);
		Object.assign(env, {
			HOME: join(dir, "home"), PATH: `${bin}:${process.env.PATH}`, PYTHONDONTWRITEBYTECODE: "1",
			KANBOARD_HOME: join(dir, "board"), KANBOARD_PORT: String(port), KANBOARD_REPO: join(dir, "repo"),
			FAKE_CMUX_STATE: join(dir, "cmux.json"), FAKE_WT_ROOT: join(dir, "worktrees"),
		});
		run(["git", "init", "-q", "-b", "main"], join(dir, "repo"));
		run(["git", "commit", "-q", "--allow-empty", "-m", "init"], join(dir, "repo"));
		run(["python3", "server.py", "--prepare"], ROOT);
		server = Bun.spawn(["python3", "server.py"], { cwd: ROOT, env, stdout: "ignore", stderr: "ignore" });
		for (const deadline = Date.now() + 20_000; Date.now() < deadline; await Bun.sleep(100)) {
			if (await api("GET", "/api/state").then(() => true, () => false)) break;
		}
		origin = context(openWorkspace(join(dir, "repo")));
	}, 60_000);

	afterAll(() => {
		server?.kill();
		Bun.spawnSync(["pkill", "-f", join(dir, "board", "hosts")]);
		rmSync(dir, { recursive: true, force: true });
	});

	// Each started card costs seconds of Beads and git work, so the requester cases run once per landing, not per worktree kind.
	const CASES = [
		{ hooks: true, remove: false, requester: "board" },
		{ hooks: true, remove: true, requester: "board" },
		{ hooks: true, remove: false, requester: "inside" },
		{ hooks: true, remove: true, requester: "inside" },
		{ hooks: false, remove: false, requester: "outside" },
		{ hooks: false, remove: true, requester: "outside" },
	] as const;

	for (const { hooks, remove, requester } of CASES) {
		const name = `${hooks ? "a createWorktree hook's" : "a board-opened"} worktree merged ${remove ? "removing" : "keeping"} it, from ${
			requester === "inside" ? "a session inside it, closes every terminal there with the session's last" : requester === "outside" ? "a session elsewhere, closes every terminal there and none elsewhere" : "the board, closes every terminal there"
		}`;
		test(name, async () => {
			useHooks(hooks);
			// A hooked task gets no origin terminal: its presentation stays null, as for tasks started before the board recorded hook terminals.
			const t = await startedTask(`${hooks ? "hook" : "board"} ${remove ? "remove" : "keep"} ${requester}`, hooks ? undefined : origin);
			mkdirSync(join(t.worktree, "src"));
			openWorkspace(join(t.worktree, "src"));
			const replied = join(dir, `${t.id}.replied`);
			const asker = requester === "inside" ? openWorkspace(t.worktree, replied) : requester === "outside" ? openWorkspace(join(dir, "repo")) : undefined;
			const before = inside(cmux(), t.worktree);
			expect(before.length).toBe(requester === "inside" ? 3 : 2);
			expect(t.presentation?.kind ?? null).toBe(hooks ? null : "cmux");

			const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${t.id}/merge`, {
				method: "POST",
				keepalive: false,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cleanup: remove, commit: true, ...(asker ? { terminal: context(asker) } : {}) }),
			});
			writeFileSync(replied, "");
			const result = (await res.json()) as { ok?: boolean; cleanupError?: string; error?: string };
			expect(result.error ?? result.cleanupError).toBeUndefined();
			for (const deadline = Date.now() + 5_000; inside(cmux(), t.worktree).length && Date.now() < deadline; ) await Bun.sleep(50);

			const after = cmux();
			expect(inside(after, t.worktree)).toEqual([]);
			expect(existsSync(t.worktree)).toBe(!remove);
			if (requester === "outside") expect(after.workspaces[asker!]).toBeDefined();
			if (requester === "inside") {
				expect(after.log.filter((e) => before.includes(e.workspace)).at(-1)).toEqual({ op: "close", workspace: asker!, afterReply: true });
			}
		}, 60_000);
	}

	test("Stop closes the terminal a createWorktree hook opened", async () => {
		useHooks(true);
		const t = await startedTask("stop hooked", origin);
		const opened = t.presentation?.cmux?.workspace;
		expect(opened && cmux().workspaces[opened]?.cwd).toBe(t.worktree);
		await api("POST", `/api/tasks/${t.id}/stop`);
		expect(cmux().workspaces[opened!]).toBeUndefined();
	}, 60_000);

	test("Merging with removal finishes the removal once an agent that's slow to exit is gone", async () => {
		useHooks(true);
		const t = await startedTask("slow agent remove");
		const res = await api<{ output: string; cleanupError?: string }>("POST", `/api/tasks/${t.id}/merge`, { cleanup: true, commit: true });
		expect(res.cleanupError).toBeUndefined();
		expect(res.output).toContain("still stopping");
		expect(existsSync(t.worktree)).toBe(true);
		expect((await card(t.id)).cleanupPending).toBeTruthy();
		// The lingering session disconnects 20 s after the agent started; the board then sees it gone within a ping and a poll.
		for (const deadline = Date.now() + 40_000; (await card(t.id)).worktree && Date.now() < deadline; ) await Bun.sleep(250);
		const after = await card(t.id);
		expect(after.worktree).toBeNull();
		expect(after.cleanupPending ?? null).toBeNull();
		expect(existsSync(t.worktree)).toBe(false);
	}, 90_000);

	test("A sweep removes a merged worktree a failed removal left behind, and keeps one the merge chose to keep", async () => {
		useHooks(true);
		const kept = await startedTask("sweep keep");
		await api("POST", `/api/tasks/${kept.id}/merge`, { cleanup: false, commit: true });
		const left = await startedTask("sweep leftover");
		writeFileSync(join(dir, "home", "wt-rm-fails"), "");
		const res = await api<{ cleanupError?: string }>("POST", `/api/tasks/${left.id}/merge`, { cleanup: true, commit: true });
		expect(res.cleanupError).toContain("worktree busy");
		expect(existsSync(left.worktree)).toBe(true);
		await api("POST", "/api/refresh");
		for (const deadline = Date.now() + 15_000; existsSync(left.worktree) && Date.now() < deadline; ) await Bun.sleep(250);
		expect(existsSync(left.worktree)).toBe(false);
		expect(existsSync(kept.worktree)).toBe(true);
	}, 90_000);
});
