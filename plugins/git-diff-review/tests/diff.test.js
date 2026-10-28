import assert from "node:assert/strict";
import { test } from "bun:test";
import { changedSpan, parseUnifiedDiff, splitDiff } from "../src/shared/diff.js";
import { blockStarts, changeBlockAround, pairRows } from "../src/shared/layout.js";
import { wordSpans } from "../web/render.js";

const row = (kind, oldLineNumber, newLineNumber, text) => ({
  kind,
  oldLineNumber,
  newLineNumber,
  oldText: oldLineNumber == null ? null : text.slice(1),
  newText: newLineNumber == null ? null : text.slice(1),
  text,
});
const hunk = (text) => ({ kind: "hunk", oldLineNumber: null, newLineNumber: null, oldText: null, newText: null, text });

test("parseUnifiedDiff matches the server row model", () => {
  const raw = [
    "diff --git a/x b/x",
    "index 111..222 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -1,3 +1,3 @@ fn main()",
    " keep",
    "-old",
    "\\ No newline at end of file",
    "+new",
    " tail",
    "@@ -5 +5 @@",
    "-five",
    "+FIVE",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
    "",
  ].join("\n");
  const parsed = parseUnifiedDiff(raw);
  assert.deepEqual(parsed.rows, [
    hunk("@@ -1,3 +1,3 @@ fn main()"),
    row("context", 1, 1, " keep"),
    row("deletion", 2, null, "-old"),
    row("addition", null, 2, "+new"),
    row("context", 3, 3, " tail"),
    hunk("@@ -5 +5 @@"),
    row("deletion", 5, null, "-five"),
    row("addition", null, 5, "+FIVE"),
  ]);
  assert.equal(parsed.additions, 2);
  assert.equal(parsed.deletions, 2);
});

test("parseUnifiedDiff truncates at 5000 rows", () => {
  const raw = ["@@ -0,0 +1,6000 @@", ...Array.from({ length: 6000 }, (_, i) => `+l${i}`)].join("\n");
  const parsed = parseUnifiedDiff(raw);
  assert.equal(parsed.rows.length, 5000);
  assert.equal(parsed.truncated, true);
});

test("splitDiff separates files and reads add, delete, rename and binary headers", () => {
  const raw = [
    "diff --git a/src/a.js b/src/a.js",
    "index 1..2 100644",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1 +1 @@",
    "-a",
    "+A",
    "diff --git a/new.md b/new.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.md",
    "@@ -0,0 +1,2 @@",
    "+x",
    "+y",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-keep",
    "diff --git a/old name.txt b/new name.txt",
    "similarity index 100%",
    "rename from old name.txt",
    "rename to new name.txt",
    "diff --git a/logo.png b/logo.png",
    "Binary files a/logo.png and b/logo.png differ",
    "",
  ].join("\n");
  const files = splitDiff(raw).map(({ rows, ...f }) => ({ ...f, rows: rows.length }));
  assert.deepEqual(files, [
    { path: "src/a.js", origPath: null, status: "M", binary: false, rows: 3, additions: 1, deletions: 1, truncated: false },
    { path: "new.md", origPath: null, status: "A", binary: false, rows: 3, additions: 2, deletions: 0, truncated: false },
    { path: "gone.txt", origPath: null, status: "D", binary: false, rows: 2, additions: 0, deletions: 1, truncated: false },
    { path: "new name.txt", origPath: "old name.txt", status: "R", binary: false, rows: 0, additions: 0, deletions: 0, truncated: false },
    { path: "logo.png", origPath: null, status: "M", binary: true, rows: 0, additions: 0, deletions: 0, truncated: false },
  ]);
});

test("pairRows pairs deletion and addition runs index-wise", () => {
  const a = row("deletion", 1, null, "-a");
  const b = row("deletion", 2, null, "-b");
  const c = row("addition", null, 1, "+c");
  assert.deepEqual(pairRows([a, b, c]), [
    { left: a, right: c },
    { left: b, right: null },
  ]);
});

test("change blocks merge a deletion run with the following additions", () => {
  const rows = parseUnifiedDiff("@@ -1,6 +1,6 @@\n a\n-b\n-c\n+B\n d\n-e\n+E\n").rows;
  assert.deepEqual(changeBlockAround(rows, 3), [2, 4]);
  assert.deepEqual(changeBlockAround(rows, 1), [1, 1]);
  assert.deepEqual(blockStarts(rows), [2, 6]);
});

test("changedSpan isolates the edited middle of a line", () => {
  assert.deepEqual(changedSpan("return total(a)", "return sum(a)"), { a: [7, 12], b: [7, 10] });
});

test("wordSpans marks only similar modified pairs", () => {
  const rows = parseUnifiedDiff("@@ -1,2 +1,2 @@\n-const total = items.reduce(sum, 0)\n-xyz\n+const total = items.reduce(add, 0)\n+completely different\n").rows;
  const spans = wordSpans(rows.slice(1));
  assert.deepEqual(spans.get(rows[1]), [27, 30]);
  assert.deepEqual(spans.get(rows[3]), [27, 30]);
  assert.equal(spans.has(rows[2]), false);
});
