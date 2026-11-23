import { expect, test } from "bun:test";
import type { ControlDefinition } from "../src/library";
import { RUN_HEAD, runPrompt } from "../src/prompts";

const base = "0123456789abcdef0123456789abcdef01234567";
const tests: ControlDefinition = { id: "tests", name: "Tests", kind: "check", description: "", command: "bun test", timeout: 120, path: "/repo/.omp/control/nodes/tests.md", source: "repo" };
const lint: ControlDefinition = { ...tests, id: "lint", name: "Lint", command: "bun run lint", timeout: 60, path: "/repo/.omp/control/nodes/lint.md" };
const quality: ControlDefinition = { id: "quality-reviewer", name: "Quality", kind: "review", description: "", command: null, timeout: null, path: "/library/nodes/quality-reviewer.md", source: "built-in" };
const rules: ControlDefinition = { ...quality, id: "rules-reviewer", name: "Project rules", path: "/library/nodes/rules-reviewer.md" };

test("a run lists its shell checks, then its reviewers, and ends with control_report", () => {
	const text = runPrompt({ base, approval: "apply", controls: [tests, lint, quality, rules] });
	expect(text).toStartWith(`${RUN_HEAD} check this repository's change since 0123456789ab`);
	expect(text).toContain(`CONTROL_BASE=${base}`);
	expect(text).toContain("1. Tests (stop it after 120 s)\n```sh\nbun test\n```");
	expect(text).toContain("2. Lint (stop it after 60 s)\n```sh\nbun run lint\n```");
	expect(text).toContain(`- Quality: ${quality.path}\n- Project rules: ${rules.path}`);
	expect(text).toContain("leave the task's agent unset");
	expect(text.indexOf("## Shell checks")).toBeLessThan(text.indexOf("## Reviewers"));
	expect(text).toContain("\n5. Call control_report with passed true when the last pass was clean (judgment calls you skipped don't count), else false.");
});

test("a run with only checks has no reviewers section and no spawn step", () => {
	const text = runPrompt({ base, approval: "apply", controls: [tests] });
	expect(text).not.toContain("## Reviewers");
	expect(text).not.toContain("Spawn");
	expect(text).toContain("\n1. Run the shell checks. Fix what fails and run them again until they pass.\n");
	expect(text).toContain("\n3. Call control_report with passed true when the last pass was clean, else false.");
});

test("a run with only reviewers has no shell checks section", () => {
	const text = runPrompt({ base, approval: "apply", controls: [quality] });
	expect(text).not.toContain("## Shell checks");
	expect(text).toContain("\n1. Spawn the reviewers and wait for all of them.\n");
});

test("ask has the user approve each finding with the agent's recommendation; apply never asks", () => {
	const ask = runPrompt({ base, approval: "ask", controls: [quality] });
	expect(ask).toContain("set recommended");
	expect(ask).toContain("findings the user skipped don't count");
	const apply = runPrompt({ base, approval: "apply", controls: [quality] });
	expect(apply).not.toMatch(/\bask tool\b/);
	expect(apply).toContain("Fix every certain finding.");
});
