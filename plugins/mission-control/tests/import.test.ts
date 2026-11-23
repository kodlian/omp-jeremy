import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const EXTRA_PATH = `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`;
// Beads is needed only to read the Orchestrator's cards; Homebrew installs it there.
const BD = Bun.which("bd", { PATH: EXTRA_PATH });
const CALLER = /^(BEADS_|BD_|GIT_|MISSION_CONTROL_|ORCHESTRATOR_)/;

const dir = realpathSync(mkdtempSync("/tmp/mission-control-import-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!BD)("an Orchestrator board's open cards with a worktree are imported once, the others listed", () => {
	const home = join(dir, "home");
	const old = join(home, ".orchestrator");
	const beads = join(old, "beads");
	const board = join(dir, "board");
	const repo = join(dir, "repo");
	const started = join(dir, "started");
	for (const path of [home, beads, repo, join(old, "tasks", "KB-2")]) mkdirSync(path, { recursive: true });
	writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Import\n\temail = import@example.com\n");
	const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const unused = String(probe.port);
	probe.stop(true);
	const env: Record<string, string> = {
		...(Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !CALLER.test(k))) as Record<string, string>),
		HOME: home, PATH: EXTRA_PATH, PYTHONDONTWRITEBYTECODE: "1", MISSION_CONTROL_HOME: board, ORCHESTRATOR_PORT: unused,
	};
	const run = (cmd: string[], cwd: string, extra: Record<string, string> = {}) => {
		const p = Bun.spawnSync(cmd, { cwd, env: { ...env, ...extra } });
		if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
		return p.stdout.toString();
	};
	run(["git", "init", "-q", "-b", "main"], repo);
	run(["git", "commit", "-q", "--allow-empty", "-m", "init"], repo);
	run(["git", "worktree", "add", "-q", "-b", "feature/started", started], repo);

	// The Orchestrator's Beads workspace, as its prepare made it.
	const bdEnv = { BEADS_DIR: join(beads, ".beads"), BD_NON_INTERACTIVE: "1", NO_COLOR: "1" };
	const bd = (...args: string[]) => run([BD!, "--json", ...args], beads, bdEnv);
	run(["git", "init", "-q"], beads);
	run([BD!, "init", "--non-interactive", "--prefix", "KB", "--skip-agents", "--skip-hooks", "--role", "maintainer", "--quiet"], beads, bdEnv);
	run([BD!, "config", "set", "issue_id_mode", "counter"], beads, bdEnv);
	bd("create", "--title", "Landed", "--type", "task", "--priority", "2", "--status", "open");
	bd("create", "--title", "Started", "--description", "Work in its worktree", "--type", "task", "--priority", "2",
		"--status", "in_progress", "--metadata", JSON.stringify({ orchestrator: { repo, base: "main", branch: "feature/started", controlSet: null, number: 2 } }));
	bd("create", "--title", "Never started", "--description", "An idea for later", "--type", "task", "--priority", "2", "--status", "open");
	bd("update", "KB-1", "--status", "closed", "--force");
	writeFileSync(join(old, "tasks", "KB-2", "execution.json"), JSON.stringify({ worktree: started, order: 1000, spawn: { state: "done", error: null, log: "" }, execution: null }));
	writeFileSync(join(old, "tasks", "KB-2", "brief.md"), "# Task 2: Started\n");
	writeFileSync(join(old, "config.json"), JSON.stringify({ commands: { createWorktree: "wt --branch \"$ORCHESTRATOR_BRANCH\"" } }));
	writeFileSync(join(old, "board.json"), JSON.stringify({ flows: [{ repo, base: "main", checkout: repo, concurrencyLimit: 2, controlSets: null }] }));

	run(["python3", "server.py", "--prepare"], ROOT);

	const imported = JSON.parse(readFileSync(join(board, "tasks", "KB-2", "task.json"), "utf8"));
	expect(imported).toMatchObject({ id: "KB-2", title: "Started", column: "doing", worktree: started, branch: "feature/started", number: "2", tags: [] });
	expect(existsSync(join(board, "tasks", "KB-2", "brief.md"))).toBe(true);
	expect(existsSync(join(board, "tasks", "KB-2", "execution.json"))).toBe(false);
	expect(existsSync(join(board, "tasks", "KB-1"))).toBe(false);
	expect(existsSync(join(board, "tasks", "KB-3"))).toBe(false);
	expect(readFileSync(join(board, "not-imported.md"), "utf8")).toContain("#3 Never started");
	expect(JSON.parse(readFileSync(join(board, "board.json"), "utf8"))).toEqual({ nextId: 4, projects: [{ repo, controlSets: null }] });
	const config = readFileSync(join(board, "config.json"), "utf8");
	expect(config).toContain("MISSION_CONTROL_BRANCH");
	expect(config).not.toContain("ORCHESTRATOR_");
}, 60_000);
