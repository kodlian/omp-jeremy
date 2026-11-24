import type { ControlApproval, ControlDefinition } from "./library";

export const RUN_HEAD = "Control run:";
export const MAX_PASSES = 3;
export const NUDGE = "A control run is in progress and control_report hasn't been called. Finish the run and call control_report; if you can't finish, call control_report with passed false.";

const FENCE = "```";

const APPROVAL: Record<ControlApproval, { step: string; skipped: string }> = {
	apply: {
		step: "Fix every certain finding. Apply a judgment call only when you agree with it.",
		skipped: "judgment calls you skipped don't count",
	},
	ask: {
		step: "Show the reviewers' findings to the user with the ask tool before changing anything: one question per finding with the options Apply and Skip. When you have a view on a finding, set recommended to that option so it is preselected. Fix only the findings the user chose to apply. Failing shell checks are fixed without asking.",
		skipped: "findings the user skipped don't count",
	},
};

/** The message that runs the selected controls on the change since base: checks, then reviewer subagents, fixes, and a confirming pass. */
export function runPrompt(input: { base: string; approval: ControlApproval; controls: ControlDefinition[] }): string {
	const checks = input.controls.filter((c) => c.kind === "check");
	const reviewers = input.controls.filter((c) => c.kind === "review");
	const change = `\`git diff ${input.base}\` plus untracked files`;
	const approval = APPROVAL[input.approval];
	const parts = [`${RUN_HEAD} check this repository's change since ${input.base.slice(0, 12)} (everything since that commit, committed or not: ${change}) with the controls below. Never edit files under .omp/control.`];
	if (checks.length) {
		parts.push(
			[
				"## Shell checks",
				`Run each from the repository root with CONTROL_BASE=${input.base} exported. A check passes when it exits 0.`,
				...checks.map((c, i) => `${i + 1}. ${c.name} (stop it after ${c.timeout} s)\n${FENCE}sh\n${c.command}\n${FENCE}`),
			].join("\n"),
		);
	}
	if (reviewers.length) {
		parts.push(
			[
				"## Reviewers",
				`Spawn one subagent per reviewer with the task tool, all in one batch. Use the default agent for every one: leave the task's agent unset, and never pick a named agent (reviewer, code-reviewer, scout or any other), whatever the control is about. Each one audits and never edits files. Give each one its control file to read and follow (it reads the header's resources first and skips any that don't exist), the change to review (${change}), and this report format: only problems in the changed code or in callers it breaks; for each finding the file and line, what the code does, what it should do, a concrete fix, and whether it is certain (the code must change) or a judgment call.`,
				...reviewers.map((c) => `- ${c.name}: ${c.path}`),
				"If you can't spawn subagents, do each audit yourself, one reviewer at a time.",
			].join("\n"),
		);
	}
	const again = checks.length && reviewers.length ? "the shell checks, then every reviewer again" : checks.length ? "the shell checks again" : "every reviewer again";
	const steps = [
		checks.length ? `Run the shell checks. Fix what fails and run them again until they pass${reviewers.length ? ", before any reviewer runs" : ""}.` : null,
		reviewers.length ? "Spawn the reviewers and wait for all of them." : null,
		reviewers.length ? approval.step : null,
		`If you changed anything, run another pass (${again}) to confirm the fixes hold and broke nothing. Stop after a clean pass, or after ${MAX_PASSES} passes.`,
		`Call control_report with passed true when the last pass was clean${reviewers.length ? ` (${approval.skipped})` : ""}, else false. Then give your final answer: per control, what it found, what you fixed and what is left.`,
	].filter((s) => s !== null);
	parts.push(["## Steps", ...steps.map((s, i) => `${i + 1}. ${s}`)].join("\n"));
	return parts.join("\n\n");
}
