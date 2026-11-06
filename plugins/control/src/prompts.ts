import type { FindingView, Scope, Severity } from "omp-control-view/protocol";
import type { ChangedFile } from "./git";
import type { LoopSnapshot, NodeDefinition } from "./library";

export interface RawFinding {
	file: string | null;
	line: number | null;
	rule: string;
	observed: string;
	expected: string;
	alternatives: string[];
	severity: Severity;
	certain: boolean;
}

const SEVERITIES: Severity[] = ["blocker", "major", "minor"];
const FENCE = "```";

export function reviewerSystemPrompt(node: NodeDefinition): string {
	const parts = [
		`You are "${node.name}", a reviewer in a control loop. You never modify files and you only use the ${node.tools.join(", ")} tools. Review the change attached to the user message against the instructions below; read any repository file you need for context.`,
		`## Instructions\n${node.instructions}`,
	];
	if (node.resources.length) parts.push(`## Read these first\n${node.resources.map((r) => `- ${r}`).join("\n")}\nSkip any that don't exist.`);
	parts.push(
		[
			"## Report",
			"Report only problems in the changed code, or in callers it breaks. No praise, no summary of what is fine.",
			"End your final message with exactly one fenced json block:",
			`${FENCE}json`,
			`{"findings":[{"file":"path/from/repo/root","line":42,"rule":"short name of the rule or expectation","observed":"what the code does","expected":"what it should do instead","alternatives":["a concrete acceptable fix"],"severity":"blocker|major|minor","certain":true}]}`,
			FENCE,
			"certain is true only when the code must change according to the instructions or project rules; use false for judgment calls the user should decide. An empty findings list means the change passes.",
		].join("\n"),
	);
	return parts.join("\n\n");
}

/** What a plan check reads: the request and the proposed plan; there's no code change yet. */
export function planPacketText(input: { loopName: string; nodeName: string; prompts: string[]; plan: string }): string {
	return [
		"# Plan to review",
		`Loop: ${input.loopName} · reviewer: ${input.nodeName}`,
		"Nothing is implemented yet: review the plan below, not code. Report a finding for each problem in the plan (file and line may be null, or name the files the plan should touch).",
		`## What the user asked\n${input.prompts.join("\n\n---\n\n") || "(no prompt recorded)"}`,
		`## Proposed plan\n${input.plan}`,
	].join("\n\n");
}

export function reviewPacketText(input: {
	loopName: string;
	nodeName: string;
	pass: number;
	prompts: string[];
	plan: string | null;
	baseline: string;
	packet: { stat: string; diff: string; truncated: boolean };
	/** What the user already answered about this reviewer's findings, and the notes they sent back from their final review. */
	answers?: string[];
}): string {
	const asked = input.plan ?? input.prompts.join("\n\n---\n\n");
	const parts = [
		"# Change to review",
		`Loop: ${input.loopName} · reviewer: ${input.nodeName} · pass ${input.pass}`,
		`## What the user asked\n${asked || "(no prompt recorded)"}`,
		`## Changed files\n${input.packet.stat || "(none)"}`,
		`## Diff (since ${input.baseline.slice(0, 12)})\n${FENCE}diff\n${input.packet.diff.trimEnd()}\n${FENCE}`,
	];
	if (input.packet.truncated) parts.push("The diff was cut at 80,000 characters; read the remaining changed files directly.");
	if (input.answers?.length) {
		parts.push(`## The user already answered\nDon't flag these again, however you'd phrase them, unless the answer says to and the change still doesn't do it:\n${input.answers.map((a) => `- ${a}`).join("\n")}`);
	}
	return `${parts.join("\n\n")}\n`;
}

/** The text of the last assistant message in omp's JSON-mode event lines. */
export function finalText(lines: string[]): string {
	let text = "";
	for (const line of lines) {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!event || typeof event !== "object" || !("type" in event) || event.type !== "message_end" || !("message" in event)) continue;
		const message = event.message;
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant" || !("content" in message)) continue;
		const content = Array.isArray(message.content) ? message.content : [];
		text = content
			.filter((b: unknown) => b && typeof b === "object" && "type" in b && b.type === "text" && "text" in b && typeof b.text === "string")
			.map((b: { text: string }) => b.text)
			.join("");
	}
	return text;
}

