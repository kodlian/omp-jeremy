import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type AskMode, type Finish, type LibrarySummary, type LoopShape, type NodeKind, type PlanMode, type Scope, type Source, withPlanMode } from "omp-control-view/protocol";
import { errorText } from "omp-integrations/text";
import { parseNodeFile, serializeNode } from "./frontmatter";

export interface NodeDefinition {
	id: string;
	name: string;
	kind: NodeKind;
	description: string;
	command: string | null;
	timeout: number;
	ask: AskMode;
	model: string | null;
	thinking: string | null;
	tools: string[];
	resources: string[];
	instructions: string;
}

export interface LoopDefinition {
	id: string;
	name: string;
	description: string;
	maxPasses: number;
	plan: PlanMode;
	finish: Finish;
	planReviewer: string | null;
	stages: { nodes: string[] }[];
}

export interface LoopSnapshot {
	id: string | null;
	name: string;
	description: string;
	maxPasses: number;
	plan: PlanMode;
	finish: Finish;
	planReviewer: NodeDefinition | null;
	stages: { nodes: NodeDefinition[] }[];
}

export interface Library {
	loops: Map<string, { loop: LoopDefinition; source: Source; path: string; overrides: Source[] }>;
	nodes: Map<string, { node: NodeDefinition; source: Source; path: string; overrides: Source[] }>;
	errors: { path: string; message: string }[];
	/** Loop ids whose file doesn't load, with why. */
	broken: Map<string, string>;
}

export const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REVIEWER_TOOLS = ["read", "grep", "glob", "find", "ast_grep", "web_search"];
const DEFAULT_TOOLS = ["read", "grep", "glob"];
const ASK_MODES: AskMode[] = ["doubts", "all", "never"];
const PLAN_MODES: PlanMode[] = ["none", "you", "ai"];
const BUILT_IN = join(dirname(realpathSync(import.meta.path)), "..", "library");

export function libraryRoots(root: string | null): Record<Scope, string | null> & { builtIn: string } {
	return {
		repo: root ? join(root, ".omp", "control") : null,
		global: process.env.OMP_CONTROL_HOME || join(homedir(), ".omp", "control"),
		builtIn: BUILT_IN,
	};
}

function optionalText(fields: Record<string, unknown>, key: string, where: string): string | null {
	const value = fields[key];
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string") throw new Error(`${where}: ${key} must be text`);
	return value;
}

function textList(fields: Record<string, unknown>, key: string, where: string): string[] | null {
	const value = fields[key];
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) throw new Error(`${where}: ${key} must be a list of text`);
	return value.map((v: string) => v.trim());
}

function checkId(id: string, where: string, what: string) {
	if (!ID.test(id)) throw new Error(`${where}: ${what} "${id}" must be lowercase letters, digits and dashes (at most 63)`);
}

/** A node from its header fields and body, with defaults applied; throws naming the path and field. */
export function nodeFrom(id: string, fields: Record<string, unknown>, body: string, where: string): NodeDefinition {
	checkId(id, where, "node id");
	const name = typeof fields.name === "string" ? fields.name.trim() : "";
	if (name.length < 1 || name.length > 60) throw new Error(`${where}: name must be 1–60 characters`);
	const kind = fields.kind;
	if (kind !== "check" && kind !== "review") throw new Error(`${where}: kind must be check or review`);
	const description = optionalText(fields, "description", where) ?? "";
	const ask = optionalText(fields, "ask", where) ?? "doubts";
	if (!ASK_MODES.includes(ask as AskMode)) throw new Error(`${where}: ask must be doubts, all or never`);
	const [min, max, fallback] = kind === "check" ? [1, 7200, 900] : [30, 3600, 600];
	const timeout = fields.timeout ?? fallback;
	if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < min || timeout > max) {
		throw new Error(`${where}: timeout must be ${min}–${max} seconds`);
	}
	const resources = textList(fields, "resources", where) ?? [];
	if (resources.length > 20) throw new Error(`${where}: resources has at most 20 entries`);
	let command: string | null = null;
	let tools: string[] = [];
	if (kind === "check") {
		command = optionalText(fields, "command", where)?.trim() || null;
		if (!command) throw new Error(`${where}: a check needs a command`);
	} else {
		if (!body.trim()) throw new Error(`${where}: a reviewer needs instructions (the text after the header)`);
		tools = textList(fields, "tools", where) ?? DEFAULT_TOOLS;
		const bad = tools.filter((t) => !REVIEWER_TOOLS.includes(t));
		if (bad.length) throw new Error(`${where}: tools can only be ${REVIEWER_TOOLS.join(", ")}; reviewers never modify files (not ${bad.join(", ")})`);
	}
	return {
		id,
		name,
		kind,
		description,
		command,
		timeout,
		ask: ask as AskMode,
		model: optionalText(fields, "model", where),
		thinking: optionalText(fields, "thinking", where),
		tools,
		resources,
		instructions: body.trim(),
	};
}

