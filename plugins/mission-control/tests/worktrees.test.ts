import { type Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const EXTRA_PATH = `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`;
const CALLER = /^(CMUX_|TMUX|OMP_TERMINAL|MISSION_CONTROL_|WT_)/;

type Agent = { id: string; title: string | null; state: string; step: string | null; startedAt: string | null; todo: { done: number; total: number; current: string | null } | null; said: string | null; question: string | null; terminal: boolean };
type Worktree = {
	path: string; key: string; title: string; folder: string; project: string; branch: string | null; detached: string | null; main: boolean; base: string; column: string; landed: boolean; tags: string[]; dependsOn: string[]; waitingFor: string[];
	git: { commits: number; dirty: number; last: { subject: string } | null } | null;
	pr: { number: number; state: string; unresolved: number } | null;
	agent: { state: string; session: { id: string; file: string } | null };
	agents: Agent[];
	actions: { open: boolean; pr: string | null; resume: boolean; remove: boolean };
};
type Link = { from: string; to: string };
type Project = { id: string; tags: string[]; links: Link[]; positions: Record<string, { x: number; y: number }> };
type State = { projects: Project[]; worktrees: Worktree[] };
type FakeCmux = { workspaces: Record<string, { cwd: string; surface: string; command: string | null }>; log: { op: string; workspace?: string; panel?: string; command?: string | null }[] };

const HOOKS = {
	// A createWorktree hook like the kit's wt: checks the branch out under $FAKE_WT_ROOT and records what it was given.
	wt: `#!/bin/sh
set -e
wt="$FAKE_WT_ROOT/$MISSION_CONTROL_BRANCH"
if git -C "$MISSION_CONTROL_REPO" show-ref --verify --quiet "refs/heads/$MISSION_CONTROL_BRANCH"; then
  git -C "$MISSION_CONTROL_REPO" worktree add -q "$wt" "$MISSION_CONTROL_BRANCH"
else
  git -C "$MISSION_CONTROL_REPO" worktree add -q -b "$MISSION_CONTROL_BRANCH" "$wt" "$MISSION_CONTROL_BASE"
fi
echo "$MISSION_CONTROL_BRANCH from $MISSION_CONTROL_BASE agent: $MISSION_CONTROL_AGENT_COMMAND" >>"$HOME/wt.log"
`,
	// A removeWorktree hook like the kit's wt-rm: asks before losing uncommitted files.
	"wt-rm": `#!/bin/sh
set -e
root=$(git rev-parse --show-toplevel)
repo=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
branch=$(git symbolic-ref --short -q HEAD || true)
if [ -n "$(git status --porcelain)" ]; then
  answer=$(head -c 1 || true)
  [ "$answer" = y ] || { echo "Cancelled"; exit 1; }
fi
cd "$repo"
git worktree remove --force "$root"
[ -z "$branch" ] || git branch -D -q "$branch"
echo "removed $root" >>"$HOME/wt-rm.log"
`,
	// gh: pull requests from $HOME/gh-prs.json, review threads from $HOME/gh-threads.json, and pr create.
	gh: `#!/bin/sh
case "$1 $2" in
  "pr list") if [ -f "$HOME/gh-prs.json" ]; then cat "$HOME/gh-prs.json"; else echo "[]"; fi ;;
  "api graphql") if [ -f "$HOME/gh-threads.json" ]; then cat "$HOME/gh-threads.json"; else exit 1; fi ;;
  "pr create") echo "$*" >>"$HOME/gh.log"; echo "https://github.com/acme/repo/pull/7" ;;
  *) echo "gh $*: not stubbed" >&2; exit 1 ;;
esac
`,
	omp: `#!/bin/sh
echo "omp $*" >>"$HOME/omp.log"
`,
};

let dir = "";
let bin = "";
let repo = "";
let port = 0;
let env: Record<string, string> = {};
let server: Subprocess | undefined;
let holder: Subprocess | undefined;

function run(cmd: string[], cwd = dir): string {
	const p = Bun.spawnSync(cmd, { cwd, env });
	if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		headers: method === "GET" ? {} : { "Content-Type": "application/json" },
		keepalive: false,
		body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
	});
	return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await call(method, path, body);
	if (res.status >= 400) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.data)}`);
	return res.data as T;
}

async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>, timeout = 15_000): Promise<T> {
	for (const deadline = Date.now() + timeout; Date.now() < deadline; await Bun.sleep(150)) {
		const value = await check().catch(() => null);
		if (value) return value;
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The checkout at `path` once `ready` holds for it, after a full scan. */
async function checkout(path: string, ready: (w: Worktree) => boolean = () => true): Promise<Worktree> {
	await api("POST", "/api/refresh");
	return waitFor(path, async () => {
		const w = (await api<State>("GET", "/api/state")).worktrees.find((x) => x.path === path);
		return w && ready(w) ? w : null;
	});
}

function worktree(name: string, ...extra: string[]): string {
	const path = join(dir, name);
	run(["git", "-C", repo, "worktree", "add", "-q", ...extra, path]);
	return path;
}

function cmux(): FakeCmux {
	return JSON.parse(readFileSync(join(dir, "cmux.json"), "utf8"));
}

/** A cmux workspace already open in `cwd`, as the user's own terminal there. */
function workspace(cwd: string): { kind: "cmux"; cmux: { cli: string; socket: string; workspace: string; surface: string } } {
	const id = run([join(bin, "cmux"), "new-workspace", "--name", "shell", "--cwd", cwd]).split(" ")[1];
	return { kind: "cmux", cmux: { cli: join(bin, "cmux"), socket: join(dir, "cmux.sock"), workspace: id, surface: cmux().workspaces[id].surface } };
}

/** An omp session file of `cwd`, as omp writes it: a 256-byte title slot, the header, then entries. */
function session(cwd: string, id: string, title: string): string {
	const bucket = join(dir, "home", ".omp", "agent", "sessions", `--${cwd.slice(1).replaceAll("/", "-")}--`);
	mkdirSync(bucket, { recursive: true });
	const file = join(bucket, `2026-11-20T10-00-00-000Z_${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "title", v: 1, title, source: "auto" }).padEnd(255)}\n${JSON.stringify({ type: "session", version: 3, id, cwd })}\n{"type":"message"}\n`);
	return file;
}

/** Holds the leases of `ids`, as their live omp would, until the returned process is killed. */
async function hold(ids: string[]): Promise<Subprocess> {
	const p = Bun.spawn(["python3", "-c", `import fcntl, os, sys, time
