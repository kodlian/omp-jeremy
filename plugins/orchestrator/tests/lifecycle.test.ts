import { type Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const EXTRA_PATH = `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`;
// The board also looks for Beads and tmux in Homebrew's directories when they aren't on PATH.
const BD = Bun.which("bd", { PATH: EXTRA_PATH });
const TMUX = Bun.which("tmux", { PATH: EXTRA_PATH });
const CALLER = /^(CMUX_|TMUX|OMP_TERMINAL|ORCHESTRATOR_|WT_)/;

type Workspace = { ref: string; title: string; cwd: string; surface: string; command: string | null; waitsFor: string | null };
type FakeCmux = { workspaces: Record<string, Workspace>; log: { op: string; workspace?: string; session?: string; afterReply?: boolean | null }[] };
type Task = {
	id: string;
	branch: string;
	column: string;
	worktree: string | null;
	spawn: { state: string; error: string | null };
	presentation: { kind: string; cmux?: { workspace: string } } | null;
	execution: { kind: string; state: string; exitCode: number | null } | null;
	agent: { state: string } | null;
	attachCommand: string | null;
	intent: { op: string; stage: string | null; attempt: number; lastError: string | null } | null;
	lastOperation: { op: string; ok: boolean; error: string | null; output: string } | null;
	pendingUpdate: boolean;
	syncPending: boolean;
};
type Context = { kind: "cmux"; cmux: { cli: string; socket: string; workspace: string; surface: string } };

let dir = "";
let bin = "";
let port = 0;
let label = "";
let env: Record<string, string> = {};
let server: Subprocess | undefined;
let origin: Context;

const HOOKS = {
	// It reuses the branch's existing worktree, as cmuxkit's wt does. $HOME/wt-slow makes it take 6 s and fail without a
	// worktree; $HOME/wt-fails makes it fail once after creating one.
	wt: `#!/bin/sh
set -e
if [ -f "$HOME/wt-slow" ]; then sleep 6; exit 1; fi
wt=$(git -C "$ORCHESTRATOR_REPO" worktree list --porcelain | awk -v b="refs/heads/$ORCHESTRATOR_BRANCH" '$1=="worktree"{p=$2} $1=="branch"&&$2==b{print p; exit}')
if [ -n "$wt" ]; then
  echo "reuse $ORCHESTRATOR_BRANCH" >>"$HOME/wt.log"
else
  wt="$FAKE_WT_ROOT/$ORCHESTRATOR_BRANCH"
  git -C "$ORCHESTRATOR_REPO" worktree add -q "$wt" "$ORCHESTRATOR_BRANCH"
  echo "$ORCHESTRATOR_BRANCH" >>"$HOME/wt.log"
  if [ -f "$HOME/wt-fails" ]; then rm "$HOME/wt-fails"; echo "sidebar step failed" >&2; exit 1; fi
fi
cmux new-workspace --name "$ORCHESTRATOR_BRANCH" --cwd "$wt" --command "$ORCHESTRATOR_AGENT_COMMAND"
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
	// Beads timing out on writes while $HOME/bd-fail exists.
	bd: `#!/bin/sh
if [ -f "$HOME/bd-fail" ]; then
  for arg in "$@"; do
    if [ "$arg" = update ]; then echo "bd update timed out after 60s" >&2; exit 1; fi
  done
fi
exec "$REAL_BD" "$@"
`,
};

async function card(id: string): Promise<Task> {
	return (await api<{ tasks: Task[] }>("GET", "/api/state")).tasks.find((t) => t.id === id)!;
}

async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>, timeout: number): Promise<T> {
	for (const deadline = Date.now() + timeout; Date.now() < deadline; await Bun.sleep(200)) {
		const value = await check().catch(() => null);
		if (value) return value;
	}
	throw new Error(`timed out waiting for ${what}`);
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

function sessions(): string[] {
	const p = Bun.spawnSync([TMUX!, "-L", label, "list-sessions", "-F", "#{session_name}"], { env });
	return p.exitCode === 0 ? p.stdout.toString().split("\n").filter(Boolean) : [];
}

function sessionName(id: string): string {
	return `orch-${id.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
}

/** The argument lists the fake omp started with for a task, oldest first. */
function ompArgs(id: string): string[][] {
	const path = join(dir, "home", "omp-args.log");
	if (!existsSync(path)) return [];
	const entries: { task: string; argv: string[] }[] = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return entries.filter((e) => e.task === id).map((e) => e.argv);
}

function flag(name: string, on: boolean): void {
	const path = join(dir, "home", name);
	if (on) writeFileSync(path, "");
	else rmSync(path, { force: true });
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		keepalive: false,
		headers: method === "GET" ? {} : { "Content-Type": "application/json" },
		body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
	});
	return { status: res.status, data: await res.json() };
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await call(method, path, body);
	if (res.status >= 400) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.data)}`);
	return res.data as T;
}

function useHooks(hooks: boolean): void {
	const commands = hooks ? { createWorktree: join(bin, "wt"), removeWorktree: join(bin, "wt-rm") } : {};
	writeFileSync(join(dir, "board", "config.json"), JSON.stringify({ commands }));
}

async function startServer(): Promise<void> {
	server = Bun.spawn(["python3", "server.py"], { cwd: ROOT, env, stdout: "ignore", stderr: "ignore" });
	await waitFor("the board", () => api("GET", "/api/state").then(() => true), 20_000);
}

/** Kills the board without letting it finish anything, as a crash or a forced restart would, and starts it again. */
async function restartServer(): Promise<void> {
	server?.kill("SIGKILL");
	await server?.exited;
	await startServer();
}

/** A created card started from Todo; the board starts and closes terminals in its own process, so the test polls its
 * state rather than awaiting a signal. */
async function startTask(title: string, options: { from?: Context; merge?: "local" | "pr" } = {}): Promise<Task & { worktree: string }> {
	const { from, merge = "local" } = options;
	const created = await api<Task>("POST", "/api/tasks", { title, merge, ...(from ? { origin: { session: "lifecycle", terminal: from } } : {}) });
	await api("POST", `/api/tasks/${created.id}/move`, { column: "todo" });
	const t = await waitFor(`${created.id} to start`, async () => {
		const c = await card(created.id);
		if (c.spawn.state === "failed") throw new Error(`${c.id} didn't start: ${c.spawn.error}`);
		return c.spawn.state === "done" && c.worktree && !c.intent ? c : null;
	}, 30_000).catch(async (e) => {
		const c = await card(created.id);
		throw c.spawn.state === "failed" ? new Error(`${c.id} didn't start: ${c.spawn.error}`) : e;
	});
	return t as Task & { worktree: string };
}

