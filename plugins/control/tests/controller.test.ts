import { expect, test } from "bun:test";
import type { Decision, FindingView, RunView } from "omp-control-view/protocol";
import { type Checkpoint, Controller, type ControllerDeps } from "../src/controller";
import type { LoopSnapshot, NodeDefinition } from "../src/library";
import type { RawFinding } from "../src/prompts";
import type { NodeOutcome } from "../src/sensors";

const node = (id: string, over: Partial<NodeDefinition> = {}): NodeDefinition => ({
	id,
	name: id,
	kind: "review",
	description: "",
	command: null,
	timeout: 60,
	ask: "doubts",
	model: null,
	thinking: null,
	tools: ["read"],
	resources: [],
	instructions: "x",
	...over,
});

const finding = (rule: string, certain: boolean): RawFinding => ({ file: "a.ts", line: 1, rule, observed: "o", expected: "e", alternatives: [], severity: "major", certain });

type Outcomes = Record<string, NodeOutcome | ((signal: AbortSignal) => Promise<NodeOutcome>)>;

function harness(loop: LoopSnapshot, options: { ui?: boolean } = {}) {
	const state = { fp: "fp1", outcomes: {} as Outcomes, ran: [] as string[], packets: [] as string[], views: [] as (RunView | null)[], checkpoints: [] as Checkpoint[], asks: [] as { items: FindingView[]; signal: AbortSignal }[] };
	let answer: (items: FindingView[], signal: AbortSignal) => Promise<Record<string, Decision> | "pause" | null> = () => new Promise(() => {});
	const gateOpened = Promise.withResolvers<void>();
	const run = async (n: NodeDefinition, signal: AbortSignal) => {
		state.ran.push(n.id);
		const outcome = state.outcomes[n.id] ?? { kind: "passed" };
		return typeof outcome === "function" ? outcome(signal) : outcome;
	};
	const deps: ControllerDeps = {
		fingerprint: async () => state.fp,
		packet: async () => ({ stat: "", diff: "", truncated: false, baseline: "abc" }),
		changes: async () => [
			{ path: "ios/Cart/CartView.swift", added: 40, removed: 6, isNew: false },
			{ path: "ios/Cart/CartModel.swift", added: 12, removed: 0, isNew: true },
			{ path: "README.md", added: 2, removed: 1, isNew: false },
		],
		runCheck: run,
		runReview: (n, text, signal) => {
			state.packets.push(text);
			return run(n, signal);
		},
		hasUI: () => options.ui ?? true,
		ask: (items, signal) => {
			state.asks.push({ items, signal });
			gateOpened.resolve();
			return answer(items, signal);
		},
		emit: (v) => state.views.push(v),
		persist: (c) => state.checkpoints.push(c),
		now: () => "2026-01-01T00:00:00.000Z",
	};
	const controller = new Controller(deps);
	controller.attach(loop, "repo:test", { kind: "commit", sha: "abc" });
	const check = (incomplete?: string) => controller.check({ incomplete, signal: new AbortController().signal, progress: () => {} });
	return { controller, state, check, gateOpened: gateOpened.promise, onAsk: (fn: typeof answer) => (answer = fn) };
}

const single = (n: NodeDefinition, maxPasses = 4): LoopSnapshot => ({ id: "t", name: "Test", description: "", maxPasses, plan: false, planStages: [], stages: [{ nodes: [n] }], finish: "auto" });
const flow = (...stages: NodeDefinition[][]): LoopSnapshot => ({ id: "t", name: "Test", description: "", maxPasses: 4, plan: false, planStages: [], stages: stages.map((nodes) => ({ nodes })), finish: "auto" });
const reviewed = (...stages: NodeDefinition[][]): LoopSnapshot => ({ ...flow(...stages), finish: "review" });

