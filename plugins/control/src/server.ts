import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Appearance } from "omp-integrations/appearance";
import { HttpError, json, portRange, startPageServer } from "omp-integrations/server";
import { errorText } from "omp-integrations/text";
import type { ControlReply, Decision, RunView, Scope, Source } from "omp-control-view/protocol";
import type { ChangedFile } from "./git";
import { type LoopDefinition, type LoopSnapshot, loopFrom, type NodeDefinition, nodeFrom, validateSnapshot } from "./library";
import { draftPrompt } from "./prompts";

const WEB_DIR = resolve(dirname(realpathSync(import.meta.path)), "..", "web");
export const DEFAULT_PORTS = portRange(9880);
const STATE_DIR = join(homedir(), ".omp", "cache", "control");
const PING_MS = 15_000;

export interface StatePayload {
	session: { name: string; cwd: string; repo: string | null; idle: boolean };
	/** since: what the loop checks, in words ("since main · 3 commits and uncommitted changes"). */
	attached: { loop: LoopSnapshot; source: string; since: string } | null;
	run: RunView | null;
	/** git-diff-review is loaded in this omp, so the page can open the change there. */
	review: boolean;
	library: {
		loops: (LoopDefinition & { source: Source; path: string; overrides: Source[] })[];
		nodes: (NodeDefinition & { source: Source; path: string; overrides: Source[] })[];
		errors: { path: string; message: string }[];
	};
}

export interface ControlHooks {
	state(): Promise<StatePayload>;
	attach(id: string | null): Promise<void>;
	setSessionLoop(loop: LoopSnapshot): Promise<void>;
	saveLoop(scope: Scope, loop: LoopDefinition, nodes: NodeDefinition[]): Promise<string[]>;
	saveNode(scope: Scope, node: NodeDefinition): Promise<string>;
	deleteItem(kind: "node" | "loop", scope: Scope, id: string): Promise<void>;
	copyItem(kind: "node" | "loop", id: string, to: Scope, move: boolean): Promise<string>;
	/** The files the attached loop's change touches, for the page's summary of it. */
	changes(): Promise<ChangedFile[]>;
	/** Opens the attached loop's change in git-diff-review. */
	review(): Promise<void>;
	decide(decisions: Record<string, Decision>, pause: boolean): ControlReply;
	send(text: string): void;
	/** Runs the loop on the current code now, even when it already passed. */
	check(): void;
	/** Measures the loop from a branch or commit and checks the code since; returns the new "since" text. */
	since(ref: string): Promise<string>;
	setPaused(paused: boolean): void;
}

export interface ControlServer {
	readonly port: number;
	readonly token: string;
	url(): string;
	notify(): void;
	/** Pages connected right now; zero means nobody has the Control page open. */
	clients(): number;
	setAppearance(appearance: Appearance | null): void;
	stop(): void;
}

function scopeOf(value: unknown): Scope {
	if (value !== "repo" && value !== "global") throw new HttpError(400, "scope must be repo or global");
	return value;
}

