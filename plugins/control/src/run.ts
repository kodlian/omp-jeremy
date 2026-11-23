import type { ControlApproval } from "omp-integrations/control";
import type { Baseline } from "./git";

/** What a control run checks: control ids from the library, and what happens to their findings. */
export interface Selection {
	label: string;
	controls: string[];
	approval: ControlApproval;
}

export interface State {
	baseline: Baseline | null;
	auto: Selection | null;
	run: { selection: Selection; nudges: number; delivered: boolean } | null;
	settled: { fingerprint: string; passed: boolean } | null;
	last: { label: string; passed: boolean } | null;
}

export const MAX_NUDGES = 2;

export function empty(): State {
	return { baseline: null, auto: null, run: null, settled: null, last: null };
}

/** A restored session keeps baseline, auto, settled and last; a run in flight is dropped. */
export function restored(saved: Partial<State> | undefined): State {
	const { baseline = null, auto = null, settled = null, last = null } = saved ?? {};
	return { baseline, auto, run: null, settled, last };
}

export type Stop = { kind: "allow" } | { kind: "nudge" } | { kind: "stalled" } | { kind: "start"; selection: Selection };

/** What a stop does: a run in flight sends the agent back until it reports; auto starts a run on an unchecked change. */
export function onStop(state: State, fingerprint: string, promptFingerprint: string | null): Stop {
	const run = state.run;
	if (run && !run.delivered) return { kind: "allow" };
	if (run && run.nudges >= MAX_NUDGES) {
		state.last = { label: run.selection.label, passed: false };
		state.settled = { fingerprint, passed: false };
		state.run = null;
		return { kind: "stalled" };
	}
	if (run) {
		run.nudges += 1;
		return { kind: "nudge" };
	}
	if (state.auto && fingerprint !== "clean" && fingerprint !== promptFingerprint && fingerprint !== state.settled?.fingerprint) {
		state.run = { selection: state.auto, nudges: 0, delivered: true };
		return { kind: "start", selection: state.auto };
	}
	return { kind: "allow" };
}

/** Ends the run in flight; returns its selection, or null when none is running. */
export function onReport(state: State, fingerprint: string, passed: boolean): Selection | null {
	const run = state.run;
	if (!run) return null;
	state.settled = { fingerprint, passed };
	state.last = { label: run.selection.label, passed };
	state.run = null;
	return run.selection;
}

export function status(state: State, fingerprint: string): { passed: boolean; autonomous: boolean } {
	return {
		passed: state.run === null && state.settled?.passed === true && state.settled.fingerprint === fingerprint,
		autonomous: state.auto?.approval === "apply",
	};
}

/** The line under the editor, or null for none. */
export function line(state: State): string | null {
	if (state.run) return `Control · running ${state.run.selection.label}${state.auto ? " · auto" : ""}`;
	if (!state.auto) return null;
	const last = state.last ? (state.last.passed ? " · ✓ passed" : " · ✗ not passed") : "";
	return `Control · auto · ${state.auto.label}${last}`;
}
