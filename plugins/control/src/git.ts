export type Baseline = { kind: "commit"; sha: string } | { kind: "merge-base"; ref: string };

export async function git(args: string[], cwd: string, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

async function must(args: string[], cwd: string): Promise<string> {
	const r = await git(args, cwd);
	if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
	return r.stdout;
}

export async function repoRoot(cwd: string): Promise<string | null> {
	const r = await git(["rev-parse", "--show-toplevel"], cwd).catch(() => null);
	return r && r.code === 0 ? r.stdout.trim() : null;
}

/** The commit a baseline names now; a merge base is recomputed each time so a rebased branch stays right. */
export async function baselineSha(root: string, baseline: Baseline, note?: (text: string) => void): Promise<string> {
	if (baseline.kind === "commit") return baseline.sha;
	const r = await git(["merge-base", "HEAD", baseline.ref], root);
	if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
	note?.(`Couldn't find ${baseline.ref}; checking changes since HEAD`);
	return (await must(["rev-parse", "HEAD"], root)).trim();
}

/** The branch work merges into: origin's default branch, else a local main or master; null in a repository with neither. */
export async function defaultBranch(root: string): Promise<string | null> {
	const remote = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
	if (remote.code === 0 && remote.stdout.trim()) return remote.stdout.trim();
	for (const name of ["main", "master"]) if ((await git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`], root)).code === 0) return name;
	return null;
}

/** Whether ref names a commit in this repository. */
export async function isCommit(root: string, ref: string): Promise<boolean> {
	return !ref.startsWith("-") && (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root)).code === 0;
}

/** How many commits HEAD has on top of sha. */
export async function commitsSince(root: string, sha: string): Promise<number> {
	const r = await git(["rev-list", "--count", `${sha}..HEAD`], root);
	return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

async function untracked(root: string): Promise<string[]> {
	return (await must(["ls-files", "--others", "--exclude-standard", "-z"], root)).split("\0").filter(Boolean);
}

/** Identifies the working tree's changes since sha: "clean" when there are none. */
export async function fingerprint(root: string, sha: string): Promise<string> {
	const [diff, files] = await Promise.all([must(["diff", sha, "--binary", "--no-color"], root), untracked(root)]);
	if (!diff && !files.length) return "clean";
	const hasher = new Bun.CryptoHasher("sha1");
	hasher.update(diff);
	hasher.update("\0");
	if (files.length) {
		const r = await git(["hash-object", "--stdin-paths"], root, `${files.join("\n")}\n`);
		const ids = r.stdout.trim().split("\n");
		files.forEach((file, i) => hasher.update(`${file}\0${ids[i] ?? ""}\0`));
	}
	return hasher.digest("hex");
}

function splitFiles(diff: string): string[] {
	return diff ? diff.split(/^(?=diff --git )/m).filter(Boolean) : [];
}

/** The change since sha as reviewers read it: stat plus diff, new files included, cut at limit characters. */
export async function reviewPacket(root: string, sha: string, limit = 80_000): Promise<{ stat: string; diff: string; truncated: boolean }> {
	const [stat, diff, files] = await Promise.all([must(["diff", sha, "--stat"], root), must(["diff", sha, "--no-color", "-U5"], root), untracked(root)]);
	const chunks = splitFiles(diff);
	for (const file of files) {
		const r = await git(["diff", "--no-index", "--no-color", "--", "/dev/null", file], root);
		if (r.code > 1) throw new Error(`git diff failed for ${file}: ${r.stderr.trim()}`);
		chunks.push(r.stdout);
	}
	let out = "";
	let truncated = false;
	for (const chunk of chunks) {
		if (out.length + chunk.length <= limit) {
			out += chunk;
			continue;
		}
		out += `${chunk.slice(0, Math.max(0, limit - out.length))}\n… (cut; read the file)\n`;
		truncated = true;
		break;
	}
	const newFiles = files.map((f) => ` ${f} (new file)`).join("\n");
	return { stat: [stat.trimEnd(), newFiles].filter(Boolean).join("\n"), diff: out, truncated };
}

export interface ChangedFile {
	path: string;
	added: number;
	removed: number;
	isNew: boolean;
}

/** Every file changed since sha, with its line counts; new untracked files count all their lines as added. */
export async function changedFiles(root: string, sha: string): Promise<ChangedFile[]> {
	const [numstat, files] = await Promise.all([must(["diff", sha, "--numstat", "--no-renames"], root), untracked(root)]);
	const out: ChangedFile[] = numstat
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [added, removed, path] = line.split("\t");
			return { path, added: Number(added) || 0, removed: Number(removed) || 0, isNew: false };
		});
	for (const path of files) {
		const text = await Bun.file(`${root}/${path}`).text().catch(() => "");
		out.push({ path, added: text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0, removed: 0, isNew: true });
	}
	return out;
}
