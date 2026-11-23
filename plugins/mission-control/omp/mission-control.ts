// Mission Control for omp: /mission, /task, /next, /link, /tag and /land, mission_control_* tools, task sessions' agent reports and widget, and a board that starts itself.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as omp from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth, type AutocompleteItem } from "@oh-my-pi/pi-tui";
import { detectTerminalContext, openBoard as openTerminalBoard, type TerminalContext, type TerminalKind } from "omp-integrations/terminal";
import { PLAN_APPROVALS } from "omp-integrations/plan";
import { errorText, toolReply } from "omp-integrations/text";
import { busAsk } from "omp-integrations/bus";
import { currentTheme, hasThemeApi, isLightColor, resolveTheme, type Scheme } from "omp-integrations/theme";
import { CONTROL_ASK_EVENT, CONTROL_SETS_EVENT, type ControlReply, type ControlSetSummary } from "omp-integrations/control";

const BASE = `http://127.0.0.1:${process.env.MISSION_CONTROL_PORT || "4747"}`;
const HOME = process.env.MISSION_CONTROL_HOME || join(homedir(), ".mission-control");
const PYTHON = process.env.MISSION_CONTROL_PYTHON || "python3";
const SERVER = join(dirname(realpathSync(import.meta.path)), "..", "server.py");
const SERVER_ROOT = dirname(SERVER);
const START_TIMEOUT_MS = 30_000;
const RECONNECT_MS = 3000;
const STREAM_IDLE_MS = 10_000;
const STEP_MS = 2000;
const CLEANUP_ENTRY = "mission-control.cleanup";
const ENGAGED_ENTRY = "mission-control.engaged";
const MERGE_REMOVE = "Merge and remove the worktree";
const MERGE_KEEP = "Merge and keep the worktree";
const DELETE_REMOVE = "Delete and remove the worktree";
const DELETE_KEEP = "Delete and keep the worktree";
const CANCEL = "Cancel";

const DIFF_TOOL_LIMIT = 60_000;
const SHARING =
	"Record a concise finding other tasks need (a decision, contract, gotcha, where something lives) with mission_control_publish as you learn it, and your outcome (what changed, where, how dependents use it) once the work is committed, before finishing. Read what a dependency recorded, newer than your brief, with mission_control_context.";

/** A board command for a task session's agent; the session answers it at /api/control/<id>. */
interface Control {
	id: string;
	task: string;
	action: string;
	text?: string;
}

/** A question for the Control plugin over the shared bus; Control answers each through its reply callback. */
type ControlRequest = { type: "sets" } | { type: "status" };
const CONTROL_ASK_MS = 2000;

function isControl(data: unknown): data is Control {
	return (
		typeof data === "object" &&
		data !== null &&
		"id" in data &&
		typeof data.id === "string" &&
		"task" in data &&
		typeof data.task === "string" &&
		"action" in data &&
		typeof data.action === "string"
	);
}

interface GitStats {
	commits: number;
	added: number;
	removed: number;
	files: number;
	dirty: number;
}

interface PullRequest {
	number: number;
	state: "open" | "draft" | "merged" | "closed";
	url: string;
	title: string;
	base: string;
	review: "approved" | "changes_requested" | "review_required" | null;
	checks: "passing" | "failing" | "pending" | null;
	conflicts: boolean;
}

interface Task {
	id: string;
	/** Counted per project: "12", or "74.1" for an imported child. */
	number: string;
	title: string;
	description: string;
	column: string;
	branch: string;
	base: string;
	repo: string;
	project: string;
	tags: string[];
	dependsOn: string[];
	parent: string | null;
	children: string[];
	blockedBy: string[];
	waitingForSlot: boolean;
	paused: boolean;
	held: boolean;
	planned: string | null;
	presentation: Presentation | null;
	attachCommand: string | null;
	session: { id: string | null; file: string | null; connected: boolean } | null;
	moveRequiresConfirmation: boolean;
	ticket: string | null;
	worktree: string | null;
	health?: { worktreeMissing: boolean };
	origin: { session: string; terminal?: TerminalContext | null } | null;
	spawn: { state: string; error: string | null };
	intent: { op: "start" | "resume" | "stop" | "merge" | "remove" | "delete"; stage: string | null; at: string; attempt: number; lastError: string | null } | null;
	agent: { state: string; step?: string | null } | null;
	git: GitStats | null;
	pr: PullRequest | null;
	land: { mergeInto: string | null; pr: boolean };
	merged: { into: string; sha: string } | null;
	controlSet: string | null;
}

/** A task's shared context, as GET/POST /api/tasks/<id>/context returns it. */
interface TaskContext {
	id: string;
	revision: string;
	updatedAt: string | null;
	entries: { kind: "finding" | "outcome" | "note"; at: string | null; source: string | null; ref: string | null; text: string }[];
}

interface Project {
	id: string;
	name: string;
	repo: string;
	defaultBranch: string;
	concurrencyLimit: number | null;
	controlSets: ControlSetSummary[] | null;
	tags: string[];
	/** Branches whose card or worktree the page leaves out. */
	hidden: string[];
}

/** A linked worktree of a project that no card owns. */
interface Worktree {
	path: string;
	project: string;
	branch: string;
	base: string;
	git: GitStats | null;
	pr: PullRequest | null;
	column: string;
	tags: string[];
}

interface Board {
	version: number;
	columns: { id: string; title: string }[];
	projects: Project[];
	tasks: Task[];
	worktrees: Worktree[];
}

interface Health {
	pid: number;
	codeMtime: number;
}

interface ServerEvent {
	event: string;
	data: string;
}

/** Where a task's agent terminal is presented; alive says nothing about the agent. */
interface Presentation {
	kind: TerminalKind;
	alive: boolean;
	capabilities: { focus: boolean; close: boolean; diff: boolean; board: boolean };
}

class BoardError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

/** Card numbers by id, as the latest board read gave them. */
const cardNumbers = new Map<string, string>();
// A card id in prose; one inside a path or name (tasks/MC-1, mc-MC-1) stays as it is.
const CARD_ID = /(?<![\w/-])(?:MC|KB)-\d+(?:\.\d+)*\b/g;
/** The latest board read, for argument completions. */
let lastBoard: Board | null = null;

function rememberNumbers(board: Board): void {
	lastBoard = board;
	for (const t of board.tasks) cardNumbers.set(t.id, t.number);
}

/** A card as people know it: #12. */
const taskNumber = (id: string) => {
	const n = cardNumbers.get(id);
	return n ? `#${n}` : id;
};

/** `text` with the board's card ids replaced by their numbers. */
const withNumbers = (text: string) => text.replace(CARD_ID, taskNumber);

// --- board server -------------------------------------------------------------------------------------------------

// The checkout the board starts from: the latest session cwd.
let serverCwd = process.cwd();
let starting: Promise<void> | undefined;

async function health(): Promise<Health | null> {
	try {
		const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
		return res.ok ? ((await res.json()) as Health) : null;
	} catch {
		return null;
	}
}

/** Runs server.py --prepare (the home and any one-time import) to completion; rejects with its diagnostic. */
async function prepare(env: Record<string, string | undefined>): Promise<void> {
	const child = spawn(PYTHON, [SERVER, "--prepare"], { cwd: serverCwd, env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
		stderr += chunk;
	});
	const exited = Promise.withResolvers<number | null>();
	child.on("error", exited.reject);
	child.on("close", exited.resolve);
	const code = await exited.promise.catch((e: unknown) => {
		throw new Error(`Mission Control didn't start: ${errorText(e)}`);
	});
	mkdirSync(HOME, { recursive: true });
	if (output) appendFileSync(join(HOME, "server.log"), output);
	if (code !== 0) {
		const reason = stderr.trim().split("\n").pop() || `server.py --prepare exited with ${code}`;
		throw new Error(`Mission Control can't start: ${reason}`);
	}
}

/** Prepares the board's home, then starts server.py detached and waits for it to answer. */
async function launch(): Promise<void> {
	const env = { ...process.env };
	delete env.MISSION_CONTROL_TASK;
	await prepare(env);
	const log = openSync(join(HOME, "server.log"), "a");
	const spawned: { error?: Error } = {};
	try {
		const child = spawn(PYTHON, [SERVER], { cwd: serverCwd, env, detached: true, stdio: ["ignore", log, log] });
		child.on("error", (e) => {
			spawned.error = e;
		});
		child.unref();
		if (child.pid) writeFileSync(join(HOME, "server.pid"), `${child.pid}\n`);
	} finally {
		closeSync(log);
	}
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (spawned.error) throw new Error(`Mission Control didn't start: ${spawned.error.message}`);
		if (await health()) return;
		await Bun.sleep(100);
	}
	throw new Error(`Mission Control didn't start; see ${tilde(HOME)}/server.log`);
}

/** Runs one board (re)start at a time; concurrent callers share it. */
function exclusive(job: () => Promise<void>): Promise<void> {
	starting ??= job().finally(() => {
		starting = undefined;
	});
	return starting;
}

