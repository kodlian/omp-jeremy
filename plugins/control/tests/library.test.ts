import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNodeFile, serializeNode } from "../src/frontmatter";
import { copyItem, deleteItem, loadLibrary, type NodeDefinition, nodeFrom, resolveLoop, saveLoop, saveNode, validateSnapshot } from "../src/library";

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

const reviewer: NodeDefinition = {
	id: "docs-reviewer",
	name: "Docs reviewer",
	kind: "review",
	description: "Docs match: the code's behavior",
	command: null,
	timeout: 600,
	ask: "all",
	model: "anthropic/claude-sonnet-4-5",
	thinking: "low",
	tools: ["read", "grep"],
	resources: ["docs/style guide.md", "it's ok", "skill://writing"],
	instructions: "Check the README.\n\n- Every flag is documented.",
};

test("a node survives a write and a read: lists, quoted text and '' escapes", () => {
	const text = serializeNode(reviewer);
	const { fields, body } = parseNodeFile(text, "x.md");
	expect(nodeFrom(reviewer.id, fields, body, "x.md")).toEqual(reviewer);

	const check: NodeDefinition = { ...reviewer, id: "tests", name: "Tests", kind: "check", command: `bun test --grep "a: b" && echo 'done'`, timeout: 120, ask: "doubts", tools: [], model: null, thinking: null, resources: [], instructions: "" };
	const parsed = parseNodeFile(serializeNode(check), "c.md");
	expect(nodeFrom("tests", parsed.fields, parsed.body, "c.md")).toEqual(check);

	const hand = parseNodeFile("---\nname: 'It''s a check'\n# comment\n\nkind: check\ncommand: \"make \\\"all\\\"\"\ntimeout: 30\n---\n", "h.md");
	expect(hand.fields).toEqual({ name: "It's a check", kind: "check", command: 'make "all"', timeout: 30 });
});

test("bad node files are rejected with the path and field", () => {
	expect(() => parseNodeFile("---\nname: A\ncolor: red\n---\n", "n.md")).toThrow('n.md: unknown key "color"');
	const noCommand = parseNodeFile("---\nname: Build\nkind: check\n---\n", "b.md");
	expect(() => nodeFrom("build", noCommand.fields, noCommand.body, "b.md")).toThrow("b.md: a check needs a command");
	const editor = parseNodeFile("---\nname: Fixer\nkind: review\ntools:\n  - read\n  - edit\n---\nFix things", "f.md");
	expect(() => nodeFrom("fixer", editor.fields, editor.body, "f.md")).toThrow(/f\.md: tools can only be .*not edit/);
	const noBody = parseNodeFile("---\nname: Empty\nkind: review\n---\n", "e.md");
	expect(() => nodeFrom("empty", noBody.fields, noBody.body, "e.md")).toThrow("e.md: a reviewer needs instructions");
});

test("repo overrides global, which overrides built-in; bad files are listed, not fatal", async () => {
	const globalNode = { ...reviewer, id: "quality-reviewer", name: "Global quality" };
	await saveNode(repo, "global", globalNode);
	let library = await loadLibrary(repo);
	expect(library.nodes.get("quality-reviewer")).toMatchObject({ source: "global", overrides: ["built-in"], node: { name: "Global quality" } });
	expect(library.nodes.get("conventions-reviewer")).toMatchObject({ source: "built-in", overrides: [] });

	await saveNode(repo, "repo", { ...globalNode, name: "Repo quality" });
	await mkdir(join(repo, ".omp/control/loops"), { recursive: true });
	await writeFile(join(repo, ".omp/control/loops/broken.json"), "{ nope");
	library = await loadLibrary(repo);
	expect(library.nodes.get("quality-reviewer")).toMatchObject({ source: "repo", overrides: ["global", "built-in"], node: { name: "Repo quality" } });
	expect(library.loops.get("review")?.source).toBe("built-in");
	expect(library.errors.map((e) => e.path)).toEqual([join(repo, ".omp/control/loops/broken.json")]);

	await deleteItem(repo, "repo", "node", "quality-reviewer");
	expect((await loadLibrary(repo)).nodes.get("quality-reviewer")?.source).toBe("global");
	await expect(deleteItem(repo, "repo", "loop", "review")).rejects.toThrow("built-in loops can't be deleted");
});

test("items copy or move between levels", async () => {
	await saveNode(repo, "global", reviewer);
	const moved = await copyItem(repo, await loadLibrary(repo), "node", "docs-reviewer", "repo", true);
	expect(moved).toBe(join(repo, ".omp/control/nodes/docs-reviewer.md"));
	expect((await loadLibrary(repo)).nodes.get("docs-reviewer")).toMatchObject({ source: "repo", overrides: [] });
	await copyItem(repo, await loadLibrary(repo), "node", "quality-reviewer", "global", false);
	expect((await loadLibrary(repo)).nodes.get("quality-reviewer")).toMatchObject({ source: "global", overrides: ["built-in"] });
	await expect(copyItem(repo, await loadLibrary(repo), "loop", "review", "repo", true)).rejects.toThrow("Built-in loops can't move");
});

test("saveLoop writes the repo loop file and refuses unknown nodes; resolveLoop names missing nodes", async () => {
	await saveNode(repo, "repo", reviewer);
	let library = await loadLibrary(repo);
	const loop = { id: "docs", name: "Docs", description: "", maxPasses: 2, stages: [{ nodes: ["docs-reviewer"] }, { nodes: ["quality-reviewer"] }] };
	const path = await saveLoop(repo, "repo", loop, library);
	expect(path).toBe(join(repo, ".omp/control/loops/docs.json"));
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ name: "Docs", description: "", maxPasses: 2, plan: false, planStages: [], stages: loop.stages, finish: "review" });
	await expect(saveLoop(repo, "repo", { ...loop, stages: [{ nodes: ["ghost", "phantom"] }] }, library)).rejects.toThrow("Loop docs needs missing nodes: ghost, phantom");

	library = await loadLibrary(repo);
	expect(resolveLoop(library, "docs").stages[0].nodes[0]).toEqual(reviewer);
	await rm(join(repo, ".omp/control/nodes/docs-reviewer.md"));
	const reloaded = await loadLibrary(repo);
	expect(() => resolveLoop(reloaded, "docs")).toThrow("Loop docs needs missing nodes: docs-reviewer");
});

test("loop and session snapshot limits", () => {
	expect(() => validateSnapshot({ name: "X", stages: Array.from({ length: 9 }, () => ({ nodes: [] })) })).toThrow("stages must list 0–8 stages");
	expect(() => validateSnapshot({ name: "X", stages: [], finish: "later" })).toThrow("finish must be review or auto");
	expect(validateSnapshot({ name: "X", stages: [] })).toMatchObject({ stages: [], finish: "review" });
	expect(() => validateSnapshot({ name: "X", stages: [{ nodes: [reviewer, reviewer] }] })).toThrow("node docs-reviewer appears twice");
	expect(() => validateSnapshot({ name: "X", maxPasses: 11, stages: [{ nodes: [reviewer] }] })).toThrow("maxPasses must be 1–10");
	expect(validateSnapshot({ id: null, name: "X", stages: [{ nodes: [reviewer] }] })).toMatchObject({ id: null, maxPasses: 4, stages: [{ nodes: [reviewer] }] });
});