test("stop decisions: chat-only turns pass, unchecked changes block, settled changes pass, the fourth stop is let through", async () => {
	const { controller, state, check } = harness(single(node("q")));
	controller.onUserPrompt("fp0", "do it");
	expect(controller.stopDecision("fp0")).toEqual({ block: false });
	expect(controller.stopDecision("clean")).toEqual({ block: false });
	const blocked = controller.stopDecision("fp1");
	expect(blocked.block).toBe(true);
	if (blocked.block) expect(blocked.reason).toContain("control_check");
	expect(await check()).toStartWith("Control loop «Test» passed on pass 1");
	expect(controller.stopDecision("fp1")).toEqual({ block: false });

	state.fp = "fp2";
	expect(controller.stopDecision("fp2").block).toBe(true);
	expect(controller.stopDecision("fp2").block).toBe(true);
	expect(controller.stopDecision("fp2").block).toBe(true);
	expect(controller.stopDecision("fp2")).toEqual({ block: false, stalled: true });
	expect(controller.view()?.status).toBe("stalled");
	expect(controller.stopDecision("fp2")).toEqual({ block: false });
});

test("a failing first-stage check skips the reviewers", async () => {
	const build = node("build", { kind: "check", command: "make" });
	const { controller, state, check } = harness(flow([build], [node("q")]));
	state.outcomes.build = { kind: "findings", findings: [finding("command failed (exit 2)", true)] };
	const text = await check();
	expect(text).toStartWith("Control loop «Test» — pass 1 of 4: fix this finding");
	expect(state.ran).toEqual(["build"]);
	expect(controller.view()?.nodes).toMatchObject({ build: { state: "failed", findings: 1 }, q: { state: "skipped" } });
	expect(controller.view()?.findings[0]).toMatchObject({ id: "1.1", route: "fix" });
});

test("ask modes route findings: doubts asks only uncertain ones, all asks everything, never asks nothing", async () => {
	const doubts = node("d");
	const all = node("a", { ask: "all" });
	const never = node("n", { ask: "never" });
	const { controller, state, check } = harness(flow([doubts, all, never]), { ui: false });
	for (const id of ["d", "a", "n"]) state.outcomes[id] = { kind: "findings", findings: [finding(`${id} sure`, true), finding(`${id} maybe`, false)] };
	await check();
	const routes = Object.fromEntries(controller.view()!.findings.map((f) => [f.rule, f.route]));
	expect(routes).toEqual({ "d sure": "fix", "d maybe": "ask", "a sure": "ask", "a maybe": "ask", "n sure": "fix", "n maybe": "fix" });
});

test("without a UI, ask items reach the agent as judgment calls", async () => {
	const { state, check } = harness(single(node("q")), { ui: false });
	state.outcomes.q = { kind: "findings", findings: [finding("maybe", false)] };
	const text = await check();
	expect(text).toStartWith("Control loop «Test» passed on pass 1");
	expect(text).toContain("Judgment calls — apply only if you agree, and say which you skipped:\n1. [q] a.ts:1 — maybe");
});

test("a finding sent to fix that comes back goes to the user as recurring", async () => {
	const { controller, state, check, onAsk } = harness(single(node("q")));
	state.outcomes.q = { kind: "findings", findings: [finding("Empty list", true)] };
	expect(await check()).toContain("fix this finding");
	state.fp = "fp2";
	onAsk(async (items) => Object.fromEntries(items.map((f) => [f.id, { decision: "fix" as const }])));
	const text = await check();
	expect(state.asks).toHaveLength(1);
	expect(state.asks[0].items[0]).toMatchObject({ id: "2.1", route: "ask", recurring: true });
	expect(text).toStartWith("Control loop «Test» — pass 2 of 4: fix this finding");
	expect(controller.view()?.findings[0].decision).toEqual({ decision: "fix" });
});

test("at the pass limit every fix goes to the user with the limit reason", async () => {
	const { controller, state, check, gateOpened } = harness(single(node("q"), 1));
	state.outcomes.q = { kind: "findings", findings: [finding("sure", true)] };
	const pending = check();
	await gateOpened;
	expect(controller.view()?.gate).toEqual({ open: true, reason: "limit" });
	expect(controller.view()?.findings[0].route).toBe("ask");
	expect(controller.decide({ "1.1": { decision: "dismiss" } }, false)).toEqual({ ok: true, message: "Recorded 1 decisions; the loop continues" });
	expect(await pending).toStartWith("Control loop «Test» passed on pass 1: q ✓. Give your final answer. (1 dismissed by the user.)");
});