/** Restarts the running board when this plugin's server code is newer than the code it runs. */
async function refreshBoard(): Promise<void> {
	const running = await health();
	if (!running) return;
	const mtimes = readdirSync(SERVER_ROOT)
		.filter((name) => name.endsWith(".py"))
		.map((name) => statSync(join(SERVER_ROOT, name)).mtimeMs / 1000);
	if (!mtimes.length) return;
	const mtime = Math.max(...mtimes);
	if (Math.floor(mtime) <= Math.floor(running.codeMtime)) return;
	await exclusive(async () => {
		await api("POST", "/api/restart", {}, false).catch(() => {
			try {
				process.kill(running.pid, "SIGTERM");
			} catch {
				// already gone
			}
		});
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline && (await health())) await Bun.sleep(100);
		await launch();
	});
}

/** Starts the board when it is down, else restarts it when its server code is stale. */
async function ensureBoard(): Promise<void> {
	if (await health()) await refreshBoard();
	else await exclusive(launch);
}

/** Calls the Mission Control API, starting the board first when it is down (unless autostart is false); rejects with the board's error. */
async function api<T>(method: string, path: string, body?: unknown, autostart = true): Promise<T> {
	const init: RequestInit = {
		method,
		headers: method === "GET" ? {} : { "Content-Type": "application/json" },
		body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
		signal: autostart ? undefined : AbortSignal.timeout(2000),
	};
	let res: Response;
	try {
		res = await fetch(BASE + path, init);
	} catch {
		if (!autostart) throw new Error("Mission Control isn't running");
		await exclusive(launch);
		try {
			res = await fetch(BASE + path, init);
		} catch {
			throw new Error(`Mission Control didn't start; see ${tilde(HOME)}/server.log`);
		}
	}
	const data: unknown = await res.json().catch(() => null);
	if (!res.ok) {
		const error = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "";
		throw new BoardError(res.status, error || `${res.status} ${res.statusText}`);
	}
	if (method === "GET" && path === "/api/state") rememberNumbers(data as Board);
	else if (data && typeof data === "object" && "id" in data && "number" in data) cardNumbers.set(String(data.id), String(data.number));
	return data as T;
}

/** The server-sent events of a stream body. */
async function* serverEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerEvent> {
	let buffer = "";
	for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
		buffer += chunk;
		for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
			const block = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			let event = "message";
			const data: string[] = [];
			for (const line of block.split("\n")) {
				if (line.startsWith("event:")) event = line.slice(6).trim();
				else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
			}
			if (data.length) yield { event, data: data.join("\n") };
		}
	}
}

// --- git, cmux, session -------------------------------------------------------------------------------------------

function git(args: string[], cwd: string): string {
	return (spawnSync("git", args, { cwd, encoding: "utf8" }).stdout ?? "").trim();
}

function realpath(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/** Whether cwd is in a linked git worktree (its git dir differs from the common dir). */
function linkedWorktree(cwd: string): boolean {
	const [gitDir, commonDir] = git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], cwd).split("\n");
	return Boolean(gitDir && commonDir && gitDir !== commonDir);
}

/** The top of the git checkout at cwd. */
const checkoutRoot = (cwd: string) => git(["rev-parse", "--show-toplevel"], cwd) || cwd;

/** The real path of the main checkout of the repository at cwd; null outside git. */
function mainCheckout(cwd: string): string | null {
	const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	return common ? realpath(dirname(common)) : null;
}

/** The task whose worktree is the git checkout at cwd. */
function worktreeTask(board: Board, cwd: string): Task | undefined {
	const root = realpath(checkoutRoot(cwd));
	return root ? board.tasks.find((t) => t.worktree && realpath(t.worktree) === root) : undefined;
}

/** What a tool call does, for its card: its intent, else the tool and its main argument. */
function stepText(event: { toolName: string; args: unknown; intent?: string }): string {
	if (event.intent) return event.intent;
	const args = event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : {};
	const detail = [args.path, args.pattern, args.query].find((v): v is string => typeof v === "string") ?? "";
	return `${event.toolName} ${detail}`.trim();
}

/** Whether the session's latest mode change entered plan mode. */
function inPlanMode(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "mode_change") return "mode" in entry && entry.mode === "plan";
	}
	return false;
}

const TERMINAL_OVERRIDES = ["MISSION_CONTROL_TERMINAL", "OMP_TERMINAL"];
let terminal: Promise<{ context: TerminalContext } | { error: string }> | undefined;

/** This omp's terminal context, detected and validated once; an unavailable MISSION_CONTROL_TERMINAL or OMP_TERMINAL is an error. */
function callerTerminal(): Promise<{ context: TerminalContext } | { error: string }> {
	terminal ??= detectTerminalContext({ python: PYTHON, overrideEnvs: TERMINAL_OVERRIDES }).then(
		(context) => ({ context }),
		(e) => ({ error: errorText(e) }),
	);
	return terminal;
}

/** The terminal context a new card records for its origin session; throws on an unavailable override. */
async function originTerminal(): Promise<TerminalContext> {
	const found = await callerTerminal();
	if ("error" in found) throw new Error(found.error);
	return found.context;
}

/** This session's terminal for a request that closes a worktree's terminals, so the board closes it last; undefined when unknown. */
async function requestTerminal(): Promise<TerminalContext | undefined> {
	const found = await callerTerminal();
	return "context" in found ? found.context : undefined;
}

/** Shows the board in this session's cmux workspace when it has one, else the default browser; throws when neither opens. */
async function showBoard(url: string, focus: boolean): Promise<void> {
	await openTerminalBoard(url, { focus, python: PYTHON, overrideEnvs: TERMINAL_OVERRIDES });
}

/** Where the user meets a task's agent: its live terminal, else the command that attaches one. */
function presentationText(t: Task): string {
	const p = t.presentation;
	if (p?.alive && p.kind !== "plain") return `in its ${p.kind} ${p.kind === "tmux" ? "window" : "workspace"}`;
	return t.attachCommand ? `after attaching with: ${t.attachCommand}` : "in its omp session";
}

// --- listings -----------------------------------------------------------------------------------------------------

const columnTitle = (board: Board, column: string) => board.columns.find((c) => c.id === column)?.title ?? column;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const numbers = (ids: string[]) => ids.map(taskNumber).join(", ");

/** A pull request in words: number, state, checks, review and conflicts. */
function prText(pr: PullRequest): string {
	const marks = [pr.checks && `checks ${pr.checks}`, pr.review && pr.review.replace("_", " "), pr.conflicts && "conflicts"].filter(Boolean);
	return `PR #${pr.number} ${pr.state}${marks.length ? ` (${marks.join(", ")})` : ""}`;
}

/** What a card waits on: its own open dependencies must be done; a block inherited from its parent tree only has to clear. */
function waitsUntil(t: { dependsOn: string[]; blockedBy: string[] }): string {
	const own = t.blockedBy.filter((b) => t.dependsOn.includes(b));
	const inherited = t.blockedBy.filter((b) => !t.dependsOn.includes(b));
	return [
		own.length && `${numbers(own)} ${own.length === 1 ? "is" : "are"} done`,
		inherited.length && `the block on its parent tree (${numbers(inherited)}) clears`,
	]
		.filter(Boolean)
		.join(" and ");
}

/** The cards of `projects`, open ones first, then done ones, then the projects' untracked worktrees; `self` is marked as this task. */
function listTasks(board: Board, projects: Project[], self: string | undefined): string {
	const hidden = (x: { project: string; branch: string }) => projects.some((p) => p.id === x.project && p.hidden.includes(x.branch));
	const ids = new Set(projects.map((p) => p.id));
	const several = projects.length > 1;
	const listed = board.tasks.filter((t) => ids.has(t.project));
	const tags = [...new Set(projects.flatMap((p) => p.tags))].sort();
	const lines = [`Tags in use: ${tags.join(", ") || "none"}`];
	for (const p of projects) lines.push(`Project ${p.id} (${tilde(p.repo)}, default branch ${p.defaultBranch})`);
	lines.push("");
	const open = listed.filter((t) => t.column !== "done");
	for (const t of open) {
		let line = `${t.id} · ${columnTitle(board, t.column)} · ${t.title} · ${t.branch} from ${t.base}`;
		if (t.id === self) line += " · this task";
		if (t.tags.length) line += ` · tags ${t.tags.join(", ")}`;
		if (t.dependsOn.length) line += ` · depends on ${t.dependsOn.join(", ")}`;
		if (t.parent) line += ` · child of ${t.parent}`;
		if (t.children.length) line += ` · ${plural(t.children.length, "child card")}`;
		if (t.held) line += " · paused until moved to In Progress";
		else if (t.paused) line += " · paused";
		if (t.blockedBy.length) line += ` · waits until ${waitsUntil(t)}`;
		else if (t.waitingForSlot) line += " · waiting for a task slot";
		if (t.agent && t.agent.state !== "idle") line += ` · ${t.agent.state.replace("_", " ")}`;
		if (t.worktree && (t.presentation || t.attachCommand)) line += ` · reach it ${presentationText(t)}`;
		if (t.health?.worktreeMissing) line += " · worktree missing";
		if (t.land.mergeInto) line += ` · merges into ${t.land.mergeInto}`;
		if (t.pr) line += ` · ${prText(t.pr)}`;
		if (t.controlSet) line += ` · controls ${t.controlSet}`;
		if (t.ticket) line += ` · ticket ${t.ticket}`;
		if (several) line += ` · project ${t.project}`;
		if (hidden(t)) line += " · hidden on the page";
		lines.push(line);
	}
	if (!open.length) lines.push("No open cards");
	const done = listed.filter((t) => t.column === "done");
	if (done.length) {
		lines.push("", "Done, still on the board (depend on one when new work builds on it; it doesn't block):");
		for (const t of done) lines.push(`${t.id} · ${t.title}${several ? ` · project ${t.project}` : ""}`);
	}
	const others = board.worktrees.filter((w) => ids.has(w.project));
	if (others.length) {
		lines.push("", "Other worktrees (no card; mission_control_adopt tracks one):");
		for (const w of others) {
			const work = w.git ? ` · ${plural(w.git.commits, "commit")}${w.git.dirty ? `, ${w.git.dirty} uncommitted` : ""}` : "";
			const tags = w.tags.length ? ` · tags ${w.tags.join(", ")}` : "";
			lines.push(`${w.branch} from ${w.base} · ${tilde(w.path)} · ${columnTitle(board, w.column)}${work}${w.pr ? ` · ${prText(w.pr)}` : ""}${tags}${hidden(w) ? " · hidden on the page" : ""}`);
		}
	}
	return lines.join("\n");
}

