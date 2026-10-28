import { type FSWatcher, watch } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { LocalFont } from "omp-integrations/fonts";
import type { Appearance } from "./appearance";
import { appearanceCss } from "./appearance";
import { type Compare, fileLines, gitDir, initRepo, isRepo, listBranches, listCommits, loadReview, resolveInRoot } from "./git";
import { openIn, openTargets } from "./open-in";
import { PROTOCOL } from "./shared/protocol.js";
import { ReviewStore } from "./store";

const WEB_DIR = resolve(import.meta.dir, "..", "web");
export const DEFAULT_PORTS = Array.from({ length: 10 }, (_, i) => 9890 + i);
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".woff2": "font/woff2",
};

export interface ReviewHooks {
	send(text: string): void;
	paste(text: string): void;
	sessionName(): string;
}

export interface ReviewServer {
	readonly port: number;
	readonly token: string;
	readonly root: string;
	url(compare: Compare): string;
	setRoot(root: string): void;
	setAppearance(appearance: Appearance | null): void;
	notifyChanged(): void;
	stop(): void;
}

export function parseCompare(params: URLSearchParams): Compare {
	const kind = params.get("kind");
	if (kind === "branch") return { kind, base: params.get("base") || null };
	if (kind === "commit") return { kind, sha: params.get("sha") || null };
	return { kind: "uncommitted" };
}

