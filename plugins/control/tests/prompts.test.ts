import { expect, test } from "bun:test";
import type { FindingView } from "omp-control-view/protocol";
import { checkFinding, finalText, fixMessage, parseFindings } from "../src/prompts";
import type { NodeDefinition } from "../src/library";

const fence = "```";

test("the last json block wins and defaults apply", () => {
	const text = [
		"Looked around.",
		`${fence}json\n{"findings":[{"rule":"old","observed":"x","expected":"y"}]}\n${fence}`,
		"Final:",
		`${fence}json\n{"findings":[{"file":"src/a.ts","line":3,"rule":" No any ","observed":"uses any","expected":"a type","alternatives":["unknown"]},{"rule":"r","observed":"o","expected":"e","severity":"minor","certain":true}]}\n${fence}`,
	].join("\n");
	expect(parseFindings(text)).toEqual([
		{ file: "src/a.ts", line: 3, rule: "No any", observed: "uses any", expected: "a type", alternatives: ["unknown"], severity: "major", certain: false },
		{ file: null, line: null, rule: "r", observed: "o", expected: "e", alternatives: [], severity: "minor", certain: true },
	]);
	expect(parseFindings(`${fence}json\n{"findings":[]}\n${fence}`)).toEqual([]);
});

test("a missing block or a finding without a rule is an error", () => {
	expect(() => parseFindings("All good!")).toThrow("Reviewer output had no valid findings JSON");
	expect(() => parseFindings(`${fence}json\n{"findings":[{"observed":"o","expected":"e"}]}\n${fence}`)).toThrow("finding 1 has no rule");
	expect(() => parseFindings(`${fence}json\n{"findings":[{"rule":"r","observed":"o","expected":"e","line":0}]}\n${fence}`)).toThrow("invalid line");
});

test("finalText takes the text of the last assistant message_end", () => {
	const lines = [
		JSON.stringify({ type: "session" }),
		"not json",
		JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "prompt" }] } }),
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }),
		JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "tool" }] } }),
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }, { type: "text", text: "final " }, { type: "text", text: "answer" }] } }),
		JSON.stringify({ type: "agent_end" }),
	];
	expect(finalText(lines)).toBe("final answer");
});

const finding = (over: Partial<FindingView>): FindingView => ({
	id: "1.1",
	node: "quality",
	nodeName: "Quality",
	file: "src/a.ts",
	line: 12,
	rule: "Empty list",
	observed: "crashes on []",
	expected: "returns 0",
	alternatives: ["guard the length", "use reduce with 0"],
	severity: "major",
	certain: true,
	recurring: false,
	route: "fix",
	decision: null,
	...over,
});

test("fixMessage gives every item its location, observed, expected and acceptable fixes", () => {
	const text = fixMessage("Review", 1, 4, [finding({}), finding({ id: "1.2", file: null, line: null, rule: "Build", alternatives: [], decision: { decision: "fix", note: "keep it small" } })], [finding({ id: "1.3", rule: "Naming" })], 2);
	expect(text).toStartWith("Control loop «Review» — pass 1 of 4: fix these 2 findings, then call control_check again before your final answer.");
	expect(text).toContain("1. [Quality] src/a.ts:12 — Empty list\n   Observed: crashes on []\n   Expected: returns 0\n   Acceptable fixes: guard the length; use reduce with 0");
	expect(text).toContain("2. [Quality] Build\n   Observed: crashes on []\n   Expected: returns 0\n   User note: keep it small");
	expect(text).toContain("Judgment calls — apply only if you agree, and say which you skipped:\n3. [Quality] src/a.ts:12 — Naming");
	expect(text).toEndWith("The user dismissed 2 findings; don't act on them.");
	expect(fixMessage("Review", 2, 4, [finding({})], [], 0)).toStartWith("Control loop «Review» — pass 2 of 4: fix this finding,");
});

test("a failed check reports the tail of its output", () => {
	const node = { command: "make test" } as NodeDefinition;
	const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
	const f = checkFinding(node, 2, output);
	expect(f).toMatchObject({ rule: "command failed (exit 2)", expected: "`make test` exits 0 from the repository root", severity: "blocker", certain: true });
	expect(f.observed.split("\n")).toHaveLength(60);
	expect(f.observed).toEndWith("line 99");
});
