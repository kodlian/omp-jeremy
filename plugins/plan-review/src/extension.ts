import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as omp from "@oh-my-pi/pi-coding-agent";
import { COMMAND_EVENT, type ControlReply, RUN_EVENT, type RunView } from "omp-control-view/protocol";
import { busAsk } from "omp-integrations/bus";
import { appearanceSync, recordedPort } from "omp-integrations/page";
import { openBoard } from "omp-integrations/terminal";
import { errorText } from "omp-integrations/text";
import { DEFAULT_PORTS, type PlanReviewServer, startPlanReviewServer } from "./server";

// Session entry recording the port a session's page uses, so a restored session brings it back and an open tab reconnects.
const SERVER_ENTRY = "plan-review.server";
/** How long Control gets to say whether its AI reviewer answers the plan; it answers at once when loaded. */
const CONTROL_ASK_MS = 150;

export default function planReview(pi: ExtensionAPI) {
	let server: PlanReviewServer | null = null;
	let ctx: ExtensionContext | null = null;
	let resumePort: number | null = null;
	let pending: string | null = null; // the review omp waits on
	let opened: string | null = null; // the review the page was opened for
	const appearance = appearanceSync(omp, () => server);

	async function ensureServer(sessionCtx: ExtensionContext, port: number | null = recordedPort(sessionCtx, SERVER_ENTRY)): Promise<PlanReviewServer> {
		if (!server) {
			server = startPlanReviewServer(
				{
					resolve: (reviewId, choice, options) => ctx?.resolvePlanReview(reviewId, choice, options) ?? false,
					sessionName: () => pi.getSessionName() || "omp",
				},
				{ ports: port ? [port, ...DEFAULT_PORTS] : DEFAULT_PORTS },
			);
			appearance.start();
		}
		if (recordedPort(sessionCtx, SERVER_ENTRY) !== server.port) pi.appendEntry(SERVER_ENTRY, { port: server.port });
		// The terminal config has no change signal, so each open re-reads it.
		await appearance.sync(true);
		return server;
	}

	/** Brings the page forward for a review, once. */
	const show = async (reviewId: string) => {
		// Orchestrator task sessions already show their plan on the board.
		if (opened === reviewId || pending !== reviewId || !ctx || process.env.ORCHESTRATOR_TASK) return;
		opened = reviewId;
		await openBoard((await ensureServer(ctx)).url(), { focus: true });
	};
	const showFailed = (error: unknown) => ctx?.ui.notify(`Plan review: the page didn't open: ${errorText(error)}`, "warning");

	pi.registerCommand("plan-review", {
		description: "Open the plan review page: comment on the plan's lines, then refine or approve it",
		handler: async (_args, commandCtx) => {
			ctx = commandCtx;
			const url = (await ensureServer(commandCtx)).url();
			await openBoard(url, { focus: true });
			commandCtx.ui.notify(`plan review open at ${url}`, "info");
		},
	});

	pi.on("plan_review_requested", (event, eventCtx) => {
		if (eventCtx.agent?.kind === "sub") return;
		ctx = eventCtx;
		pending = event.reviewId;
		// The review's handlers must return quickly; the page opens after.
		void (async () => {
			(await ensureServer(eventCtx)).present(event);
			// Control's AI reviewer answers first; the page comes forward if it leaves the plan to you.
			const run = (await busAsk<ControlReply>(pi.events, COMMAND_EVENT, { type: "run" }, CONTROL_ASK_MS, "")).run;
			if (run?.loop.plan === "ai" && run.status !== "paused" && run.plan !== "review") return;
			await show(event.reviewId);
		})().catch(showFailed);
	});

	pi.events.on(RUN_EVENT, (data) => {
		const view = (data ?? null) as RunView | null; // Control's RUN_EVENT payload
		if (view?.plan === "review" && pending) void show(pending).catch(showFailed);
	});

	pi.on("plan_review_resolved", (event, eventCtx) => {
		if (eventCtx.agent?.kind === "sub") return;
		if (event.reviewId === pending) pending = null;
		server?.resolved(event.reviewId, event.choice ?? null, event.by);
	});

	pi.on("before_agent_start", (_event, eventCtx) => {
		if (eventCtx.agent?.kind !== "sub") server?.setWorking(true);
	});

	pi.on("agent_end", (_event, eventCtx) => {
		if (eventCtx.agent?.kind !== "sub") server?.setWorking(false);
	});

	pi.on("session_start", async (_event, sessionCtx) => {
		if (sessionCtx.agent?.kind === "sub") return;
		ctx = sessionCtx;
		const port = resumePort ?? recordedPort(sessionCtx, SERVER_ENTRY);
		resumePort = null;
		// Control's reviewer sessions never plan.
		if (process.env.OMP_CONTROL_REVIEWER === "1") return;
		await ensureServer(sessionCtx, port).catch((e) => sessionCtx.ui.notify(`Plan review: the page didn't start: ${errorText(e)}`, "warning"));
	});

	pi.on("session_switch", async (_event, sessionCtx) => {
		if (sessionCtx.agent?.kind === "sub") return;
		ctx = sessionCtx;
		if (server) server.clear();
		else await ensureServer(sessionCtx).catch((e) => sessionCtx.ui.notify(`Plan review: the page didn't start: ${errorText(e)}`, "warning"));
	});

	pi.on("session_shutdown", (_event, sessionCtx) => {
		if (sessionCtx.agent?.kind === "sub") return;
		ctx = null;
		pending = null;
		resumePort = server?.port ?? null;
		appearance.stop();
		server?.stop();
		server = null;
	});
}
