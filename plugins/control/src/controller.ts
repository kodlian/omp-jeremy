import type { ControlReply, Decision, FindingView, NodeState, PlanState, PendingReview, ReviewRecord, RunStatus, RunView } from "omp-control-view/protocol";
import type { Baseline, ChangedFile } from "./git";
import { type LoopSnapshot, type NodeDefinition, shape } from "./library";
import { fixMessage, judgmentCalls, passedMessage, planPacketText, type RawFinding, reviewPacketText, reviewSummary, stopReason } from "./prompts";
import type { NodeOutcome } from "./sensors";

export interface ControllerDeps {
	fingerprint(): Promise<string>;
	packet(): Promise<{ stat: string; diff: string; truncated: boolean; baseline: string }>;
	/** Every file the change touches, for the summary your final review shows. */
	changes(): Promise<ChangedFile[]>;
	runCheck(node: NodeDefinition, signal: AbortSignal): Promise<NodeOutcome>;
	runReview(node: NodeDefinition, packetText: string, signal: AbortSignal, progress: (d: string) => void): Promise<NodeOutcome>;
	hasUI(): boolean;
	ask(items: FindingView[], signal: AbortSignal): Promise<Record<string, Decision> | "pause" | null>;
	emit(view: RunView | null): void;
	persist(checkpoint: Checkpoint): void;
	now(): string;
}

type Settled = { fingerprint: string; kind: "passed" | "accepted" | "deferred" | "stalled" };
type History = RunView["history"][number];
type NodeView = RunView["nodes"][string];

export interface Checkpoint {
	baseline: Baseline;
	paused: boolean;
	settled: Settled | null;
	promptFingerprint: string | null;
	pass: number;
	sentToFix: Remembered[];
	/** Every answer you gave this session; a finding you answered is never asked again. */
	answers: Answer[];
	blocks: number;
	prompts: string[];
	plan: string | null;
	planState: PlanState;
	/** How many times the plan reviewer read this request's plans; at the loop's limit the plan comes to you. */
	planRounds: number;
	status: RunStatus;
	history: History[];
	note: string | null;
	findings: FindingView[];
	reviews: ReviewRecord[];
	pendingReview: PendingReview | null;
}

export interface AttachedLoop {
	loop: LoopSnapshot;
	source: string;
	baseline: Baseline;
}

const MAX_BLOCKS = 3;
const EMIT_MS = 250;
const PROMPT_LIMIT = 3000;
const PLAN_LIMIT = 12_000;
const NOTE_LIMIT = 300;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A choice the implementing agent made without being sure, sent with control_check. */
export interface AgentQuestion {
	question: string;
	options: string[];
	chose: string;
}

/** The node id agent questions are remembered under. */
const AGENT = "@agent";
/** The node id of the end-of-loop review, for its tile in the diagram. */
const REVIEW = "@review";

/** A finding as the loop remembers it across passes: which check, which file, and what it was about. */
export interface Remembered {
	node: string;
	file: string | null;
	rule: string;
}

const remember = (f: Remembered): Remembered => ({ node: f.node, file: f.file, rule: f.rule });
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2) ?? []);

/** Reviewers re-run every pass and rephrase: same check and file, and most of the words of the shorter rule, is the same finding. */
function sameFinding(a: Remembered, b: Remembered): boolean {
	if (a.node !== b.node || (a.file ?? "") !== (b.file ?? "")) return false;
	if (a.rule.trim().toLowerCase() === b.rule.trim().toLowerCase()) return true;
	const [x, y] = [words(a.rule), words(b.rule)];
	if (!x.size || !y.size) return false;
	let shared = 0;
	for (const w of x) if (y.has(w)) shared += 1;
	return shared / Math.min(x.size, y.size) >= 0.6;
}

const remembers = (list: Remembered[], f: Remembered) => list.some((r) => sameFinding(r, f));

/** Your answer to a finding (or to your final review, when approval is set), kept for the whole session. */
export interface Answer extends Remembered {
	decision: "fix" | "dismiss";
	note?: string;
	approval?: boolean;
}

