import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git";
import { type ReviewServer, startReviewServer } from "../src/server";
import { ReviewStore } from "../src/store";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup.splice(0)) fn();
});

async function setup({ repo = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), "gdr-srv-"));
	const stateDir = mkdtempSync(join(tmpdir(), "gdr-state-"));
	if (repo) await git(root, ["init", "-q", "-b", "main"]);
	writeFileSync(join(root, "a.txt"), "a\n");
	const sent: string[] = [];
	const pasted: string[] = [];
	const pasteReceived = Promise.withResolvers<void>();
	const hooks = {
		send: (t: string) => sent.push(t),
		paste: (t: string) => {
			pasted.push(t);
			pasteReceived.resolve();
		},
		sessionName: () => "sess",
	};
	const server = startReviewServer(root, hooks, { store: new ReviewStore(stateDir), ports: [] });
	cleanup.push(() => {
		server.stop();
		rmSync(root, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	});
	return { root, stateDir, server, sent, pasted, pasteReceived: pasteReceived.promise };
}

function client(server: ReviewServer) {
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${server.token}`);
	const inbox: unknown[] = [];
	const waiters: ((m: unknown) => void)[] = [];
	ws.onmessage = (e) => {
		const msg: unknown = JSON.parse(String(e.data));
		const waiter = waiters.shift();
		if (waiter) waiter(msg);
		else inbox.push(msg);
	};
	const next = () => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		if (inbox.length) resolve(inbox.shift());
		else waiters.push(resolve);
		return promise;
	};
	const { promise: opened, resolve } = Promise.withResolvers<unknown>();
	ws.onopen = resolve;
	cleanup.unshift(() => ws.close());
	return { ws, next, opened };
}

test("api requires the session token", async () => {
	const { server } = await setup();
	const base = `http://127.0.0.1:${server.port}`;
	expect((await fetch(`${base}/api/review`)).status).toBe(403);
	expect((await fetch(`${base}/api/review?token=nope`)).status).toBe(403);
	const ok = await fetch(`${base}/api/review?token=${server.token}`);
	expect(ok.status).toBe(200);
	expect((await ok.json()).files.map((f: { path: string }) => f.path)).toEqual(["a.txt"]);
	expect((await fetch(`${base}/ws?token=nope`)).status).toBe(403);
});

test("terminal font access requires the token and cannot select arbitrary files", async () => {
	const { server } = await setup();
	const base = `http://127.0.0.1:${server.port}`;
	server.setAppearance({
		scheme: "dark",
		vars: {},
		font: { id: "fira", family: "Fira Code", postscriptName: "FiraCode-Regular", path: join(import.meta.dir, "../web/fonts/FiraCode-VF.woff2") },
	});
	expect((await fetch(`${base}/appearance.css`)).status).toBe(403);
	expect(await (await fetch(base)).text()).not.toContain(server.token);
	expect((await fetch(`${base}/api/font?id=fira`)).status).toBe(403);
	expect((await fetch(`${base}/api/font?token=nope&id=fira`)).status).toBe(403);
	expect((await fetch(`${base}/api/font?token=${server.token}&id=/etc/passwd`)).status).toBe(404);
	const font = await fetch(`${base}/api/font?token=${server.token}&id=fira`);
	expect(font.status).toBe(200);
	expect(font.headers.get("Content-Type")).toBe("font/woff2");
	server.setAppearance({ scheme: "dark", vars: {} });
	expect((await fetch(`${base}/api/font?token=${server.token}&id=fira`)).status).toBe(404);
});

test("a plain folder reports notRepo until init, then lists every file", async () => {
	const { server } = await setup({ repo: false });
	const review = () => fetch(`http://127.0.0.1:${server.port}/api/review?token=${server.token}`).then((r) => r.json());
	expect(await review()).toMatchObject({ notRepo: true, files: [] });
	const c = client(server);
	await c.opened;
	await c.next();
	c.ws.send(JSON.stringify({ type: "init" }));
	expect(await c.next()).toEqual({ type: "changed" });
	const after = await review();
	expect(after.notRepo).toBeUndefined();
	expect(after.files.map((f: { path: string; status: string }) => [f.path, f.status])).toEqual([["a.txt", "?"]]);
});

test("static files cannot escape the web directory", async () => {
	const { server } = await setup();
	const res = await fetch(`http://127.0.0.1:${server.port}/..%2Fpackage.json`);
	expect(res.status).toBe(404);
});

test("pins sync to other tabs, persist, and send reaches the agent", async () => {
	const { root, stateDir, server, sent, pasted, pasteReceived } = await setup();
	const a = client(server);
	const b = client(server);
	await Promise.all([a.opened, b.opened]);
	expect(await a.next()).toMatchObject({ type: "hello", root, session: "sess", pins: [], viewed: {} });
	await b.next();

	const pin = { id: "p1", path: "a.txt", startLine: 1, endLine: 1, hasNew: true, deletedOld: [], note: "fix", side: "worktree", snippet: "a", createdAt: 1 };
	a.ws.send(JSON.stringify({ type: "pins", pins: [pin] }));
	expect(await b.next()).toMatchObject({ type: "state", pins: [pin] });
	expect(new ReviewStore(stateDir).get(root).pins).toEqual([pin]);

	a.ws.send(JSON.stringify({ type: "send", text: "review text" }));
	a.ws.send(JSON.stringify({ type: "paste", text: "@a.txt#L1 " }));
	a.ws.send(JSON.stringify({ type: "send", text: "   " }));
	await pasteReceived;
	server.notifyChanged();
	expect(await b.next()).toEqual({ type: "changed" });
	expect(sent).toEqual(["review text"]);
	expect(pasted).toEqual(["@a.txt#L1 "]);
});
