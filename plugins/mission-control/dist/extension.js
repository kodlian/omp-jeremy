// @bun
// plugins/mission-control/omp/mission-control.ts
import { spawn, spawnSync } from "child_process";
import { closeSync, mkdirSync, openSync, readdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import * as omp from "@oh-my-pi/pi-coding-agent";

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

// packages/integrations/src/fonts.ts
var fonts = new Map;

// packages/integrations/src/theme.ts
var THEME_EXPORTS = ["getCurrentThemeName", "getResolvedThemeColors", "getThemeExportColors", "isLightTheme", "onThemeChange"];
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

// plugins/mission-control/omp/mission-control.ts
var BASE = `http://127.0.0.1:${process.env.MISSION_CONTROL_PORT || "4747"}`;
var HOME = process.env.MISSION_CONTROL_HOME || join(homedir(), ".mission-control");
var PYTHON = process.env.MISSION_CONTROL_PYTHON || "python3";
var SERVER = join(dirname(realpathSync(import.meta.path)), "..", "server.py");
var SERVER_ROOT = dirname(SERVER);
var START_TIMEOUT_MS = 30000;
var STEP_MS = 2000;
var RETRY_MS = 3000;
var UNKNOWN_CHECKOUT_MS = 60000;
var HEARTBEAT_MS = 20000;
var HOLD_POLL_MS = 1e4;
var FOLLOW_POLL_MS = 5000;
var HOLD_ENTRY = "mission-control.hold";
var HOLD_WIDGET = "mission-control.hold";
var FOLLOW_ENTRY = "mission-control.follow";
var MAX_SUBAGENTS = 6;

class BoardError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
var tilde = (path) => path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
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
async function launch() {
  mkdirSync(HOME, { recursive: true });
  const log = openSync(join(HOME, "server.log"), "a");
  const spawned = {};
  try {
    const child = spawn(PYTHON, [SERVER], { cwd: serverCwd, env: process.env, detached: true, stdio: ["ignore", log, log] });
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
async function refreshBoard(running) {
  const mtimes = readdirSync(SERVER_ROOT).filter((name) => name.endsWith(".py")).map((name) => statSync(join(SERVER_ROOT, name)).mtimeMs / 1000);
  if (!mtimes.length)
    return;
  const mtime = Math.max(...mtimes);
  if (Math.floor(mtime) <= Math.floor(running.codeMtime))
    return;
  await exclusive(async () => {
    const restarting = await api("POST", "/api/restart", {}, false).then(() => true, () => false);
    if (!restarting) {
      try {
        process.kill(running.pid, "SIGTERM");
      } catch {}
    }
    const deadline = Date.now() + 60000;
    let now = await health();
    while (Date.now() < deadline && now?.started === running.started) {
      await Bun.sleep(100);
      now = await health();
    }
    const grace = Date.now() + (restarting ? 5000 : 0);
    while (!now && Date.now() < grace) {
      await Bun.sleep(100);
      now = await health();
    }
    if (!now)
      await launch();
  });
}
async function ensureBoard() {
  const running = await health();
  if (running)
    await refreshBoard(running);
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
  return data;
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
function mainCheckout(cwd) {
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  return common ? realpath(dirname(common)) : null;
}
function stepText(event) {
  if (event.intent)
    return event.intent;
  const detail = [field(event.args, "path"), field(event.args, "pattern"), field(event.args, "query")].find((v) => typeof v === "string") ?? "";
  return `${event.toolName} ${detail}`.trim();
}
function field(value, key) {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
function oneLine(text, max = 300) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}
function lastSentence(text, finished) {
  const parts = text.slice(-1200).replace(/```[\s\S]*?(?:```|$)/g, `
`).split(/(?<=[.!?\u2026])\s+|\n+/);
  if (!finished)
    parts.pop();
  for (let i = parts.length - 1;i >= 0; i--) {
    const plain = parts[i].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|[`*]/g, "").replace(/^\s*(?:#+|[-+>]|\d+\.)\s+/, "").trim();
    if (plain.length > 2 && !plain.startsWith("|"))
      return oneLine(plain);
  }
  return null;
}
function todoProgress(result) {
  const phases = field(field(result, "details"), "phases");
  if (!Array.isArray(phases))
    return;
  const tasks = phases.flatMap((phase) => {
    const list = field(phase, "tasks");
    return Array.isArray(list) ? list : [];
  }).map((t) => ({ content: field(t, "content"), status: field(t, "status") })).filter((t) => t.status !== "dropped" && t.status !== "abandoned");
  if (!tasks.length)
    return null;
  const current = tasks.find((t) => t.status === "in_progress")?.content;
  return { done: tasks.filter((t) => t.status === "completed").length, total: tasks.length, current: typeof current === "string" ? oneLine(current, 200) : null };
}
function askQuestion(args) {
  const questions = field(args, "questions");
  const first = Array.isArray(questions) ? field(questions[0], "question") : undefined;
  return typeof first === "string" && first.trim() ? oneLine(first) : null;
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
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
var COLUMNS = { planning: "Planning", waiting: "Waiting", doing: "In Progress", uncommitted: "Uncommitted", paused: "Paused", pr: "Pull Request", idle: "Idle", done: "Done" };
var columnName = (column) => COLUMNS[column] ?? column;
var named = (w) => w.folder ? `${w.title} (${w.folder})` : w.title;
var isStrings = (value) => Array.isArray(value) && value.every((v) => typeof v === "string");
function checkoutAt(board, cwd) {
  const paths = [cwd, realpath(cwd) ?? cwd];
  let found;
  for (const w of board.worktrees) {
    if (!paths.some((p) => p === w.path || p.startsWith(`${w.path}/`)))
      continue;
    if (!found || w.path.length > found.path.length)
      found = w;
  }
  return found;
}
function findCheckout(board, ref, project) {
  const pool = board.worktrees.filter((w) => !project || w.project === project);
  const exact = pool.filter((w) => w.key === ref);
  const lower = ref.toLowerCase();
  const matches = exact.length ? exact : pool.filter((w) => w.key.toLowerCase() === lower || w.title.toLowerCase() === lower);
  if (matches.length === 1)
    return matches[0];
  if (!matches.length)
    throw new Error(`No checkout named ${ref}${project ? ` in ${project}` : ""}`);
  throw new Error(`${ref} names several checkouts: ${matches.map((w) => `${w.key} (${w.project})`).join(", ")}`);
}
var checkoutOf = (board, project, key) => board.worktrees.find((w) => w.project === project && w.key === key);
function withColumns(board, project, keys) {
  return keys.map((key) => {
    const w = checkoutOf(board, project, key);
    return w ? `${key} (${columnName(w.column)})` : key;
  }).join(", ");
}
var titlesOf = (board, project, keys) => keys.map((key) => checkoutOf(board, project, key)?.title ?? key);
function openPrerequisites(board, w, keys) {
  return keys.filter((key) => {
    const prerequisite = checkoutOf(board, w.project, key);
    return w.dependsOn.includes(key) && prerequisite !== undefined && prerequisite.column !== "done";
  });
}
function dependencies(board, w) {
  const lines = [`${named(w)} depends on ${w.dependsOn.length ? withColumns(board, w.project, w.dependsOn) : "nothing"}`];
  if (w.waitingFor.length)
    lines.push(`waiting for ${w.waitingFor.join(", ")}`);
  lines.push(`needed by ${w.neededBy.length ? withColumns(board, w.project, w.neededBy) : "nothing"}`);
  return lines.join(`
`);
}
function tagsText(w) {
  const ruled = w.tags.filter((t) => !w.ownTags.includes(t));
  const own = w.ownTags.length ? `${named(w)} tags: ${w.ownTags.join(", ")}` : `${named(w)} has no tags of its own`;
  return ruled.length ? `${own} \xB7 from tag rules: ${ruled.join(", ")}` : own;
}
function editTags(current, add, remove) {
  const drop = new Set(remove.map((t) => t.toLowerCase()));
  return [...new Set([...current, ...add.map((t) => t.toLowerCase())])].filter((t) => !drop.has(t.toLowerCase()));
}
function checkoutLine(board, w) {
  const parts = [`${named(w)}${w.main ? " (main checkout)" : ""}`, w.branch ?? `detached ${w.detached}`, tilde(w.path), columnName(w.column)];
  if (w.dependsOn.length)
    parts.push(`depends on ${withColumns(board, w.project, w.dependsOn)}`);
  if (w.neededBy.length)
    parts.push(`needed by ${withColumns(board, w.project, w.neededBy)}`);
  if (w.waitingFor.length)
    parts.push(`waiting for ${w.waitingFor.join(", ")}`);
  if (w.git) {
    const work = [`+${w.git.added} \u2212${w.git.removed} in ${plural(w.git.files, "file")}`, plural(w.git.commits, "commit")];
    if (w.git.dirty)
      work.push(`${w.git.dirty} uncommitted`);
    parts.push(work.join(", "));
  }
  if (w.pr) {
    const pr = [`PR #${w.pr.number} ${w.pr.state}`];
    if (w.pr.checks)
      pr.push(`checks ${w.pr.checks}`);
    if (w.pr.review)
      pr.push(w.pr.review.replace("_", " "));
    if (w.pr.unresolved)
      pr.push(plural(w.pr.unresolved, "unresolved comment"));
    parts.push(pr.join(", "));
  }
  if (w.tags.length)
    parts.push(`tags ${w.tags.join(", ")}`);
  if (w.agents.length) {
    const running = w.agents.map((a) => {
      const bits = [a.title ? `"${a.title}"` : "omp", a.state.replace("_", " ")];
      if (a.step)
        bits.push(a.step);
      if (a.todo)
        bits.push(`to-do ${a.todo.done}/${a.todo.total}`);
      if (a.subagents.length)
        bits.push(plural(a.subagents.length, "subagent"));
      if (a.waitingFor.length)
        bits.push(`holds its plan for ${a.waitingFor.join(", ")}`);
      return bits.join(", ");
    });
    parts.push(`running: ${running.join("; ")}`);
  } else if (w.agent.state === "asleep") {
    parts.push(`asleep since ${w.agent.at?.slice(0, 10) ?? "?"} (session ${w.agent.session?.id ?? "?"})`);
  } else {
    parts.push("no omp session");
  }
  return parts.join(" \xB7 ");
}
function listCheckouts(board, projects) {
  const lines = [];
  for (const p of projects) {
    if (lines.length)
      lines.push("");
    lines.push(`Project ${p.id} (${tilde(p.repo)}, default branch ${p.defaultBranch})`);
    const checkouts = board.worktrees.filter((w) => w.project === p.id);
    for (const w of checkouts)
      lines.push(`- ${checkoutLine(board, w)}`);
    if (!checkouts.length)
      lines.push("- no checkouts");
  }
  return lines.length ? lines.join(`
`) : "No projects registered: /mission registers this one";
}
function completeLast(prefix, items) {
  const at = prefix.lastIndexOf(" ") + 1;
  const head = prefix.slice(0, at);
  const word = prefix.slice(at).toLowerCase();
  const matches = items.filter((v) => v.value.toLowerCase().startsWith(word) || v.also?.toLowerCase().startsWith(word)).map((v) => ({ label: v.label, value: head + v.value, description: v.description }));
  return matches.length ? matches : null;
}
function asHold(value) {
  const keys = field(value, "keys");
  const titles = field(value, "titles");
  return isStrings(keys) && isStrings(titles) && keys.length ? { keys, titles } : null;
}
function asFollowed(value) {
  if (!Array.isArray(value))
    return [];
  return value.flatMap((f) => {
    const project = field(f, "project");
    const key = field(f, "key");
    return typeof project === "string" && typeof key === "string" ? [{ project, key }] : [];
  });
}
var themeApi = hasThemeApi(omp);
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
function missionControl(pi) {
  const z = pi.zod;
  let projectId = null;
  let sessionId = "";
  let sessionFile = null;
  let reportPath = "";
  let reporting;
  let shuttingDown = false;
  let reported = "";
  let current = "";
  let planning = false;
  let reviewOpen = false;
  let currentStep = null;
  let reportedStep = null;
  let runStart = 0;
  let todo = null;
  let said = null;
  let question = null;
  let lastMessage = null;
  const subagents = new Map;
  let reportedDetail = "";
  const detailKey = () => JSON.stringify([runStart, todo, said, question, hold?.keys, [...subagents.values()]]);
  let stepTimer;
  let resendTimer;
  let retryAt = 0;
  let sentAt = 0;
  let reports = Promise.resolve();
  let themeVersion = 0;
  let themeOff;
  let sessionCtx = null;
  let lastBoard = null;
  let boardAt = 0;
  let hold = null;
  let stopRun = false;
  let carryHold = false;
  let holdTimer;
  let followed = [];
  const seen = new Map;
  let followTimer;
  let holdLine = null;
  const syncTheme = () => {
    if (!themeApi || !projectId)
      return;
    const mine = ++themeVersion;
    const project = projectId;
    themeAppearance().then((look) => themeVersion === mine ? api("POST", "/api/appearance", { project, ...look }, false) : undefined).catch(() => {});
  };
  const clearTimers = () => {
    clearTimeout(stepTimer);
    clearTimeout(resendTimer);
    themeOff?.();
    themeOff = undefined;
    clearInterval(holdTimer);
    clearInterval(followTimer);
    stepTimer = resendTimer = holdTimer = followTimer = undefined;
  };
  const send = () => {
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
      subagents: [...subagents.values()],
      question,
      waitingFor: state === "waiting" && hold ? hold.keys : []
    };
    reports = reports.then(async () => {
      const found = await callerTerminal();
      const ok = await api("POST", "/api/agent", { ...body, terminal: "context" in found ? found.context : null }, false).then(() => true, (e) => {
        reported = "";
        retryAt = Date.now() + (!(e instanceof BoardError) ? HEARTBEAT_MS : e.status === 404 ? UNKNOWN_CHECKOUT_MS : RETRY_MS);
        return false;
      });
      if (shuttingDown || state === "exited")
        return;
      clearTimeout(resendTimer);
      resendTimer = setTimeout(() => {
        resendTimer = undefined;
        send();
      }, ok ? HEARTBEAT_MS : retryAt - Date.now());
    });
    return reports;
  };
  const report = (ctx, state, step = null) => {
    if (ctx.agent?.kind === "sub" || shuttingDown)
      return reports;
    current = state;
    currentStep = step;
    reportPath = ctx.cwd;
    if (state === reported && step === reportedStep && detailKey() === reportedDetail)
      return reports;
    reporting ??= mainCheckout(ctx.cwd) !== null;
    if (!reporting || Date.now() < retryAt)
      return reports;
    const wait = sentAt + STEP_MS - Date.now();
    if (state === reported && wait > 0) {
      stepTimer ??= setTimeout(() => {
        stepTimer = undefined;
        if (current !== reported || currentStep !== reportedStep || detailKey() !== reportedDetail)
          send();
      }, wait);
      return reports;
    }
    return send();
  };
  const resting = () => hold ? "waiting" : reviewOpen ? "plan_ready" : "idle";
  const readBoard = async (autostart = true) => {
    lastBoard = await api("GET", "/api/state", undefined, autostart);
    boardAt = Date.now();
    return lastBoard;
  };
  const ownCheckout = async (ctx) => {
    const board = await readBoard();
    const own = checkoutAt(board, ctx.cwd);
    if (!own)
      throw new Error(`${tilde(ctx.cwd)} is in no checkout of a registered project: /mission registers it`);
    return { board, own };
  };
  const syncPolls = () => {
    if (hold)
      holdTimer ??= setInterval(() => void checkHold(), HOLD_POLL_MS);
    else {
      clearInterval(holdTimer);
      holdTimer = undefined;
    }
    if (followed.length)
      followTimer ??= setInterval(() => void checkFollowed(), FOLLOW_POLL_MS);
    else {
      clearInterval(followTimer);
      followTimer = undefined;
    }
  };
  const showHold = (board = lastBoard) => {
    const ctx = sessionCtx;
    if (!ctx)
      return;
    const own = hold && board ? checkoutAt(board, ctx.cwd) : undefined;
    const names = hold ? board && own ? titlesOf(board, own.project, hold.keys) : hold.keys : [];
    const line = hold ? `\u23F8 Approved plan on hold: waiting for ${names.join(", ")} to be Done \xB7 it starts on its own once they land` : undefined;
    if (line === holdLine)
      return;
    holdLine = line;
    ctx.ui.setWidget(HOLD_WIDGET, line ? [line] : undefined);
  };
  const setHold = (next, board = lastBoard) => {
    hold = next;
    pi.appendEntry(HOLD_ENTRY, { hold: next });
    syncPolls();
    showHold(board);
  };
  const stopHeld = (ctx) => {
    stopRun = false;
    ctx.abort();
    report(ctx, "waiting");
  };
  const holdApproved = async (ctx) => {
    const board = await readBoard(false);
    const own = checkoutAt(board, ctx.cwd);
    const keys = own ? openPrerequisites(board, own, own.waitingFor) : [];
    if (!own || !keys.length)
      return;
    const titles = titlesOf(board, own.project, keys);
    carryHold = true;
    setHold({ keys, titles }, board);
    ctx.ui.notify(`Plan approved \xB7 on hold until ${titles.join(", ")} ${titles.length > 1 ? "are" : "is"} Done`, "info");
    const live = sessionCtx ?? ctx;
    if (live.isIdle()) {
      stopRun = true;
      report(live, "waiting");
    } else {
      stopHeld(live);
    }
  };
  const checkHold = async () => {
    const ctx = sessionCtx;
    const board = ctx && hold ? await readBoard(false).catch(() => null) : null;
    const own = board && ctx ? checkoutAt(board, ctx.cwd) : undefined;
    if (!ctx || !hold || !board || !own)
      return;
    const open = openPrerequisites(board, own, hold.keys);
    if (open.length === hold.keys.length)
      return;
    if (open.length) {
      setHold({ keys: open, titles: hold.titles }, board);
      if (current === "waiting")
        report(ctx, "waiting");
      return;
    }
    const text = `${hold.titles.join(", ")} landed: rebase on ${own.base} if it moved, then implement the approved plan.`;
    setHold(null);
    stopRun = false;
    if (current === "waiting")
      report(ctx, resting());
    if (ctx.isIdle())
      pi.sendUserMessage(text);
    else
      pi.sendUserMessage(text, { deliverAs: "followUp" });
  };
  const saveFollowed = (next) => {
    followed = next;
    pi.appendEntry(FOLLOW_ENTRY, { followed });
    syncPolls();
  };
  const checkFollowed = async () => {
    const ctx = sessionCtx;
    const board = ctx && followed.length ? await readBoard(false).catch(() => null) : null;
    if (!ctx || !board)
      return;
    const keep = [];
    for (const f of followed) {
      const id = `${f.project}
${f.key}`;
      const w = checkoutOf(board, f.project, f.key);
      if (!w) {
        seen.delete(id);
        continue;
      }
      const before = seen.get(id);
      const now = { column: w.column, states: w.agents.map((a) => a.state), checks: w.pr?.checks ?? null, review: w.pr?.review ?? null };
      seen.set(id, now);
      if (w.column === "done")
        seen.delete(id);
      else
        keep.push(f);
      if (!before)
        continue;
      const n = named(w);
      const entered = (state) => now.states.includes(state) && !before.states.includes(state);
      if (entered("plan_ready"))
        ctx.ui.notify(`${n}: plan ready for review`, "warning");
      if (entered("needs_input")) {
        const asked = w.agents.find((a) => a.state === "needs_input")?.question;
        ctx.ui.notify(`${n} needs your input${asked ? `: ${asked}` : ""}`, "warning");
      }
      if (now.column !== before.column) {
        if (now.column === "waiting")
          ctx.ui.notify(`${n} is waiting for ${titlesOf(board, w.project, w.waitingFor).join(", ")}`, "info");
        else if (now.column === "uncommitted")
          ctx.ui.notify(`${n} has uncommitted changes and nothing at work`, "info");
        else if (now.column === "paused")
          ctx.ui.notify(`${n} paused: it has commits and no pull request yet`, "info");
        else if (now.column === "done")
          ctx.ui.notify(w.pr?.state === "merged" ? `${n}: PR #${w.pr.number} merged` : `${n} is done: it landed`, "info");
      }
      if (w.pr && now.checks === "failing" && before.checks !== "failing")
        ctx.ui.notify(`${n}: PR #${w.pr.number} checks failing`, "warning");
      if (w.pr && now.review === "changes_requested" && before.review !== "changes_requested")
        ctx.ui.notify(`${n}: PR #${w.pr.number} changes requested`, "warning");
    }
    if (keep.length !== followed.length)
      saveFollowed(keep);
  };
  const newWorktree = async (ctx, prompt, stack, branch) => {
    if (!prompt)
      throw new Error(`Say what to plan: /${stack ? "next" : "task"} <prompt>`);
    const { own } = await ownCheckout(ctx);
    if (stack && !own.branch)
      throw new Error(`${named(own)} is on a detached HEAD: nothing can stack on it`);
    const from = stack ? { after: own.key } : own.branch ? { base: own.branch } : {};
    const made = await api("POST", "/api/worktrees/new", {
      project: own.project,
      prompt,
      branch: branch || undefined,
      ...from
    });
    saveFollowed([...followed.filter((f) => f.project !== own.project || f.key !== made.key), { project: own.project, key: made.key }]);
    const where = stack ? `stacked on ${own.key}, which it waits for` : `from ${own.branch ?? "the default branch"}`;
    const run = made.opened ? "Its omp opened in its own terminal and plans the prompt." : made.command ? `No terminal opened: run ${made.command}` : "No terminal opened.";
    return `Created ${made.key} at ${tilde(made.path)}, ${where}.
${run}
This session is told when it moves along.`;
  };
  const link = async (board, dependent, prerequisite, remove) => {
    const from = remove && dependent.dependsOn.includes(prerequisite) ? prerequisite : findCheckout(board, prerequisite, dependent.project).key;
    await api("PATCH", "/api/projects/links", { id: dependent.project, from, to: dependent.key, linked: !remove });
  };
  const saveTags = async (w, tags) => {
    await api("PATCH", "/api/projects/tags", { id: w.project, key: w.key, tags });
    const board = await readBoard();
    const now = checkoutOf(board, w.project, w.key);
    return now ? tagsText(now) : `${named(w)} tags: ${tags.join(", ")}`;
  };
  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    if ("prompt" in event && typeof event.prompt === "string")
      lastMessage = event.prompt.slice(0, 2000);
    runStart ||= Math.floor(Date.now() / 1000);
    said = null;
  });
  pi.on("turn_start", (_event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    if (stopRun) {
      stopHeld(ctx);
      return;
    }
    planning = inPlanMode(ctx);
    runStart ||= Math.floor(Date.now() / 1000);
    report(ctx, planning ? "planning" : "thinking");
  });
  pi.on("message_update", (event, ctx) => {
    if (ctx.agent?.kind === "sub" || !["planning", "thinking", "working"].includes(current))
      return;
    const update = event.assistantMessageEvent;
    if (update.type !== "thinking_delta" && update.type !== "thinking_end" && update.type !== "text_delta" && update.type !== "text_end")
      return;
    const content = field(event.message, "content");
    const block = Array.isArray(content) ? content[update.contentIndex] : undefined;
    const text = field(block, "thinking") ?? field(block, "text");
    const sentence = typeof text === "string" ? lastSentence(text, update.type.endsWith("_end")) : null;
    if (!sentence || sentence === said)
      return;
    said = sentence;
    report(ctx, current, currentStep);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    if (event.toolName === "ask")
      question = askQuestion(event.args);
    report(ctx, event.toolName === "ask" ? "needs_input" : planning ? "planning" : "working", stepText(event));
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    if (event.toolName === "todo") {
      const progress = todoProgress(event.result);
      if (progress === undefined)
        return;
      todo = progress;
      if (current)
        report(ctx, current, currentStep);
    } else if (event.toolName === "ask") {
      question = null;
      runStart = Math.floor(Date.now() / 1000);
      report(ctx, planning ? "planning" : "working");
    }
  });
  pi.on("agent_end", (event, ctx) => {
    if (ctx.agent?.kind === "sub" || "willContinue" in event && event.willContinue === true)
      return;
    runStart = 0;
    question = null;
    report(ctx, resting());
  });
  pi.on("plan_review_requested", (_event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    reviewOpen = true;
    report(ctx, "plan_ready");
  });
  pi.on("plan_review_resolved", (event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    reviewOpen = false;
    if (!event.choice || event.choice === "save")
      report(ctx, resting());
    if (event.choice && PLAN_APPROVALS[event.choice])
      holdApproved(ctx).catch(() => {});
  });
  const reportSubagents = () => {
    if (sessionCtx && current)
      report(sessionCtx, current, currentStep);
  };
  pi.events.on("task:subagent:progress", (data) => {
    if (!sessionCtx)
      return;
    const progress = field(data, "progress");
    const id = field(progress, "id");
    if (typeof id !== "string")
      return;
    const status = field(progress, "status");
    if (status !== "running" && status !== "pending") {
      if (subagents.delete(id))
        reportSubagents();
      return;
    }
    if (!subagents.has(id) && subagents.size >= MAX_SUBAGENTS)
      return;
    const name = [field(progress, "description"), field(progress, "agent"), field(data, "agent")].find((v) => typeof v === "string" && v.trim());
    const intent = field(progress, "lastIntent"), tool = field(progress, "currentTool");
    const sub = {
      name: oneLine(typeof name === "string" ? name : "subagent", 60),
      step: typeof intent === "string" && intent.trim() ? oneLine(intent, 200) : typeof tool === "string" && tool ? `Running ${tool}` : null
    };
    const was = subagents.get(id);
    if (was?.name === sub.name && was.step === sub.step)
      return;
    subagents.set(id, sub);
    reportSubagents();
  });
  pi.events.on("task:subagent:lifecycle", (data) => {
    const id = field(data, "id");
    if (sessionCtx && typeof id === "string" && field(data, "status") !== "started" && subagents.delete(id))
      reportSubagents();
  });
  const restore = (_event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    serverCwd = ctx.cwd;
    sessionCtx = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    let savedHold;
    let savedFollowed = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom")
        continue;
      if (entry.customType === HOLD_ENTRY)
        savedHold = asHold(field(entry.data, "hold"));
      else if (entry.customType === FOLLOW_ENTRY)
        savedFollowed = asFollowed(field(entry.data, "followed"));
    }
    if (savedHold === undefined && carryHold && hold)
      pi.appendEntry(HOLD_ENTRY, { hold });
    else
      hold = savedHold ?? null;
    carryHold = false;
    followed = savedFollowed;
    seen.clear();
    syncPolls();
    holdLine = null;
    showHold();
    subagents.clear();
    reported = "";
    retryAt = 0;
    const busy = ["planning", "thinking", "working", "needs_input"].includes(current);
    report(ctx, busy ? current : resting(), currentStep);
    readBoard(false).then((board) => {
      if (!hold)
        return;
      showHold(board);
      return checkHold();
    }, () => {});
  };
  pi.on("session_start", restore);
  pi.on("session_switch", restore);
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.agent?.kind === "sub" || shuttingDown)
      return;
    shuttingDown = true;
    clearTimers();
    if (!reporting)
      return;
    current = "exited";
    currentStep = null;
    await send();
    clearTimers();
  });
  pi.registerCommand("mission", {
    description: "Open Mission Control on this project",
    handler: async (_args, ctx) => {
      if (ctx.agent?.kind === "sub")
        return;
      serverCwd = ctx.cwd;
      try {
        await ensureBoard();
        const { project } = await api("POST", "/api/projects", { path: ctx.cwd });
        projectId = project.id;
        syncTheme();
        if (themeApi)
          themeOff ??= omp.onThemeChange(syncTheme);
        await openBoard(`${BASE}/?project=${encodeURIComponent(project.id)}`, { focus: true, python: PYTHON, overrideEnvs: TERMINAL_OVERRIDES });
        ctx.ui.notify(`Mission Control on ${project.name} (${project.defaultBranch})`, "info");
      } catch (e) {
        ctx.ui.notify(errorText(e), "error");
      }
    }
  });
  const command = (name, description, run, complete) => {
    pi.registerCommand(name, {
      description,
      getArgumentCompletions: complete,
      handler: async (args, ctx) => {
        if (ctx.agent?.kind === "sub")
          return;
        serverCwd = ctx.cwd;
        try {
          ctx.ui.notify(await run(args.trim(), ctx), "info");
        } catch (e) {
          ctx.ui.notify(errorText(e), "error");
        }
      }
    });
  };
  const completionCheckout = () => {
    if (Date.now() - boardAt > 5000)
      readBoard(false).catch(() => {});
    const own = lastBoard && sessionCtx ? checkoutAt(lastBoard, sessionCtx.cwd) : undefined;
    return lastBoard && own ? { board: lastBoard, own } : null;
  };
  const checkoutItems = (sign, only) => {
    const found = completionCheckout();
    if (!found)
      return [];
    return found.board.worktrees.filter((w) => w.project === found.own.project && w.key !== found.own.key && (!only || only.includes(w.key))).map((w) => ({ value: sign + w.key, label: sign + w.key, description: `${named(w)} \xB7 ${columnName(w.column)}`, also: sign + w.title }));
  };
  command("link", "Make this checkout depend on others: /link <branch|title>\u2026 adds, /link -<branch> removes, /link lists both directions", async (args, ctx) => {
    const { board, own } = await ownCheckout(ctx);
    if (!args)
      return dependencies(board, own);
    for (const word of args.split(/\s+/))
      await link(board, own, word.replace(/^-/, ""), word.startsWith("-"));
    const after = await ownCheckout(ctx);
    return dependencies(after.board, after.own);
  }, (prefix) => completeLast(prefix, [...checkoutItems(""), ...checkoutItems("-", completionCheckout()?.own.dependsOn ?? [])]));
  command("task", "Start work in a new worktree from this checkout's branch: its omp plans the prompt", (prompt, ctx) => newWorktree(ctx, prompt, false), () => null);
  command("next", "Start work that builds on this checkout: a new worktree stacked on its branch, waiting for it", (prompt, ctx) => newWorktree(ctx, prompt, true), () => null);
  command("tag", "Tag this checkout: /tag a b adds, /tag -a removes, /tag lists", async (args, ctx) => {
    const { own } = await ownCheckout(ctx);
    if (!args)
      return tagsText(own);
    const words = args.split(/\s+/);
    const remove = words.filter((w) => w.startsWith("-")).map((w) => w.slice(1));
    return saveTags(own, editTags(own.ownTags, words.filter((w) => !w.startsWith("-")), remove));
  }, (prefix) => {
    const found = completionCheckout();
    if (!found)
      return null;
    const tags = found.board.projects.find((p) => p.id === found.own.project)?.tags ?? [];
    return completeLast(prefix, [...tags.map((tag) => ({ value: tag, label: tag })), ...found.own.ownTags.map((tag) => ({ value: `-${tag}`, label: `-${tag}`, description: "Remove" }))]);
  });
  const toolCheckout = (board, ctx, ref) => {
    const here = checkoutAt(board, ctx.cwd);
    const w = ref ? findCheckout(board, ref, here?.project ?? null) : here;
    if (!w)
      throw new Error(`${tilde(ctx.cwd)} is in no checkout of a registered project: /mission registers it`);
    return w;
  };
  const answer = async (work) => {
    try {
      return toolReply(await work);
    } catch (e) {
      return toolReply(errorText(e), true);
    }
  };
  pi.registerTool({
    name: "mission_control_checkouts",
    label: "Mission Control checkouts",
    description: "Read-only: list the checkouts Mission Control shows for this project (all: every registered project). For each, its title (folder), branch (or detached commit, or the main checkout), path, column (Idle, Planning, Waiting, In Progress, Uncommitted, Paused, Pull Request, Done), what it depends on and what needs it with their columns, what it waits for, diff, commits and uncommitted files, pull request with checks, review and unresolved comments, tags, and every omp running there (title, state, step, to-do progress), else its latest asleep session.",
    parameters: z.object({ all: z.boolean().optional() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer(readBoard().then((board) => {
        const here = checkoutAt(board, ctx.cwd)?.project ?? projectId;
        const project = board.projects.find((p) => p.id === here);
        if (params.all !== true && !project)
          throw new Error(`${tilde(ctx.cwd)} is in no registered project: /mission registers it, all lists every project`);
        return listCheckouts(board, params.all === true || !project ? board.projects : [project]);
      }));
    }
  });
  pi.registerTool({
    name: "mission_control_link",
    label: "Mission Control link",
    description: "Make a checkout (dependent, default this one) depend on another checkout of its project (prerequisite), or remove that dependency with remove. Both take a branch (checkout key) or a title. While a prerequisite isn't Done the dependent waits: an omp there holds its approved plan until it lands. Replies with what the dependent then depends on and what needs it.",
    parameters: z.object({ prerequisite: z.string(), dependent: z.string().optional(), remove: z.boolean().optional() }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer((async () => {
        const board = await readBoard();
        const dependent = toolCheckout(board, ctx, params.dependent);
        await link(board, dependent, params.prerequisite, params.remove === true);
        const after = await readBoard();
        const now = checkoutOf(after, dependent.project, dependent.key);
        return now ? dependencies(after, now) : `${dependent.key} is gone`;
      })());
    }
  });
  pi.registerTool({
    name: "mission_control_task",
    label: "Mission Control task",
    description: "Start separate work in a new worktree whose omp plans prompt for the user to review. It branches from this checkout's branch; after: true stacks it on this checkout instead (branched from it and waiting for it to land). branch names it (default feature/<slug of the prompt>). Replies with its branch, path and whether its terminal opened (else the command to run); this session is then told when its plan is ready, it needs input, waits, pauses with commits and no pull request, its PR fails checks or gets changes requested, and when it's done.",
    parameters: z.object({ prompt: z.string(), branch: z.string().optional(), after: z.boolean().optional() }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer(newWorktree(ctx, params.prompt.trim(), params.after === true, params.branch));
    }
  });
  pi.registerTool({
    name: "mission_control_edit",
    label: "Mission Control edit",
    description: "Edit a checkout's own tags (checkout: a branch or title, default this one): tags replaces them, add and remove change them; none of them lists its tags. Replies with its tags, and those its project's tag rules add.",
    parameters: z.object({
      tags: z.array(z.string()).optional(),
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
      checkout: z.string().optional()
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return answer(readBoard().then((board) => {
        const w = toolCheckout(board, ctx, params.checkout);
        if (!params.tags && !params.add && !params.remove)
          return tagsText(w);
        return saveTags(w, editTags(params.tags ?? w.ownTags, params.add ?? [], params.remove ?? []));
      }));
    }
  });
}
export {
  missionControl as default
};
