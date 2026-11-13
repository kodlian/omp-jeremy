import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as omp from "@oh-my-pi/pi-coding-agent";
import { toAppearance } from "omp-integrations/appearance";
import { openBoard } from "omp-integrations/terminal";
import { currentTheme, hasThemeApi, terminalConfig } from "omp-integrations/theme";
import { DEFAULT_PORTS, type PlanReviewServer, startPlanReviewServer } from "./server";

// Undocumented omp exports; without them the page keeps its built-in palette and font size.
const themeApi = hasThemeApi(omp);
// Session entry recording the port a session's page uses, so a restored session brings it back and an open tab reconnects.
const SERVER_ENTRY = "plan-review.server";

function recordedPort(sessionCtx: ExtensionContext): number | null {
	let port: number | null = null;
	for (const entry of sessionCtx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === SERVER_ENTRY && typeof entry.data?.port === "number") port = entry.data.port;
	}
	return port;
}

export default function planReview(pi: ExtensionAPI) {
	let server: PlanReviewServer | null = null;
	let ctx: ExtensionContext | null = null;
	let themeEpoch: number | null = null;
	let themeTimer: Timer | undefined;
	let resumePort: number | null = null;

	async function syncAppearance(force = false) {
		if (!themeApi) return;
		const epoch = omp.getThemeEpoch();
		if (!server || (epoch === themeEpoch && !force)) return;
		themeEpoch = epoch;
		const [theme, terminal] = await Promise.all([currentTheme(omp), terminalConfig()]);
		if (themeEpoch === epoch) server?.setAppearance(toAppearance(theme, terminal));
	}

	async function ensureServer(sessionCtx: ExtensionContext, port: number | null = recordedPort(sessionCtx)): Promise<PlanReviewServer> {
		if (!server) {
			server = startPlanReviewServer(
				{
					resolve: (reviewId, choice, options) => ctx?.resolvePlanReview(reviewId, choice, options) ?? false,
					sessionName: () => pi.getSessionName() || "omp",
				},
				{ ports: port ? [port, ...DEFAULT_PORTS] : DEFAULT_PORTS },
			);
			if (themeApi) themeTimer = setInterval(() => syncAppearance(), 1000);
		}
		if (recordedPort(sessionCtx) !== server.port) pi.appendEntry(SERVER_ENTRY, { port: server.port });
		// The terminal config has no change signal, so each open re-reads it.
		if (themeApi) await syncAppearance(true);
		return server;
	}

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
		// The review's handlers must return quickly; the page opens after.
		void (async () => {
			const reviewServer = await ensureServer(eventCtx);
			reviewServer.present(event);
			// Orchestrator task sessions already show their plan on the board.
			if (!process.env.ORCHESTRATOR_TASK) await openBoard(reviewServer.url(), { focus: true });
		})().catch((error) => eventCtx.ui.notify(`Plan review: the page didn't open: ${error instanceof Error ? error.message : String(error)}`, "warning"));
	});

	pi.on("plan_review_resolved", (event, eventCtx) => {
		if (eventCtx.agent?.kind === "sub") return;
		server?.resolved(event.reviewId, event.choice ?? null, event.by);
	});

	pi.on("before_agent_start", (_event, eventCtx) => {
		if (eventCtx.agent?.kind !== "sub") server?.setWorking(true);
	});

	pi.on("agent_end", (_event, eventCtx) => {
		if (eventCtx.agent?.kind !== "sub") server?.setWorking(false);
	});

	// The page is served for the whole session, so an open tab shows what omp is doing even before its first plan.
	pi.on("session_start", async (_event, sessionCtx) => {
		ctx = sessionCtx;
		const port = resumePort ?? recordedPort(sessionCtx);
		resumePort = null;
		// Control's reviewer sessions never plan.
		if (sessionCtx.agent?.kind !== "sub" && process.env.OMP_CONTROL_REVIEWER !== "1") await ensureServer(sessionCtx, port);
	});

	pi.on("session_switch", async (_event, sessionCtx) => {
		ctx = sessionCtx;
		if (server) server.clear();
		else await ensureServer(sessionCtx);
	});

	pi.on("session_shutdown", () => {
		resumePort = server?.port ?? null;
		clearInterval(themeTimer);
		themeEpoch = null;
		server?.stop();
		server = null;
	});
}
