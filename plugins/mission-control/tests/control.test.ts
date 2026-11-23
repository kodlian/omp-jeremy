import { type Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const EXTRA_PATH = `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`;
// The board also looks for tmux in Homebrew's directories when it isn't on PATH.
const TMUX = Bun.which("tmux", { PATH: EXTRA_PATH });
const CALLER = /^(CMUX_|TMUX|OMP_TERMINAL|MISSION_CONTROL_|WT_|OMP_CONTROL_)/;

type Task = { id: string; controlSet: string | null; worktree: string | null; spawn: { state: string; error: string | null }; project: string };
type Project = { id: string; repo: string; controlSets: { id: string }[] | null };

let dir = "";
let label = "";
let port = 0;
let env: Record<string, string> = {};
let server: Subprocess | undefined;

function run(cmd: string[], cwd = dir): string {
	const p = Bun.spawnSync(cmd, { cwd, env });
	if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
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
	const r = await call(method, path, body);
	if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
	return r.data as T;
}

const state = () => api<{ tasks: Task[]; projects: Project[] }>("GET", "/api/state");

/** Creates a task, which starts at once, and waits for its worktree; the board starts agents in its own process, so the
 * test polls its state. */
async function start(prompt: string, controlSet: string): Promise<Task & { worktree: string }> {
	const created = await api<Task>("POST", "/api/tasks", { prompt, repo: join(dir, "repo"), controlSet });
	expect(created.controlSet).toBe(controlSet);
	for (const deadline = Date.now() + 30_000; Date.now() < deadline; await Bun.sleep(100)) {
		const t = (await state()).tasks.find((x) => x.id === created.id)!;
		if (t.spawn.state === "failed") throw new Error(`${t.id} didn't start: ${t.spawn.error}`);
		if (t.spawn.state === "done" && t.worktree) return t as Task & { worktree: string };
	}
	throw new Error(`${created.id} didn't start in time`);
}

describe.skipIf(!TMUX)("a task's control set", () => {
	let started: Task & { worktree: string };

	beforeAll(async () => {
		dir = realpathSync(mkdtempSync("/tmp/mission-control-control-"));
		label = `mc-test-${basename(dir)}`;
		for (const sub of ["bin", "home", "board", "repo", "leases"]) mkdirSync(join(dir, sub));
		copyFileSync(join(import.meta.dir, "fake_omp.py"), join(dir, "bin", "omp"));
		chmodSync(join(dir, "bin", "omp"), 0o755);
		writeFileSync(join(dir, "home", ".gitconfig"), "[user]\n\tname = Control\n\temail = control@example.com\n");
		env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !CALLER.test(k))) as Record<string, string>;
		const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		port = probe.port;
		probe.stop(true);
		Object.assign(env, {
			HOME: join(dir, "home"), PATH: `${join(dir, "bin")}:${EXTRA_PATH}`, PYTHONDONTWRITEBYTECODE: "1",
			MISSION_CONTROL_HOME: join(dir, "board"), MISSION_CONTROL_PORT: String(port),
			MISSION_CONTROL_TMUX_LABEL: label, MISSION_CONTROL_LEASE_DIR: join(dir, "leases"),
		});
		run(["git", "init", "-q", "-b", "main"], join(dir, "repo"));
		run(["git", "commit", "-q", "--allow-empty", "-m", "init"], join(dir, "repo"));
		writeFileSync(join(dir, "board", "config.json"), JSON.stringify({ commands: {} }));
		run(["python3", "server.py", "--prepare"], ROOT);
		server = Bun.spawn(["python3", "server.py"], { cwd: ROOT, env, stdout: "ignore", stderr: "ignore" });
		for (const deadline = Date.now() + 20_000; Date.now() < deadline; await Bun.sleep(100)) {
			if (await api("GET", "/api/state").then(() => true, () => false)) break;
		}
		started = await start("Controlled work", "review");
	}, 90_000);

	afterAll(() => {
		server?.kill();
		Bun.spawnSync([TMUX!, "-L", label, "kill-server"], { env });
		rmSync(dir, { recursive: true, force: true });
	});

	test("a task keeps a valid control set, refuses an invalid one, and fixes it once it exists", async () => {
		expect((await call("POST", "/api/tasks", { prompt: "Bad set", repo: join(dir, "repo"), controlSet: "Not An Id" })).status).toBe(400);
		const patched = await call("PATCH", `/api/tasks/${started.id}`, { controlSet: "quality" });
		expect(patched).toMatchObject({ status: 409, data: { error: "The control set is fixed once the task starts" } });
	});

	test("the task session starts with the card's control set and base", () => {
		const script = readFileSync(join(dir, "board", "tasks", started.id, "launch.sh"), "utf8");
		expect(script).toContain("OMP_CONTROL_SET=review");
		expect(script).toContain("OMP_CONTROL_BASE=main");
	});

	test("a project records the control sets its omp offers", async () => {
		const registered = await api<{ project: Project }>("POST", "/api/projects", { path: started.worktree });
		expect(registered.project).toMatchObject({ id: started.project, repo: join(dir, "repo") });
		const sets = [{ id: "review", name: "Review", description: "", controls: ["Quality"], approval: "apply" }];
		await api("PATCH", "/api/projects/control-sets", { id: started.project, sets });
		expect((await state()).projects.find((p) => p.id === started.project)?.controlSets).toEqual(sets);
		expect((await call("PATCH", "/api/projects/control-sets", { id: started.project, sets: [{ id: "Bad" }] })).status).toBe(400);
	});
});