function findTask(board: Board, id: string): Task {
	const t = board.tasks.find((x) => x.id === id);
	if (!t) throw new Error(`Unknown task ${id}`);
	return t;
}

/** Adds dependencies to a task, keeping the ones it has; returns the resulting list. */
async function addDependencies(id: string, deps: string[]): Promise<string[]> {
	const t = findTask(await api<Board>("GET", "/api/state"), id);
	const dependsOn = [...new Set([...t.dependsOn, ...deps])];
	await api("PATCH", `/api/tasks/${id}`, { dependsOn });
	return dependsOn;
}

function mergeSummary(t: Task): string {
	const commits = t.git?.commits ?? 0;
	const dirty = t.git?.dirty ?? 0;
	const pending = dirty ? `, ${dirty} uncommitted file${dirty === 1 ? "" : "s"} will be committed` : "";
	return `${plural(commits, "commit")} on ${t.branch}, +${t.git?.added ?? 0} \u2212${t.git?.removed ?? 0}${pending}`;
}

/** How a task lands, for its agent. */
function landsText(t: Task): string {
	return t.land.mergeInto
		? `When the work is complete and verified, tell the user; do not push: /land (mission_control_land when the user says to merge) merges this branch into ${t.base}, removes this worktree and ends this session.`
		: `When the work is complete and verified, commit it, push the branch and open a pull request into ${t.base} (/land or mission_control_land does it).`;
}

function taskContext(id: string, board: Board | null): string {
	const t = board?.tasks.find((x) => x.id === id);
	if (!board || !t) return `This session works on Mission Control task ${id}. Read the other cards with mission_control_tasks; don't do their part. ${SHARING}`;
	const builders = board.tasks.filter((o) => o.dependsOn.includes(id)).map((o) => o.id);
	return `This session works on Mission Control task ${taskNumber(t.id)}: ${t.title}, on ${t.branch} from ${t.base}. ${landsText(t)} It waits for: ${t.blockedBy.length ? numbers(t.blockedBy) : "nothing"}. Tasks that build on it: ${builders.length ? numbers(builders) : "none"}. Read another card with mission_control_tasks; don't do its part. If your work touches another product area, add its tag with mission_control_edit. ${SHARING}`;
}

/** Renders a task's shared context for a tool result, newest entries kept when it's long. */
function contextText(c: TaskContext): string {
	const head = `${c.id} · revision ${c.revision}${c.updatedAt ? ` · updated ${c.updatedAt}` : ""}`;
	if (!c.entries.length) return `${head}\nNothing recorded yet.`;
	const blocks = c.entries.map((e) => {
		const stamp = [e.source, e.ref, e.at].filter(Boolean).join(" · ");
		return `## ${e.kind}${stamp ? ` (${stamp})` : ""}\n${e.text}`;
	});
	let shown = blocks.length;
	while (shown > 1 && blocks.slice(blocks.length - shown).join("\n\n").length > DIFF_TOOL_LIMIT) shown--;
	const cut = shown < blocks.length ? `\n\n[${blocks.length - shown} older entries not shown]` : "";
	return `${head}\n\n${blocks.slice(blocks.length - shown).join("\n\n")}${cut}`;
}

/** One card for hierarchy listings: id, column, title and what it waits on. */
function cardLine(board: Board, id: string): string {
	const t = board.tasks.find((x) => x.id === id);
	if (!t) return `${id} (not on the board)`;
	const state = t.merged
		? `merged into ${t.merged.into}`
		: t.paused
			? "paused"
			: t.blockedBy.length
				? `waits until ${waitsUntil(t)}`
				: t.waitingForSlot
					? "waiting for a task slot"
					: t.agent && t.agent.state !== "idle"
						? t.agent.state.replace("_", " ")
						: "";
	return `${t.id} · ${columnTitle(board, t.column)} · ${t.title}${state ? ` · ${state}` : ""}`;
}

function childrenText(board: Board, t: Task): string {
	const lines = [`${t.id}: ${t.title} (${columnTitle(board, t.column)})`];
	lines.push(t.parent ? `Parent: ${cardLine(board, t.parent)}` : "No parent");
	if (t.children.length) lines.push(`Children (${t.children.length}):`, ...t.children.map((c) => `- ${cardLine(board, c)}`));
	else lines.push("No children");
	lines.push("Parent groups cards; use dependsOn for ordering. Children also wait for what their parent tree depends on.");
	return lines.join("\n");
}

// --- omp theme ----------------------------------------------------------------------------------------------------

type Tone = "accent" | "muted" | "dim" | "success" | "warning" | "error";

/** The parts of omp's theme the widget paints with. */
interface Paint {
	fg(color: Tone, text: string): string;
	bold(text: string): string;
	getSymbolPreset(): string;
}

// Undocumented omp exports, used as omp-git-diff-review does; without them the board keeps cmux's colors.
const themeApi = hasThemeApi(omp);
const WIDGET = "mission-control";
const BOARD_GLYPH: Record<string, string> = { nerd: "\uf135", unicode: "\u{1f680}", ascii: "[mc]" };
const AGENT_LOOK: Record<string, [Tone, string]> = {
	needs_input: ["warning", "needs input"],
	plan_ready: ["warning", "plan ready for review"],
	planning: ["accent", "planning"],
	thinking: ["accent", "thinking"],
	working: ["accent", "working"],
	idle: ["muted", "idle"],
	disconnected: ["muted", "omp disconnected"],
	stopped: ["muted", "stopped"],
};
const CONTROL = /\p{Cc}/gu;
const THEME_VARS: Record<string, string> = {
	"--bg": "pageBg",
	"--fg": "text",
	"--accent": "accent",
	"--muted": "muted",
	"--add": "toolDiffAdded",
	"--remove": "toolDiffRemoved",
	"--warning": "warning",
	"--cyan": "borderAccent",
};

/** What a card's operation in progress shows, or null when none runs. */
function intentText(t: Task): string | null {
	const i = t.intent;
	if (!i) return null;
	const text = { start: "starting", resume: "resuming", stop: "stopping", merge: `merging into ${t.base}`, remove: "removing worktree", delete: "deleting" }[i.op] ?? i.op;
	return i.attempt > 0 ? `${text} (retrying: ${i.lastError ?? "unknown error"})` : text;
}

/** How a task session's own card reads in the widget: its tone and state. */
function cardLook(t: Task): [Tone, string] | null {
	const busy = intentText(t);
	if (busy) return ["accent", busy];
	if (t.spawn.state === "failed") return ["error", "didn't start"];
	if (t.merged) return ["success", `merged into ${t.merged.into}`];
	if (t.column === "review") return ["success", t.land.mergeInto ? `ready to merge into ${t.land.mergeInto}` : "ready for pull request"];
	if (t.column === "pr" && t.pr) return [t.pr.checks === "failing" || t.pr.review === "changes_requested" || t.pr.conflicts ? "warning" : "success", prText(t.pr)];
	if (t.column === "waiting") return ["warning", t.held || t.paused ? "paused" : t.waitingForSlot ? "waiting for a task slot" : "waiting"];
	return (t.agent && AGENT_LOOK[t.agent.state]) || null;
}

/** The widget's line: a task session's own card. */
function widgetLines(p: Paint, board: Board | null, id: string): string[] {
	const icon = p.fg("accent", BOARD_GLYPH[p.getSymbolPreset()] ?? BOARD_GLYPH.unicode);
	const sep = p.fg("dim", " \u00b7 ");
	const head = ` ${icon} ${p.bold(p.fg("accent", taskNumber(id)))}`;
	const t = board?.tasks.find((x) => x.id === id);
	if (!t) return [head];
	const commits = t.git?.commits ?? 0;
	const work = commits
		? `${p.fg("muted", plural(commits, "commit"))} ${p.fg("success", `+${t.git?.added ?? 0}`)} ${p.fg("error", `\u2212${t.git?.removed ?? 0}`)}`
		: p.fg("dim", "no commits yet");
	const look = cardLook(t);
	const state = look ? `${sep}${p.fg(look[0], look[1])}` : "";
	const waits = t.blockedBy.length ? `${sep}${p.fg("muted", `waits for ${numbers(t.blockedBy)}`)}` : "";
	return [`${head} ${t.title.replace(CONTROL, " ")} ${p.fg("muted", `from ${t.base}`)}${sep}${work}${state}${waits}`];
}

