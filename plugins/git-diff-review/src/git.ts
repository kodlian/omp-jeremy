import { join, resolve, sep } from "node:path";
import { parseUnifiedDiff, splitDiff } from "./shared/diff.js";

export type Compare = { kind: "uncommitted" } | { kind: "branch"; base: string | null } | { kind: "commit"; sha: string | null };

export interface Row {
	kind: "hunk" | "context" | "addition" | "deletion";
	oldLineNumber: number | null;
	newLineNumber: number | null;
	oldText: string | null;
	newText: string | null;
	text: string;
}

export interface FileDiff {
	path: string;
	origPath: string | null;
	status: string;
	binary: boolean;
	rows: Row[];
	additions: number;
	deletions: number;
	truncated: boolean;
	note?: string;
}

export interface Review {
	files: FileDiff[];
	branch: string | null;
	base: { ref: string; sha: string } | null;
	commit: Commit | null;
	notRepo?: true;
}

export interface Commit {
	sha: string;
	short: string;
	subject: string;
	date: string;
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DIFF_ARGS = ["--no-color", "--no-ext-diff", "-U3", "-M"];
const BASE_REFS = ["origin/main", "origin/master", "main", "master"];
const CHECKOUT_RE = /^checkout: moving from (\S+) to (\S+)$/;
const REBASE_ONTO_RE = /^rebase(?: -i)?(?: \(start\))?: checkout (\S+)$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const UNTRACKED_MAX_FILES = 500;
const UNTRACKED_MAX_BYTES = 1_048_576;

export class GitError extends Error {
	constructor(
		message: string,
		readonly exitCode: number,
		readonly stderr: string,
	) {
		super(message);
	}
}

export async function git(root: string, args: string[], ok: number[] = [0]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", root, "-c", "core.quotePath=false", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
	});
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (!ok.includes(code)) throw new GitError(stderr.trim() || `git ${args[0]} failed (${code})`, code, stderr);
	return stdout;
}

export async function repoRoot(cwd: string): Promise<string> {
	return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

export async function isRepo(root: string): Promise<boolean> {
	return (await git(root, ["rev-parse", "--is-inside-work-tree"], [0, 128]).catch(() => "")).trim() === "true";
}

export async function gitDir(root: string): Promise<string> {
	return (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
}

export async function initRepo(root: string): Promise<void> {
	await git(root, ["init", "--quiet"]);
}

export async function headSha(root: string): Promise<string | null> {
	return (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1, 128])).trim() || null;
}

export async function currentBranch(root: string): Promise<string | null> {
	return (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1, 128])).trim() || null;
}

// Where the current branch forked: the rebase target, the branch it was created from, or the default branch.
export async function mergeBase(root: string): Promise<{ ref: string; sha: string } | null> {
	if (!(await headSha(root))) return null;
	const subjects = (await git(root, ["reflog", "show", "HEAD", "--format=%gs"], [0, 128])).split("\n").filter(Boolean);
	const candidates: string[] = [];
	const add = (ref: string | null | undefined) => {
		if (ref && !candidates.includes(ref)) candidates.push(ref);
	};
	for (const line of subjects) {
		const m = REBASE_ONTO_RE.exec(line);
		if (m) {
			if (!SHA_RE.test(m[1])) add(m[1]);
			break;
		}
	}
	const current = await currentBranch(root);
	if (current) {
		let parent: string | null = null;
		for (const line of subjects) {
			const m = CHECKOUT_RE.exec(line);
			if (m && m[2] === current && m[1] !== current) parent = m[1];
		}
		add(parent);
	}
	for (const ref of BASE_REFS) if (ref !== current) add(ref);

	let best: { ref: string; sha: string } | null = null;
	for (const ref of candidates) {
		const sha = (await git(root, ["merge-base", ref, "HEAD"], [0, 1, 128])).trim();
		if (!sha) continue;
		const newer = best && sha !== best.sha && (await git(root, ["merge-base", "--is-ancestor", best.sha, sha]).then(() => true, () => false));
		if (!best || newer) best = { ref, sha };
	}
	return best;
}

