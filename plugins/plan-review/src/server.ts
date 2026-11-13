import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Appearance } from "omp-integrations/appearance";
import { json, portRange, startPageServer } from "omp-integrations/server";
import { PROTOCOL } from "./shared/protocol.js";

const WEB_DIR = resolve(import.meta.dir, "..", "web");
export const DEFAULT_PORTS = portRange(9900);
export const DEFAULT_STATE_DIR = join(homedir(), ".omp", "cache", "plan-review");

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

function parseResolve(body: unknown): ({ reviewId: string; choice: string } & ResolveOptions) | null {
	if (!body || typeof body !== "object") return null;
	const { reviewId, choice, feedback, role } = body as Record<string, unknown>;
	if (typeof reviewId !== "string" || typeof choice !== "string") return null;
	if (feedback !== undefined && typeof feedback !== "string") return null;
	if (role !== undefined && typeof role !== "string") return null;
	return { reviewId, choice, feedback, role };
}

export function startPlanReviewServer(hooks: PlanReviewHooks, { ports = DEFAULT_PORTS, stateDir = DEFAULT_STATE_DIR } = {}): PlanReviewServer {
	let review: PlanReviewView | null = null;
	let working = false;

	const publish = () => page.server.publish("plan", JSON.stringify({ type: "review", review }));

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

	const page = startPageServer({
		name: "plan-review",
		webDir: WEB_DIR,
		stateDir,
		ports,
		fonts: true,
		api: (req, url) => (url.pathname !== "/api/resolve" ? json({ error: "not found" }, 404) : req.method === "POST" ? resolveReview(req) : json({ error: "method not allowed" }, 405)),
		websocket: {
			open(ws) {
				ws.subscribe("plan");
				ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, session: hooks.sessionName(), review, working }));
			},
			message() {},
		},
		onAppearance: () => page.server.publish("plan", JSON.stringify({ type: "appearance" })),
	});

	return {
		port: page.port,
		token: page.token,
		url: page.url,
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
			page.server.publish("plan", JSON.stringify({ type: "working", working }));
		},
		setAppearance: page.setAppearance,
		stop: page.stop,
	};
}
