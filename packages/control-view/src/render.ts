import { type Decision, type FindingView, type LoopShape, type NodeKind, type NodeState, type PlanMode, questionAnswer, type RunStatus, type RunView, withPlanMode } from "./protocol";

export type Phase = "plan" | "change";

/** Editing hooks: the editor draws + slots and selects blocks; without them the diagram is read-only. */
export interface EditHandlers {
	selected?: string | null;
	onSelect?(id: string | null): void;
	/** Inserts a new stage at `index` in run order (0 = the first check run) of a loop's checks. */
	onAddStage?(phase: Phase, index: number): void;
	onAddToStage?(phase: Phase, stage: number): void;
	onPlanMode?(mode: PlanMode): void;
	onToggleFinish?(): void;
}

export interface RenderHandlers {
	onDecide?(decisions: Record<string, Decision>, pause: boolean): void;
	edit?: EditHandlers;
}

export const STATUS_LABELS: Record<RunStatus, string> = {
	idle: "Idle",
	planning: "Planning",
	implementing: "Implementing",
	checking: "Checking",
	deciding: "Needs you",
	fixing: "Fixing",
	passed: "Done",
	deferred: "Deferred",
	paused: "Paused",
	stalled: "Stalled",
};

export const KIND_LABELS: Record<NodeKind, string> = { check: "Command check", review: "AI check" };
/** Lucide icons (the board's set, plus user and sparkles), as 24×24 stroke paths. */
const ICONS: Record<string, string> = {
	pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
	wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>',
	terminal: '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>',
	sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
	user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
	file: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>',
	code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
	check: '<path d="M20 6 9 17l-5-5"/>',
	x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
	alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
};
const KIND_ICONS: Record<NodeKind | "you", string> = { check: "terminal", review: "sparkles", you: "user" };
const STATE_ICONS: Partial<Record<NodeState, string>> = { passed: "check", failed: "x", error: "alert" };
const ICON = 14;

type Attrs = Record<string, string | number | ((e: Event) => void) | null | undefined>;
type Child = Node | string | null | undefined | false;

function set(node: Element, attrs: Attrs): void {
	for (const [key, value] of Object.entries(attrs)) {
		if (value === null || value === undefined) continue;
		if (typeof value === "function") node.addEventListener(key.slice(2), value);
		else node.setAttribute(key, String(value));
	}
}

function el(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
	const node = document.createElement(tag);
	set(node, attrs);
	for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
	return node;
}

const SVG = "http://www.w3.org/2000/svg";

function sv(tag: string, attrs: Attrs = {}, text?: string): SVGElement {
	const node = document.createElementNS(SVG, tag);
	set(node, attrs);
	if (text !== undefined) node.textContent = text;
	return node;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const where = (f: FindingView) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "");
const needsYou = (f: FindingView) => f.route === "ask" && !f.decision;

