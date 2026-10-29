// Orchestrator for omp: /orchestrator mode and commands, orchestrator_* tools, task mode and agent reports, a widget under the editor, and a board that starts itself.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as omp from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth, type AutocompleteItem } from "@oh-my-pi/pi-tui";
import { detectTerminalContext, openBoard as openTerminalBoard, type TerminalContext, type TerminalKind } from "omp-integrations/terminal";
import { isLightColor, resolveTheme, type Scheme, type ThemePalette } from "omp-integrations/theme";

const BASE = `http://127.0.0.1:${process.env.KANBOARD_PORT || "4747"}`;
const HOME = process.env.KANBOARD_HOME || join(homedir(), ".kanboard");
const PYTHON = process.env.KANBOARD_PYTHON || "python3";
const SERVER = join(dirname(realpathSync(import.meta.path)), "..", "server.py");
const SERVER_ROOT = dirname(SERVER);
const START_TIMEOUT_MS = 5000;
const RECONNECT_MS = 3000;
const MODE_FILE = "kanboard";
const STEP_MS = 2000;
const CLEANUP_ENTRY = "kanboard.cleanup";
const USAGE = "Orchestrator: /orchestrator on | off | status | open | start #n…|all | done [#n]";
const ORCHESTRATOR_COMMANDS: AutocompleteItem[] = [
	{ label: "on", value: "on", description: "Enable Orchestrator mode for this checkout" },
	{ label: "off", value: "off", description: "Disable Orchestrator mode for this checkout" },
	{ label: "status", value: "status", description: "Show this checkout's Orchestrator state" },
	{ label: "open", value: "open", description: "Open this checkout's board" },
	{ label: "start", value: "start", description: "Start cards by ID or start all queued cards" },
	{ label: "done", value: "done", description: "Commit pending changes and merge a task" },
];
const MERGE_REMOVE = "Merge and remove the worktree";
const MERGE_KEEP = "Merge and keep the worktree";
const DELETE_REMOVE = "Delete and remove the worktree";
const DELETE_KEEP = "Delete and keep the worktree";
const CANCEL = "Cancel";
const ORCHESTRATOR_CONTEXT = `Orchestrator mode is on in this checkout: this session manages the Orchestrator backlog of its flow. A card is a title and a description. Once started, it runs in its own git worktree branched from this checkout's branch. Auto cards let that task's omp quickly decide whether plan review is useful; Plan requires it and Fast implements directly.
- Work the board only through the orchestrator_* tools (orchestrator_tasks, orchestrator_plan, orchestrator_children, orchestrator_history, orchestrator_ready, orchestrator_create, orchestrator_edit, orchestrator_amend, orchestrator_link, orchestrator_start, orchestrator_move, orchestrator_message, orchestrator_review, orchestrator_stop, orchestrator_screen, orchestrator_diff, orchestrator_context, orchestrator_publish, orchestrator_memory, orchestrator_cleanup, orchestrator_done, orchestrator_delete). Never git merge a task's branch, create or remove its worktree, or call the board's HTTP API or bd by hand.
- When the user asks for a task (or several), first call orchestrator_tasks once for that flow. Compare the open card titles and dependencies; read orchestrator_plan only for a plausible same-subject card or prerequisite, then set dependsOn when that card must land first. Keep this preflight bounded: don't explore the repository and don't turn it into planning.
- Every card costs a worktree and a build, so group work by subject. An ask on the same subject as an open card (same screen, feature, component or bug area) that fits its branch without changing its direction goes to that card with orchestrator_amend, even when the card has started; don't create a card for it. If orchestrator_amend refuses because the card is done or its agent isn't running, create a new card; if the card is still starting, tell the user to retry shortly.
- Otherwise create cards right away with orchestrator_create. The card's omp owns implementation decisions when it starts. Read only what the user points you to when the description needs it (a ticket, a design). The description says what to build and why, what the user decided in this conversation, the acceptance and the links (ticket, design, files the user named), not how.
- After creating cards, or amending a Backlog card, call orchestrator_start for those card IDs when the user's wording commits to doing the work now. Bug reports, missing behavior and assertive requests to check, fix, add, change or implement something all count. Keep cards in Backlog for ideas, "maybe" or "later" requests, and while the user is still discussing or deciding. Started cards still wait for dependsOn and flow capacity.
- Leave planningMode as auto unless the user explicitly wants mandatory plan review or a fast direct implementation.
- Keep related asks from one request in one card. Split into several cards only when the parts are large and touch independent areas, when one must land before another, or when the user asks to split; each split card's description starts with the line "Part of: <the overall need in one line>". Set dependsOn for earlier new cards that must land first, as well as existing prerequisites found by the preflight.
- In the reply, say where each ask went: the card it was added to and whether its agent received it, the cards you created, and which cards you started or left in Backlog.
- For existing cards, an explicit "start", "do" or "run" KB-n is one trigger for orchestrator_start (it runs in its own worktree), not a request to implement it in this session unless the user says to do it here. Explicit wording is not required for new or amended cards that meet the intent rule above. "Merge KB-n" means orchestrator_done; "drop" or "delete KB-n" means orchestrator_delete; changing a card's title or description means orchestrator_edit. To replace or remove dependencies, pass the complete desired dependsOn list to orchestrator_edit; [] clears it.
- parent groups a card under another card of the same flow (an epic and its parts) when the user asks for that structure; it isn't a prerequisite, so use dependsOn for ordering, but children also inherit their parent's blockers under Beads readiness. Set it with orchestrator_create or orchestrator_edit (parent "none" clears it) and read the hierarchy with orchestrator_children.
- When the user asks why a card hasn't started or what can run next, call orchestrator_ready: it compares Beads' dependency readiness with the board's queue, pauses and task slots, and never starts anything. orchestrator_history shows how a card's title, description, plan and status changed.
- A started card's agent is yours to steer when the user asks. "Pause" or "hold" KB-n means orchestrator_move to Backlog, where it stays parked until resumed, or to Todo when it should continue on its own once its dependencies are done, any block inherited from its parent tree clears and a slot frees; "resume" or "continue" KB-n means orchestrator_move to doing (In Progress); "stop" KB-n means orchestrator_stop. Telling or asking its agent something means orchestrator_message; the user's verdict on its plan means orchestrator_review. Check what an agent shows with orchestrator_screen and its changes with orchestrator_diff before reporting on it.
- orchestrator_context reads the findings and outcome a card's agent recorded; a card that depends on it gets them in its brief. Record a decision from this conversation that a started card's agent and later cards need with orchestrator_publish on that card.
- orchestrator_memory holds this repository's durable project decisions and conventions, shared by every card. Search it on demand when a decision may already exist, and remember a durable decision the user made; task outcomes go on the card with orchestrator_publish. Never load all memories each turn, and never store the user's personal omp preferences there. Forgetting one asks the user first.
- A plan you propose in this session is for work done here; it doesn't become a card.`;

/** Plan review choices that approve; orchestrator_review picks the first enabled one, as Enter would. */
const APPROVALS: Record<string, true> = { execute: true, compact: true, keep: true };
const DIFF_TOOL_LIMIT = 60_000;
const SHARING =
	"Record a concise finding other tasks need (a decision, contract, gotcha, where something lives) with orchestrator_publish as you learn it, and your outcome (what changed, where, how dependents use it) once the work is committed, before finishing. Read what a dependency recorded, newer than your brief, with orchestrator_context. orchestrator_memory holds this repository's durable project decisions across all tasks: search it when a past decision may apply, and remember one only when it outlives this task; it's not for task outcomes, progress or the user's personal omp preferences, and it's never loaded in full.";
const HISTORY_FIELD_LIMIT = 800;
const MEMORY_EXCERPT = 300;
const MEMORY_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** A board command for a task session's agent; the session answers it at /api/control/<id>. */
interface Control {
	id: string;
	task: string;
	action: string;
	text?: string;
	decision?: "approve" | "refine";
	feedback?: string;
}

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

interface Task {
	id: string;
	title: string;
	description: string;
	column: string;
	branch: string;
	base: string;
	repo: string;
	checkout: string | null;
	flow: string;
	merge: "local" | "pr";
	planningMode: "auto" | "plan" | "fast";
	planningOutcome: "plan" | "fast" | null;
	dependsOn: string[];
	parent: string | null;
	children: string[];
	blockedBy: string[];
	waitingForSlot: boolean;
	paused: boolean;
	presentation: Presentation | null;
	attachCommand: string | null;
	session: { id: string | null; file: string | null; connected: boolean } | null;
	moveRequiresConfirmation: boolean;
	pendingUpdate: boolean;
	plan: string;
	ticket: string | null;
	worktree: string | null;
	origin: { session: string; terminal?: TerminalContext | null } | null;
	spawn: { state: string; error: string | null };
	agent: { state: string; step?: string | null } | null;
	git: { commits: number; added: number; removed: number; dirty: number } | null;
	pr: { state: string; number?: number } | null;
	merged: { into: string; sha: string } | null;
}

/** A task's shared context: the entries in its bead's notes, as GET/POST /api/tasks/<id>/context returns it. */
interface TaskContext {
	id: string;
	beadId: string;
	revision: string;
	updatedAt: string | null;
	entries: { kind: "finding" | "outcome" | "note"; at: string | null; source: string | null; ref: string | null; text: string }[];
}

/** A native Beads history entry: a commit snapshot of the bead, or with events an audit row. */
interface HistorySnapshot {
	CommitHash: string;
	Committer: string;
	CommitDate: string;
	Issue: Record<string, unknown>;
}

interface HistoryEvent {
	event_type: string;
	actor: string;
	old_value?: string | null;
	new_value?: string | null;
	comment?: string | null;
	created_at: string;
}

