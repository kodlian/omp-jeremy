// Mission Control for omp: every session's agent reports and plan hold, /mission /link /task /next /tag, its tools, notifications on the checkouts a session created, and a board that starts itself.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import * as omp from "@oh-my-pi/pi-coding-agent";
import { detectTerminalContext, openBoard, type TerminalContext } from "omp-integrations/terminal";
import { PLAN_APPROVALS } from "omp-integrations/plan";
import { errorText, toolReply } from "omp-integrations/text";
import { currentTheme, hasThemeApi, isLightColor, resolveTheme, type Scheme } from "omp-integrations/theme";

const BASE = `http://127.0.0.1:${process.env.MISSION_CONTROL_PORT || "4747"}`;
const HOME = process.env.MISSION_CONTROL_HOME || join(homedir(), ".mission-control");
const PYTHON = process.env.MISSION_CONTROL_PYTHON || "python3";
const SERVER = join(dirname(realpathSync(import.meta.path)), "..", "server.py");
const SERVER_ROOT = dirname(SERVER);
const START_TIMEOUT_MS = 30_000;
const STEP_MS = 2000;
const RETRY_MS = 3000;
const UNKNOWN_CHECKOUT_MS = 60_000;
const HEARTBEAT_MS = 20_000;
const HOLD_POLL_MS = 10_000;
const FOLLOW_POLL_MS = 5_000;
const HOLD_ENTRY = "mission-control.hold";
const FOLLOW_ENTRY = "mission-control.follow";

interface PullRequest {
	number: number;
	state: "open" | "draft" | "merged" | "closed";
	checks: "passing" | "failing" | "pending" | null;
	review: "approved" | "changes_requested" | "review_required" | null;
	unresolved: number;
}

interface Project {
	id: string;
	name: string;
	repo: string;
	defaultBranch: string;
	tags: string[];
	/** `to` depends on `from`, by checkout key. */
	links: { from: string; to: string }[];
}

/** An omp running in a checkout, with what it last reported; state "running" when it reports nothing. */
interface RunningAgent {
	id: string;
	title: string | null;
	state: string;
	step: string | null;
	todo: { done: number; total: number; current: string | null } | null;
	question: string | null;
	waitingFor: string[];
}

/** A checkout of a project: its main checkout, or a linked worktree on a branch or a detached HEAD. */
interface Worktree {
	path: string;
	/** Its branch, else its path when detached. */
	key: string;
	title: string;
	folder: string;
	project: string;
	branch: string | null;
	detached: string | null;
	main: boolean;
	base: string;
	column: string;
	git: { added: number; removed: number; files: number; commits: number; dirty: number } | null;
	pr: PullRequest | null;
	tags: string[];
	ownTags: string[];
	dependsOn: string[];
	neededBy: string[];
	waitingFor: string[];
	agent: { state: "running" | "asleep" | "none"; session: { id: string; file: string } | null; at: string | null };
	agents: RunningAgent[];
}

interface Board {
	projects: Project[];
	worktrees: Worktree[];
}

/** An approved plan held until the prerequisites `keys` land; `titles` names every one it waited for. */
interface Hold {
	keys: string[];
	titles: string[];
}

/** A checkout this session created and follows. */
interface Followed {
	project: string;
	key: string;
}