/** Keeps one answer per finding: a later answer to the same finding replaces the earlier one. */
function record(answers: Answer[], f: FindingView): void {
	if (!f.decision) return;
	const answer: Answer = { ...remember(f), decision: f.decision.decision, ...(f.decision.note ? { note: f.decision.note } : {}), ...(f.approval ? { approval: true } : {}) };
	const i = answers.findIndex((a) => !!a.approval === !!f.approval && sameFinding(a, f));
	if (i >= 0) answers[i] = answer;
	else answers.push(answer);
}

/** What a reviewer is told you already answered: its own findings, and every note you sent back from your final review. */
function answersFor(answers: Answer[], node: string): string[] {
	return answers.flatMap((a) => {
		if (a.approval) return a.decision === "fix" && a.note ? [`You sent the change back: ${a.note}`] : [];
		if (a.node !== node) return [];
		const what = `${a.file ? `${a.file} — ` : ""}${a.rule}`;
		return [a.decision === "dismiss" ? `${what}: dismissed, don't report it` : `${what}: the user asked for a fix${a.note ? ` (${a.note})` : ""}; report it only if the change still doesn't do it`];
	});
}

/** Checkpoints written before findings were remembered as objects kept "node|file|rule" keys. */
const fromKey = (entry: Remembered | string): Remembered => {
	if (typeof entry !== "string") return entry;
	const [node = "", file = "", ...rule] = entry.split("|");
	return { node, file: file || null, rule: rule.join("|") };
};
const NODE_SYMBOL: Record<NodeState, string> = { waiting: "…", running: "…", passed: "✓", findings: "✗", failed: "✗", error: "✗", skipped: "–" };

interface Gate {
	items: FindingView[];
	finish(result: "done" | "pause" | "aborted"): void;
}

function fresh(baseline: Baseline): Checkpoint {
	return {
		baseline,
		paused: false,
		settled: null,
		promptFingerprint: null,
		pass: 0,
		sentToFix: [],
		answers: [],
		blocks: 0,
		prompts: [],
		plan: null,
		planState: "unused",
		planRounds: 0,
		status: "idle",
		history: [],
		note: null,
		findings: [],
		reviews: [],
		pendingReview: null,
	};
}

