import type { NodeDefinition } from "./library";

export const NODE_KEYS = ["name", "kind", "description", "command", "timeout", "ask", "model", "thinking", "tools", "resources"] as const;
const BARE = /^[A-Za-z0-9][A-Za-z0-9 ._/@+-]*$/;

function scalar(raw: string, where: string): string {
	const value = raw.trim();
	if (value.startsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (typeof parsed === "string") return parsed;
		} catch {}
		throw new Error(`${where}: invalid quoted string`);
	}
	if (value.startsWith("'")) {
		const inner = value.slice(1, -1);
		if (value.length < 2 || !value.endsWith("'") || inner.replaceAll("''", "").includes("'")) throw new Error(`${where}: invalid single-quoted string`);
		return inner.replaceAll("''", "'");
	}
	return value;
}

/** Splits a node file into its header fields and its body (a reviewer's instructions). */
export function parseNodeFile(text: string, path: string): { fields: Record<string, string | number | string[]>; body: string } {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") throw new Error(`${path}: must start with a --- header`);
	const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
	if (end < 0) throw new Error(`${path}: the header has no closing ---`);
	const fields: Record<string, string | number | string[]> = {};
	let list: string[] | null = null;
	for (let i = 1; i < end; i++) {
		const line = lines[i];
		const where = `${path}:${i + 1}`;
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const item = /^\s+-\s*(.*)$/.exec(line);
		if (item) {
			if (!list) throw new Error(`${where}: a list item needs a "key:" line above it`);
			list.push(scalar(item[1], where));
			continue;
		}
		const pair = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
		if (!pair) throw new Error(`${where}: expected "key: value"`);
		const [, key, rest] = pair;
		if (!(NODE_KEYS as readonly string[]).includes(key)) throw new Error(`${path}: unknown key "${key}"`);
		if (key in fields) throw new Error(`${path}: duplicate key "${key}"`);
		if (!rest.trim()) {
			list = [];
			fields[key] = list;
			continue;
		}
		list = null;
		const value = scalar(rest, where);
		if (key === "timeout") {
			if (!/^\d+$/.test(value)) throw new Error(`${path}: timeout must be a whole number of seconds`);
			fields[key] = Number(value);
		} else fields[key] = value;
	}
	return { fields, body: lines.slice(end + 1).join("\n").trim() };
}

function quote(value: string): string {
	return BARE.test(value) && value === value.trim() ? value : JSON.stringify(value);
}

/** Writes a node as a file parseNodeFile reads back to the same definition. */
export function serializeNode(node: NodeDefinition): string {
	const out = ["---", `name: ${quote(node.name)}`, `kind: ${node.kind}`];
	if (node.description) out.push(`description: ${quote(node.description)}`);
	if (node.kind === "check" && node.command !== null) out.push(`command: ${quote(node.command)}`);
	out.push(`timeout: ${node.timeout}`, `ask: ${node.ask}`);
	if (node.model) out.push(`model: ${quote(node.model)}`);
	if (node.thinking) out.push(`thinking: ${quote(node.thinking)}`);
	if (node.kind === "review") out.push("tools:", ...node.tools.map((t) => `  - ${quote(t)}`));
	if (node.resources.length) out.push("resources:", ...node.resources.map((r) => `  - ${quote(r)}`));
	out.push("---");
	return `${out.join("\n")}\n${node.instructions ? `\n${node.instructions}\n` : ""}`;
}
