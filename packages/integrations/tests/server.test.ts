import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError, type PageOptions, type PageServer, startPageServer } from "../src/server";

const appearance = { scheme: "dark" as const, vars: { "--accent": "#ff8800" } };
const running: PageServer[] = [];

afterEach(() => {
	for (const server of running.splice(0)) server.stop();
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "page-server-"));
	const webDir = join(root, "web");
	mkdirSync(webDir);
	writeFileSync(join(webDir, "index.html"), '<link id="appearance" rel="stylesheet" href="/appearance.css">');
	writeFileSync(join(root, "secret.js"), "secret");
	return { webDir, stateDir: join(root, "state") };
}

function start(options: Partial<PageOptions> & Pick<PageOptions, "webDir" | "stateDir">) {
	const server = startPageServer({ name: "test", ports: [], api: () => Response.json({ ok: true }), onAppearance: () => {}, ...options });
	running.push(server);
	return server;
}

const get = (server: PageServer, path: string) => fetch(`http://127.0.0.1:${server.port}${path}`);

test("the page carries its token into the appearance stylesheet link", async () => {
	const server = start(setup());
	const html = await (await get(server, `/?token=${server.token}`)).text();
	expect(html).toContain(`href="/appearance.css?token=${server.token}"`);
});

test("API routes run only with the token, and failures answer with their status", async () => {
	let calls = 0;
	let fail: Error | null = null;
	const server = start({
		...setup(),
		api: () => {
			calls++;
			if (fail) throw fail;
			return Response.json({ ok: true });
		},
	});
	expect((await get(server, "/api/x")).status).toBe(403);
	expect(calls).toBe(0);
	expect(await (await get(server, `/api/x?token=${server.token}`)).json()).toEqual({ ok: true });
	fail = new HttpError(409, "busy");
	const busy = await get(server, `/api/x?token=${server.token}`);
	expect([busy.status, await busy.json()]).toEqual([409, { error: "busy" }]);
	fail = new Error("boom");
	const boom = await get(server, `/api/x?token=${server.token}`);
	expect([boom.status, await boom.json()]).toEqual([500, { error: "boom" }]);
});

test("files outside the web folder and missing files are not found", async () => {
	const server = start(setup());
	expect((await get(server, "/../secret.js")).status).toBe(404);
	expect((await get(server, "/%2e%2e/secret.js")).status).toBe(404);
	expect((await get(server, "/missing.js")).status).toBe(404);
});

test("without fonts, /api/font is the plugin's own route", async () => {
	const seen: string[] = [];
	const server = start({
		...setup(),
		api: (_req, url) => {
			seen.push(url.pathname);
			return Response.json({ ok: true });
		},
	});
	expect((await get(server, `/api/font?token=${server.token}&id=x`)).status).toBe(200);
	expect(seen).toEqual(["/api/font"]);
});

test("a changed appearance tells the pages once and serves the new stylesheet", async () => {
	let told = 0;
	const server = start({ ...setup(), onAppearance: () => told++ });
	server.setAppearance(appearance);
	expect(told).toBe(1);
	expect(await (await get(server, `/appearance.css?token=${server.token}`)).text()).toContain("--accent: #ff8800");
	server.setAppearance(appearance);
	expect(told).toBe(1);
});

test("servers of one plugin share the token, and a taken port falls through to another", () => {
	const dirs = setup();
	const first = start(dirs);
	const second = start({ ...dirs, ports: [first.port] });
	expect(second.token).toBe(first.token);
	expect(second.port).not.toBe(first.port);
});