/** The ai plan's reviewer and the change loop's stages; node ids are unique across them. */
function flowFrom<T>(
	raw: Record<string, unknown>,
	where: string,
	plan: PlanMode,
	node: (value: unknown, where: string) => T,
	idOf: (n: T) => string,
	kindOf: (n: T) => NodeKind | null,
): { planReviewer: T | null; stages: { nodes: T[] }[] } {
	const seen = new Set<string>();
	const unique = (n: T) => {
		const id = idOf(n);
		if (seen.has(id)) throw new Error(`${where}: node ${id} appears twice in the loop`);
		seen.add(id);
		return n;
	};
	const named = raw.planReviewer !== undefined && raw.planReviewer !== null;
	if (named !== (plan === "ai")) throw new Error(`${where}: planReviewer names the plan's reviewer when plan is ai, and only then`);
	const planReviewer = named ? unique(node(raw.planReviewer, `${where}: planReviewer`)) : null;
	if (planReviewer !== null && kindOf(planReviewer) === "check") throw new Error(`${where}: planReviewer must be an AI reviewer, not a command check`);
	const stages = raw.stages ?? [];
	if (!Array.isArray(stages) || stages.length > 8) throw new Error(`${where}: stages must list 0–8 stages`);
	return {
		planReviewer,
		stages: stages.map((stage, i) => {
			const nodes = stage && typeof stage === "object" && "nodes" in stage ? stage.nodes : undefined;
			if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 6) throw new Error(`${where}: stages stage ${i + 1} must hold 1–6 nodes`);
			return { nodes: nodes.map((v) => unique(node(v, `${where}: stages stage ${i + 1}`))) };
		}),
	};
}

function loopHeader(raw: Record<string, unknown>, where: string): { name: string; description: string; maxPasses: number; plan: PlanMode; finish: Finish } {
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	if (name.length < 1 || name.length > 60) throw new Error(`${where}: name must be 1–60 characters`);
	const description = raw.description ?? "";
	if (typeof description !== "string") throw new Error(`${where}: description must be text`);
	const maxPasses = raw.maxPasses ?? 4;
	if (typeof maxPasses !== "number" || !Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 10) throw new Error(`${where}: maxPasses must be 1–10`);
	const plan = raw.plan ?? "none";
	if (!PLAN_MODES.includes(plan as PlanMode)) throw new Error(`${where}: plan must be none, you or ai`);
	const finish = raw.finish ?? "review";
	if (finish !== "review" && finish !== "auto") throw new Error(`${where}: finish must be review or auto`);
	return { name, description, maxPasses, plan: plan as PlanMode, finish };
}

