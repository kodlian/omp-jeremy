import { expect, test } from "bun:test";
import { parsePlan } from "../src/shared/blocks.js";
import { feedbackMessage } from "../src/shared/feedback.js";
import { compareRevisions } from "../src/shared/revision.js";

const PLAN = `# Plan

Intro paragraph
over two lines.

1. First step
2. Second step
   - nested a
   - nested b
3. Third <script>alert(1)</script>

[bad](javascript:alert(1)) and [good](https://x.y)
`;

test("blocks carry their own source lines, list items one by one", () => {
	const { blocks } = parsePlan(PLAN);
	expect(blocks.map((b) => [b.start, b.end, b.text])).toEqual([
		[1, 1, "# Plan"],
		[3, 4, "Intro paragraph\nover two lines."],
		[6, 6, "1. First step"],
		[7, 7, "2. Second step"],
		[8, 8, "- nested a"],
		[9, 9, "- nested b"],
		[10, 10, "3. Third <script>alert(1)</script>"],
		[12, 12, "[bad](javascript:alert(1)) and [good](https://x.y)"],
	]);
});

test("the agent's HTML and unsafe links don't render", () => {
	const { html } = parsePlan(PLAN);
	expect(html).not.toContain("<script>");
	expect(html).toContain("&lt;script&gt;");
	expect(html).not.toContain("javascript:");
	expect(html).toContain('<a href="https://x.y"');
});

test("revisions: rewritten, added and removed blocks become hunks in order", () => {
	const before = parsePlan("# Plan\n\n- keep\n- old step\n- dropped\n\nEnd").blocks;
	const after = parsePlan("# Plan\n\nNew intro\n\n- keep\n- new step\n\nEnd").blocks;
	const id = (text: string) => after.find((b) => b.text === text)!.id;
	expect(compareRevisions(before, after)).toEqual([
		{ blocks: [id("New intro")], before: [], after: id("# Plan") },
		{ blocks: [id("- new step")], before: ["- old step", "- dropped"], after: id("- keep") },
	]);
	expect(compareRevisions(after, after)).toEqual([]);
	expect(compareRevisions(parsePlan("A\n\nB").blocks, parsePlan("A").blocks)).toEqual([{ blocks: [], before: ["B"], after: "b0" }]);
});

test("feedback quotes each comment's lines, then the overall note", () => {
	const comments = [
		{ start: 3, end: 3, excerpt: "1. First step", note: "Why first?" },
		{ start: 5, end: 9, excerpt: "a\nb\nc\nd\ne\nf", note: "Too long" },
		{ start: 10, end: 10, excerpt: "x", note: "  " },
	];
	expect(feedbackMessage(comments, " Ship it smaller ")).toBe(
		[
			"Plan review: 2 comments on the plan.",
			"1. Line 3:\n> 1. First step\nWhy first?",
			"2. Lines 5–9:\n> a\n> b\n> c\n> d …\nToo long",
			"Overall: Ship it smaller",
		].join("\n\n"),
	);
	expect(feedbackMessage([], "Just this")).toBe("Just this");
	expect(feedbackMessage([], "  ")).toBe("");
});