interface Health {
	pid: number;
	codeMtime: number;
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

/** Starts server.py detached and waits for it to answer. */
async function launch(): Promise<void> {
	mkdirSync(HOME, { recursive: true });
	const log = openSync(join(HOME, "server.log"), "a");
	const spawned: { error?: Error } = {};
	try {
		const child = spawn(PYTHON, [SERVER], { cwd: serverCwd, env: process.env, detached: true, stdio: ["ignore", log, log] });
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
async function refreshBoard(running: Health): Promise<void> {
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
	const running = await health();
	if (running) await refreshBoard(running);
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
	return data as T;
}

// --- git, terminal, session ---------------------------------------------------------------------------------------

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

/** The real path of the main checkout of the repository at cwd; null outside git. */
function mainCheckout(cwd: string): string | null {
	const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	return common ? realpath(dirname(common)) : null;
}

/** What a tool call does, for its card: its intent, else the tool and its main argument. */
function stepText(event: { toolName: string; args: unknown; intent?: string }): string {
	if (event.intent) return event.intent;
	const detail = [field(event.args, "path"), field(event.args, "pattern"), field(event.args, "query")].find((v): v is string => typeof v === "string") ?? "";
	return `${event.toolName} ${detail}`.trim();
}

/** `value[key]` when `value` is an object; undefined otherwise. */
function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** Text on one line, at most `max` characters. */
function oneLine(text: string, max = 300): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The latest sentence of a block of reasoning or reply, in plain words; while it streams its unfinished end doesn't count. */
function lastSentence(text: string, finished: boolean): string | null {
	const parts = text
		.slice(-1200)
		.replace(/```[\s\S]*?(?:```|$)/g, "\n")
		.split(/(?<=[.!?…])\s+|\n+/);
	if (!finished) parts.pop();
	for (let i = parts.length - 1; i >= 0; i--) {
		const plain = parts[i]
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\*\*|__|[`*]/g, "")
			.replace(/^\s*(?:#+|[-+>]|\d+\.)\s+/, "")
			.trim();
		if (plain.length > 2 && !plain.startsWith("|")) return oneLine(plain);
	}
	return null;
}

/** A todo tool result's progress (dropped tasks don't count) and its task in progress: null for an empty list, undefined without phases. */
function todoProgress(result: unknown): { done: number; total: number; current: string | null } | null | undefined {
	const phases = field(field(result, "details"), "phases");
	if (!Array.isArray(phases)) return undefined;
	const tasks = phases
		.flatMap((phase) => {
			const list = field(phase, "tasks");
			return Array.isArray(list) ? list : [];
		})
		.map((t) => ({ content: field(t, "content"), status: field(t, "status") }))
		.filter((t) => t.status !== "dropped" && t.status !== "abandoned");
	if (!tasks.length) return null;
	const current = tasks.find((t) => t.status === "in_progress")?.content;
	return { done: tasks.filter((t) => t.status === "completed").length, total: tasks.length, current: typeof current === "string" ? oneLine(current, 200) : null };
}

/** The first question an ask tool call puts to the user. */
function askQuestion(args: unknown): string | null {
	const questions = field(args, "questions");
	const first = Array.isArray(questions) ? field(questions[0], "question") : undefined;
	return typeof first === "string" && first.trim() ? oneLine(first) : null;
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

// --- checkouts ----------------------------------------------------------------------------------------------------

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const COLUMNS: Record<string, string> = { planning: "Planning", waiting: "Waiting", doing: "In Progress", review: "Review", pr: "Pull Request", idle: "Idle", done: "Done" };
const columnName = (column: string) => COLUMNS[column] ?? column;

/** A checkout's name as the cmux kit shows it, with its folder. */
const named = (w: Worktree) => (w.folder ? `${w.title} (${w.folder})` : w.title);

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

/** The checkout holding `cwd`: the deepest one whose path contains it. */
function checkoutAt(board: Board, cwd: string): Worktree | undefined {
	const paths = [cwd, realpath(cwd) ?? cwd];
	let found: Worktree | undefined;
	for (const w of board.worktrees) {
		if (!paths.some((p) => p === w.path || p.startsWith(`${w.path}/`))) continue;
		if (!found || w.path.length > found.path.length) found = w;
	}
	return found;
}

/** The checkout `ref` names (its key, else its title) in `project`, else in any project. */
function findCheckout(board: Board, ref: string, project: string | null): Worktree {
	const pool = board.worktrees.filter((w) => !project || w.project === project);
	const exact = pool.filter((w) => w.key === ref);
	const lower = ref.toLowerCase();
	const matches = exact.length ? exact : pool.filter((w) => w.key.toLowerCase() === lower || w.title.toLowerCase() === lower);
	if (matches.length === 1) return matches[0];
	if (!matches.length) throw new Error(`No checkout named ${ref}${project ? ` in ${project}` : ""}`);
	throw new Error(`${ref} names several checkouts: ${matches.map((w) => `${w.key} (${w.project})`).join(", ")}`);
}

const checkoutOf = (board: Board, project: string, key: string) => board.worktrees.find((w) => w.project === project && w.key === key);

/** Checkout keys with their columns. */
function withColumns(board: Board, project: string, keys: string[]): string {
	return keys
		.map((key) => {
			const w = checkoutOf(board, project, key);
			return w ? `${key} (${columnName(w.column)})` : key;
		})
		.join(", ");
}

const titlesOf = (board: Board, project: string, keys: string[]) => keys.map((key) => checkoutOf(board, project, key)?.title ?? key);

/** Of the prerequisites `keys`, those still linked to `w` whose checkout exists and isn't Done. */
function openPrerequisites(board: Board, w: Worktree, keys: string[]): string[] {
	return keys.filter((key) => {
		const prerequisite = checkoutOf(board, w.project, key);
		return w.dependsOn.includes(key) && prerequisite !== undefined && prerequisite.column !== "done";
	});
}

/** What a checkout depends on and what depends on it, with their columns. */
function dependencies(board: Board, w: Worktree): string {
	const lines = [`${named(w)} depends on ${w.dependsOn.length ? withColumns(board, w.project, w.dependsOn) : "nothing"}`];
	if (w.waitingFor.length) lines.push(`waiting for ${w.waitingFor.join(", ")}`);
	lines.push(`needed by ${w.neededBy.length ? withColumns(board, w.project, w.neededBy) : "nothing"}`);
	return lines.join("\n");
}

function tagsText(w: Worktree): string {
	const ruled = w.tags.filter((t) => !w.ownTags.includes(t));
	const own = w.ownTags.length ? `${named(w)} tags: ${w.ownTags.join(", ")}` : `${named(w)} has no tags of its own`;
	return ruled.length ? `${own} · from tag rules: ${ruled.join(", ")}` : own;
}

/** `current` with `add` and without `remove`, compared in lowercase. */
function editTags(current: string[], add: string[], remove: string[]): string[] {
	const drop = new Set(remove.map((t) => t.toLowerCase()));
	return [...new Set([...current, ...add.map((t) => t.toLowerCase())])].filter((t) => !drop.has(t.toLowerCase()));
}

/** One checkout in words: its name, where, its column, links, work, pull request, tags and omps. */
function checkoutLine(board: Board, w: Worktree): string {
	const parts = [`${named(w)}${w.main ? " (main checkout)" : ""}`, w.branch ?? `detached ${w.detached}`, tilde(w.path), columnName(w.column)];
	if (w.dependsOn.length) parts.push(`depends on ${withColumns(board, w.project, w.dependsOn)}`);
	if (w.neededBy.length) parts.push(`needed by ${withColumns(board, w.project, w.neededBy)}`);
	if (w.waitingFor.length) parts.push(`waiting for ${w.waitingFor.join(", ")}`);
	if (w.git) {
		const work = [`+${w.git.added} \u2212${w.git.removed} in ${plural(w.git.files, "file")}`, plural(w.git.commits, "commit")];
		if (w.git.dirty) work.push(`${w.git.dirty} uncommitted`);
		parts.push(work.join(", "));
	}
	if (w.pr) {
		const pr = [`PR #${w.pr.number} ${w.pr.state}`];
		if (w.pr.checks) pr.push(`checks ${w.pr.checks}`);
		if (w.pr.review) pr.push(w.pr.review.replace("_", " "));
		if (w.pr.unresolved) pr.push(plural(w.pr.unresolved, "unresolved comment"));
		parts.push(pr.join(", "));
	}
	if (w.tags.length) parts.push(`tags ${w.tags.join(", ")}`);
	if (w.agents.length) {
		const running = w.agents.map((a) => {
			const bits = [a.title ? `"${a.title}"` : "omp", a.state.replace("_", " ")];
			if (a.step) bits.push(a.step);
			if (a.todo) bits.push(`to-do ${a.todo.done}/${a.todo.total}`);
			if (a.waitingFor.length) bits.push(`holds its plan for ${a.waitingFor.join(", ")}`);
			return bits.join(", ");
		});
		parts.push(`running: ${running.join("; ")}`);
	} else if (w.agent.state === "asleep") {
		parts.push(`asleep since ${w.agent.at?.slice(0, 10) ?? "?"} (session ${w.agent.session?.id ?? "?"})`);
	} else {
		parts.push("no omp session");
	}
	return parts.join(" · ");
}

function listCheckouts(board: Board, projects: Project[]): string {
	const lines: string[] = [];
	for (const p of projects) {
		if (lines.length) lines.push("");
		lines.push(`Project ${p.id} (${tilde(p.repo)}, default branch ${p.defaultBranch})`);
		const checkouts = board.worktrees.filter((w) => w.project === p.id);
		for (const w of checkouts) lines.push(`- ${checkoutLine(board, w)}`);
		if (!checkouts.length) lines.push("- no checkouts");
	}
	return lines.length ? lines.join("\n") : "No projects registered: /mission registers this one";
}

/** Completes the last word of a command's arguments from `items`, matched on their value or `also`, keeping the words before it. */
function completeLast(prefix: string, items: (AutocompleteItem & { also?: string })[]): AutocompleteItem[] | null {
	const at = prefix.lastIndexOf(" ") + 1;
	const head = prefix.slice(0, at);
	const word = prefix.slice(at).toLowerCase();
	const matches = items
		.filter((v) => v.value.toLowerCase().startsWith(word) || v.also?.toLowerCase().startsWith(word))
		.map((v) => ({ label: v.label, value: head + v.value, description: v.description }));
	return matches.length ? matches : null;
}

/** A hold saved in a session entry; null for none. */
function asHold(value: unknown): Hold | null {
	const keys = field(value, "keys");
	const titles = field(value, "titles");
	return isStrings(keys) && isStrings(titles) && keys.length ? { keys, titles } : null;
}

/** Followed checkouts saved in a session entry. */
function asFollowed(value: unknown): Followed[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((f) => {
		const project = field(f, "project");
		const key = field(f, "key");
		return typeof project === "string" && typeof key === "string" ? [{ project, key }] : [];
	});
}

// --- omp theme ----------------------------------------------------------------------------------------------------

// Undocumented omp exports, used as omp-git-diff-review does; without them the board keeps cmux's colors.
const themeApi = hasThemeApi(omp);
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

// --- extension ----------------------------------------------------------------------------------------------------

export default function missionControl(pi: ExtensionAPI) {
	const z = pi.zod;
	let projectId: string | null = null;
	let sessionId = "";
	let sessionFile: string | null = null;
	let reportPath = "";
	let reporting: boolean | undefined;
	let shuttingDown = false;
	let reported = "";
	let current = "";
	let planning = false;
	let reviewOpen = false;
	let currentStep: string | null = null;
	let reportedStep: string | null = null;
	let runStart = 0;
	let todo: { done: number; total: number; current: string | null } | null = null;
	let said: string | null = null;
	let question: string | null = null;
	let lastMessage: string | null = null;
	let reportedDetail = "";
	const detailKey = () => JSON.stringify([runStart, todo, said, question, hold?.keys]);
	let stepTimer: Timer | undefined;
	let resendTimer: Timer | undefined;
	let retryAt = 0;
	let sentAt = 0;
	let reports = Promise.resolve();
	let themeEpoch: number | null = null;
	let themeTimer: Timer | undefined;
	let sessionCtx: ExtensionContext | null = null;
	let lastBoard: Board | null = null;
	let boardAt = 0;
	let hold: Hold | null = null;
	// The approved plan's run is stopped once it starts; the new session "Approve and execute" opens keeps the hold.
	let stopRun = false;
	let carryHold = false;
	let holdTimer: Timer | undefined;
	let followed: Followed[] = [];
	const seen = new Map<string, { column: string; states: string[]; checks: string | null; review: string | null }>();
	let followTimer: Timer | undefined;

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

	const clearTimers = () => {
		clearTimeout(stepTimer);
		clearTimeout(resendTimer);
		clearInterval(themeTimer);
		clearInterval(holdTimer);
		clearInterval(followTimer);
		stepTimer = resendTimer = themeTimer = holdTimer = followTimer = undefined;
	};

	// --- agent state reports

	/** Posts the latest state; a failure retries (backing off while the checkout is in no registered project), a success re-sends it as a heartbeat. */
	const send = (): Promise<void> => {
		clearTimeout(stepTimer);
		clearTimeout(resendTimer);
		stepTimer = resendTimer = undefined;
		const state = current;
		const step = currentStep;
		reported = state;
		reportedStep = step;
		reportedDetail = detailKey();
		sentAt = Date.now();
		const body = {
			path: reportPath,
			sessionId,
			sessionFile,
			state,
			step,
			message: lastMessage,
			startedAt: runStart || null,
			todo,
			said,
			question,
			waitingFor: state === "waiting" && hold ? hold.keys : [],
		};
		reports = reports.then(async () => {
			const found = await callerTerminal();
			const ok = await api("POST", "/api/agent", { ...body, terminal: "context" in found ? found.context : null }, false).then(
				() => true,
				(e) => {
					reported = "";
					retryAt = Date.now() + (!(e instanceof BoardError) ? HEARTBEAT_MS : e.status === 404 ? UNKNOWN_CHECKOUT_MS : RETRY_MS);
					return false;
				},
			);
			if (shuttingDown || state === "exited") return;
			clearTimeout(resendTimer);
			resendTimer = setTimeout(() => {
				resendTimer = undefined;
				void send();
			}, ok ? HEARTBEAT_MS : retryAt - Date.now());
		});
		return reports;
	};

	/** Reports a state change at once; a new step or detail under the same state at most every STEP_MS. */
	const report = (ctx: ExtensionContext, state: string, step: string | null = null): Promise<void> => {
		if (ctx.agent?.kind === "sub" || shuttingDown) return reports;
		current = state;
		currentStep = step;
		reportPath = ctx.cwd;
		if (state === reported && step === reportedStep && detailKey() === reportedDetail) return reports;
		reporting ??= mainCheckout(ctx.cwd) !== null;
		if (!reporting || Date.now() < retryAt) return reports;
		const wait = sentAt + STEP_MS - Date.now();
		if (state === reported && wait > 0) {
			stepTimer ??= setTimeout(() => {
				stepTimer = undefined;
				if (current !== reported || currentStep !== reportedStep || detailKey() !== reportedDetail) void send();
			}, wait);
			return reports;
		}
		return send();
	};

	const resting = () => (hold ? "waiting" : reviewOpen ? "plan_ready" : "idle");

	// --- board reads, plan hold, followed checkouts

	/** Reads the board, keeping it for argument completions. */
	const readBoard = async (autostart = true): Promise<Board> => {
		lastBoard = await api<Board>("GET", "/api/state", undefined, autostart);
		boardAt = Date.now();
		return lastBoard;
	};

	/** The board and the checkout this session runs in; an error outside every registered project. */
	const ownCheckout = async (ctx: ExtensionContext): Promise<{ board: Board; own: Worktree }> => {
		const board = await readBoard();
		const own = checkoutAt(board, ctx.cwd);
		if (!own) throw new Error(`${tilde(ctx.cwd)} is in no checkout of a registered project: /mission registers it`);
		return { board, own };
	};

	/** Polls the board while a plan is held or a created checkout is followed. */
	const syncPolls = () => {
		if (hold) holdTimer ??= setInterval(() => void checkHold(), HOLD_POLL_MS);
		else {
			clearInterval(holdTimer);
			holdTimer = undefined;
		}
		if (followed.length) followTimer ??= setInterval(() => void checkFollowed(), FOLLOW_POLL_MS);
		else {
			clearInterval(followTimer);
			followTimer = undefined;
		}
	};

	const setHold = (next: Hold | null) => {
		hold = next;
		pi.appendEntry(HOLD_ENTRY, { hold: next });
		syncPolls();
	};

	/** Stops the run an approved plan starts while it is held. */
	const stopHeld = (ctx: ExtensionContext) => {
		stopRun = false;
		ctx.abort();
		void report(ctx, "waiting");
	};

	/** Holds a just-approved plan while this checkout has prerequisites that aren't Done. */
	const holdApproved = async (ctx: ExtensionContext) => {
		const board = await readBoard(false);
		const own = checkoutAt(board, ctx.cwd);
		const keys = own ? openPrerequisites(board, own, own.waitingFor) : [];
		if (!own || !keys.length) return;
		const titles = titlesOf(board, own.project, keys);
		carryHold = true;
		setHold({ keys, titles });
		ctx.ui.notify(`Plan approved · waiting for ${titles.join(", ")}`, "info");
		const live = sessionCtx ?? ctx;
		if (live.isIdle()) {
			stopRun = true;
			void report(live, "waiting");
		} else {
			stopHeld(live);
		}
	};

	/** Releases the held plan once none of its prerequisites is open: the agent rebases and implements it. */
	const checkHold = async () => {
		const ctx = sessionCtx;
		const board = ctx && hold ? await readBoard(false).catch(() => null) : null;
		const own = board && ctx ? checkoutAt(board, ctx.cwd) : undefined;
		if (!ctx || !hold || !board || !own) return;
		const open = openPrerequisites(board, own, hold.keys);
		if (open.length === hold.keys.length) return;
		if (open.length) {
			setHold({ keys: open, titles: hold.titles });
			if (current === "waiting") void report(ctx, "waiting");
			return;
		}
		const text = `${hold.titles.join(", ")} landed: rebase on ${own.base} if it moved, then implement the approved plan.`;
		setHold(null);
		stopRun = false;
		if (current === "waiting") void report(ctx, resting());
		if (ctx.isIdle()) pi.sendUserMessage(text);
		else pi.sendUserMessage(text, { deliverAs: "followUp" });
	};

	const saveFollowed = (next: Followed[]) => {
		followed = next;
		pi.appendEntry(FOLLOW_ENTRY, { followed });
		syncPolls();
	};

	/** Tells this session how the checkouts it created move along; stops following one once it is Done or gone. */
	const checkFollowed = async () => {
		const ctx = sessionCtx;
		const board = ctx && followed.length ? await readBoard(false).catch(() => null) : null;
		if (!ctx || !board) return;
		const keep: Followed[] = [];
		for (const f of followed) {
			const id = `${f.project}\n${f.key}`;
			const w = checkoutOf(board, f.project, f.key);
			if (!w) {
				seen.delete(id);
				continue;
			}
			const before = seen.get(id);
			const now = { column: w.column, states: w.agents.map((a) => a.state), checks: w.pr?.checks ?? null, review: w.pr?.review ?? null };
			seen.set(id, now);
			if (w.column === "done") seen.delete(id);
			else keep.push(f);
			if (!before) continue;
			const n = named(w);
			const entered = (state: string) => now.states.includes(state) && !before.states.includes(state);
			if (entered("plan_ready")) ctx.ui.notify(`${n}: plan ready for review`, "warning");
			if (entered("needs_input")) {
				const asked = w.agents.find((a) => a.state === "needs_input")?.question;
				ctx.ui.notify(`${n} needs your input${asked ? `: ${asked}` : ""}`, "warning");
			}
			if (now.column !== before.column) {
				if (now.column === "waiting") ctx.ui.notify(`${n} is waiting for ${titlesOf(board, w.project, w.waitingFor).join(", ")}`, "info");
				else if (now.column === "review") ctx.ui.notify(`${n} is in review: ready for a pull request`, "info");
				else if (now.column === "done") ctx.ui.notify(w.pr?.state === "merged" ? `${n}: PR #${w.pr.number} merged` : `${n} is done: it landed`, "info");
			}
			if (w.pr && now.checks === "failing" && before.checks !== "failing") ctx.ui.notify(`${n}: PR #${w.pr.number} checks failing`, "warning");
			if (w.pr && now.review === "changes_requested" && before.review !== "changes_requested") ctx.ui.notify(`${n}: PR #${w.pr.number} changes requested`, "warning");
		}
		if (keep.length !== followed.length) saveFollowed(keep);
	};

	/** Creates a worktree whose omp plans `prompt`, from this checkout's branch or stacked on this checkout; this session follows it. */
	const newWorktree = async (ctx: ExtensionContext, prompt: string, stack: boolean, branch?: string): Promise<string> => {
		if (!prompt) throw new Error(`Say what to plan: /${stack ? "next" : "task"} <prompt>`);
		const { own } = await ownCheckout(ctx);
		if (stack && !own.branch) throw new Error(`${named(own)} is on a detached HEAD: nothing can stack on it`);
		const from = stack ? { after: own.key } : own.branch ? { base: own.branch } : {};
		const made = await api<{ key: string; path: string; opened: boolean; command: string | null }>("POST", "/api/worktrees/new", {
			project: own.project,
			prompt,
			branch: branch || undefined,
			...from,
		});
		saveFollowed([...followed.filter((f) => f.project !== own.project || f.key !== made.key), { project: own.project, key: made.key }]);
		const where = stack ? `stacked on ${own.key}, which it waits for` : `from ${own.branch ?? "the default branch"}`;
		const run = made.opened ? "Its omp opened in its own terminal and plans the prompt." : made.command ? `No terminal opened: run ${made.command}` : "No terminal opened.";
		return `Created ${made.key} at ${tilde(made.path)}, ${where}.\n${run}\nThis session is told when it moves along.`;
	};

	/** Links (or with `remove` unlinks) the checkout `prerequisite` names before `dependent`. */
	const link = async (board: Board, dependent: Worktree, prerequisite: string, remove: boolean) => {
		const from = remove && dependent.dependsOn.includes(prerequisite) ? prerequisite : findCheckout(board, prerequisite, dependent.project).key;
		await api("PATCH", "/api/projects/links", { id: dependent.project, from, to: dependent.key, linked: !remove });
	};

	/** Sets a checkout's own tags; tells the tags it then has. */
	const saveTags = async (w: Worktree, tags: string[]): Promise<string> => {
		await api("PATCH", "/api/projects/tags", { id: w.project, key: w.key, tags });
		const board = await readBoard();
		const now = checkoutOf(board, w.project, w.key);
		return now ? tagsText(now) : `${named(w)} tags: ${tags.join(", ")}`;
	};

	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		if ("prompt" in event && typeof event.prompt === "string") lastMessage = event.prompt.slice(0, 2000);
		runStart ||= Math.floor(Date.now() / 1000);
		said = null;
	});
	pi.on("turn_start", (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		if (stopRun) {
			stopHeld(ctx);
			return;
		}
		planning = inPlanMode(ctx);
		runStart ||= Math.floor(Date.now() / 1000);
		void report(ctx, planning ? "planning" : "thinking");
	});
	pi.on("message_update", (event, ctx) => {
		if (ctx.agent?.kind === "sub" || !["planning", "thinking", "working"].includes(current)) return;
		const update = event.assistantMessageEvent;
		if (update.type !== "thinking_delta" && update.type !== "thinking_end" && update.type !== "text_delta" && update.type !== "text_end") return;
		const content = field(event.message, "content");
		const block = Array.isArray(content) ? content[update.contentIndex] : undefined;
		const text = field(block, "thinking") ?? field(block, "text");
		const sentence = typeof text === "string" ? lastSentence(text, update.type.endsWith("_end")) : null;
		if (!sentence || sentence === said) return;
		said = sentence;
		void report(ctx, current, currentStep);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		if (event.toolName === "ask") question = askQuestion(event.args);
		void report(ctx, event.toolName === "ask" ? "needs_input" : planning ? "planning" : "working", stepText(event));
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		if (event.toolName === "todo") {
			const progress = todoProgress(event.result);
			if (progress === undefined) return;
			todo = progress;
			if (current) void report(ctx, current, currentStep);
		} else if (event.toolName === "ask") {
			question = null;
			// The clock starts over once the agent is back at work after the answer.
			runStart = Math.floor(Date.now() / 1000);
			void report(ctx, planning ? "planning" : "working");
		}
	});
	pi.on("agent_end", (event, ctx) => {
		if (ctx.agent?.kind === "sub" || ("willContinue" in event && event.willContinue === true)) return;
		runStart = 0;
		question = null;
		void report(ctx, resting());
	});
	pi.on("plan_review_requested", (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		reviewOpen = true;
		void report(ctx, "plan_ready");
	});
	pi.on("plan_review_resolved", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		reviewOpen = false;
		if (!event.choice || event.choice === "save") void report(ctx, resting());
		if (event.choice && PLAN_APPROVALS[event.choice]) void holdApproved(ctx).catch(() => {});
	});