/** A loop definition from its JSON; throws naming the path and field. */
export function loopFrom(id: string, raw: unknown, where: string): LoopDefinition {
	checkId(id, where, "loop id");
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: must be a JSON object`);
	const value = raw as Record<string, unknown>;
	const header = loopHeader(value, where);
	const flow = flowFrom(
		value,
		where,
		header.plan,
		(n, at) => {
			if (typeof n !== "string") throw new Error(`${at}: nodes must be node ids`);
			checkId(n, at, "node id");
			return n;
		},
		(n) => n,
		() => null,
	);
	return { id, ...header, ...flow };
}

/** A session-only loop as the Control page sends it, every node validated like a library file. */
export function validateSnapshot(value: unknown): LoopSnapshot {
	const where = "loop";
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: must be an object`);
	const raw = value as Record<string, unknown>;
	const id = raw.id === null || raw.id === undefined || raw.id === "" ? null : raw.id;
	if (id !== null) {
		if (typeof id !== "string") throw new Error(`${where}: id must be text`);
		checkId(id, where, "loop id");
	}
	const header = loopHeader(raw, where);
	const flow = flowFrom(
		raw,
		where,
		header.plan,
		(n, at) => {
			if (!n || typeof n !== "object") throw new Error(`${at}: each node must be an object`);
			const fields = n as Record<string, unknown>;
			if (typeof fields.id !== "string") throw new Error(`${at}: each node needs an id`);
			const body = typeof fields.instructions === "string" ? fields.instructions : "";
			return nodeFrom(fields.id, fields, body, `${at}: node ${fields.id}`);
		},
		(n) => n.id,
		(n) => n.kind,
	);
	return { id, ...header, ...flow };
}

/** A session's loop as saved; ones saved before plan modes (plan on or off, plan checks) come back with you approving the plan. */
export function savedSnapshot(loop: LoopSnapshot): LoopSnapshot {
	return validateSnapshot(withPlanMode(loop));
}

async function listDir(dir: string, ext: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((f) => f.endsWith(ext)).sort();
	} catch {
		return [];
	}
}

export async function loadLibrary(root: string | null): Promise<Library> {
	const roots = libraryRoots(root);
	const library: Library = { loops: new Map(), nodes: new Map(), errors: [], broken: new Map() };
	// Widest first: each narrower level overrides the items it shares an id with.
	const sources: [Source, string | null][] = [
		["built-in", roots.builtIn],
		["global", roots.global],
		["repo", roots.repo],
	];
	for (const [source, dir] of sources) {
		if (!dir) continue;
		for (const file of await listDir(join(dir, "nodes"), ".md")) {
			const path = join(dir, "nodes", file);
			const id = basename(file, ".md");
			try {
				const { fields, body } = parseNodeFile(await readFile(path, "utf8"), path);
				const below = library.nodes.get(id);
				library.nodes.set(id, { node: nodeFrom(id, fields, body, path), source, path, overrides: below ? [below.source, ...below.overrides] : [] });
			} catch (e) {
				library.errors.push({ path, message: errorText(e) });
			}
		}
		for (const file of await listDir(join(dir, "loops"), ".json")) {
			const path = join(dir, "loops", file);
			const id = basename(file, ".json");
			try {
				let raw: unknown;
				try {
					raw = JSON.parse(await readFile(path, "utf8"));
				} catch (e) {
					throw new Error(`${path}: invalid JSON (${errorText(e)})`);
				}
				const below = library.loops.get(id);
				library.loops.set(id, { loop: loopFrom(id, raw, path), source, path, overrides: below ? [below.source, ...below.overrides] : [] });
				library.broken.delete(id);
			} catch (e) {
				library.loops.delete(id);
				library.broken.set(id, errorText(e));
				library.errors.push({ path, message: errorText(e) });
			}
		}
	}
	return library;
}

function scopeDir(root: string | null, scope: Scope): string {
	const dir = libraryRoots(root)[scope];
	if (!dir) throw new Error(`The ${scope} library needs a git repository`);
	return dir;
}

export async function saveNode(root: string | null, scope: Scope, node: NodeDefinition): Promise<string> {
	const text = serializeNode(nodeFrom(node.id, { ...node }, node.instructions, `node ${node.id}`));
	const { fields, body } = parseNodeFile(text, `node ${node.id}`);
	nodeFrom(node.id, fields, body, `node ${node.id}`);
	const path = join(await scopeDir(root, scope), "nodes", `${node.id}.md`);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text);
	return path;
}