/** Drives a session's control loop: decides stops, runs passes, routes findings and holds the decision gate. */
export class Controller {
	readonly #deps: ControllerDeps;
	#attached: AttachedLoop | null = null;
	#state: Checkpoint = fresh({ kind: "commit", sha: "HEAD" });
	#nodes: Record<string, NodeView> = {};
	#stage: number | null = null;
	#gateReason: "doubts" | "limit" | null = null;
	#gate: Gate | null = null;
	#running: Promise<string> | null = null;
	#passAbort: AbortController | null = null;
	#lastEmit = 0;
	#lastStatus: RunStatus | null = null;
	#emitTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(deps: ControllerDeps) {
		this.#deps = deps;
	}

	attach(loop: LoopSnapshot, source: string, baseline: Baseline): void {
		this.#abortPass("Control loop detached.");
		this.#attached = { loop, source, baseline };
		this.#state = fresh(baseline);
		this.#resetNodes();
		this.#persist();
		this.#emit(true);
	}

	detach(): void {
		this.#abortPass("Control loop detached.");
		this.#attached = null;
		clearTimeout(this.#emitTimer);
		this.#deps.emit(null);
	}

	restore(attached: AttachedLoop | null, checkpoint: Checkpoint | null): void {
		this.#abortPass("Control loop detached.");
		this.#attached = attached;
		if (!attached) {
			this.#deps.emit(null);
			return;
		}
		this.#state = checkpoint ? { ...fresh(attached.baseline), ...checkpoint, baseline: attached.baseline } : fresh(attached.baseline);
		// Checkpoints from before answers were remembered kept only dismissals, some as "node|file|rule" keys.
		const old = checkpoint as (Checkpoint & { dismissed?: (Remembered | string)[] }) | null;
		if (old?.dismissed && !checkpoint?.answers) this.#state.answers = old.dismissed.map((d) => ({ ...fromKey(d), decision: "dismiss" as const }));
		this.#state.sentToFix = (this.#state.sentToFix as (Remembered | string)[]).map(fromKey);
		if (this.#state.status === "checking" || this.#state.status === "deciding") {
			this.#state.status = "implementing";
			this.#state.note = "Interrupted";
		}
		this.#resetNodes();
		for (const f of this.#state.findings) {
			const node = this.#nodes[f.node];
			if (node) {
				node.findings += 1;
				node.state = "findings";
			}
		}
		this.#emit(true);
	}

	onUserPrompt(fp: string, text: string): void {
		if (!this.#attached) return;
		const s = this.#state;
		s.promptFingerprint = fp;
		s.pass = 0;
		s.sentToFix = [];
		s.blocks = 0;
		s.prompts = [...s.prompts, cut(text, PROMPT_LIMIT)].slice(-3);
		// A review still waiting for you stays open and will cover this instruction too.
		if (s.pendingReview) s.pendingReview.requests = [...s.pendingReview.requests, cut(text, PROMPT_LIMIT)].slice(-5);
		if (!s.paused) {
			s.status = s.planState === "planning" ? "planning" : "implementing";
			s.note = null;
		}
		this.#persist();
		this.#emit(true);
	}

	onPlan(state: PlanState, planText?: string): void {
		if (!this.#attached) return;
		const s = this.#state;
		s.planState = state;
		if (planText !== undefined) s.plan = cut(planText, PLAN_LIMIT);
		if (state === "unused") s.plan = null;
		if (state === "unused" || state === "approved") s.planRounds = 0;
		// The plan reviewer's tile resets for a new plan.
		const reviewer = this.#attached.loop.planReviewer;
		const view = reviewer && this.#nodes[reviewer.id];
		if (state === "planning" && view) Object.assign(view, { state: "waiting", detail: null, findings: 0 });
		if (!s.paused && s.status !== "checking" && s.status !== "deciding") s.status = state === "planning" || state === "review" ? "planning" : "implementing";
		this.#persist();
		this.#emit(true);
	}

	stopDecision(fp: string): { block: false; stalled?: true } | { block: true; reason: string } {
		const s = this.#state;
		if (!this.#attached || s.paused) return { block: false };
		if (s.planState === "planning" || s.planState === "review") return { block: false };
		if (fp === "clean" || fp === s.promptFingerprint || s.settled?.fingerprint === fp) return { block: false };
		if (s.blocks >= MAX_BLOCKS) {
			s.settled = { fingerprint: fp, kind: "stalled" };
			s.status = "stalled";
			s.note = "The agent ended its turn three times without running control_check";
			s.blocks = 0;
			this.#persist();
			this.#emit(true);
			return { block: false, stalled: true };
		}
		s.blocks += 1;
		this.#persist();
		return { block: true, reason: stopReason(this.#attached.loop.name) };
	}

	async check(options: { incomplete?: string; questions?: AgentQuestion[]; signal: AbortSignal; progress(text: string): void }): Promise<string> {
		if (!this.#attached) return "No control loop is attached to this session.";
		const s = this.#state;
		if (s.paused) return "The control loop is paused; the user resumes it with /control resume.";
		if (this.#running) return this.#running;
		s.blocks = 0;
		const fp = await this.#deps.fingerprint();
		if (options.incomplete?.trim()) {
			s.settled = { fingerprint: fp, kind: "deferred" };
			s.status = "deferred";
			s.note = cut(options.incomplete.trim(), NOTE_LIMIT);
			this.#record("deferred", 0);
			this.#persist();
			this.#emit(true);
			return `Recorded as incomplete: ${s.note.replace(/[.!?]+$/, "")}. The loop checks your changes at your next stop after you continue.`;
		}
		if (fp === "clean") {
			s.settled = { fingerprint: fp, kind: "passed" };
			s.status = "passed";
			s.note = null;
			this.#persist();
			this.#emit(true);
			return "Nothing to check: no changes since the loop's baseline.";
		}
		if (s.settled?.fingerprint === fp && (s.settled.kind === "passed" || s.settled.kind === "accepted")) {
			return "Already checked: nothing changed since the last passing check.";
		}
		const run = this.#pass(this.#attached, fp, options.questions ?? [], options.signal, options.progress).finally(() => {
			if (this.#running === run) this.#running = null;
		});
		this.#running = run;
		return run;
	}

	/** Makes the next check run a full pass, even when this exact change already passed. */
	recheck(): void {
		this.#state.settled = null;
		this.#state.blocks = 0;
		this.#persist();
	}

	decide(decisions: Record<string, Decision>, pause: boolean): ControlReply {
		const gate = this.#gate;
		if (!gate) return { ok: false, message: "No control decision is pending" };
		let recorded = 0;
		for (const [id, d] of Object.entries(decisions)) {
			const item = gate.items.find((f) => f.id === id);
			if (!item || item.decision || (d?.decision !== "fix" && d?.decision !== "dismiss")) continue;
			item.decision = d.note?.trim() ? { decision: d.decision, note: cut(d.note.trim(), 2000) } : { decision: d.decision };
			recorded += 1;
		}
		if (pause) {
			gate.finish("pause");
			return { ok: true, message: "Paused the control loop" };
		}
		const left = gate.items.filter((f) => !f.decision).length;
		if (!left) {
			gate.finish("done");
			return { ok: true, message: `Recorded ${recorded} decisions; the loop continues` };
		}
		this.#persist();
		this.#emit(true);
		return { ok: true, message: `Recorded ${recorded} decisions; ${left} still need one` };
	}

	setPaused(paused: boolean): void {
		if (!this.#attached) return;
		if (paused && this.#gate) {
			this.decide({}, true);
			return;
		}
		const s = this.#state;
		s.paused = paused;
		s.status = paused ? "paused" : "implementing";
		s.note = paused ? "Paused by the user" : null;
		this.#persist();
		this.#emit(true);
	}

	view(): RunView | null {
		if (!this.#attached) return null;
		const s = this.#state;
		return {
			version: 1,
			loop: shape(this.#attached.loop),
			plan: s.planState,
			status: s.status,
			pass: s.pass,
			stage: this.#stage,
			nodes: structuredClone(this.#nodes),
			findings: structuredClone(s.findings),
			gate: { open: this.#gate !== null, reason: this.#gate ? this.#gateReason : null },
			note: s.note,
			history: [...s.history],
			reviews: structuredClone(s.reviews),
			pendingReview: structuredClone(s.pendingReview),
			updatedAt: this.#deps.now(),
		};
	}

	snapshot(): { loop: LoopSnapshot; source: string } | null {
		return this.#attached ? { loop: this.#attached.loop, source: this.#attached.source } : null;
	}

	get paused(): boolean {
		return this.#state.paused;
	}

	/** Stops a running pass and its reviewers, keeping the loop attached. */
	abort(): void {
		this.#abortPass("Control check interrupted.");
	}

	/**
	 * Has the plan reviewer read a plan omp asks to review: approve once it passes, refine sends its findings back to
	 * planning, and ask leaves omp's plan review open for you (why, or null when there's nothing to say).
	 */
	async checkPlan(planText: string, signal: AbortSignal): Promise<{ action: "approve" } | { action: "refine"; feedback: string } | { action: "ask"; reason: string | null }> {
		const attached = this.#attached;
		const node = attached?.loop.planReviewer;
		if (!attached || !node || this.#state.paused) return { action: "ask", reason: null };
		const { loop } = attached;
		const s = this.#state;
		s.planRounds += 1;
		const view = this.#nodes[node.id];
		Object.assign(view, { state: "running", detail: "reading the plan", findings: 0 });
		this.#emit();
		const started = Date.now();
		let outcome: NodeOutcome;
		try {
			outcome =
				node.kind === "check"
					? await this.#deps.runCheck(node, signal)
					: await this.#deps.runReview(node, planPacketText({ loopName: loop.name, nodeName: node.name, prompts: s.prompts, plan: planText }), signal, (detail) => {
							view.detail = detail;
							this.#emit();
						});
		} catch (e) {
			outcome = { kind: "error", message: e instanceof Error ? e.message : String(e) };
		}
		view.durationMs = Date.now() - started;
		view.artifacts = outcome.artifacts ?? [];
		view.detail = null;
		if (signal.aborted) {
			view.state = "waiting";
			this.#emit(true);
			return { action: "ask", reason: null };
		}
		if (outcome.kind === "passed") {
			view.state = "passed";
			s.findings = s.findings.filter((f) => !f.id.startsWith("plan."));
			this.#persist();
			this.#emit(true);
			return { action: "approve" };
		}
		if (outcome.kind !== "findings") {
			view.state = "error";
			view.detail = cut(outcome.message, 200);
			this.#persist();
			this.#emit(true);
			return { action: "ask", reason: `${node.name} couldn't review the plan: ${cut(outcome.message, 200)}` };
		}
		view.state = "findings";
		view.findings = outcome.findings.length;
		s.findings = outcome.findings.map((f, i) => ({ id: `plan.${i + 1}`, node: node.id, nodeName: node.name, ...f, recurring: false, approval: false, route: "fix", decision: null }));
		this.#persist();
		this.#emit(true);
		if (s.planRounds >= loop.maxPasses) return { action: "ask", reason: `${node.name} still finds problems in the plan after ${s.planRounds} rounds` };
		return { action: "refine", feedback: fixMessage(loop.name, 0, 0, s.findings, [], 0).replace(/^.*?\n\n/, `${node.name} found problems in your plan; revise it:\n\n`) };
	}

	// --- pass

	async #pass(attached: AttachedLoop, fp: string, questions: AgentQuestion[], signal: AbortSignal, progress: (text: string) => void): Promise<string> {
		const { loop } = attached;
		const s = this.#state;
		const abort = new AbortController();
		this.#passAbort = abort;
		const onAbort = () => abort.abort("Control check interrupted.");
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			s.pass += 1;
			s.status = "checking";
			s.note = null;
			s.findings = [];
			this.#resetNodes(true);
			this.#stage = 0;
			this.#persist();
			this.#emit(true);

			let packet: Promise<{ stat: string; diff: string; truncated: boolean; baseline: string }> | null = null;
			const packetText = async (node: NodeDefinition) => {
				packet ??= this.#deps.packet();
				const p = await packet;
				return reviewPacketText({ loopName: loop.name, nodeName: node.name, pass: s.pass, prompts: s.prompts, plan: s.planState === "approved" ? s.plan : null, baseline: p.baseline, packet: p, answers: answersFor(s.answers, node.id) });
			};
			const report = () => progress(this.#progressText(loop));
			const limit = s.pass >= loop.maxPasses;
			const findings: FindingView[] = [];
			const approvals: FindingView[] = [];
			/**
			 * Routes a finding as it arrives: dismissed when you dismissed it before, a doubt (ask) when the check isn't sure,
			 * when it came back after a fix, or when the check couldn't run; otherwise the agent fixes it.
			 */
			const add = (node: NodeDefinition, finding: RawFinding, error: boolean) => {
				const view: FindingView = { id: `${s.pass}.${findings.length + 1}`, node: node.id, nodeName: node.name, ...finding, recurring: false, approval: false, route: "fix", decision: null };
				const answered = s.answers.find((a) => !a.approval && sameFinding(a, view));
				if (answered?.decision === "dismiss") view.route = "dismissed";
				else if (answered) {
					// You already said to fix it: it goes back to the agent with your note, without asking again.
					view.recurring = true;
					view.decision = answered.note ? { decision: "fix", note: answered.note } : { decision: "fix" };
				} else if (remembers(s.sentToFix, view)) {
					view.route = "ask";
					view.recurring = true;
				} else if (error || node.ask === "all" || (node.ask === "doubts" && !finding.certain)) view.route = "ask";
				findings.push(view);
			};
			const undecided = () => findings.filter((f) => f.route === "ask" && !f.decision);
			// The agent's own open questions wait with the doubts; one you already answered goes back with your answer.
			for (const q of questions) {
				const view: FindingView = {
					id: `${s.pass}.q${findings.length + 1}`,
					node: AGENT,
					nodeName: "Agent",
					file: null,
					line: null,
					rule: q.question,
					observed: `It chose: ${q.chose}`,
					expected: "Keep its choice, or pick another option",
					alternatives: q.options,
					severity: "minor",
					certain: false,
					recurring: false,
					approval: false,
					question: { options: q.options, chose: q.chose },
					route: "ask",
					decision: null,
				};
				const answered = s.answers.find((a) => !a.approval && sameFinding(a, view));
				if (answered?.decision === "dismiss") view.route = "dismissed";
				else if (answered) {
					view.route = "fix";
					view.recurring = true;
					view.decision = answered.note ? { decision: "fix", note: answered.note } : { decision: "fix" };
				}
				findings.push(view);
			}

			for (let i = 0; i < loop.stages.length && !abort.signal.aborted; i++) {
				this.#stage = i;
				const before = findings.length;
				const stage = loop.stages[i].nodes;
				await Promise.all(
					stage
						.map(async (node) => {
							const view = this.#nodes[node.id];
							view.state = "running";
							const started = Date.now();
							this.#emit();
							report();
							let outcome: NodeOutcome;
							try {
								outcome =
									node.kind === "check"
										? await this.#deps.runCheck(node, abort.signal)
										: await this.#deps.runReview(node, await packetText(node), abort.signal, (detail) => {
												view.detail = detail;
												this.#emit();
												report();
											});
							} catch (e) {
								outcome = { kind: "error", message: e instanceof Error ? e.message : String(e) };
							}
							if (abort.signal.aborted) return;
							view.durationMs = Date.now() - started;
							view.artifacts = outcome.artifacts ?? [];
							view.detail = null;
							if (outcome.kind === "passed") view.state = "passed";
							else if (outcome.kind === "findings") {
								view.state = node.kind === "check" ? "failed" : "findings";
								view.findings = outcome.findings.length;
								for (const finding of outcome.findings) add(node, finding, false);
							} else {
								view.state = "error";
								view.detail = cut(outcome.message, 200);
								view.findings = 1;
								add(node, { file: null, line: null, rule: "couldn't run", observed: outcome.message, expected: "the node runs", alternatives: [], severity: "major", certain: false }, true);
							}
							this.#emit();
							report();
						}),
				);
				// Only what the agent must fix stops the later checks; doubts wait for the end of the loop.
				if (findings.slice(before).some((f) => f.route === "fix")) {
					for (const later of loop.stages.slice(i + 1)) for (const node of later.nodes) this.#nodes[node.id].state = "skipped";
					break;
				}
			}
			if (abort.signal.aborted) return this.#interrupted(String(abort.signal.reason ?? "Control check interrupted."));

			// At the pass limit nothing goes back to the agent on its own: everything left is yours to decide.
			if (limit) for (const f of findings) if (f.route === "fix") f.route = "ask";
			s.findings = [...findings];
			this.#stage = null;

			const certain = findings.filter((f) => f.route === "fix");
			const doubts = undecided();
			let consider: FindingView[] = [];
			let held = 0;
			if (doubts.length && this.#deps.hasUI()) {
				if (certain.length) held = doubts.length;
				else {
					// Nothing certain is left: the doubts and the agent's questions come to you in one go.
					const result = await this.#openGate(doubts, limit ? "limit" : "doubts", abort.signal);
					if (result === "aborted") return this.#interrupted(String(abort.signal.reason ?? "Control check interrupted."));
					if (result === "pause") return this.#pausedAt(fp, doubts.filter((f) => !f.decision).length, findings.length);
					for (const f of doubts) record(s.answers, f);
				}
			} else consider = doubts;

			// The review ends the loop: only once nothing is left to fix and every doubt is answered.
			const settled = !certain.length && !findings.some((f) => f.decision?.decision === "fix");
			if (settled && loop.finish === "review" && this.#deps.hasUI()) {
				const review = await this.#review(loop, findings, abort.signal);
				if (review === "aborted") return this.#interrupted(String(abort.signal.reason ?? "Control check interrupted."));
				if (review === "pause") return this.#pausedAt(fp, 1, findings.length);
				approvals.push(review);
				s.findings = [...findings, review];
			}

			const userDismissed = findings.filter((f) => f.decision?.decision === "dismiss");
			const fix = [...findings.filter((f) => f.route === "fix" || f.decision?.decision === "fix"), ...approvals.filter((f) => f.decision?.decision === "fix")];
			for (const f of [...findings, ...approvals]) if (f.decision && f.route === "ask") record(s.answers, f);
			for (const f of fix) if (!f.approval && !remembers(s.sentToFix, f)) s.sentToFix.push(remember(f));
			const dismissedCount = userDismissed.length + findings.filter((f) => f.route === "dismissed").length;
			let message: string;
			if (!fix.length) {
				s.settled = { fingerprint: fp, kind: dismissedCount ? "accepted" : "passed" };
				s.status = "passed";
				this.#record("passed", findings.length);
				const names = loop.stages.flatMap((st) => st.nodes.map((n) => n.name));
				message = passedMessage(loop.name, s.pass, names, dismissedCount);
				if (consider.length) message += `\n\n${judgmentCalls(consider)}`;
			} else {
				s.settled = null;
				s.status = "fixing";
				this.#record("fixes", fix.length);
				message = fixMessage(loop.name, s.pass, loop.maxPasses, fix, consider, dismissedCount);
				if (held) message += `\n\n${held} judgment call${held === 1 ? " waits" : "s wait"} for the user once these are fixed; don't act on ${held === 1 ? "it" : "them"}.`;
			}
			this.#persist();
			this.#emit(true);
			return message;
		} finally {
			signal.removeEventListener("abort", onAbort);
			if (this.#passAbort === abort) this.#passAbort = null;
		}
	}

	/**
	 * Asks for your review with a summary of the final change; when you've answered, the review goes to history with
	 * everything you decided this pass, and the next cycle starts a fresh one.
	 */
	async #review(loop: LoopSnapshot, findings: FindingView[], signal: AbortSignal): Promise<FindingView | "pause" | "aborted"> {
		const s = this.#state;
		s.pendingReview ??= { since: this.#deps.now(), requests: s.prompts.slice(-1) };
		const pending = s.pendingReview;
		const summary = await this.#summary(loop, pending.requests);
		const view = this.#nodes[REVIEW];
		if (view) Object.assign(view, { state: "running", detail: "waiting for you" });
		const review: FindingView = {
			id: `${s.pass}.review`,
			node: REVIEW,
			nodeName: "You review",
			file: null,
			line: null,
			rule: "Approve this change?",
			observed: summary,
			expected: "Approve it, or send it back with what to change",
			alternatives: [],
			severity: "major",
			certain: false,
			recurring: false,
			approval: true,
			route: "ask",
			decision: null,
		};
		s.findings = [...findings, review];
		const result = await this.#openGate([review], "doubts", signal);
		if (result !== "done") return result;
		record(s.answers, review);
		const sentBack = review.decision?.decision === "fix";
		if (view) Object.assign(view, { state: sentBack ? "findings" : "passed", detail: sentBack ? "sent back" : "approved" });
		const answer = (f: FindingView) => (f.question ? (f.decision?.decision === "dismiss" ? `kept: ${f.question.chose}` : (f.decision?.note ?? "another option")) : f.decision?.decision === "fix" ? `fix${f.decision.note ? `: ${f.decision.note}` : ""}` : "dismissed");
		s.reviews = [
			{
				at: this.#deps.now(),
				pass: s.pass,
				requests: pending.requests,
				summary,
				outcome: sentBack ? ("sent back" as const) : ("approved" as const),
				note: review.decision?.note ?? null,
				answers: findings.filter((f) => f.decision && f.route === "ask").map((f) => ({ nodeName: f.nodeName, rule: f.rule, answer: answer(f) })),
			},
			...s.reviews,
		].slice(0, 10);
		s.pendingReview = null;
		return review;
	}

	#openGate(items: FindingView[], reason: "doubts" | "limit", signal: AbortSignal): Promise<"done" | "pause" | "aborted"> {
		this.#state.status = "deciding";
		this.#gateReason = reason;
		const { promise, resolve } = Promise.withResolvers<"done" | "pause" | "aborted">();
		const controller = new AbortController();
		const onAbort = () => gate.finish("aborted");
		const gate: Gate = {
			items,
			finish: (result) => {
				if (this.#gate !== gate) return;
				this.#gate = null;
				this.#gateReason = null;
				signal.removeEventListener("abort", onAbort);
				controller.abort();
				resolve(result);
			},
		};
		this.#gate = gate;
		signal.addEventListener("abort", onAbort, { once: true });
		this.#persist();
		this.#emit(true);
		this.#deps.ask(items, controller.signal).then(
			(answer) => {
				if (controller.signal.aborted || answer === null) return;
				if (answer === "pause") this.decide({}, true);
				else this.decide(answer, false);
			},
			() => {},
		);
		return promise;
	}

	/** The grouped summary your review shows: the requests, the final change by folder, what the loop fixed, what you answered. */
	async #summary(loop: LoopSnapshot, requests: string[]): Promise<string> {
		const s = this.#state;
		const names = new Map([...(loop.planReviewer ? [loop.planReviewer] : []), ...loop.stages.flatMap((st) => st.nodes)].map((n) => [n.id, n.name]));
		const files = await this.#deps.changes().catch(() => []);
		return reviewSummary({
			requests,
			files,
			fixed: s.sentToFix.map((f) => ({ nodeName: names.get(f.node) ?? f.node, file: f.file, rule: f.rule })),
			answered: s.answers.filter((a) => !a.approval).length,
		});
	}

	#pausedAt(fp: string, undecided: number, total: number): string {
		const s = this.#state;
		s.paused = true;
		s.settled = { fingerprint: fp, kind: "deferred" };
		s.status = "paused";
		s.note = `Paused with ${undecided} undecided findings`;
		this.#stage = null;
		this.#record("paused", total);
		this.#persist();
		this.#emit(true);
		return `The user paused the control loop with ${undecided} findings undecided; don't fix them. Finish your turn.`;
	}

	#interrupted(message: string): string {
		for (const node of Object.values(this.#nodes)) if (node.state === "running" || node.state === "waiting") node.state = "skipped";
		this.#stage = null;
		if (this.#attached) {
			this.#state.status = "implementing";
			this.#record("interrupted", 0);
			this.#persist();
			this.#emit(true);
		}
		return message;
	}

	#abortPass(reason: string): void {
		this.#passAbort?.abort(reason);
		this.#gate?.finish("aborted");
	}

	#record(result: History["result"], findings: number): void {
		this.#state.history = [...this.#state.history, { pass: this.#state.pass, result, findings, at: this.#deps.now() }].slice(-10);
	}

	#resetNodes(changeOnly = false): void {
		const loop = this.#attached?.loop;
		if (!changeOnly) this.#nodes = {};
		const nodes = [...(changeOnly || !loop?.planReviewer ? [] : [loop.planReviewer]), ...(loop?.stages ?? []).flatMap((st) => st.nodes)];
		for (const node of nodes) this.#nodes[node.id] = { state: "waiting", detail: null, findings: 0, durationMs: null, artifacts: [] };
		if (loop?.finish === "review") this.#nodes[REVIEW] = { state: "waiting", detail: null, findings: 0, durationMs: null, artifacts: [] };
	}

	#progressText(loop: LoopSnapshot): string {
		const stage = this.#stage ?? 0;
		const nodes = (loop.stages[stage]?.nodes ?? []).map((n) => {
			const view = this.#nodes[n.id];
			return `${n.name} ${view.state === "running" && view.detail ? view.detail : NODE_SYMBOL[view.state]}`;
		});
		return `Control «${loop.name}» · pass ${this.#state.pass}/${loop.maxPasses} · stage ${stage + 1}/${loop.stages.length}: ${nodes.join(", ")}`;
	}

	#persist(): void {
		if (this.#attached) this.#deps.persist(structuredClone(this.#state));
	}

	#emit(force = false): void {
		const status = this.#state.status;
		const wait = this.#lastEmit + EMIT_MS - Date.now();
		if (!force && status === this.#lastStatus && wait > 0) {
			this.#emitTimer ??= setTimeout(() => {
				this.#emitTimer = undefined;
				this.#emit(true);
			}, wait);
			return;
		}
		clearTimeout(this.#emitTimer);
		this.#emitTimer = undefined;
		this.#lastEmit = Date.now();
		this.#lastStatus = status;
		this.#deps.emit(this.view());
	}
}
