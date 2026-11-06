import { type Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// The board also looks for Beads in Homebrew's directories when they aren't on PATH.
const BD = Bun.which("bd", { PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` });
const CALLER = /^(CMUX_|TMUX|OMP_TERMINAL|KANBOARD_|WT_|OMP_CONTROL_)/;

type Task = { id: string; loop: string | null; control: unknown; worktree: string | null; spawn: { state: string; error: string | null }; flow: string };
type Flow = { id: string; controlLoops: { id: string }[] | null };

let dir = "";
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

const state = () => api<{ tasks: Task[]; flows: Flow[] }>("GET", "/api/state");

/** Starts a card and waits for its worktree; the board starts agents in its own process, so the test polls its state. */
async function start(id: string): Promise<Task & { worktree: string }> {
	await api("POST", `/api/tasks/${id}/move`, { column: "todo" });
	for (const deadline = Date.now() + 30_000; Date.now() < deadline; await Bun.sleep(100)) {
		const t = (await state()).tasks.find((x) => x.id === id)!;
		if (t.spawn.state === "failed") throw new Error(`${t.id} didn't start: ${t.spawn.error}`);
		if (t.spawn.state === "done" && t.worktree) return t as Task & { worktree: string };
	}
	throw new Error(`${id} didn't start in time`);
}

describe.skipIf(!BD)("a card's control loop", () => {
	let started: Task & { worktree: string };

	beforeAll(async () => {
		// /tmp, not the per-user temp directory: an agent host's socket path must stay under 104 bytes.
		dir = realpathSync(mkdtempSync("/tmp/orchestrator-control-"));
		for (const sub of ["bin", "home", "board", "repo"]) mkdirSync(join(dir, sub));
		writeFileSync(join(dir, "bin", "omp"), "#!/bin/sh\nexec sleep 600\n");
		chmodSync(join(dir, "bin", "omp"), 0o755);
		writeFileSync(join(dir, "home", ".gitconfig"), "[user]\n\tname = Control\n\temail = control@example.com\n");
		env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !CALLER.test(k))) as Record<string, string>;
		const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		port = probe.port;
		probe.stop(true);
		Object.assign(env, {
			HOME: join(dir, "home"), PATH: `${join(dir, "bin")}:${process.env.PATH}`, PYTHONDONTWRITEBYTECODE: "1",
			KANBOARD_HOME: join(dir, "board"), KANBOARD_PORT: String(port), KANBOARD_REPO: join(dir, "repo"),
		});
		run(["git", "init", "-q", "-b", "main"], join(dir, "repo"));
		run(["git", "commit", "-q", "--allow-empty", "-m", "init"], join(dir, "repo"));
		writeFileSync(join(dir, "board", "config.json"), JSON.stringify({ commands: {} }));
		run(["python3", "server.py", "--prepare"], ROOT);
		server = Bun.spawn(["python3", "server.py"], { cwd: ROOT, env, stdout: "ignore", stderr: "ignore" });
		for (const deadline = Date.now() + 20_000; Date.now() < deadline; await Bun.sleep(100)) {
			if (await api("GET", "/api/state").then(() => true, () => false)) break;
		}
		const created = await api<Task>("POST", "/api/tasks", { title: "Looped work", merge: "local", loop: "review" });
		expect(created.loop).toBe("review");
		started = await start(created.id);
	}, 90_000);

	afterAll(() => {
		server?.kill();
		Bun.spawnSync(["pkill", "-f", join(dir, "board", "hosts")]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("a card keeps a valid loop id, refuses an invalid one, and fixes it once started", async () => {
		expect((await call("POST", "/api/tasks", { title: "Bad loop", loop: "Not An Id" })).status).toBe(400);
		const other = await api<Task>("POST", "/api/tasks", { title: "Later loop" });
		expect((await api<Task>("PATCH", `/api/tasks/${other.id}`, { loop: "quality" })).loop).toBe("quality");
		expect((await api<Task>("PATCH", `/api/tasks/${other.id}`, { loop: "" })).loop).toBeNull();
		const patched = await call("PATCH", `/api/tasks/${started.id}`, { loop: "quality" });
		expect(patched).toMatchObject({ status: 409, data: { error: "Control loop is fixed once the task starts" } });
	});

	test("the task session starts with the card's loop and base", () => {
		const script = readFileSync(join(dir, "board", "tasks", started.id, "launch.sh"), "utf8");
		expect(script).toContain("OMP_CONTROL_LOOP=review");
		expect(script).toContain("OMP_CONTROL_BASE=main");
	});

	test("a session inside the worktree reports the live view; one elsewhere can't", async () => {
		const view = { version: 1, status: "checking", loop: { id: "review", name: "Review", description: "", maxPasses: 4, stages: [] } };
		await api("POST", `/api/tasks/${started.id}/control`, { path: join(started.worktree, "src"), view });
		expect((await state()).tasks.find((t) => t.id === started.id)?.control).toEqual(view);
		expect((await call("POST", `/api/tasks/${started.id}/control`, { path: join(dir, "repo"), view })).status).toBe(404);
		expect((await call("POST", `/api/tasks/${started.id}/control`, { path: started.worktree, view: { version: 2 } })).status).toBe(400);
	});

	test("a flow records the loops its omp offers", async () => {
		const loops = [{ id: "review", name: "Review", description: "", maxPasses: 4, source: "built-in", stages: [{ nodes: [{ id: "quality-reviewer", name: "Quality reviewer", kind: "review" }] }] }];
		await api("PATCH", "/api/flows/control-loops", { id: started.flow, loops });
		expect((await state()).flows.find((f) => f.id === started.flow)?.controlLoops).toEqual(loops);
		expect((await call("PATCH", "/api/flows/control-loops", { id: started.flow, loops: [{ id: "Bad" }] })).status).toBe(400);
	});

	test("the board's decisions reach the task session and come back with its answer", async () => {
		const ctl = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}/api/events?session=s&task=${started.id}`, { signal: ctl.signal });
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let text = "";
		const nextControl = async (): Promise<{ id: string; action: string; decisions: unknown; pause: boolean }> => {
			for (;;) {
				const match = /event: control\ndata: (.*)\n/.exec(text);
				if (match) return JSON.parse(match[1]);
				text += decoder.decode((await reader.read()).value);
			}
		};
		// The board registers the session's stream before its first event; decisions are refused until then.
		while (!text) text += decoder.decode((await reader.read()).value);
		const decided = call("POST", `/api/tasks/${started.id}/control/decide`, { decisions: { "1.1": { decision: "fix", note: "small" } }, pause: false });
		const command = await nextControl();
		expect(command).toMatchObject({ action: "control_decide", decisions: { "1.1": { decision: "fix", note: "small" } }, pause: false });
		await api("POST", `/api/control/${command.id}`, { ok: true, message: "Recorded" });
		expect(await decided).toEqual({ status: 200, data: { ok: true, message: "Recorded" } });
		expect((await call("POST", `/api/tasks/${started.id}/control/decide`, { decisions: {} })).status).toBe(400);
		ctl.abort();
	});
});