function objectOf(value: unknown, what: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${what} must be an object`);
	return value as Record<string, unknown>; // checked to be a plain object just above
}

function nodeOf(value: unknown): NodeDefinition {
	const raw = objectOf(value, "node");
	if (typeof raw.id !== "string") throw new HttpError(400, "node needs an id");
	return nodeFrom(raw.id, raw, typeof raw.instructions === "string" ? raw.instructions : "", `node ${raw.id}`);
}

function decisionsOf(value: unknown): Record<string, Decision> {
	const raw = objectOf(value ?? {}, "decisions");
	const out: Record<string, Decision> = {};
	for (const [id, d] of Object.entries(raw)) {
		const item = objectOf(d, `decision ${id}`);
		if (item.decision !== "fix" && item.decision !== "dismiss") throw new HttpError(400, `decision ${id} must be fix or dismiss`);
		if (item.note !== undefined && typeof item.note !== "string") throw new HttpError(400, `decision ${id} note must be text`);
		out[id] = item.note ? { decision: item.decision, note: item.note } : { decision: item.decision };
	}
	return out;
}

export function startControlServer(hooks: ControlHooks, { ports = DEFAULT_PORTS, stateDir = STATE_DIR } = {}): ControlServer {
	const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const encoder = new TextEncoder();

	const push = (client: ReadableStreamDefaultController<Uint8Array>, text: string) => {
		try {
			client.enqueue(encoder.encode(text));
		} catch {
			clients.delete(client);
		}
	};
	const broadcast = (text: string) => {
		for (const client of clients) push(client, text);
	};
	const sendState = async (client?: ReadableStreamDefaultController<Uint8Array>) => {
		const text = `event: state\ndata: ${JSON.stringify(await hooks.state())}\n\n`;
		if (client) push(client, text);
		else broadcast(text);
	};
	const ping = setInterval(() => broadcast(": ping\n\n"), PING_MS);

	function events(): Response {
		let self: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				self = controller;
				clients.add(controller);
				void sendState(controller).catch(() => {});
			},
			cancel() {
				clients.delete(self);
			},
		});
		return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
	}

	async function api(req: Request, pathname: string): Promise<Response> {
		const method = req.method;
		if (method === "GET" && pathname === "/api/state") return json(await hooks.state());
		if (method === "GET" && pathname === "/api/events") return events();
		if (method === "GET" && pathname === "/api/changes") return json(await hooks.changes());
		if (method === "GET" && pathname === "/api/artifact") {
			// Only images the current run lists: the page can't read arbitrary files through this route.
			const path = new URL(req.url).searchParams.get("path") ?? "";
			const listed = Object.values((await hooks.state()).run?.nodes ?? {}).some((n) => n.artifacts.includes(path));
			if (!listed || !(await Bun.file(path).exists())) return json({ error: "not found" }, 404);
			return new Response(Bun.file(path), { headers: { "Cache-Control": "no-store" } });
		}
		const del = /^\/api\/library\/(node|loop)\/(repo|global)\/([^/]+)$/.exec(pathname);
		if (method === "DELETE" && del) {
			await hooks.deleteItem(del[1] as "node" | "loop", del[2] as Scope, decodeURIComponent(del[3]));
			return json({ ok: true });
		}
		if (method !== "POST" && method !== "PUT") throw new HttpError(404, "not found");
		if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) throw new HttpError(415, "send application/json");
		let body: Record<string, unknown>;
		try {
			body = objectOf(await req.json(), "body");
		} catch (e) {
			throw e instanceof HttpError ? e : new HttpError(400, "invalid JSON body");
		}
		const route = `${method} ${pathname}`;
		switch (route) {
			case "POST /api/attach": {
				if (body.loop !== null && typeof body.loop !== "string") throw new HttpError(400, "loop must be a loop id or null");
				await hooks.attach(body.loop);
				return json({ ok: true });
			}
			case "PUT /api/session-loop":
				await hooks.setSessionLoop(validateSnapshot(body.loop));
				return json({ ok: true });
			case "POST /api/library/loop": {
				const raw = objectOf(body.loop, "loop");
				if (typeof raw.id !== "string") throw new HttpError(400, "loop needs an id");
				const loop = loopFrom(raw.id, raw, `loop ${raw.id}`);
				if (!Array.isArray(body.nodes)) throw new HttpError(400, "nodes must be a list");
				const paths = await hooks.saveLoop(scopeOf(body.scope), loop, body.nodes.map(nodeOf));
				return json({ paths });
			}
			case "POST /api/library/copy": {
				if (body.kind !== "node" && body.kind !== "loop") throw new HttpError(400, "kind must be node or loop");
				if (typeof body.id !== "string") throw new HttpError(400, "id is required");
				return json({ path: await hooks.copyItem(body.kind, body.id, scopeOf(body.to), body.move === true) });
			}
			case "POST /api/library/node":
				return json({ path: await hooks.saveNode(scopeOf(body.scope), nodeOf(body.node)) });
			case "POST /api/decide": {
				const reply = hooks.decide(decisionsOf(body.decisions), body.pause === true);
				return json(reply, reply.ok ? 200 : 409);
			}
			case "POST /api/draft": {
				const intent = typeof body.intent === "string" ? body.intent.trim() : "";
				if (!intent) throw new HttpError(400, "Say what it should check");
				const kind = body.kind === "check" || body.kind === "review" ? body.kind : undefined;
				const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
				hooks.send(draftPrompt({ kind, name, intent, scope: scopeOf(body.scope) }));
				return json({ ok: true });
			}
			case "POST /api/check":
				hooks.check();
				return json({ ok: true });
			case "POST /api/review":
				await hooks.review();
				return json({ ok: true });
			case "POST /api/since": {
				if (typeof body.ref !== "string" || !body.ref.trim()) throw new HttpError(400, "ref is required");
				return json({ ok: true, since: await hooks.since(body.ref) });
			}
			case "POST /api/pause":
				if (typeof body.paused !== "boolean") throw new HttpError(400, "paused must be true or false");
				hooks.setPaused(body.paused);
				return json({ ok: true });
			default:
				throw new HttpError(404, "not found");
		}
	}

	const page = startPageServer({
		name: "control",
		webDir: WEB_DIR,
		stateDir,
		ports,
		idleTimeout: 0,
		api: async (req, url) => {
			try {
				return await api(req, url.pathname);
			} catch (e) {
				return json({ error: errorText(e) }, e instanceof HttpError ? e.status : 400);
			}
		},
		onAppearance: () => broadcast("event: appearance\ndata: {}\n\n"),
	});

	return {
		port: page.port,
		token: page.token,
		url: page.url,
		notify: () => void sendState().catch(() => {}),
		clients: () => clients.size,
		setAppearance: page.setAppearance,
		stop() {
			clearInterval(ping);
			for (const client of clients) {
				try {
					client.close();
				} catch {}
			}
			clients.clear();
			page.stop();
		},
	};
}