test("a dismissed finding stays dismissed when the reviewer words it differently, and reviewers are told about it", async () => {
	const { controller, state, check, onAsk } = harness(single(node("q")));
	state.outcomes.q = { kind: "findings", findings: [finding("Empty cart total returns NaN", false)] };
	onAsk(async () => ({ "1.1": { decision: "dismiss" } }));
	expect(await check()).toStartWith("Control loop «Test» passed");
	state.fp = "fp2";
	state.outcomes.q = { kind: "findings", findings: [finding("Total returns NaN for an empty cart", false)] };
	expect(await check()).toStartWith("Control loop «Test» passed on pass 2");
	expect(state.asks).toHaveLength(1);
	expect(controller.view()?.findings[0].route).toBe("dismissed");
	expect(state.packets[1]).toContain("## The user already answered");
	expect(state.packets[1]).toContain("- a.ts — Empty cart total returns NaN: dismissed, don't report it");
});

test("a finding you said to fix that comes back goes to the agent with your note, without asking again", async () => {
	const { controller, state, check, onAsk } = harness(single(node("q")));
	state.outcomes.q = { kind: "findings", findings: [finding("Naming of the cart total", false)] };
	onAsk(async () => ({ "1.1": { decision: "fix", note: "call it subtotal" } }));
	expect(await check()).toContain("User note: call it subtotal");
	state.fp = "fp2";
	state.outcomes.q = { kind: "findings", findings: [finding("Cart total naming", false)] };
	const text = await check();
	expect(state.asks).toHaveLength(1);
	expect(controller.view()?.findings[0]).toMatchObject({ route: "fix", recurring: true, decision: { decision: "fix", note: "call it subtotal" } });
	expect(text).toContain("User note: call it subtotal");
	expect(state.packets[1]).toContain("the user asked for a fix (call it subtotal)");
});

test("doubts don't stop later stages and wait until nothing certain is left", async () => {
	const { controller, state, check } = harness(flow([node("first")], [node("second")]));
	state.outcomes.first = { kind: "findings", findings: [finding("maybe naming", false)] };
	state.outcomes.second = { kind: "findings", findings: [finding("crashes on nil", true)] };
	const text = await check();
	expect(state.ran).toEqual(["first", "second"]);
	expect(state.asks).toHaveLength(0);
	expect(text).toContain("crashes on nil");
	expect(text).toContain("1 judgment call waits for the user once these are fixed; don't act on it.");
	expect(controller.view()?.findings.map((f) => [f.rule, f.route])).toEqual([["maybe naming", "ask"], ["crashes on nil", "fix"]]);
});

test("a remote decision resolves the gate and closes the TUI dialog", async () => {
	const { controller, state, check, gateOpened } = harness(single(node("q")));
	state.outcomes.q = { kind: "findings", findings: [finding("a", false), finding("b", false)] };
	const pending = check();
	await gateOpened;
	expect(state.asks).toHaveLength(1);
	expect(controller.decide({ "1.1": { decision: "fix", note: "small" } }, false).message).toBe("Recorded 1 decisions; 1 still need one");
	expect(state.asks[0].signal.aborted).toBe(false);
	controller.decide({ "1.2": { decision: "dismiss" } }, false);
	expect(state.asks[0].signal.aborted).toBe(true);
	const text = await pending;
	expect(text).toContain("fix this finding");
	expect(text).toContain("User note: small");
	expect(text).toContain("The user dismissed 1 finding; don't act on them.");
	expect(controller.decide({}, true)).toEqual({ ok: false, message: "No control decision is pending" });
});

test("pausing at the gate pauses the loop and lets the next stop through", async () => {
	const { controller, state, check, onAsk } = harness(single(node("q")));
	state.outcomes.q = { kind: "findings", findings: [finding("maybe", false)] };
	onAsk(async () => "pause");
	expect(await check()).toBe("The user paused the control loop with 1 findings undecided; don't fix them. Finish your turn.");
	expect(controller.view()?.status).toBe("paused");
	expect(controller.stopDecision("fp9")).toEqual({ block: false });
	expect(await check()).toBe("The control loop is paused; the user resumes it with /control resume.");
});

