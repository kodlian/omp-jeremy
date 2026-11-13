import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as omp from "@oh-my-pi/pi-coding-agent";
import { appearanceSync, recordedPort } from "omp-integrations/page";
import { isReviewRequest, REVIEW_EVENT } from "omp-integrations/review";
import { openBoard } from "omp-integrations/terminal";
import { errorText } from "omp-integrations/text";
import { type Compare, isRepo, repoRoot } from "./git";
import { DEFAULT_PORTS, type ReviewServer, startReviewServer } from "./server";

const USAGE = "Usage: /review [branch [base] | uncommitted | commit [sha]]";
// Session entry recording the port a session's review page uses, so a restored session brings it back.
const SERVER_ENTRY = "git-diff-review.server";

function parseArgs(args: string): Compare | null {
	const [kind, value] = args.trim().split(/\s+/).filter(Boolean);
	if (!kind || kind === "branch") return { kind: "branch", base: value ?? null };
	if (kind === "uncommitted") return { kind };
	if (kind === "commit") return { kind, sha: value ?? null };
	return null;
}

async function reviewRoot(cwd: string): Promise<string> {
	return (await isRepo(cwd)) ? await repoRoot(cwd) : cwd;
}

export default function gitDiffReview(pi: ExtensionAPI) {
	let server: ReviewServer | null = null;
	let ctx: ExtensionContext | null = null;
	let resumePort: number | null = null;
	const appearance = appearanceSync(omp, () => server);

	const hooks = {
		send(text: string) {
			if (!ctx || ctx.isIdle()) pi.sendUserMessage(text);
			else pi.sendUserMessage(text, { deliverAs: "followUp" });
		},
		paste(text: string) {
			ctx?.ui.pasteToEditor(text);
		},
		sessionName: () => pi.getSessionName() || "omp",
	};

	async function ensureServer(cwd: string, port: number | null): Promise<ReviewServer> {
		const root = await reviewRoot(cwd);
		if (server) server.setRoot(root);
		else {
			server = startReviewServer(root, hooks, { ports: port ? [port, ...DEFAULT_PORTS] : DEFAULT_PORTS });
			appearance.start();
		}
		// The terminal config has no change signal, so each /review re-reads it.
		await appearance.sync(true);
		return server;
	}

	async function follow(sessionCtx: ExtensionContext) {
		ctx = sessionCtx;
		if (!server) return;
		server.setRoot(await reviewRoot(sessionCtx.cwd));
		server.notifyChanged();
	}

	/** Opens the review page on a comparison of the session's repo; returns its URL. */
	async function open(sessionCtx: ExtensionContext, compare: Compare): Promise<string> {
		ctx = sessionCtx;
		const reviewServer = await ensureServer(sessionCtx.cwd, null);
		if (recordedPort(sessionCtx, SERVER_ENTRY) !== reviewServer.port) pi.appendEntry(SERVER_ENTRY, { port: reviewServer.port });
		const url = reviewServer.url(compare);
		await openBoard(url, { focus: true });
		return url;
	}

	pi.registerCommand("review", {
		description: `Review changes in the browser with a file tree and line comments for the agent. ${USAGE}`,
		handler: async (args, commandCtx) => {
			const compare = parseArgs(args);
			if (!compare) {
				commandCtx.ui.notify(USAGE, "error");
				return;
			}
			commandCtx.ui.notify(`review open at ${await open(commandCtx, compare)}`, "info");
		},
	});

	pi.events.on(REVIEW_EVENT, (data: unknown) => {
		if (!isReviewRequest(data)) return;
		if (data.type === "probe") return data.reply({ ok: true, message: "" });
		if (!ctx) return data.reply({ ok: false, message: "git-diff-review has no omp session yet" });
		open(ctx, { kind: "branch", base: data.base }).then(
			(url) => data.reply({ ok: true, message: url }),
			(e) => data.reply({ ok: false, message: errorText(e) }),
		);
	});

	pi.on("session_start", async (_event, sessionCtx) => {
		if (sessionCtx.agent?.kind === "sub") return;
		ctx = sessionCtx;
		const port = resumePort ?? recordedPort(sessionCtx, SERVER_ENTRY);
		resumePort = null;
		if (port !== null) await ensureServer(sessionCtx.cwd, port).catch((e) => sessionCtx.ui.notify(`Review: the page didn't start: ${errorText(e)}`, "warning"));
	});
	pi.on("session_switch", async (_event, sessionCtx) => {
		if (sessionCtx.agent?.kind === "sub") return;
		const port = server ? null : recordedPort(sessionCtx, SERVER_ENTRY);
		if (port !== null) {
			ctx = sessionCtx;
			await ensureServer(sessionCtx.cwd, port).catch((e) => sessionCtx.ui.notify(`Review: the page didn't start: ${errorText(e)}`, "warning"));
		} else await follow(sessionCtx);
	});
	pi.on("tool_result", async (_event, sessionCtx) => {
		if (sessionCtx.agent?.kind === "sub") return;
		await follow(sessionCtx);
	});
	pi.on("agent_end", async (_event, sessionCtx) => {
		if (sessionCtx.agent?.kind === "sub") return;
		await follow(sessionCtx);
	});
	pi.on("session_shutdown", async (_event, sessionCtx) => {
		if (sessionCtx.agent?.kind === "sub") return;
		ctx = null;
		if (!server) return;
		resumePort = server.port;
		appearance.stop();
		server.stop();
		server = null;
	});
}