function duration(ms: number): string {
	return ms < 1000 ? "<1 s" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min`;
}

function nodeFact(id: string, run: RunView | null): { state: NodeState | null; fact: string } {
	const node = run?.nodes[id];
	if (!node) return { state: null, fact: "" };
	const asks = run.findings.filter((f) => f.node === id && needsYou(f)).length;
	if (node.state === "running") return { state: "running", fact: node.detail ?? "running…" };
	if (node.state === "error") return { state: "error", fact: node.detail ?? "couldn't run" };
	if (asks) return { state: node.state, fact: `${asks} to decide` };
	if (node.findings) return { state: node.state, fact: plural(node.findings, "finding") };
	if (node.state === "passed" && node.durationMs !== null) return { state: "passed", fact: duration(node.durationMs) };
	return { state: node.state, fact: node.state };
}

// MARK: diagram

const PAD = 14;
const ROW_H = 46;
const NODE_W = 144;
const NODE_H = 40;
const STAGE_GAP = 34;
const AGENT_W = 128;
const OUT_W = 100;
const LOOP_GAP = 34;

type ShapeNode = { id: string; name: string; kind: NodeKind | "you" };

interface Segment {
	phase: Phase;
	title: string;
	agent: { title: string; sub: string; active: boolean; icon: string };
	output: { title: string; sub: string; icon: string };
	stages: { nodes: ShapeNode[] }[];
	/** The tile after the checks that isn't a check: your approval of the plan, or your review of the change. */
	implicit: (ShapeNode & { fact: string; state: NodeState | null }) | null;
	hot: { text: string; tone: "warn" | "accent" } | null;
	active: boolean;
	/** The editor's + button after the checks (null: none), and whether checks can be stacked to run together. */
	add: string | null;
	together: boolean;
}

/**
 * The flow as control-loop block diagrams stacked one per phase: the plan loop (⊗ → Plan → plan, plan checks feeding
 * back as refine) hands the approved plan down to the implement loop (⊗ → Implement → change, change checks feeding
 * back as findings), which ends in Done.
 */
function diagram(loop: LoopShape, run: RunView | null, handlers: RenderHandlers, filter: string | null, onFilter: (id: string | null) => void): HTMLElement {
	const edit = handlers.edit;
	const items: SVGElement[] = [];
	const plan = run?.plan ?? "unused";
	const status = run?.status;
	const changeFindings = run ? run.findings.filter((f) => !f.id.startsWith("plan.")) : [];
	const open = changeFindings.filter(needsYou).length;
	const fixing = changeFindings.filter((f) => f.route === "fix" || f.decision?.decision === "fix").length;

	const arrow = (d: string, cls = "cv-flow") => items.push(sv("path", { d, class: `cv-wire ${cls}`, "marker-end": `url(#cv-arrow-${cls})` }));
	const label = (x: number, y: number, text: string, cls = "", anchor = "middle") => items.push(sv("text", { x, y, class: `cv-label ${cls}`, "text-anchor": anchor }, text));
	/** A 14px Lucide icon whose top-left corner is at (x, y). */
	const icon = (name: string, x: number, y: number, cls = "") => {
		const g = sv("g", { class: `cv-icon ${cls}`, transform: `translate(${x} ${y}) scale(${ICON / 24})` });
		g.innerHTML = ICONS[name] ?? "";
		return g;
	};
	const block = (x: number, y: number, w: number, title: string, sub: string, cls: string, iconName: string) => {
		const g = sv("g", { class: `cv-block ${cls}` });
		// One line centered when there's no status, two when there is.
		g.append(sv("rect", { x, y, width: w, height: ROW_H, rx: 8 }), icon(iconName, x + 12, y + (ROW_H - ICON) / 2), sv("text", { x: x + 34, y: sub ? y + 20 : y + ROW_H / 2 + 4, class: "cv-title" }, title));
		if (sub) g.append(sv("text", { x: x + 34, y: y + 35, class: "cv-sub" }, clip(sub, 16)));
		items.push(g);
	};
	const checkNode = (n: ShapeNode, x: number, y: number, fixed?: { fact: string; state: NodeState | null }) => {
		const { state, fact } = fixed ?? nodeFact(n.id, run);
		const selected = edit ? edit.selected === n.id : filter === n.id;
		const click = fixed ? null : edit?.onSelect ? () => edit.onSelect!(n.id) : run ? () => onFilter(filter === n.id ? null : n.id) : null;
		const g = sv("g", { class: `cv-node cv-${n.kind}${state ? ` is-${state}` : ""}${selected ? " is-selected" : ""}${click ? " clickable" : ""}`, onclick: click ? (e: Event) => (e.stopPropagation(), click()) : null });
		g.append(
			sv("rect", { x, y, width: NODE_W, height: NODE_H, rx: 7 }),
			icon((state && STATE_ICONS[state]) || KIND_ICONS[n.kind], x + 10, y + (NODE_H - ICON) / 2),
			sv("text", { x: x + 32, y: fact ? y + 17 : y + NODE_H / 2 + 4, class: "cv-title" }, clip(n.name, 15)),
			fact ? sv("text", { x: x + 32, y: y + 31, class: "cv-sub" }, clip(fact, 17)) : sv("g"),
			sv("title", {}, `${n.name} · ${n.kind === "you" ? "You" : KIND_LABELS[n.kind]}`),
		);
		items.push(g);
	};
	const addButton = (x: number, y: number, w: number, text: string, title: string, onclick: () => void) => {
		const g = sv("g", { class: "cv-add clickable", onclick: (e: Event) => (e.stopPropagation(), onclick()) });
		g.append(sv("rect", { x, y, width: w, height: 26, rx: 6 }), sv("text", { x: x + w / 2, y: y + 17, "text-anchor": "middle" }, text), sv("title", {}, title));
		items.push(g);
	};

	const sumX = PAD + 64;
	const agentX = sumX + 16 + 34;
	const outX = agentX + AGENT_W + 30;
	const stackOf = (seg: Segment) => Math.max(1, ...seg.stages.map((s) => s.nodes.length + (edit && seg.together ? 1 : 0)));
	const columnsOf = (seg: Segment) => seg.stages.length + (seg.implicit ? 1 : 0) + (edit && seg.add ? 1 : 0);
	const segmentWidth = (seg: Segment) => Math.max(outX + OUT_W - agentX, columnsOf(seg) * (NODE_W + STAGE_GAP) - STAGE_GAP + 2 * PAD);

	/** One loop band at y0: ⊗ → agent → output, its checks in a box below feeding back into ⊗. */
	const drawLoop = (y0: number, seg: Segment, boxW: number) => {
		const rowY = y0 + 24;
		const midY = rowY + ROW_H / 2;
		const boxX = agentX;
		const boxY = rowY + ROW_H + 30;
		const stack = stackOf(seg);
		const HEAD = 12;
		const boxH = 10 + HEAD + stack * (NODE_H + 8) + 6;
		const boxMid = boxY + 10 + HEAD + (Math.max(1, ...seg.stages.map((s) => s.nodes.length), 1) * (NODE_H + 8) - 8) / 2;
		const branchX = boxX + boxW + 20;
		if (seg.active) items.push(sv("rect", { x: sumX - 30, y: y0, width: branchX - sumX + 44, height: boxY + boxH - y0 + 8, rx: 12, class: "cv-frame is-active" }));
		label(sumX - 14, y0 + 14, seg.title, "cv-box-title", "start");
		items.push(sv("circle", { cx: sumX, cy: midY, r: 14, class: `cv-sum${seg.hot ? " is-hot" : ""}` }), sv("path", { d: `M${sumX - 10} ${midY - 10} L${sumX + 10} ${midY + 10} M${sumX + 10} ${midY - 10} L${sumX - 10} ${midY + 10}`, class: "cv-wire cv-cross" }));
		arrow(`M${sumX + 14} ${midY} H${agentX - 2}`);
		block(agentX, rowY, AGENT_W, seg.agent.title, seg.agent.sub, `cv-agent${seg.agent.active ? " is-active" : ""}`, seg.agent.icon);
		arrow(`M${agentX + AGENT_W} ${midY} H${outX - 2}`);
		block(outX, rowY, OUT_W, seg.output.title, seg.output.sub, "cv-plant", seg.output.icon);
		items.push(sv("path", { d: `M${outX + OUT_W} ${midY} H${branchX}`, class: "cv-wire" }));
		arrow(`M${branchX} ${midY} V${boxMid} H${boxX + boxW + 2}`);
		items.push(sv("rect", { x: boxX, y: boxY, width: boxW, height: boxH, rx: 10, class: "cv-box" }));
		arrow(`M${boxX} ${boxMid} H${sumX} V${midY + 16}`, seg.hot ? "cv-back" : "cv-idle");
		label(sumX - 6, boxMid - 4, seg.phase === "plan" ? "refine" : "findings", seg.hot ? "cv-warn" : "", "end");
		if (seg.hot?.text) label(sumX - 6, boxMid + 9, seg.hot.text, "cv-warn", "end");

		// Checks run right to left, the way the change flows back toward ⊗.
		const groupW = columnsOf(seg) * (NODE_W + STAGE_GAP) - STAGE_GAP;
		const right = boxX + (boxW + groupW) / 2;
		const colX = (i: number) => right - (i + 1) * NODE_W - i * STAGE_GAP;
		// Each stage is centered on the line through the box, so arrows meet the middle of the stage they enter.
		const topOf = (count: number) => boxMid - (Math.max(1, count) * (NODE_H + 8) - 8) / 2;
		/** A stage's lane: the tint its checks sit on when there are several. */
		const lane = (count: number, x: number) => {
			const h = Math.max(1, count) * (NODE_H + 8) - 8;
			if (count > 1) items.push(sv("rect", { x: x - 5, y: topOf(count) - 5, width: NODE_W + 10, height: h + 10, rx: 9, class: "cv-lane" }));
		};
		/** Drawn over the tiles: the stage's number on its top-right corner, and a + between checks that run together. */
		const marks = (i: number, count: number, x: number) => {
			const edge = count > 1 ? 5 : 0;
			const cx = x + NODE_W + edge - 2;
			const cy = topOf(count) - edge + 2;
			items.push(sv("circle", { cx, cy, r: 8, class: "cv-badge" }), sv("text", { x: cx, y: cy + 3.5, class: "cv-badge-text", "text-anchor": "middle" }, String(i + 1)));
			for (let k = 1; k < count; k++) {
				const py = topOf(count) + k * (NODE_H + 8) - 4;
				const g = sv("g", { class: "cv-join" });
				g.append(sv("circle", { cx: x + NODE_W / 2, cy: py, r: 7 }), sv("path", { d: `M${x + NODE_W / 2 - 3} ${py} h6 M${x + NODE_W / 2} ${py - 3} v6` }), sv("title", {}, "Runs at the same time"));
				items.push(g);
			}
		};
		// From the left edge of one stage (its lane, when it has one) to the right edge of the next.
		const between = (i: number, fromCount: number, toCount: number) => {
			const from = colX(i - 1) - (fromCount > 1 ? 5 : 0);
			const to = colX(i) + NODE_W + (toCount > 1 ? 5 : 0);
			const path = sv("path", { d: `M${from} ${boxMid} H${to + 2}`, class: "cv-wire cv-inner", "marker-end": "url(#cv-arrow-cv-inner)" });
			path.append(sv("title", {}, `Stage ${i + 1} runs only if stage ${i} is clean`));
			items.push(path);
		};
		const counts = [...seg.stages.map((s) => s.nodes.length), ...(seg.implicit ? [1] : [])];
		seg.stages.forEach((stage, i) => {
			const sx = colX(i);
			const top = topOf(stage.nodes.length);
			lane(stage.nodes.length, sx);
			if (i > 0) between(i, counts[i - 1], counts[i]);
			stage.nodes.forEach((n, k) => checkNode(n, sx, top + k * (NODE_H + 8)));
			marks(i, stage.nodes.length, sx);
			if (edit?.onAddToStage && seg.together) addButton(sx, top + stage.nodes.length * (NODE_H + 8) + 2, NODE_W, "+ run together", "Add a check that runs at the same time", () => edit.onAddToStage!(seg.phase, i));
		});
		let next = seg.stages.length;
		if (seg.implicit) {
			lane(1, colX(next));
			if (next > 0) between(next, counts[next - 1], 1);
			checkNode(seg.implicit, colX(next), topOf(1), seg.implicit);
			marks(next, 1, colX(next));
			next += 1;
		}
		if (edit?.onAddStage && seg.add) addButton(colX(next), boxMid - 13, NODE_W, seg.add, seg.phase === "plan" ? "Pick the AI reviewer that approves the plan" : "Add a check that runs after the others", () => edit.onAddStage!(seg.phase, seg.stages.length));
		return { midY, branchX, bottom: boxY + boxH + 8 };
	};

	const reviewAsk = run?.findings.find((f) => f.approval && needsYou(f));
	const reviewState = run?.nodes["@review"]?.state;
	const review: Segment["implicit"] =
		loop.finish === "review"
			? {
					id: "@review",
					name: "You review",
					kind: "you",
					...(reviewAsk
						? { fact: "waiting for you", state: "running" as const }
						: run?.pendingReview
							? { fact: "still waiting", state: "findings" as const }
							: reviewState === "passed"
								? { fact: "approved", state: "passed" as const }
								: reviewState === "findings"
									? { fact: "sent back", state: "findings" as const }
									: { fact: "", state: run ? ("waiting" as const) : null }),
				}
			: null;
	const planSeg: Segment | null =
		loop.plan !== "none"
			? {
					phase: "plan",
					title: "Plan loop",
					agent: { title: "Plan", sub: plan === "planning" ? "planning…" : plan === "checking" || plan === "review" ? "in review" : "", active: plan === "planning", icon: "pencil" },
					output: { title: "Plan", sub: plan === "approved" ? "approved" : "", icon: "file" },
					stages: loop.plan === "ai" && loop.planReviewer ? [{ nodes: [loop.planReviewer] }] : [],
					implicit:
						loop.plan === "you"
							? { id: "@plan-review", name: "You approve", kind: "you", fact: plan === "approved" ? "approved" : plan === "review" ? "waiting for you" : "", state: plan === "approved" ? "passed" : plan === "review" ? "running" : run ? "waiting" : null }
							: loop.plan === "ai" && plan === "review"
								? { id: "@plan-review", name: "You approve", kind: "you", fact: "waiting for you", state: "running" }
								: null,
					hot: run?.findings.some((f) => f.id.startsWith("plan.")) && plan !== "approved" ? { text: "revise", tone: "warn" } : null,
					active: plan === "planning" || plan === "checking" || plan === "review",
					add: loop.plan === "ai" && !loop.planReviewer ? "+ plan reviewer" : null,
					together: false,
				}
			: null;
	const changeSeg: Segment = {
		phase: "change",
		title: loop.plan !== "none" ? "Implement loop" : "Control loop",
		agent: {
			title: "Implement",
			sub: run ? `${STATUS_LABELS[run.status]}${run.pass && loop.maxPasses ? ` · ${run.pass}/${loop.maxPasses}` : ""}` : "",
			active: status === "implementing" || status === "fixing",
			icon: "wrench",
		},
		output: { title: "Change", sub: "", icon: "code" },
		stages: loop.stages,
		implicit: review,
		hot: open ? { text: `${open} for you`, tone: "warn" } : fixing ? { text: `${fixing} to fix`, tone: "accent" } : null,
		active: !!run && plan !== "planning" && plan !== "checking" && plan !== "review",
		add: "+ add check",
		together: true,
	};
	// Both bands share one width so their blocks line up.
	const boxW = Math.max(segmentWidth(changeSeg), planSeg ? segmentWidth(planSeg) : 0);

	let y = 6;
	const firstMid = y + 24 + ROW_H / 2;
	label(PAD, firstMid - 8, "Request", "", "start");
	arrow(`M${PAD} ${firstMid} H${sumX - 16}`);
	if (planSeg) {
		const p = drawLoop(y, planSeg, boxW);
		y = p.bottom + LOOP_GAP;
		const nextMid = y + 24 + ROW_H / 2;
		// The approved plan leaves the plan loop on the right and enters the implement loop's ⊗ from the left.
		const gapY = p.bottom + LOOP_GAP / 2 - 2;
		arrow(`M${p.branchX} ${p.midY} H${p.branchX + 18} V${gapY} H${PAD + 8} V${nextMid} H${sumX - 16}`, plan === "approved" ? "cv-flow" : "cv-idle");
		label(PAD + 16, gapY - 5, "approved plan", plan === "approved" ? "cv-ok" : "", "start");
	}
	const c = drawLoop(y, changeSeg, boxW);
	const doneX = c.branchX + 58;
	arrow(`M${c.branchX} ${c.midY} H${doneX}`);
	label(doneX - 2, c.midY - 8, loop.finish === "auto" ? "Done · auto" : "Done", status === "passed" ? "cv-ok" : "", "end");

	const width = doneX + PAD;
	const height = c.bottom + 4;
	const svg = sv("svg", { class: "cv-diagram", viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": `${loop.name} flow`, onclick: edit?.onSelect ? () => edit.onSelect!(null) : null });
	// Shrinks to fit a narrow pane, never grows past its natural size.
	svg.setAttribute("style", `max-width:${width}px`);
	const defs = sv("defs");
	for (const cls of ["cv-flow", "cv-back", "cv-idle", "cv-inner"]) {
		const m = sv("marker", { id: `cv-arrow-${cls}`, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
		m.append(sv("path", { d: "M0,0 L8,4 L0,8 z", class: `cv-head ${cls}` }));
		defs.append(m);
	}
	svg.append(defs, ...items);
	const planButton = (mode: PlanMode, text: string) =>
		el("button", { class: "btn ghost sm cv-plan-toggle", type: "button", onclick: () => edit!.onPlanMode!(mode) }, text);
	const planModes: Record<PlanMode, [PlanMode, string][]> = {
		none: [["you", "+ Plan first: the agent writes a plan you approve"], ["ai", "+ Plan first: an AI reviewer approves the plan"]],
		you: [["ai", "Let an AI reviewer approve the plan instead"], ["none", "Remove planning"]],
		ai: [["you", "Approve the plan myself instead"], ["none", "Remove planning"]],
	};
	const toggles = edit?.onPlanMode ? planModes[loop.plan].map(([mode, text]) => planButton(mode, text)) : [];
	const finish = edit?.onToggleFinish
		? el(
				"button",
				{ class: "btn ghost sm cv-plan-toggle", type: "button", onclick: () => edit.onToggleFinish!() },
				loop.finish === "review" ? "Finish without my review: done as soon as the checks pass" : "+ Finish with my review: approve the change or send it back",
			)
		: null;
	return el("div", { class: "cv-diagram-wrap" }, el("div", { class: "cv-toggles" }, ...toggles, finish), svg);
}

// MARK: findings

function card(f: FindingView, run: RunView, handlers: RenderHandlers): HTMLElement {
	const canDecide = handlers.onDecide && run.gate.open && needsYou(f);
	if (f.question) {
		const { options, chose } = f.question;
		const pick = (o: string, comment: string) => {
			const answer = questionAnswer(f, o);
			if (!answer) return null;
			if (!comment) return answer;
			return { decision: "fix" as const, note: answer.decision === "dismiss" ? `Keep "${o}". ${comment}` : `${answer.note ?? `Use "${o}".`} ${comment}` };
		};
		return el(
			"div",
			{ class: "cv-card cv-question", "data-id": f.id },
			el("div", { class: "cv-card-head" }, el("span", { class: "cv-rule" }, f.rule), el("span", { class: "cv-where" }, "the agent asks")),
			el("div", { class: "cv-expected" }, `It went with: ${chose}`),
			canDecide
				? choices(f, handlers, options.map((o) => ({ label: o === chose ? `Keep: ${o}` : o, primary: o === chose, decide: (c: string) => pick(o, c) })))
				: decided(f),
		);
	}
	if (f.approval) {
		const note = el("textarea", { class: "field cv-send-note", rows: 2, placeholder: "What should change? (sent to the agent)" });
		return el(
			"div",
			{ class: "cv-card cv-approval", "data-id": f.id },
			el("div", { class: "cv-card-head" }, el("span", { class: "cv-rule" }, f.rule), el("span", { class: "cv-where" }, f.nodeName)),
			el("pre", { class: "cv-summary" }, f.observed),
			canDecide ? note : null,
			canDecide
				? el(
						"div",
						{ class: "cv-actions" },
						el("button", { class: "btn sm primary", type: "button", onclick: () => handlers.onDecide!({ [f.id]: { decision: "dismiss" } }, false) }, "Approve"),
						el(
							"button",
							{
								class: "btn sm",
								type: "button",
								onclick: () => {
									const text = (note as HTMLTextAreaElement).value.trim();
									handlers.onDecide!({ [f.id]: text ? { decision: "fix", note: text } : { decision: "fix" } }, false);
								},
							},
							"Send back",
						),
					)
				: null,
		);
	}
	return el(
		"div",
		{ class: "cv-card", "data-id": f.id },
		el("div", { class: "cv-card-head" }, el("span", { class: "cv-rule" }, f.rule), where(f) ? el("span", { class: "cv-where" }, where(f)) : null),
		el("div", { class: "cv-observed" }, f.observed),
		el("div", { class: "cv-expected" }, `Should: ${f.expected}`),
		f.recurring ? el("div", { class: "cv-again" }, "Came back after the agent tried to fix it") : null,
		el(
			"details",
			{ class: "cv-details" },
			el("summary", {}, "Details"),
			el("div", { class: "cv-meta" }, `${f.nodeName} · ${f.severity}${f.certain ? "" : " · judgment call"}`),
		),
		canDecide
			? choices(f, handlers, [
					...(f.alternatives.length
						? f.alternatives.map((a, i) => ({ label: a, primary: i === 0, decide: (c: string) => ({ decision: "fix" as const, note: c ? `Fix it this way: ${a}. ${c}` : `Fix it this way: ${a}` }) }))
						: [{ label: "Fix it", primary: true, decide: (c: string) => (c ? { decision: "fix" as const, note: c } : { decision: "fix" as const }) }]),
					{ label: "Leave it as is", primary: false, decide: (c: string) => (c ? { decision: "dismiss" as const, note: c } : { decision: "dismiss" as const }) },
				])
			: decided(f),
	);
}

interface Choice {
	label: string;
	primary: boolean;
	decide(comment: string): Decision | null;
}

function choices(f: FindingView, handlers: RenderHandlers, list: Choice[]): HTMLElement {
	const comment = el("textarea", { class: "field cv-comment", rows: 2, placeholder: "Comment for the agent (optional; added to your choice)" }) as HTMLTextAreaElement;
	const send = (d: Decision | null) => {
		if (d) handlers.onDecide!({ [f.id]: d }, false);
	};
	return el(
		"div",
		{ class: "cv-choose" },
		el("div", { class: "cv-options" }, ...list.map((c) => el("button", { class: `btn sm${c.primary ? " primary" : ""}`, type: "button", onclick: () => send(c.decide(comment.value.trim())) }, c.label))),
		comment,
		el(
			"div",
			{ class: "cv-actions" },
			el("button", { class: "btn sm ghost", type: "button", title: "Send only your comment; the agent decides how to act on it", onclick: () => {
				const text = comment.value.trim();
				if (text) send({ decision: "fix", note: text });
				else comment.focus();
			} }, "Send comment only"),
		),
	);
}

function decided(f: FindingView): HTMLElement | null {
	if (!f.decision) return null;
	const base = f.decision.decision === "dismiss" ? "You left it as is" : "Sent to the agent";
	return el("div", { class: "cv-meta" }, f.decision.note ? `${base}: ${f.decision.note}` : base);
}

function line(f: FindingView): HTMLElement {
	const label = f.approval
		? f.decision?.decision === "fix"
			? "You sent it back"
			: "You approved"
		: f.decision
			? f.decision.decision === "fix"
				? "You: fix"
				: "You: dismissed"
			: f.route === "fix"
				? "To fix"
				: "Dismissed";
	return el("div", { class: "cv-line", title: f.approval ? (f.decision?.note ?? "") : `${f.observed}\nShould: ${f.expected}` }, el("span", { class: "cv-line-label" }, label), el("span", { class: "cv-rule" }, f.approval ? f.rule : f.rule), where(f) ? el("span", { class: "cv-where" }, where(f)) : null);
}

function findings(run: RunView, handlers: RenderHandlers, filter: string | null): HTMLElement[] {
	const shown = run.findings.filter((f) => !filter || f.node === filter);
	const open = shown.filter(needsYou);
	const rest = shown.filter((f) => !needsYou(f));
	const out: HTMLElement[] = [];
	if (filter) out.push(el("div", { class: "cv-filter" }, `Showing ${run.findings.find((f) => f.node === filter)?.nodeName ?? "one check"} only · click it again for all`));
	if (open.length) out.push(el("div", { class: "cv-cards" }, ...open.map((f) => card(f, run, handlers))));
	if (rest.length) out.push(el("details", { class: "cv-folded", open: open.length ? null : "" }, el("summary", {}, `${plural(rest.length, "other finding")} this pass`), ...rest.map(line)));
	const allOpen = run.findings.filter(needsYou);
	if (handlers.onDecide && run.gate.open && allOpen.length) {
		const plain = allOpen.filter((f) => !f.approval && !f.question);
		const all = (decision: Decision["decision"]) => Object.fromEntries(plain.map((f) => [f.id, { decision }]));
		out.push(
			el(
				"div",
				{ class: "cv-gate" },
				el("span", {}, run.gate.reason === "limit" ? "Pass limit reached; the rest is up to you." : `${plural(allOpen.length, "decision")} waiting for you.`),
				el("span", { class: "cv-spacer" }),
				plain.length > 1 ? el("button", { class: "btn sm", type: "button", onclick: () => handlers.onDecide!(all("fix"), false) }, "Fix all") : null,
				plain.length > 1 ? el("button", { class: "btn sm", type: "button", onclick: () => handlers.onDecide!(all("dismiss"), false) }, "Dismiss all") : null,
				el("button", { class: "btn sm ghost", type: "button", onclick: () => handlers.onDecide!({}, true) }, "Pause loop"),
			),
		);
	}
	return out;
}

/** Draws the flow's block diagram with the run's live state, then the findings that need a decision (unless `decisions: false`). */
export function renderLoop(root: HTMLElement, loop: LoopShape, run: RunView | null, handlers: RenderHandlers = {}, options: { decisions?: boolean } = {}): void {
	loop = withPlanMode(loop);
	const filter = root.dataset.filter && run?.findings.some((f) => f.node === root.dataset.filter) ? root.dataset.filter : null;
	const onFilter = (id: string | null) => {
		if (id) root.dataset.filter = id;
		else delete root.dataset.filter;
		renderLoop(root, loop, run, handlers, options);
	};
	const children: Node[] = [];
	const decisions = options.decisions !== false;
	if (run?.note && decisions) children.push(el("div", { class: "cv-note" }, run.note));
	children.push(diagram(loop, run, handlers, filter, onFilter));
	if (run && !handlers.edit) {
		if (decisions) children.push(...findings(run, handlers, filter));
		if (run.history.length) children.push(el("div", { class: "cv-history" }, run.history.map((h) => `pass ${h.pass}: ${h.result === "fixes" ? `${h.findings} to fix` : h.result}`).join(" · ")));
	}
	root.replaceChildren(el("div", { class: "cv" }, ...children));
}

/** The findings waiting for you, then the run's other findings, with the decision controls. */
export function renderDecisions(root: HTMLElement, run: RunView, handlers: RenderHandlers): void {
	root.replaceChildren(el("div", { class: "cv" }, ...findings(run, handlers, null)));
}

/** One sentence saying where the run is and what, if anything, waits for you. */
export function runHeadline(run: RunView): string {
	const pass = run.pass && run.loop.maxPasses ? `Pass ${run.pass} of ${run.loop.maxPasses} · ` : "";
	const waiting = run.findings.filter(needsYou);
	if (run.gate.open && waiting.length) {
		const review = waiting.some((f) => f.approval);
		const others = waiting.filter((f) => !f.approval).length;
		return pass + (others ? `${plural(others, "decision")} need${others === 1 ? "s" : ""} you` : review ? "Checks passed · your review is waiting" : "Waiting for you");
	}
	if (run.status === "checking") {
		const names = run.loop.stages.flatMap((s) => s.nodes).filter((n) => run.nodes[n.id]?.state === "running").map((n) => n.name);
		return `${pass}Checking${names.length ? `: ${names.join(", ")}` : ""}`;
	}
	if (run.status === "fixing") return `${pass}The agent is fixing ${plural(run.findings.filter((f) => f.route === "fix" || f.decision?.decision === "fix").length, "finding")}`;
	if (run.status === "passed") return run.pendingReview ? `${pass}Checks passed · your review is waiting` : `${pass}Passed`;
	if (run.status === "implementing") return "The agent is working; the checks run when it's done";
	return `${pass}${STATUS_LABELS[run.status]}${run.note ? ` · ${run.note}` : ""}`;
}