/** omp's current theme as board colors (the mapping omp-git-diff-review uses); the board puts them over cmux's colors. */
async function themeAppearance(): Promise<{ scheme: Scheme; vars: Record<string, string> }> {
	const theme = resolveTheme(await currentTheme(omp), null);
	const vars: Record<string, string> = {};
	for (const [name, token] of Object.entries(THEME_VARS)) {
		const value = theme.colors[token];
		if (value) vars[name] = value;
	}
	if (vars["--accent"]) vars["--accent-fg"] = isLightColor(vars["--accent"]) ? "#000000" : "#ffffff";
	return { scheme: theme.scheme, vars };
}

/** Completes the last word of a command's arguments from `values`, keeping the words before it. */
function completeLast(prefix: string, values: AutocompleteItem[]): AutocompleteItem[] | null {
	const at = prefix.lastIndexOf(" ") + 1;
	const head = prefix.slice(0, at);
	const word = prefix.slice(at).toLowerCase();
	const matches = values.filter((v) => v.value.toLowerCase().startsWith(word)).map((v) => ({ ...v, value: head + v.value }));
	return matches.length ? matches : null;
}

// --- extension ----------------------------------------------------------------------------------------------------

export default function missionControl(pi: ExtensionAPI) {
	const z = pi.zod;
	let engaged = false;
	let projectId: string | null = null;
	let sessionId = "";
	let lastCard: string | null = null;
	let lastCleanup = true;
	let task: string | null = null;
	let taskLookup = false;
	let reporting: boolean | undefined;
	let reportRetryAt = 0;
	let shuttingDown = false;
	const handledControls: string[] = [];
	let reported = "";
	let current = "";
	let planning = false;
	let reviewOpen = false;
	let currentStep: string | null = null;
	let reportedStep: string | null = null;
	let stepTimer: Timer | undefined;
	let sentAt = 0;
	let reports = Promise.resolve();
	let sessionFile: string | null = null;
	let lastMessage: string | null = null;
	let terminalWarned = false;
	let stream: AbortController | null = null;
	let seen: Map<string, Task> | null = null;
	let latest: Board | null = null;
	let repaint: (() => void) | null = null;
	let themeEpoch: number | null = null;
	let themeTimer: Timer | undefined;
	let sessionCtx: ExtensionContext | null = null;
	let autoMerging = false;

	/** Shows the widget under the editor in a task session. */
	const showWidget = (ctx: ExtensionContext) => {
		if (!task) return ctx.ui.setWidget(WIDGET, undefined);
		const ui = ctx.ui;
		ui.setWidget(
			WIDGET,
			(tui) => {
				let rows: string[] = [];
				let width = -1;
				const mine = () => {
					width = -1;
					tui.requestRender();
				};
				repaint = mine;
				return {
					render(w: number) {
						if (w !== width) {
							width = w;
							rows = widgetLines(ui.theme, latest, task ?? "").map((line) => truncateToWidth(line, w));
						}
						return rows;
					},
					invalidate() {
						width = -1;
					},
					dispose() {
						if (repaint === mine) repaint = null;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	};

	/** Gives the board this session's omp theme for its project, once per theme change. */
	const syncTheme = () => {
		if (!themeApi || !projectId) return;
		const epoch: number = omp.getThemeEpoch();
		if (epoch === themeEpoch) return;
		themeEpoch = epoch;
		const project = projectId;
		void themeAppearance()
			.then((look) => (themeEpoch === epoch ? api("POST", "/api/appearance", { project, ...look }, false) : undefined))
			.catch(() => {});
	};

	/** The project this session works in: its task's, else the registered one, else the one of this checkout's main checkout. */
	const sessionProject = (board: Board, ctx: ExtensionContext): Project | undefined => {
		const id = (task ? board.tasks.find((t) => t.id === task)?.project : undefined) ?? projectId;
		const named = id ? board.projects.find((p) => p.id === id) : undefined;
		if (named) return named;
		const repo = mainCheckout(ctx.cwd);
		return repo ? board.projects.find((p) => realpath(p.repo) === repo) : undefined;
	};

	/** Registers the project of this checkout and remembers it for the session. */
	const registerProject = async (ctx: ExtensionContext): Promise<Project> => {
		const r = await api<{ project: Project }>("POST", "/api/projects", { path: ctx.cwd });
		projectId = r.project.id;
		return r.project;
	};

	/** The card a reference names: a number ("12", "#12") among this session's project's cards, else a card id (mc-12, KB-74.1). */
	const cardId = async (raw: string, ctx: ExtensionContext): Promise<string> => {
		const ref = raw.trim().replace(/^#(?=\d)/, "");
		if (/^(mc|kb)-\d+(\.\d+)*$/i.test(ref)) return ref.toUpperCase();
		if (!/^\d+(\.\d+)*$/.test(ref)) return ref;
		const board = await api<Board>("GET", "/api/state");
		const project = sessionProject(board, ctx);
		const found = board.tasks.filter((t) => t.number === ref && (!project || t.project === project.id));
		if (found.length === 1) return found[0].id;
		throw new Error(found.length ? `#${ref} names cards in several projects` : `No card #${ref}${project ? ` in ${project.name}` : ""}`);
	};
	const cardIds = (refs: string[], ctx: ExtensionContext) => Promise.all(refs.map((ref) => cardId(ref, ctx)));

	/** This worktree's card: the task session's own, else this linked worktree adopted as a card. */
	const ownCard = async (ctx: ExtensionContext): Promise<Task> => {
		if (task) return findTask(await api<Board>("GET", "/api/state"), task);
		if (!linkedWorktree(ctx.cwd)) throw new Error("This is the main checkout: run it in a task's worktree");
		return api<Task>("POST", "/api/worktrees/adopt", { path: checkoutRoot(ctx.cwd) });
	};

	const tell = async (ctx: ExtensionContext, work: Promise<string>) => {
		try {
			ctx.ui.notify(withNumbers(await work), "info");
		} catch (e) {
			ctx.ui.notify(withNumbers(errorText(e)), "error");
		}
	};

	const answer = async (work: Promise<string>) => {
		try {
			return toolReply(withNumbers(await work));
		} catch (e) {
			return toolReply(withNumbers(errorText(e)), true);
		}
	};

	// --- agent state reports

	/** Posts the latest state and step. */
	const send = (path: string): Promise<void> => {
		clearTimeout(stepTimer);
		stepTimer = undefined;
		const state = current;
		const step = currentStep;
		reported = state;
		reportedStep = step;
		sentAt = Date.now();
		reports = reports.then(() =>
			api("POST", "/api/agent", { path, task: task ?? process.env.MISSION_CONTROL_TASK ?? null, state, step, sessionId, sessionFile, message: lastMessage }, false).then(
				() => {},
				(e) => {
					reported = "";
					if (e instanceof BoardError && e.status === 404) reportRetryAt = Date.now() + 3000;
				},
			),
		);
		return reports;
	};

	/** Reports a state change at once; a new step under the same state at most every STEP_MS. */
	const report = (ctx: ExtensionContext, state: string, step: string | null = null): Promise<void> => {
		if (ctx.agent?.kind === "sub") return reports;
		current = state;
		currentStep = step;
		if (state === reported && step === reportedStep) return reports;
		reporting ??= Boolean(process.env.MISSION_CONTROL_TASK) || linkedWorktree(ctx.cwd);
		if (!reporting || Date.now() < reportRetryAt) return reports;
		const path = ctx.cwd;
		const wait = sentAt + STEP_MS - Date.now();
		if (state === reported && wait > 0) {
			stepTimer ??= setTimeout(() => {
				stepTimer = undefined;
				if (current !== reported || currentStep !== reportedStep) void send(path);
			}, wait);
			return reports;
		}
		return send(path);
	};

	/** What the board's hold on an approved plan waits for, until the run the approval starts is stopped or the agent is resumed. */
	let holding: string | null = null;

	/** Stops the run an approved plan starts while the board holds it. */
	const stopHeld = (ctx: ExtensionContext) => {
		const waits = holding;
		if (!waits) return;
		holding = null;
		ctx.abort();
		void report(ctx, "idle");
		ctx.ui.notify(`Plan approved · ${waits}`, "info");
	};

	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		if ("prompt" in event && typeof event.prompt === "string") lastMessage = event.prompt.slice(0, 2000);
	});
	pi.on("turn_start", (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		if (holding) {
			stopHeld(ctx);
			return;
		}
		planning = inPlanMode(ctx);
		void report(ctx, planning ? "planning" : "thinking");
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		if (event.toolName.startsWith("mission_control_")) engage(ctx);
		void report(ctx, event.toolName === "ask" ? "needs_input" : planning ? "planning" : "working", stepText(event));
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.agent?.kind !== "sub" && event.toolName === "ask") void report(ctx, planning ? "planning" : "working");
	});
	pi.on("agent_end", (event, ctx) => {
		if (ctx.agent?.kind === "sub" || ("willContinue" in event && event.willContinue === true)) return;
		void report(ctx, reviewOpen ? "plan_ready" : "idle");
		if (task) void autoMerge(ctx);
	});

	// --- control sets (the Control plugin, when installed)

	/** Asks the Control plugin in this omp over the shared bus; without an answer in time it isn't loaded. */
	const controlAsk = (command: ControlRequest) => busAsk<ControlReply>(pi.events, CONTROL_ASK_EVENT, command, CONTROL_ASK_MS, "The Control plugin isn't loaded in this omp");

	pi.events.on(CONTROL_SETS_EVENT, (data) => {
		if (!engaged || !projectId || !Array.isArray(data)) return;
		void api("PATCH", "/api/projects/control-sets", { id: projectId, sets: data }, false).catch(() => {});
	});

	/** After each connect: the project's set list from Control (null clears a stale one). */
	const syncControl = async () => {
		if (!engaged || !projectId) return;
		const id = projectId;
		const r = await controlAsk({ type: "sets" });
		await api("PATCH", "/api/projects/control-sets", { id, sets: r.ok ? (r.sets ?? null) : null }, false).catch(() => {});
	};

	/** A stacked task whose controls passed with approval apply merges into its parent branch once the agent has stopped. */
	const autoMerge = async (ctx: ExtensionContext) => {
		if (!task || autoMerging) return;
		const id = task;
		const r = await controlAsk({ type: "status" });
		if (!r.ok || !r.passed || !r.autonomous) return;
		autoMerging = true;
		try {
			const t = findTask(await api<Board>("GET", "/api/state"), id);
			if (!t.land.mergeInto || t.merged || !t.worktree) return;
			ctx.ui.notify(`Controls passed: merging ${taskNumber(id)} into ${t.land.mergeInto}`, "info");
			await api("POST", `/api/tasks/${id}/merge`, { cleanup: true, commit: true, terminal: await requestTerminal() });
		} catch (e) {
			const message = errorText(e);
			if (!message.includes(" is still ")) ctx.ui.notify(`Couldn't merge ${taskNumber(id)} automatically: ${message}`, "error");
		} finally {
			autoMerging = false;
		}
	};

	// --- event stream

	/** Tells the session that created a card what happened to it. */
	const watch = (ctx: ExtensionContext, board: Board) => {
		const next = new Map<string, Task>();
		for (const t of board.tasks) {
			if (t.origin?.session !== sessionId) continue;
			const before = seen?.get(t.id);
			next.set(t.id, !t.agent && before?.agent ? { ...t, agent: before.agent } : t);
			if (!before) continue;
			const n = `${taskNumber(t.id)} · ${t.title}`;
			if (t.spawn.state === "failed" && before.spawn.state !== "failed") {
				ctx.ui.notify(`${taskNumber(t.id)} didn't start: ${t.spawn.error ?? "unknown error"}`, "error");
			}
			if (t.agent?.state === "needs_input" && before.agent?.state !== "needs_input") {
				ctx.ui.notify(`${taskNumber(t.id)} needs your input ${presentationText(t)}`, "warning");
			}
			if (t.agent?.state === "plan_ready" && before.agent?.state !== "plan_ready") {
				ctx.ui.notify(`${taskNumber(t.id)}'s plan is ready: review it ${presentationText(t)}`, "warning");
			}
			if (t.column === "doing" && before.column === "waiting") ctx.ui.notify(`${n}\nResumed: what it waited for has landed`, "info");
			if (t.column === "review" && before.column !== "review") {
				ctx.ui.notify(
					t.land.mergeInto ? `${n}\nReady to merge ${t.branch} → ${t.land.mergeInto}` : `${n}\nReady for a pull request ${t.branch} → ${t.base}`,
					"info",
				);
			}
			if (t.pr?.checks === "failing" && before.pr?.checks !== "failing") ctx.ui.notify(`${n}\nPR #${t.pr.number}: checks failing`, "warning");
			if (t.pr?.state === "merged" && before.pr?.state !== "merged") {
				ctx.ui.notify(`${n}\nPR #${t.pr.number} merged: ${t.branch} → ${t.pr.base}`, "info");
			} else if (t.merged && !before.merged) {
				ctx.ui.notify(`${n}\nMerged ${t.branch} → ${t.merged.into} (${t.merged.sha.slice(0, 7)})`, "info");
			}
		}
		seen = next;
	};

	const answerControl = (id: string, ok: boolean, message: string) =>
		api("POST", `/api/control/${id}`, { ok, message }, false).then(
			() => {},
			() => {},
		);

	/** Carries out a board command for this task's agent through omp, then answers it. */
	const runControl = async (ctx: ExtensionContext, c: Control) => {
		if (handledControls.includes(c.id)) return answerControl(c.id, true, "Already handled");
		handledControls.push(c.id);
		if (handledControls.length > 50) handledControls.shift();
		let ok = true;
		let message: string;
		try {
			const review = ctx.getPendingPlanReview();
			if (c.action === "pause") {
				const running = !ctx.isIdle();
				if (running) ctx.abort();
				void report(ctx, review ? "plan_ready" : "idle");
				message = running ? "Interrupted its turn" : "It was idle";
				ctx.ui.notify(`Mission Control paused ${taskNumber(c.task)}; moving its card back to In Progress resumes it`, "warning");
			} else if (c.action === "message") {
				if (review) {
					ok = false;
					message = "Its plan is waiting for review in its omp";
				} else {
					holding = null;
					const idle = ctx.isIdle();
					pi.sendUserMessage(c.text ?? "");
					message = idle ? "It started a turn with it" : "It gets it at its next step";
				}
			} else if (c.action === "stop") {
				if (!ctx.isIdle()) ctx.abort();
				await answerControl(c.id, true, "Its omp session is exiting");
				ctx.shutdown();
				return;
			} else {
				ok = false;
				message = `Unknown command ${c.action}`;
			}
		} catch (e) {
			ok = false;
			message = errorText(e);
		}
		await answerControl(c.id, ok, message);
	};

	const onEvent = (ctx: ExtensionContext, e: ServerEvent) => {
		try {
			const data: unknown = JSON.parse(e.data);
			if (e.event === "snapshot") {
				latest = data as Board; // the server's /api/state shape
				rememberNumbers(latest);
				watch(ctx, latest);
				repaint?.();
			} else if (e.event === "control" && isControl(data) && data.task === task) {
				void runControl(ctx, data);
			}
		} catch {
			// a malformed event is skipped
		}
	};

	const stopStream = () => {
		stream?.abort();
		stream = null;
		clearInterval(themeTimer);
		themeTimer = undefined;
	};

	/** Keeps one event stream open in a task session or an engaged one; never starts the board. An engaged session (re)registers its project on each connect. */
	const syncStream = (ctx: ExtensionContext) => {
		if (!engaged && !task) return stopStream();
		if (stream) return;
		const ctl = new AbortController();
		stream = ctl;
		seen = null;
		if (themeApi) themeTimer = setInterval(syncTheme, 1000);
		const cwd = ctx.cwd;
		void (async () => {
			while (!ctl.signal.aborted) {
				try {
					const query = new URLSearchParams({ session: sessionId });
					if (task) query.set("task", task);
					if (engaged) {
						projectId = await api<{ project: Project }>("POST", "/api/projects", { path: cwd }, false).then(
							(r) => r.project.id,
							(e) => {
								if (e instanceof BoardError) return null;
								throw e;
							},
						);
						if (projectId) query.set("project", projectId);
					}
					const where = await callerTerminal();
					if ("context" in where) query.set("terminal", JSON.stringify(where.context));
					else if (!terminalWarned) {
						terminalWarned = true;
						ctx.ui.notify(`Mission Control: ${where.error}`, "warning");
					}
					const conn = new AbortController();
					const cancel = () => conn.abort();
					ctl.signal.addEventListener("abort", cancel, { once: true });
					let watchdog: Timer | undefined;
					const arm = () => {
						clearTimeout(watchdog);
						watchdog = setTimeout(cancel, STREAM_IDLE_MS);
					};
					try {
						arm();
						const res = await fetch(`${BASE}/api/events?${query}`, { signal: conn.signal });
						if (res.ok && res.body) {
							themeEpoch = null;
							syncTheme();
							reported = "";
							void report(ctx, current || "idle", currentStep);
							void syncControl();
							const body = res.body.pipeThrough(
								new TransformStream<Uint8Array, Uint8Array>({
									transform(chunk, out) {
										arm();
										out.enqueue(chunk);
									},
								}),
							);
							for await (const e of serverEvents(body)) onEvent(ctx, e);
						} else await res.body?.cancel();
					} finally {
						clearTimeout(watchdog);
						ctl.signal.removeEventListener("abort", cancel);
					}
				} catch {
					// reconnects below
				}
				if (!ctl.signal.aborted) await Bun.sleep(RECONNECT_MS);
			}
		})();
	};

	// --- session state

	/** Marks this session as using Mission Control: it streams the board from now on, and after a restore. */
	function engage(ctx: ExtensionContext) {
		if (engaged) return;
		engaged = true;
		pi.appendEntry(ENGAGED_ENTRY, { engaged: true });
		stopStream();
		syncStream(ctx);
	}

	/** Sends the "continue where you stopped" message the board left for a resumed session, then tells the board it went out. */
	const nudge = (id: string) => {
		const file = process.env.MISSION_CONTROL_RESUME_FILE;
		if (!file || !existsSync(file)) return;
		let text: string;
		try {
			const data: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!data || typeof data !== "object" || !("text" in data) || typeof data.text !== "string" || !data.text) return;
			text = data.text;
		} catch {
			return;
		}
		setTimeout(async () => {
			pi.sendUserMessage(text);
			await api("POST", `/api/tasks/${id}/resumed`, {}, false).catch(() => {});
		}, 1500);
	};

	const enterTask = (ctx: ExtensionContext, id: string) => {
		task = id;
		showWidget(ctx);
		stopStream();
		syncStream(ctx);
		nudge(id);
	};

	/** Task mode: MISSION_CONTROL_TASK, else a board task whose worktree is this checkout (retried while the board is down; never starts the board). */
	const detectTask = async (ctx: ExtensionContext) => {
		const env = process.env.MISSION_CONTROL_TASK;
		if (!env && !linkedWorktree(ctx.cwd)) return;
		if (env) return enterTask(ctx, env);
		while (!shuttingDown) {
			try {
				const found = worktreeTask(await api<Board>("GET", "/api/state", undefined, false), ctx.cwd);
				if (found && !shuttingDown) enterTask(ctx, found.id);
				return;
			} catch {
				await Bun.sleep(RECONNECT_MS);
			}
		}
	};

	const restore = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.agent?.kind === "sub") return;
		serverCwd = ctx.cwd;
		sessionCtx = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		lastCleanup = true;
		engaged = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === CLEANUP_ENTRY) lastCleanup = entry.data?.cleanup !== false;
			else if (entry.customType === ENGAGED_ENTRY) engaged = true;
		}
		if (!engaged) projectId = null;
		showWidget(ctx);
		stopStream();
		syncStream(ctx);
		// An engaged session brings the board back so pages left open reconnect; a task session never starts it.
		if (engaged && !process.env.MISSION_CONTROL_TASK) void ensureBoard().catch((e) => ctx.ui.notify(errorText(e), "warning"));
		if (!taskLookup) {
			taskLookup = true;
			void detectTask(ctx);
		}
	};
	pi.on("session_start", restore);
	pi.on("session_switch", restore);
	pi.on("session_branch", restore);
	pi.on("session_tree", restore);

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		shuttingDown = true;
		stopStream();
		await report(ctx, "exited");
	});

	// --- cards

	/** A new task in its own worktree; its omp plans the prompt. */
	const createTask = async (ctx: ExtensionContext, body: Record<string, unknown>): Promise<Task> => {
		const t = await api<Task>("POST", "/api/tasks", {
			...body,
			repo: ctx.cwd,
			origin: { session: ctx.sessionManager.getSessionId(), terminal: await originTerminal() },
		});
		lastCard = t.id;
		return t;
	};

	const createdText = (t: Task, from?: string) =>
		`${t.id} ${t.title} · planning on ${t.branch}${from ? ` (from ${from})` : ` from ${t.base}`}${t.blockedBy.length ? ` · waits for ${t.blockedBy.join(", ")}` : ""}`;

	/** Asks a card's agent (or gh) to open its pull request. */
	const createPr = async (id: string): Promise<string> => {
		const r = await api<{ via: "agent" | "gh"; url?: string }>("POST", `/api/tasks/${id}/pr`, {});
		return r.via === "agent" ? `Asked ${id}'s agent to commit, push and open the pull request` : `Opened a pull request for ${id}${r.url ? `: ${r.url}` : ""}`;
	};

	/** Commits pending changes and merges a stacked task into its parent branch: this worktree's own card without asking (removing it), else with a cleanup choice. */
	const merge = async (ctx: ExtensionContext, t: Task, own: boolean): Promise<string> => {
		const id = t.id;
		if (!ctx.hasUI) throw new Error(`Merging needs the user's confirmation: ask them to run /land in ${id}'s worktree`);
		if (t.merged) throw new Error(`${id} is already merged into ${t.merged.into}`);
		if (!t.worktree) throw new Error(`${id} has no worktree, so there is nothing to merge`);
		if (!t.land.mergeInto) throw new Error(`${id} branches from ${t.base}, the default branch: it lands through a pull request`);
		let cleanup: boolean;
		if (own) {
			cleanup = true;
		} else {
			const options = lastCleanup ? [MERGE_REMOVE, MERGE_KEEP, CANCEL] : [MERGE_KEEP, MERGE_REMOVE, CANCEL];
			const pick = await ctx.ui.select(`Merge ${taskNumber(id)} into ${t.base}? ${mergeSummary(t)}`, options);
			if (pick !== MERGE_REMOVE && pick !== MERGE_KEEP) return "Merge cancelled";
			cleanup = pick === MERGE_REMOVE;
			if (cleanup !== lastCleanup) {
				lastCleanup = cleanup;
				pi.appendEntry(CLEANUP_ENTRY, { cleanup });
			}
		}
		const r = await api<{ output: string; merged?: { into: string; sha: string } | null; pending?: boolean }>("POST", `/api/tasks/${id}/merge`, {
			cleanup,
			commit: true,
			terminal: await requestTerminal(),
		});
		const ends = own && task === id;
		if (ends) {
			const text = `Merged ${t.branch} \u2192 ${t.base} (${r.merged?.sha.slice(0, 7) ?? "?"}) \u00b7 this session ends${r.pending ? "; the worktree is removed once this session has exited" : ""}`;
			setTimeout(() => {
				ctx.ui.notify(text, "info");
				ctx.shutdown();
			}, 0);
		}
		if (!r.pending || ends) return r.output;
		return `${r.output}\n${taskNumber(id)} ${cleanup ? "has its worktree removed once its agent has stopped" : "is stopping its agent"}`;
	};

	/** Lands a card: merges a stacked one into its parent branch, else opens its pull request; `how` forces one. Without `raw`, this worktree's card. */
	const land = async (ctx: ExtensionContext, raw: string | undefined, how: "merge" | "pr" | undefined): Promise<string> => {
		let t: Task;
		let own: boolean;
		if (raw?.trim()) {
			const board = await api<Board>("GET", "/api/state");
			t = findTask(board, await cardId(raw, ctx));
			own = t.id === (task ?? worktreeTask(board, ctx.cwd)?.id);
		} else {
			t = await ownCard(ctx);
			own = true;
		}
		const mode = how ?? (t.land.mergeInto ? "merge" : "pr");
		return mode === "merge" ? merge(ctx, t, own) : createPr(t.id);
	};

	const deleteCard = async (ctx: ExtensionContext, raw: string): Promise<string> => {
		const id = await cardId(raw, ctx);
		if (!ctx.hasUI) throw new Error(`Deleting needs the user's confirmation: ask them to delete ${id} on the board`);
		const board = await api<Board>("GET", "/api/state");
		const t = findTask(board, id);
		const column = columnTitle(board, t.column);
		const dependents = board.tasks.filter((o) => o.column !== "done" && o.dependsOn.includes(id)).map((o) => o.id);
		const links = [
			t.children.length && `${t.children.join(", ")} lose${t.children.length === 1 ? "s" : ""} its parent`,
			dependents.length && `${dependents.join(", ")} no longer wait${dependents.length === 1 ? "s" : ""} for it and may resume`,
		].filter(Boolean);
		const unlinks = links.length ? ` ${links.join("; ")}.` : "";
		let cleanup = false;
		if (t.worktree) {
			const working = t.moveRequiresConfirmation ? " It may still be working: keeping the worktree leaves its omp running." : "";
			const pick = await ctx.ui.select(
				`Delete ${taskNumber(id)}? ${t.title} (${column}). Removing its worktree ${tilde(t.worktree)} also deletes the branch ${t.branch} and ends its omp and terminal.${working}${unlinks}`,
				[DELETE_REMOVE, DELETE_KEEP, CANCEL],
			);
			if (pick !== DELETE_REMOVE && pick !== DELETE_KEEP) return `${id} kept`;
			cleanup = pick === DELETE_REMOVE;
		} else if (!(await ctx.ui.confirm(`Delete ${taskNumber(id)}?`, `${t.title} (${column})\n\nIt has no worktree.${unlinks}`))) return `${id} kept`;
		const terminal = await requestTerminal();
		const r = await api<{ output?: string; pending?: boolean; message?: string }>("DELETE", `/api/tasks/${id}`, { confirmWorking: t.moveRequiresConfirmation, cleanup, terminal });
		if (r.pending) return r.message ?? `${id} is deleted once its worktree is gone`;
		return r.output ? `Deleted ${id}\n${r.output}` : `Deleted ${id}`;
	};

	/** Moves a card as dragging it on the board does; the reply says what that did to its agent. */
	const moveCard = async (ctx: ExtensionContext, raw: string, column: string, force: boolean): Promise<string> => {
		const id = await cardId(raw, ctx);
		const before = findTask(await api<Board>("GET", "/api/state"), id);
		const t = await api<Task & { note?: string }>("POST", `/api/tasks/${id}/move`, { column, confirmWorking: true, force });
		if (t.column === "waiting") {
			return `${before.column === "waiting" ? `${id} stays paused` : `Paused ${id}: ${t.note ?? "its agent stopped"}`}. Its worktree and session stay; moving it to In Progress resumes it.`;
		}
		if (t.column === "doing") {
			if (before.spawn.state === "failed") return `${id} starting again`;
			if (before.column === "doing") return `${id} continues in In Progress`;
			return `Resumed ${id}: its agent continues${before.session?.connected ? "" : " once omp reopens on its session"}.`;
		}
		return `Moved ${id} to Done`;
	};

	const cleanupCard = async (ctx: ExtensionContext, raw: string): Promise<string> => {
		const id = await cardId(raw, ctx);
		if (!ctx.hasUI) throw new Error(`Removing a worktree needs the user's confirmation: ask them to remove ${id}'s on the board`);
		const t = findTask(await api<Board>("GET", "/api/state"), id);
		if (!t.worktree) throw new Error(`${id} has no worktree`);
		const keeps = t.merged || t.column === "done" ? "The card stays." : "The card goes with it: the task isn't done.";
		const sure = await ctx.ui.confirm(`Remove ${taskNumber(id)}'s worktree?`, `Deletes ${tilde(t.worktree)} and the branch ${t.branch}, ending its omp and terminal. ${keeps}`);
		if (!sure) return `${id}'s worktree kept`;
		const terminal = await requestTerminal();
		const r = await api<{ output: string; pending?: boolean; deleted?: boolean }>("POST", `/api/tasks/${id}/cleanup`, { terminal });
		const output = r.output ? `${r.output}\n` : "";
		if (r.pending) return `${output}${id}'s worktree is removed once its agent has stopped`;
		return r.deleted ? `${output}Removed ${id}'s worktree and its card` : r.output;
	};

	/** Shows the board on the session's project: this worktree's card when it belongs to it, else the session's last card. */
	const openBoard = async (ctx: ExtensionContext, focus: boolean): Promise<string> => {
		const project = await registerProject(ctx);
		const board = await api<Board>("GET", "/api/state");
		const own = worktreeTask(board, ctx.cwd);
		const card = own?.project === project.id ? own.id : (lastCard ?? undefined);
		await showBoard(`${BASE}/?project=${encodeURIComponent(project.id)}${card ? `#${card}` : ""}`, focus);
		return `Mission Control on ${project.name} (${project.defaultBranch})`;
	};

	// --- commands

	/** Registers a command that marks the session engaged and reports its result or error. */
	const command = (name: string, description: string, run: (args: string, ctx: ExtensionContext) => Promise<string>, complete?: (prefix: string) => AutocompleteItem[] | null) => {
		pi.registerCommand(name, {
			description,
			getArgumentCompletions: complete,
			handler: async (args, ctx) => {
				if (ctx.agent?.kind === "sub") return;
				serverCwd = ctx.cwd;
				engage(ctx);
				await tell(ctx, run(args.trim(), ctx));
			},
		});
	};

	/** Open cards of the latest board read, by number, for completions. */
	const cardItems = (): AutocompleteItem[] =>
		(lastBoard?.tasks ?? [])
			.filter((t) => t.column !== "done" && (!projectId || t.project === projectId))
			.map((t) => ({ label: `#${t.number}`, value: `#${t.number}`, description: t.title }));
	const tagItems = (): AutocompleteItem[] => {
		const tags = (lastBoard?.projects ?? []).filter((p) => !projectId || p.id === projectId).flatMap((p) => p.tags);
		return [...new Set(tags)].map((tag) => ({ label: tag, value: tag }));
	};

	command("mission", "Open Mission Control on this project", async (_args, ctx) => {
		await refreshBoard();
		return openBoard(ctx, true);
	});

	command("task", "Start a task in a new worktree from this branch: its omp plans the prompt", async (prompt, ctx) => {
		if (!prompt) throw new Error("Say what to plan: /task <prompt>");
		return createdText(await createTask(ctx, { prompt }));
	});

	command("next", "Start a task that builds on this worktree's card: branches from it and waits for it", async (prompt, ctx) => {
		if (!prompt) throw new Error("Say what to plan: /next <prompt>");
		if (!task && !linkedWorktree(ctx.cwd)) throw new Error("Run /next in a worktree; /task starts independent work");
		const own = await ownCard(ctx);
		return createdText(await createTask(ctx, { prompt, after: own.id }), own.branch);
	});

	command(
		"link",
		"Make this worktree's card wait for other cards: /link #n…, /link none clears, /link lists",
		async (args, ctx) => {
			const own = await ownCard(ctx);
			if (!args) return own.dependsOn.length ? `${own.id} depends on ${own.dependsOn.join(", ")}${own.blockedBy.length ? ` · waits for ${own.blockedBy.join(", ")}` : " · all landed"}` : `${own.id} depends on nothing`;
			if (/^none$/i.test(args)) {
				await api("PATCH", `/api/tasks/${own.id}`, { dependsOn: [] });
				return `${own.id} no longer depends on any card`;
			}
			const deps = await addDependencies(own.id, await cardIds(args.split(/\s+/), ctx));
			return `${own.id} now depends on ${deps.join(", ")}`;
		},
		(prefix) => completeLast(prefix, [{ label: "none", value: "none", description: "Clear its links" }, ...cardItems()]),
	);

	command(
		"tag",
		"Tag this worktree's card: /tag a b adds, /tag -a removes, /tag lists",
		async (args, ctx) => {
			const own = await ownCard(ctx);
			if (!args) return own.tags.length ? `${own.id} tags: ${own.tags.join(", ")}` : `${own.id} has no tags`;
			const words = args.split(/\s+/);
			const drop = new Set(words.filter((w) => w.startsWith("-")).map((w) => w.slice(1).toLowerCase()));
			const tags = [...new Set([...own.tags, ...words.filter((w) => !w.startsWith("-"))])].filter((tag) => !drop.has(tag.toLowerCase()));
			const t = await api<Task>("PATCH", `/api/tasks/${own.id}`, { tags });
			return t.tags.length ? `${t.id} tags: ${t.tags.join(", ")}` : `${t.id} has no tags`;
		},
		(prefix) => completeLast(prefix, tagItems()),
	);

	command(
		"land",
		"Land this worktree's card: merge into its parent branch when stacked, else open a pull request (/land pr|merge forces one)",
		async (args, ctx) => {
			const how = args.toLowerCase();
			if (how && how !== "pr" && how !== "merge") throw new Error("Usage: /land [pr|merge]");
			return land(ctx, undefined, how ? (how as "pr" | "merge") : undefined);
		},
		(prefix) =>
			completeLast(prefix, [
				{ label: "merge", value: "merge", description: "Merge into its parent branch" },
				{ label: "pr", value: "pr", description: "Open a pull request" },
			]),
	);

	pi.on("before_agent_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub" || !task) return;
		serverCwd = ctx.cwd;
		const board = await api<Board>("GET", "/api/state", undefined, false).catch(() => latest);
		return { message: { customType: "mission-control.context", content: taskContext(task, board), display: false, attribution: "agent" } };
	});

	pi.on("plan_review_requested", (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		reviewOpen = true;
		if (task) void report(ctx, "plan_ready");
	});

	pi.on("plan_review_resolved", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		reviewOpen = false;
		if (!event.choice || event.choice === "save") void report(ctx, "idle");
		if (!task || !event.choice || !PLAN_APPROVALS[event.choice]) return;
		const id = task;
		void api<{ hold: boolean; waitingFor?: string[] }>("POST", `/api/tasks/${id}/planned`, {}, false).then(
			(r) => {
				if (!r.hold) return;
				holding = r.waitingFor?.length ? `waiting for ${r.waitingFor.join(", ")}` : "waiting for a free task slot";
				// "Approve and execute" runs the plan in a new session: its first turn is stopped in turn_start unless it already runs.
				const current = sessionCtx ?? ctx;
				if (!current.isIdle()) stopHeld(current);
			},
			(e) => ctx.ui.notify(`${taskNumber(id)}: the board didn't record the approved plan: ${errorText(e)}`, "warning"),
		);
	});

	// --- tools

	pi.registerTool({
		name: "mission_control_tasks",
		label: "Mission Control tasks",
		description:
			"List the Mission Control cards of this project: first the tags in use, then each open card with column, title, branch and base, tags, links (depends on, parent, children), what it waits for, agent state and pull request (number, state, checks, review, conflicts); then its done cards; then the project's other worktrees that have no card. all lists every project.",
		parameters: z.object({ all: z.boolean().optional() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				(async () => {
					const board = await api<Board>("GET", "/api/state");
					const project = sessionProject(board, ctx);
					const projects = params.all === true || !project ? board.projects : [project];
					return listTasks(board, projects, task ?? undefined);
				})(),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_task",
		label: "Mission Control task",
		description:
			"Start separate work in its own worktree: its omp plans the prompt and the user reviews that plan there. Use `after` (a card number) when it builds on a card: it branches from that card's branch and waits for it. Give one to three tags naming the product area, reusing `mission_control_tasks`' tags. Call it when the user asks for a task or to split work, never for work you do in this session.",
		parameters: z.object({
			prompt: z.string().min(1),
			title: z.string().optional(),
			tags: z.array(z.string()).optional(),
			after: z.string().optional(),
			base: z.string().optional(),
			controlSet: z.string().optional(),
		}),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				(async () => {
					const after = params.after?.trim() ? await cardId(params.after, ctx) : undefined;
					const t = await createTask(ctx, { ...params, after });
					return `Created ${createdText(t)}`;
				})(),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_adopt",
		label: "Mission Control adopt",
		description:
			"Track a linked git worktree (default: this checkout) as a Mission Control card, with an optional title and tags. Returns its card when it already has one. No agent starts until the card is moved to In Progress.",
		parameters: z.object({ path: z.string().optional(), title: z.string().optional(), tags: z.array(z.string()).optional() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				api<Task>("POST", "/api/worktrees/adopt", { ...params, path: params.path ?? checkoutRoot(ctx.cwd) }).then(
					(t) => `${t.id} ${t.title} · ${t.branch} from ${t.base} · ${t.column}`,
				),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_edit",
		label: "Mission Control edit",
		description:
			"Change a Mission Control card's title, replace its tags or dependencies ([] clears), or set its parent (a card of the same project, or \"none\" to clear it; it groups cards, use dependsOn for ordering, though a child also waits for its parent tree's dependencies). The prompt is fixed once the task exists: tell its agent with mission_control_message.",
		parameters: z.object({
			id: z.string(),
			title: z.string().optional(),
			tags: z.array(z.string()).optional(),
			dependsOn: z.array(z.string()).optional(),
			parent: z.string().optional(),
		}),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const fields = (["title", "tags", "dependsOn", "parent"] as const).filter((k) => params[k] !== undefined);
			if (!fields.length) return toolReply("Nothing to change: pass title, tags, dependsOn or parent", true);
			return answer(
				(async () => {
					const id = await cardId(params.id, ctx);
					const changes: Record<string, unknown> = {};
					if (params.title !== undefined) changes.title = params.title;
					if (params.tags !== undefined) changes.tags = params.tags;
					if (params.dependsOn !== undefined) changes.dependsOn = await cardIds(params.dependsOn, ctx);
					if (params.parent !== undefined) changes.parent = /^(none)?$/i.test(params.parent.trim()) ? null : await cardId(params.parent, ctx);
					const t = await api<Task>("PATCH", `/api/tasks/${id}`, changes);
					return `Updated ${id}: ${fields.map((k) => (k === "parent" ? (t.parent ? `parent ${t.parent}` : "parent cleared") : k === "tags" ? `tags ${t.tags.join(", ") || "none"}` : k)).join(", ")}`;
				})(),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_link",
		label: "Mission Control link",
		description:
			"Make a Mission Control card depend on other cards: once its plan is approved it waits until every open dependsOn card is done. A done card can be a dependency too: it doesn't block, and its recorded outcome goes into the card's brief.",
		parameters: z.object({ task: z.string(), dependsOn: z.array(z.string()).min(1) }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				(async () => {
					const id = await cardId(params.task, ctx);
					const deps = await addDependencies(id, await cardIds(params.dependsOn, ctx));
					return `${id} now depends on ${deps.join(", ")}`;
				})(),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_children",
		label: "Mission Control children",
		description: "Show a Mission Control card's hierarchy: its parent and its direct children, each with column and what it waits on.",
		parameters: z.object({ id: z.string() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				(async () => {
					const board = await api<Board>("GET", "/api/state");
					return childrenText(board, findTask(board, await cardId(params.id, ctx)));
				})(),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_move",
		label: "Mission Control move",
		description:
			"Move a Mission Control card as dragging it on the board does. waiting pauses its agent (worktree and session stay, it frees its task slot) until it's moved to doing (In Progress), which resumes it now; doing is refused while it waits for open dependencies unless force; doing also starts again a card whose start failed. done records it as done without merging. Other columns are reached on their own. Use it when the user asks to pause, hold, resume or finish a card.",
		parameters: z.object({ id: z.string(), column: z.enum(["waiting", "doing", "done"]), force: z.boolean().optional() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(moveCard(ctx, params.id, params.column, params.force === true));
		},
	});

	pi.registerTool({
		name: "mission_control_stop",
		label: "Mission Control stop",
		description:
			"Stop a Mission Control card's agent when the user asks: its omp session exits and its terminal closes, while its worktree, branch and session stay. A planning or In Progress card waits in Waiting until moved to In Progress, which reopens omp on the same session. To only pause it, use mission_control_move to waiting.",
		parameters: z.object({ id: z.string() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				(async () => {
					const id = await cardId(params.id, ctx);
					const t = await api<Task & { note?: string }>("POST", `/api/tasks/${id}/stop`, {});
					return `Stopped ${id}: its omp session ended; its worktree and branch ${t.branch} stay${t.column === "waiting" ? ", and it waits in Waiting" : ""}.${t.note ? ` ${t.note}.` : ""}`;
				})(),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_message",
		label: "Mission Control message",
		description:
			"Send a message to a Mission Control card's agent, as if typed in its omp: an idle agent starts a turn with it, a working one gets it at its next step. Refuses paused cards, disconnected agents, and agents waiting for plan review or an answer (the user answers in its terminal; mission_control_tasks shows how to reach it).",
		parameters: z.object({ id: z.string(), text: z.string() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				(async () => {
					const id = await cardId(params.id, ctx);
					const r = await api<{ message: string }>("POST", `/api/tasks/${id}/message`, { text: params.text });
					return `Sent to ${id}'s agent: ${r.message}`;
				})(),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_screen",
		label: "Mission Control screen",
		description: "Read the last lines of a Mission Control card's agent terminal: what it is doing, asking or showing now.",
		parameters: z.object({ id: z.string() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				(async () => {
					const id = await cardId(params.id, ctx);
					const r = await api<{ text: string }>("GET", `/api/tasks/${id}/screen`);
					return r.text || `${id}'s screen is empty`;
				})(),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_diff",
		label: "Mission Control diff",
		description: "Show a Mission Control card's changes against its base branch: the diffstat, then the diff (long diffs are cut).",
		parameters: z.object({ id: z.string() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				(async () => {
					const id = await cardId(params.id, ctx);
					const d = await api<{ base: string; stat: string; diff: string; truncated: boolean }>("GET", `/api/tasks/${id}/diff`);
					const cut = d.truncated || d.diff.length > DIFF_TOOL_LIMIT;
					const diff = d.diff.slice(0, DIFF_TOOL_LIMIT);
					return `${id} compared with ${d.base}\n${d.stat || "No changes"}${diff ? `\n\n${diff}` : ""}${cut ? "\n\n[diff cut; the board's Diff view shows all of it]" : ""}`;
				})(),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_context",
		label: "Mission Control context",
		description:
			"Read the shared context a Mission Control card recorded: reusable findings and its outcome, each with the source task, branch@commit and time, plus the revision. Without id, this session's own task. Use it for a dependency or sibling whose work yours builds on, or to see what changed since the revision your brief shows.",
		parameters: z.object({ id: z.string().optional() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				(async () => {
					const id = params.id ? await cardId(params.id, ctx) : task;
					if (!id) throw new Error("Name the card to read: this session has no task of its own");
					return contextText(await api<TaskContext>("GET", `/api/tasks/${id}/context`));
				})(),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_publish",
		label: "Mission Control publish",
		description:
			"Record shared context on a Mission Control card, stamped with the source task, its branch@commit and the time. kind finding: a concise, reusable fact other tasks need (a decision, contract, gotcha, where something lives). kind outcome: what this task delivered, where, and how dependents use it; record it before finishing. Cards that depend on it get the latest outcome and findings in their brief; any task reads them with mission_control_context. Not a log: no progress updates, transcripts or diffs. Without id, this session's own task.",
		parameters: z.object({ kind: z.enum(["finding", "outcome"]), text: z.string().min(1), id: z.string().optional() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				(async () => {
					const id = params.id ? await cardId(params.id, ctx) : task;
					if (!id) throw new Error("Name the card to record on: this session has no task of its own");
					const c = await api<TaskContext>("POST", `/api/tasks/${id}/context`, { kind: params.kind, text: params.text, source: task ?? "mission-control" });
					return `Recorded a ${params.kind} on ${id} (revision ${c.revision}, ${c.entries.length} entr${c.entries.length === 1 ? "y" : "ies"})`;
				})(),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_land",
		label: "Mission Control land",
		description:
			"Land a Mission Control card when the user says to merge, ship it or that it's done (that request is the approval; never because you judge the work finished). A card branched from another task's branch merges into that branch (committing pending changes); other cards get a pull request (its live agent is asked to commit, push and open it). how forces merge or pr. Without id, this session's own card: a merge then removes its worktree and ends this session. With another card's id, the user chooses whether to keep its worktree.",
		parameters: z.object({ id: z.string().optional(), how: z.enum(["merge", "pr"]).optional() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(land(ctx, params.id, params.how));
		},
	});

	pi.registerTool({
		name: "mission_control_cleanup",
		label: "Mission Control cleanup",
		description:
			"Remove a Mission Control card's worktree after the user confirms: deletes the worktree and its branch and ends its omp and terminal. A card that isn't done goes with it.",
		parameters: z.object({ id: z.string() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(cleanupCard(ctx, params.id));
		},
	});

	pi.registerTool({
		name: "mission_control_delete",
		label: "Mission Control delete",
		description: "Delete a Mission Control card after the user confirms; for a card with a worktree the user also chooses whether its worktree and branch go with it.",
		parameters: z.object({ id: z.string() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(deleteCard(ctx, params.id));
		},
	});
}