/** What POST /api/readiness returns: native bd ready --explain filtered to the board's scope, and the board's own view. */
interface Readiness {
	flow: string | null;
	native: {
		ready: { id: string; title: string; status?: string; reason?: string }[];
		blocked: { id: string; title: string; status?: string; blocked_by?: { id: string; title?: string; status?: string }[] }[];
		summary: { total_ready?: number; total_blocked?: number; cycle_count?: number } | null;
	};
	tasks: {
		id: string;
		title: string;
		column: string;
		queued: boolean;
		blockedBy: string[];
		waitingForSlot: boolean;
		paused: boolean;
		native: "ready" | "blocked" | null;
		nativeBlockedBy?: string[];
		reason: string;
	}[];
	disclaimer: string;
}

interface Memories {
	scope: string;
	memories: { key: string; text: string }[];
	truncated?: boolean;
}

interface Flow {
	id: string;
	base: string;
	checkout: string | null;
	concurrencyLimit: number | null;
}

interface Board {
	repo: { name: string; path: string; base: string; flow: string };
	flows: Flow[];
	columns: { id: string; title: string }[];
	tasks: Task[];
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
		readonly requiresConfirmation: string | null = null,
	) {
		super(message);
	}
}

/** Runs a board call that may refuse a task whose omp may still run in a legacy terminal: asks the user, then retries with confirmLegacy; `confirmed` is the user's earlier explicit yes. */
async function withLegacyConfirm<T>(ctx: ExtensionContext, id: string, call: (confirmLegacy: boolean) => Promise<T>, confirmed = false): Promise<T> {
	try {
		return await call(confirmed);
	} catch (e) {
		if (confirmed || !(e instanceof BoardError) || e.requiresConfirmation !== "legacySession") throw e;
		if (!ctx.hasUI) throw new Error(`${e.message}. Ask the user to confirm that the omp in ${id}'s old terminal has exited, then retry with confirmLegacy: true.`);
		const sure = await ctx.ui.confirm(
			`Has ${taskNumber(id)}'s old omp exited?`,
			`${e.message}.\n\nConfirm only once the omp that ran in its old terminal has exited: the board can't see that terminal.`,
		);
		if (!sure) throw new Error(`${id} unchanged: its old omp may still be running`);
		return call(true);
	}
}

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });

/** A card id from user or agent input: "#12", "kb-12", "12" mean KB-12 and "#12.1", "kb-12.1", "12.1" mean KB-12.1; other ids (Beads' native KB-a3f8.1) stay as given. */
function taskId(raw: string): string {
	const id = raw.trim().replace(/^#(?=\d)/, "");
	if (/^\d+(\.\d+)*$/.test(id)) return `KB-${id}`;
	return /^kb-\d+(\.\d+)*$/i.test(id) ? id.toUpperCase() : id;
}

/** A card id as people read it: KB-12.1 shows as #12.1; other ids stay as given. */
const taskNumber = (id: string) => (/^KB-\d+(\.\d+)*$/i.test(id) ? `#${id.slice(3)}` : id);

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

/** Runs server.py --prepare (the Beads workspace and any migration) to completion; rejects with its diagnostic. */
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
		throw new Error(`Orchestrator didn't start: ${errorText(e)}`);
	});
	if (output) appendFileSync(join(HOME, "server.log"), output);
	if (code !== 0) {
		const reason = stderr.trim().split("\n").pop() || `server.py --prepare exited with ${code}`;
		throw new Error(`Orchestrator can't start: ${reason}`);
	}
}

/** Prepares the board's Beads workspace, then starts server.py detached and waits for it to answer. */
async function launch(): Promise<void> {
	mkdirSync(HOME, { recursive: true });
	const env = { ...process.env };
	delete env.KANBOARD_TASK;
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
		if (spawned.error) throw new Error(`Orchestrator didn't start: ${spawned.error.message}`);
		if (await health()) return;
		await Bun.sleep(100);
	}
	throw new Error(`Orchestrator didn't start; see ${tilde(HOME)}/server.log`);
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
		try {
			process.kill(running.pid, "SIGTERM");
		} catch {
			// already gone
		}
		const deadline = Date.now() + START_TIMEOUT_MS;
		while (Date.now() < deadline && (await health())) await Bun.sleep(100);
		await launch();
	});
}

/** Calls the Orchestrator API, starting the board first when it is down (unless autostart is false); rejects with the board's error. */
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
		if (!autostart) throw new Error("Orchestrator isn't running");
		await exclusive(launch);
		try {
			res = await fetch(BASE + path, init);
		} catch {
			throw new Error(`Orchestrator didn't start; see ${tilde(HOME)}/server.log`);
		}
	}
	const data: unknown = await res.json().catch(() => null);
	if (!res.ok) {
		const error = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "";
		const confirm = data && typeof data === "object" && "requiresConfirmation" in data && typeof data.requiresConfirmation === "string" ? data.requiresConfirmation : null;
		throw new BoardError(res.status, error || `${res.status} ${res.statusText}`, confirm);
	}
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

/** The task whose worktree is the git checkout at cwd. */
function worktreeTask(board: Board, cwd: string): Task | undefined {
	const root = realpath(git(["rev-parse", "--show-toplevel"], cwd) || cwd);
	return root ? board.tasks.find((t) => t.worktree && realpath(t.worktree) === root) : undefined;
}

