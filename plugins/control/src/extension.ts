// Control for omp: /control picks checks and reviewers that audit the session's change, once or after every change.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText, toolReply } from "omp-integrations/text";
import { type Baseline, baselineSha, defaultBranch, fingerprint, git, repoRoot } from "./git";
import { type ControlDefinition, type Library, loadLibrary } from "./library";
import { NUDGE, RUN_HEAD, runPrompt } from "./prompts";
import { empty, line, onReport, onStop, restored, type Selection, type State } from "./run";

const ENTRY = "control.session";
const WIDGET = "control";
const TOOL = "control_report";
const PICK = "Pick controls…";
const AUTO_OFF = "Turn auto off";
const ONCE = "Run once";
const AUTO = "Auto: after each request that changes code";
const APPLY = "Apply right away";
const ASK = "Ask me before applying";

/** Where a change is measured from: where the branch left its default branch, else HEAD. */
async function startBaseline(at: string): Promise<Baseline> {
	const ref = await defaultBranch(at);
	if (ref) return { kind: "merge-base", ref };
	const head = await git(["rev-parse", "HEAD"], at);
	if (head.code !== 0) throw new Error("Control needs a commit to compare against");
	return { kind: "commit", sha: head.stdout.trim() };
}

export default function control(pi: ExtensionAPI) {
	const z = pi.zod;
	let sessionCtx: ExtensionContext | null = null;
	let root: string | null = null;
	let state: State = empty();
	let promptFingerprint: string | null = null;
	let lastNote: string | null = null;

	const notify = (message: string, type: "info" | "warning" | "error") => sessionCtx?.ui.notify(message, type);

	const persist = () => {
		const { baseline, auto, settled, last } = state;
		pi.appendEntry(ENTRY, { baseline, auto, settled, last });
	};

	const show = () => {
		const l = line(state);
		sessionCtx?.ui.setWidget(WIDGET, l ? [l] : undefined, { placement: "belowEditor" });
	};

	const activate = async () => {
		const on = state.auto !== null || state.run !== null;
		const tools = pi.getActiveTools();
		if (tools.includes(TOOL) === on) return;
		await pi.setActiveTools(on ? [...tools, TOOL] : tools.filter((t) => t !== TOOL));
	};

	const refresh = async () => {
		persist();
		await activate();
		show();
	};

	/** The repository and the commit its change is measured from. */
	const base = async (): Promise<{ at: string; sha: string }> => {
		const at = root;
		if (!at) throw new Error("Control needs a git repository");
		state.baseline ??= await startBaseline(at);
		const sha = await baselineSha(at, state.baseline, (note) => {
			if (note === lastNote) return;
			lastNote = note;
			notify(`Control: ${note}`, "warning");
		});
		return { at, sha };
	};

	const currentFingerprint = async () => {
		const { at, sha } = await base();
		return fingerprint(at, sha);
	};

	const send = (text: string) => {
		if (!sessionCtx || sessionCtx.isIdle()) pi.sendUserMessage(text);
		else pi.sendUserMessage(text, { deliverAs: "followUp" });
	};

	/** The selection's controls still in the library: checks first, then reviewers, each group in selection order. */
	const definitions = (lib: Library, selection: Selection): ControlDefinition[] => {
		const missing = selection.controls.filter((id) => !lib.controls.has(id));
		if (missing.length) notify(`Control: ${missing.join(", ")} not in the library anymore; skipped`, "warning");
		const found = selection.controls.flatMap((id) => lib.controls.get(id) ?? []);
		return [...found.filter((c) => c.kind === "check"), ...found.filter((c) => c.kind === "review")];
	};

	const startRun = async (selection: Selection) => {
		const controls = definitions(await loadLibrary(root), selection);
		if (!controls.length) {
			notify("Control: none of the selected controls exist anymore", "error");
			if (state.auto === selection) state.auto = null;
			return refresh();
		}
		const { at, sha } = await base();
		if ((await fingerprint(at, sha)) === "clean") {
			notify(`Control: nothing to check, no changes since ${sha.slice(0, 7)}`, "info");
			return refresh();
		}
		state.run = { selection, nudges: 0, delivered: false };
		await refresh();
		send(runPrompt({ base: sha, approval: selection.approval, controls }));
	};

	const restore = async (ctx: ExtensionContext) => {
		sessionCtx = ctx;
		root = await repoRoot(ctx.cwd);
		promptFingerprint = null;
		lastNote = null;
		let saved: Partial<State> | undefined;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "custom" && e.customType === ENTRY) saved = e.data as Partial<State>; // written by persist
		}
		state = restored(saved);
		await activate();
		show();
	};

	const follow = async (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.agent?.kind === "sub") return;
		await restore(ctx);
	};
	pi.on("session_start", follow);
	pi.on("session_switch", follow);
	pi.on("session_branch", follow);
	pi.on("session_tree", follow);

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		sessionCtx = ctx;
		if (!("prompt" in event) || typeof event.prompt !== "string" || !event.prompt.trim()) return;
		promptFingerprint = state.auto ? await currentFingerprint().catch(() => null) : null;
		const run = state.run;
		if (!run) return;
		// The run's own prompt, and the nudge that sends the agent back to it, keep it going; any other prompt means the user moved on.
		if (event.prompt.startsWith(RUN_HEAD) || event.prompt.startsWith(NUDGE)) run.delivered = true;
		else if (run.delivered) {
			state.run = null;
			await activate();
			show();
		}
	});

	pi.on("session_stop", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		sessionCtx = ctx;
		if ((!state.auto && !state.run) || ctx.sessionModes?.getState().plan.status === "active") return;
		let sha: string;
		let fp: string;
		try {
			const from = await base();
			sha = from.sha;
			fp = await fingerprint(from.at, sha);
		} catch {
			return;
		}
		const stop = onStop(state, fp, promptFingerprint);
		if (stop.kind === "nudge") return { decision: "block" as const, reason: NUDGE };
		if (stop.kind === "stalled") {
			await refresh();
			ctx.ui.notify("Control: the agent stopped twice without finishing the run; start it again with /control", "warning");
			return;
		}
		if (stop.kind !== "start") return;
		const controls = definitions(await loadLibrary(root), stop.selection);
		if (!controls.length) {
			state.run = null;
			state.auto = null;
			await refresh();
			ctx.ui.notify("Control: none of the selected controls exist anymore", "error");
			return;
		}
		show();
		return { decision: "block" as const, reason: runPrompt({ base: sha, approval: stop.selection.approval, controls }) };
	});

	pi.registerTool({
		name: TOOL,
		label: "Control report",
		description: "Report the end of the control run in progress: call it once, when its last pass is done or you can't finish it. passed is true only when the last pass came back clean.",
		parameters: z.object({ passed: z.boolean() }),
		loadMode: "essential",
		defaultInactive: true,
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			sessionCtx = ctx;
			const done = onReport(state, await currentFingerprint(), params.passed);
			if (!done) return toolReply("No control run is in progress.", true);
			await refresh();
			ctx.ui.notify(`Control: ${done.label} ${params.passed ? "passed" : "didn't pass"}`, params.passed ? "info" : "warning");
			return toolReply(params.passed ? "Recorded: the controls passed. Give your final answer." : "Recorded: the controls didn't pass. Say what is left in your final answer.");
		},
	});

	pi.registerCommand("control", {
		description: "Control: pick a set or controls to check the change, once or after every change",
		handler: async (_args, ctx) => {
			if (ctx.agent?.kind === "sub") return;
			sessionCtx = ctx;
			try {
				root ??= await repoRoot(ctx.cwd);
				if (!root) throw new Error("Control needs a git repository");
				const lib = await loadLibrary(root);
				for (const e of lib.errors) ctx.ui.notify(`Control: ${e.message}`, "warning");
				const controls = [...lib.controls.values()];
				if (!controls.length) throw new Error("The control library is empty");
				const sets = [...lib.sets.values()].sort((a, b) => a.name.localeCompare(b.name));
				const setLabel = (s: { id: string; name: string }) => `${s.name} (${s.id})`;
				const choice = await ctx.ui.select("Control", [
					...sets.map((s) => ({
						label: setLabel(s),
						description: `${s.controls.map((id) => lib.controls.get(id)?.name ?? id).join(", ")} · ${s.approval === "ask" ? "asks before applying" : "applies right away"}`,
					})),
					{ label: PICK, description: `Choose among ${controls.length} controls` },
					...(state.auto ? [{ label: AUTO_OFF, description: `Auto runs ${state.auto.label}` }] : []),
				]);
				if (!choice) return;
				if (choice === AUTO_OFF) {
					state.auto = null;
					await refresh();
					ctx.ui.notify("Control: auto is off", "info");
					return;
				}
				let selection: Selection;
				let auto: boolean;
				const set = sets.find((s) => setLabel(s) === choice);
				if (set) {
					selection = { label: set.name, controls: set.controls, approval: set.approval };
					const when = await ctx.ui.select(`Run «${set.name}»`, [ONCE, AUTO]);
					if (!when) return;
					auto = when === AUTO;
				} else {
					if (!ctx.ui.askDialog) throw new Error("Picking controls needs omp's interactive terminal");
					const result = await ctx.ui.askDialog([
						{ id: "controls", header: "Controls", question: "Which controls?", multi: true, options: controls.map((c) => ({ label: setLabel(c), description: c.description })) },
						{ id: "approval", header: "Findings", question: "What happens to findings?", options: [{ label: APPLY }, { label: ASK }], recommended: 0 },
						{ id: "when", header: "When", question: "When do they run?", options: [{ label: ONCE }, { label: AUTO }], recommended: 0 },
					]);
					if (!result || result.kind === "chat") return;
					const picked = (id: string) => result.results.find((r) => r.id === id)?.selectedOptions ?? [];
					const ticked = controls.filter((c) => picked("controls").includes(setLabel(c)));
					if (!ticked.length) return;
					selection = { label: ticked.map((c) => c.name).join(", "), controls: ticked.map((c) => c.id), approval: picked("approval")[0] === ASK ? "ask" : "apply" };
					auto = picked("when")[0] === AUTO;
				}
				if (auto) state.auto = selection;
				await startRun(selection);
			} catch (e) {
				ctx.ui.notify(errorText(e), "error");
			}
		},
	});
}