	const restore = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.agent?.kind === "sub") return;
		serverCwd = ctx.cwd;
		sessionCtx = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		let savedHold: Hold | null | undefined;
		let savedFollowed: Followed[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === HOLD_ENTRY) savedHold = asHold(field(entry.data, "hold"));
			else if (entry.customType === FOLLOW_ENTRY) savedFollowed = asFollowed(field(entry.data, "followed"));
		}
		if (savedHold === undefined && carryHold && hold) pi.appendEntry(HOLD_ENTRY, { hold });
		else hold = savedHold ?? null;
		carryHold = false;
		followed = savedFollowed;
		seen.clear();
		syncPolls();
		reported = "";
		retryAt = 0;
		const busy = ["planning", "thinking", "working", "needs_input"].includes(current);
		void report(ctx, busy ? current : resting(), currentStep);
		void readBoard(false).then(
			() => (hold ? checkHold() : undefined),
			() => {},
		);
	};
	pi.on("session_start", restore);
	pi.on("session_switch", restore);

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub" || shuttingDown) return;
		shuttingDown = true;
		clearTimers();
		if (!reporting) return;
		current = "exited";
		currentStep = null;
		await send();
		clearTimers();
	});

	// --- /mission

	pi.registerCommand("mission", {
		description: "Open Mission Control on this project",
		handler: async (_args, ctx) => {
			if (ctx.agent?.kind === "sub") return;
			serverCwd = ctx.cwd;
			try {
				await ensureBoard();
				const { project } = await api<{ project: Project }>("POST", "/api/projects", { path: ctx.cwd });
				projectId = project.id;
				themeEpoch = null;
				syncTheme();
				if (themeApi) themeTimer ??= setInterval(syncTheme, 1000);
				await openBoard(`${BASE}/?project=${encodeURIComponent(project.id)}`, { focus: true, python: PYTHON, overrideEnvs: TERMINAL_OVERRIDES });
				ctx.ui.notify(`Mission Control on ${project.name} (${project.defaultBranch})`, "info");
			} catch (e) {
				ctx.ui.notify(errorText(e), "error");
			}
		},
	});

	// --- commands

	/** Registers a command that tells its result or error. */
	const command = (name: string, description: string, run: (args: string, ctx: ExtensionContext) => Promise<string>, complete: (prefix: string) => AutocompleteItem[] | null) => {
		pi.registerCommand(name, {
			description,
			getArgumentCompletions: complete,
			handler: async (args, ctx) => {
				if (ctx.agent?.kind === "sub") return;
				serverCwd = ctx.cwd;
				try {
					ctx.ui.notify(await run(args.trim(), ctx), "info");
				} catch (e) {
					ctx.ui.notify(errorText(e), "error");
				}
			},
		});
	};

	/** This session's checkout in the latest board read, refreshed in the background when older than a few seconds. */
	const completionCheckout = (): { board: Board; own: Worktree } | null => {
		if (Date.now() - boardAt > 5000) void readBoard(false).catch(() => {});
		const own = lastBoard && sessionCtx ? checkoutAt(lastBoard, sessionCtx.cwd) : undefined;
		return lastBoard && own ? { board: lastBoard, own } : null;
	};

	/** The other checkouts of this session's project, by key (also matched on title), each prefixed with `sign`. */
	const checkoutItems = (sign: string, only?: string[]) => {
		const found = completionCheckout();
		if (!found) return [];
		return found.board.worktrees
			.filter((w) => w.project === found.own.project && w.key !== found.own.key && (!only || only.includes(w.key)))
			.map((w) => ({ value: sign + w.key, label: sign + w.key, description: `${named(w)} · ${columnName(w.column)}`, also: sign + w.title }));
	};

	command(
		"link",
		"Make this checkout depend on others: /link <branch|title>… adds, /link -<branch> removes, /link lists both directions",
		async (args, ctx) => {
			const { board, own } = await ownCheckout(ctx);
			if (!args) return dependencies(board, own);
			for (const word of args.split(/\s+/)) await link(board, own, word.replace(/^-/, ""), word.startsWith("-"));
			const after = await ownCheckout(ctx);
			return dependencies(after.board, after.own);
		},
		(prefix) => completeLast(prefix, [...checkoutItems(""), ...checkoutItems("-", completionCheckout()?.own.dependsOn ?? [])]),
	);

	command("task", "Start work in a new worktree from this checkout's branch: its omp plans the prompt", (prompt, ctx) => newWorktree(ctx, prompt, false), () => null);
	command("next", "Start work that builds on this checkout: a new worktree stacked on its branch, waiting for it", (prompt, ctx) => newWorktree(ctx, prompt, true), () => null);

	command(
		"tag",
		"Tag this checkout: /tag a b adds, /tag -a removes, /tag lists",
		async (args, ctx) => {
			const { own } = await ownCheckout(ctx);
			if (!args) return tagsText(own);
			const words = args.split(/\s+/);
			const remove = words.filter((w) => w.startsWith("-")).map((w) => w.slice(1));
			return saveTags(own, editTags(own.ownTags, words.filter((w) => !w.startsWith("-")), remove));
		},
		(prefix) => {
			const found = completionCheckout();
			if (!found) return null;
			const tags = found.board.projects.find((p) => p.id === found.own.project)?.tags ?? [];
			return completeLast(prefix, [...tags.map((tag) => ({ value: tag, label: tag })), ...found.own.ownTags.map((tag) => ({ value: `-${tag}`, label: `-${tag}`, description: "Remove" }))]);
		},
	);

	// --- tools

	/** The checkout `ref` names in this session's project (else any project), else this session's checkout. */
	const toolCheckout = (board: Board, ctx: ExtensionContext, ref: string | undefined): Worktree => {
		const here = checkoutAt(board, ctx.cwd);
		const w = ref ? findCheckout(board, ref, here?.project ?? null) : here;
		if (!w) throw new Error(`${tilde(ctx.cwd)} is in no checkout of a registered project: /mission registers it`);
		return w;
	};

	const answer = async (work: Promise<string>) => {
		try {
			return toolReply(await work);
		} catch (e) {
			return toolReply(errorText(e), true);
		}
	};

	pi.registerTool({
		name: "mission_control_checkouts",
		label: "Mission Control checkouts",
		description:
			"Read-only: list the checkouts Mission Control shows for this project (all: every registered project). For each, its title (folder), branch (or detached commit, or the main checkout), path, column (Planning, Waiting, In Progress, Review, Pull Request, Idle, Done), what it depends on and what needs it with their columns, what it waits for, diff, commits and uncommitted files, pull request with checks, review and unresolved comments, tags, and every omp running there (title, state, step, to-do progress), else its latest asleep session.",
		parameters: z.object({ all: z.boolean().optional() }),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				readBoard().then((board) => {
					const here = checkoutAt(board, ctx.cwd)?.project ?? projectId;
					const project = board.projects.find((p) => p.id === here);
					if (params.all !== true && !project) throw new Error(`${tilde(ctx.cwd)} is in no registered project: /mission registers it, all lists every project`);
					return listCheckouts(board, params.all === true || !project ? board.projects : [project]);
				}),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_link",
		label: "Mission Control link",
		description:
			"Make a checkout (dependent, default this one) depend on another checkout of its project (prerequisite), or remove that dependency with remove. Both take a branch (checkout key) or a title. While a prerequisite isn't Done the dependent waits: an omp there holds its approved plan until it lands. Replies with what the dependent then depends on and what needs it.",
		parameters: z.object({ prerequisite: z.string(), dependent: z.string().optional(), remove: z.boolean().optional() }),
		approval: "write",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				(async () => {
					const board = await readBoard();
					const dependent = toolCheckout(board, ctx, params.dependent);
					await link(board, dependent, params.prerequisite, params.remove === true);
					const after = await readBoard();
					const now = checkoutOf(after, dependent.project, dependent.key);
					return now ? dependencies(after, now) : `${dependent.key} is gone`;
				})(),
			);
		},
	});

	pi.registerTool({
		name: "mission_control_task",
		label: "Mission Control task",
		description:
			"Start separate work in a new worktree whose omp plans prompt for the user to review. It branches from this checkout's branch; after: true stacks it on this checkout instead (branched from it and waiting for it to land). branch names it (default feature/<slug of the prompt>). Replies with its branch, path and whether its terminal opened (else the command to run); this session is then told when its plan is ready, it needs input, waits, is ready for a pull request, its PR fails checks or gets changes requested, and when it's done.",
		parameters: z.object({ prompt: z.string(), branch: z.string().optional(), after: z.boolean().optional() }),
		approval: "write",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(newWorktree(ctx, params.prompt.trim(), params.after === true, params.branch));
		},
	});

	pi.registerTool({
		name: "mission_control_edit",
		label: "Mission Control edit",
		description:
			"Edit a checkout's own tags (checkout: a branch or title, default this one): tags replaces them, add and remove change them; none of them lists its tags. Replies with its tags, and those its project's tag rules add.",
		parameters: z.object({
			tags: z.array(z.string()).optional(),
			add: z.array(z.string()).optional(),
			remove: z.array(z.string()).optional(),
			checkout: z.string().optional(),
		}),
		approval: "write",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return answer(
				readBoard().then((board) => {
					const w = toolCheckout(board, ctx, params.checkout);
					if (!params.tags && !params.add && !params.remove) return tagsText(w);
					return saveTags(w, editTags(params.tags ?? w.ownTags, params.add ?? [], params.remove ?? []));
				}),
			);
		},
	});
}
