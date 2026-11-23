import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ControlApproval, ControlSetSummary } from "omp-integrations/control";
import { errorText } from "omp-integrations/text";
import { parseControlFile } from "./frontmatter";

/** Where a library item lives: repo (.omp/control, committed), global (every repo), built-in; repo overrides global overrides built-in. */
export type Source = "built-in" | "global" | "repo";

export interface ControlDefinition {
	id: string;
	name: string;
	kind: "check" | "review";
	description: string;
	command: string | null;
	/** Seconds a check's command may run; null for a reviewer. */
	timeout: number | null;
	path: string;
	source: Source;
}

export interface SetDefinition {
	id: string;
	name: string;
	description: string;
	controls: string[];
	approval: ControlApproval;
	path: string;
	source: Source;
}

export interface Library {
	controls: Map<string, ControlDefinition>;
	sets: Map<string, SetDefinition>;
	errors: { path: string; message: string }[];
}

export const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BUILT_IN = join(dirname(realpathSync(import.meta.path)), "..", "library");

export function libraryRoots(root: string | null): { repo: string | null; global: string; builtIn: string } {
	return {
		repo: root ? join(root, ".omp", "control") : null,
		global: process.env.OMP_CONTROL_HOME || join(homedir(), ".omp", "control"),
		builtIn: BUILT_IN,
	};
}

function optionalText(fields: Record<string, unknown>, key: string, path: string): string | null {
	const value = fields[key];
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string") throw new Error(`${path}: ${key} must be text`);
	return value;
}

function checkId(id: string, path: string, what: string) {
	if (!ID.test(id)) throw new Error(`${path}: ${what} "${id}" must be lowercase letters, digits and dashes (at most 63)`);
}

function checkName(name: unknown, path: string): string {
	const text = typeof name === "string" ? name.trim() : "";
	if (text.length < 1 || text.length > 60) throw new Error(`${path}: name must be 1–60 characters`);
	return text;
}

/** A control from its header fields and body; keys it doesn't read are ignored. Throws naming the path and field. */
export function controlFrom(id: string, fields: Record<string, unknown>, body: string, path: string, source: Source): ControlDefinition {
	checkId(id, path, "control id");
	const name = checkName(fields.name, path);
	const kind = fields.kind;
	if (kind !== "check" && kind !== "review") throw new Error(`${path}: kind must be check or review`);
	const description = optionalText(fields, "description", path) ?? "";
	if (kind === "review") {
		if (!body.trim()) throw new Error(`${path}: a reviewer needs instructions (the text after the header)`);
		return { id, name, kind, description, command: null, timeout: null, path, source };
	}
	const command = optionalText(fields, "command", path)?.trim();
	if (!command) throw new Error(`${path}: a check needs a command`);
	const timeout = fields.timeout ?? 900;
	if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 7200) throw new Error(`${path}: timeout must be 1–7200 seconds`);
	return { id, name, kind, description, command, timeout, path, source };
}

/** A set from its JSON; throws naming the path and field. */
export function setFrom(id: string, raw: unknown, path: string, source: Source): SetDefinition {
	checkId(id, path, "set id");
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: must be a JSON object`);
	const value = raw as Record<string, unknown>; // checked to be a plain object just above
	const name = checkName(value.name, path);
	const description = value.description ?? "";
	if (typeof description !== "string") throw new Error(`${path}: description must be text`);
	const controls = value.controls;
	if (!Array.isArray(controls) || controls.length < 1 || controls.length > 12 || controls.some((c) => typeof c !== "string" || !ID.test(c))) {
		throw new Error(`${path}: controls must list 1–12 control ids`);
	}
	const twice = controls.find((c, i) => controls.indexOf(c) !== i);
	if (twice !== undefined) throw new Error(`${path}: control ${twice} appears twice`);
	const approval = value.approval ?? "apply";
	if (approval !== "apply" && approval !== "ask") throw new Error(`${path}: approval must be apply or ask`);
	return { id, name, description, controls, approval, path, source };
}

async function listDir(dir: string, ext: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((f) => f.endsWith(ext)).sort();
	} catch {
		return [];
	}
}

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (e) {
		throw new Error(`${path}: invalid JSON (${errorText(e)})`);
	}
}

export async function loadLibrary(root: string | null): Promise<Library> {
	const roots = libraryRoots(root);
	const library: Library = { controls: new Map(), sets: new Map(), errors: [] };
	// Widest first: each narrower level overrides the items it shares an id with.
	const levels: [Source, string | null][] = [
		["built-in", roots.builtIn],
		["global", roots.global],
		["repo", roots.repo],
	];
	for (const [source, dir] of levels) {
		if (!dir) continue;
		for (const file of await listDir(join(dir, "nodes"), ".md")) {
			const path = join(dir, "nodes", file);
			const id = basename(file, ".md");
			try {
				const { fields, body } = parseControlFile(await readFile(path, "utf8"), path);
				library.controls.set(id, controlFrom(id, fields, body, path, source));
			} catch (e) {
				library.errors.push({ path, message: errorText(e) });
			}
		}
		for (const file of await listDir(join(dir, "sets"), ".json")) {
			const path = join(dir, "sets", file);
			const id = basename(file, ".json");
			try {
				library.sets.set(id, setFrom(id, await readJson(path), path, source));
			} catch (e) {
				library.errors.push({ path, message: errorText(e) });
			}
		}
	}
	for (const set of library.sets.values()) {
		const missing = set.controls.filter((id) => !library.controls.has(id));
		if (!missing.length) continue;
		library.sets.delete(set.id);
		library.errors.push({ path: set.path, message: `${set.path}: set ${set.id} names missing controls: ${missing.join(", ")}` });
	}
	return library;
}

/** The sets as other plugins show them: sorted by name, each with its controls' names. */
export function summarize(library: Library): ControlSetSummary[] {
	return [...library.sets.values()]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((s) => ({ id: s.id, name: s.name, description: s.description, controls: s.controls.map((id) => library.controls.get(id)?.name ?? id), approval: s.approval }));
}
