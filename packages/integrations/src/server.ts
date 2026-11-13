import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { Server, WebSocketHandler } from "bun";
import { type Appearance, appearanceCss } from "./appearance";
import type { LocalFont } from "./fonts";
import { errorText } from "./text";

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".woff2": "font/woff2",
};

/** Ten ports from base: a plugin's page keeps its port across restarts when one is free. */
export const portRange = (base: number): number[] => Array.from({ length: 10 }, (_, i) => base + i);

export function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** An API failure with its HTTP status. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export interface PageOptions {
	/** Prefixes the error when no port binds: "control", "git-diff-review", "plan-review". */
	name: string;
	/** The plugin's web folder: index.html, its bundle and stylesheets. */
	webDir: string;
	/** Holds the token every server of the plugin shares, so an open tab reconnects after omp restarts. */
	stateDir: string;
	ports: number[];
	/** Serves the terminal's font to the page; without it the appearance stylesheet names no font. */
	fonts?: boolean;
	idleTimeout?: number;
	/** The plugin's routes under /api/, called only for requests carrying the token. */
	api(req: Request, url: URL): Response | Promise<Response>;
	/** The page's socket at /ws, opened only with the token. */
	websocket?: WebSocketHandler<undefined>;
	/** The appearance stylesheet changed: tell the open pages to reload it. */
	onAppearance(): void;
}

export interface PageServer {
	readonly port: number;
	readonly token: string;
	/** Bun's server, for publishing to the page's sockets. */
	readonly server: Server<undefined>;
	/** The page's address, token included. */
	url(): string;
	setAppearance(appearance: Appearance | null): void;
	stop(): void;
}

function storedToken(dir: string): string {
	const file = join(dir, "token");
	try {
		const token = readFileSync(file, "utf8").trim();
		if (token) return token;
	} catch {}
	const token = randomBytes(16).toString("hex");
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, token, { mode: 0o600 });
	return token;
}

async function serveStatic(webDir: string, pathname: string, token: string): Promise<Response> {
	const file = resolve(webDir, `.${pathname === "/" ? "/index.html" : pathname}`);
	const type = CONTENT_TYPES[extname(file)];
	if (!type || !file.startsWith(webDir + sep)) return new Response("Not found", { status: 404 });
	if (!(await Bun.file(file).exists())) return new Response("Not found", { status: 404 });
	const headers = { "Content-Type": type, "Cache-Control": "no-store" };
	if (type.startsWith("text/html")) {
		const html = await Bun.file(file).text();
		return new Response(html.replace('href="/appearance.css"', `href="/appearance.css?token=${token}"`), { headers });
	}
	return new Response(Bun.file(file), { headers });
}

/** A plugin's local page: token-guarded static files, API, socket, and the stylesheet that follows omp's theme. */
export function startPageServer(options: PageOptions): PageServer {
	const token = storedToken(options.stateDir);
	const expected = Buffer.from(token);
	let css = "";
	let font: LocalFont | undefined;

	const authorized = (url: URL) => {
		const given = Buffer.from(url.searchParams.get("token") ?? "");
		return given.length === expected.length && timingSafeEqual(given, expected);
	};

	async function fetch(req: Request, srv: Server<undefined>): Promise<Response | undefined> {
		const url = new URL(req.url);
		const ok = authorized(url);
		if (url.pathname === "/ws") {
			if (options.websocket && ok && srv.upgrade(req, { data: undefined })) return undefined;
			return new Response("Forbidden", { status: 403 });
		}
		if (options.fonts && url.pathname === "/api/font") {
			if (!ok) return new Response("Forbidden", { status: 403 });
			if (!font || url.searchParams.get("id") !== font.id) return new Response("Not found", { status: 404 });
			return new Response(Bun.file(font.path), { headers: { "Cache-Control": "no-store" } });
		}
		if (url.pathname.startsWith("/api/")) {
			if (!ok) return json({ error: "forbidden" }, 403);
			try {
				return await options.api(req, url);
			} catch (e) {
				return json({ error: errorText(e) }, e instanceof HttpError ? e.status : 500);
			}
		}
		if (url.pathname === "/appearance.css") {
			if (!ok) return new Response("Forbidden", { status: 403 });
			return new Response(css, { headers: { "Content-Type": CONTENT_TYPES[".css"], "Cache-Control": "no-store" } });
		}
		return serveStatic(options.webDir, url.pathname, ok ? token : "");
	}

	let server: Server<undefined> | null = null;
	for (const port of [...options.ports, 0]) {
		try {
			server = options.websocket
				? Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: options.idleTimeout, fetch, websocket: options.websocket })
				: Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: options.idleTimeout, fetch });
			break;
		} catch {}
	}
	if (!server) throw new Error(`${options.name}: could not bind a local port`);
	const srv = server;

	return {
		port: srv.port as number,
		token,
		server: srv,
		url: () => `http://127.0.0.1:${srv.port}/?token=${token}`,
		setAppearance(appearance) {
			font = options.fonts ? appearance?.font : undefined;
			const next = appearance ? (options.fonts ? appearanceCss(appearance, `/api/font?token=${token}&id=${font?.id}`) : appearanceCss({ ...appearance, font: undefined })) : "";
			if (next === css) return;
			css = next;
			options.onAppearance();
		},
		stop() {
			srv.stop(true);
		},
	};
}