/** Throws unless the library holds every node the loop names and its plan reviewer is an AI reviewer. */
function checkLoop(loop: LoopDefinition, library: Library): void {
	const missing = [...(loop.planReviewer ? [loop.planReviewer] : []), ...loop.stages.flatMap((s) => s.nodes)].filter((n) => !library.nodes.has(n));
	if (missing.length) throw new Error(`Loop ${loop.id} needs missing nodes: ${missing.join(", ")}`);
	if (loop.planReviewer && library.nodes.get(loop.planReviewer)?.node.kind === "check") throw new Error(`Loop ${loop.id}: planReviewer must be an AI reviewer, not a command check`);
}

export async function saveLoop(root: string | null, scope: Scope, loop: LoopDefinition, library: Library): Promise<string> {
	const valid = loopFrom(loop.id, loop, `loop ${loop.id}`);
	checkLoop(valid, library);
	const path = join(await scopeDir(root, scope), "loops", `${loop.id}.json`);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ name: valid.name, description: valid.description, maxPasses: valid.maxPasses, plan: valid.plan, ...(valid.planReviewer ? { planReviewer: valid.planReviewer } : {}), stages: valid.stages, finish: valid.finish }, null, 2)}\n`);
	return path;
}

export async function deleteItem(root: string | null, scope: Scope, kind: "node" | "loop", id: string): Promise<void> {
	checkId(id, kind, `${kind} id`);
	const dir = libraryRoots(root)[scope];
	const path = dir && join(dir, kind === "node" ? "nodes" : "loops", `${id}${kind === "node" ? ".md" : ".json"}`);
	try {
		if (!path) throw new Error();
		await readFile(path);
	} catch {
		throw new Error(`No ${kind} ${id} in the ${scope} library; built-in ${kind}s can't be deleted`);
	}
	await rm(path);
}

/** Copies the item that wins for `id` to another level; move also deletes it where it was. Returns the new path. */
export async function copyItem(root: string | null, library: Library, kind: "node" | "loop", id: string, to: Scope, move: boolean): Promise<string> {
	const entry = kind === "node" ? library.nodes.get(id) : library.loops.get(id);
	if (!entry) throw new Error(`No ${kind} ${id} in the library`);
	if (entry.source === to) throw new Error(`${id} is already in the ${to} library`);
	if (move && entry.source === "built-in") throw new Error(`Built-in ${kind}s can't move; copy ${id} instead`);
	const path = "node" in entry ? await saveNode(root, to, entry.node) : await saveLoop(root, to, entry.loop, library);
	if (move && entry.source !== "built-in") await deleteItem(root, entry.source, kind, id);
	return path;
}

export function resolveLoop(library: Library, id: string): LoopSnapshot {
	const entry = library.loops.get(id);
	if (!entry) throw new Error(library.broken.get(id) ?? `No loop ${id} in the library`);
	checkLoop(entry.loop, library);
	const { loop } = entry;
	const node = (n: string) => library.nodes.get(n)!.node;
	return { id, name: loop.name, description: loop.description, maxPasses: loop.maxPasses, plan: loop.plan, planReviewer: loop.planReviewer ? node(loop.planReviewer) : null, stages: loop.stages.map((s) => ({ nodes: s.nodes.map(node) })), finish: loop.finish };
}

export function shape(loop: LoopSnapshot): LoopShape {
	const brief = (n: NodeDefinition) => ({ id: n.id, name: n.name, kind: n.kind });
	return {
		id: loop.id,
		name: loop.name,
		description: loop.description,
		maxPasses: loop.maxPasses,
		plan: loop.plan,
		planReviewer: loop.planReviewer ? brief(loop.planReviewer) : null,
		finish: loop.finish,
		stages: loop.stages.map((s) => ({ nodes: s.nodes.map(brief) })),
	};
}

export function summarize(library: Library, repo: string | null): LibrarySummary {
	const loops = [...library.loops.values()].flatMap(({ loop, source }) => {
		try {
			return [{ ...shape(resolveLoop(library, loop.id)), id: loop.id, source }];
		} catch {
			return [];
		}
	});
	return { repo, loops: loops.sort((a, b) => a.name.localeCompare(b.name)) };
}