test("an incomplete check defers the loop until the change moves on", async () => {
	const { controller, state, check } = harness(single(node("q")));
	expect(await check("Need the user's API key")).toBe("Recorded as incomplete: Need the user's API key. The loop checks your changes at your next stop after you continue.");
	expect(controller.view()).toMatchObject({ status: "deferred", note: "Need the user's API key" });
	expect(controller.stopDecision("fp1")).toEqual({ block: false });
	expect(controller.stopDecision("fp2").block).toBe(true);
	expect(state.ran).toEqual([]);
});

test("aborting the tool call interrupts the pass", async () => {
	const { controller, state } = harness(single(node("q")));
	const started = Promise.withResolvers<void>();
	state.outcomes.q = (signal) => {
		started.resolve();
		return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ kind: "error", message: "Interrupted" })));
	};
	const ctl = new AbortController();
	const pending = controller.check({ signal: ctl.signal, progress: () => {} });
	await started.promise;
	ctl.abort();
	expect(await pending).toBe("Control check interrupted.");
	expect(controller.view()).toMatchObject({ status: "implementing", nodes: { q: { state: "skipped" } } });
	expect(controller.view()?.history.at(-1)?.result).toBe("interrupted");
});

test("a review flow asks for your review once the checks are clean; approving passes it and records the review", async () => {
	const { controller, state, check, gateOpened } = harness(reviewed([node("build", { kind: "check", command: "make" })], [node("q")]));
	controller.onUserPrompt("fp0", "Add a cart total");
	const pending = check();
	await gateOpened;
	expect(state.ran).toEqual(["build", "q"]);
	expect(controller.view()).toMatchObject({ status: "deciding", gate: { open: true }, nodes: { "@review": { state: "running", detail: "waiting for you" } } });
	const review = controller.view()!.findings.at(-1)!;
	expect(review).toMatchObject({ approval: true, nodeName: "You review", route: "ask" });
	controller.decide({ [review.id]: { decision: "dismiss" } }, false);
	expect(await pending).toStartWith("Control loop «Test» passed on pass 1");
	expect(controller.view()).toMatchObject({ nodes: { "@review": { state: "passed", detail: "approved" } }, pendingReview: null, reviews: [{ outcome: "approved", requests: ["Add a cart total"] }] });
});

test("an auto flow passes without a review, and so does a review flow without a UI", async () => {
	const auto = harness(flow([node("q")]));
	expect(await auto.check()).toStartWith("Control loop «Test» passed on pass 1");
	expect(auto.state.asks).toHaveLength(0);
	expect(auto.controller.view()?.nodes["@review"]).toBeUndefined();
	const headless = harness(reviewed([node("q")]), { ui: false });
	expect(await headless.check()).toStartWith("Control loop «Test» passed on pass 1");
	expect(headless.state.asks).toHaveLength(0);
});

test("sending the change back gives the agent your note", async () => {
	const { controller, check, gateOpened } = harness(reviewed([node("q")]));
	const pending = check();
	await gateOpened;
	controller.decide({ [controller.view()!.findings.at(-1)!.id]: { decision: "fix", note: "Rename the flag" } }, false);
	expect(await pending).toContain("1. [You review] The user sent the change back: Rename the flag");
	expect(controller.view()).toMatchObject({ status: "fixing", nodes: { "@review": { state: "findings", detail: "sent back" } }, reviews: [{ outcome: "sent back", note: "Rename the flag" }] });
});

test("a review interrupted by a new request stays pending and covers both requests", async () => {
	const { controller, check, gateOpened, onAsk } = harness(reviewed([node("q")]));
	controller.onUserPrompt("fp0", "Add a cart total");
	const ctl = new AbortController();
	const pending = controller.check({ signal: ctl.signal, progress: () => {} });
	await gateOpened;
	ctl.abort();
	expect(await pending).toBe("Control check interrupted.");
	controller.onUserPrompt("fp0", "Also show the tax");
	expect(controller.view()?.pendingReview?.requests).toEqual(["Add a cart total", "Also show the tax"]);
	const asked = Promise.withResolvers<FindingView>();
	onAsk(async (items) => {
		asked.resolve(items[0]);
		return { [items[0].id]: { decision: "dismiss" } };
	});
	const again = check();
	expect((await asked.promise).observed).toContain("Also show the tax");
	await again;
	expect(controller.view()).toMatchObject({ pendingReview: null, reviews: [{ requests: ["Add a cart total", "Also show the tax"] }] });
});

