import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as omp from "@oh-my-pi/pi-coding-agent";
import { openBoard } from "omp-integrations/terminal";
import { currentTheme, hasThemeApi, terminalConfig } from "omp-integrations/theme";
import { toAppearance } from "./appearance";
import { type Compare, isRepo, repoRoot } from "./git";
import { DEFAULT_PORTS, type ReviewServer, startReviewServer } from "./server";

const USAGE = "Usage: /review [branch [base] | uncommitted | commit [sha]]";

// Undocumented omp exports; without them the page keeps its built-in palette and font size.
const themeApi = hasThemeApi(omp);

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
	let themeEpoch: number | null = null;
	let themeTimer: Timer | undefined;

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

	async function syncAppearance(force = false) {
		if (!themeApi) return;
		const epoch = omp.getThemeEpoch();
		if (!server || (epoch === themeEpoch && !force)) return;
		themeEpoch = epoch;
		const [theme, terminal] = await Promise.all([currentTheme(omp), terminalConfig()]);
		if (themeEpoch === epoch) server?.setAppearance(toAppearance(theme, terminal));
	}

	async function ensureServer(cwd: string, port: number | null): Promise<ReviewServer> {
		const root = await reviewRoot(cwd);
		if (server) server.setRoot(root);
		else {
			server = startReviewServer(root, hooks, { ports: port ? [port, ...DEFAULT_PORTS] : DEFAULT_PORTS });
			if (themeApi) themeTimer = setInterval(() => syncAppearance(), 1000);
		}
		// The terminal config has no change signal, so each /review re-reads it.
		if (themeApi) await syncAppearance(true);
		return server;
	}

	async function follow(sessionCtx: ExtensionContext) {
		ctx = sessionCtx;
		if (!server) return;
		server.setRoot(await reviewRoot(sessionCtx.cwd));
		server.notifyChanged();
	}

	pi.registerCommand("review", {
		description: `Review changes in the browser with a file tree and line comments for the agent. ${USAGE}`,
		handler: async (args, commandCtx) => {
			ctx = commandCtx;
			const compare = parseArgs(args);
			if (!compare) {
				commandCtx.ui.notify(USAGE, "error");
				return;
			}
			const url = (await ensureServer(commandCtx.cwd, null)).url(compare);
			await openBoard(url, { focus: true });
			commandCtx.ui.notify(`review open at ${url}`, "info");
		},
	});

	pi.on("session_start", async (_event, sessionCtx) => {
		ctx = sessionCtx;
		if (resumePort === null) return;
		const port = resumePort;
		resumePort = null;
		await ensureServer(sessionCtx.cwd, port);
	});
	pi.on("session_switch", async (_event, sessionCtx) => {
		await follow(sessionCtx);
	});
	pi.on("tool_result", async (_event, sessionCtx) => {
		await follow(sessionCtx);
	});
	pi.on("agent_end", async (_event, sessionCtx) => {
		await follow(sessionCtx);
	});
	pi.on("session_shutdown", async () => {
		if (!server) return;
		resumePort = server.port;
		clearInterval(themeTimer);
		themeEpoch = null;
		server.stop();
		server = null;
	});
}
