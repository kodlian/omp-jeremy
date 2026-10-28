import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Pin {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	hasNew: boolean;
	deletedOld: number[];
	note: string;
	side: string;
	snippet: string;
	createdAt: number;
}

export interface RepoState {
	pins: Pin[];
	viewed: Record<string, string>;
}

export const DEFAULT_STATE_DIR = join(homedir(), ".omp", "cache", "git-diff-review");

// Pins and viewed marks per repository root, kept across browser reloads and omp restarts.
export class ReviewStore {
	readonly #cache = new Map<string, RepoState>();

	constructor(readonly dir = DEFAULT_STATE_DIR) {}

	#file(root: string): string {
		return join(this.dir, `${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);
	}

	// Shared by every review server so an open tab survives omp restarts and session switches.
	token(): string {
		const file = join(this.dir, "token");
		try {
			const token = readFileSync(file, "utf8").trim();
			if (token) return token;
		} catch {}
		const token = randomBytes(16).toString("hex");
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(file, token, { mode: 0o600 });
		return token;
	}

	get(root: string): RepoState {
		let state = this.#cache.get(root);
		if (!state) {
			try {
				const raw = JSON.parse(readFileSync(this.#file(root), "utf8"));
				state = { pins: Array.isArray(raw.pins) ? raw.pins : [], viewed: raw.viewed && typeof raw.viewed === "object" ? raw.viewed : {} };
			} catch {
				state = { pins: [], viewed: {} };
			}
			this.#cache.set(root, state);
		}
		return state;
	}

	update(root: string, patch: Partial<RepoState>): RepoState {
		const state = { ...this.get(root), ...patch };
		this.#cache.set(root, state);
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(this.#file(root), JSON.stringify({ root, ...state }));
		return state;
	}
}
