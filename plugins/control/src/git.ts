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