/** A started card with a commit to merge. */
async function startedTask(title: string, from?: Context): Promise<Task & { worktree: string }> {
	const t = await startTask(title, { from });
	run(["git", "-C", t.worktree, "commit", "-q", "--allow-empty", "-m", `${title} work`]);
	return t;
}

describe.skipIf(!BD || !TMUX)("a task's lifecycle", () => {
	beforeAll(async () => {
		dir = realpathSync(mkdtempSync("/tmp/orchestrator-lifecycle-"));
		bin = join(dir, "bin");
		label = `orch-test-${basename(dir)}`;
		for (const sub of ["bin", "home", "board", "repo", "worktrees", "leases"]) mkdirSync(join(dir, sub));
		copyFileSync(join(import.meta.dir, "fake_cmux.py"), join(bin, "cmux"));
		copyFileSync(join(import.meta.dir, "fake_omp.py"), join(bin, "omp"));
		for (const [name, text] of Object.entries(HOOKS)) writeFileSync(join(bin, name), text);
		for (const name of ["cmux", "omp", ...Object.keys(HOOKS)]) chmodSync(join(bin, name), 0o755);
		writeFileSync(join(dir, "home", ".gitconfig"), "[user]\n\tname = Lifecycle\n\temail = lifecycle@example.com\n");
		env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !CALLER.test(k))) as Record<string, string>;
		const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		port = probe.port;
		probe.stop(true);
		Object.assign(env, {
			HOME: join(dir, "home"), PATH: `${bin}:${EXTRA_PATH}`, PYTHONDONTWRITEBYTECODE: "1",
			ORCHESTRATOR_HOME: join(dir, "board"), ORCHESTRATOR_PORT: String(port), ORCHESTRATOR_REPO: join(dir, "repo"),
			ORCHESTRATOR_TMUX_LABEL: label, ORCHESTRATOR_LEASE_DIR: join(dir, "leases"), ORCHESTRATOR_RESUME_GRACE: "5", REAL_BD: BD!,
			FAKE_CMUX_STATE: join(dir, "cmux.json"), FAKE_WT_ROOT: join(dir, "worktrees"),
		});
		run(["git", "init", "-q", "-b", "main"], join(dir, "repo"));
		run(["git", "commit", "-q", "--allow-empty", "-m", "init"], join(dir, "repo"));
		run(["python3", "server.py", "--prepare"], ROOT);
		await startServer();
		origin = context(openWorkspace(join(dir, "repo")));
	}, 60_000);

	afterAll(() => {
		server?.kill();
		Bun.spawnSync([TMUX!, "-L", label, "kill-server"], { env });
		Bun.spawnSync([TMUX!, "-S", join(dir, "local-tmux.sock"), "kill-server"], { env });
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
			const result = (await res.json()) as { ok?: boolean; error?: string };
			expect(result.error).toBeUndefined();
			await waitFor("the worktree's terminals to close", async () => !inside(cmux(), t.worktree).length && !(await card(t.id)).intent, 15_000);

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

	test("An agent on cmux's local-tmux shows in the task's workspace left from before, not beside a terminal that only sits in its worktree", async () => {
		useHooks(false);
		flag("local-tmux", true);
		try {
			const created = await api<Task>("POST", "/api/tasks", { title: "reused workspace", merge: "local", origin: { session: "lifecycle", terminal: origin } });
			// The worktree and its cmux workspace from a start before a board restart.
			const path = join(dir, "worktrees", "reused");
			run(["git", "-C", join(dir, "repo"), "worktree", "add", "-q", "-b", created.branch, path]);
			const left = openWorkspace(path);
			await api("POST", `/api/tasks/${created.id}/move`, { column: "todo" });
			const t = await waitFor("the start", async () => {
				const c = await card(created.id);
				return c.spawn.state === "done" && !c.intent ? c : null;
			}, 30_000);
			expect(t.worktree).toBe(path);
			expect(t.presentation?.cmux?.workspace).toBe(left);
			expect(cmux().log).toContainEqual({ op: "attach", workspace: left, session: sessionName(t.id) });
			expect(inside(cmux(), path)).toEqual([left]);
		} finally {
			flag("local-tmux", false);
		}
	}, 60_000);

	test("A resumed task with a createWorktree hook comes back in the terminal the hook opens, where the user's setup places it", async () => {
		useHooks(true);
		const t = await startTask("hook resume", { from: origin, merge: "pr" });
		expect(cmux().workspaces[t.presentation!.cmux!.workspace].command).toContain("agent.sh");
		await api("POST", `/api/tasks/${t.id}/stop`);
		expect(inside(cmux(), t.worktree)).toEqual([]);
		await api("POST", `/api/tasks/${t.id}/move`, { column: "doing" });
		const resumed = await waitFor("the resume", async () => {
			const c = await card(t.id);
			return c.execution?.state === "running" && !c.intent ? c : null;
		}, 20_000);
		const shown = inside(cmux(), t.worktree);
		expect(shown).toHaveLength(1);
		expect(resumed.presentation?.cmux?.workspace).toBe(shown[0]);
		expect(cmux().workspaces[shown[0]].command).toContain("agent.sh");
		expect(readFileSync(join(dir, "home", "wt.log"), "utf8")).toContain(`reuse ${t.branch}`);
	}, 60_000);

	test("A stopped agent on cmux's local-tmux ends through cmux, and resumes in a cmux workspace even when cmux reports its start failed", async () => {
		useHooks(false);
		flag("local-tmux", true);
		try {
			const t = await startTask("local tmux resume", { from: origin, merge: "pr" });
			expect(inside(cmux(), t.worktree)).toHaveLength(1);
			await api("POST", `/api/tasks/${t.id}/stop`);
			expect(inside(cmux(), t.worktree)).toEqual([]);
			flag("local-tmux-start-fails", true);
			await api("POST", `/api/tasks/${t.id}/move`, { column: "doing" });
			const resumed = await waitFor("the resume", async () => {
				const c = await card(t.id);
				return c.execution?.state === "running" && !c.intent ? c : null;
			}, 20_000);
			expect(resumed.lastOperation).toMatchObject({ op: "resume", ok: true });
			expect(cmux().log).toContainEqual({ op: "local-tmux close", session: sessionName(t.id) });
			const shown = inside(cmux(), t.worktree);
			expect(shown).toHaveLength(1);
			expect(resumed.presentation?.cmux?.workspace).toBe(shown[0]);
		} finally {
			flag("local-tmux", false);
			flag("local-tmux-start-fails", false);
		}
	}, 60_000);

	test("An agent killed outside the board reads as stopped, with its exit code and last screen", async () => {
		useHooks(false);
		const t = await startTask("slow lease");
		const running = await card(t.id);
		expect(running.execution).toMatchObject({ kind: "tmux", state: "running" });
		expect(running.attachCommand).toContain("attach-session");
		const pidFile = join(dir, "home", `omp-${t.id}.pid`);
		await waitFor("the agent's pid", async () => existsSync(pidFile), 10_000);
		process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
		const stopped = await waitFor("the agent to read as stopped", async () => {
			const c = await card(t.id);
			return c.execution?.state === "stopped" && c.agent?.state === "stopped" && c.execution.exitCode !== null ? c : null;
		}, 8_000);
		expect(stopped.execution?.exitCode).toBe(137);
		expect(stopped.attachCommand).toBeNull();
		const screen = await call("GET", `/api/tasks/${t.id}/screen`);
		expect(screen.status).toBe(200);
		expect(screen.data).toMatchObject({ text: expect.any(String) });
	}, 60_000);

	test("A resume continues a cleanly exited session with --resume and a killed one with --restore", async () => {
		useHooks(false);
		const t = await startTask("resume flags", { merge: "pr" });
		await api("POST", `/api/tasks/${t.id}/stop`);
		await waitFor("the stop", async () => {
			const c = await card(t.id);
			return c.column === "backlog" && c.execution?.state === "stopped" && !c.intent;
		}, 15_000);
		const pidFile = join(dir, "home", `omp-${t.id}.pid`);
		rmSync(pidFile, { force: true });
		await api("POST", `/api/tasks/${t.id}/move`, { column: "doing" });
		await waitFor("the resume", async () => {
			const c = await card(t.id);
			return c.execution?.state === "running" && c.agent?.state === "idle" && !c.intent && ompArgs(t.id).length === 2 && existsSync(pidFile);
		}, 15_000);
		expect(ompArgs(t.id)[1]).toContain("--resume");

		process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
		await waitFor("the kill", async () => (await card(t.id)).agent?.state === "stopped", 10_000);
		await api("POST", `/api/tasks/${t.id}/move`, { column: "doing" });
		await waitFor("the second resume", async () => {
			const c = await card(t.id);
			return c.execution?.state === "running" && !c.intent && ompArgs(t.id).length === 3;
		}, 15_000);
		expect(ompArgs(t.id)[2]).toContain("--restore");
		expect(ompArgs(t.id)[2]).toContain(ompArgs(t.id)[1].at(-1)!);
	}, 90_000);

	test("A resumed agent's message waits in its resume file until its omp delivers it", async () => {
		useHooks(false);
		const t = await startTask("nudge handshake", { merge: "pr" });
		await api("POST", `/api/tasks/${t.id}/stop`);
		expect((await api<Task>("PATCH", `/api/tasks/${t.id}`, { title: "renamed" })).pendingUpdate).toBe(true);
		await api("POST", `/api/tasks/${t.id}/move`, { column: "doing" });
		const file = join(dir, "board", "tasks", t.id, "resume.json");
		await waitFor("the resume file", async () => existsSync(file), 15_000);
		const resume = JSON.parse(readFileSync(file, "utf8"));
		expect(resume.update.title).toBe("renamed");
		expect(resume.text).toContain("continue where you stopped");
		await api("POST", `/api/tasks/${t.id}/resumed`);
		expect(existsSync(file)).toBe(false);
		expect((await card(t.id)).pendingUpdate).toBe(false);
	}, 60_000);

	test("A worktree removal survives a board restart and finishes once a slow agent is gone", async () => {
		useHooks(true);
		const t = await startedTask("slow restart remove");
		const res = await api<{ pending: boolean }>("POST", `/api/tasks/${t.id}/merge`, { cleanup: true, commit: true });
		expect(res.pending).toBe(true);
		expect((await card(t.id)).intent?.op).toBe("remove");
		await restartServer();
		const done = await waitFor("the removal", async () => {
			const c = await card(t.id);
			return !c.worktree && !c.intent ? c : null;
		}, 40_000);
		expect(done.lastOperation?.ok).toBe(true);
		expect(existsSync(t.worktree)).toBe(false);
		expect(sessions()).not.toContain(sessionName(t.id));
	}, 90_000);

	test("A start survives a board restart in its createWorktree hook, with one agent", async () => {
		useHooks(true);
		flag("wt-slow", true);
		const created = await api<Task>("POST", "/api/tasks", { title: "restart start", merge: "local" });
		await api("POST", `/api/tasks/${created.id}/move`, { column: "todo" });
		await Bun.sleep(2000);
		flag("wt-slow", false);
		await restartServer();
		const started = await waitFor("the start", async () => {
			const c = await card(created.id);
			return c.spawn.state === "done" && c.worktree && !c.intent ? c : null;
		}, 30_000);
		expect(existsSync(started.worktree!)).toBe(true);
		expect(sessions().filter((s) => s === sessionName(created.id))).toHaveLength(1);
	}, 60_000);

	test("A failed start leaves nothing to redo: starting again reuses its worktree", async () => {
		useHooks(true);
		flag("wt-fails", true);
		const created = await api<Task>("POST", "/api/tasks", { title: "fails once", merge: "local" });
		await api("POST", `/api/tasks/${created.id}/move`, { column: "todo" });
		const failed = await waitFor("the failed start", async () => {
			const c = await card(created.id);
			return c.spawn.state === "failed" && !c.intent ? c : null;
		}, 30_000);
		expect(failed.lastOperation).toMatchObject({ op: "start", ok: false });
		expect(failed.spawn.error).toContain("sidebar step failed");
		await api("POST", `/api/tasks/${created.id}/move`, { column: "todo" });
		const started = await waitFor("the second start", async () => {
			const c = await card(created.id);
			return c.spawn.state === "done" && c.worktree && !c.intent ? c : null;
		}, 30_000);
		expect(started.worktree).toBe(join(dir, "worktrees", created.branch));
		expect(readFileSync(join(dir, "home", "wt.log"), "utf8").split("\n").filter((line) => line === created.branch)).toHaveLength(1);
	}, 60_000);

	test("A merge succeeds while Beads can't take writes, and its column reaches Beads once it can", async () => {
		useHooks(false);
		const t = await startedTask("beads outage");
		flag("bd-fail", true);
		try {
			const res = await api<{ ok: boolean }>("POST", `/api/tasks/${t.id}/merge`, { cleanup: false, commit: true });
			expect(res.ok).toBe(true);
			const merged = await card(t.id);
			expect(merged.column).toBe("done");
			expect(merged.syncPending).toBe(true);
		} finally {
			flag("bd-fail", false);
		}
		await waitFor("the column to reach Beads", async () => !(await card(t.id)).syncPending, 25_000);
		const shown = Bun.spawnSync([BD!, "--json", "show", t.id], {
			cwd: join(dir, "board", "beads"),
			env: { ...env, BEADS_DIR: join(dir, "board", "beads", ".beads") },
		});
		expect(shown.stdout.toString()).toMatch(/"status":\s*"closed"/);
	}, 60_000);

	test("A task's own session merges it, and the board removes its worktree once that session has exited", async () => {
		useHooks(false);
		const created = await api<Task>("POST", "/api/tasks", { title: "selfmerge work", merge: "local" });
		await api("POST", `/api/tasks/${created.id}/move`, { column: "todo" });
		const done = await waitFor("the self-merge", async () => {
			const c = await card(created.id);
			return c.column === "done" && !c.worktree && !c.intent ? c : null;
		}, 40_000);
		expect(done.lastOperation?.ok).toBe(true);
		const reply = readFileSync(join(dir, "home", "selfmerge.out"), "utf8");
		expect(reply).toContain('"merged"');
		expect(reply).not.toContain('"error"');
	}, 60_000);

	test("Deleting a card whose agent is slow to stop replies at once and deletes it once the worktree is gone", async () => {
		useHooks(false);
		const t = await startedTask("slow delete");
		const res = await call("DELETE", `/api/tasks/${t.id}`, { cleanup: true, confirmWorking: true });
		expect(res.status).toBe(202);
		expect(res.data).toMatchObject({ pending: true });
		await waitFor("the delete", async () => !(await api<{ tasks: Task[] }>("GET", "/api/state")).tasks.some((c) => c.id === t.id), 40_000);
		expect(existsSync(t.worktree)).toBe(false);
		expect(sessions()).not.toContain(sessionName(t.id));
	}, 90_000);

	test("A removal retries after its removeWorktree command fails, and a worktree the merge kept stays", async () => {
		useHooks(true);
		const kept = await startedTask("retry keep");
		await api("POST", `/api/tasks/${kept.id}/merge`, { cleanup: false, commit: true });
		const left = await startedTask("retry remove");
		flag("wt-rm-fails", true);
		const res = await api<{ pending: boolean }>("POST", `/api/tasks/${left.id}/merge`, { cleanup: true, commit: true });
		expect(res.pending).toBe(true);
		const removed = await waitFor("the retried removal", async () => {
			const c = await card(left.id);
			return !c.worktree && !c.intent ? c : null;
		}, 30_000);
		expect(removed.lastOperation?.ok).toBe(true);
		expect(existsSync(left.worktree)).toBe(false);
		expect(existsSync(kept.worktree)).toBe(true);
	}, 90_000);
});