const planned = (planStages: NodeDefinition[][], stages: NodeDefinition[][]): LoopSnapshot => ({ ...flow(...stages), plan: true, planStages: planStages.map((nodes) => ({ nodes })) });

test("plan checks send a flawed plan back to planning with their findings", async () => {
	const { controller, state } = harness(planned([[node("plan-reviewer")]], [[node("q")]]));
	state.outcomes["plan-reviewer"] = { kind: "findings", findings: [finding("No tests in the plan", true)] };
	const r = await controller.checkPlan("1. Change the cart", new AbortController().signal);
	expect(r.action).toBe("refine");
	if (r.action === "refine") expect(r.feedback).toContain("No tests in the plan");
	expect(controller.view()?.nodes["plan-reviewer"].state).toBe("findings");
	expect(state.ran).toEqual(["plan-reviewer"]);
});

test("a clean plan waits for your approval in omp's plan review", async () => {
	const { controller } = harness(planned([[node("plan-reviewer")]], [[node("q")]]));
	expect(await controller.checkPlan("plan", new AbortController().signal)).toEqual({ action: "wait" });
	expect(controller.view()?.nodes["plan-reviewer"].state).toBe("passed");
});

test("your review waits until the doubts are answered, then shows a grouped summary of the change", async () => {
	const { controller, state, check, onAsk } = harness(reviewed([node("swift")]));
	controller.onUserPrompt("fp0", "Add a cart total");
	state.outcomes.swift = { kind: "findings", findings: [finding("maybe naming", false)] };
	const calls: FindingView[][] = [];
	onAsk(async (items) => {
		calls.push(items);
		return Object.fromEntries(items.map((f) => [f.id, { decision: "dismiss" as const }]));
	});
	expect(await check()).toStartWith("Control loop «Test» passed on pass 1");
	expect(calls.map((items) => items.map((f) => (f.approval ? "review" : f.rule)))).toEqual([["maybe naming"], ["review"]]);
	const summary = calls[1][0].observed;
	expect(summary).toContain("Request: Add a cart total");
	expect(summary).toContain("Changed: 3 files, +54 −7");
	expect(summary).toContain("ios/Cart/ — CartView.swift, CartModel.swift (new)  +52 −6");
	expect(summary).toContain("You already answered 1 finding.");
});

test("when you send a doubt back to be fixed, your review waits for a later pass", async () => {
	const { controller, state, check, onAsk } = harness(reviewed([node("swift")]));
	state.outcomes.swift = { kind: "findings", findings: [finding("maybe naming", false)] };
	onAsk(async (items) => Object.fromEntries(items.map((f) => [f.id, { decision: "fix" as const }])));
	expect(await check()).toStartWith("Control loop «Test» — pass 1 of 4: fix this finding");
	expect(state.asks).toHaveLength(1);
	expect(controller.view()?.nodes["@review"].state).toBe("waiting");
});

test("the agent's open questions come with the doubts; another option goes back as a fix and is remembered", async () => {
	const { controller, state, onAsk } = harness(single(node("q")));
	const questions = [{ question: "Show the total in the header or the footer?", options: ["Header", "Footer"], chose: "Header" }];
	onAsk(async (items) => ({ [items[0].id]: { decision: "fix", note: "Use «Footer» instead of «Header»" } }));
	const text = await controller.check({ questions, signal: new AbortController().signal, progress: () => {} });
	expect(state.asks[0].items[0]).toMatchObject({ node: "@agent", nodeName: "Agent", question: { chose: "Header" }, route: "ask" });
	expect(text).toContain("User note: Use «Footer» instead of «Header»");
	state.fp = "fp2";
	const again = await controller.check({ questions, signal: new AbortController().signal, progress: () => {} });
	expect(state.asks).toHaveLength(1);
	expect(again).toContain("User note: Use «Footer» instead of «Header»");
});
