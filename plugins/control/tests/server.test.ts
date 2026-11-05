import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, RunView } from "omp-control-view/protocol";
import { type ControlHooks, type ControlServer, type StatePayload, startControlServer } from "../src/server";

let dir: string;
let server: ControlServer;
let base: string;
const decided: [Record<string, Decision>, boolean][] = [];
const sent: string[] = [];
let payload: StatePayload = {
	session: { name: "omp", cwd: "/repo", repo: "/repo", idle: true },
	attached: null,
	run: null,
	library: { loops: [], nodes: [], errors: [] },
};

const hooks: ControlHooks = {
	state: async () => payload,
	attach: async () => {},
	setSessionLoop: async () => {},
	saveLoop: async () => [],
	saveNode: async () => "",
	deleteItem: async () => {},
	copyItem: async () => "",
	changes: async () => [],
	diff: async () => "",
	decide: (decisions, pause) => {
		decided.push([decisions, pause]);
		return { ok: true, message: "Recorded" };
	},
	send: (text) => sent.push(text),
	setPaused: () => {},
};

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "control-server-"));
	server = startControlServer(hooks, { ports: [], stateDir: dir });
	base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
	server.stop();
	await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) => fetch(`${base}${path}?token=${server.token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("the API needs the token", async () => {
	expect((await fetch(`${base}/api/state`)).status).toBe(403);
	expect((await fetch(`${base}/api/state?token=nope`)).status).toBe(403);
	expect((await fetch(`${base}/appearance.css`)).status).toBe(403);
});

test("state comes from the hooks; decisions reach them; writes need JSON", async () => {
	expect(await (await fetch(`${base}/api/state?token=${server.token}`)).json()).toEqual(payload);
	const res = await post("/api/decide", { decisions: { "1.1": { decision: "fix", note: "small" } }, pause: false });
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ ok: true, message: "Recorded" });
	expect(decided).toEqual([[{ "1.1": { decision: "fix", note: "small" } }, false]]);
	expect((await post("/api/decide", { decisions: { "1.1": { decision: "maybe" } } })).status).toBe(400);
	expect((await fetch(`${base}/api/pause?token=${server.token}`, { method: "POST", body: "{}" })).status).toBe(415);
	expect((await post("/api/draft", { intent: "no console.log", scope: "repo" })).status).toBe(200);
	expect(sent.at(-1)).toStartWith('Help me create a Control node for this project: no console.log. Decide whether');
});

test("artifacts are served only when the current run lists them", async () => {
	const shot = join(dir, "screen.png");
	await writeFile(shot, "png");
	await writeFile(join(dir, "secret.png"), "secret");
	const before = payload;
	payload = { ...payload, run: { nodes: { screens: { artifacts: [shot] } } } as unknown as RunView };
	try {
		const ok = await fetch(`${base}/api/artifact?path=${encodeURIComponent(shot)}&token=${server.token}`);
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe("png");
		expect((await fetch(`${base}/api/artifact?path=${encodeURIComponent(join(dir, "secret.png"))}&token=${server.token}`)).status).toBe(404);
		expect((await fetch(`${base}/api/artifact?path=${encodeURIComponent(shot)}`)).status).toBe(403);
	} finally {
		payload = before;
	}
});

test("the event stream sends the state on connect and after notify", async () => {
	const ctl = new AbortController();
	const res = await fetch(`${base}/api/events?token=${server.token}`, { signal: ctl.signal });
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const next = async (marker: string) => {
		while (!text.includes(marker)) text += decoder.decode((await reader.read()).value);
	};
	await next('"name":"omp"');
	payload = { ...payload, session: { ...payload.session, name: "renamed" } };
	server.notify();
	await next('"name":"renamed"');
	expect(text).toContain("event: state\ndata: ");
	ctl.abort();
});

test("static files stay inside the web folder", async () => {
	expect((await fetch(`${base}/..%2Fpackage.json`)).status).toBe(404);
	expect((await fetch(`${base}/missing.js`)).status).toBe(404);
});
