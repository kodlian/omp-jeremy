// Control for omp: a session's control loop (checks and reviewers that measure each change), its tools, /control, a widget and a page.
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as omp from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { COMMAND_EVENT, type ControlCommand, type Decision, type FindingView, LIBRARY_EVENT, questionAnswer, RUN_EVENT, type RunView } from "omp-control-view/protocol";
import { STATUS_LABELS } from "omp-control-view/render";
import { toAppearance } from "omp-integrations/appearance";
import { REVIEW_EVENT, type ReviewReply } from "omp-integrations/review";
import { openBoard } from "omp-integrations/terminal";
import { currentTheme, hasThemeApi, terminalConfig } from "omp-integrations/theme";
import { type Checkpoint, Controller, type ControllerDeps } from "./controller";
import { type Baseline, baselineSha, changedFiles, commitsSince, defaultBranch, fingerprint, git, isCommit, repoRoot, reviewPacket } from "./git";
import { copyItem, deleteItem, type Library, type LoopSnapshot, loadLibrary, loopFrom, nodeFrom, resolveLoop, saveLoop, saveNode, savedSnapshot, summarize } from "./library";
import { CHECK_REQUEST, contextMessage, draftPrompt, reviewerSystemPrompt, stagesText } from "./prompts";
import { runCheck, runReviewer } from "./sensors";
import { type ControlServer, DEFAULT_PORTS, startControlServer, type StatePayload } from "./server";

const LOOP_ENTRY = "control.loop";
const STATE_ENTRY = "control.state";
const SERVER_ENTRY = "control.server";
const WIDGET = "control";
const CONTEXT_TYPE = "control.context";
const TOOL = "control_check";
const USAGE = "Control: /control [open] | use <loop> | off | pause | resume | status | check | since <branch or commit> | draft <what it should check>";
const COMMANDS: AutocompleteItem[] = [
	{ label: "open", value: "open", description: "Open the Control page" },
	{ label: "use", value: "use", description: "Attach a library loop to this session" },
	{ label: "off", value: "off", description: "Detach this session's loop" },
	{ label: "pause", value: "pause", description: "Pause the loop" },
	{ label: "resume", value: "resume", description: "Resume the loop" },
	{ label: "status", value: "status", description: "Show the loop's status" },
	{ label: "check", value: "check", description: "Run the loop on the current code now, even if it already passed" },
	{ label: "since", value: "since", description: "Check the changes since a branch or commit" },
	{ label: "draft", value: "draft", description: "Create a check or reviewer with the agent" },
];
const FIX = "Fix it";
const DISMISS = "Leave it as is";
const FIX_ALL = "Fix all remaining";
const APPROVE = "Approve";
const SEND_BACK = "Send back";
const DISMISS_ALL = "Dismiss all remaining";
const PAUSE = "Pause the loop";
const GATE_HELP = "Esc pauses the loop";
/** omp's plan review choices that approve the plan. */
const PLAN_APPROVALS: Record<string, true> = { execute: true, compact: true, keep: true };
/** How long git-diff-review gets to answer: a probe at once when it's loaded; opening its page takes longer. */
const REVIEW_PROBE_MS = 500;
const REVIEW_OPEN_MS = 15_000;

interface LoopEntry {
	loop: LoopSnapshot | null;
	source: string | null;
	baseline: Baseline | null;
}

interface Attached {
	loop: LoopSnapshot;
	source: string;
	baseline: Baseline;
}

// Undocumented omp exports; without them the page keeps its built-in palette.
const themeApi = hasThemeApi(omp);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });

function findingQuestion(f: FindingView): string {
	if (f.approval) return `${f.rule}\n\n${f.observed}\n\nApprove the change, or send it back with what to change (type it as your answer).`;
	if (f.question) return `${f.rule}\nIt chose: ${f.question.chose}. Keep it, or pick another option.`;
	const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""} — ` : "";
	const lines = [`${where}${f.rule}`, `Observed: ${f.observed}`, `Expected: ${f.expected}`];
	if (f.alternatives.length) lines.push(`Acceptable fixes: ${f.alternatives.join("; ")}`);
	return lines.join("\n");
}

function statusText(view: RunView | null): string {
	if (!view) return "No control loop is attached to this session.";
	const head = `Control loop «${view.loop.name}» (${stagesText(view.loop) || "no stages"}) · ${STATUS_LABELS[view.status]}${view.pass ? ` · pass ${view.pass}/${view.loop.maxPasses}` : ""}`;
	const lines = [head];
	if (view.note) lines.push(view.note);
	if (view.history.length) lines.push(view.history.map((h) => `Pass ${h.pass}: ${h.result === "fixes" ? `${h.findings} to fix` : h.result}`).join(" · "));
	for (const f of view.findings) {
		const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""} —` : "";
		const route = f.decision ? `you: ${f.decision.decision}` : f.route === "ask" ? "your call" : f.route;
		lines.push(`${f.id} [${f.nodeName}]${where} ${f.rule} (${route})`);
	}
	return lines.join("\n");
}

