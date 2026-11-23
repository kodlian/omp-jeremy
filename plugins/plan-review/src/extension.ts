import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as omp from "@oh-my-pi/pi-coding-agent";
import { appearanceSync, recordedPort } from "omp-integrations/page";
import { closeTab, openTab, type PageTab } from "omp-integrations/terminal";
import { errorText } from "omp-integrations/text";
import { DEFAULT_PORTS, type PlanReviewServer, startPlanReviewServer } from "./server";

// Session entry recording the port a session's page uses, so a restored session brings it back and an open tab reconnects.
const SERVER_ENTRY = "plan-review.server";

export default function planReview(pi: ExtensionAPI) {
	let server: PlanReviewServer | null = null;
	let ctx: ExtensionContext | null = null;
	let resumePort: number | null = null;
	let pending: string | null = null; // the review omp waits on
	let opened: string | null = null; // the review the page was opened for
	let tab: PageTab | null = null; // the browser tab showing the page, closed once its review ends
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

	/** Closes the page's tab, if one is open. */
	const closePage = async () => {
		const current = tab;
		tab = null;
		if (current) await closeTab(current).catch(() => {});
	};

	/** Opens the page in a tab beside the session's terminal and jumps to it. */
	const openPage = async (sessionCtx: ExtensionContext) => {
		const next = await openTab((await ensureServer(sessionCtx)).url());
		if (tab && tab.surface !== next?.surface) await closePage();
		tab = next;
	};

	/** Brings the page forward for a review, once. */
	const show = async (reviewId: string) => {
		// Orchestrator task sessions already show their plan on the board.
		if (opened === reviewId || pending !== reviewId || !ctx || process.env.ORCHESTRATOR_TASK) return;
		opened = reviewId;
		await openPage(ctx);
	};
	const showFailed = (error: unknown) => ctx?.ui.notify(`Plan review: the page didn't open: ${errorText(error)}`, "warning");

	pi.registerCommand("plan-review", {
		description: "Open the plan review page: comment on the plan's lines, then refine or approve it",
		handler: async (_args, commandCtx) => {
			ctx = commandCtx;
			await openPage(commandCtx);
			commandCtx.ui.notify(`plan review open at ${(await ensureServer(commandCtx)).url()}`, "info");
		},
	});

	pi.on("plan_review_requested", (event, eventCtx) => {
		if (eventCtx.agent?.kind === "sub") return;
		ctx = eventCtx;
		pending = event.reviewId;
		// The review's handlers must return quickly; the page opens after.
		void (async () => {
			(await ensureServer(eventCtx)).present(event);
			await show(event.reviewId);
		})().catch(showFailed);
	});

	// However the review ends (answered on the page or in the terminal, dismissed, replaced, plan mode left), its tab closes.
	pi.on("plan_review_resolved", (event, eventCtx) => {
		if (eventCtx.agent?.kind === "sub") return;
		if (event.reviewId === pending) pending = null;
		server?.resolved(event.reviewId, event.choice ?? null, event.by);
		void closePage();
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
		await ensureServer(sessionCtx, port).catch((e) => sessionCtx.ui.notify(`Plan review: the page didn't start: ${errorText(e)}`, "warning"));
	});

	pi.on("session_switch", async (_event, sessionCtx) => {
		if (sessionCtx.agent?.kind === "sub") return;
		ctx = sessionCtx;
		if (server) {
			server.clear();
			await closePage();
		} else await ensureServer(sessionCtx).catch((e) => sessionCtx.ui.notify(`Plan review: the page didn't start: ${errorText(e)}`, "warning"));
	});

	pi.on("session_shutdown", async (_event, sessionCtx) => {
		if (sessionCtx.agent?.kind === "sub") return;
		ctx = null;
		pending = null;
		resumePort = server?.port ?? null;
		appearance.stop();
		server?.stop();
		server = null;
		await closePage();
	});
}
