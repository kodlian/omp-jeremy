// @bun
// plugins/mission-control/omp/mission-control.ts
import { spawn, spawnSync } from "child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import * as omp from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth } from "@oh-my-pi/pi-tui";

// packages/integrations/src/terminal.ts
import { fileURLToPath } from "url";
var TERMINALS_SCRIPT = fileURLToPath(new URL("../python/omp_terminals.py", import.meta.url));
async function helper(args, options) {
  const overrides = (options.overrideEnvs ?? []).flatMap((name) => ["--override-env", name]);
  const proc = Bun.spawn([options.python ?? "python3", TERMINALS_SCRIPT, ...overrides, ...args], {
    env: options.env ?? process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 30000);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0)
      throw new Error(err.trim().replace(/^terminals: /, "") || `omp_terminals.py ${args[0]} exited with ${code}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}
async function detectTerminalContext(options = {}) {
  return JSON.parse(await helper(["detect"], options));
}
async function openBoard(url, options = {}) {
  const args = ["board", url, options.focus ? "--focus" : "--no-focus"];
  if (options.context)
    args.push("--context", JSON.stringify(options.context));
  await helper(args, options);
}

// packages/integrations/src/plan.ts
var PLAN_APPROVALS = { execute: true, compact: true, keep: true };

// packages/integrations/src/text.ts
var errorText = (e) => e instanceof Error ? e.message : String(e);
var toolReply = (text, isError = false) => ({ content: [{ type: "text", text }], isError });

// packages/integrations/src/bus.ts
function busAsk(events, event, request, timeoutMs, unavailable) {
  const { promise, resolve } = Promise.withResolvers();
  const timer = setTimeout(() => resolve({ ok: false, message: unavailable }), timeoutMs);
  events.emit(event, {
    ...request,
    reply: (r) => {
      clearTimeout(timer);
      resolve(r);
    }
  });
  return promise;
}

// packages/integrations/src/fonts.ts
var fonts = new Map;

// packages/integrations/src/theme.ts
var THEME_EXPORTS = ["getCurrentThemeName", "getResolvedThemeColors", "getThemeExportColors", "isLightTheme", "getThemeEpoch"];
function hasThemeApi(module) {
  return THEME_EXPORTS.every((name) => typeof module[name] === "function");
}
async function currentTheme(api) {
  const name = api.getCurrentThemeName();
  const [tokens, page] = await Promise.all([api.getResolvedThemeColors(name), api.getThemeExportColors(name)]);
  return { colors: { ...tokens, ...page }, light: api.isLightTheme(name) };
}
var HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
function isLightColor(hex) {
  const full = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}
function resolveTheme(theme, terminal) {
  const colors = Object.fromEntries(Object.entries(theme.colors).filter(([, value]) => HEX.test(value)));
  const base = colors.pageBg ?? colors.userMessageBg;
  const scheme = base ? isLightColor(base) ? "light" : "dark" : theme.light ? "light" : "dark";
  const term = terminal?.background && isLightColor(terminal.background) === (scheme === "light") ? terminal : null;
  return { scheme, colors, background: term?.background ?? colors.pageBg, foreground: term?.foreground ?? colors.text };
}
var GHOSTTY_FONT_SIZE = process.platform === "darwin" ? 13 : 12;

// packages/control-view/src/protocol.ts
var RUN_EVENT = "control:run";
var LIBRARY_EVENT = "control:library";
var COMMAND_EVENT = "control:command";

// plugins/mission-control/omp/mission-control.ts
var BASE = `http://127.0.0.1:${process.env.MISSION_CONTROL_PORT || "4747"}`;
var HOME = process.env.MISSION_CONTROL_HOME || join(homedir(), ".mission-control");
var PYTHON = process.env.MISSION_CONTROL_PYTHON || "python3";
var SERVER = join(dirname(realpathSync(import.meta.path)), "..", "server.py");
var SERVER_ROOT = dirname(SERVER);
var START_TIMEOUT_MS = 30000;
var RECONNECT_MS = 3000;
var STREAM_IDLE_MS = 1e4;
var STEP_MS = 2000;
var CLEANUP_ENTRY = "mission-control.cleanup";
var ENGAGED_ENTRY = "mission-control.engaged";
var MERGE_REMOVE = "Merge and remove the worktree";
var MERGE_KEEP = "Merge and keep the worktree";
var DELETE_REMOVE = "Delete and remove the worktree";
var DELETE_KEEP = "Delete and keep the worktree";
var CANCEL = "Cancel";
var DIFF_TOOL_LIMIT = 60000;
var SHARING = "Record a concise finding other tasks need (a decision, contract, gotcha, where something lives) with mission_control_publish as you learn it, and your outcome (what changed, where, how dependents use it) once the work is committed, before finishing. Read what a dependency recorded, newer than your brief, with mission_control_context.";
var CONTROL_ASK_MS = 2000;
var CONTROL_POST_MS = 500;
function isControl(data) {
  return typeof data === "object" && data !== null && "id" in data && typeof data.id === "string" && "task" in data && typeof data.task === "string" && "action" in data && typeof data.action === "string";
}

class BoardError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
var tilde = (path) => path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
var cardNumbers = new Map;
var CARD_ID = /(?<![\w/-])(?:MC|KB)-\d+(?:\.\d+)*\b/g;
var lastBoard = null;
function rememberNumbers(board) {
  lastBoard = board;
  for (const t of board.tasks)
    cardNumbers.set(t.id, t.number);
}
var taskNumber = (id) => {
  const n = cardNumbers.get(id);
  return n ? `#${n}` : id;
};
var withNumbers = (text) => text.replace(CARD_ID, taskNumber);
var serverCwd = process.cwd();
var starting;
async function health() {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
async function prepare(env) {
  const child = spawn(PYTHON, [SERVER, "--prepare"], { cwd: serverCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    stderr += chunk;
  });
  const exited = Promise.withResolvers();
  child.on("error", exited.reject);
  child.on("close", exited.resolve);
  const code = await exited.promise.catch((e) => {
    throw new Error(`Mission Control didn't start: ${errorText(e)}`);
  });
  mkdirSync(HOME, { recursive: true });
  if (output)
    appendFileSync(join(HOME, "server.log"), output);
  if (code !== 0) {
    const reason = stderr.trim().split(`
`).pop() || `server.py --prepare exited with ${code}`;
    throw new Error(`Mission Control can't start: ${reason}`);
  }
}
async function launch() {
  const env = { ...process.env };
  delete env.MISSION_CONTROL_TASK;
  await prepare(env);
  const log = openSync(join(HOME, "server.log"), "a");
  const spawned = {};
  try {
    const child = spawn(PYTHON, [SERVER], { cwd: serverCwd, env, detached: true, stdio: ["ignore", log, log] });
    child.on("error", (e) => {
      spawned.error = e;
    });
    child.unref();
    if (child.pid)
      writeFileSync(join(HOME, "server.pid"), `${child.pid}
`);
  } finally {
    closeSync(log);
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawned.error)
      throw new Error(`Mission Control didn't start: ${spawned.error.message}`);
    if (await health())
      return;
    await Bun.sleep(100);
  }
  throw new Error(`Mission Control didn't start; see ${tilde(HOME)}/server.log`);
}
function exclusive(job) {
  starting ??= job().finally(() => {
    starting = undefined;
  });
  return starting;
}
async function refreshBoard() {
  const running = await health();
  if (!running)
    return;
  const mtimes = readdirSync(SERVER_ROOT).filter((name) => name.endsWith(".py")).map((name) => statSync(join(SERVER_ROOT, name)).mtimeMs / 1000);
  if (!mtimes.length)
    return;
  const mtime = Math.max(...mtimes);
  if (Math.floor(mtime) <= Math.floor(running.codeMtime))
    return;
  await exclusive(async () => {
    await api("POST", "/api/restart", {}, false).catch(() => {
      try {
        process.kill(running.pid, "SIGTERM");
      } catch {}
    });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && await health())
      await Bun.sleep(100);
    await launch();
  });
}
async function ensureBoard() {
  if (await health())
    await refreshBoard();
  else
    await exclusive(launch);
}
async function api(method, path, body, autostart = true) {
  const init = {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    signal: autostart ? undefined : AbortSignal.timeout(2000)
  };
  let res;
  try {
    res = await fetch(BASE + path, init);
  } catch {
    if (!autostart)
      throw new Error("Mission Control isn't running");
    await exclusive(launch);
    try {
      res = await fetch(BASE + path, init);
    } catch {
      throw new Error(`Mission Control didn't start; see ${tilde(HOME)}/server.log`);
    }
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "";
    throw new BoardError(res.status, error || `${res.status} ${res.statusText}`);
  }
  if (method === "GET" && path === "/api/state")
    rememberNumbers(data);
  else if (data && typeof data === "object" && "id" in data && "number" in data)
    cardNumbers.set(String(data.id), String(data.number));
  return data;
}
async function* serverEvents(body) {
  let buffer = "";
  for await (const chunk of body.pipeThrough(new TextDecoderStream)) {
    buffer += chunk;
    for (let end = buffer.indexOf(`

`);end >= 0; end = buffer.indexOf(`

`)) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data = [];
      for (const line of block.split(`
`)) {
        if (line.startsWith("event:"))
          event = line.slice(6).trim();
        else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length)
        yield { event, data: data.join(`
`) };
    }
  }
}
function git(args, cwd) {
  return (spawnSync("git", args, { cwd, encoding: "utf8" }).stdout ?? "").trim();
}
function realpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
function linkedWorktree(cwd) {
  const [gitDir, commonDir] = git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], cwd).split(`
`);
  return Boolean(gitDir && commonDir && gitDir !== commonDir);
}
var checkoutRoot = (cwd) => git(["rev-parse", "--show-toplevel"], cwd) || cwd;
function mainCheckout(cwd) {
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  return common ? realpath(dirname(common)) : null;
}
function worktreeTask(board, cwd) {
  const root = realpath(checkoutRoot(cwd));
  return root ? board.tasks.find((t) => t.worktree && realpath(t.worktree) === root) : undefined;
}
function stepText(event) {
  if (event.intent)
    return event.intent;
  const args = event.args && typeof event.args === "object" ? event.args : {};
  const detail = [args.path, args.pattern, args.query].find((v) => typeof v === "string") ?? "";
  return `${event.toolName} ${detail}`.trim();
}
function inPlanMode(ctx) {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1;i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "mode_change")
      return "mode" in entry && entry.mode === "plan";
  }
  return false;
}
var TERMINAL_OVERRIDES = ["MISSION_CONTROL_TERMINAL", "OMP_TERMINAL"];
var terminal;
function callerTerminal() {
  terminal ??= detectTerminalContext({ python: PYTHON, overrideEnvs: TERMINAL_OVERRIDES }).then((context) => ({ context }), (e) => ({ error: errorText(e) }));
  return terminal;
}
async function originTerminal() {
  const found = await callerTerminal();
  if ("error" in found)
    throw new Error(found.error);
  return found.context;
}
async function requestTerminal() {
  const found = await callerTerminal();
  return "context" in found ? found.context : undefined;
}
async function showBoard(url, focus) {
  await openBoard(url, { focus, python: PYTHON, overrideEnvs: TERMINAL_OVERRIDES });
}
function presentationText(t) {
  const p = t.presentation;
  if (p?.alive && p.kind !== "plain")
    return `in its ${p.kind} ${p.kind === "tmux" ? "window" : "workspace"}`;
  return t.attachCommand ? `after attaching with: ${t.attachCommand}` : "in its omp session";
}
var columnTitle = (board, column) => board.columns.find((c) => c.id === column)?.title ?? column;
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
var numbers = (ids) => ids.map(taskNumber).join(", ");
function prText(pr) {
  const marks = [pr.checks && `checks ${pr.checks}`, pr.review && pr.review.replace("_", " "), pr.conflicts && "conflicts"].filter(Boolean);
  return `PR #${pr.number} ${pr.state}${marks.length ? ` (${marks.join(", ")})` : ""}`;
}
function waitsUntil(t) {
  const own = t.blockedBy.filter((b) => t.dependsOn.includes(b));
  const inherited = t.blockedBy.filter((b) => !t.dependsOn.includes(b));
  return [
    own.length && `${numbers(own)} ${own.length === 1 ? "is" : "are"} done`,
    inherited.length && `the block on its parent tree (${numbers(inherited)}) clears`
  ].filter(Boolean).join(" and ");
}
function listTasks(board, projects, self) {
  const hidden = (x) => projects.some((p) => p.id === x.project && p.hidden.includes(x.branch));
  const ids = new Set(projects.map((p) => p.id));
  const several = projects.length > 1;
  const listed = board.tasks.filter((t) => ids.has(t.project));
  const tags = [...new Set(projects.flatMap((p) => p.tags))].sort();
  const lines = [`Tags in use: ${tags.join(", ") || "none"}`];
  for (const p of projects)
    lines.push(`Project ${p.id} (${tilde(p.repo)}, default branch ${p.defaultBranch})`);
  lines.push("");
  const open = listed.filter((t) => t.column !== "done");
  for (const t of open) {
    let line = `${t.id} \xB7 ${columnTitle(board, t.column)} \xB7 ${t.title} \xB7 ${t.branch} from ${t.base}`;
    if (t.id === self)
      line += " \xB7 this task";
    if (t.tags.length)
      line += ` \xB7 tags ${t.tags.join(", ")}`;
    if (t.dependsOn.length)
      line += ` \xB7 depends on ${t.dependsOn.join(", ")}`;
    if (t.parent)
      line += ` \xB7 child of ${t.parent}`;
    if (t.children.length)
      line += ` \xB7 ${plural(t.children.length, "child card")}`;
    if (t.held)
      line += " \xB7 paused until moved to In Progress";
    else if (t.paused)
      line += " \xB7 paused";
    if (t.blockedBy.length)
      line += ` \xB7 waits until ${waitsUntil(t)}`;
    else if (t.waitingForSlot)
      line += " \xB7 waiting for a task slot";
    if (t.agent && t.agent.state !== "idle")
      line += ` \xB7 ${t.agent.state.replace("_", " ")}`;
    if (t.worktree && (t.presentation || t.attachCommand))
      line += ` \xB7 reach it ${presentationText(t)}`;
    if (t.health?.worktreeMissing)
      line += " \xB7 worktree missing";
    if (t.land.mergeInto)
      line += ` \xB7 merges into ${t.land.mergeInto}`;
    if (t.pr)
      line += ` \xB7 ${prText(t.pr)}`;
    if (t.loop)
      line += ` \xB7 loop ${t.loop}`;
    if (t.ticket)
      line += ` \xB7 ticket ${t.ticket}`;
    if (several)
      line += ` \xB7 project ${t.project}`;
    if (hidden(t))
      line += " \xB7 hidden on the page";
    lines.push(line);
  }
  if (!open.length)
    lines.push("No open cards");
  const done = listed.filter((t) => t.column === "done");
  if (done.length) {
    lines.push("", "Done, still on the board (depend on one when new work builds on it; it doesn't block):");
    for (const t of done)
      lines.push(`${t.id} \xB7 ${t.title}${several ? ` \xB7 project ${t.project}` : ""}`);
  }
  const others = board.worktrees.filter((w) => ids.has(w.project));
  if (others.length) {
    lines.push("", "Other worktrees (no card; mission_control_adopt tracks one):");
    for (const w of others) {
      const work = w.git ? ` \xB7 ${plural(w.git.commits, "commit")}${w.git.dirty ? `, ${w.git.dirty} uncommitted` : ""}` : "";
      const tags2 = w.tags.length ? ` \xB7 tags ${w.tags.join(", ")}` : "";
      lines.push(`${w.branch} from ${w.base} \xB7 ${tilde(w.path)} \xB7 ${columnTitle(board, w.column)}${work}${w.pr ? ` \xB7 ${prText(w.pr)}` : ""}${tags2}${hidden(w) ? " \xB7 hidden on the page" : ""}`);
    }
  }
  return lines.join(`
`);
}
function findTask(board, id) {
  const t = board.tasks.find((x) => x.id === id);
  if (!t)
    throw new Error(`Unknown task ${id}`);
  return t;
}
async function addDependencies(id, deps) {
  const t = findTask(await api("GET", "/api/state"), id);
  const dependsOn = [...new Set([...t.dependsOn, ...deps])];
  await api("PATCH", `/api/tasks/${id}`, { dependsOn });
  return dependsOn;
}
function mergeSummary(t) {
  const commits = t.git?.commits ?? 0;
  const dirty = t.git?.dirty ?? 0;
  const pending = dirty ? `, ${dirty} uncommitted file${dirty === 1 ? "" : "s"} will be committed` : "";
  return `${plural(commits, "commit")} on ${t.branch}, +${t.git?.added ?? 0} \u2212${t.git?.removed ?? 0}${pending}`;
}
function landsText(t) {
  return t.land.mergeInto ? `When the work is complete and verified, tell the user; do not push: /land (mission_control_land when the user says to merge) merges this branch into ${t.base}, removes this worktree and ends this session.` : `When the work is complete and verified, commit it, push the branch and open a pull request into ${t.base} (/land or mission_control_land does it).`;
}
function taskContext(id, board) {
  const t = board?.tasks.find((x) => x.id === id);
  if (!board || !t)
    return `This session works on Mission Control task ${id}. Read the other cards with mission_control_tasks; don't do their part. ${SHARING}`;
  const builders = board.tasks.filter((o) => o.dependsOn.includes(id)).map((o) => o.id);
  return `This session works on Mission Control task ${taskNumber(t.id)}: ${t.title}, on ${t.branch} from ${t.base}. ${landsText(t)} It waits for: ${t.blockedBy.length ? numbers(t.blockedBy) : "nothing"}. Tasks that build on it: ${builders.length ? numbers(builders) : "none"}. Read another card with mission_control_tasks; don't do its part. If your work touches another product area, add its tag with mission_control_edit. ${SHARING}`;
}
function contextText(c) {
  const head = `${c.id} \xB7 revision ${c.revision}${c.updatedAt ? ` \xB7 updated ${c.updatedAt}` : ""}`;
  if (!c.entries.length)
    return `${head}
Nothing recorded yet.`;
  const blocks = c.entries.map((e) => {
    const stamp = [e.source, e.ref, e.at].filter(Boolean).join(" \xB7 ");
    return `## ${e.kind}${stamp ? ` (${stamp})` : ""}
${e.text}`;
  });
  let shown = blocks.length;
  while (shown > 1 && blocks.slice(blocks.length - shown).join(`

`).length > DIFF_TOOL_LIMIT)
    shown--;
  const cut = shown < blocks.length ? `

[${blocks.length - shown} older entries not shown]` : "";
  return `${head}

${blocks.slice(blocks.length - shown).join(`

`)}${cut}`;
}
function cardLine(board, id) {
  const t = board.tasks.find((x) => x.id === id);
  if (!t)
    return `${id} (not on the board)`;
  const state = t.merged ? `merged into ${t.merged.into}` : t.paused ? "paused" : t.blockedBy.length ? `waits until ${waitsUntil(t)}` : t.waitingForSlot ? "waiting for a task slot" : t.agent && t.agent.state !== "idle" ? t.agent.state.replace("_", " ") : "";
  return `${t.id} \xB7 ${columnTitle(board, t.column)} \xB7 ${t.title}${state ? ` \xB7 ${state}` : ""}`;
}
function childrenText(board, t) {
  const lines = [`${t.id}: ${t.title} (${columnTitle(board, t.column)})`];
  lines.push(t.parent ? `Parent: ${cardLine(board, t.parent)}` : "No parent");
  if (t.children.length)
    lines.push(`Children (${t.children.length}):`, ...t.children.map((c) => `- ${cardLine(board, c)}`));
  else
    lines.push("No children");
  lines.push("Parent groups cards; use dependsOn for ordering. Children also wait for what their parent tree depends on.");
  return lines.join(`
`);
}
var themeApi = hasThemeApi(omp);
var WIDGET = "mission-control";
var BOARD_GLYPH = { nerd: "\uF135", unicode: "\uD83D\uDE80", ascii: "[mc]" };
var AGENT_LOOK = {
  needs_input: ["warning", "needs input"],
  plan_ready: ["warning", "plan ready for review"],
  planning: ["accent", "planning"],
  thinking: ["accent", "thinking"],
  working: ["accent", "working"],
  idle: ["muted", "idle"],
  disconnected: ["muted", "omp disconnected"],
  stopped: ["muted", "stopped"]
};
var CONTROL = /\p{Cc}/gu;
var THEME_VARS = {
  "--bg": "pageBg",
  "--fg": "text",
  "--accent": "accent",
  "--muted": "muted",
  "--add": "toolDiffAdded",
  "--remove": "toolDiffRemoved",
  "--warning": "warning",
  "--cyan": "borderAccent"
};
function intentText(t) {
  const i = t.intent;
  if (!i)
    return null;
  const text = { start: "starting", resume: "resuming", stop: "stopping", merge: `merging into ${t.base}`, remove: "removing worktree", delete: "deleting" }[i.op] ?? i.op;
  return i.attempt > 0 ? `${text} (retrying: ${i.lastError ?? "unknown error"})` : text;
}
function cardLook(t) {
  const busy = intentText(t);
  if (busy)
    return ["accent", busy];
  if (t.spawn.state === "failed")
    return ["error", "didn't start"];
  if (t.merged)
    return ["success", `merged into ${t.merged.into}`];
  if (t.column === "review")
    return ["success", t.land.mergeInto ? `ready to merge into ${t.land.mergeInto}` : "ready for pull request"];
  if (t.column === "pr" && t.pr)
    return [t.pr.checks === "failing" || t.pr.review === "changes_requested" || t.pr.conflicts ? "warning" : "success", prText(t.pr)];
  if (t.column === "waiting")
    return ["warning", t.held || t.paused ? "paused" : t.waitingForSlot ? "waiting for a task slot" : "waiting"];
  return t.agent && AGENT_LOOK[t.agent.state] || null;
}
function widgetLines(p, board, id) {
  const icon = p.fg("accent", BOARD_GLYPH[p.getSymbolPreset()] ?? BOARD_GLYPH.unicode);
  const sep = p.fg("dim", " \xB7 ");
  const head = ` ${icon} ${p.bold(p.fg("accent", taskNumber(id)))}`;
  const t = board?.tasks.find((x) => x.id === id);
  if (!t)
    return [head];
  const commits = t.git?.commits ?? 0;
  const work = commits ? `${p.fg("muted", plural(commits, "commit"))} ${p.fg("success", `+${t.git?.added ?? 0}`)} ${p.fg("error", `\u2212${t.git?.removed ?? 0}`)}` : p.fg("dim", "no commits yet");
  const look = cardLook(t);
  const state = look ? `${sep}${p.fg(look[0], look[1])}` : "";
  const waits = t.blockedBy.length ? `${sep}${p.fg("muted", `waits for ${numbers(t.blockedBy)}`)}` : "";
  return [`${head} ${t.title.replace(CONTROL, " ")} ${p.fg("muted", `from ${t.base}`)}${sep}${work}${state}${waits}`];
}
async function themeAppearance() {
  const theme = resolveTheme(await currentTheme(omp), null);
  const vars = {};
  for (const [name, token] of Object.entries(THEME_VARS)) {
    const value = theme.colors[token];
    if (value)
      vars[name] = value;
  }
  if (vars["--accent"])
    vars["--accent-fg"] = isLightColor(vars["--accent"]) ? "#000000" : "#ffffff";
  return { scheme: theme.scheme, vars };
}
function completeLast(prefix, values) {
  const at = prefix.lastIndexOf(" ") + 1;
  const head = prefix.slice(0, at);
  const word = prefix.slice(at).toLowerCase();
  const matches = values.filter((v) => v.value.toLowerCase().startsWith(word)).map((v) => ({ ...v, value: head + v.value }));
  return matches.length ? matches : null;
}
function missionControl(pi) {
  const z = pi.zod;
  let engaged = false;
  let projectId = null;
  let sessionId = "";
  let lastCard = null;
  let lastCleanup = true;
  let task = null;
  let taskLookup = false;
  let reporting;
  let reportRetryAt = 0;
  let shuttingDown = false;
  const handledControls = [];
  let reported = "";
  let current = "";
  let planning = false;
  let reviewOpen = false;
  let planForYou = false;
  let lastControl = null;
  let currentStep = null;
  let reportedStep = null;
  let stepTimer;
  let sentAt = 0;
  let reports = Promise.resolve();
  let sessionFile = null;
  let lastMessage = null;
  let terminalWarned = false;
  let stream = null;
  let seen = null;
  let latest = null;
  let repaint = null;
  let themeEpoch = null;
  let themeTimer;
  let controlCtx = null;
  let controlPending = null;
  let controlPosting = false;
  let controlSentAt = 0;
  let autoMerging = false;
  const showWidget = (ctx) => {
    if (!task)
      return ctx.ui.setWidget(WIDGET, undefined);
    const ui = ctx.ui;
    ui.setWidget(WIDGET, (tui) => {
      let rows = [];
      let width = -1;
      const mine = () => {
        width = -1;
        tui.requestRender();
      };
      repaint = mine;
      return {
        render(w) {
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
          if (repaint === mine)
            repaint = null;
        }
      };
    }, { placement: "belowEditor" });
  };
  const syncTheme = () => {
    if (!themeApi || !projectId)
      return;
    const epoch = omp.getThemeEpoch();
    if (epoch === themeEpoch)
      return;
    themeEpoch = epoch;
    const project = projectId;
    themeAppearance().then((look) => themeEpoch === epoch ? api("POST", "/api/appearance", { project, ...look }, false) : undefined).catch(() => {});
  };
  const sessionProject = (board, ctx) => {
    const id = (task ? board.tasks.find((t) => t.id === task)?.project : undefined) ?? projectId;
    const named = id ? board.projects.find((p) => p.id === id) : undefined;
    if (named)
      return named;
    const repo = mainCheckout(ctx.cwd);
    return repo ? board.projects.find((p) => realpath(p.repo) === repo) : undefined;
  };
  const registerProject = async (ctx) => {
    const r = await api("POST", "/api/projects", { path: ctx.cwd });
    projectId = r.project.id;
    return r.project;
  };
  const cardId = async (raw, ctx) => {
    const ref = raw.trim().replace(/^#(?=\d)/, "");
    if (/^(mc|kb)-\d+(\.\d+)*$/i.test(ref))
      return ref.toUpperCase();
    if (!/^\d+(\.\d+)*$/.test(ref))
      return ref;
    const board = await api("GET", "/api/state");
    const project = sessionProject(board, ctx);
    const found = board.tasks.filter((t) => t.number === ref && (!project || t.project === project.id));
    if (found.length === 1)
      return found[0].id;
    throw new Error(found.length ? `#${ref} names cards in several projects` : `No card #${ref}${project ? ` in ${project.name}` : ""}`);
  };
  const cardIds = (refs, ctx) => Promise.all(refs.map((ref) => cardId(ref, ctx)));
  const ownCard = async (ctx) => {
    if (task)
      return findTask(await api("GET", "/api/state"), task);
    if (!linkedWorktree(ctx.cwd))
      throw new Error("This is the main checkout: run it in a task's worktree");
    return api("POST", "/api/worktrees/adopt", { path: checkoutRoot(ctx.cwd) });
  };
  const tell = async (ctx, work) => {
    try {
      ctx.ui.notify(withNumbers(await work), "info");
    } catch (e) {
      ctx.ui.notify(withNumbers(errorText(e)), "error");
    }
  };
  const answer = async (work) => {
    try {
      return toolReply(withNumbers(await work));
    } catch (e) {
      return toolReply(withNumbers(errorText(e)), true);
    }
  };
  const send = (path) => {
    clearTimeout(stepTimer);
    stepTimer = undefined;
    const state = current;
    const step = currentStep;
    reported = state;
    reportedStep = step;
    sentAt = Date.now();
    reports = reports.then(() => api("POST", "/api/agent", { path, task: task ?? process.env.MISSION_CONTROL_TASK ?? null, state, step, sessionId, sessionFile, message: lastMessage }, false).then(() => {}, (e) => {
      reported = "";
      if (e instanceof BoardError && e.status === 404)
        reportRetryAt = Date.now() + 3000;
    }));
    return reports;
  };
  const report = (ctx, state, step = null) => {
    if (ctx.agent?.kind === "sub")
      return reports;
    current = state;
    currentStep = step;
    if (state === reported && step === reportedStep)
      return reports;
    reporting ??= Boolean(process.env.MISSION_CONTROL_TASK) || linkedWorktree(ctx.cwd);
    if (!reporting || Date.now() < reportRetryAt)
      return reports;
    const path = ctx.cwd;
    const wait = sentAt + STEP_MS - Date.now();
    if (state === reported && wait > 0) {
      stepTimer ??= setTimeout(() => {
        stepTimer = undefined;
        if (current !== reported || currentStep !== reportedStep)
          send(path);
      }, wait);
      return reports;
    }
    return send(path);
  };
  let holding = null;
  const stopHeld = (ctx) => {
    const waits = holding;
    if (!waits)
      return;
    holding = null;
    ctx.abort();
    report(ctx, "idle");
    ctx.ui.notify(`Plan approved \xB7 ${waits}`, "info");
  };
  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    if ("prompt" in event && typeof event.prompt === "string")
      lastMessage = event.prompt.slice(0, 2000);
  });
  pi.on("turn_start", (_event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    if (holding) {
      stopHeld(ctx);
      return;
    }
    planning = inPlanMode(ctx);
    report(ctx, planning ? "planning" : "thinking");
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    if (event.toolName.startsWith("mission_control_"))
      engage(ctx);
    report(ctx, event.toolName === "ask" ? "needs_input" : planning ? "planning" : "working", stepText(event));
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (ctx.agent?.kind !== "sub" && event.toolName === "ask")
      report(ctx, planning ? "planning" : "working");
  });
  pi.on("agent_end", (event, ctx) => {
    if (ctx.agent?.kind === "sub" || "willContinue" in event && event.willContinue === true)
      return;
    report(ctx, reviewOpen && planForYou ? "plan_ready" : reviewOpen ? "planning" : "idle");
    if (task)
      autoMerge(ctx);
  });
  const controlAsk = (command2) => busAsk(pi.events, COMMAND_EVENT, command2, CONTROL_ASK_MS, "The Control plugin isn't loaded in this omp");
  const postControl = (view) => {
    if (!task || !controlCtx)
      return;
    controlPending = { view };
    if (controlPosting)
      return;
    controlPosting = true;
    const id = task;
    const path = controlCtx.cwd;
    (async () => {
      while (controlPending) {
        const wait = controlSentAt + CONTROL_POST_MS - Date.now();
        if (wait > 0)
          await Bun.sleep(wait);
        const next = controlPending;
        controlPending = null;
        controlSentAt = Date.now();
        await api("POST", `/api/tasks/${id}/control`, { path, view: next.view }, false).catch(() => {});
      }
      controlPosting = false;
    })();
  };
  pi.events.on(RUN_EVENT, (data) => {
    const view = data ?? null;
    lastControl = view;
    if (task)
      postControl(view);
    if (!controlCtx || !view)
      return;
    if (reviewOpen) {
      if (view.plan === "review" && !planForYou) {
        planForYou = true;
        report(controlCtx, "plan_ready");
      } else if (view.plan === "checking") {
        planForYou = false;
        report(controlCtx, "planning", `Control \xB7 ${view.loop.planReviewer?.name ?? "plan reviewer"} reads the plan`);
      }
    }
    if (view.gate.open) {
      const undecided = view.findings.filter((f) => f.route === "ask" && !f.decision).length;
      report(controlCtx, "needs_input", `Control: ${undecided} findings need your decision`);
    } else if (view.status === "checking") {
      const names = view.loop.stages.flatMap((s) => s.nodes).filter((n) => view.nodes[n.id]?.state === "running").map((n) => n.name);
      report(controlCtx, "working", `Control \xB7 ${names.join(", ") || "checking"}`);
    }
  });
  pi.events.on(LIBRARY_EVENT, (data) => {
    if (!engaged || !projectId || !data || typeof data !== "object" || !("loops" in data))
      return;
    const summary = data;
    api("PATCH", "/api/projects/control-loops", { id: projectId, loops: summary.loops }, false).catch(() => {});
  });
  const syncControl = async () => {
    if (engaged && projectId) {
      const id = projectId;
      const r = await controlAsk({ type: "library" });
      await api("PATCH", "/api/projects/control-loops", { id, loops: r.ok ? r.library?.loops ?? null : null }, false).catch(() => {});
    }
    if (task) {
      const r = await controlAsk({ type: "run" });
      postControl(r.ok ? r.run ?? null : null);
    }
  };
  const autoMerge = async (ctx) => {
    if (!task || autoMerging)
      return;
    const id = task;
    const r = await controlAsk({ type: "run" });
    const run = r.ok ? r.run : null;
    if (run?.status !== "passed" || run.loop.finish !== "auto")
      return;
    autoMerging = true;
    try {
      const t = findTask(await api("GET", "/api/state"), id);
      if (!t.land.mergeInto || t.merged || !t.worktree)
        return;
      ctx.ui.notify(`Control flow \xAB${run.loop.name}\xBB passed: merging ${taskNumber(id)} into ${t.land.mergeInto}`, "info");
      await api("POST", `/api/tasks/${id}/merge`, { cleanup: true, commit: true, terminal: await requestTerminal() });
    } catch (e) {
      const message = errorText(e);
      if (!message.includes(" is still "))
        ctx.ui.notify(`Couldn't merge ${taskNumber(id)} automatically: ${message}`, "error");
    } finally {
      autoMerging = false;
    }
  };
  const watch = (ctx, board) => {
    const next = new Map;
    for (const t of board.tasks) {
      if (t.origin?.session !== sessionId)
        continue;
      const before = seen?.get(t.id);
      next.set(t.id, !t.agent && before?.agent ? { ...t, agent: before.agent } : t);
      if (!before)
        continue;
      const n = `${taskNumber(t.id)} \xB7 ${t.title}`;
      if (t.spawn.state === "failed" && before.spawn.state !== "failed") {
        ctx.ui.notify(`${taskNumber(t.id)} didn't start: ${t.spawn.error ?? "unknown error"}`, "error");
      }
      if (t.agent?.state === "needs_input" && before.agent?.state !== "needs_input") {
        ctx.ui.notify(`${taskNumber(t.id)} needs your input ${presentationText(t)}`, "warning");
      }
      if (t.agent?.state === "plan_ready" && before.agent?.state !== "plan_ready") {
        ctx.ui.notify(`${taskNumber(t.id)}'s plan is ready: review it ${presentationText(t)}`, "warning");
      }
      if (t.column === "doing" && before.column === "waiting")
        ctx.ui.notify(`${n}
Resumed: what it waited for has landed`, "info");
      if (t.column === "review" && before.column !== "review") {
        ctx.ui.notify(t.land.mergeInto ? `${n}
Ready to merge ${t.branch} \u2192 ${t.land.mergeInto}` : `${n}
Ready for a pull request ${t.branch} \u2192 ${t.base}`, "info");
      }
      if (t.pr?.checks === "failing" && before.pr?.checks !== "failing")
        ctx.ui.notify(`${n}
PR #${t.pr.number}: checks failing`, "warning");
      if (t.pr?.state === "merged" && before.pr?.state !== "merged") {
        ctx.ui.notify(`${n}
PR #${t.pr.number} merged: ${t.branch} \u2192 ${t.pr.base}`, "info");
      } else if (t.merged && !before.merged) {
        ctx.ui.notify(`${n}
Merged ${t.branch} \u2192 ${t.merged.into} (${t.merged.sha.slice(0, 7)})`, "info");
      }
    }
    seen = next;
  };
  const answerControl = (id, ok, message) => api("POST", `/api/control/${id}`, { ok, message }, false).then(() => {}, () => {});
  const runControl = async (ctx, c) => {
    if (handledControls.includes(c.id))
      return answerControl(c.id, true, "Already handled");
    handledControls.push(c.id);
    if (handledControls.length > 50)
      handledControls.shift();
    let ok = true;
    let message;
    try {
      const review = ctx.getPendingPlanReview();
      if (c.action === "pause") {
        const running = !ctx.isIdle();
        if (running)
          ctx.abort();
        report(ctx, review ? "plan_ready" : "idle");
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
      } else if (c.action === "control_decide") {
        const r = await controlAsk({ type: "decide", decisions: c.decisions ?? {}, pause: c.pause === true });
        ok = r.ok;
        message = r.message;
      } else if (c.action === "control_open") {
        const r = await controlAsk({ type: "open" });
        ok = r.ok;
        message = r.message;
      } else if (c.action === "stop") {
        if (!ctx.isIdle())
          ctx.abort();
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
  const onEvent = (ctx, e) => {
    try {
      const data = JSON.parse(e.data);
      if (e.event === "snapshot") {
        latest = data;
        rememberNumbers(latest);
        watch(ctx, latest);
        repaint?.();
      } else if (e.event === "control" && isControl(data) && data.task === task) {
        runControl(ctx, data);
      }
    } catch {}
  };
  const stopStream = () => {
    stream?.abort();
    stream = null;
    clearInterval(themeTimer);
    themeTimer = undefined;
  };
  const syncStream = (ctx) => {
    if (!engaged && !task)
      return stopStream();
    if (stream)
      return;
    const ctl = new AbortController;
    stream = ctl;
    seen = null;
    if (themeApi)
      themeTimer = setInterval(syncTheme, 1000);
    const cwd = ctx.cwd;
    (async () => {
      while (!ctl.signal.aborted) {
        try {
          const query = new URLSearchParams({ session: sessionId });
          if (task)
            query.set("task", task);
          if (engaged) {
            projectId = await api("POST", "/api/projects", { path: cwd }, false).then((r) => r.project.id, (e) => {
              if (e instanceof BoardError)
                return null;
              throw e;
            });
            if (projectId)
              query.set("project", projectId);
          }
          const where = await callerTerminal();
          if ("context" in where)
            query.set("terminal", JSON.stringify(where.context));
          else if (!terminalWarned) {
            terminalWarned = true;
            ctx.ui.notify(`Mission Control: ${where.error}`, "warning");
          }
          const conn = new AbortController;
          const cancel = () => conn.abort();
          ctl.signal.addEventListener("abort", cancel, { once: true });
          let watchdog;
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
              report(ctx, current || "idle", currentStep);
              syncControl();
              const body = res.body.pipeThrough(new TransformStream({
                transform(chunk, out) {
                  arm();
                  out.enqueue(chunk);
                }
              }));
              for await (const e of serverEvents(body))
                onEvent(ctx, e);
            } else
              await res.body?.cancel();
          } finally {
            clearTimeout(watchdog);
            ctl.signal.removeEventListener("abort", cancel);
          }
        } catch {}
        if (!ctl.signal.aborted)
          await Bun.sleep(RECONNECT_MS);
      }
    })();
  };
  function engage(ctx) {
    if (engaged)
      return;
    engaged = true;
    pi.appendEntry(ENGAGED_ENTRY, { engaged: true });
    stopStream();
    syncStream(ctx);
  }
  const nudge = (id) => {
    const file = process.env.MISSION_CONTROL_RESUME_FILE;
    if (!file || !existsSync(file))
      return;
    let text;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (!data || typeof data !== "object" || !("text" in data) || typeof data.text !== "string" || !data.text)
        return;
      text = data.text;
    } catch {
      return;
    }
    setTimeout(async () => {
      pi.sendUserMessage(text);
      await api("POST", `/api/tasks/${id}/resumed`, {}, false).catch(() => {});
    }, 1500);
  };
  const enterTask = (ctx, id) => {
    task = id;
    showWidget(ctx);
    stopStream();
    syncStream(ctx);
    nudge(id);
  };
  const detectTask = async (ctx) => {
    const env = process.env.MISSION_CONTROL_TASK;
    if (!env && !linkedWorktree(ctx.cwd))
      return;
    if (env)
      return enterTask(ctx, env);
    while (!shuttingDown) {
      try {
        const found = worktreeTask(await api("GET", "/api/state", undefined, false), ctx.cwd);
        if (found && !shuttingDown)
          enterTask(ctx, found.id);
        return;
      } catch {
        await Bun.sleep(RECONNECT_MS);
      }
    }
  };
  const restore = (_event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    serverCwd = ctx.cwd;
    controlCtx = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    lastCleanup = true;
    engaged = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom")
        continue;
      if (entry.customType === CLEANUP_ENTRY)
        lastCleanup = entry.data?.cleanup !== false;
      else if (entry.customType === ENGAGED_ENTRY)
        engaged = true;
    }
    if (!engaged)
      projectId = null;
    showWidget(ctx);
    stopStream();
    syncStream(ctx);
    if (engaged && !process.env.MISSION_CONTROL_TASK)
      ensureBoard().catch((e) => ctx.ui.notify(errorText(e), "warning"));
    if (!taskLookup) {
      taskLookup = true;
      detectTask(ctx);
    }
  };
  pi.on("session_start", restore);
  pi.on("session_switch", restore);
  pi.on("session_branch", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    shuttingDown = true;
    stopStream();
    await report(ctx, "exited");
  });
  const createTask = async (ctx, body) => {
    const t = await api("POST", "/api/tasks", {
      ...body,
      repo: ctx.cwd,
      origin: { session: ctx.sessionManager.getSessionId(), terminal: await originTerminal() }
    });
    lastCard = t.id;
    return t;
  };
  const createdText = (t, from) => `${t.id} ${t.title} \xB7 planning on ${t.branch}${from ? ` (from ${from})` : ` from ${t.base}`}${t.blockedBy.length ? ` \xB7 waits for ${t.blockedBy.join(", ")}` : ""}`;
  const createPr = async (id) => {
    const r = await api("POST", `/api/tasks/${id}/pr`, {});
    return r.via === "agent" ? `Asked ${id}'s agent to commit, push and open the pull request` : `Opened a pull request for ${id}${r.url ? `: ${r.url}` : ""}`;
  };
  const merge = async (ctx, t, own) => {
    const id = t.id;
    if (!ctx.hasUI)
      throw new Error(`Merging needs the user's confirmation: ask them to run /land in ${id}'s worktree`);
    if (t.merged)
      throw new Error(`${id} is already merged into ${t.merged.into}`);
    if (!t.worktree)
      throw new Error(`${id} has no worktree, so there is nothing to merge`);
    if (!t.land.mergeInto)
      throw new Error(`${id} branches from ${t.base}, the default branch: it lands through a pull request`);
    let cleanup;
    if (own) {
      cleanup = true;
    } else {
      const options = lastCleanup ? [MERGE_REMOVE, MERGE_KEEP, CANCEL] : [MERGE_KEEP, MERGE_REMOVE, CANCEL];
      const pick = await ctx.ui.select(`Merge ${taskNumber(id)} into ${t.base}? ${mergeSummary(t)}`, options);
      if (pick !== MERGE_REMOVE && pick !== MERGE_KEEP)
        return "Merge cancelled";
      cleanup = pick === MERGE_REMOVE;
      if (cleanup !== lastCleanup) {
        lastCleanup = cleanup;
        pi.appendEntry(CLEANUP_ENTRY, { cleanup });
      }
    }
    const r = await api("POST", `/api/tasks/${id}/merge`, {
      cleanup,
      commit: true,
      terminal: await requestTerminal()
    });
    const ends = own && task === id;
    if (ends) {
      const text = `Merged ${t.branch} \u2192 ${t.base} (${r.merged?.sha.slice(0, 7) ?? "?"}) \xB7 this session ends${r.pending ? "; the worktree is removed once this session has exited" : ""}`;
      setTimeout(() => {
        ctx.ui.notify(text, "info");
        ctx.shutdown();
      }, 0);
    }
    if (!r.pending || ends)
      return r.output;
    return `${r.output}
${taskNumber(id)} ${cleanup ? "has its worktree removed once its agent has stopped" : "is stopping its agent"}`;
  };
  const land = async (ctx, raw, how) => {
    let t;
    let own;
    if (raw?.trim()) {
      const board = await api("GET", "/api/state");
      t = findTask(board, await cardId(raw, ctx));
      own = t.id === (task ?? worktreeTask(board, ctx.cwd)?.id);
    } else {
      t = await ownCard(ctx);
      own = true;
    }
    const mode = how ?? (t.land.mergeInto ? "merge" : "pr");
    return mode === "merge" ? merge(ctx, t, own) : createPr(t.id);
  };
  const deleteCard = async (ctx, raw) => {
    const id = await cardId(raw, ctx);
    if (!ctx.hasUI)
      throw new Error(`Deleting needs the user's confirmation: ask them to delete ${id} on the board`);
    const board = await api("GET", "/api/state");
    const t = findTask(board, id);
    const column = columnTitle(board, t.column);
    const dependents = board.tasks.filter((o) => o.column !== "done" && o.dependsOn.includes(id)).map((o) => o.id);
    const links = [
      t.children.length && `${t.children.join(", ")} lose${t.children.length === 1 ? "s" : ""} its parent`,
      dependents.length && `${dependents.join(", ")} no longer wait${dependents.length === 1 ? "s" : ""} for it and may resume`
    ].filter(Boolean);
    const unlinks = links.length ? ` ${links.join("; ")}.` : "";
    let cleanup = false;
    if (t.worktree) {
      const working = t.moveRequiresConfirmation ? " It may still be working: keeping the worktree leaves its omp running." : "";
      const pick = await ctx.ui.select(`Delete ${taskNumber(id)}? ${t.title} (${column}). Removing its worktree ${tilde(t.worktree)} also deletes the branch ${t.branch} and ends its omp and terminal.${working}${unlinks}`, [DELETE_REMOVE, DELETE_KEEP, CANCEL]);
      if (pick !== DELETE_REMOVE && pick !== DELETE_KEEP)
        return `${id} kept`;
      cleanup = pick === DELETE_REMOVE;
    } else if (!await ctx.ui.confirm(`Delete ${taskNumber(id)}?`, `${t.title} (${column})

It has no worktree.${unlinks}`))
      return `${id} kept`;
    const terminal2 = await requestTerminal();
    const r = await api("DELETE", `/api/tasks/${id}`, { confirmWorking: t.moveRequiresConfirmation, cleanup, terminal: terminal2 });
    if (r.pending)
      return r.message ?? `${id} is deleted once its worktree is gone`;
    return r.output ? `Deleted ${id}
${r.output}` : `Deleted ${id}`;
  };
  const moveCard = async (ctx, raw, column, force) => {
    const id = await cardId(raw, ctx);
    const before = findTask(await api("GET", "/api/state"), id);
    const t = await api("POST", `/api/tasks/${id}/move`, { column, confirmWorking: true, force });
    if (t.column === "waiting") {
      return `${before.column === "waiting" ? `${id} stays paused` : `Paused ${id}: ${t.note ?? "its agent stopped"}`}. Its worktree and session stay; moving it to In Progress resumes it.`;
    }
    if (t.column === "doing") {
      if (before.spawn.state === "failed")
        return `${id} starting again`;
      if (before.column === "doing")
        return `${id} continues in In Progress`;
      return `Resumed ${id}: its agent continues${before.session?.connected ? "" : " once omp reopens on its session"}.`;
    }
    return `Moved ${id} to Done`;
  };
  const cleanupCard = async (ctx, raw) => {
    const id = await cardId(raw, ctx);
    if (!ctx.hasUI)
      throw new Error(`Removing a worktree needs the user's confirmation: ask them to remove ${id}'s on the board`);
    const t = findTask(await api("GET", "/api/state"), id);
    if (!t.worktree)
      throw new Error(`${id} has no worktree`);
    const keeps = t.merged || t.column === "done" ? "The card stays." : "The card goes with it: the task isn't done.";
    const sure = await ctx.ui.confirm(`Remove ${taskNumber(id)}'s worktree?`, `Deletes ${tilde(t.worktree)} and the branch ${t.branch}, ending its omp and terminal. ${keeps}`);
    if (!sure)
      return `${id}'s worktree kept`;
    const terminal2 = await requestTerminal();
    const r = await api("POST", `/api/tasks/${id}/cleanup`, { terminal: terminal2 });
    const output = r.output ? `${r.output}
` : "";
    if (r.pending)
      return `${output}${id}'s worktree is removed once its agent has stopped`;
    return r.deleted ? `${output}Removed ${id}'s worktree and its card` : r.output;
  };
  const openBoard2 = async (ctx, focus) => {
    const project = await registerProject(ctx);
    const board = await api("GET", "/api/state");
    const own = worktreeTask(board, ctx.cwd);
    const card = own?.project === project.id ? own.id : lastCard ?? undefined;
    await showBoard(`${BASE}/?project=${encodeURIComponent(project.id)}${card ? `#${card}` : ""}`, focus);
    return `Mission Control on ${project.name} (${project.defaultBranch})`;
  };
  const command = (name, description, run, complete) => {
    pi.registerCommand(name, {
      description,
      getArgumentCompletions: complete,
      handler: async (args, ctx) => {
        if (ctx.agent?.kind === "sub")
          return;
        serverCwd = ctx.cwd;
        engage(ctx);
        await tell(ctx, run(args.trim(), ctx));
      }
    });
  };
  const cardItems = () => (lastBoard?.tasks ?? []).filter((t) => t.column !== "done" && (!projectId || t.project === projectId)).map((t) => ({ label: `#${t.number}`, value: `#${t.number}`, description: t.title }));
  const tagItems = () => {
    const tags = (lastBoard?.projects ?? []).filter((p) => !projectId || p.id === projectId).flatMap((p) => p.tags);
    return [...new Set(tags)].map((tag) => ({ label: tag, value: tag }));
  };
  command("mission", "Open Mission Control on this project", async (_args, ctx) => {
    await refreshBoard();
    return openBoard2(ctx, true);
  });
  command("task", "Start a task in a new worktree from this branch: its omp plans the prompt", async (prompt, ctx) => {
    if (!prompt)
      throw new Error("Say what to plan: /task <prompt>");
    return createdText(await createTask(ctx, { prompt }));
  });
  command("next", "Start a task that builds on this worktree's card: branches from it and waits for it", async (prompt, ctx) => {
    if (!prompt)
      throw new Error("Say what to plan: /next <prompt>");
    if (!task && !linkedWorktree(ctx.cwd))
      throw new Error("Run /next in a worktree; /task starts independent work");
    const own = await ownCard(ctx);
    return createdText(await createTask(ctx, { prompt, after: own.id }), own.branch);
  });
  command("link", "Make this worktree's card wait for other cards: /link #n\u2026, /link none clears, /link lists", async (args, ctx) => {
    const own = await ownCard(ctx);
    if (!args)
      return own.dependsOn.length ? `${own.id} depends on ${own.dependsOn.join(", ")}${own.blockedBy.length ? ` \xB7 waits for ${own.blockedBy.join(", ")}` : " \xB7 all landed"}` : `${own.id} depends on nothing`;
    if (/^none$/i.test(args)) {
      await api("PATCH", `/api/tasks/${own.id}`, { dependsOn: [] });
      return `${own.id} no longer depends on any card`;
    }
    const deps = await addDependencies(own.id, await cardIds(args.split(/\s+/), ctx));
    return `${own.id} now depends on ${deps.join(", ")}`;
  }, (prefix) => completeLast(prefix, [{ label: "none", value: "none", description: "Clear its links" }, ...cardItems()]));
  command("tag", "Tag this worktree's card: /tag a b adds, /tag -a removes, /tag lists", async (args, ctx) => {
    const own = await ownCard(ctx);
    if (!args)
      return own.tags.length ? `${own.id} tags: ${own.tags.join(", ")}` : `${own.id} has no tags`;
    const words = args.split(/\s+/);
    const drop = new Set(words.filter((w) => w.startsWith("-")).map((w) => w.slice(1).toLowerCase()));
    const tags = [...new Set([...own.tags, ...words.filter((w) => !w.startsWith("-"))])].filter((tag) => !drop.has(tag.toLowerCase()));
    const t = await api("PATCH", `/api/tasks/${own.id}`, { tags });
    return t.tags.length ? `${t.id} tags: ${t.tags.join(", ")}` : `${t.id} has no tags`;
  }, (prefix) => completeLast(prefix, tagItems()));
  command("land", "Land this worktree's card: merge into its parent branch when stacked, else open a pull request (/land pr|merge forces one)", async (args, ctx) => {
    const how = args.toLowerCase();
    if (how && how !== "pr" && how !== "merge")
      throw new Error("Usage: /land [pr|merge]");
    return land(ctx, undefined, how ? how : undefined);
  }, (prefix) => completeLast(prefix, [
    { label: "merge", value: "merge", description: "Merge into its parent branch" },
    { label: "pr", value: "pr", description: "Open a pull request" }
  ]));
  pi.on("before_agent_start", async (_event, ctx) => {
    if (ctx.agent?.kind === "sub" || !task)
      return;
    serverCwd = ctx.cwd;
    const board = await api("GET", "/api/state", undefined, false).catch(() => latest);
    return { message: { customType: "mission-control.context", content: taskContext(task, board), display: false, attribution: "agent" } };
  });
  pi.on("plan_review_requested", (_event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    reviewOpen = true;
    planForYou = !(lastControl?.loop.plan === "ai" && lastControl.status !== "paused");
    if (task)
      report(ctx, planForYou ? "plan_ready" : "planning", planForYou ? undefined : "Control reviews the plan");
  });
  pi.on("plan_review_resolved", (event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    reviewOpen = false;
    planForYou = false;
    if (!event.choice || event.choice === "save")
      report(ctx, "idle");
    if (!task || !event.choice || !PLAN_APPROVALS[event.choice])
      return;
    const id = task;
    api("POST", `/api/tasks/${id}/planned`, {}, false).then((r) => {
      if (!r.hold)
        return;
      holding = r.waitingFor?.length ? `waiting for ${r.waitingFor.join(", ")}` : "waiting for a free task slot";
      const current2 = controlCtx ?? ctx;
      if (!current2.isIdle())
        stopHeld(current2);
    }, (e) => ctx.ui.notify(`${taskNumber(id)}: the board didn't record the approved plan: ${errorText(e)}`, "warning"));
  });
  pi.registerTool({
    name: "mission_control_tasks",
    label: "Mission Control tasks",
    description: "List the Mission Control cards of this project: first the tags in use, then each open card with column, title, branch and base, tags, links (depends on, parent, children), what it waits for, agent state and pull request (number, state, checks, review, conflicts); then its done cards; then the project's other worktrees that have no card. all lists every project.",
    parameters: z.object({ all: z.boolean().optional() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer((async () => {
        const board = await api("GET", "/api/state");
        const project = sessionProject(board, ctx);
        const projects = params.all === true || !project ? board.projects : [project];
        return listTasks(board, projects, task ?? undefined);
      })());
    }
  });
  pi.registerTool({
    name: "mission_control_task",
    label: "Mission Control task",
    description: "Start separate work in its own worktree: its omp plans the prompt and the user reviews that plan there. Use `after` (a card number) when it builds on a card: it branches from that card's branch and waits for it. Give one to three tags naming the product area, reusing `mission_control_tasks`' tags. Call it when the user asks for a task or to split work, never for work you do in this session.",
    parameters: z.object({
      prompt: z.string().min(1),
      title: z.string().optional(),
      tags: z.array(z.string()).optional(),
      after: z.string().optional(),
      base: z.string().optional(),
      loop: z.string().optional()
    }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer((async () => {
        const after = params.after?.trim() ? await cardId(params.after, ctx) : undefined;
        const t = await createTask(ctx, { ...params, after });
        return `Created ${createdText(t)}`;
      })());
    }
  });
  pi.registerTool({
    name: "mission_control_adopt",
    label: "Mission Control adopt",
    description: "Track a linked git worktree (default: this checkout) as a Mission Control card, with an optional title and tags. Returns its card when it already has one. No agent starts until the card is moved to In Progress.",
    parameters: z.object({ path: z.string().optional(), title: z.string().optional(), tags: z.array(z.string()).optional() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer(api("POST", "/api/worktrees/adopt", { ...params, path: params.path ?? checkoutRoot(ctx.cwd) }).then((t) => `${t.id} ${t.title} \xB7 ${t.branch} from ${t.base} \xB7 ${t.column}`));
    }
  });
  pi.registerTool({
    name: "mission_control_edit",
    label: "Mission Control edit",
    description: `Change a Mission Control card's title, replace its tags or dependencies ([] clears), or set its parent (a card of the same project, or "none" to clear it; it groups cards, use dependsOn for ordering, though a child also waits for its parent tree's dependencies). The prompt is fixed once the task exists: tell its agent with mission_control_message.`,
    parameters: z.object({
      id: z.string(),
      title: z.string().optional(),
      tags: z.array(z.string()).optional(),
      dependsOn: z.array(z.string()).optional(),
      parent: z.string().optional()
    }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const fields = ["title", "tags", "dependsOn", "parent"].filter((k) => params[k] !== undefined);
      if (!fields.length)
        return toolReply("Nothing to change: pass title, tags, dependsOn or parent", true);
      return answer((async () => {
        const id = await cardId(params.id, ctx);
        const changes = {};
        if (params.title !== undefined)
          changes.title = params.title;
        if (params.tags !== undefined)
          changes.tags = params.tags;
        if (params.dependsOn !== undefined)
          changes.dependsOn = await cardIds(params.dependsOn, ctx);
        if (params.parent !== undefined)
          changes.parent = /^(none)?$/i.test(params.parent.trim()) ? null : await cardId(params.parent, ctx);
        const t = await api("PATCH", `/api/tasks/${id}`, changes);
        return `Updated ${id}: ${fields.map((k) => k === "parent" ? t.parent ? `parent ${t.parent}` : "parent cleared" : k === "tags" ? `tags ${t.tags.join(", ") || "none"}` : k).join(", ")}`;
      })());
    }
  });
  pi.registerTool({
    name: "mission_control_link",
    label: "Mission Control link",
    description: "Make a Mission Control card depend on other cards: once its plan is approved it waits until every open dependsOn card is done. A done card can be a dependency too: it doesn't block, and its recorded outcome goes into the card's brief.",
    parameters: z.object({ task: z.string(), dependsOn: z.array(z.string()).min(1) }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer((async () => {
        const id = await cardId(params.task, ctx);
        const deps = await addDependencies(id, await cardIds(params.dependsOn, ctx));
        return `${id} now depends on ${deps.join(", ")}`;
      })());
    }
  });
  pi.registerTool({
    name: "mission_control_children",
    label: "Mission Control children",
    description: "Show a Mission Control card's hierarchy: its parent and its direct children, each with column and what it waits on.",
    parameters: z.object({ id: z.string() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer((async () => {
        const board = await api("GET", "/api/state");
        return childrenText(board, findTask(board, await cardId(params.id, ctx)));
      })());
    }
  });
  pi.registerTool({
    name: "mission_control_move",
    label: "Mission Control move",
    description: "Move a Mission Control card as dragging it on the board does. waiting pauses its agent (worktree and session stay, it frees its task slot) until it's moved to doing (In Progress), which resumes it now; doing is refused while it waits for open dependencies unless force; doing also starts again a card whose start failed. done records it as done without merging. Other columns are reached on their own. Use it when the user asks to pause, hold, resume or finish a card.",
    parameters: z.object({ id: z.string(), column: z.enum(["waiting", "doing", "done"]), force: z.boolean().optional() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer(moveCard(ctx, params.id, params.column, params.force === true));
    }
  });
  pi.registerTool({
    name: "mission_control_stop",
    label: "Mission Control stop",
    description: "Stop a Mission Control card's agent when the user asks: its omp session exits and its terminal closes, while its worktree, branch and session stay. A planning or In Progress card waits in Waiting until moved to In Progress, which reopens omp on the same session. To only pause it, use mission_control_move to waiting.",
    parameters: z.object({ id: z.string() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer((async () => {
        const id = await cardId(params.id, ctx);
        const t = await api("POST", `/api/tasks/${id}/stop`, {});
        return `Stopped ${id}: its omp session ended; its worktree and branch ${t.branch} stay${t.column === "waiting" ? ", and it waits in Waiting" : ""}.${t.note ? ` ${t.note}.` : ""}`;
      })());
    }
  });
  pi.registerTool({
    name: "mission_control_message",
    label: "Mission Control message",
    description: "Send a message to a Mission Control card's agent, as if typed in its omp: an idle agent starts a turn with it, a working one gets it at its next step. Refuses paused cards, disconnected agents, and agents waiting for plan review or an answer (the user answers in its terminal; mission_control_tasks shows how to reach it).",
    parameters: z.object({ id: z.string(), text: z.string() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer((async () => {
        const id = await cardId(params.id, ctx);
        const r = await api("POST", `/api/tasks/${id}/message`, { text: params.text });
        return `Sent to ${id}'s agent: ${r.message}`;
      })());
    }
  });
  pi.registerTool({
    name: "mission_control_screen",
    label: "Mission Control screen",
    description: "Read the last lines of a Mission Control card's agent terminal: what it is doing, asking or showing now.",
    parameters: z.object({ id: z.string() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer((async () => {
        const id = await cardId(params.id, ctx);
        const r = await api("GET", `/api/tasks/${id}/screen`);
        return r.text || `${id}'s screen is empty`;
      })());
    }
  });
  pi.registerTool({
    name: "mission_control_diff",
    label: "Mission Control diff",
    description: "Show a Mission Control card's changes against its base branch: the diffstat, then the diff (long diffs are cut).",
    parameters: z.object({ id: z.string() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer((async () => {
        const id = await cardId(params.id, ctx);
        const d = await api("GET", `/api/tasks/${id}/diff`);
        const cut = d.truncated || d.diff.length > DIFF_TOOL_LIMIT;
        const diff = d.diff.slice(0, DIFF_TOOL_LIMIT);
        return `${id} compared with ${d.base}
${d.stat || "No changes"}${diff ? `

${diff}` : ""}${cut ? `

[diff cut; the board's Diff view shows all of it]` : ""}`;
      })());
    }
  });
  pi.registerTool({
    name: "mission_control_context",
    label: "Mission Control context",
    description: "Read the shared context a Mission Control card recorded: reusable findings and its outcome, each with the source task, branch@commit and time, plus the revision. Without id, this session's own task. Use it for a dependency or sibling whose work yours builds on, or to see what changed since the revision your brief shows.",
    parameters: z.object({ id: z.string().optional() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer((async () => {
        const id = params.id ? await cardId(params.id, ctx) : task;
        if (!id)
          throw new Error("Name the card to read: this session has no task of its own");
        return contextText(await api("GET", `/api/tasks/${id}/context`));
      })());
    }
  });
  pi.registerTool({
    name: "mission_control_publish",
    label: "Mission Control publish",
    description: "Record shared context on a Mission Control card, stamped with the source task, its branch@commit and the time. kind finding: a concise, reusable fact other tasks need (a decision, contract, gotcha, where something lives). kind outcome: what this task delivered, where, and how dependents use it; record it before finishing. Cards that depend on it get the latest outcome and findings in their brief; any task reads them with mission_control_context. Not a log: no progress updates, transcripts or diffs. Without id, this session's own task.",
    parameters: z.object({ kind: z.enum(["finding", "outcome"]), text: z.string().min(1), id: z.string().optional() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer((async () => {
        const id = params.id ? await cardId(params.id, ctx) : task;
        if (!id)
          throw new Error("Name the card to record on: this session has no task of its own");
        const c = await api("POST", `/api/tasks/${id}/context`, { kind: params.kind, text: params.text, source: task ?? "mission-control" });
        return `Recorded a ${params.kind} on ${id} (revision ${c.revision}, ${c.entries.length} entr${c.entries.length === 1 ? "y" : "ies"})`;
      })());
    }
  });
  pi.registerTool({
    name: "mission_control_land",
    label: "Mission Control land",
    description: "Land a Mission Control card when the user says to merge, ship it or that it's done (that request is the approval; never because you judge the work finished). A card branched from another task's branch merges into that branch (committing pending changes); other cards get a pull request (its live agent is asked to commit, push and open it). how forces merge or pr. Without id, this session's own card: a merge then removes its worktree and ends this session. With another card's id, the user chooses whether to keep its worktree.",
    parameters: z.object({ id: z.string().optional(), how: z.enum(["merge", "pr"]).optional() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer(land(ctx, params.id, params.how));
    }
  });
  pi.registerTool({
    name: "mission_control_cleanup",
    label: "Mission Control cleanup",
    description: "Remove a Mission Control card's worktree after the user confirms: deletes the worktree and its branch and ends its omp and terminal. A card that isn't done goes with it.",
    parameters: z.object({ id: z.string() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer(cleanupCard(ctx, params.id));
    }
  });
  pi.registerTool({
    name: "mission_control_delete",
    label: "Mission Control delete",
    description: "Delete a Mission Control card after the user confirms; for a card with a worktree the user also chooses whether its worktree and branch go with it.",
    parameters: z.object({ id: z.string() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer(deleteCard(ctx, params.id));
    }
  });
}
export {
  missionControl as default
};
