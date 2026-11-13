import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "omp-integrations/text";
import type { NodeDefinition } from "./library";
import { checkFinding, finalText, parseFindings, type RawFinding, timeoutFinding } from "./prompts";

export type NodeOutcome = ({ kind: "passed" } | { kind: "findings"; findings: RawFinding[] } | { kind: "error"; message: string }) & { artifacts?: string[] };

const PROGRESS_MS = 500;
const ARTIFACT_LIMIT = 24;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const REVIEW_PROMPT = "Review the change in the attached packet. Follow your reviewer instructions and end with the findings JSON block.";

/** Runs a command check from the repository root; `base` (the commit the change is measured from) is in $CONTROL_BASE, and images it writes to $CONTROL_ARTIFACTS (emptied first) are shown with your review. */
export async function runCheck(exec: ExtensionAPI["exec"], node: NodeDefinition, root: string, base: string, artifacts: string, signal: AbortSignal): Promise<NodeOutcome> {
	await rm(artifacts, { recursive: true, force: true });
	await mkdir(artifacts, { recursive: true });
	const script = `CONTROL_BASE='${base.replace(/[^0-9a-f]/gi, "")}'; CONTROL_ARTIFACTS='${artifacts.replaceAll("'", "'\\''")}'; export CONTROL_BASE CONTROL_ARTIFACTS\n${node.command ?? ""}`;
	const r = await exec("/bin/sh", ["-c", script], { cwd: root, timeout: node.timeout * 1000, signal });
	if (signal.aborted) return { kind: "error", message: "Interrupted" };
	const images = (await readdir(artifacts).catch(() => []))
		.filter((name) => IMAGE.test(name))
		.sort()
		.slice(0, ARTIFACT_LIMIT)
		.map((name) => join(artifacts, name));
	if (r.code === 0 && !r.killed) return { kind: "passed", artifacts: images };
	const output = [r.stdout, r.stderr].filter((s) => s.trim()).join("\n");
	return { kind: "findings", findings: [r.killed ? timeoutFinding(node, output) : checkFinding(node, r.code, output)], artifacts: images };
}

function reviewerEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("ORCHESTRATOR_") && !key.startsWith("OMP_CONTROL_")) env[key] = value;
	}
	return { ...env, OMP_CONTROL_REVIEWER: "1", OMP_MCP_TIMEOUT_MS: "1000" };
}

function progressText(event: unknown): string | null {
	if (!event || typeof event !== "object" || !("type" in event) || event.type !== "tool_execution_start" || !("toolName" in event)) return null;
	const args = new Map(Object.entries("args" in event && event.args && typeof event.args === "object" ? event.args : {}));
	const target = ["path", "pattern", "query"].map((k) => args.get(k)).find((v) => typeof v === "string");
	return `${String(event.toolName)}${target ? ` ${target}` : ""}`;
}

export async function runReviewer(
	node: NodeDefinition,
	root: string,
	input: { system: string; packet: string },
	signal: AbortSignal,
	progress: (detail: string) => void,
): Promise<NodeOutcome> {
	const omp = Bun.which("omp", { PATH: process.env.PATH ?? "" });
	if (!omp) return { kind: "error", message: "omp isn't on PATH" };
	const dir = await mkdtemp(join(tmpdir(), "omp-control-"));
	try {
		const systemPath = join(dir, "system.md");
		const packetPath = join(dir, "packet.md");
		await Promise.all([writeFile(systemPath, input.system), writeFile(packetPath, input.packet)]);
		if (signal.aborted) return { kind: "error", message: "Interrupted" };
		const args = [
			omp,
			"-p",
			"--mode",
			"json",
			"--no-session",
			"--no-extensions",
			"--no-lsp",
			"--no-title",
			"--tools",
			node.tools.join(","),
			"--max-time",
			String(node.timeout),
			"--append-system-prompt",
			systemPath,
			...(node.model ? ["--model", node.model] : []),
			...(node.thinking ? ["--thinking", node.thinking] : []),
			`@${packetPath}`,
			REVIEW_PROMPT,
		];
		const proc = Bun.spawn(args, { cwd: root, env: reviewerEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		let timedOut = false;
		const kill = () => proc.kill();
		signal.addEventListener("abort", kill, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, (node.timeout + 30) * 1000);
		const stderr = new Response(proc.stderr).text();
		const lines: string[] = [];
		let lastProgress = 0;
		let buffered = "";
		const decoder = new TextDecoder();
		const onLine = (line: string) => {
			if (!line.trim()) return;
			lines.push(line);
			if (Date.now() - lastProgress < PROGRESS_MS) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			const text = progressText(event);
			if (text) {
				lastProgress = Date.now();
				progress(text);
			}
		};
		try {
			for await (const chunk of proc.stdout) {
				buffered += decoder.decode(chunk, { stream: true });
				const parts = buffered.split("\n");
				buffered = parts.pop() ?? "";
				for (const part of parts) onLine(part);
			}
			onLine(buffered);
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", kill);
		}
		const code = await proc.exited;
		if (signal.aborted) return { kind: "error", message: "Interrupted" };
		if (timedOut) return { kind: "error", message: `timed out after ${node.timeout + 30}s` };
		if (code === 3) return { kind: "error", message: "cost cap reached" };
		if (code !== 0) {
			const tail = (await stderr).trimEnd().split("\n").slice(-20).join("\n");
			return { kind: "error", message: `omp exited with ${code}${tail ? `:\n${tail}` : ""}` };
		}
		try {
			const findings = parseFindings(finalText(lines));
			return findings.length ? { kind: "findings", findings } : { kind: "passed" };
		} catch (e) {
			return { kind: "error", message: errorText(e) };
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
