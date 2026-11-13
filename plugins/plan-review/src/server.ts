import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import type { Server } from "bun";
import type { Appearance } from "omp-integrations/appearance";
import { appearanceCss } from "omp-integrations/appearance";
import type { LocalFont } from "omp-integrations/fonts";
import { PROTOCOL } from "./shared/protocol.js";

const WEB_DIR = resolve(import.meta.dir, "..", "web");
export const DEFAULT_PORTS = Array.from({ length: 10 }, (_, i) => 9900 + i);
export const DEFAULT_STATE_DIR = join(homedir(), ".omp", "cache", "plan-review");
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
};

export interface PlanOption {
	id: string;
	label: string;
	disabled: boolean;
}

export interface PlanTier {
	role: string;
	provider: string;
	model: string;
	thinkingLevel?: string;
}

/** omp's plan_review_requested event, as far as the page needs it. */
export interface PlanReviewRequest {
	reviewId: string;
	title: string;
	planFilePath: string;
	planContent: string;
	options: PlanOption[];
	tiers?: PlanTier[];
}

/** Who answered a review: this page, another extension (Control's plan checks) or the terminal. */
export type ResolvedBy = "page" | "extension" | "local";

export interface PlanReviewView extends PlanReviewRequest {
	/** The plan this one revises after a refine, for highlighting what changed. */
	previous: string | null;
	resolution: { choice: string | null; by: ResolvedBy } | null;
}

export interface ResolveOptions {
	feedback?: string;
	role?: string;
}

export interface PlanReviewHooks {
	/** Answers omp's pending review as its own dialog would; false when omp refuses. */
	resolve(reviewId: string, choice: string, options: ResolveOptions): boolean;
	sessionName(): string;
}

export interface PlanReviewServer {
	readonly port: number;
	readonly token: string;
	url(): string;
	present(request: PlanReviewRequest): void;
	resolved(reviewId: string, choice: string | null, by: "extension" | "local"): void;
	clear(): void;
	/** Whether the main agent is running a turn: planning, revising or executing. */
	setWorking(working: boolean): void;
	setAppearance(appearance: Appearance | null): void;
	stop(): void;
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

function parseResolve(body: unknown): ({ reviewId: string; choice: string } & ResolveOptions) | null {
	if (!body || typeof body !== "object") return null;
	const { reviewId, choice, feedback, role } = body as Record<string, unknown>;
	if (typeof reviewId !== "string" || typeof choice !== "string") return null;
	if (feedback !== undefined && typeof feedback !== "string") return null;
	if (role !== undefined && typeof role !== "string") return null;
	return { reviewId, choice, feedback, role };
}

// Shared by every plan review server so an open tab reconnects after omp restarts.
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

export function startPlanReviewServer(hooks: PlanReviewHooks, { ports = DEFAULT_PORTS, stateDir = DEFAULT_STATE_DIR } = {}): PlanReviewServer {
	const token = storedToken(stateDir);
	let review: PlanReviewView | null = null;
	let working = false;
	let themeCss = "";
	let font: LocalFont | undefined;

	const publish = () => server?.publish("plan", JSON.stringify({ type: "review", review }));

	async function resolveReview(req: Request): Promise<Response> {
		const body = parseResolve(await req.json().catch(() => null));
		if (!body) return json({ error: "Expected { reviewId, choice, feedback?, role? }" }, 400);
		if (!review || review.reviewId !== body.reviewId || review.resolution) return json({ error: "This plan review is no longer waiting for an answer" }, 409);
		const { reviewId, choice, feedback, role } = body;
		if (!hooks.resolve(reviewId, choice, { feedback, role })) return json({ error: "omp didn't take this answer" }, 422);
		// omp reports it as answered by an extension right after; the page already knows it was this one.
		if (review?.reviewId === reviewId) {
			review.resolution = { choice, by: "page" };
			publish();
		}
		return json({ ok: true });
	}

	let server: Server<undefined> | null = null;
	for (const port of [...ports, 0]) {
		try {
			server = Bun.serve({
				hostname: "127.0.0.1",
				port,
				fetch(req, srv) {
					const url = new URL(req.url);
					const authorized = url.searchParams.get("token") === token;
					if (url.pathname === "/ws") {
						if (authorized && srv.upgrade(req, { data: undefined })) return undefined;
						return new Response("Forbidden", { status: 403 });
					}
					if (url.pathname === "/api/font") {
						if (!authorized) return new Response("Forbidden", { status: 403 });
						if (!font || url.searchParams.get("id") !== font.id) return new Response("Not found", { status: 404 });
						return new Response(Bun.file(font.path), { headers: { "Cache-Control": "no-store" } });
					}
					if (url.pathname === "/api/resolve") {
						if (!authorized) return json({ error: "forbidden" }, 403);
						return req.method === "POST" ? resolveReview(req) : json({ error: "method not allowed" }, 405);
					}
					if (url.pathname.startsWith("/api/")) return json({ error: authorized ? "not found" : "forbidden" }, authorized ? 404 : 403);
					if (url.pathname === "/appearance.css") {
						if (!authorized) return new Response("Forbidden", { status: 403 });
						return new Response(themeCss, { headers: { "Content-Type": CONTENT_TYPES[".css"], "Cache-Control": "no-store" } });
					}
					return serveStatic(url.pathname, authorized ? token : "");
				},
				websocket: {
					open(ws) {
						ws.subscribe("plan");
						ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, session: hooks.sessionName(), review, working }));
					},
					message() {},
				},
			});
			break;
		} catch {}
	}
	if (!server) throw new Error("plan-review: could not bind a local port");
	const srv = server;

	return {
		port: srv.port as number,
		token,
		url: () => `http://127.0.0.1:${srv.port}/?token=${token}`,
		present(request) {
			const previous = review && review.planFilePath === request.planFilePath && review.resolution?.choice === "refine" ? review.planContent : null;
			const { reviewId, title, planFilePath, planContent, options, tiers } = request;
			review = { reviewId, title, planFilePath, planContent, options, tiers, previous, resolution: null };
			publish();
		},
		resolved(reviewId, choice, by) {
			if (!review || review.reviewId !== reviewId || review.resolution) return;
			review.resolution = { choice, by };
			publish();
		},
		clear() {
			if (!review) return;
			review = null;
			publish();
		},
		setWorking(next) {
			if (next === working) return;
			working = next;
			srv.publish("plan", JSON.stringify({ type: "working", working }));
		},
		setAppearance(appearance) {
			font = appearance?.font;
			const next = appearance ? appearanceCss(appearance, `/api/font?token=${token}&id=${font?.id}`) : "";
			if (next === themeCss) return;
			themeCss = next;
			srv.publish("plan", JSON.stringify({ type: "appearance" }));
		},
		stop() {
			srv.stop(true);
		},
	};
}