function cut(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function requiredText(raw: Record<string, unknown>, key: string, i: number): string {
	const value = raw[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`Reviewer output had no valid findings JSON: finding ${i + 1} has no ${key}`);
	return cut(value.trim(), 600);
}

export function parseFindings(text: string): RawFinding[] {
	const fail = (reason: string) => new Error(`Reviewer output had no valid findings JSON: ${reason}`);
	const blocks = [...text.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)];
	const block = blocks.at(-1);
	if (!block) throw fail("no ```json block");
	let parsed: unknown;
	try {
		parsed = JSON.parse(block[1]);
	} catch (e) {
		throw fail(e instanceof Error ? e.message : String(e));
	}
	if (!parsed || typeof parsed !== "object" || !("findings" in parsed) || !Array.isArray(parsed.findings)) throw fail('expected {"findings": [...]}');
	return parsed.findings.map((item: unknown, i: number): RawFinding => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw fail(`finding ${i + 1} isn't an object`);
		const raw = item as Record<string, unknown>; // checked to be a plain object just above
		const file = raw.file === undefined || raw.file === null || raw.file === "" ? null : raw.file;
		if (file !== null && typeof file !== "string") throw fail(`finding ${i + 1} has a non-text file`);
		const line = raw.line === undefined || raw.line === null ? null : raw.line;
		if (line !== null && (typeof line !== "number" || !Number.isInteger(line) || line < 1)) throw fail(`finding ${i + 1} has an invalid line`);
		const alternatives = raw.alternatives ?? [];
		if (!Array.isArray(alternatives) || alternatives.some((a) => typeof a !== "string")) throw fail(`finding ${i + 1} has invalid alternatives`);
		const severity = raw.severity ?? "major";
		if (!SEVERITIES.includes(severity as Severity)) throw fail(`finding ${i + 1} has severity ${String(severity)}`);
		const certain = raw.certain ?? false;
		if (typeof certain !== "boolean") throw fail(`finding ${i + 1} has a non-boolean certain`);
		return {
			file,
			line,
			rule: requiredText(raw, "rule", i),
			observed: requiredText(raw, "observed", i),
			expected: requiredText(raw, "expected", i),
			alternatives: alternatives.slice(0, 5).map((a: string) => cut(a, 300)),
			severity: severity as Severity,
			certain,
		};
	});
}

function tail(output: string): string {
	const lines = output.trimEnd().split("\n").slice(-60).join("\n");
	return lines.length > 6000 ? lines.slice(-6000) : lines;
}

export function checkFinding(node: NodeDefinition, code: number, output: string): RawFinding {
	return { file: null, line: null, rule: `command failed (exit ${code})`, observed: tail(output) || "(no output)", expected: `\`${node.command}\` exits 0 from the repository root`, alternatives: [], severity: "blocker", certain: true };
}

export function timeoutFinding(node: NodeDefinition, output: string): RawFinding {
	return { ...checkFinding(node, 0, output), rule: `command timed out after ${node.timeout}s` };
}

