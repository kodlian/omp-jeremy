import { expect, test } from "bun:test";
import { empty, line, onReport, onStop, restored, type Selection, type State, status } from "../src/run";

const review: Selection = { label: "Review", controls: ["quality-reviewer"], approval: "apply" };

test("auto starts a run on an unchecked change, and a reported pass settles it", () => {
	const state: State = { ...empty(), auto: review };
	expect(onStop(state, "fp1", "fp0")).toEqual({ kind: "start", selection: review });
	expect(line(state)).toBe("Control · running Review · auto");
	expect(onReport(state, "fp1", true)).toBe(review);
	expect(onStop(state, "fp1", "fp0")).toEqual({ kind: "allow" });
	expect(status(state, "fp1")).toEqual({ passed: true, autonomous: true });
	expect(status({ ...state, auto: { ...review, approval: "ask" } }, "fp1")).toEqual({ passed: true, autonomous: false });
	expect(line(state)).toBe("Control · auto · Review · ✓ passed");
});

test("auto starts no run when the request changed no file", () => {
	const state: State = { ...empty(), auto: review };
	expect(onStop(state, "fp0", "fp0")).toEqual({ kind: "allow" });
	expect(onStop(state, "clean", null)).toEqual({ kind: "allow" });
	expect(state.run).toBeNull();
});

test("a delivered run that stops without a report is nudged twice, then stalls", () => {
	const state: State = { ...empty(), auto: review, run: { selection: review, nudges: 0, delivered: true } };
	expect(onStop(state, "fp1", null)).toEqual({ kind: "nudge" });
	expect(onStop(state, "fp1", null)).toEqual({ kind: "nudge" });
	expect(onStop(state, "fp1", null)).toEqual({ kind: "stalled" });
	expect(state).toMatchObject({ run: null, settled: { fingerprint: "fp1", passed: false }, last: { label: "Review", passed: false } });
	expect(onStop(state, "fp1", null)).toEqual({ kind: "allow" });
	expect(line(state)).toBe("Control · auto · Review · ✗ not passed");
});

test("a run whose prompt is still queued lets the turn stop and starts no auto run", () => {
	const state: State = { ...empty(), auto: review, run: { selection: review, nudges: 0, delivered: false } };
	expect(onStop(state, "fp1", "fp0")).toEqual({ kind: "allow" });
	expect(state.run).toEqual({ selection: review, nudges: 0, delivered: false });
});

test("a pass stops counting once the tree changes", () => {
	const state: State = { ...empty(), run: { selection: review, nudges: 0, delivered: true } };
	onReport(state, "fp1", true);
	expect(status(state, "fp1").passed).toBe(true);
	expect(status(state, "fp2").passed).toBe(false);
	expect(onReport(state, "fp2", true)).toBeNull();
});

test("a restored session drops the run in flight and keeps the rest", () => {
	const saved: State = {
		baseline: { kind: "merge-base", ref: "main" },
		auto: review,
		run: { selection: review, nudges: 1, delivered: true },
		settled: { fingerprint: "fp1", passed: true },
		last: { label: "Review", passed: true },
	};
	expect(restored(saved)).toEqual({ ...saved, run: null });
	expect(restored(undefined)).toEqual(empty());
});