function failedView(id: string, message: string): RunView {
	return {
		version: 1,
		loop: { id, name: id, description: "", maxPasses: 0, plan: "none", planReviewer: null, finish: "review", stages: [] },
		plan: "unused",
		status: "idle",
		pass: 0,
		stage: null,
		nodes: {},
		findings: [],
		gate: { open: false, reason: null },
		note: `Loop ${id}: ${message}`,
		history: [],
		reviews: [],
		pendingReview: null,
		updatedAt: new Date().toISOString(),
	};
}

function isCommand(data: unknown): data is ControlCommand {
	return typeof data === "object" && data !== null && "type" in data && typeof data.type === "string" && "reply" in data && typeof data.reply === "function";
}

export default function control(pi: ExtensionAPI) {
	// A reviewer's own omp run loads no loop of its own.
	if (process.env.OMP_CONTROL_REVIEWER === "1") return;
	const z = pi.zod;
	const artifactsDir = join(homedir(), ".omp", "cache", "control", "artifacts", crypto.randomUUID());
	let sessionCtx: ExtensionContext | null = null;
	let root: string | null = null;
	let attached: Attached | null = null;
	let attaching: Promise<void> | null = null;
	let library: Library | null = null;
	let server: ControlServer | null = null;
	let resumePort: number | null = null;
	let themeEpoch: number | null = null;
	let themeTimer: Timer | undefined;
	let lastNote: string | null = null;
	let lastPrompt: string | null = null;
	let planChecks: AbortController | null = null;
	let reviewOpened: string | null = null;

	const send = (text: string) => {
		if (!sessionCtx || sessionCtx.isIdle()) pi.sendUserMessage(text);
		else pi.sendUserMessage(text, { deliverAs: "followUp" });
	};

	const currentSha = async (): Promise<{ root: string; sha: string }> => {
		if (!root || !attached) throw new Error("No control loop is attached to this session.");
		const sha = await baselineSha(root, attached.baseline, (note) => {
			if (note === lastNote) return;
			lastNote = note;
			sessionCtx?.ui.notify(`Control: ${note}`, "warning");
		});
		return { root, sha };
	};

	const showWidget = (view: RunView | null) => {
		const ui = sessionCtx?.ui;
		if (!ui) return;
		if (!view) return ui.setWidget(WIDGET, undefined);
		const name = view.loop.name;
		let line: string;
		if (view.status === "checking") {
			const running = Object.entries(view.nodes)
				.filter(([, n]) => n.state === "running")
				.map(([id]) => view.loop.stages.flatMap((s) => s.nodes).find((n) => n.id === id)?.name ?? id);
			line = `Control · ${name} · checking: ${running.join(", ") || "…"}`;
		} else if (view.gate.open) {
			line = `Control · ${name} · ${view.findings.filter((f) => f.route === "ask" && !f.decision).length} findings need your decision`;
		} else if (view.status === "passed") line = `Control · ${name} · ✓ passed`;
		else {
			line = `Control · ${name} · ${STATUS_LABELS[view.status]}${view.pass ? ` · pass ${view.pass}/${view.loop.maxPasses}` : ""}`;
			if (view.note && (view.status === "paused" || view.status === "deferred" || view.status === "stalled" || view.status === "idle")) line += ` · ${view.note}`;
		}
		ui.setWidget(WIDGET, [line], { placement: "belowEditor" });
	};

	const ask = async (items: FindingView[], signal: AbortSignal): Promise<Record<string, Decision> | "pause" | null> => {
		const ctx = sessionCtx;
		if (!ctx?.hasUI) return null;
		const ui = ctx.ui;
		const out: Record<string, Decision> = {};
		if (ui.askDialog) {
			const result = await ui.askDialog(
				items.map((f) => ({
					id: f.id,
					header: `${f.nodeName}${f.recurring ? " · again" : ""}`,
					question: findingQuestion(f),
					options: f.question ? f.question.options.map((o) => ({ label: o })) : f.approval ? [{ label: APPROVE }, { label: SEND_BACK }] : [...(f.alternatives.length ? f.alternatives.map((a) => ({ label: a })) : [{ label: FIX }]), { label: DISMISS }],
					recommended: f.question ? Math.max(0, f.question.options.indexOf(f.question.chose)) : f.approval ? 0 : f.certain ? 0 : undefined,
				})),
				{ signal, helpText: GATE_HELP },
			);
			if (signal.aborted) return null;
			if (!result || result.kind === "chat") return "pause";
			for (const r of result.results) {
				const custom = r.customInput?.trim();
				const choice = r.selectedOptions[0];
				const item = items.find((f) => f.id === r.id);
				if (item?.question) {
					const answer = questionAnswer(item, custom || choice);
					if (answer) out[r.id] = answer;
					continue;
				}
				const alternative = item?.alternatives.includes(choice ?? "") ? choice : null;
				const decision = custom || alternative || choice === FIX || choice === SEND_BACK ? "fix" : choice === DISMISS || choice === APPROVE ? "dismiss" : null;
				if (!decision) continue;
				const note = [alternative ? `Fix it this way: ${alternative}` : null, custom, r.note?.trim()].filter(Boolean).join("\n");
				out[r.id] = note ? { decision, note } : { decision };
			}
			return out;
		}
		for (let i = 0; i < items.length; i++) {
			const f = items[i];
			const title = `${f.nodeName}${f.recurring ? " · again" : ""} (${i + 1}/${items.length})\n${findingQuestion(f)}`;
			if (f.question) {
				const choice = await ui.select(title, [...f.question.options, PAUSE], { signal, helpText: GATE_HELP, initialIndex: Math.max(0, f.question.options.indexOf(f.question.chose)) });
				if (signal.aborted) return null;
				if (!choice || choice === PAUSE) return "pause";
				const answer = questionAnswer(f, choice);
				if (answer) out[f.id] = answer;
				continue;
			}
			if (f.approval) {
				const choice = await ui.select(title, [APPROVE, SEND_BACK, PAUSE], { signal, helpText: GATE_HELP });
				if (signal.aborted) return null;
				if (!choice || choice === PAUSE) return "pause";
				const note = choice === SEND_BACK ? (await ui.input("What should change?", undefined, { signal }))?.trim() : undefined;
				out[f.id] = choice === APPROVE ? { decision: "dismiss" } : note ? { decision: "fix", note } : { decision: "fix" };
				continue;
			}
			const choice = await ui.select(title, [FIX, DISMISS, FIX_ALL, DISMISS_ALL, PAUSE], { signal, helpText: GATE_HELP });
			if (signal.aborted) return null;
			if (!choice || choice === PAUSE) return "pause";
			if (choice === FIX_ALL || choice === DISMISS_ALL) {
				for (const rest of items.slice(i)) out[rest.id] = { decision: choice === FIX_ALL ? "fix" : "dismiss" };
				break;
			}
			out[f.id] = { decision: choice === FIX ? "fix" : "dismiss" };
		}
		return out;
	};

	const deps: ControllerDeps = {
		fingerprint: async () => {
			const at = await currentSha();
			return fingerprint(at.root, at.sha);
		},
		packet: async () => {
			const at = await currentSha();
			return { ...(await reviewPacket(at.root, at.sha)), baseline: at.sha };
		},
		changes: async () => {
			const at = await currentSha();
			return changedFiles(at.root, at.sha);
		},
		runCheck: async (node, signal) => {
			const at = await currentSha();
			return runCheck((command, args, options) => pi.exec(command, args, options), node, at.root, at.sha, join(artifactsDir, node.id), signal);
		},
		runReview: (node, packet, signal, progress) => runReviewer(node, root ?? ".", { system: reviewerSystemPrompt(node), packet }, signal, progress),
		hasUI: () => sessionCtx?.hasUI === true,
		ask,
		emit: (view) => {
			pi.events.emit(RUN_EVENT, view);
			server?.notify();
			showWidget(view);
			// When your review is due and nobody has the Control page open, it opens on the review.
			const review = view?.gate.open ? view.findings.find((f) => f.approval && !f.decision) : undefined;
			if (review && review.id !== reviewOpened && (!server || server.clients() === 0)) {
				reviewOpened = review.id;
				void openPage().catch(() => {});
			}
		},
		persist: (checkpoint) => pi.appendEntry(STATE_ENTRY, checkpoint),
		now: () => new Date().toISOString(),
	};
	const controller = new Controller(deps);

	const refreshLibrary = async (): Promise<Library> => {
		library = await loadLibrary(root);
		return library;
	};

	const emitLibrary = async () => {
		const lib = await refreshLibrary();
		pi.events.emit(LIBRARY_EVENT, summarize(lib, root));
		server?.notify();
	};

	const activate = async (on: boolean) => {
		const tools = pi.getActiveTools();
		if (tools.includes(TOOL) === on) return;
		await pi.setActiveTools(on ? [...tools, TOOL] : tools.filter((t) => t !== TOOL));
	};

	/** A flow that plans starts each request in plan mode: enter it whenever the session is idle outside it. */
	const armPlan = (ctx: ExtensionContext | null) => {
		const modes = ctx?.sessionModes;
		if (!attached || attached.loop.plan === "none" || !modes || controller.paused) return;
		void (async () => {
			// omp refuses mode changes while a turn is settling ("busy"); the session is idle a moment later.
			for (let attempt = 0; attempt < 20 && attached && attached.loop.plan !== "none" && modes.getState().plan.status === "inactive"; attempt++) {
				const r = await modes.set({ mode: "plan", action: "enter" }).catch(() => null);
				if (!r || r.ok || r.code !== "busy") return;
				await Bun.sleep(250);
			}
		})();
	};

	const setLoop = async (next: Attached) => {
		attached = next;
		lastNote = null;
		controller.attach(next.loop, next.source, next.baseline);
		pi.appendEntry<LoopEntry>(LOOP_ENTRY, next);
		await activate(true);
		armPlan(sessionCtx);
	};

	const detach = async () => {
		attached = null;
		controller.detach();
		pi.appendEntry<LoopEntry>(LOOP_ENTRY, { loop: null, source: null, baseline: null });
		await activate(false);
	};

	/** Where a newly attached loop measures from: the Orchestrator's base, else where the branch left its default branch, else HEAD. */
	const startBaseline = async (at: string): Promise<Baseline> => {
		const ref = process.env.OMP_CONTROL_BASE ?? (await defaultBranch(at));
		if (ref) return { kind: "merge-base", ref };
		const head = await git(["rev-parse", "HEAD"], at);
		if (head.code !== 0) throw new Error("Control loops need a commit to compare against");
		return { kind: "commit", sha: head.stdout.trim() };
	};

	/** Runs the loop on the code as it is now, even when it already passed; the agent fixes what it finds. */
	const checkNow = () => {
		if (!attached) throw new Error("No control loop is attached to this session.");
		controller.recheck();
		send(CHECK_REQUEST);
	};

	/** Starts the loop right away when there is already code to check, so attaching to finished work reviews it. */
	const startIfChanged = async () => {
		if (!attached || controller.paused || attached.loop.plan !== "none") return;
		if ((await deps.fingerprint().catch(() => "clean")) !== "clean") checkNow();
	};

	const attach = async (cwd: string, id: string): Promise<LoopSnapshot> => {
		const at = await repoRoot(cwd);
		if (!at) throw new Error("Control loops need a git repository");
		root = at;
		const lib = await refreshLibrary();
		const loop = resolveLoop(lib, id);
		await setLoop({ loop, source: `${lib.loops.get(id)?.source ?? "repo"}:${id}`, baseline: await startBaseline(at) });
		await startIfChanged();
		return loop;
	};

	/** Measures the attached loop from `ref` (a branch: where HEAD left it; a commit: that commit) and checks the code since. */
	const since = async (ref: string): Promise<string> => {
		if (!attached || !root) throw new Error("No control loop is attached to this session.");
		const name = ref.trim();
		if (!name || !(await isCommit(root, name))) throw new Error(`${name || "That"} isn't a branch or commit in this repository`);
		await setLoop({ ...attached, baseline: { kind: "merge-base", ref: name } });
		await startIfChanged();
		return sinceLabel();
	};

	/** What the loop checks, in words: "since main · 3 commits and uncommitted changes". */
	const sinceLabel = async (): Promise<string> => {
		if (!attached || !root) return "";
		const at = await currentSha();
		const from = attached.baseline.kind === "merge-base" ? attached.baseline.ref : at.sha.slice(0, 7);
		const [commits, dirty] = await Promise.all([commitsSince(at.root, at.sha), git(["status", "--porcelain"], at.root).then((r) => r.stdout.trim() !== "")]);
		const parts = [commits ? `${commits} commit${commits === 1 ? "" : "s"}` : null, dirty ? "uncommitted changes" : null].filter(Boolean);
		return `since ${from} · ${parts.length ? parts.join(" and ") : "no changes yet"}`;
	};

	// --- page

	const syncAppearance = async (force = false) => {
		if (!themeApi) return;
		const epoch = omp.getThemeEpoch();
		if (!server || (epoch === themeEpoch && !force)) return;
		themeEpoch = epoch;
		const [theme, terminal] = await Promise.all([currentTheme(omp), terminalConfig()]);
		if (themeEpoch === epoch) server?.setAppearance(toAppearance(theme, terminal));
	};

	/** Asks git-diff-review in this omp over the shared bus; without an answer in time it isn't loaded. */
	const askReview = (request: { type: "probe" } | { type: "open"; base: string }): Promise<ReviewReply> => {
		const { promise, resolve } = Promise.withResolvers<ReviewReply>();
		const timer = setTimeout(() => resolve({ ok: false, message: "git-diff-review isn't loaded in this omp" }), request.type === "probe" ? REVIEW_PROBE_MS : REVIEW_OPEN_MS);
		pi.events.emit(REVIEW_EVENT, {
			...request,
			reply: (r: ReviewReply) => {
				clearTimeout(timer);
				resolve(r);
			},
		});
		return promise;
	};
	let reviewProbe: Promise<boolean> | null = null;
	const reviewLoaded = () => (reviewProbe ??= askReview({ type: "probe" }).then((r) => r.ok));

	const state = async (): Promise<StatePayload> => {
		const lib = library ?? (await refreshLibrary());
		return {
			session: { name: pi.getSessionName() || "omp", cwd: sessionCtx?.cwd ?? process.cwd(), repo: root, idle: sessionCtx?.isIdle() ?? true },
			attached: await (async () => {
				const snap = controller.snapshot();
				return snap ? { ...snap, since: await sinceLabel().catch(() => "") } : null;
			})(),
			run: controller.view(),
			review: await reviewLoaded(),
			library: {
				loops: [...lib.loops.values()].map((e) => ({ ...e.loop, source: e.source, path: e.path, overrides: e.overrides })),
				nodes: [...lib.nodes.values()].map((e) => ({ ...e.node, source: e.source, path: e.path, overrides: e.overrides })),
				errors: lib.errors,
			},
		};
	};

	const ensureServer = async (port: number | null): Promise<ControlServer> => {
		if (!server) {
			server = startControlServer(
				{
					state,
					attach: async (id) => {
						if (id === null) await detach();
						else await attach(sessionCtx?.cwd ?? process.cwd(), id);
					},
					setSessionLoop: async (loop) => {
						const at = root ?? (await repoRoot(sessionCtx?.cwd ?? process.cwd()));
						if (!at) throw new Error("Control loops need a git repository");
						root = at;
						await setLoop({ loop, source: "session", baseline: attached?.baseline ?? (await startBaseline(at)) });
					},
					saveLoop: async (scope, loop, nodes) => {
						const paths: string[] = [];
						for (const node of nodes) paths.push(await saveNode(root, scope, node));
						paths.push(await saveLoop(root, scope, loop, await refreshLibrary()));
						await emitLibrary();
						return paths;
					},
					saveNode: async (scope, node) => {
						const path = await saveNode(root, scope, node);
						await emitLibrary();
						return path;
					},
					deleteItem: async (kind, scope, id) => {
						await deleteItem(root, scope, kind, id);
						await emitLibrary();
					},
					copyItem: async (kind, id, to, move) => {
						const path = await copyItem(root, await refreshLibrary(), kind, id, to, move);
						await emitLibrary();
						return path;
					},
					changes: () => deps.changes(),
					review: async () => {
						const r = await askReview({ type: "open", base: (await currentSha()).sha });
						if (!r.ok) throw new Error(r.message);
					},
					decide: (decisions, pause) => controller.decide(decisions, pause),
					send,
					check: checkNow,
					since,
					setPaused: (paused) => controller.setPaused(paused),
				},
				{ ports: port ? [port, ...DEFAULT_PORTS] : DEFAULT_PORTS },
			);
			if (themeApi) themeTimer = setInterval(() => syncAppearance(), 1000);
		}
		if (themeApi) await syncAppearance(true);
		return server;
	};

	const recordedPort = (ctx: ExtensionContext): number | null => {
		let port: number | null = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === SERVER_ENTRY && typeof entry.data?.port === "number") port = entry.data.port;
		}
		return port;
	};

	const openPage = async () => {
		const page = await ensureServer(null);
		if (sessionCtx && recordedPort(sessionCtx) !== page.port) pi.appendEntry(SERVER_ENTRY, { port: page.port });
		await openBoard(page.url(), { focus: true });
		return page.url();
	};

	// --- session state

	const restore = async (ctx: ExtensionContext, withServer: boolean) => {
		sessionCtx = ctx;
		root = await repoRoot(ctx.cwd);
		library = null;
		let entry: LoopEntry | undefined;
		let checkpoint: Checkpoint | null = null;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type !== "custom") continue;
			if (e.customType === LOOP_ENTRY) {
				entry = e.data as LoopEntry; // written by setLoop/detach above
				checkpoint = null;
			} else if (e.customType === STATE_ENTRY) checkpoint = e.data as Checkpoint; // written by deps.persist
		}
		const envLoop = process.env.OMP_CONTROL_LOOP;
		if (entry === undefined && envLoop) {
			attaching = attach(ctx.cwd, envLoop).then(
				() => {},
				(e) => {
					ctx.ui.notify(`Control: loop ${envLoop}: ${errorText(e)}`, "error");
					deps.emit(failedView(envLoop, errorText(e)));
				},
			);
		} else {
			attached = entry?.loop && entry.source && entry.baseline ? { loop: savedSnapshot(entry.loop), source: entry.source, baseline: entry.baseline } : null;
			controller.restore(attached, attached ? checkpoint : null);
			await activate(attached !== null);
			armPlan(ctx);
		}
		if (withServer) {
			const port = resumePort ?? recordedPort(ctx);
			resumePort = null;
			if (port !== null) await ensureServer(port);
		}
		await emitLibrary();
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		await restore(ctx, true);
	});
	const follow = async (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.agent?.kind === "sub") return;
		await restore(ctx, !server);
	};
	pi.on("session_switch", follow);
	pi.on("session_branch", follow);
	pi.on("session_tree", follow);

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		sessionCtx = ctx;
		if (!("prompt" in event) || typeof event.prompt !== "string" || !event.prompt.trim()) return;
		await attaching;
		if (!attached) return;
		const fp = await deps.fingerprint().catch(() => "unknown");
		// Policy retries prepare the same submission again; record it once.
		if (lastPrompt !== `${fp}\0${event.prompt}`) {
			lastPrompt = `${fp}\0${event.prompt}`;
			controller.onUserPrompt(fp, event.prompt);
			if (controller.view()?.pendingReview) {
				ctx.ui.notify("Control: your review is still waiting on the Control page; it now covers this request too", "warning");
				if (!server || server.clients() === 0) void openPage().catch(() => {});
			}
		}
		if (controller.paused) return;
		return { message: { customType: CONTEXT_TYPE, content: contextMessage(attached.loop), display: false, attribution: "agent" } };
	});

	pi.on("mode_changed", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		const plan = controller.view()?.plan;
		if (event.state.plan.status === "active" && event.previous.plan.status !== "active") controller.onPlan("planning");
		else if (event.previous.plan.status === "active" && event.state.plan.status !== "active" && plan === "planning") controller.onPlan("unused");
	});

	pi.on("plan_review_requested", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		controller.onPlan("review", event.planContent);
		if (attached?.loop.plan !== "ai") return;
		// The review's handlers must return quickly; the reviewer runs after, and answers the review when it's done.
		planChecks?.abort();
		const ctl = new AbortController();
		planChecks = ctl;
		void controller.checkPlan(event.planContent, ctl.signal).then(
			(r) => {
				const review = ctx.getPendingPlanReview();
				if (ctl.signal.aborted || !review || review.reviewId !== event.reviewId) return;
				if (r.action === "refine") ctx.resolvePlanReview(event.reviewId, "refine", { feedback: r.feedback });
				else if (r.action === "approve") {
					// The first approving choice, as Enter would pick.
					const choice = review.options.find((o) => !o.disabled && PLAN_APPROVALS[o.id]);
					if (!choice || !ctx.resolvePlanReview(event.reviewId, choice.id)) ctx.ui.notify("Control: the plan reviewer passed the plan, but omp took no approval; approve it yourself", "warning");
				} else if (r.reason) ctx.ui.notify(`Control: ${r.reason}; approve the plan or send it back`, "warning");
			},
			(e) => ctx.ui.notify(`Control: the plan review failed: ${errorText(e)}`, "warning"),
		);
	});

	pi.on("plan_review_resolved", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		if (PLAN_APPROVALS[event.choice]) controller.onPlan("approved");
		else if (event.choice === "refine") controller.onPlan("planning");
		else controller.onPlan(ctx.sessionModes?.getState().plan.status === "active" ? "planning" : "unused");
	});

	pi.on("agent_end", (event, ctx) => {
		if (ctx.agent?.kind === "sub" || ("willContinue" in event && event.willContinue === true)) return;
		sessionCtx = ctx;
		armPlan(ctx);
	});

	pi.on("session_stop", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		sessionCtx = ctx;
		if (!attached || controller.paused || ctx.sessionModes?.getState().plan.status === "active") return;
		let fp: string;
		try {
			fp = await deps.fingerprint();
		} catch {
			return;
		}
		const d = controller.stopDecision(fp);
		if (!d.block && d.stalled) ctx.ui.notify("Control: the agent ended its turn three times without running control_check; the loop let it stop", "warning");
		return d.block ? { decision: "block" as const, reason: d.reason } : undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		controller.abort();
		planChecks?.abort();
		clearInterval(themeTimer);
		themeTimer = undefined;
		themeEpoch = null;
		await rm(artifactsDir, { recursive: true, force: true });
		if (!server) return;
		resumePort = server.port;
		server.stop();
		server = null;
	});

	pi.events.on(COMMAND_EVENT, async (data) => {
		if (!isCommand(data)) return;
		try {
			if (data.type === "library") data.reply({ ok: true, message: "", library: summarize(await refreshLibrary(), root) });
			else if (data.type === "run") data.reply({ ok: true, message: "", run: controller.view() });
			else if (data.type === "decide") data.reply(controller.decide(data.decisions ?? {}, data.pause === true));
			else if (data.type === "open") {
				// The terminal helper can outlast the asker's wait; a failure shows in this session instead.
				data.reply({ ok: true, message: "Opening Control" });
				void openPage().catch((e) => sessionCtx?.ui.notify(`Control: ${errorText(e)}`, "error"));
			}
		} catch (e) {
			data.reply({ ok: false, message: errorText(e) });
		}
	});

	// --- tools

	pi.registerTool({
		name: TOOL,
		label: "Control check",
		description:
			"Run this session's control loop on your changes: its checks and focused reviewers measure the change since the loop started and return findings to fix. Call it when your implementation is complete, before your final answer; fix what it returns and call it again until it passes. When you made a choice you weren't sure of (an approach, a name, a UI variant, an assumption about behavior), don't stop to ask: keep going and list it in questions with the options you considered and the one you chose; the user answers them all at once at the end, and a different answer comes back to you as a fix. If you must end your turn before finishing (you're blocked), pass incomplete with the reason instead. Never edit files under .omp/control to make the loop pass.",
		parameters: z.object({
			incomplete: z.string().optional().describe("Why you're ending your turn before the work is complete"),
			questions: z
				.array(z.object({ question: z.string(), options: z.array(z.string()).min(2), chose: z.string() }))
				.max(10)
				.optional()
				.describe("Choices you weren't sure of, with the options you considered and the one you went with"),
		}),
		loadMode: "essential",
		defaultInactive: true,
		approval: "exec",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			sessionCtx = ctx;
			const text = await controller.check({
				incomplete: params.incomplete,
				questions: params.questions,
				signal: signal ?? new AbortController().signal,
				progress: (t) => onUpdate?.({ content: [{ type: "text", text: t }], details: undefined }),
			});
			return { content: [{ type: "text" as const, text }], details: controller.view() };
		},
	});

	const nodeShape = z.object({
		name: z.string(),
		kind: z.enum(["check", "review"]),
		description: z.string().optional(),
		command: z.string().optional(),
		timeout: z.number().int().optional(),
		ask: z.enum(["doubts", "all", "never"]).optional(),
		model: z.string().optional(),
		thinking: z.string().optional(),
		tools: z.array(z.string()).optional(),
		resources: z.array(z.string()).optional(),
		instructions: z.string().optional(),
	});
	const loopShape = z.object({
		name: z.string(),
		description: z.string().optional(),
		maxPasses: z.number().int().optional(),
		plan: z.enum(["none", "you", "ai"]).optional().describe('"none" (default): the agent implements right away; "you": it plans in omp plan mode and you approve the plan; "ai": planReviewer approves the plan'),
		planReviewer: z.string().optional().describe('The reviewer node that approves the plan; only with plan "ai"'),
		stages: z.array(z.object({ nodes: z.array(z.string()) })),
		finish: z.enum(["review", "auto"]).optional().describe('"review" (default): you review the final change; "auto": done once the checks pass, and a local Orchestrator task merges'),
	});

	pi.registerTool({
		name: "control_library",
		label: "Control library",
		description:
			"Read or save Control loops and nodes. list shows the library: repo (.omp/control, committed), global (~/.omp/control, every repo), built-in; a repo item overrides a global one with the same id, which overrides a built-in. read returns one definition with its path; save writes a node (a check: a shell command that must exit 0 from the repository root; a reviewer: focused instructions plus resources to read first) or a loop (stages of node ids; nodes in a stage run together). Use it when the user asks to create or change a loop or node: research the project's conventions first, and save to the repo scope unless they say global.",
		parameters: z.object({
			action: z.enum(["list", "read", "save"]),
			kind: z.enum(["node", "loop"]).optional(),
			id: z.string().optional(),
			scope: z.enum(["repo", "global"]).optional(),
			node: nodeShape.optional(),
			loop: loopShape.optional(),
		}),
		approval: (args: unknown) => (args && typeof args === "object" && "action" in args && args.action === "save" ? "write" : "read"),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			sessionCtx = ctx;
			try {
				root ??= await repoRoot(ctx.cwd);
				const lib = await refreshLibrary();
				if (params.action === "list") {
					const loops = [...lib.loops.values()].map(({ loop, source }) => {
						const names = { stages: loop.stages.map((s) => ({ nodes: s.nodes.map((id) => ({ name: id })) })) };
						return `- ${loop.id} · ${loop.name} (${source}) — ${stagesText(names)}`;
					});
					const nodes = [...lib.nodes.values()].map(({ node, source }) => `- ${node.id} · ${node.name} · ${node.kind} (${source})`);
					const parts = [`Loops:\n${loops.join("\n") || "(none)"}`, `Nodes:\n${nodes.join("\n") || "(none)"}`];
					if (lib.errors.length) parts.push(`Files with errors:\n${lib.errors.map((e) => `- ${e.message}`).join("\n")}`);
					return reply(parts.join("\n\n"));
				}
				if (!params.kind || !params.id) return reply(`${params.action} needs kind and id`, true);
				if (params.action === "read") {
					const entry = params.kind === "node" ? lib.nodes.get(params.id) : lib.loops.get(params.id);
					if (!entry) return reply(`No ${params.kind} ${params.id} in the library`, true);
					return reply(`${entry.path} (${entry.source})\n\n${await Bun.file(entry.path).text()}`);
				}
				const scope = params.scope ?? (root ? "repo" : "global");
				let path: string;
				if (params.kind === "node") {
					if (!params.node) return reply("save of a node needs node", true);
					const node = nodeFrom(params.id, params.node, params.node.instructions ?? "", `node ${params.id}`);
					path = await saveNode(root, scope, node);
				} else {
					if (!params.loop) return reply("save of a loop needs loop", true);
					path = await saveLoop(root, scope, loopFrom(params.id, params.loop, `loop ${params.id}`), lib);
				}
				const existed = (params.kind === "node" ? lib.nodes.get(params.id) : lib.loops.get(params.id))?.path === path;
				await emitLibrary();
				return reply(existed ? `Updated ${params.kind} ${params.id} at ${path}` : `Saved ${params.kind} ${params.id} to ${path}`);
			} catch (e) {
				return reply(errorText(e), true);
			}
		},
	});

	pi.registerTool({
		name: "control_attach",
		label: "Control attach",
		description: 'Attach a library loop to this session (or "none" to detach) when the user asks to use one; it then checks your changes before you finish.',
		parameters: z.object({ loop: z.string() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			sessionCtx = ctx;
			try {
				if (params.loop === "none") {
					await detach();
					return reply("Detached the control loop");
				}
				const loop = await attach(ctx.cwd, params.loop);
				return reply(`Attached «${loop.name}» (${stagesText(loop)}). Call control_check when your implementation is complete.`);
			} catch (e) {
				return reply(errorText(e), true);
			}
		},
	});

	pi.registerTool({
		name: "control_status",
		label: "Control status",
		description: "Show this session's control loop: its stages, the current pass and the latest findings.",
		parameters: z.object({}),
		approval: "read",
		async execute() {
			return reply(statusText(controller.view()));
		},
	});

	// --- command

	pi.registerCommand("control", {
		description: USAGE,
		getArgumentCompletions(argumentPrefix) {
			const normalized = argumentPrefix.trimStart().toLowerCase();
			if (/\s/.test(normalized)) return null;
			if (!normalized) return COMMANDS;
			const matches = COMMANDS.filter((command) => command.value.startsWith(normalized));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			if (ctx.agent?.kind === "sub") return;
			sessionCtx = ctx;
			const [verb = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				switch (verb.toLowerCase()) {
					case "":
					case "open":
						ctx.ui.notify(`Control open at ${await openPage()}`, "info");
						break;
					case "use": {
						let id = rest[0];
						if (!id) {
							root ??= await repoRoot(ctx.cwd);
							const loops = [...(await refreshLibrary()).loops.values()].map((e) => e.loop);
							if (!loops.length) throw new Error("The library has no loops");
							const labels = loops.map((l) => `${l.name} (${l.id})`);
							const choice = await ctx.ui.select("Attach a control loop", labels);
							if (!choice) return;
							id = loops[labels.indexOf(choice)].id;
						}
						const loop = await attach(ctx.cwd, id);
						ctx.ui.notify(`Control: «${loop.name}» checks this session's changes (${stagesText(loop)})`, "info");
						break;
					}
					case "off":
						await detach();
						ctx.ui.notify("Control: loop detached", "info");
						break;
					case "pause":
					case "resume":
						if (!attached) throw new Error("No control loop is attached to this session.");
						controller.setPaused(verb.toLowerCase() === "pause");
						ctx.ui.notify(`Control: loop ${verb.toLowerCase() === "pause" ? "paused" : "resumed"}`, "info");
						break;
					case "status":
						ctx.ui.notify(statusText(controller.view()), "info");
						break;
					case "check":
						checkNow();
						break;
					case "since": {
						const ref = rest.join(" ").trim();
						if (!ref) throw new Error("Say where to measure from: /control since <branch or commit>");
						ctx.ui.notify(`Control: checking ${await since(ref)}`, "info");
						break;
					}
					case "draft": {
						const intent = rest.join(" ").trim();
						if (!intent) throw new Error("Say what it should check: /control draft <what it should check>");
						root ??= await repoRoot(ctx.cwd);
						send(draftPrompt({ intent, scope: root ? "repo" : "global" }));
						break;
					}
					default:
						ctx.ui.notify(USAGE, "warning");
				}
			} catch (e) {
				ctx.ui.notify(errorText(e), "error");
			}
		},
	});
}
