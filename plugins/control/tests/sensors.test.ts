import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeDefinition } from "../src/library";
import { runCheck, runReviewer } from "../src/sensors";

let dir: string;
const savedPath = process.env.PATH;

const node: NodeDefinition = {
	id: "quality",
	name: "Quality",
	kind: "review",
	description: "",
	command: null,
	timeout: 60,
	ask: "doubts",
	model: null,
	thinking: null,
	tools: ["read", "grep", "glob"],
	resources: [],
	instructions: "Find bugs.",
};

const fence = "```";
const answer = `Done.\n${fence}json\n{"findings":[{"file":"a.ts","line":1,"rule":"r","observed":"o","expected":"e","certain":true}]}\n${fence}`;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "control-sensors-"));
	const lines = [
		{ type: "session" },
		{ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
	];
	await writeFile(join(dir, "lines.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	await writeFile(
		join(dir, "omp"),
		`#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_DIR/argv"
env > "$FAKE_DIR/env"
case "$FAKE_MODE" in
  fail) echo "boom one" >&2; echo "boom two" >&2; exit 1 ;;
  hang) echo '{"type":"tool_execution_start","toolName":"grep","args":{"pattern":"x"}}'; exec sleep 30 ;;
esac
cat "$FAKE_DIR/lines.jsonl"
`,
	);
	await chmod(join(dir, "omp"), 0o755);
	process.env.PATH = `${dir}:${savedPath}`;
	process.env.FAKE_DIR = dir;
	process.env.ORCHESTRATOR_TASK = "KB-1";
});

afterAll(async () => {
	process.env.PATH = savedPath;
	delete process.env.FAKE_DIR;
	delete process.env.FAKE_MODE;
	delete process.env.ORCHESTRATOR_TASK;
	await rm(dir, { recursive: true, force: true });
});

const input = { system: "SYSTEM PROMPT", packet: "PACKET" };

test("a reviewer runs omp read-only with its prompt files, a scrubbed env, and its findings parsed", async () => {
	process.env.FAKE_MODE = "ok";
	const progress: string[] = [];
	const outcome = await runReviewer(node, dir, input, new AbortController().signal, (d) => progress.push(d));
	expect(outcome).toEqual({ kind: "findings", findings: [{ file: "a.ts", line: 1, rule: "r", observed: "o", expected: "e", alternatives: [], severity: "major", certain: true }] });
	expect(progress).toEqual(["read a.ts"]);
	const argv = (await readFile(join(dir, "argv"), "utf8")).trimEnd().split("\n");
	expect(argv.slice(0, 5)).toEqual(["-p", "--mode", "json", "--no-session", "--no-extensions"]);
	expect(argv[argv.indexOf("--tools") + 1]).toBe("read,grep,glob");
	expect(argv[argv.indexOf("--append-system-prompt") + 1]).toEndWith("/system.md");
	expect(argv.find((a) => a.startsWith("@"))).toEndWith("/packet.md");
	const env = await readFile(join(dir, "env"), "utf8");
	expect(env).toContain("OMP_CONTROL_REVIEWER=1");
	expect(env).not.toContain("ORCHESTRATOR_TASK");
});

test("a failing reviewer is an error with its stderr tail", async () => {
	process.env.FAKE_MODE = "fail";
	const outcome = await runReviewer(node, dir, input, new AbortController().signal, () => {});
	expect(outcome).toEqual({ kind: "error", message: "omp exited with 1:\nboom one\nboom two" });
});

test("aborting kills the reviewer", async () => {
	process.env.FAKE_MODE = "hang";
	const ctl = new AbortController();
	const started = Date.now();
	const outcome = await runReviewer(node, dir, input, ctl.signal, () => ctl.abort());
	expect(outcome).toEqual({ kind: "error", message: "Interrupted" });
	expect(Date.now() - started).toBeLessThan(5000);
});

test("a failing check becomes a certain blocker finding", async () => {
	const exec = async (command: string, args: string[], options?: { cwd?: string }) => {
		const proc = Bun.spawn([command, ...args], { cwd: options?.cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { stdout, stderr, code, killed: false };
	};
	const check = { ...node, kind: "check" as const, command: "echo nope >&2; exit 2", tools: [] };
	const artifacts = join(dir, "artifacts");
	const outcome = await runCheck(exec, check, dir, "abc123", artifacts, new AbortController().signal);
	expect(outcome).toEqual({
		kind: "findings",
		findings: [{ file: null, line: null, rule: "command failed (exit 2)", observed: "nope", expected: "`echo nope >&2; exit 2` exits 0 from the repository root", alternatives: [], severity: "blocker", certain: true }],
		artifacts: [],
	});
	expect(await runCheck(exec, { ...check, command: 'test "$CONTROL_BASE" = abc123' }, dir, "abc123", artifacts, new AbortController().signal)).toEqual({ kind: "passed", artifacts: [] });

	// Images the check writes are listed; other files aren't, and the folder starts empty on every run.
	const shoot = { ...check, command: 'touch "$CONTROL_ARTIFACTS/b.png" "$CONTROL_ARTIFACTS/a.JPG" "$CONTROL_ARTIFACTS/log.txt"' };
	expect(await runCheck(exec, shoot, dir, "abc123", artifacts, new AbortController().signal)).toEqual({ kind: "passed", artifacts: [join(artifacts, "a.JPG"), join(artifacts, "b.png")] });
	expect(await runCheck(exec, { ...check, command: "true" }, dir, "abc123", artifacts, new AbortController().signal)).toEqual({ kind: "passed", artifacts: [] });
});
