import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseUnifiedDiff } from "../src/shared/diff.js";
import { compactLineRefs, formatPin, pinFromSelection, referenceFor, reviewMessage } from "../src/shared/reference.js";

const rowsOf = (raw, lo, hi) => parseUnifiedDiff(raw).rows.slice(lo, hi + 1);

test("reference covers the new-side range and lists deleted lines", () => {
  const raw = "@@ -10,3 +10,4 @@\n ctx1\n-old\n+new1\n+new2\n ctx2";
  assert.equal(referenceFor("src/foo.swift", rowsOf(raw, 1, 5)), "@src/foo.swift#L10-L13 (deleted: L11)");
});

test("single added line yields a single-number reference", () => {
  assert.equal(referenceFor("src/foo.py", rowsOf("@@ -5 +5 @@\n+only\n", 1, 1)), "@src/foo.py#L5");
});

test("pure deletion references the file with a deleted suffix", () => {
  assert.equal(referenceFor("a/b.go", rowsOf("@@ -7,2 +7,0 @@\n-gone1\n-gone2\n", 1, 2)), "@a/b.go (deleted: L7-L8)");
});

test("header-only selection yields an empty reference", () => {
  assert.equal(referenceFor("x", rowsOf("diff --git a/x b/x\n@@ -1 +1 @@\n", 0, 0)), "");
});

test("compactLineRefs collapses runs", () => {
  assert.equal(compactLineRefs([10, 11, 12, 15, 20, 21]), "L10-L12, L15, L20-L21");
});

test("pins rebuild the same reference, including pure deletions", () => {
  const mixed = rowsOf("@@ -10,3 +10,4 @@\n ctx1\n-old\n+new1\n+new2\n ctx2", 1, 5);
  assert.equal(formatPin(pinFromSelection("src/foo.swift", mixed, "local")), "@src/foo.swift#L10-L13 (deleted: L11)");
  const gone = rowsOf("@@ -7,2 +7,0 @@\n-gone1\n-gone2\n", 1, 2);
  assert.equal(formatPin(pinFromSelection("a/b.go", gone, "local")), "@a/b.go (deleted: L7-L8)");
});

test("reviewMessage sorts pins and indents multi-line notes", () => {
  const pin = (path, startLine, endLine, deletedOld, note) => ({ path, startLine, endLine, hasNew: true, deletedOld, note });
  const message = reviewMessage([
    pin("b.py", 30, 35, [28], "the removed validation was load-bearing"),
    pin("a.py", 42, 58, [], "this ignores the cache\nand the TTL is wrong"),
  ]);
  assert.equal(
    message,
    "Please address these review comments:\n" +
      "- @a.py#L42-L58 — this ignores the cache\n" +
      "  and the TTL is wrong\n" +
      "- @b.py#L30-L35 (deleted: L28) — the removed validation was load-bearing",
  );
});