/** The file whose presence turns orchestrator mode on for the git checkout at cwd (in its git dir); null outside git. */
function modeFile(cwd: string): string | null {
	const gitDir = git(["rev-parse", "--absolute-git-dir"], cwd);
	return gitDir ? join(gitDir, MODE_FILE) : null;
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

const TERMINAL_OVERRIDES = ["KANBOARD_TERMINAL", "OMP_TERMINAL"];
let terminal: Promise<{ context: TerminalContext } | { error: string }> | undefined;

/** This omp's terminal context, detected and validated once; an unavailable KANBOARD_TERMINAL or OMP_TERMINAL is an error. */
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

// --- plans and listings -------------------------------------------------------------------------------------------

/** The cards of `flows` (every card with `all`), the first flow's first; `self` is marked as this task. */
function listTasks(board: Board, flows: string[], all: boolean, includeDone: boolean, self: string | undefined): string {
	const rank = (t: Task) => (t.flow === flows[0] ? 0 : flows.includes(t.flow) ? 1 : 2);
	const shown = board.tasks
		.filter((t) => (includeDone || t.column !== "done") && (all || flows.includes(t.flow)))
		.sort((a, b) => rank(a) - rank(b));
	const several = all || new Set(shown.map((t) => t.flow)).size > 1;
	const lines = shown.map((t) => {
		const column = board.columns.find((c) => c.id === t.column)?.title ?? t.column;
		let line = `${t.id} · ${column} · ${t.title} · ${t.branch} → ${t.base} (${t.merge})`;
		if (t.id === self) line += " · this task";
		if (t.dependsOn.length) line += ` · depends on ${t.dependsOn.join(", ")}`;
		if (t.parent) line += ` · child of ${t.parent}`;
		if (t.children.length) line += ` · ${t.children.length} child card${t.children.length === 1 ? "" : "s"}`;
		if (t.paused) line += t.column === "backlog" ? " · paused, parked" : " · paused";
		if (t.blockedBy.length) line += ` · waits until ${waitsUntil(t)}`;
		else if (t.waitingForSlot) line += " · waiting for a task slot";
		if (t.agent && t.agent.state !== "idle") line += ` · ${t.agent.state.replace("_", " ")}`;
		if (t.worktree && (t.presentation || t.attachCommand)) line += ` · reach it ${presentationText(t)}`;
		const route = t.planningOutcome ?? t.planningMode;
		line += ` · ${route === "fast" ? "fast path" : route === "plan" ? "plan review" : "auto triage"}`;
		if (t.plan.trim()) line += " · has a plan";
		if (t.ticket) line += ` · ticket ${t.ticket}`;
		if (several) line += ` · flow ${t.flow}`;
		return line;
	});
	const header = all
		? [`All flows: ${board.flows.map((f) => f.id).join(", ") || "none"}`]
		: flows.map((id) => {
				const checkout = board.flows.find((f) => f.id === id)?.checkout;
				return `Flow ${id}${checkout ? ` (${tilde(checkout)})` : ""}`;
			});
	return [...header, ...(lines.length ? lines : ["No tasks"])].join("\n");
}

/** Adds dependencies to a task, keeping the ones it has; returns the resulting list. */
async function addDependencies(id: string, deps: string[]): Promise<string[]> {
	const board = await api<Board>("GET", "/api/state");
	const t = board.tasks.find((x) => x.id === id);
	if (!t) throw new Error(`Unknown task ${id}`);
	const dependsOn = [...new Set([...t.dependsOn, ...deps])];
	await api("PATCH", `/api/tasks/${id}`, { dependsOn });
	return dependsOn;
}

function findTask(board: Board, id: string): Task {
	const t = board.tasks.find((x) => x.id === id);
	if (!t) throw new Error(`Unknown task ${id}`);
	return t;
}

function mergeSummary(t: Task): string {
	const commits = t.git?.commits ?? 0;
	const dirty = t.git?.dirty ?? 0;
	const pending = dirty ? `, ${dirty} uncommitted file${dirty === 1 ? "" : "s"} will be committed` : "";
	return `${commits} commit${commits === 1 ? "" : "s"} on ${t.branch}, +${t.git?.added ?? 0} \u2212${t.git?.removed ?? 0}${pending}`;
}

function taskContext(id: string, t: Task | null): string {
	if (!t) {
		return `This session implements Orchestrator task ${id}. Follow its planning mode: Auto briefly triages and plans only when a real decision or risk appears, Plan requires review before edits, and Fast acts directly. When the user says to merge, it's done, or ship it, call orchestrator_done: that request is the approval, so it merges without asking again and commits pending local-task changes. Never call it because you judge the work finished, or when "done" answers a different question you asked. List the other tasks with orchestrator_tasks and read one's description and plan with orchestrator_plan when your work touches it; don't do its part. ${SHARING}`;
	}
	const approach =
		t.planningMode === "plan"
			? "Plan this task and wait for review before editing."
			: t.planningMode === "fast"
				? "This is a Fast task: implement directly without plan review unless the user asks."
				: "Briefly triage this Auto task: implement directly when clear, but request plan review for a product decision, unclear acceptance, architecture, migration, or meaningful cross-cutting risk.";
	const lands =
		t.merge === "local"
			? `it lands in ${t.base} locally. When the user says to merge, "ok merge", it's done, or ship it, call orchestrator_done: that request is the approval, so it doesn't ask again. It commits pending changes, merges into ${t.base}, removes this worktree and ends this session and its terminal. Never call it because you judge the work finished, or when "done" answers a different question you asked.`
			: `it lands in ${t.base} via a pull request. When the user says to merge, it's done, or ship it: commit everything, push the branch and open a pull request into ${t.base}.`;
	return `${approach} Orchestrator task ${t.id} is ${t.title} on ${t.branch}; ${lands} Sibling tasks also merge into ${t.base}: list them with orchestrator_tasks and read one's description and plan with orchestrator_plan when your work touches it; don't do its part. ${SHARING}`;
}

/** Renders a task's shared context for a tool result, newest entries kept when it's long. */
function contextText(c: TaskContext): string {
	const head = `${c.id} (bead ${c.beadId}) · revision ${c.revision}${c.updatedAt ? ` · updated ${c.updatedAt}` : ""}`;
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

const columnTitle = (board: Board, column: string) => board.columns.find((c) => c.id === column)?.title ?? column;
const excerpt = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more characters]` : text);
const fieldText = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
const indent = (text: string) => text.replace(/^/gm, "    ");

/** What a card waits on: its own open dependencies must be done; a block inherited from its parent tree only has to clear. */
function waitsUntil(t: { dependsOn: string[]; blockedBy: string[] }): string {
	const own = t.blockedBy.filter((b) => t.dependsOn.includes(b));
	const inherited = t.blockedBy.filter((b) => !t.dependsOn.includes(b));
	return [
		own.length && `${own.join(", ")} ${own.length === 1 ? "is" : "are"} done`,
		inherited.length && `the block on its parent tree (${inherited.join(", ")}) clears`,
	]
		.filter(Boolean)
		.join(" and ");
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
	lines.push("Parent groups cards; use dependsOn for ordering. Children also inherit their parent's blockers under Beads readiness.");
	return lines.join("\n");
}

/** The bead fields history reports, by the name the board uses. */
const HISTORY_FIELDS: Record<string, string> = {
	title: "title",
	status: "status",
	description: "description",
	design: "plan",
	notes: "shared context",
	external_ref: "ticket",
	close_reason: "close reason",
	metadata: "board settings",
};

/** One field's change: short values inline, long ones as a bounded excerpt (only the appended part when text was appended). */
function fieldChange(label: string, before: string, after: string): string {
	if (!after) return `  ${label} cleared`;
	if (!/\n/.test(before + after) && before.length <= 120 && after.length <= 120) return `  ${label}: ${before || "(empty)"} → ${after}`;
	if (before && after.startsWith(before)) return `  ${label} appended:\n${indent(excerpt(after.slice(before.length).trim(), HISTORY_FIELD_LIMIT))}`;
	return `  ${label} ${before ? "changed" : "set"} (${before.length} → ${after.length} characters):\n${indent(excerpt(after, HISTORY_FIELD_LIMIT))}`;
}

function parseObject(text: string | null | undefined): Record<string, unknown> | null {
	try {
		const v: unknown = JSON.parse(text ?? "");
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function snapshotBlock(s: HistorySnapshot, prev: Record<string, unknown> | undefined): string {
	const issue = s.Issue ?? {};
	const head = `- ${s.CommitDate} · ${String(s.CommitHash).slice(0, 8)} by ${s.Committer}`;
	if (!prev) {
		const sizes = (["description", "design", "notes"] as const).map((k) => `${HISTORY_FIELDS[k]} ${fieldText(issue[k]).length} characters`);
		const plan = fieldText(issue.design);
		return `${head}\n  earliest shown: ${fieldText(issue.status)} · ${fieldText(issue.title)} · ${sizes.join(", ")}${plan ? `\n  plan:\n${indent(excerpt(plan, HISTORY_FIELD_LIMIT))}` : ""}`;
	}
	const changes = Object.entries(HISTORY_FIELDS)
		.filter(([k]) => fieldText(prev[k]) !== fieldText(issue[k]))
		.map(([k, label]) => fieldChange(label, fieldText(prev[k]), fieldText(issue[k])));
	return [head, ...(changes.length ? changes : ["  no change to its title, status, description, plan, shared context or ticket"])].join("\n");
}

function eventBlock(e: HistoryEvent): string {
	const lines = [`- ${e.created_at} · ${e.event_type.replace(/_/g, " ")} by ${e.actor}`];
	const after = parseObject(e.new_value);
	const before = parseObject(e.old_value);
	if (after) {
		for (const [k, v] of Object.entries(after)) lines.push(fieldChange(HISTORY_FIELDS[k] ?? k, fieldText(before?.[k]), fieldText(v)));
	} else if (e.new_value) lines.push(`  ${excerpt(e.new_value, HISTORY_FIELD_LIMIT)}`);
	if (e.comment) lines.push(`  comment: ${excerpt(e.comment, HISTORY_FIELD_LIMIT)}`);
	return lines.join("\n");
}

/** Renders native bd history (commit snapshots as field changes, or audit events), newest first, oldest dropped when long. */
function historyText(r: { id: string; history: unknown; events: boolean }): string {
	const list = Array.isArray(r.history) ? r.history : [];
	const kind = r.events ? "audit events" : "history";
	if (!list.length) return `${r.id}: no ${kind} recorded`;
	const blocks = r.events
		? (list as HistoryEvent[]).map(eventBlock)
		: (list as HistorySnapshot[]).map((s, i) => snapshotBlock(s, (list[i + 1] as HistorySnapshot | undefined)?.Issue));
	let shown = blocks.length;
	while (shown > 1 && blocks.slice(0, shown).join("\n").length > DIFF_TOOL_LIMIT) shown--;
	const cut = shown < blocks.length ? `\n[${blocks.length - shown} older entries not shown]` : "";
	return `${r.id} ${kind}, newest first (${list.length} entr${list.length === 1 ? "y" : "ies"}):\n${blocks.slice(0, shown).join("\n")}${cut}`;
}

/** Renders the board's queue state beside native Beads dependency readiness. */
function readinessText(board: Board, r: Readiness): string {
	const lines = [r.flow ? `Readiness of flow ${r.flow}` : "Readiness of every flow", "", "Board (what actually starts):"];
	for (const t of r.tasks) {
		const card = board.tasks.find((x) => x.id === t.id);
		const why =
			t.reason ||
			[
				t.paused && "paused",
				t.blockedBy.length && `waits until ${waitsUntil({ dependsOn: card?.dependsOn ?? [], blockedBy: t.blockedBy })}`,
				t.waitingForSlot && "waiting for a task slot",
				t.queued && "queued",
			]
				.filter(Boolean)
				.join(", ") ||
			"not queued";
		const native = !t.reason && t.native ? ` · Beads ${t.native}${t.nativeBlockedBy?.length ? ` by ${t.nativeBlockedBy.join(", ")}` : ""}` : "";
		lines.push(`- ${t.id} · ${columnTitle(board, t.column)} · ${t.title} · ${why}${native}`);
	}
	if (!r.tasks.length) lines.push("- no open cards in scope");
	lines.push("", "Beads dependencies (bd ready --explain):");
	for (const i of r.native.ready) lines.push(`- ready ${i.id} ${i.title}: ${i.reason ?? "no blocking dependencies"}`);
	for (const i of r.native.blocked) {
		const by = (i.blocked_by ?? []).map((b) => `${b.id}${b.status ? ` (${b.status})` : ""}`).join(", ");
		lines.push(`- blocked ${i.id} ${i.title}${by ? `: by ${by}` : ""}`);
	}
	if (!r.native.ready.length && !r.native.blocked.length) lines.push("- nothing open in scope");
	const cycles = r.native.summary?.cycle_count ?? 0;
	if (cycles) lines.push(`- ${cycles} dependency cycle${cycles === 1 ? "" : "s"}: those cards never become ready until one dependency is removed`);
	if (r.disclaimer) lines.push("", r.disclaimer);
	const text = lines.join("\n");
	return text.length > DIFF_TOOL_LIMIT ? `${text.slice(0, DIFF_TOOL_LIMIT)}\n[cut; name one card with id]` : text;
}

// --- omp theme ----------------------------------------------------------------------------------------------------

type Tone = "accent" | "muted" | "dim" | "success" | "warning" | "error";
type Glyph = "status.running" | "status.success" | "status.warning" | "status.error" | "status.pending" | "status.shadowed";
type Look = [Glyph, Tone, string];

/** The parts of omp's theme the widget paints with. */
interface Paint {
	fg(color: Tone, text: string): string;
	bold(text: string): string;
	symbol(key: Glyph): string;
	getSymbolPreset(): string;
}

// Undocumented omp exports, used as omp-git-diff-review does; without them the board keeps cmux's colors.
const themeApi =
	typeof omp.getNativeThemePalette === "function" && typeof omp.getCurrentThemeName === "function" && typeof omp.getThemeEpoch === "function";
const WIDGET = "orchestrator";
const BOARD_GLYPH: Record<string, string> = { nerd: "\uf502", unicode: "\u25a5", ascii: "[kb]" };
const COLUMN_TONE: Record<string, Tone> = { backlog: "dim", todo: "muted", doing: "accent", review: "success" };
const LISTED_RANK: Record<string, number> = { review: 0, doing: 1, todo: 2 };
const MAX_LISTED = 4;
const AGENT_LOOK: Record<string, Look> = {
	needs_input: ["status.warning", "warning", "needs input"],
	plan_ready: ["status.warning", "warning", "plan ready for review"],
	planning: ["status.running", "accent", "planning"],
	thinking: ["status.running", "accent", "thinking"],
	working: ["status.running", "accent", "working"],
	idle: ["status.shadowed", "muted", "idle"],
	disconnected: ["status.shadowed", "muted", "omp disconnected"],
	stopped: ["status.shadowed", "muted", "stopped"],
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

/** How an open card reads in the widget: its glyph, tone and state. */
function cardLook(t: Task): Look {
	if (t.spawn.state === "failed") return ["status.error", "error", "didn't start"];
	if (t.column === "review") return ["status.success", "success", t.pr ? "pull request open" : "ready to merge"];
	if (t.paused) {
		if (t.column === "todo" && t.blockedBy.length) return ["status.pending", "muted", `paused, resumes once ${waitsUntil(t)}`];
		return ["status.pending", "muted", t.column === "todo" && t.waitingForSlot ? "paused, waiting for a task slot" : "paused"];
	}
	if (t.column === "todo" && t.blockedBy.length) return ["status.pending", "muted", `starts once ${waitsUntil(t)}`];
	if (t.column === "todo" && t.waitingForSlot) return ["status.pending", "muted", "waiting for a task slot"];
	return (t.spawn.state !== "running" && t.agent && AGENT_LOOK[t.agent.state]) || ["status.running", "accent", "starting"];
}

/** The widget's lines: orchestrator mode's open cards of its flow, or task mode's own card. */
function widgetLines(p: Paint, board: Board | null, scope: { flow: string } | { task: string }): string[] {
	const icon = p.fg("accent", BOARD_GLYPH[p.getSymbolPreset()] ?? BOARD_GLYPH.unicode);
	const sep = p.fg("dim", " \u00b7 ");
	if ("task" in scope) {
		const head = ` ${icon} ${p.bold(p.fg("accent", taskNumber(scope.task)))}`;
		const t = board?.tasks.find((x) => x.id === scope.task);
		if (!t) return [head];
		const commits = t.git?.commits ?? 0;
		const work = commits
			? `${p.fg("muted", `${commits} commit${commits === 1 ? "" : "s"}`)} ${p.fg("success", `+${t.git?.added ?? 0}`)} ${p.fg("error", `\u2212${t.git?.removed ?? 0}`)}`
			: p.fg("dim", "no commits yet");
		const state = t.paused
			? `${sep}${p.fg("warning", "paused")}`
			: t.column === "review"
				? `${sep}${p.fg("success", t.pr ? "pull request open" : "ready to merge")}`
				: "";
		return [`${head} ${t.title.replace(CONTROL, " ")} ${p.fg("muted", `\u2192 ${t.base}`)}${sep}${work}${state}`];
	}
	const head = ` ${icon} ${p.bold(p.fg("accent", "Orchestrator"))}`;
	if (!board) return [head];
	const open = board.tasks.filter((t) => t.flow === scope.flow && t.column !== "done");
	const counts = board.columns.flatMap((c) => {
		const n = open.filter((t) => t.column === c.id).length;
		return n && COLUMN_TONE[c.id] ? [p.fg(COLUMN_TONE[c.id], `${n} ${c.title.toLowerCase()}`)] : [];
	});
	const listed = open.filter((t) => t.column in LISTED_RANK).sort((a, b) => LISTED_RANK[a.column] - LISTED_RANK[b.column]);
	const lines = listed.slice(0, MAX_LISTED).map((t) => {
		const [glyph, tone, state] = cardLook(t);
		return `   ${p.fg(tone, p.symbol(glyph))} ${p.bold(taskNumber(t.id))} ${t.title.replace(CONTROL, " ")}${sep}${p.fg(tone, state)}`;
	});
	if (listed.length > MAX_LISTED) lines.push(`   ${p.fg("dim", `+${listed.length - MAX_LISTED} more on the board`)}`);
	return [`${head}${sep}${counts.length ? counts.join(sep) : p.fg("dim", "no open cards")}`, ...lines];
}

/** omp's current theme as board colors (the mapping omp-git-diff-review uses); the board puts them over cmux's colors. */
function themeAppearance(): { scheme: Scheme; vars: Record<string, string> } | null {
	const palette: ThemePalette = omp.getNativeThemePalette();
	const theme = resolveTheme(palette, omp.getCurrentThemeName(), null);
	if (!theme) return null;
	const vars: Record<string, string> = {};
	for (const [name, token] of Object.entries(THEME_VARS)) {
		const value = theme.colors[token];
		if (value) vars[name] = value;
	}
	if (vars["--accent"]) vars["--accent-fg"] = isLightColor(vars["--accent"]) ? "#000000" : "#ffffff";
	return { scheme: theme.scheme, vars };
}

// --- extension ----------------------------------------------------------------------------------------------------

export default function orchestrator(pi: ExtensionAPI) {
	const z = pi.zod;
	let on = false;
	let flowId: string | null = null;
	let sessionId = "";
	let lastCard: string | null = null;
	let lastCleanup = true;
	let task: string | null = null;
	let taskInfo: Task | null = null;
	let taskLookup = false;
	let reporting: boolean | undefined;
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

	/** Shows the widget under the editor while orchestrator mode or task mode is on. */
	const showWidget = (ctx: ExtensionContext) => {
		if (!on && !task) return ctx.ui.setWidget(WIDGET, undefined);
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
							const scope = on ? { flow: flowId ?? latest?.repo.flow ?? "" } : { task: task ?? "" };
							rows = widgetLines(ui.theme, latest, scope).map((line) => truncateToWidth(line, w));
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

	/** Gives the board this session's omp theme for its flow, once per theme change. */
	const syncTheme = () => {
		if (!themeApi || !on || !flowId) return;
		const epoch: number = omp.getThemeEpoch();
		if (epoch === themeEpoch) return;
		themeEpoch = epoch;
		const look = themeAppearance();
		if (look) void api("POST", "/api/appearance", { flow: flowId, ...look }, false).catch(() => {});
	};

	/** The flow this session works in: the one /orchestrator on registered, else its task's, else its checkout's. */
	const sessionFlow = (board: Board, ctx: ExtensionContext): string => {
		if (flowId) return flowId;
		const own = task ? board.tasks.find((t) => t.id === task) : undefined;
		if (own) return own.flow;
		const root = realpath(git(["rev-parse", "--show-toplevel"], ctx.cwd) || ctx.cwd);
		return board.flows.find((f) => f.checkout && realpath(f.checkout) === root)?.id ?? board.repo.flow;
	};

	const tell = async (ctx: ExtensionContext, work: Promise<string>) => {
		try {
			ctx.ui.notify(await work, "info");
		} catch (e) {
			ctx.ui.notify(errorText(e), "error");
		}
	};

	const answer = async (work: Promise<string>) => {
		try {
			return reply(await work);
		} catch (e) {
			return reply(errorText(e), true);
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
			api("POST", "/api/agent", { path, task: task ?? process.env.KANBOARD_TASK ?? null, state, step, sessionId, sessionFile, message: lastMessage }, false).then(
				() => {},
				(e) => {
					if (e instanceof BoardError && e.status === 404) reporting = false;
					else reported = "";
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
		reporting ??= Boolean(process.env.KANBOARD_TASK) || linkedWorktree(ctx.cwd);
		if (!reporting) return reports;
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

	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		if ("prompt" in event && typeof event.prompt === "string") lastMessage = event.prompt.slice(0, 2000);
	});
	pi.on("turn_start", (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		planning = inPlanMode(ctx);
		void report(ctx, planning ? "planning" : "thinking");
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		void report(ctx, event.toolName === "ask" ? "needs_input" : planning ? "planning" : "working", stepText(event));
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.agent?.kind !== "sub" && event.toolName === "ask") void report(ctx, planning ? "planning" : "working");
	});
	pi.on("agent_end", (event, ctx) => {
		if (ctx.agent?.kind === "sub" || ("willContinue" in event && event.willContinue === true)) return;
		void report(ctx, reviewOpen ? "plan_ready" : "idle");
	});

	// --- event stream

	const watch = (ctx: ExtensionContext, board: Board) => {
		const next = new Map<string, Task>();
		for (const t of board.tasks) {
			if (!(on && t.flow === flowId) && t.origin?.session !== sessionId) continue;
			const before = seen?.get(t.id);
			next.set(t.id, !t.agent && before?.agent ? { ...t, agent: before.agent } : t);
			if (!before) continue;
			if (t.spawn.state === "failed" && before.spawn.state !== "failed") {
				ctx.ui.notify(`${taskNumber(t.id)} didn't start: ${t.spawn.error ?? "unknown error"}`, "error");
			}
			if (t.agent?.state === "needs_input" && before.agent?.state !== "needs_input") {
				ctx.ui.notify(`${taskNumber(t.id)} needs your input ${presentationText(t)}`, "warning");
			}
			if (t.agent?.state === "plan_ready" && before.agent?.state !== "plan_ready") {
				ctx.ui.notify(`${taskNumber(t.id)}'s plan is ready: review it on the board or ${presentationText(t)}`, "warning");
			}
			if (t.column === "review" && before.column !== "review" && t.merge === "local" && !t.pr) {
				ctx.ui.notify(`${taskNumber(t.id)} is ready to merge: /orchestrator done ${taskNumber(t.id)}`, "info");
			}
			if (t.pr?.state === "merged" && before.pr?.state !== "merged") {
				ctx.ui.notify(`${taskNumber(t.id)}: its pull request was merged into ${t.base}`, "info");
			} else if (t.merged && !before.merged) {
				ctx.ui.notify(`${taskNumber(t.id)} merged into ${t.merged.into} (${t.merged.sha.slice(0, 7)})`, "info");
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
		let ok = true;
		let message: string;
		try {
			const review = ctx.getPendingPlanReview();
			if (c.action === "pause") {
				const running = !ctx.isIdle();
				if (running) ctx.abort();
				void report(ctx, review ? "plan_ready" : "idle");
				message = running ? "Interrupted its turn" : "It was idle";
				ctx.ui.notify(`Orchestrator paused ${taskNumber(c.task)}; moving its card back to In Progress resumes it`, "warning");
			} else if (c.action === "resume") {
				if (review) message = "Its plan is waiting for review";
				else if (!ctx.isIdle()) message = "It was already working";
				else {
					pi.sendUserMessage(c.text ?? "");
					message = "Resumed";
				}
				ctx.ui.notify(`Orchestrator resumed ${taskNumber(c.task)}`, "info");
			} else if (c.action === "message") {
				if (review) {
					ok = false;
					message = "Its plan is waiting for review: approve or refine it";
				} else {
					const idle = ctx.isIdle();
					pi.sendUserMessage(c.text ?? "");
					message = idle ? "It started a turn with it" : "It gets it at its next step";
				}
			} else if (c.action === "review") {
				if (!review) {
					ok = false;
					message = "No plan review is open";
				} else if (c.decision === "refine") {
					ok = ctx.resolvePlanReview(review.reviewId, "refine", { feedback: c.feedback });
					message = ok ? "Sent the feedback; it plans again" : "omp didn't take the feedback";
				} else {
					const choice = review.options.find((o) => !o.disabled && APPROVALS[o.id]);
					ok = choice !== undefined && ctx.resolvePlanReview(review.reviewId, choice.id);
					message = ok && choice ? `Approved its plan (${choice.label})` : "Its plan review took no approval";
				}
			} else if (c.action === "stop") {
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
				watch(ctx, latest);
				repaint?.();
			} else if (e.event === "task_prompt" && on && !task && data && typeof data === "object" &&
				"id" in data && typeof data.id === "string" && "text" in data && typeof data.text === "string") {
				try {
					if (ctx.getPendingPlanReview()) throw new Error("The main agent is waiting for plan review; answer it first");
					pi.sendUserMessage(data.text);
					void answerControl(data.id, true, "Sent to the main agent");
				} catch (error) {
					void answerControl(data.id, false, errorText(error));
				}
			} else if (e.event === "discuss" && data && typeof data === "object" && "id" in data && typeof data.id === "string") {
				const id = taskId(data.id);
				if (ctx.hasUI) ctx.ui.pasteToEditor(`${id} `);
				ctx.ui.notify(`${taskNumber(id)}: say what to change; omp updates the card`, "info");
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

	/** Keeps one event stream open while orchestrator mode or task mode is on; never starts the board. In orchestrator mode each connect (re)registers the checkout's flow. */
	const syncStream = (ctx: ExtensionContext) => {
		if (!on && !task) return stopStream();
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
					if (on) {
						flowId = await api<{ flow: Flow }>("POST", "/api/flows", { path: cwd }, false).then(
							(r) => r.flow.id,
							(e) => {
								if (e instanceof BoardError) return null;
								throw e;
							},
						);
						if (flowId) query.set("flow", flowId);
					}
					const where = await callerTerminal();
					if ("context" in where) query.set("terminal", JSON.stringify(where.context));
					else if (!terminalWarned) {
						terminalWarned = true;
						ctx.ui.notify(`Orchestrator: ${where.error}`, "warning");
					}
					const res = await fetch(`${BASE}/api/events?${query}`, { signal: ctl.signal });
					if (res.ok && res.body) {
						themeEpoch = null;
						syncTheme();
						if (current) {
							reported = "";
							void report(ctx, current, currentStep);
						}
						for await (const e of serverEvents(res.body)) onEvent(ctx, e);
					} else await res.body?.cancel();
				} catch {
					// reconnects below
				}
				if (!ctl.signal.aborted) await Bun.sleep(RECONNECT_MS);
			}
		})();
	};

	// --- session state

	const setMode = (ctx: ExtensionContext, value: boolean) => {
		on = value;
		const file = modeFile(ctx.cwd);
		if (file && value) writeFileSync(file, "on\n");
		else if (file) rmSync(file, { force: true });
		if (!value) flowId = null;
		showWidget(ctx);
		stopStream();
		syncStream(ctx);
		themeEpoch = null;
		syncTheme();
	};

	/** Task mode: KANBOARD_TASK, else a board task whose worktree is this checkout (asked once; never starts the board). */
	const detectTask = async (ctx: ExtensionContext) => {
		const env = process.env.KANBOARD_TASK;
		if (!env && !linkedWorktree(ctx.cwd)) return;
		try {
			const board = await api<Board>("GET", "/api/state", undefined, false);
			taskInfo = (env ? board.tasks.find((t) => t.id === env) : worktreeTask(board, ctx.cwd)) ?? null;
		} catch {
			taskInfo = null;
		}
		task = env || taskInfo?.id || null;
		if (!task) return;
		showWidget(ctx);
		stopStream();
		syncStream(ctx);
	};

	const restore = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.agent?.kind === "sub") return;
		serverCwd = ctx.cwd;
		sessionId = ctx.sessionManager.getSessionId();
		sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		const file = modeFile(ctx.cwd);
		on = file !== null && existsSync(file);
		if (!on) flowId = null;
		lastCleanup = true;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CLEANUP_ENTRY) lastCleanup = entry.data?.cleanup !== false;
		}
		showWidget(ctx);
		stopStream();
		syncStream(ctx);
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
		stopStream();
		await report(ctx, "idle");
	});

	// --- cards

	const startCards = async (ctx: ExtensionContext, raw: string[]): Promise<string> => {
		const board = await api<Board>("GET", "/api/state");
		let ids = raw.map(taskId);
		if (ids.length === 1 && ids[0].toUpperCase() === "ALL") {
			const flow = sessionFlow(board, ctx);
			ids = board.tasks.filter((t) => t.column === "backlog" && t.flow === flow && t.origin?.session === sessionId).map((t) => t.id);
			if (!ids.length) return "No backlog cards from this session to start";
		}
		if (!ids.length) throw new Error("Name the cards to start (#n…, or all)");
		const lines: string[] = [];
		for (const id of ids) {
			try {
				const before = findTask(board, id);
				const parked = before.paused && before.column === "backlog";
				if (!parked && (before.worktree || (before.column !== "backlog" && before.spawn.state !== "failed"))) {
					lines.push(`${id} is already ${before.column === "todo" ? "queued" : `in ${board.columns.find((c) => c.id === before.column)?.title ?? before.column}`}`);
					continue;
				}
				const t = await api<Task>("POST", `/api/tasks/${id}/move`, { column: "todo" });
				const verb = parked ? "resumes" : "starts";
				lines.push(
					t.blockedBy.length
						? `${id} queued: it ${verb} on its own once ${waitsUntil(t)}`
						: t.waitingForSlot
							? `${id} queued: it ${verb} when another task leaves In Progress`
							: `${id} ${parked ? "resuming" : "starting"}`,
				);
			} catch (e) {
				lines.push(`${id}: ${errorText(e)}`);
			}
		}
		return lines.join("\n");
	};

	/** Commits pending changes and merges a local task: this worktree's task without an id (removing it), else the given card with a cleanup choice. */
	const done = async (ctx: ExtensionContext, raw?: string): Promise<string> => {
		const named = raw?.trim() ? taskId(raw) : undefined;
		if (!ctx.hasUI) throw new Error(`Merging needs the user's confirmation: ask them to run /orchestrator done${named ? ` ${named}` : ""}`);
		await refreshBoard();
		const board = await api<Board>("GET", "/api/state");
		const own = task ? board.tasks.find((t) => t.id === task) : worktreeTask(board, ctx.cwd);
		const id = named ?? own?.id;
		if (!id) throw new Error("This directory isn't an Orchestrator task worktree: name the task to merge (/orchestrator done #n)");
		const t = findTask(board, id);
		if (t.merge !== "local") throw new Error(`${id} merges via a pull request: push the branch and open one`);
		if (t.merged) throw new Error(`${id} is already merged into ${t.merged.into}`);
		if (!t.worktree) throw new Error(`${id} hasn't started, so there is nothing to merge`);
		let cleanup: boolean;
		if (own?.id === id) {
			cleanup = true;
		} else {
			const options = lastCleanup ? [MERGE_REMOVE, MERGE_KEEP, CANCEL] : [MERGE_KEEP, MERGE_REMOVE, CANCEL];
			const pick = await ctx.ui.select(`Merge ${taskNumber(t.id)} into ${t.base}? ${mergeSummary(t)}`, options);
			if (pick !== MERGE_REMOVE && pick !== MERGE_KEEP) return "Merge cancelled";
			cleanup = pick === MERGE_REMOVE;
			if (cleanup !== lastCleanup) {
				lastCleanup = cleanup;
				pi.appendEntry(CLEANUP_ENTRY, { cleanup });
			}
		}
		const r = await api<{ output: string; cleanupError?: string }>("POST", `/api/tasks/${id}/merge`, { cleanup, commit: true });
		return r.cleanupError ? `${r.output}\n${r.cleanupError}` : r.output;
	};

	const deleteCard = async (ctx: ExtensionContext, raw: string): Promise<string> => {
		const id = taskId(raw);
		if (!ctx.hasUI) throw new Error(`Deleting needs the user's confirmation: ask them to delete ${id} on the board`);
		const board = await api<Board>("GET", "/api/state");
		const t = findTask(board, id);
		const column = board.columns.find((c) => c.id === t.column)?.title ?? t.column;
		const dependents = board.tasks.filter((o) => o.column !== "done" && o.dependsOn.includes(id)).map((o) => o.id);
		const links = [
			t.children.length && `${t.children.join(", ")} lose${t.children.length === 1 ? "s" : ""} its parent`,
			dependents.length && `${dependents.join(", ")} no longer wait${dependents.length === 1 ? "s" : ""} for it and may start`,
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
		} else {
			const detail = t.moveRequiresConfirmation
				? `It may still be working. Deleting it removes board tracking, but omp, its worktree and branch keep running.`
				: "Its plan is deleted with it.";
			if (!(await ctx.ui.confirm(`Delete ${taskNumber(id)}?`, `${t.title} (${column})\n\n${detail}${unlinks}`))) return `${id} kept`;
		}
		const r = await withLegacyConfirm(ctx, id, (confirmLegacy) =>
			api<{ output?: string }>("DELETE", `/api/tasks/${id}`, { confirmWorking: t.moveRequiresConfirmation, cleanup, confirmLegacy }),
		);
		return r.output ? `Deleted ${id}\n${r.output}` : `Deleted ${id}`;
	};

	/** Moves a card as dragging it on the board does; the reply says what that did to its agent. */
	const moveCard = async (ctx: ExtensionContext, raw: string, column: string, force: boolean, confirmed: boolean): Promise<string> => {
		const id = taskId(raw);
		const board = await api<Board>("GET", "/api/state");
		const before = findTask(board, id);
		const t = await withLegacyConfirm(
			ctx,
			id,
			(confirmLegacy) => api<Task & { note?: string }>("POST", `/api/tasks/${id}/move`, { column, confirmWorking: true, force, confirmLegacy }),
			confirmed,
		);
		const title = (c: string) => board.columns.find((x) => x.id === c)?.title ?? c;
		const waits = t.blockedBy.length
			? `once ${waitsUntil(t)}`
			: t.waitingForSlot
				? "when a task slot frees"
				: "";
		const resumes =
			t.column === "backlog"
				? "it stays parked in Backlog until moved to Todo or In Progress"
				: `it resumes on its own ${waits || "once it's first in Todo with a free task slot"}`;
		if (t.paused && !before.paused) return `Paused ${id} in ${title(t.column)}: ${t.note ?? "its agent stopped"}. Its worktree and session stay; ${resumes}.`;
		if (t.paused) return `${id} stays paused in ${title(t.column)}; ${resumes}.`;
		if (before.paused && t.column === "doing") {
			return `Resumed ${id}: its agent continues${before.session?.connected ? "" : " once omp reopens on its session"}.`;
		}
		if (!before.worktree && t.spawn.state === "running") return `${id} starting`;
		if (!before.worktree && t.column === "todo" && waits) return `${id} queued: it starts ${waits}`;
		return `Moved ${id} to ${title(t.column)}`;
	};

	const cleanupCard = async (ctx: ExtensionContext, raw: string): Promise<string> => {
		const id = taskId(raw);
		if (!ctx.hasUI) throw new Error(`Removing a worktree needs the user's confirmation: ask them to remove ${id}'s on the board`);
		const t = findTask(await api<Board>("GET", "/api/state"), id);
		if (!t.worktree) throw new Error(`${id} has no worktree`);
		const sure = await ctx.ui.confirm(
			`Remove ${taskNumber(id)}'s worktree?`,
			`Deletes ${tilde(t.worktree)} and the branch ${t.branch}, ending its omp and terminal. The card stays.`,
		);
		if (!sure) return `${id}'s worktree kept`;
		const done = await withLegacyConfirm(ctx, id, (confirmLegacy) => api<{ output: string }>("POST", `/api/tasks/${id}/cleanup`, { confirmLegacy }));
		return done.output;
	};

	/** Runs one repository-scoped shared-memory action; forget shows the memory and asks the user first. */
	const memory = async (
		ctx: ExtensionContext,
		params: { action: "search" | "read" | "remember" | "forget"; query?: string; key?: string; text?: string },
	): Promise<string> => {
		const key = params.key?.trim() ?? "";
		const query = params.query?.trim() ?? "";
		const text = params.text?.trim() ?? "";
		if (query.length > 200) throw new Error("query is limited to 200 characters");
		if (params.action !== "search" && !key) throw new Error(`${params.action} needs the memory's key`);
		if (key && !MEMORY_KEY.test(key)) throw new Error("A key is 1–80 letters, digits, dots, dashes or underscores, starting with a letter or digit");
		if (params.action === "remember" && !text) throw new Error("remember needs the text to keep");
		if (text.length > 4000) throw new Error("A memory is limited to 4000 characters: keep only the durable decision");
		const call = (body: Record<string, string>) => api<Memories>("POST", "/api/memories", { repo: ctx.cwd, ...body });
		if (params.action === "search") {
			const r = await call(query ? { action: "search", query } : { action: "search" });
			const scope = tilde(r.scope);
			if (!r.memories.length) return `No memories in ${scope}${query ? ` match "${query}"` : ""}`;
			const n = r.memories.length;
			const lines = r.memories.map((m) => `- ${m.key}: ${excerpt(m.text.replace(/\s+/g, " ").trim(), MEMORY_EXCERPT)}`);
			const cut = r.truncated ? "\n[more memories not shown: narrow the query, or read one by key]" : "";
			return `${n} memor${n === 1 ? "y" : "ies"} in ${scope}${query ? ` matching "${query}"` : ""} (read one by key for its full text):\n${lines.join("\n")}${cut}`;
		}
		if (params.action === "remember") {
			const r = await call({ action: "remember", key, text });
			return `Remembered ${key} for ${tilde(r.scope)} (replacing any memory with that key)`;
		}
		const current = await call({ action: "read", key });
		const m = current.memories.find((x) => x.key === key) ?? current.memories[0];
		if (!m) throw new Error(`No memory ${key} in ${tilde(current.scope)}`);
		if (params.action === "read") return `${m.key} (${tilde(current.scope)})\n\n${m.text}${current.truncated ? "\n\n[cut at the read limit]" : ""}`;
		if (!ctx.hasUI) throw new Error(`Forgetting ${key} needs the user's confirmation, which this session can't ask for`);
		const sure = await ctx.ui.confirm(`Forget ${key}?`, `${excerpt(m.text, 1000)}\n\nEvery task in ${tilde(current.scope)} loses this memory.`);
		if (!sure) return `${key} kept`;
		const r = await call({ action: "forget", key });
		return `Forgot ${key} in ${tilde(r.scope)}`;
	};

	/** Shows the board on the session's flow: this worktree's task when it belongs to it, else the session's last card. */
	const openBoard = async (ctx: ExtensionContext, focus: boolean) => {
		const board = await api<Board>("GET", "/api/state");
		const flow = sessionFlow(board, ctx);
		const own = worktreeTask(board, ctx.cwd);
		const card = own?.flow === flow ? own.id : (lastCard ?? undefined);
		await showBoard(`${BASE}/?flow=${encodeURIComponent(flow)}${card ? `#${card}` : ""}`, focus);
	};

	pi.registerCommand("orchestrator", {
		description: USAGE,
		getArgumentCompletions(argumentPrefix) {
			const normalized = argumentPrefix.trimStart().toLowerCase();
			if (/\s/.test(normalized)) return null;
			if (!normalized) return ORCHESTRATOR_COMMANDS;
			const matches = ORCHESTRATOR_COMMANDS.filter(command => command.value.startsWith(normalized));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			if (ctx.agent?.kind === "sub") return;
			serverCwd = ctx.cwd;
			const [verb = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const arg = verb.toLowerCase();
			try {
				if (arg === "on" || (!arg && !on)) {
					await refreshBoard();
					const r = await api<{ flow: Flow }>("POST", "/api/flows", { path: ctx.cwd });
					flowId = r.flow.id;
					setMode(ctx, true);
					await openBoard(ctx, false);
					ctx.ui.notify(`Orchestrator mode on for ${tilde(r.flow.checkout ?? ctx.cwd)}: cards go to ${flowId}, merging into ${r.flow.base}`, "info");
				} else if (arg === "off" || !arg) {
					setMode(ctx, false);
					ctx.ui.notify("Orchestrator mode off for this checkout", "info");
				} else if (arg === "status") {
					const parts = [`Orchestrator mode is ${on ? "on" : "off"} for this checkout`];
					if (flowId) parts.push(`flow ${flowId}`);
					if (task) parts.push(`task ${taskNumber(task)}`);
					ctx.ui.notify(parts.join(" · "), "info");
				} else if (arg === "open") {
					await refreshBoard();
					await openBoard(ctx, true);
				} else if (arg === "start") {
					await tell(ctx, startCards(ctx, rest));
				} else if (arg === "done") {
					await tell(ctx, done(ctx, rest[0]));
				} else {
					ctx.ui.notify(USAGE, "warning");
				}
			} catch (e) {
				ctx.ui.notify(errorText(e), "error");
			}
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		serverCwd = ctx.cwd;
		const parts: string[] = [];
		if (task) {
			const id = task;
			taskInfo = await api<Board>("GET", "/api/state", undefined, false).then(
				(board) => board.tasks.find((t) => t.id === id) ?? taskInfo,
				() => taskInfo,
			);
			parts.push(taskContext(id, taskInfo));
		}
		if (on) parts.push(ORCHESTRATOR_CONTEXT);
		if (!parts.length) return;
		return { message: { customType: "kanboard.context", content: parts.join("\n\n"), display: false, attribution: "agent" } };
	});

	pi.on("plan_review_requested", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		reviewOpen = true;
		if (!task) return;
		const id = task;
		void report(ctx, "plan_ready");
		void api("PATCH", `/api/tasks/${id}`, { plan: event.planContent }, false).catch((e) =>
			ctx.ui.notify(`${taskNumber(id)}: the plan didn't reach the board: ${errorText(e)}`, "warning"),
		);
	});

	pi.on("plan_review_resolved", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		reviewOpen = false;
		if (!event.choice || event.choice === "save") void report(ctx, "idle");
	});

	// --- tools

	pi.registerTool({
		name: "orchestrator_tasks",
		label: "Orchestrator tasks",
		description:
			"List the Orchestrator cards of this checkout's flow (in a task session, its sibling tasks first): column, title, branch, base and merge mode, planning route, dependencies, parent and child count, agent state and whether it has a plan. all lists every flow; done cards only with includeDone.",
		parameters: z.object({ all: z.boolean().optional(), includeDone: z.boolean().optional() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				(async () => {
					const board = await api<Board>("GET", "/api/state");
					const own = task ? board.tasks.find((t) => t.id === task) : undefined;
					const flows = [...new Set([own?.flow, on || !own ? sessionFlow(board, ctx) : undefined].filter((f): f is string => Boolean(f)))];
					return listTasks(board, flows, params.all === true, params.includeDone === true, own?.id);
				})(),
			);
		},
	});

	pi.registerTool({
		name: "orchestrator_plan",
		label: "Orchestrator plan",
		description: "Read an Orchestrator card by id (e.g. KB-3): its description, planning mode, parent and children, and plan when it has one.",
		parameters: z.object({ id: z.string() }),
		approval: "read",
		async execute(_toolCallId, params) {
			return answer(
				(async () => {
					const t = findTask(await api<Board>("GET", "/api/state"), taskId(params.id));
					const plan = t.plan.trim() ? `## Plan\n\n${t.plan.trim()}` : "No plan: Auto and Fast tasks may implement without plan review.";
					const family = [t.parent && `Parent: ${t.parent}`, t.children.length && `Children: ${t.children.join(", ")}`].filter(Boolean).join("\n");
					return `${t.id}: ${t.title}\nPlanning: ${t.planningOutcome ?? t.planningMode}${family ? `\n${family}` : ""}\n\n${t.description.trim() || "(no description)"}\n\n${plan}`;
				})(),
			);
		},
	});

	pi.registerTool({
		name: "orchestrator_children",
		label: "Orchestrator children",
		description:
			"Show an Orchestrator card's hierarchy: its parent and its direct children, each with column and what it waits on. Parent groups cards; use dependsOn for ordering; children also inherit their parent's blockers under Beads readiness.",
		parameters: z.object({ id: z.string() }),
		approval: "read",
		async execute(_toolCallId, params) {
			return answer(
				(async () => {
					const board = await api<Board>("GET", "/api/state");
					return childrenText(board, findTask(board, taskId(params.id)));
				})(),
			);
		},
	});

	pi.registerTool({
		name: "orchestrator_history",
		label: "Orchestrator history",
		description:
			"Show an Orchestrator card's native Beads history, newest first: each recorded change to its title, status, description, plan, shared context or ticket, with long text cut. events shows the audit trail (who changed what, and when) instead of snapshots. limit is 1 to 50 entries (default 10).",
		parameters: z.object({ id: z.string(), limit: z.number().int().min(1).max(50).optional(), events: z.boolean().optional() }),
		approval: "read",
		async execute(_toolCallId, params) {
			const id = taskId(params.id);
			return answer(
				api<{ id: string; history: unknown; events: boolean }>("POST", `/api/tasks/${id}/history`, {
					limit: params.limit ?? 10,
					events: params.events === true,
				}).then(historyText),
			);
		},
	});

	pi.registerTool({
		name: "orchestrator_ready",
		label: "Orchestrator ready",
		description:
			"Explain readiness without changing anything: for this checkout's flow (one card with id, every flow with all), what the board will start and why cards wait (dependencies, pause, task slots, still in Backlog), next to Beads' own dependency readiness. Beads calling a card ready doesn't start or queue it; only orchestrator_start does.",
		parameters: z.object({ id: z.string().optional(), all: z.boolean().optional() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.id && params.all) return reply("Pass id or all, not both", true);
			return answer(
				(async () => {
					const board = await api<Board>("GET", "/api/state");
					const scope = params.id ? { id: taskId(params.id) } : params.all ? {} : { flow: sessionFlow(board, ctx) };
					return readinessText(board, await api<Readiness>("POST", "/api/readiness", scope));
				})(),
			);
		},
	});

	pi.registerTool({
		name: "orchestrator_link",
		label: "Orchestrator link",
		description: "Make an Orchestrator card wait for other cards: it starts only once every dependsOn card is done.",
		parameters: z.object({ task: z.string(), dependsOn: z.array(z.string()).min(1) }),
		approval: "read",
		async execute(_toolCallId, params) {
			const id = taskId(params.task);
			return answer(addDependencies(id, params.dependsOn.map(taskId)).then((deps) => `${id} now depends on ${deps.join(", ")}`));
		},
	});

	pi.registerTool({
		name: "orchestrator_create",
		label: "Orchestrator create",
		description:
			"Create an Orchestrator backlog card after the required bounded preflight, only when no open card covers the same subject (add to that card with orchestrator_amend instead): a title and a description of what to build and why (what the user decided, the acceptance, links), not a plan. Set dependsOn for open cards that must land first. parent (a card of the same flow) groups it under that card; use dependsOn for ordering, though a child also inherits its parent's blockers. planningMode defaults to auto; plan requires review and fast implements directly. Once started, it runs in its own git worktree branched from this checkout's branch.",
		parameters: z.object({
			title: z.string(),
			description: z.string(),
			ticket: z.string().optional(),
			dependsOn: z.array(z.string()).optional(),
			parent: z.string().optional(),
			merge: z.enum(["local", "pr"]).optional(),
			planningMode: z.enum(["auto", "plan", "fast"]).optional(),
		}),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				(async () => {
					const t = await api<Task>("POST", "/api/tasks", {
						...params,
						dependsOn: params.dependsOn?.map(taskId),
						parent: params.parent?.trim() ? taskId(params.parent) : undefined,
						repo: ctx.cwd,
						origin: { session: ctx.sessionManager.getSessionId(), terminal: await originTerminal() },
					});
					lastCard = t.id;
					return `Created ${t.id} in the backlog: ${t.title}${t.parent ? ` (child of ${t.parent})` : ""}`;
				})(),
			);
		},
	});

	pi.registerTool({
		name: "orchestrator_edit",
		label: "Orchestrator edit",
		description:
			"Change an Orchestrator card's title, description, ticket or plan text, its planning mode, merge mode, base or branch (fixed once it starts), its parent (a card of the same flow, or \"none\" to clear it; it groups cards, use dependsOn for ordering, though a child also inherits its parent's blockers), or replace its dependencies (use [] to clear). A started card's running agent also receives a new title or description; when it can't yet (waiting for plan review or an answer, paused, omp disconnected, still starting), the board keeps the edit marked as not sent. Title and description are fixed once done. before or after (a card id in the same column) moves the card next to that card without starting it; Todo cards start from the top, so this sets which starts next.",
		parameters: z.object({
			id: z.string(),
			title: z.string().optional(),
			description: z.string().optional(),
			ticket: z.string().optional(),
			planningMode: z.enum(["auto", "plan", "fast"]).optional(),
			merge: z.enum(["local", "pr"]).optional(),
			base: z.string().optional(),
			branch: z.string().optional(),
			plan: z.string().optional(),
			dependsOn: z.array(z.string()).optional(),
			parent: z.string().optional(),
			before: z.string().optional(),
			after: z.string().optional(),
		}),
		approval: "read",
		async execute(_toolCallId, params) {
			const id = taskId(params.id);
			const fields = (["title", "description", "ticket", "plan", "planningMode", "merge", "base", "branch", "dependsOn", "parent"] as const).filter(
				(k) => params[k] !== undefined,
			);
			const side = params.before !== undefined ? "before" : params.after !== undefined ? "after" : undefined;
			if (params.before !== undefined && params.after !== undefined) return reply("Pass before or after, not both", true);
			if (!fields.length && !side) {
				return reply("Nothing to change: pass title, description, ticket, plan, planningMode, merge, base, branch, dependsOn, parent, before or after", true);
			}
			const parent = params.parent === undefined || /^(none)?$/i.test(params.parent.trim()) ? null : taskId(params.parent);
			const changes = Object.fromEntries(
				fields.map((k) => [k, k === "dependsOn" ? params.dependsOn?.map(taskId) : k === "parent" ? parent : params[k]]),
			);
			const edit = async () => {
				const t = await api<Task>("PATCH", `/api/tasks/${id}`, changes);
				const updated = `Updated ${id}: ${fields.map((k) => (k === "parent" ? (t.parent ? `parent ${t.parent}` : "parent cleared") : k)).join(", ")}`;
				if (!t.pendingUpdate || (params.title === undefined && params.description === undefined)) return updated;
				try {
					const r = await api<{ reopened: boolean }>("POST", `/api/tasks/${id}/update`, {});
					return `${updated}, and sent the change to its agent${r.reopened ? "; it moved back to In Progress" : ""}`;
				} catch (e) {
					return `${updated}, on the card only (${errorText(e)}). The board's task panel shows it as not sent and can send it later.`;
				}
			};
			return answer(
				(async () => {
					const done: string[] = [];
					if (side) {
						const anchor = taskId(params[side] as string);
						await api<Task>("POST", `/api/tasks/${id}/reorder`, { [side]: anchor });
						done.push(`Moved ${id} ${side} ${anchor}`);
					}
					if (fields.length) done.push(await edit());
					return done.join(". ");
				})(),
			);
		},
	});

	pi.registerTool({
		name: "orchestrator_amend",
		label: "Orchestrator amend",
		description:
			"Add same-subject work to an open Orchestrator card instead of creating a card. A card that hasn't started takes it in its description; a started card's running agent also receives it, and a Review card returns to In Progress. While its agent waits for plan review or an answer, or its card is paused, only the card records it. Refuses done cards, cards still starting, and started cards whose agent isn't running.",
		parameters: z.object({ id: z.string(), addition: z.string() }),
		approval: "read",
		async execute(_toolCallId, params) {
			const id = taskId(params.id);
			return answer(
				api<{ delivered: boolean; held: string | null; reopened: boolean }>("POST", `/api/tasks/${id}/amend`, {
					text: params.addition,
				}).then((r) =>
					r.delivered
						? `Added to ${id} and sent to its agent${r.reopened ? "; it moved back to In Progress" : ""}`
						: r.held === "paused"
							? `Added to ${id}'s card only: it's paused, and its agent gets the addition when it resumes`
							: r.held
								? `Added to ${id}'s card only: its agent is waiting for ${r.held === "plan_ready" ? "plan review" : "an answer"}, so tell the user to include this there, or to send it from the board's task panel once the agent resumes`
								: `Added to ${id}'s description; its brief will include it when it starts`,
				),
			);
		},
	});

	pi.registerTool({
		name: "orchestrator_start",
		label: "Orchestrator start",
		description:
			'Start Orchestrator cards: each moves to Todo and runs in its own worktree once the cards it depends on are done and any block inherited from its parent tree clears; a paused card parked in Backlog moves to Todo and resumes on its turn. ids are card ids, or ["all"] for this session\'s backlog cards in board order.',
		parameters: z.object({ ids: z.array(z.string()).min(1) }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(startCards(ctx, params.ids));
		},
	});

	pi.registerTool({
		name: "orchestrator_move",
		label: "Orchestrator move",
		description:
			"Move an Orchestrator card to another column (doing is In Progress), as dragging it on the board does. A started card moved to Todo or Backlog pauses: its agent is interrupted, its worktree and omp session stay, and it frees its task slot. Todo resumes it on its own once it's first in line with its dependencies done, no block inherited from its parent tree and a slot free; Backlog keeps it parked. Moving a paused card to doing resumes it now (it waits in Todo while it's blocked unless force). A card that hasn't started starts like orchestrator_start. Done without merging only records it as done. Use it when the user asks to pause, hold, park, resume or move a card.",
		parameters: z.object({
			id: z.string(),
			column: z.enum(["backlog", "todo", "doing", "review", "done"]),
			force: z.boolean().optional(),
			confirmLegacy: z
				.boolean()
				.optional()
				.describe(
					"Only when resuming a task whose omp may still run in its old terminal, and only after the user explicitly confirmed in this conversation that that omp has exited. Never set it on your own.",
				),
		}),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(moveCard(ctx, params.id, params.column, params.force === true, params.confirmLegacy === true));
		},
	});

	pi.registerTool({
		name: "orchestrator_stop",
		label: "Orchestrator stop",
		description:
			"Stop a started Orchestrator card's agent when the user asks: its omp session exits and its terminal closes, while its worktree, branch and session stay. The card parks in Backlog (a Review card stays). Moving it to Todo or In Progress later reopens omp on the same session and resumes it. To only pause it, use orchestrator_move.",
		parameters: z.object({ id: z.string() }),
		approval: "read",
		async execute(_toolCallId, params) {
			const id = taskId(params.id);
			return answer(
				api<Task & { note?: string }>("POST", `/api/tasks/${id}/stop`, {}).then(
					(t) =>
						`Stopped ${id}: its omp session ended; its worktree and branch ${t.branch} stay${t.column === "backlog" ? ", and it's parked in Backlog" : ""}.${t.note ? ` ${t.note}.` : ""}`,
				),
			);
		},
	});

	pi.registerTool({
		name: "orchestrator_message",
		label: "Orchestrator message",
		description:
			"Send a message to a started Orchestrator card's agent, as if typed in its omp: an idle agent starts a turn with it, a working one gets it at its next step. Use it to tell or ask the agent something; to add work to the card itself, use orchestrator_amend. Refuses paused cards, disconnected agents, and agents waiting for plan review (answer with orchestrator_review) or for an answer to their question (the user answers in its terminal; orchestrator_tasks shows how to reach it).",
		parameters: z.object({ id: z.string(), text: z.string() }),
		approval: "read",
		async execute(_toolCallId, params) {
			const id = taskId(params.id);
			return answer(
				api<{ message: string }>("POST", `/api/tasks/${id}/message`, { text: params.text }).then(
					(r) => `Sent to ${id}'s agent: ${r.message}`,
				),
			);
		},
	});

	pi.registerTool({
		name: "orchestrator_review",
		label: "Orchestrator review",
		description:
			"Answer a started Orchestrator card's open plan review with the user's decision, never your own: approve runs the plan as reviewed (read it first with orchestrator_plan); refine sends the user's feedback for another planning pass.",
		parameters: z.object({
			id: z.string(),
			decision: z.enum(["approve", "refine"]),
			feedback: z.string().optional(),
		}),
		approval: "read",
		async execute(_toolCallId, params) {
			const id = taskId(params.id);
			return answer(
				api<{ message: string }>("POST", `/api/tasks/${id}/review`, {
					decision: params.decision,
					feedback: params.feedback,
				}).then((r) => `${id}: ${r.message}`),
			);
		},
	});

	pi.registerTool({
		name: "orchestrator_screen",
		label: "Orchestrator screen",
		description: "Read the last lines of a started Orchestrator card's agent terminal: what it is doing, asking or showing now.",
		parameters: z.object({ id: z.string() }),
		approval: "read",
		async execute(_toolCallId, params) {
			const id = taskId(params.id);
			return answer(api<{ text: string }>("GET", `/api/tasks/${id}/screen`).then((r) => r.text || `${id}'s screen is empty`));
		},
	});

	pi.registerTool({
		name: "orchestrator_context",
		label: "Orchestrator context",
		description:
			"Read the shared context an Orchestrator card recorded (its Beads notes): reusable findings and its outcome, each with the source task, branch@commit and time, plus the revision. Without id, this session's own task. Use it for a dependency or sibling whose work yours builds on, or to see what changed since the revision your brief shows.",
		parameters: z.object({ id: z.string().optional() }),
		approval: "read",
		async execute(_toolCallId, params) {
			const id = params.id ? taskId(params.id) : task;
			if (!id) return reply("Name the card to read: this session has no task of its own", true);
			return answer(api<TaskContext>("GET", `/api/tasks/${id}/context`).then(contextText));
		},
	});

	pi.registerTool({
		name: "orchestrator_publish",
		label: "Orchestrator publish",
		description:
			"Record shared context on an Orchestrator card (its Beads notes), stamped with the source task, its branch@commit and the time. kind finding: a concise, reusable fact other tasks need (a decision, contract, gotcha, where something lives). kind outcome: what this task delivered, where, and how dependents use it; record it before finishing. Cards that depend on it get the latest outcome and findings in their brief; any task reads them with orchestrator_context. Not a log: no progress updates, transcripts or diffs. Without id, this session's own task.",
		parameters: z.object({
			kind: z.enum(["finding", "outcome"]),
			text: z.string().min(1),
			id: z.string().optional(),
		}),
		approval: "read",
		async execute(_toolCallId, params) {
			const id = params.id ? taskId(params.id) : task;
			if (!id) return reply("Name the card to record on: this session has no task of its own", true);
			return answer(
				api<TaskContext>("POST", `/api/tasks/${id}/context`, { kind: params.kind, text: params.text, source: task ?? "orchestrator" }).then(
					(c) => `Recorded a ${params.kind} on ${id} (revision ${c.revision}, ${c.entries.length} entr${c.entries.length === 1 ? "y" : "ies"})`,
				),
			);
		},
	});

	pi.registerTool({
		name: "orchestrator_memory",
		label: "Orchestrator memory",
		description:
			"This repository's shared memory of durable project decisions and conventions, kept in Beads and shared by every task of the repository. search (optional query, at most 200 characters) lists matching keys with a short excerpt; read returns one memory by key; remember stores text (at most 4000 characters) under key, replacing a memory with that key; forget removes one after the user confirms. Search on demand only; task outcomes belong on the card (orchestrator_publish), and the user's personal omp preferences don't belong here.",
		parameters: z.object({
			action: z.enum(["search", "read", "remember", "forget"]),
			query: z.string().optional(),
			key: z.string().optional(),
			text: z.string().optional(),
		}),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(memory(ctx, params));
		},
	});

	pi.registerTool({
		name: "orchestrator_diff",
		label: "Orchestrator diff",
		description: "Show a started Orchestrator card's changes against its base branch: the diffstat, then the diff (long diffs are cut).",
		parameters: z.object({ id: z.string() }),
		approval: "read",
		async execute(_toolCallId, params) {
			const id = taskId(params.id);
			return answer(
				api<{ base: string; stat: string; diff: string; truncated: boolean }>("GET", `/api/tasks/${id}/diff`).then((d) => {
					const cut = d.truncated || d.diff.length > DIFF_TOOL_LIMIT;
					const diff = d.diff.slice(0, DIFF_TOOL_LIMIT);
					return `${id} compared with ${d.base}\n${d.stat || "No changes"}${diff ? `\n\n${diff}` : ""}${cut ? "\n\n[diff cut; the board's Diff view shows all of it]" : ""}`;
				}),
			);
		},
	});

	pi.registerTool({
		name: "orchestrator_cleanup",
		label: "Orchestrator cleanup",
		description:
			"Remove a started Orchestrator card's worktree after the user confirms: deletes the worktree and its branch and ends its omp and terminal; the card stays on the board.",
		parameters: z.object({ id: z.string() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(cleanupCard(ctx, params.id));
		},
	});

	pi.registerTool({
		name: "orchestrator_done",
		label: "Orchestrator done",
		description:
			"Commit pending changes and merge a local Orchestrator task into its parent branch. Call it only when the user asked to merge or said the task is done; that request is the approval. Without id, merges this session's own task without asking again, removes its worktree, and ends this session and its terminal. With another task's id, the user chooses whether to keep its worktree.",
		parameters: z.object({ id: z.string().optional() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(done(ctx, params.id));
		},
	});

	pi.registerTool({
		name: "orchestrator_delete",
		label: "Orchestrator delete",
		description: "Delete an Orchestrator card after the user confirms; for a started card the user also chooses whether its worktree and branch go with it, through the board's cleanup.",
		parameters: z.object({ id: z.string() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(deleteCard(ctx, params.id));
		},
	});
}