for sid in sys.argv[2:]:
    fcntl.lockf(os.open(os.path.join(sys.argv[1], sid + ".lock"), os.O_RDWR | os.O_CREAT), fcntl.LOCK_EX)
print("held", flush=True)
time.sleep(120)`, join(dir, "leases"), ...ids], { stdout: "pipe" });
	await p.stdout.getReader().read();
	return p;
}

function useHooks(hooks: boolean): void {
	const commands = hooks ? { createWorktree: join(bin, "wt"), removeWorktree: join(bin, "wt-rm") } : {};
	writeFileSync(join(dir, "board", "config.json"), JSON.stringify({ commands, projects: { repo: { setupScript: join(bin, "setup.sh") } } }));
}

describe("Mission Control's checkouts", () => {
	beforeAll(async () => {
		dir = realpathSync(mkdtempSync("/tmp/mission-control-worktrees-"));
		bin = join(dir, "bin");
		repo = join(dir, "repo");
		for (const sub of ["bin", "home", "board", "repo", "leases", "wt"]) mkdirSync(join(dir, sub));
		copyFileSync(join(import.meta.dir, "fake_cmux.py"), join(bin, "cmux"));
		for (const [name, text] of Object.entries(HOOKS)) writeFileSync(join(bin, name), text);
		writeFileSync(join(bin, "setup.sh"), 'echo "set up $MISSION_CONTROL_BRANCH" >>"$HOME/setup.log"\n');
		for (const name of ["cmux", "setup.sh", ...Object.keys(HOOKS)]) chmodSync(join(bin, name), 0o755);
		writeFileSync(join(dir, "home", ".gitconfig"), "[user]\n\tname = Checkouts\n\temail = checkouts@example.com\n");
		env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !CALLER.test(k))) as Record<string, string>;
		const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		port = probe.port;
		probe.stop(true);
		Object.assign(env, {
			HOME: join(dir, "home"), PATH: `${bin}:${EXTRA_PATH}`, PYTHONDONTWRITEBYTECODE: "1",
			MISSION_CONTROL_HOME: join(dir, "board"), MISSION_CONTROL_PORT: String(port), MISSION_CONTROL_LEASE_DIR: join(dir, "leases"),
			FAKE_CMUX_STATE: join(dir, "cmux.json"), FAKE_WT_ROOT: join(dir, "wt"),
		});
		run(["git", "init", "-q", "--bare", "-b", "main", join(dir, "origin.git")]);
		run(["git", "init", "-q", "-b", "main"], repo);
		run(["git", "commit", "-q", "--allow-empty", "-m", "init"], repo);
		run(["git", "-C", repo, "remote", "add", "origin", join(dir, "origin.git")]);
		run(["git", "-C", repo, "push", "-q", "-u", "origin", "main"]);
		run(["git", "-C", repo, "remote", "set-head", "origin", "main"]);
		useHooks(false);
		server = Bun.spawn(["python3", "server.py"], { cwd: ROOT, env, stdout: "ignore", stderr: "ignore" });
		await waitFor("the board", () => api("GET", "/api/health").then(() => true), 20_000);
		await api("POST", "/api/projects", { path: repo });
	}, 60_000);

	afterAll(() => {
		holder?.kill();
		server?.kill();
		rmSync(dir, { recursive: true, force: true });
	});

	test("Every checkout is a card whose column and actions follow its work, its pull request and its omp", async () => {
		const fresh = worktree("fresh", "-b", "fresh");
		const work = worktree("work", "-b", "work");
		run(["git", "-C", work, "commit", "-q", "--allow-empty", "-m", "work in progress"]);
		const merged = worktree("merged", "-b", "merged");
		run(["git", "-C", merged, "commit", "-q", "--allow-empty", "-m", "merged work"]);
		run(["git", "-C", repo, "merge", "-q", "--no-ff", "-m", "Merge merged", "merged"]);
		const leftover = worktree("leftover", "-b", "leftover");
		run(["git", "-C", leftover, "commit", "-q", "--allow-empty", "-m", "leftover work"]);
		run(["git", "-C", repo, "merge", "-q", "--no-ff", "-m", "Merge leftover", "leftover"]);
		writeFileSync(join(leftover, "notes.txt"), "not committed\n");
		const loose = worktree("loose", "--detach");

		expect(await checkout(repo)).toMatchObject({ main: true, branch: "main", title: "main", column: "idle", pr: null,
			actions: { open: true, pr: null, resume: false, remove: false } });
		expect(await checkout(fresh)).toMatchObject({ main: false, base: "main", title: "fresh", folder: "", column: "idle", landed: false,
			actions: { pr: null, resume: false, remove: true } });
		expect(await checkout(work)).toMatchObject({ column: "review", landed: false, git: { commits: 1, last: { subject: "work in progress" } },
			actions: { pr: "create" } });
		expect(await checkout(merged)).toMatchObject({ column: "done", landed: true, actions: { pr: null, remove: true } });
		// Work left uncommitted keeps a landed branch out of Done.
		expect(await checkout(leftover)).toMatchObject({ column: "idle", landed: true, git: { dirty: 1 } });
		expect(await checkout(loose)).toMatchObject({ branch: null, detached: run(["git", "-C", loose, "rev-parse", "--short", "HEAD"]),
			column: "idle", actions: { pr: null, remove: true } });

		const project = (await api<State>("GET", "/api/state")).projects[0];
		await api("PATCH", "/api/projects/tag-rules", { id: project.id, rules: [{ pattern: "fr*", tags: ["new"] }] });
		expect((await checkout(fresh)).tags).toEqual(["new"]);

		writeFileSync(join(dir, "home", "gh-prs.json"), JSON.stringify([{ number: 5, state: "OPEN", url: "https://github.com/acme/repo/pull/5", title: "Work",
			isDraft: false, headRefName: "work", baseRefName: "main", reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", statusCheckRollup: [] }]));
		writeFileSync(join(dir, "home", "gh-threads.json"), JSON.stringify({ data: { repository: { pullRequests: { nodes: [
			{ headRefName: "work", reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] } }] } } } }));
		expect(await checkout(work, (w) => w.pr !== null)).toMatchObject({ column: "pr", pr: { number: 5, state: "open", unresolved: 2 },
			actions: { pr: "open" } });
		rmSync(join(dir, "home", "gh-prs.json"));
	}, 90_000);

	test("Every omp in a checkout is listed with what it reports, asleep sessions resume, and a stopped one is forgotten", async () => {
		const work = join(dir, "work");
		const fresh = join(dir, "fresh");
		session(work, "work-1", "First look");
		const second = session(work, "work-2", "Second look");
		const sleepy = session(fresh, "fresh-1", "Plan the fresh thing");
		session(repo, "main-1", "Main work");
		holder = await hold(["work-1", "work-2", "main-1"]);

		const running = await checkout(work, (w) => w.agents.length === 2);
		expect(running.agents.map((a) => a.id).sort()).toEqual(["work-1", "work-2"]);
		expect(running.agents.every((a) => a.state === "running" && !a.terminal)).toBe(true);
		expect(running.actions).toMatchObject({ resume: false, remove: false });
		expect((await checkout(repo, (w) => w.agents.length === 1)).agents[0]).toMatchObject({ id: "main-1", title: "Main work" });
		const asleep = await checkout(fresh, (w) => w.agent.state === "asleep");
		expect(asleep).toMatchObject({ agent: { session: { id: "fresh-1", file: sleepy } }, actions: { resume: true } });

		const terminal = workspace(work);
		const startedAt = Math.floor(Date.now() / 1000) - 60;
		await api("POST", "/api/agent", { path: join(work), sessionId: "work-2", sessionFile: second, state: "working", step: "Reading the plan",
			todo: { done: 1, total: 3, current: "Check the plan" }, said: "The plan looks right.", startedAt, terminal });
		const reported = await waitFor("the report", async () =>
			(await api<State>("GET", "/api/state")).worktrees.find((w) => w.path === work)?.agents.find((a) => a.id === "work-2" && a.state === "working"));
		expect(reported).toMatchObject({ title: "Second look", step: "Reading the plan", todo: { done: 1, total: 3, current: "Check the plan" },
			said: "The plan looks right.", startedAt: new Date(startedAt * 1000).toISOString().replace(".000", ""), terminal: true });
		expect((await call("POST", "/api/agent", { path: dir, sessionId: "elsewhere", state: "idle" })).status).toBe(404);

		// Resume reopens exactly the asleep session in a new terminal; refused where omp already runs.
		const before = cmux().log.length;
		expect(await api("POST", "/api/worktrees/resume", { path: fresh, session: "fresh-1" })).toMatchObject({ opened: true });
		expect(cmux().log.slice(before)).toContainEqual(expect.objectContaining({ op: "create", command: expect.stringContaining(`--resume ${sleepy}`) }));
		expect((await call("POST", "/api/worktrees/resume", { path: work, session: "work-1" })).status).toBe(409);

		await api("POST", "/api/agent", { path: work, sessionId: "work-2", state: "exited" });
		holder.kill();
		await holder.exited;
		holder = undefined;
		expect((await checkout(work, (w) => w.agents.length === 0)).actions).toMatchObject({ remove: true });
	}, 90_000);

	test("Open only brings forward a terminal already there: the omp's own, else any in the checkout, never a new one", async () => {
		const work = join(dir, "work");
		const loose = join(dir, "loose");
		holder = await hold(["work-3"]);
		const own = workspace(work);
		workspace(work);
		await api("POST", "/api/agent", { path: work, sessionId: "work-3", sessionFile: session(work, "work-3", "Third look"), state: "idle", terminal: own });
		await checkout(work, (w) => w.agents.some((a) => a.id === "work-3" && a.terminal));

		let before = cmux().log.length;
		expect(await api("POST", "/api/worktrees/open", { path: work, session: "work-3" })).toMatchObject({ opened: true });
		expect(cmux().log.slice(before)).toEqual([{ op: "select", workspace: own.cmux.workspace }, { op: "focus", panel: own.cmux.surface }]);

		// Its omp's terminal was closed: any terminal still in the checkout comes forward instead.
		run([join(bin, "cmux"), "workspace", "close", "--workspace", own.cmux.workspace]);
		before = cmux().log.length;
		expect(await api("POST", "/api/worktrees/open", { path: work, session: "work-3" })).toMatchObject({ opened: true });
		const selected = cmux().log.slice(before).filter((e) => e.op === "select").at(-1)?.workspace;
		expect(selected).not.toBe(own.cmux.workspace);
		expect(cmux().workspaces[selected!]?.cwd).toBe(work);

		// Nothing there: the reply says where to cd, and nothing is created or closed.
		const workspaces = Object.keys(cmux().workspaces).sort();
		before = cmux().log.length;
		expect(await api("POST", "/api/worktrees/open", { path: loose })).toEqual({ ok: true, opened: false, cd: `cd ${loose}` });
		expect(cmux().log.slice(before).filter((e) => e.op !== "select")).toEqual([]);
		expect(Object.keys(cmux().workspaces).sort()).toEqual(workspaces);
		holder.kill();
		holder = undefined;
	}, 60_000);

	test("New worktree runs the createWorktree hook, else checks the branch out itself; a prompt starts omp planning it, and after stacks it", async () => {
		const project = (await api<State>("GET", "/api/state")).projects[0].id;
		const built = await api<{ path: string; key: string }>("POST", "/api/worktrees/new", { project, branch: "built" });
		expect(built).toMatchObject({ key: "built", path: join(dir, "board", "worktrees", "repo", "built") });
		expect(readFileSync(join(dir, "home", "setup.log"), "utf8")).toContain("set up built");
		await checkout(built.path);
		expect((await call("POST", "/api/worktrees/new", { project, branch: "built" })).status).toBe(409);
		expect((await call("POST", "/api/worktrees/new", { project, branch: "bad name" })).status).toBe(400);
		expect((await call("POST", "/api/worktrees/new", { project })).status).toBe(400);

		// A prompt without a hook: the branch comes from the prompt and a new terminal there runs omp planning it.
		const before = cmux().log.length;
		const planned = await api<{ key: string; opened: boolean }>("POST", "/api/worktrees/new", { project, prompt: "Speed up the search index" });
		expect(planned).toMatchObject({ key: "feature/speed-up-the-search-index", opened: true });
		const started = cmux().log.slice(before).find((e) => e.op === "create");
		expect(started?.command).toContain("--config");
		expect(started?.command).toContain("Speed up the search index");

		useHooks(true);
		try {
			const hooked = await api<{ path: string }>("POST", "/api/worktrees/new", { project, branch: "hooked" });
			expect(hooked.path).toBe(join(dir, "wt", "hooked"));
			expect(readFileSync(join(dir, "home", "wt.log"), "utf8")).toContain("hooked from main agent: \n");

			// After another checkout: made from its branch, nested under it, depending on it, and waiting while it is open.
			const stacked = await api<{ key: string; path: string }>("POST", "/api/worktrees/new", { project, branch: "stacked", after: "work", prompt: "Build on work" });
			expect(stacked.path).toBe(join(dir, "wt", "stacked"));
			const log = readFileSync(join(dir, "home", "wt.log"), "utf8");
			expect(log).toContain("stacked from work agent: ");
			expect(log).toContain("Build on work");
			expect(run(["git", "-C", repo, "config", "--get", "branch.stacked.nestUnder"])).toBe("work");
			expect(run(["git", "-C", repo, "merge-base", "--is-ancestor", "work", "stacked"])).toBe("");
			expect(await checkout(stacked.path, (w) => w.column === "waiting")).toMatchObject({ base: "work", dependsOn: ["work"], waitingFor: ["work"] });
		} finally {
			useHooks(false);
		}
	}, 60_000);

	test("Create PR pushes the branch and opens its pull request into the branch it was made from", async () => {
		const work = join(dir, "work");
		expect(await api("POST", "/api/worktrees/pr", { path: work })).toEqual({ ok: true, url: "https://github.com/acme/repo/pull/7" });
		expect(readFileSync(join(dir, "home", "gh.log"), "utf8")).toContain("pr create --base main --head work --fill");
		expect(run(["git", "-C", join(dir, "origin.git"), "rev-parse", "work"])).toBe(run(["git", "-C", work, "rev-parse", "HEAD"]));
		expect((await call("POST", "/api/worktrees/pr", { path: repo })).status).toBe(409);
	}, 60_000);

	test("Remove refuses the main checkout, a running omp and uncommitted work unless forced, and asks the hook to confirm", async () => {
		const leftover = join(dir, "leftover");
		expect((await call("POST", "/api/worktrees/remove", { path: repo })).status).toBe(409);
		holder = await hold(["leftover-1"]);
		session(leftover, "leftover-1", "Still here");
		await checkout(leftover, (w) => w.agents.length === 1);
		expect((await call("POST", "/api/worktrees/remove", { path: leftover })).status).toBe(409);
		holder.kill();
		await holder.exited;
		holder = undefined;
		await checkout(leftover, (w) => w.agents.length === 0);

		expect(await call("POST", "/api/worktrees/remove", { path: leftover })).toMatchObject({ status: 409, data: { dirty: 1 } });
		expect(existsSync(leftover)).toBe(true);
		await api("POST", "/api/worktrees/remove", { path: leftover, force: true });
		expect(existsSync(leftover)).toBe(false);
		expect(run(["git", "-C", repo, "branch", "--list", "leftover"])).toBe("");

		useHooks(true);
		try {
			const fresh = join(dir, "fresh");
			writeFileSync(join(fresh, "scratch.txt"), "scratch\n");
			await api("POST", "/api/worktrees/remove", { path: fresh, force: true });
			expect(existsSync(fresh)).toBe(false);
			expect(readFileSync(join(dir, "home", "wt-rm.log"), "utf8")).toContain(`removed ${fresh}`);
		} finally {
			useHooks(false);
		}
		expect((await api<State>("GET", "/api/state")).worktrees.some((w) => w.path === leftover)).toBe(false);
	}, 60_000);

	test("A worktree depends on others through links, which refuse itself, unknown checkouts and cycles, and go with it", async () => {
		const id = (await api<State>("GET", "/api/state")).projects[0].id;
		const link = (from: string, to: string, linked = true) => call("PATCH", "/api/projects/links", { id, from, to, linked });
		const dep = worktree("dep", "-b", "dep");
		await checkout(dep);
		expect((await link("work", "dep")).status).toBe(200);
		expect(await checkout(dep, (w) => w.column === "waiting")).toMatchObject({ dependsOn: ["work"], waitingFor: ["work"] });
		expect((await link("dep", "merged")).status).toBe(200);
		expect(await link("merged", "work")).toMatchObject({ status: 400, data: { error: "merged already depends on work" } });
		expect((await link("work", "work")).status).toBe(400);
		expect((await link("work", "nowhere")).status).toBe(400);
		expect((await api<State>("GET", "/api/state")).projects[0].links).toContainEqual({ from: "dep", to: "merged", madeFrom: false });

		// Places on the Graph canvas are kept by checkout; null forgets one and reset forgets them all.
		await api("PATCH", "/api/projects/positions", { id, positions: { dep: { x: 120, y: -40 }, work: { x: 0, y: 0 } } });
		await api("PATCH", "/api/projects/positions", { id, positions: { work: null } });
		expect((await api<State>("GET", "/api/state")).projects[0].positions).toEqual({ dep: { x: 120, y: -40 } });
		expect((await call("PATCH", "/api/projects/positions", { id, positions: { dep: { x: "far", y: 0 } } })).status).toBe(400);

		await api("POST", "/api/worktrees/remove", { path: dep });
		const project = (await api<State>("GET", "/api/state")).projects[0];
		expect(project.links.some((x) => x.from === "dep" || x.to === "dep")).toBe(false);
		expect(project.positions).toEqual({});
		await api("PATCH", "/api/projects/positions", { id, positions: { work: { x: 1, y: 2 } } });
		await api("PATCH", "/api/projects/positions", { id, reset: true });
		expect((await api<State>("GET", "/api/state")).projects[0].positions).toEqual({});
	}, 60_000);

	test("A worktree made from another checkout's branch depends on it without a drawn link, which can't be removed", async () => {
		const id = (await api<State>("GET", "/api/state")).projects[0].id;
		const made = worktree("made", "-b", "made");
		run(["git", "-C", repo, "config", "branch.made.nestUnder", "work"]);
		expect(await checkout(made, (w) => w.base === "work")).toMatchObject({ dependsOn: ["work"] });
		expect((await api<State>("GET", "/api/state")).projects[0].links).toContainEqual({ from: "work", to: "made", madeFrom: true });
		const link = (from: string, to: string, linked: boolean) => call("PATCH", "/api/projects/links", { id, from, to, linked });
		expect((await link("work", "made", false)).status).toBe(409);
		expect(await link("made", "work", true)).toMatchObject({ status: 400, data: { error: "made already depends on work" } });
	}, 60_000);

	test("When a branch lands, the worktrees made from it move onto its base", async () => {
		const project = (await api<State>("GET", "/api/state")).projects[0].id;
		const parent = worktree("parent", "-b", "parent");
		run(["git", "-C", parent, "commit", "-q", "--allow-empty", "-m", "parent work"]);
		await checkout(parent);
		const child = await api<{ path: string }>("POST", "/api/worktrees/new", { project, branch: "child", after: "parent" });
		expect(await checkout(child.path)).toMatchObject({ base: "parent", column: "waiting" });
		run(["git", "-C", repo, "merge", "-q", "--no-ff", "-m", "Merge parent", "parent"]);
		await checkout(parent, (w) => w.column === "done");
		expect(await checkout(child.path, (w) => w.base === "main")).toMatchObject({ column: "idle", waitingFor: [] });
		expect(run(["git", "-C", repo, "config", "--get", "branch.child.nestUnder"])).toBe("main");
	}, 60_000);
});
