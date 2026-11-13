// The Control plugin's run view and bus protocol, shared with every page and plugin that shows a loop.
export const RUN_EVENT = "control:run"; // payload: RunView | null (null = no loop attached)
export const LIBRARY_EVENT = "control:library"; // payload: LibrarySummary
export const COMMAND_EVENT = "control:command"; // payload: ControlCommand

/** check: a command that must exit 0; review: an AI reviewer. */
export type NodeKind = "check" | "review";
/** How a loop ends once its checks pass: you review the change, or it's done (and an Orchestrator task can merge). */
export type Finish = "review" | "auto";
/** How a request is planned: not at all; in omp plan mode with you approving the plan; or with one AI reviewer approving it. */
export type PlanMode = "none" | "you" | "ai";
export type AskMode = "doubts" | "all" | "never";
export type Severity = "blocker" | "major" | "minor";

export interface NodeShape {
	id: string;
	name: string;
	kind: NodeKind;
}

export interface LoopShape {
	id: string | null;
	name: string;
	description: string;
	maxPasses: number;
	/** none: the agent implements the request; you and ai: it starts in omp plan mode and implements once you, or the
	 * plan reviewer, approve the plan. */
	plan: PlanMode;
	/** The reviewer that approves the plan in ai mode, else null; its id is unique among the loop's nodes. */
	planReviewer: NodeShape | null;
	stages: { nodes: NodeShape[] }[];
	finish: Finish;
}

/** Where a library item lives: repo (.omp/control, committed), global (every repo), built-in; repo overrides global overrides built-in. */
export type Source = "repo" | "global" | "built-in";
export type Scope = Exclude<Source, "built-in">;

export interface LoopSummary extends LoopShape {
	id: string;
	source: Source;
}

export interface LibrarySummary {
	repo: string | null;
	loops: LoopSummary[];
}

export type NodeState = "waiting" | "running" | "passed" | "findings" | "failed" | "error" | "skipped";
export type RunStatus = "idle" | "planning" | "implementing" | "checking" | "deciding" | "fixing" | "passed" | "deferred" | "paused" | "stalled";
export type PlanState = "unused" | "planning" | "review" | "approved";

export interface Decision {
	decision: "fix" | "dismiss";
	note?: string;
}

export interface FindingView {
	id: string;
	node: string;
	nodeName: string;
	file: string | null;
	line: number | null;
	rule: string;
	observed: string;
	expected: string;
	alternatives: string[];
	severity: Severity;
	certain: boolean;
	recurring: boolean;
	/** The end-of-loop review: fix means sent back (with the note), dismiss means approved. */
	approval: boolean;
	/** A choice the implementing agent wasn't sure of: dismiss keeps what it chose, fix with a note picks another option. */
	question?: { options: string[]; chose: string };
	route: "fix" | "ask" | "dismissed";
	decision: Decision | null;
}

export interface RunView {
	version: 1;
	loop: LoopShape;
	plan: PlanState;
	status: RunStatus;
	pass: number;
	stage: number | null;
	/** artifacts: images the node's last run wrote to $CONTROL_ARTIFACTS (absolute paths), shown with your review. */
	nodes: Record<string, { state: NodeState; detail: string | null; findings: number; durationMs: number | null; artifacts: string[] }>;
	findings: FindingView[];
	gate: { open: boolean; reason: "doubts" | "limit" | null };
	note: string | null;
	history: { pass: number; result: "passed" | "fixes" | "paused" | "deferred" | "interrupted"; findings: number; at: string }[];
	/** Reviews you finished, newest first: each is history once the next cycle starts. */
	reviews: ReviewRecord[];
	/** The review waiting for you, kept across new instructions until you answer it; each instruction since it opened is listed. */
	pendingReview: PendingReview | null;
	updatedAt: string;
}

export interface ReviewRecord {
	at: string;
	pass: number;
	requests: string[];
	summary: string;
	outcome: "approved" | "sent back";
	note: string | null;
	/** Every question, doubt and finding you answered in that review, with your answer. */
	answers: { nodeName: string; rule: string; answer: string }[];
}

export interface PendingReview {
	since: string;
	requests: string[];
}

/** Your answer to an agent question: its own choice keeps it; another option (or your own text) goes back as a fix. */
export function questionAnswer(f: FindingView, picked: string | undefined): Decision | null {
	if (!f.question || !picked) return null;
	if (picked === f.question.chose) return { decision: "dismiss" };
	return { decision: "fix", note: f.question.options.includes(picked) ? `Use «${picked}» instead of «${f.question.chose}»` : picked };
}

export interface ControlReply {
	ok: boolean;
	message: string;
	library?: LibrarySummary;
	run?: RunView | null;
}

export type ControlCommand =
	| { type: "library"; reply(r: ControlReply): void }
	| { type: "run"; reply(r: ControlReply): void }
	| { type: "decide"; decisions: Record<string, Decision>; pause: boolean; reply(r: ControlReply): void }
	| { type: "open"; reply(r: ControlReply): void };