function numbered(items: FindingView[], start: number): string[] {
	return items.map((f, i) => {
		if (f.approval) return `${start + i}. [${f.nodeName}] The user sent the change back: ${f.decision?.note || "no note; ask what to change"}`;
		const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""} —` : "";
		const lines = [`${start + i}. [${f.nodeName}]${where} ${f.rule}`, `   Observed: ${f.observed}`, `   Expected: ${f.expected}`];
		if (f.alternatives.length) lines.push(`   Acceptable fixes: ${f.alternatives.join("; ")}`);
		if (f.decision?.note) lines.push(`   User note: ${f.decision.note}`);
		return lines.join("\n");
	});
}

export function fixMessage(loopName: string, pass: number, maxPasses: number, fix: FindingView[], consider: FindingView[], dismissed: number): string {
	const what = fix.length === 1 ? "this finding" : `these ${fix.length} findings`;
	const parts = [`Control loop «${loopName}» — pass ${pass} of ${maxPasses}: fix ${what}, then call control_check again before your final answer.`, numbered(fix, 1).join("\n")];
	if (consider.length) parts.push(`Judgment calls — apply only if you agree, and say which you skipped:\n${numbered(consider, fix.length + 1).join("\n")}`);
	if (dismissed > 0) parts.push(`The user dismissed ${dismissed} finding${dismissed === 1 ? "" : "s"}; don't act on them.`);
	return parts.join("\n\n");
}

export function passedMessage(loopName: string, pass: number, nodes: string[], dismissed = 0): string {
	const extra = dismissed > 0 ? ` (${dismissed} dismissed by the user.)` : "";
	return `Control loop «${loopName}» passed on pass ${pass}: ${nodes.join(" ✓, ")} ✓. Give your final answer.${extra}`;
}

export function judgmentCalls(consider: FindingView[]): string {
	return `Judgment calls — apply only if you agree, and say which you skipped:\n${numbered(consider, 1).join("\n")}`;
}

const MAX_GROUPS = 12;

/**
 * What your final review shows before you approve: the request, the final change grouped by folder with line counts, what
 * the loop fixed on the way, and how many findings you already answered.
 */
export function reviewSummary(input: { requests: string[]; files: ChangedFile[]; fixed: { nodeName: string; file: string | null; rule: string }[]; answered: number }): string {
	const lines: string[] = [];
	const requests = input.requests.map((r) => cut(r.replace(/\s+/g, " ").trim(), 240));
	if (requests.length === 1) lines.push(`Request: ${requests[0]}`);
	else if (requests.length) lines.push("Requests:", ...requests.map((r) => `  - ${r}`));
	const added = input.files.reduce((n, f) => n + f.added, 0);
	const removed = input.files.reduce((n, f) => n + f.removed, 0);
	lines.push(`Changed: ${input.files.length} file${input.files.length === 1 ? "" : "s"}, +${added} −${removed}`);
	const groups = new Map<string, ChangedFile[]>();
	for (const f of input.files) {
		const slash = f.path.lastIndexOf("/");
		const dir = slash < 0 ? "." : f.path.slice(0, slash);
		groups.set(dir, [...(groups.get(dir) ?? []), f]);
	}
	const sorted = [...groups.entries()].sort((a, b) => b[1].reduce((n, f) => n + f.added + f.removed, 0) - a[1].reduce((n, f) => n + f.added + f.removed, 0));
	for (const [dir, files] of sorted.slice(0, MAX_GROUPS)) {
		const names = files.map((f) => `${f.path.slice(dir === "." ? 0 : dir.length + 1)}${f.isNew ? " (new)" : ""}`).join(", ");
		lines.push(`  ${dir === "." ? "" : `${dir}/ — `}${names}  +${files.reduce((n, f) => n + f.added, 0)} −${files.reduce((n, f) => n + f.removed, 0)}`);
	}
	if (sorted.length > MAX_GROUPS) lines.push(`  …and ${sorted.length - MAX_GROUPS} more folders`);
	if (input.fixed.length) {
		lines.push(`Fixed during the loop:`);
		for (const f of input.fixed.slice(0, 10)) lines.push(`  - [${f.nodeName}] ${f.file ? `${f.file} — ` : ""}${f.rule}`);
		if (input.fixed.length > 10) lines.push(`  …and ${input.fixed.length - 10} more`);
	}
	if (input.answered) lines.push(`You already answered ${input.answered} finding${input.answered === 1 ? "" : "s"}.`);
	return lines.join("\n");
}

export const CHECK_REQUEST = "Run control_check on the current changes and fix what it reports before your final answer.";

export function stopReason(loopName: string): string {
	return `Control loop «${loopName}»: your latest changes haven't been checked. Call control_check before your final answer. If you're stopping to ask the user something or you can't finish, call control_check with incomplete set to the reason.`;
}

export function stagesText(loop: { stages: { nodes: { name: string }[] }[] }): string {
	return loop.stages.map((s) => s.nodes.map((n) => n.name).join(" + ")).join(" → ");
}

export function contextMessage(loop: LoopSnapshot): string {
	return `This session runs the control loop «${loop.name}» (${stagesText(loop)}). When your implementation is complete, call control_check before your final answer; fix what it reports and call it again until it passes. Never edit files under .omp/control to make the loop pass.`;
}

export function draftPrompt(input: { kind?: "check" | "review"; name?: string; intent: string; scope: Scope }): string {
	const noun = input.kind === "review" ? "reviewer" : input.kind === "check" ? "check" : "node";
	const named = input.name ? ` named "${input.name}"` : "";
	const decide = input.kind
		? ""
		: " Decide whether it should be a check (a shell command that must exit 0 from the repository root) or a reviewer (an agent that reads the change).";
	return `Help me create a Control ${noun}${named} for this project: ${input.intent}.${decide} Research what it needs first: this repository's conventions (AGENTS.md, rules, skills, docs), representative existing code it should compare against, and authoritative external references when they help. Then save it with control_library (action "save", kind "node", scope "${input.scope}"): a reviewer gets focused instructions (what to check, what counts as certain versus a judgment call) and resources to read first (repository paths, skill:// URLs, web URLs); a check gets its command. Show me what you saved and ask what to adjust.`;
}
