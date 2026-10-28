import { expect, test } from "bun:test";
import { parseUnifiedDiff } from "../src/shared/diff.js";
import { expandRows, revealRange } from "../src/shared/expand.js";

// 30-line file: line 10 changed, line 25 deleted (old file had 31 lines).
const lines = Array.from({ length: 30 }, (_, i) => (i === 9 ? "TEN" : `l${i + 1}`));
const rows = parseUnifiedDiff(
	["@@ -7,7 +7,7 @@", " l7", " l8", " l9", "-l10", "+TEN", " l11", " l12", " l13", "@@ -23,5 +23,4 @@", " l23", " l24", "-l25", " l26", " l27"].join("\n"),
).rows;

const gaps = (out: Array<{ gap?: { from: number; to: number; delta: number } }>) => out.filter((r) => r.gap).map((r) => [r.gap?.from, r.gap?.to, r.gap?.delta]);

test("unrevealed gaps become expanders; trailing size unknown until lines load", () => {
	expect(gaps(expandRows(rows, null, []))).toEqual([
		[1, 6, 0],
		[14, 22, 0],
		[27, Number.POSITIVE_INFINITY, 1],
	]);
	expect(gaps(expandRows(rows, lines, []))).toEqual([
		[1, 6, 0],
		[14, 22, 0],
		[27, 30, 1],
	]);
});

test("revealing up and down leaves the middle hidden and maps old line numbers", () => {
	const gap = { from: 14, to: 22, delta: 0 };
	const out = expandRows(rows, lines, [revealRange(gap, "down", 2), revealRange(gap, "up", 3)]);
	expect(gaps(out)).toEqual([
		[1, 6, 0],
		[16, 19, 0],
		[27, 30, 1],
	]);
	const tail = expandRows(rows, lines, [[27, 30]]).filter((r) => r.newLineNumber && r.newLineNumber >= 27);
	expect(tail.map((r) => [r.oldLineNumber, r.newLineNumber, r.newText])).toEqual([
		[28, 27, "l27"],
		[29, 28, "l28"],
		[30, 29, "l29"],
		[31, 30, "l30"],
	]);
});

test("a fully revealed gap merges the hunks", () => {
	const out = expandRows(rows, lines, [[1, 30]]);
	expect(out.filter((r) => r.kind === "hunk")).toHaveLength(0);
	expect(out.map((r) => r.newLineNumber).filter((n) => n != null)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
});
