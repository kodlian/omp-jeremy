import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, loadReview, mergeBase } from "../src/git";

const repos: string[] = [];

async function repo(): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "gdr-git-"));
	repos.push(root);
	await git(root, ["init", "-q", "-b", "main"]);
	await git(root, ["config", "user.email", "t@t"]);
	await git(root, ["config", "user.name", "t"]);
	return root;
}

async function commit(root: string, files: Record<string, string>, message = "c") {
	for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
	await git(root, ["add", "-A"]);
	await git(root, ["commit", "-q", "-m", message]);
}

const summary = (files: { path: string; status: string; additions: number; deletions: number }[]) =>
	files.map(({ path, status, additions, deletions }) => `${status} ${path} +${additions} -${deletions}`);

afterEach(() => {
	for (const root of repos.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("uncommitted", () => {
	test("combines staged, unstaged, renames, deletions and untracked files", async () => {
		const root = await repo();
		await commit(root, { "a.txt": "one\ntwo\n", "gone.txt": "x\n", "old.txt": "keep\nthis\nfile\nas is\n" });
		writeFileSync(join(root, "a.txt"), "one\nTWO\n");
		await git(root, ["rm", "-q", "gone.txt"]);
		await git(root, ["mv", "old.txt", "new.txt"]);
		writeFileSync(join(root, "staged.txt"), "s\n");
		await git(root, ["add", "staged.txt"]);
		writeFileSync(join(root, "untracked.txt"), "u1\nu2\n");

		const review = await loadReview(root, { kind: "uncommitted" });
		expect(summary(review.files)).toEqual(["M a.txt +1 -1", "D gone.txt +0 -1", "R new.txt +0 -0", "A staged.txt +1 -0", "? untracked.txt +2 -0"]);
		expect(review.files.find((f) => f.path === "new.txt")?.origPath).toBe("old.txt");
		expect(review.files.find((f) => f.path === "untracked.txt")?.rows.map((r) => r.newText)).toEqual([null, "u1", "u2"]);
		expect(review.branch).toBe("main");
	});

	test("works before the first commit", async () => {
		const root = await repo();
		writeFileSync(join(root, "staged.txt"), "s\n");
		await git(root, ["add", "staged.txt"]);
		writeFileSync(join(root, "loose.txt"), "l\n");
		expect(summary((await loadReview(root, { kind: "uncommitted" })).files)).toEqual(["? loose.txt +1 -0", "A staged.txt +1 -0"]);
	});

	test("flags binary untracked files instead of rendering them", async () => {
		const root = await repo();
		await commit(root, { "a.txt": "a\n" });
		writeFileSync(join(root, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
		const [file] = (await loadReview(root, { kind: "uncommitted" })).files;
		expect(file).toMatchObject({ path: "blob.bin", status: "?", binary: true, rows: [] });
	});

	test("ignoreWhitespace hides whitespace-only edits", async () => {
		const root = await repo();
		await commit(root, { "a.txt": "x = 1\n" });
		writeFileSync(join(root, "a.txt"), "x  =  1\n");
		expect((await loadReview(root, { kind: "uncommitted" })).files).toHaveLength(1);
		expect((await loadReview(root, { kind: "uncommitted" }, { ignoreWhitespace: true })).files[0]?.rows ?? []).toEqual([]);
	});
});

describe("branch", () => {
	test("auto base is the branch this one was created from", async () => {
		const root = await repo();
		await commit(root, { "base.txt": "b\n" });
		await git(root, ["checkout", "-q", "-b", "develop"]);
		await commit(root, { "develop.txt": "d\n" });
		await git(root, ["checkout", "-q", "-b", "feature"]);
		await commit(root, { "feature.txt": "f\n" });
		writeFileSync(join(root, "wip.txt"), "w\n");

		const review = await loadReview(root, { kind: "branch", base: null });
		expect(review.base?.ref).toBe("develop");
		expect(summary(review.files)).toEqual(["A feature.txt +1 -0", "? wip.txt +1 -0"]);
		expect((await mergeBase(root))?.sha).toBe((await git(root, ["rev-parse", "develop"])).trim());
	});

	test("explicit base overrides detection", async () => {
		const root = await repo();
		await commit(root, { "base.txt": "b\n" });
		await git(root, ["checkout", "-q", "-b", "develop"]);
		await commit(root, { "develop.txt": "d\n" });
		await git(root, ["checkout", "-q", "-b", "feature"]);
		await commit(root, { "feature.txt": "f\n" });

		const review = await loadReview(root, { kind: "branch", base: "main" });
		expect(review.base?.ref).toBe("main");
		expect(review.files.map((f) => f.path)).toEqual(["develop.txt", "feature.txt"]);
	});
});

describe("commit", () => {
	test("defaults to HEAD and reports the commit", async () => {
		const root = await repo();
		await commit(root, { "a.txt": "1\n" }, "first");
		await commit(root, { "a.txt": "2\n", "b.txt": "b\n" }, "second");
		writeFileSync(join(root, "dirty.txt"), "ignored\n");

		const review = await loadReview(root, { kind: "commit", sha: null });
		expect(review.commit?.subject).toBe("second");
		expect(summary(review.files)).toEqual(["M a.txt +1 -1", "A b.txt +1 -0"]);
	});

	test("is empty in a repository without commits", async () => {
		const root = await repo();
		expect(await loadReview(root, { kind: "commit", sha: null })).toMatchObject({ files: [], commit: null });
	});
});