async function readUntracked(root: string, path: string): Promise<FileDiff> {
	const file: FileDiff = { path, origPath: null, status: "?", binary: false, rows: [], additions: 0, deletions: 0, truncated: false };
	const blob = Bun.file(join(root, path));
	if (blob.size > UNTRACKED_MAX_BYTES) return { ...file, note: `File too large to show (${Math.round(blob.size / 1024)} KB)` };
	const bytes = new Uint8Array(await blob.arrayBuffer().catch(() => new ArrayBuffer(0)));
	if (bytes.subarray(0, 8000).includes(0)) return { ...file, binary: true };
	const lines = new TextDecoder().decode(bytes).split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (!lines.length) return file;
	const parsed = parseUnifiedDiff([`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n"));
	return { ...file, ...parsed };
}

async function untrackedFiles(root: string): Promise<FileDiff[]> {
	const paths = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
	return Promise.all(
		paths.map((path, i) =>
			i < UNTRACKED_MAX_FILES
				? readUntracked(root, path)
				: { path, origPath: null, status: "?", binary: false, rows: [], additions: 0, deletions: 0, truncated: false, note: "Too many untracked files to show" },
		),
	);
}

const byPath = (a: FileDiff, b: FileDiff) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

async function withUntracked(root: string, tracked: FileDiff[]): Promise<FileDiff[]> {
	const seen = new Set(tracked.map((f) => f.path));
	const untracked = (await untrackedFiles(root)).filter((f) => !seen.has(f.path));
	return [...tracked, ...untracked].sort(byPath);
}

export function resolveInRoot(root: string, path: string): string {
	const abs = resolve(root, path);
	if (!abs.startsWith(root + sep)) throw new Error(`Path outside the repository: ${path}`);
	return abs;
}

// The new side of a file, for revealing context lines around hunks.
export async function fileLines(root: string, compare: Compare, path: string): Promise<string[]> {
	const text =
		compare.kind === "commit"
			? await git(root, ["show", `${compare.sha ?? (await headSha(root)) ?? "HEAD"}:${path}`])
			: await Bun.file(resolveInRoot(root, path)).text();
	const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

export async function loadReview(root: string, compare: Compare, { ignoreWhitespace = false } = {}): Promise<Review> {
	const ws = ignoreWhitespace ? ["-w"] : [];
	const branch = await currentBranch(root);
	if (compare.kind === "commit") {
		const sha = compare.sha ?? (await headSha(root));
		if (!sha) return { files: [], branch, base: null, commit: null };
		const raw = await git(root, ["show", "--format=", "--diff-merges=first-parent", ...DIFF_ARGS, ...ws, sha, "--"]);
		const [commit] = await listCommits(root, 1, sha);
		return { files: (splitDiff(raw) as FileDiff[]).sort(byPath), branch, base: null, commit: commit ?? null };
	}
	if (compare.kind === "branch") {
		const head = await headSha(root);
		const fork = compare.base ? { ref: compare.base, sha: (await git(root, ["merge-base", compare.base, "HEAD"])).trim() } : await mergeBase(root);
		const base = fork ?? (head ? { ref: "HEAD", sha: head } : null);
		const tracked = splitDiff(await git(root, ["diff", ...DIFF_ARGS, ...ws, base?.sha ?? EMPTY_TREE, "--"])) as FileDiff[];
		return { files: await withUntracked(root, tracked), branch, base, commit: null };
	}
	const target = (await headSha(root)) ?? EMPTY_TREE;
	const tracked = splitDiff(await git(root, ["diff", ...DIFF_ARGS, ...ws, target, "--"])) as FileDiff[];
	return { files: await withUntracked(root, tracked), branch, base: null, commit: null };
}

export async function listBranches(root: string): Promise<string[]> {
	const out = await git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(refname:short)", "refs/heads", "refs/remotes"]);
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\0"))
		.filter(([ref]) => !ref.endsWith("/HEAD"))
		.map(([, short]) => short);
}

export async function listCommits(root: string, max = 100, rev = "HEAD"): Promise<Commit[]> {
	const out = await git(root, ["log", "-n", String(max), "--format=%H%x1f%h%x1f%s%x1f%cI%x1e", rev, "--"], [0, 128]);
	return out
		.split("\x1e")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((entry) => {
			const [sha, short, subject, date] = entry.split("\x1f");
			return { sha, short, subject, date };
		});
}