function compareQuery(compare: Compare): string {
	if (compare.kind === "branch") return compare.base ? `&kind=branch&base=${encodeURIComponent(compare.base)}` : "&kind=branch";
	if (compare.kind === "commit") return compare.sha ? `&kind=commit&sha=${encodeURIComponent(compare.sha)}` : "&kind=commit";
	return "";
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function serveStatic(pathname: string, token: string): Promise<Response> {
	const file = resolve(WEB_DIR, `.${pathname === "/" ? "/index.html" : pathname}`);
	const type = CONTENT_TYPES[extname(file)];
	if (!type || !file.startsWith(WEB_DIR + sep)) return new Response("Not found", { status: 404 });
	const headers = { "Content-Type": type, "Cache-Control": "no-store" };
	if (type.startsWith("text/html")) {
		const html = await Bun.file(file).text();
		return new Response(html.replace('href="/appearance.css"', `href="/appearance.css?token=${token}"`), { headers });
	}
	return new Response(Bun.file(file), { headers });
}

export function startReviewServer(initialRoot: string, hooks: ReviewHooks, { store = new ReviewStore(), ports = DEFAULT_PORTS } = {}): ReviewServer {
	const token = store.token();
	let root = initialRoot;
	let watcher: FSWatcher | null = null;
	let changeTimer: Timer | undefined;
	let themeCss = "";
	let font: LocalFont | undefined;

	const notifyChanged = () => server?.publish("review", JSON.stringify({ type: "changed" }));

	async function watchGit() {
		const watched = root;
		const dir = await gitDir(watched).catch(() => null);
		if (watched !== root) return;
		watcher?.close();
		watcher = null;
		if (!dir) return;
		try {
			watcher = watch(dir, { persistent: false }, () => {
				clearTimeout(changeTimer);
				changeTimer = setTimeout(notifyChanged, 250);
			});
		} catch {}
	}

	const hello = () => JSON.stringify({ type: "hello", protocol: PROTOCOL, root, name: basename(root), session: hooks.sessionName(), ...store.get(root) });

	async function api(pathname: string, params: URLSearchParams): Promise<Response> {
		try {
			switch (pathname) {
				case "/api/review":
					if (!(await isRepo(root))) return json({ files: [], branch: null, base: null, commit: null, notRepo: true });
					return json(await loadReview(root, parseCompare(params), { ignoreWhitespace: params.get("ws") === "1" }));
				case "/api/branches":
					return json(await listBranches(root));
				case "/api/commits":
					return json(await listCommits(root));
				case "/api/lines":
					return json(await fileLines(root, parseCompare(params), params.get("path") ?? ""));
				case "/api/open-targets":
					return json(await openTargets());
				case "/api/open": {
					const line = Number(params.get("line"));
					await openIn(params.get("target") ?? "default", resolveInRoot(root, params.get("path") ?? ""), line > 0 ? line : null);
					return json({ ok: true });
				}
				default:
					return json({ error: "not found" }, 404);
			}
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : String(error) }, 500);
		}
	}

	function onMessage(ws: ServerWebSocket<unknown>, raw: string | Buffer) {
		let msg: { type?: string; pins?: unknown; viewed?: unknown; text?: unknown };
		try {
			msg = JSON.parse(String(raw));
		} catch {
			return;
		}
		if (msg.type === "pins" && Array.isArray(msg.pins)) {
			ws.publish("review", JSON.stringify({ type: "state", ...store.update(root, { pins: msg.pins }) }));
		} else if (msg.type === "viewed" && msg.viewed && typeof msg.viewed === "object") {
			ws.publish("review", JSON.stringify({ type: "state", ...store.update(root, { viewed: msg.viewed as Record<string, string> }) }));
		} else if (msg.type === "send" && typeof msg.text === "string" && msg.text.trim()) {
			hooks.send(msg.text);
		} else if (msg.type === "paste" && typeof msg.text === "string" && msg.text) {
			hooks.paste(msg.text);
		} else if (msg.type === "init") {
			isRepo(root)
				.then((repo) => repo || initRepo(root))
				.then(() => {
					notifyChanged();
					return watchGit();
				})
				.catch((error) => ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })));
		}
	}

	let server: Server | null = null;
	for (const port of [...ports, 0]) {
		try {
			server = Bun.serve({
				hostname: "127.0.0.1",
				port,
				fetch(req, srv) {
					const url = new URL(req.url);
					const authorized = url.searchParams.get("token") === token;
					if (url.pathname === "/ws") {
						if (authorized && srv.upgrade(req, { data: null })) return undefined;
						return new Response("Forbidden", { status: 403 });
					}
					if (url.pathname === "/api/font") {
						if (!authorized) return new Response("Forbidden", { status: 403 });
						if (!font || url.searchParams.get("id") !== font.id) return new Response("Not found", { status: 404 });
						return new Response(Bun.file(font.path), { headers: { "Cache-Control": "no-store" } });
					}
					if (url.pathname.startsWith("/api/")) {
						return authorized ? api(url.pathname, url.searchParams) : json({ error: "forbidden" }, 403);
					}
					if (url.pathname === "/appearance.css") {
						if (!authorized) return new Response("Forbidden", { status: 403 });
						return new Response(themeCss, { headers: { "Content-Type": CONTENT_TYPES[".css"], "Cache-Control": "no-store" } });
					}
					return serveStatic(url.pathname, authorized ? token : "");
				},
				websocket: {
					open(ws) {
						ws.subscribe("review");
						ws.send(hello());
					},
					message: onMessage,
				},
			});
			break;
		} catch {}
	}
	if (!server) throw new Error("git-diff-review: could not bind a local port");
	const srv = server;
	void watchGit();

	return {
		port: srv.port as number,
		token,
		get root() {
			return root;
		},
		url: (compare) => `http://127.0.0.1:${srv.port}/?token=${token}${compareQuery(compare)}`,
		setRoot(next) {
			if (next === root) return;
			root = next;
			srv.publish("review", hello());
			void watchGit();
		},
		setAppearance(appearance) {
			font = appearance?.font;
			const next = appearance ? appearanceCss(appearance, `/api/font?token=${token}&id=${font?.id}`) : "";
			if (next === themeCss) return;
			themeCss = next;
			srv.publish("review", JSON.stringify({ type: "appearance" }));
		},
		notifyChanged,
		stop() {
			watcher?.close();
			clearTimeout(changeTimer);
			srv.stop(true);
		},
	};
}
