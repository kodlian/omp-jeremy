import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadLibrary, summarize } from "../src/library";

let home: string;
let repo: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "control-home-"));
	repo = await mkdtemp(join(tmpdir(), "control-repo-"));
	process.env.OMP_CONTROL_HOME = home;
});

afterEach(async () => {
	delete process.env.OMP_CONTROL_HOME;
	await rm(home, { recursive: true, force: true });
	await rm(repo, { recursive: true, force: true });
});

async function put(path: string, text: string) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text);
}

const reviewer = (name: string) => `---\nname: ${name}\nkind: review\n---\n\nReview the change.\n`;

test("a repo control overrides a global one, which overrides a built-in", async () => {
	await put(join(home, "nodes/quality-reviewer.md"), reviewer("Global quality"));
	let library = await loadLibrary(repo);
	expect(library.controls.get("quality-reviewer")).toMatchObject({ name: "Global quality", source: "global" });
	expect(library.controls.get("conventions-reviewer")?.source).toBe("built-in");

	const path = join(repo, ".omp/control/nodes/quality-reviewer.md");
	await put(path, reviewer("Repo quality"));
	library = await loadLibrary(repo);
	expect(library.controls.get("quality-reviewer")).toMatchObject({ name: "Repo quality", source: "repo", path });
});

test("a reviewer file with keys Control no longer reads loads; a check without a command is an error", async () => {
	await put(join(home, "nodes/docs-reviewer.md"), "---\nname: Docs\nkind: review\nask: doubts\ntools:\n  - read\n  - grep\nmodel: anthropic/claude-sonnet-4-5\ntimeout: 600\nresources:\n  - docs/STYLE.md\n---\n\nCheck the docs.\n");
	await put(join(home, "nodes/tests.md"), "---\nname: Tests\nkind: check\ncommand: bun test\n---\n");
	const broken = join(home, "nodes/build.md");
	await put(broken, "---\nname: Build\nkind: check\n---\n");
	const library = await loadLibrary(repo);
	expect(library.controls.get("docs-reviewer")).toMatchObject({ kind: "review", name: "Docs", command: null, timeout: null });
	expect(library.controls.get("tests")).toMatchObject({ kind: "check", command: "bun test", timeout: 900 });
	expect(library.controls.has("build")).toBe(false);
	expect(library.errors).toEqual([{ path: broken, message: `${broken}: a check needs a command` }]);
});

test("a set naming a missing control is dropped and listed", async () => {
	const path = join(repo, ".omp/control/sets/docs.json");
	await put(path, JSON.stringify({ name: "Docs", controls: ["quality-reviewer", "ghost"] }));
	const library = await loadLibrary(repo);
	expect(library.sets.has("docs")).toBe(false);
	expect(library.errors).toEqual([{ path, message: `${path}: set docs names missing controls: ghost` }]);
});

test("a set's approval defaults to apply; any other value is an error", async () => {
	await put(join(home, "sets/quick.json"), JSON.stringify({ name: "Quick", controls: ["quality-reviewer"] }));
	const odd = join(home, "sets/odd.json");
	await put(odd, JSON.stringify({ name: "Odd", controls: ["quality-reviewer"], approval: "maybe" }));
	const library = await loadLibrary(repo);
	expect(library.sets.get("quick")).toMatchObject({ approval: "apply", description: "", controls: ["quality-reviewer"], source: "global" });
	expect(library.sets.has("odd")).toBe(false);
	expect(library.errors).toEqual([{ path: odd, message: `${odd}: approval must be apply or ask` }]);
});

test("the built-in library loads cleanly with the review and quality sets", async () => {
	const library = await loadLibrary(null);
	expect(library.errors).toEqual([]);
	expect(summarize(library).map((s) => [s.id, s.controls, s.approval])).toEqual([
		["quality", ["Quality"], "apply"],
		["review", ["Quality", "Conventions", "Project rules"], "apply"],
	]);
});
