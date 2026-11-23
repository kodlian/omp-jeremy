import { type Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const EXTRA_PATH = `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`;
// The board also looks for tmux in Homebrew's directories when it isn't on PATH.
const TMUX = Bun.which("tmux", { PATH: EXTRA_PATH });
const CALLER = /^(CMUX_|TMUX|OMP_TERMINAL|MISSION_CONTROL_|WT_)/;

type Workspace = { ref: string; title: string; cwd: string; surface: string; command: string | null; waitsFor: string | null };
type FakeCmux = { workspaces: Record<string, Workspace>; log: { op: string; workspace?: string; session?: string; afterReply?: boolean | null }[] };
type Task = {
	id: string;
	branch: string;
	base: string;
	column: string;
	dependsOn: string[];
	planned: string | null;
	worktree: string | null;
	spawn: { state: string; error: string | null };
	presentation: { kind: string; cmux?: { workspace: string } } | null;
	execution: { kind: string; state: string; exitCode: number | null } | null;
	session: { id: string | null; file: string | null; connected: boolean } | null;
	agent: { state: string } | null;
	agents: RunningAgent[];
	attachCommand: string | null;
	intent: { op: string; stage: string | null; attempt: number; lastError: string | null } | null;
	lastOperation: { op: string; ok: boolean; error: string | null; output: string } | null;
	pr: { number: number; state: string; checks: string | null; review: string | null; conflicts: boolean } | null;
	land: { mergeInto: string | null; pr: boolean };
	tags: string[];
};
type RunningAgent = { id: string; title: string | null; state: string; step: string | null; todo: { done: number; total: number; current: string | null } | null; said: string | null; startedAt: string | null };
type Worktree = {
	path: string; project: string; branch: string | null; main: boolean; detached: string | null; base: string; column: string; tags: string[];
	agent: { state: string; session: { id: string; file: string } | null; title: string | null };
	agents: RunningAgent[];
};
type Project = { id: string; tags: string[]; hidden: string[]; tagRules: { pattern: string; tags: string[] }[] };
type State = { tasks: Task[]; projects: Project[]; worktrees: Worktree[] };
type Context = { kind: "cmux"; cmux: { cli: string; socket: string; workspace: string; surface: string } };

let dir = "";
let bin = "";
let repo = "";
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
wt=$(git -C "$MISSION_CONTROL_REPO" worktree list --porcelain | awk -v b="refs/heads/$MISSION_CONTROL_BRANCH" '$1=="worktree"{p=$2} $1=="branch"&&$2==b{print p; exit}')
if [ -n "$wt" ]; then
  echo "reuse $MISSION_CONTROL_BRANCH" >>"$HOME/wt.log"
else
  wt="$FAKE_WT_ROOT/$MISSION_CONTROL_BRANCH"
  git -C "$MISSION_CONTROL_REPO" worktree add -q "$wt" "$MISSION_CONTROL_BRANCH"
  echo "$MISSION_CONTROL_BRANCH" >>"$HOME/wt.log"
  if [ -f "$HOME/wt-fails" ]; then rm "$HOME/wt-fails"; echo "sidebar step failed" >&2; exit 1; fi
fi
cmux new-workspace --name "$MISSION_CONTROL_BRANCH" --cwd "$wt" --command "$MISSION_CONTROL_AGENT_COMMAND"
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
	// GitHub's pull requests of the repository, as $HOME/gh-prs.json lists them.
	gh: `#!/bin/sh
if [ "$1 $2" = "pr list" ]; then
  if [ -f "$HOME/gh-prs.json" ]; then cat "$HOME/gh-prs.json"; else echo "[]"; fi
  exit 0
fi
echo "gh $*: not stubbed" >&2
exit 1
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
	return `mc-${id.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
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

/** Waits until a created task has started: its worktree exists and its omp runs there. */
async function started(id: string): Promise<Task & { worktree: string }> {
	const t = await waitFor(`${id} to start`, async () => {
		const c = await card(id);
		if (c.spawn.state === "failed") throw new Error(`${c.id} didn't start: ${c.spawn.error}`);
		return c.spawn.state === "done" && c.worktree && !c.intent ? c : null;
	}, 30_000).catch(async (e) => {
		const c = await card(id);
		throw c.spawn.state === "failed" ? new Error(`${c.id} didn't start: ${c.spawn.error}`) : e;
	});
	return t as Task & { worktree: string };
}

/** A task created from `prompt`, which starts at once; the board starts and closes terminals in its own process, so the
 * test polls its state rather than awaiting a signal. */
async function startTask(prompt: string, options: { from?: Context; base?: string; after?: string } = {}): Promise<Task & { worktree: string }> {
	const { from, base, after } = options;
	const created = await api<Task>("POST", "/api/tasks", {
		prompt, repo, ...(base ? { base } : {}), ...(after ? { after } : {}),
		...(from ? { origin: { session: "lifecycle", terminal: from } } : {}),
	});
	expect(created.column).toBe("planning");
	return started(created.id);
}

/** A started task branched from `parent`, so it merges back locally, with a commit to merge. */
async function startedTask(prompt: string, from?: Context): Promise<Task & { worktree: string }> {
	const t = await startTask(prompt, { from, base: "parent" });
	run(["git", "-C", t.worktree, "commit", "-q", "--allow-empty", "-m", `${prompt} work`]);
	return t;
}

describe.skipIf(!TMUX)("a task's lifecycle", () => {
	beforeAll(async () => {
		dir = realpathSync(mkdtempSync("/tmp/mission-control-lifecycle-"));
		bin = join(dir, "bin");
		repo = join(dir, "repo");
		label = `mc-test-${basename(dir)}`;
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
			MISSION_CONTROL_HOME: join(dir, "board"), MISSION_CONTROL_PORT: String(port),
			MISSION_CONTROL_TMUX_LABEL: label, MISSION_CONTROL_LEASE_DIR: join(dir, "leases"), MISSION_CONTROL_RESUME_GRACE: "5",
			FAKE_CMUX_STATE: join(dir, "cmux.json"), FAKE_WT_ROOT: join(dir, "worktrees"),
		});
		run(["git", "init", "-q", "-b", "main"], repo);
		run(["git", "commit", "-q", "--allow-empty", "-m", "init"], repo);
		// The branch that tasks merging locally branch from, checked out where they merge.
		run(["git", "-C", repo, "worktree", "add", "-q", "-b", "parent", join(dir, "parent")]);
		run(["python3", "server.py", "--prepare"], ROOT);
		await startServer();
		origin = context(openWorkspace(repo));
	}, 60_000);

	afterAll(() => {
		server?.kill();
		Bun.spawnSync([TMUX!, "-L", label, "kill-server"], { env });
		Bun.spawnSync([TMUX!, "-S", join(dir, "local-tmux.sock"), "kill-server"], { env });
		rmSync(dir, { recursive: true, force: true });
	});

	// Each started card costs seconds of git work, so the requester cases run once per landing, not per worktree kind.
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
			const asker = requester === "inside" ? openWorkspace(t.worktree, replied) : requester === "outside" ? openWorkspace(repo) : undefined;
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

	test("A task from the default branch lands through a pull request, not a merge", async () => {
		useHooks(false);
		const t = await startTask("lands remotely");
		expect(t.land).toEqual({ mergeInto: null, pr: true });
		const res = await call("POST", `/api/tasks/${t.id}/merge`, { cleanup: false, commit: true });
		expect(res).toMatchObject({ status: 409, data: { error: expect.stringContaining("lands through a pull request") } });
	}, 60_000);

	test("Cards reach the columns people can't drag them to on their own", async () => {
		useHooks(false);
		const t = await startTask("moved by hand");
		const res = await call("POST", `/api/tasks/${t.id}/move`, { column: "review" });
		expect(res).toMatchObject({ status: 409, data: { error: "Cards reach Review on their own" } });
	}, 60_000);

	test("A task with nothing to wait for goes In Progress once its plan is approved", async () => {
		useHooks(false);
		const t = await startTask("solo plan");
		expect(await api("POST", `/api/tasks/${t.id}/planned`)).toEqual({ hold: false });
		const planned = await card(t.id);
		expect(planned.column).toBe("doing");
		expect(planned.planned).not.toBeNull();
	}, 60_000);

	test("A next task branches from its task, waits once its plan is approved, and resumes on its base once that task lands", async () => {
		useHooks(false);
		const first = await startedTask("stack base");
		const next = await startTask("planned next", { after: first.id });
		expect(next.base).toBe(first.branch);
		expect(next.dependsOn).toEqual([first.id]);
		expect(next.land.mergeInto).toBe(first.branch);
		const waiting = await waitFor("the next task to wait", async () => {
			const c = await card(next.id);
			return c.column === "waiting" && c.planned ? c : null;
		}, 15_000);
		expect(waiting.agent?.state).toBe("idle");
		expect(JSON.parse(readFileSync(join(dir, "home", `planned-${next.id}.out`), "utf8"))).toMatchObject({ hold: true });

		await api("POST", `/api/tasks/${first.id}/merge`, { cleanup: false, commit: true });
		const resumed = await waitFor("the next task to resume", async () => {
			const c = await card(next.id);
			return c.column === "doing" && (c.intent?.op === "resume" || c.lastOperation?.op === "resume") ? c : null;
		}, 20_000);
		expect(resumed.base).toBe("parent");
	}, 90_000);

	test("An open pull request moves its task to Pull Request with its checks; committed work without one goes to Review", async () => {
		useHooks(false);
		const pr = await startTask("open pull request");
		const ready = await startTask("committed work");
		for (const t of [pr, ready]) await api("POST", `/api/tasks/${t.id}/planned`);
		writeFileSync(join(dir, "home", "gh-prs.json"), JSON.stringify([{
			number: 7, state: "OPEN", url: "https://example.com/pull/7", title: "Open pull request", isDraft: false,
			headRefName: pr.branch, baseRefName: "main", reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING",
			statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }],
		}]));
		run(["git", "-C", ready.worktree, "commit", "-q", "--allow-empty", "-m", "ready work"]);
		await api("POST", "/api/refresh");
		const opened = await waitFor("the pull request", async () => {
			const c = await card(pr.id);
			return c.column === "pr" ? c : null;
		}, 15_000);
		expect(opened.pr).toMatchObject({ number: 7, state: "open", checks: "failing", review: "changes_requested", conflicts: true });
		expect(opened.land.pr).toBe(false);
		await waitFor("the committed task to reach Review", async () => (await card(ready.id)).column === "review", 15_000);
	}, 90_000);

	test("A task's tags are short lowercase words, and its project lists every tag in use", async () => {
		useHooks(false);
		const t = await api<Task>("POST", "/api/tasks", { prompt: "tagged work", repo, tags: ["Nutrition", "nutrition", "ds"] });
		expect(t.tags).toEqual(["nutrition", "ds"]);
		const refused = await call("PATCH", `/api/tasks/${t.id}`, { tags: ["bad tag"] });
		expect(refused).toMatchObject({ status: 400, data: { error: "Tags are up to 8 short words: lowercase letters, digits, . _ -" } });
		const state = await api<State>("GET", "/api/state");
		expect(state.projects.find((p) => p.id === "repo")?.tags).toEqual(["ds", "nutrition"]);
	}, 60_000);

	test("Tag rules tag a project's tasks and worktrees by branch or folder name, and hidden branches are kept per project", async () => {
		useHooks(false);
		const open = await api<Task>("POST", "/api/tasks", { prompt: "rule target", repo });
		const saved = await api<{ project: Project }>("PATCH", "/api/projects/tag-rules", { id: "repo", rules: [{ pattern: "FEATURE/rule-*", tags: ["Rules"] }] });
		expect(saved.project.tagRules).toEqual([{ pattern: "FEATURE/rule-*", tags: ["rules"] }]);
		expect((await card(open.id)).tags).toEqual(["rules"]);
		const next = await api<Task>("POST", "/api/tasks", { prompt: "rule follow-up", repo, tags: ["ds"] });
		expect(next.tags).toEqual(["ds", "rules"]);
		expect((await call("PATCH", "/api/projects/tag-rules", { id: "repo", rules: [{ pattern: "feature/*", tags: [] }] })).status).toBe(400);
		await api("PATCH", "/api/projects/tag-rules", { id: "repo", rules: [] });

		const kept = join(dir, "keep-nutrition");
		run(["git", "-C", repo, "worktree", "add", "-q", "-b", "keepme", kept]);
		await api("PATCH", "/api/projects/tag-rules", { id: "repo", rules: [{ pattern: "keep-*", tags: ["kept"] }] });
		await api("POST", "/api/refresh");
		const listed = await waitFor("the worktree", async () => (await api<State>("GET", "/api/state")).worktrees.find((w) => w.branch === "keepme"), 15_000);
		expect(listed.tags).toEqual(["kept"]);
		await api("PATCH", "/api/projects/tag-rules", { id: "repo", rules: [] });
		expect((await api<State>("GET", "/api/state")).worktrees.find((w) => w.branch === "keepme")?.tags).toEqual([]);

		const hidden = await api<{ project: Project }>("PATCH", "/api/projects/hidden", { id: "repo", branch: "keepme", hidden: true });
		expect(hidden.project.hidden).toEqual(["keepme"]);
		await api("PATCH", "/api/projects/hidden", { id: "repo", branch: open.branch, hidden: true });
		const shown = await api<{ project: Project }>("PATCH", "/api/projects/hidden", { id: "repo", branch: "keepme", hidden: false });
		expect(shown.project.hidden).toEqual([open.branch]);
		await api("PATCH", "/api/projects/hidden", { id: "repo", branch: open.branch, hidden: false });
		run(["git", "-C", repo, "worktree", "remove", "--force", kept]);
	}, 60_000);

	test("A worktree no task owns is listed and adopted once; a task built on another waits for it, then resumes", async () => {
		useHooks(false);
		const other = join(dir, "other");
		const side = join(dir, "side");
		mkdirSync(other);
		run(["git", "init", "-q", "-b", "main"], other);
		run(["git", "commit", "-q", "--allow-empty", "-m", "init"], other);
		run(["git", "-C", other, "worktree", "add", "-q", "-b", "side", side]);
		const { project } = await api<{ project: { id: string } }>("POST", "/api/projects", { path: other });
		await api("POST", "/api/refresh");
		const listed = await waitFor("the worktree", async () => (await api<State>("GET", "/api/state")).worktrees.find((w) => w.branch === "side"), 15_000);
		expect(listed).toMatchObject({ path: side, project: project.id, base: "main", column: "doing", tags: [] });

		const adopted = await api<Task>("POST", "/api/worktrees/adopt", { path: side });
		expect(adopted).toMatchObject({ worktree: side, branch: "side", base: "main", column: "doing" });
		expect((await api<State>("GET", "/api/state")).worktrees.some((w) => w.branch === "side")).toBe(false);
		expect((await api<Task>("POST", "/api/worktrees/adopt", { path: side })).id).toBe(adopted.id);

		const first = await started((await api<Task>("POST", "/api/tasks", { prompt: "first", repo: other })).id);
		const next = await api<Task>("POST", "/api/tasks", { prompt: "planned on first", repo: other, after: first.id });
		await waitFor("the next task to wait", async () => (await card(next.id)).column === "waiting", 30_000);
		await api("POST", `/api/tasks/${first.id}/move`, { column: "done", confirmWorking: true });
		await waitFor("the next task to resume", async () => (await card(next.id)).column === "doing", 20_000);
	}, 90_000);

	test("Checkouts without a task list every omp running there, asleep ones resume their session, and detached ones and the main checkout are listed too", async () => {
		useHooks(false);
		const project = join(dir, "sleepers");
		const [asleep, awake, loose] = ["asleep", "awake", "loose"].map((name) => join(dir, `sleepers-${name}`));
		mkdirSync(project);
		run(["git", "init", "-q", "-b", "main"], project);
		run(["git", "commit", "-q", "--allow-empty", "-m", "init"], project);
		run(["git", "-C", project, "worktree", "add", "-q", "-b", "asleep", asleep]);
		run(["git", "-C", project, "worktree", "add", "-q", "-b", "awake", awake]);
		run(["git", "-C", project, "worktree", "add", "-q", "--detach", loose]);
		// omp's session files: one folder per directory, a 256-byte title slot, the header, then entries.
		const session = (cwd: string, id: string, title: string): string => {
			const bucket = join(dir, "home", ".omp", "agent", "sessions", `--${cwd.slice(1).replaceAll("/", "-")}--`);
			mkdirSync(bucket, { recursive: true });
			const file = join(bucket, `2026-11-20T10-00-00-000Z_${id}.jsonl`);
			const slot = JSON.stringify({ type: "title", v: 1, title, source: "auto" }).padEnd(255);
			writeFileSync(file, `${slot}\n${JSON.stringify({ type: "session", version: 3, id, cwd })}\n{"type":"message"}\n`);
			return file;
		};
		const sleepy = session(asleep, "sleepy-1", "Plan the sleepy thing");
		session(awake, "awake-1", "Working on it");
		const second = session(awake, "awake-2", "Second look");
		session(project, "main-1", "Main work");
		// A live omp holds its session's lease.
		const holder = Bun.spawn(["python3", "-c", `import fcntl, os, time
for sid in ("awake-1", "awake-2", "main-1"):
    fcntl.lockf(os.open(os.path.join(${JSON.stringify(join(dir, "leases"))}, sid + ".lock"), os.O_RDWR | os.O_CREAT), fcntl.LOCK_EX)
print("held", flush=True)
time.sleep(60)`], { stdout: "pipe" });
		await holder.stdout.getReader().read();
		try {
			await api("POST", "/api/projects", { path: project });
			await api("POST", "/api/refresh");
			const [sleeping, running, detached, main] = await waitFor("the checkouts", async () => {
				const listed = (await api<State>("GET", "/api/state")).worktrees;
				const found = [asleep, awake, loose, project].map((path) => listed.find((w) => w.path === path));
				return found.every(Boolean) ? (found as Worktree[]) : null;
			}, 15_000);
			expect(sleeping.agent).toMatchObject({ state: "asleep", session: { id: "sleepy-1", file: sleepy }, title: "Plan the sleepy thing" });
			expect(sleeping.agents).toEqual([]);
			expect(running.agent).toMatchObject({ state: "running", title: expect.any(String) });
			expect(running.agents.map((a) => a.id).sort()).toEqual(["awake-1", "awake-2"]);
			expect(detached).toMatchObject({ branch: null, main: false, detached: run(["git", "-C", loose, "rev-parse", "--short", "HEAD"]), agent: { state: "none" } });
			expect(main).toMatchObject({ branch: "main", main: true, agent: { state: "running" } });
			expect(main.agents).toMatchObject([{ id: "main-1", title: "Main work", state: "running" }]);
			expect(await call("POST", "/api/worktrees/remove", { path: project })).toMatchObject({ status: 409 });

			// Each omp reports for itself: what it does, its run clock, to-do progress and latest sentence.
			const startedAt = Math.floor(Date.now() / 1000) - 60;
			await api("POST", "/api/agent", { path: awake, sessionId: "awake-2", sessionFile: second, state: "working", step: "Reading the plan",
				todo: { done: 1, total: 3, current: "Check the plan" }, said: "The plan looks right.", startedAt });
			const reported = await waitFor("the second omp's report", async () =>
				(await api<State>("GET", "/api/state")).worktrees.find((w) => w.path === awake)?.agents.find((a) => a.id === "awake-2" && a.state === "working"), 15_000);
			expect(reported).toMatchObject({ title: "Second look", step: "Reading the plan", todo: { done: 1, total: 3, current: "Check the plan" },
				said: "The plan looks right.", startedAt: new Date(startedAt * 1000).toISOString().replace(".000", "") });

			// Resume makes the worktree a card whose omp reopens exactly that session.
			const resumed = await api<Task>("POST", "/api/worktrees/adopt", { path: asleep, session: "sleepy-1" });
			await api("POST", `/api/tasks/${resumed.id}/move`, { column: "doing" });
			const argv = await waitFor("the resumed omp", async () => ompArgs(resumed.id).at(-1), 20_000);
			expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual(["--resume", sleepy]);

			// An omp already running there becomes the card's agent; the other one is listed beside it.
			const tracked = await api<Task>("POST", "/api/worktrees/adopt", { path: awake });
			await waitFor("the running omp", async () => (await card(tracked.id)).execution?.state === "running", 15_000);
			const beside = await waitFor("the other omp on the card", async () => {
				const c = await card(tracked.id);
				return c.agents.length === 1 ? c : null;
			}, 15_000);
			expect(beside.agents[0].id).toBe(["awake-1", "awake-2"].find((id) => id !== beside.session?.id));

			// A detached worktree opens and is removed without a card.
			expect(await api("POST", "/api/worktrees/open", { path: loose })).toMatchObject({ opened: false, cd: `cd ${loose}` });
			await api("POST", "/api/worktrees/remove", { path: loose });
			expect(existsSync(loose)).toBe(false);
			expect((await api<State>("GET", "/api/state")).worktrees.some((w) => w.path === loose)).toBe(false);
		} finally {
			holder.kill();
		}
	}, 90_000);

	test("Stop closes the terminal a createWorktree hook opened", async () => {
		useHooks(true);
		const t = await startedTask("stop hooked", origin);
		const opened = t.presentation?.cmux?.workspace;
		expect(opened && cmux().workspaces[opened]?.cwd).toBe(t.worktree);
		await api("POST", `/api/tasks/${t.id}/stop`);
		expect(cmux().workspaces[opened!]).toBeUndefined();
	}, 60_000);

	test("Opening a task whose terminal was closed only says how to reach it: no terminal opens, attaches or closes", async () => {
		useHooks(true);
		const t = await startTask("closed terminal", { from: origin });
		run([join(bin, "cmux"), "workspace", "close", "--force", "--workspace", t.presentation!.cmux!.workspace]);
		const before = cmux();
		const r = await api<{ opened: boolean; attachCommand: string | null; cd: string }>("POST", `/api/tasks/${t.id}/open`);
		expect(r).toMatchObject({ opened: false, cd: `cd ${t.worktree}` });
		expect(r.attachCommand).toContain("attach-session");
		const after = cmux();
		expect(Object.keys(after.workspaces).sort()).toEqual(Object.keys(before.workspaces).sort());
		expect(after.log).toEqual(before.log);
	}, 60_000);

	test("An agent on cmux's local-tmux shows in the task's workspace left from before, not beside a terminal that only sits in its worktree", async () => {
		useHooks(false);
		flag("local-tmux", true);
		try {
			// The worktree and its cmux workspace from a start before a board restart.
			const path = join(dir, "worktrees", "reused");
			run(["git", "-C", repo, "worktree", "add", "-q", "-b", "feature/reused", path]);
			const left = openWorkspace(path);
			const created = await api<Task>("POST", "/api/tasks", { prompt: "reused workspace", repo, branch: "feature/reused", origin: { session: "lifecycle", terminal: origin } });
			const t = await started(created.id);
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
		const t = await startTask("hook resume", { from: origin });
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
			const t = await startTask("local tmux resume", { from: origin });
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
		const t = await startTask("resume flags");
		await api("POST", `/api/tasks/${t.id}/stop`);
		await waitFor("the stop", async () => {
			const c = await card(t.id);
			return c.column === "waiting" && c.execution?.state === "stopped" && !c.intent;
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
		const t = await startTask("nudge handshake");
		await api("POST", `/api/tasks/${t.id}/stop`);
		await waitFor("the stop", async () => {
			const c = await card(t.id);
			return c.column === "waiting" && c.execution?.state === "stopped" && !c.intent;
		}, 15_000);
		await api("POST", `/api/tasks/${t.id}/move`, { column: "doing" });
		const file = join(dir, "board", "tasks", t.id, "resume.json");
		await waitFor("the resume file", async () => existsSync(file), 15_000);
		expect(JSON.parse(readFileSync(file, "utf8")).text).toContain("continue where you stopped");
		await api("POST", `/api/tasks/${t.id}/resumed`);
		expect(existsSync(file)).toBe(false);
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
		const created = await api<Task>("POST", "/api/tasks", { prompt: "restart start", repo });
		// The board must be killed while its own process waits on the hook, which the test can't observe.
		await Bun.sleep(2000);
		flag("wt-slow", false);
		await restartServer();
		const t = await started(created.id);
		expect(existsSync(t.worktree)).toBe(true);
		expect(sessions().filter((s) => s === sessionName(created.id))).toHaveLength(1);
	}, 60_000);

	test("A failed start leaves nothing to redo: starting again reuses its worktree", async () => {
		useHooks(true);
		flag("wt-fails", true);
		const created = await api<Task>("POST", "/api/tasks", { prompt: "fails once", repo });
		const failed = await waitFor("the failed start", async () => {
			const c = await card(created.id);
			return c.spawn.state === "failed" && !c.intent ? c : null;
		}, 30_000);
		expect(failed.lastOperation).toMatchObject({ op: "start", ok: false });
		expect(failed.spawn.error).toContain("sidebar step failed");
		await api("POST", `/api/tasks/${created.id}/move`, { column: "doing" });
		const t = await started(created.id);
		expect(t.worktree).toBe(join(dir, "worktrees", created.branch));
		expect(readFileSync(join(dir, "home", "wt.log"), "utf8").split("\n").filter((line) => line === created.branch)).toHaveLength(1);
	}, 60_000);

	test("A task's own session merges it, and the board removes its worktree once that session has exited", async () => {
		useHooks(false);
		const created = await api<Task>("POST", "/api/tasks", { prompt: "selfmerge work", repo, base: "parent" });
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
