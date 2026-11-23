// @bun
// packages/integrations/src/control.ts
var CONTROL_ASK_EVENT = "control:ask";
var CONTROL_SETS_EVENT = "control:sets";
function isControlRequest(data) {
  if (!data || typeof data !== "object")
    return false;
  const r = data;
  return typeof r.reply === "function" && (r.type === "sets" || r.type === "status");
}

// packages/integrations/src/text.ts
var errorText = (e) => e instanceof Error ? e.message : String(e);
var toolReply = (text, isError = false) => ({ content: [{ type: "text", text }], isError });

// plugins/control/src/git.ts
async function git(args, cwd, input) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}
async function must(args, cwd) {
  const r = await git(args, cwd);
  if (r.code !== 0)
    throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout;
}
async function repoRoot(cwd) {
  const r = await git(["rev-parse", "--show-toplevel"], cwd).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() : null;
}
async function baselineSha(root, baseline, note) {
  if (baseline.kind === "commit")
    return baseline.sha;
  const r = await git(["merge-base", "HEAD", baseline.ref], root);
  if (r.code === 0 && r.stdout.trim())
    return r.stdout.trim();
  note?.(`Couldn't find ${baseline.ref}; checking changes since HEAD`);
  return (await must(["rev-parse", "HEAD"], root)).trim();
}
async function defaultBranch(root) {
  const remote = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  if (remote.code === 0 && remote.stdout.trim())
    return remote.stdout.trim();
  for (const name of ["main", "master"])
    if ((await git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`], root)).code === 0)
      return name;
  return null;
}
async function untracked(root) {
  return (await must(["ls-files", "--others", "--exclude-standard", "-z"], root)).split("\x00").filter(Boolean);
}
async function fingerprint(root, sha) {
  const [diff, files] = await Promise.all([must(["diff", sha, "--binary", "--no-color"], root), untracked(root)]);
  if (!diff && !files.length)
    return "clean";
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(diff);
  hasher.update("\x00");
  if (files.length) {
    const r = await git(["hash-object", "--stdin-paths"], root, `${files.join(`
`)}
`);
    const ids = r.stdout.trim().split(`
`);
    files.forEach((file, i) => hasher.update(`${file}\x00${ids[i] ?? ""}\x00`));
  }
  return hasher.digest("hex");
}

// plugins/control/src/library.ts
import { realpathSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, join } from "path";

// plugins/control/src/frontmatter.ts
function scalar(raw, where) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string")
        return parsed;
    } catch {}
    throw new Error(`${where}: invalid quoted string`);
  }
  if (value.startsWith("'")) {
    const inner = value.slice(1, -1);
    if (value.length < 2 || !value.endsWith("'") || inner.replaceAll("''", "").includes("'"))
      throw new Error(`${where}: invalid single-quoted string`);
    return inner.replaceAll("''", "'");
  }
  return value;
}
function parseControlFile(text, path) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---")
    throw new Error(`${path}: must start with a --- header`);
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0)
    throw new Error(`${path}: the header has no closing ---`);
  const fields = {};
  let list = null;
  for (let i = 1;i < end; i++) {
    const line = lines[i];
    const where = `${path}:${i + 1}`;
    if (!line.trim() || line.trim().startsWith("#"))
      continue;
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item) {
      if (!list)
        throw new Error(`${where}: a list item needs a "key:" line above it`);
      list.push(scalar(item[1], where));
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!pair)
      throw new Error(`${where}: expected "key: value"`);
    const [, key, rest] = pair;
    if (key in fields)
      throw new Error(`${path}: duplicate key "${key}"`);
    if (!rest.trim()) {
      list = [];
      fields[key] = list;
      continue;
    }
    list = null;
    const value = scalar(rest, where);
    if (key === "timeout") {
      if (!/^\d+$/.test(value))
        throw new Error(`${path}: timeout must be a whole number of seconds`);
      fields[key] = Number(value);
    } else
      fields[key] = value;
  }
  return { fields, body: lines.slice(end + 1).join(`
`).trim() };
}

// plugins/control/src/library.ts
var ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
var BUILT_IN = join(dirname(realpathSync(import.meta.path)), "..", "library");
function libraryRoots(root) {
  return {
    repo: root ? join(root, ".omp", "control") : null,
    global: process.env.OMP_CONTROL_HOME || join(homedir(), ".omp", "control"),
    builtIn: BUILT_IN
  };
}
function optionalText(fields, key, path) {
  const value = fields[key];
  if (value === undefined || value === null || value === "")
    return null;
  if (typeof value !== "string")
    throw new Error(`${path}: ${key} must be text`);
  return value;
}
function checkId(id, path, what) {
  if (!ID.test(id))
    throw new Error(`${path}: ${what} "${id}" must be lowercase letters, digits and dashes (at most 63)`);
}
function checkName(name, path) {
  const text = typeof name === "string" ? name.trim() : "";
  if (text.length < 1 || text.length > 60)
    throw new Error(`${path}: name must be 1\u201360 characters`);
  return text;
}
function controlFrom(id, fields, body, path, source) {
  checkId(id, path, "control id");
  const name = checkName(fields.name, path);
  const kind = fields.kind;
  if (kind !== "check" && kind !== "review")
    throw new Error(`${path}: kind must be check or review`);
  const description = optionalText(fields, "description", path) ?? "";
  if (kind === "review") {
    if (!body.trim())
      throw new Error(`${path}: a reviewer needs instructions (the text after the header)`);
    return { id, name, kind, description, command: null, timeout: null, path, source };
  }
  const command = optionalText(fields, "command", path)?.trim();
  if (!command)
    throw new Error(`${path}: a check needs a command`);
  const timeout = fields.timeout ?? 900;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 7200)
    throw new Error(`${path}: timeout must be 1\u20137200 seconds`);
  return { id, name, kind, description, command, timeout, path, source };
}
function setFrom(id, raw, path, source) {
  checkId(id, path, "set id");
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${path}: must be a JSON object`);
  const value = raw;
  const name = checkName(value.name, path);
  const description = value.description ?? "";
  if (typeof description !== "string")
    throw new Error(`${path}: description must be text`);
  const controls = value.controls;
  if (!Array.isArray(controls) || controls.length < 1 || controls.length > 12 || controls.some((c) => typeof c !== "string" || !ID.test(c))) {
    throw new Error(`${path}: controls must list 1\u201312 control ids`);
  }
  const twice = controls.find((c, i) => controls.indexOf(c) !== i);
  if (twice !== undefined)
    throw new Error(`${path}: control ${twice} appears twice`);
  const approval = value.approval ?? "apply";
  if (approval !== "apply" && approval !== "ask")
    throw new Error(`${path}: approval must be apply or ask`);
  return { id, name, description, controls, approval, path, source };
}
async function listDir(dir, ext) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(ext)).sort();
  } catch {
    return [];
  }
}
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: invalid JSON (${errorText(e)})`);
  }
}
async function loadLibrary(root) {
  const roots = libraryRoots(root);
  const library = { controls: new Map, sets: new Map, errors: [] };
  const levels = [
    ["built-in", roots.builtIn],
    ["global", roots.global],
    ["repo", roots.repo]
  ];
  for (const [source, dir] of levels) {
    if (!dir)
      continue;
    for (const file of await listDir(join(dir, "nodes"), ".md")) {
      const path = join(dir, "nodes", file);
      const id = basename(file, ".md");
      try {
        const { fields, body } = parseControlFile(await readFile(path, "utf8"), path);
        library.controls.set(id, controlFrom(id, fields, body, path, source));
      } catch (e) {
        library.errors.push({ path, message: errorText(e) });
      }
    }
    for (const file of await listDir(join(dir, "sets"), ".json")) {
      const path = join(dir, "sets", file);
      const id = basename(file, ".json");
      try {
        library.sets.set(id, setFrom(id, await readJson(path), path, source));
      } catch (e) {
        library.errors.push({ path, message: errorText(e) });
      }
    }
  }
  for (const set of library.sets.values()) {
    const missing = set.controls.filter((id) => !library.controls.has(id));
    if (!missing.length)
      continue;
    library.sets.delete(set.id);
    library.errors.push({ path: set.path, message: `${set.path}: set ${set.id} names missing controls: ${missing.join(", ")}` });
  }
  return library;
}
function summarize(library) {
  return [...library.sets.values()].sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ id: s.id, name: s.name, description: s.description, controls: s.controls.map((id) => library.controls.get(id)?.name ?? id), approval: s.approval }));
}

// plugins/control/src/prompts.ts
var RUN_HEAD = "Control run:";
var MAX_PASSES = 3;
var NUDGE = "A control run is in progress and control_report hasn't been called. Finish the run and call control_report; if you can't finish, call control_report with passed false.";
var FENCE = "```";
var APPROVAL = {
  apply: {
    step: "Fix every certain finding. Apply a judgment call only when you agree with it.",
    skipped: "judgment calls you skipped don't count"
  },
  ask: {
    step: "Show the reviewers' findings to the user with the ask tool before changing anything: one question per finding with the options Apply and Skip. When you have a view on a finding, set recommended to that option so it is preselected. Fix only the findings the user chose to apply. Failing shell checks are fixed without asking.",
    skipped: "findings the user skipped don't count"
  }
};
function runPrompt(input) {
  const checks = input.controls.filter((c) => c.kind === "check");
  const reviewers = input.controls.filter((c) => c.kind === "review");
  const change = `\`git diff ${input.base}\` plus untracked files`;
  const approval = APPROVAL[input.approval];
  const parts = [`${RUN_HEAD} check this repository's change since ${input.base.slice(0, 12)} (everything since that commit, committed or not: ${change}) with the controls below. Never edit files under .omp/control.`];
  if (checks.length) {
    parts.push([
      "## Shell checks",
      `Run each from the repository root with CONTROL_BASE=${input.base} exported. A check passes when it exits 0.`,
      ...checks.map((c, i) => `${i + 1}. ${c.name} (stop it after ${c.timeout} s)
${FENCE}sh
${c.command}
${FENCE}`)
    ].join(`
`));
  }
  if (reviewers.length) {
    parts.push([
      "## Reviewers",
      `Spawn one subagent per reviewer with the task tool, all in one batch. Use the default agent for every one: leave the task's agent unset, and never pick a named agent (reviewer, code-reviewer, scout or any other), whatever the control is about. Each one audits and never edits files. Give each one its control file to read and follow (it reads the header's resources first and skips any that don't exist), the change to review (${change}), and this report format: only problems in the changed code or in callers it breaks; for each finding the file and line, what the code does, what it should do, a concrete fix, and whether it is certain (the code must change) or a judgment call.`,
      ...reviewers.map((c) => `- ${c.name}: ${c.path}`),
      "If you can't spawn subagents, do each audit yourself, one reviewer at a time."
    ].join(`
`));
  }
  const again = checks.length && reviewers.length ? "the shell checks, then every reviewer again" : checks.length ? "the shell checks again" : "every reviewer again";
  const steps = [
    checks.length ? `Run the shell checks. Fix what fails and run them again until they pass${reviewers.length ? ", before any reviewer runs" : ""}.` : null,
    reviewers.length ? "Spawn the reviewers and wait for all of them." : null,
    reviewers.length ? approval.step : null,
    `If you changed anything, run another pass (${again}) to confirm the fixes hold and broke nothing. Stop after a clean pass, or after ${MAX_PASSES} passes.`,
    `Call control_report with passed true when the last pass was clean${reviewers.length ? ` (${approval.skipped})` : ""}, else false. Then give your final answer: per control, what it found, what you fixed and what is left.`
  ].filter((s) => s !== null);
  parts.push(["## Steps", ...steps.map((s, i) => `${i + 1}. ${s}`)].join(`
`));
  return parts.join(`

`);
}

// plugins/control/src/run.ts
var MAX_NUDGES = 2;
function empty() {
  return { baseline: null, auto: null, run: null, settled: null, last: null };
}
function restored(saved) {
  const { baseline = null, auto = null, settled = null, last = null } = saved ?? {};
  return { baseline, auto, run: null, settled, last };
}
function onStop(state, fingerprint2, promptFingerprint) {
  const run = state.run;
  if (run && !run.delivered)
    return { kind: "allow" };
  if (run && run.nudges >= MAX_NUDGES) {
    state.last = { label: run.selection.label, passed: false };
    state.settled = { fingerprint: fingerprint2, passed: false };
    state.run = null;
    return { kind: "stalled" };
  }
  if (run) {
    run.nudges += 1;
    return { kind: "nudge" };
  }
  if (state.auto && fingerprint2 !== "clean" && fingerprint2 !== promptFingerprint && fingerprint2 !== state.settled?.fingerprint) {
    state.run = { selection: state.auto, nudges: 0, delivered: true };
    return { kind: "start", selection: state.auto };
  }
  return { kind: "allow" };
}
function onReport(state, fingerprint2, passed) {
  const run = state.run;
  if (!run)
    return null;
  state.settled = { fingerprint: fingerprint2, passed };
  state.last = { label: run.selection.label, passed };
  state.run = null;
  return run.selection;
}
function status(state, fingerprint2) {
  return {
    passed: state.run === null && state.settled?.passed === true && state.settled.fingerprint === fingerprint2,
    autonomous: state.auto?.approval === "apply"
  };
}
function line(state) {
  if (state.run)
    return `Control \xB7 running ${state.run.selection.label}${state.auto ? " \xB7 auto" : ""}`;
  if (!state.auto)
    return null;
  const last = state.last ? state.last.passed ? " \xB7 \u2713 passed" : " \xB7 \u2717 not passed" : "";
  return `Control \xB7 auto \xB7 ${state.auto.label}${last}`;
}

// plugins/control/src/extension.ts
var ENTRY = "control.session";
var WIDGET = "control";
var TOOL = "control_report";
var PICK = "Pick controls\u2026";
var AUTO_OFF = "Turn auto off";
var ONCE = "Run once";
var AUTO = "Auto: after each request that changes code";
var APPLY = "Apply right away";
var ASK = "Ask me before applying";
async function startBaseline(at) {
  const ref = process.env.OMP_CONTROL_BASE ?? await defaultBranch(at);
  if (ref)
    return { kind: "merge-base", ref };
  const head = await git(["rev-parse", "HEAD"], at);
  if (head.code !== 0)
    throw new Error("Control needs a commit to compare against");
  return { kind: "commit", sha: head.stdout.trim() };
}
function control(pi) {
  const z = pi.zod;
  let sessionCtx = null;
  let root = null;
  let state = empty();
  let promptFingerprint = null;
  let lastNote = null;
  const notify = (message, type) => sessionCtx?.ui.notify(message, type);
  const persist = () => {
    const { baseline, auto, settled, last } = state;
    pi.appendEntry(ENTRY, { baseline, auto, settled, last });
  };
  const show = () => {
    const l = line(state);
    sessionCtx?.ui.setWidget(WIDGET, l ? [l] : undefined, { placement: "belowEditor" });
  };
  const activate = async () => {
    const on = state.auto !== null || state.run !== null;
    const tools = pi.getActiveTools();
    if (tools.includes(TOOL) === on)
      return;
    await pi.setActiveTools(on ? [...tools, TOOL] : tools.filter((t) => t !== TOOL));
  };
  const refresh = async () => {
    persist();
    await activate();
    show();
  };
  const base = async () => {
    const at = root;
    if (!at)
      throw new Error("Control needs a git repository");
    state.baseline ??= await startBaseline(at);
    const sha = await baselineSha(at, state.baseline, (note) => {
      if (note === lastNote)
        return;
      lastNote = note;
      notify(`Control: ${note}`, "warning");
    });
    return { at, sha };
  };
  const currentFingerprint = async () => {
    const { at, sha } = await base();
    return fingerprint(at, sha);
  };
  const send = (text) => {
    if (!sessionCtx || sessionCtx.isIdle())
      pi.sendUserMessage(text);
    else
      pi.sendUserMessage(text, { deliverAs: "followUp" });
  };
  const definitions = (lib, selection) => {
    const missing = selection.controls.filter((id) => !lib.controls.has(id));
    if (missing.length)
      notify(`Control: ${missing.join(", ")} not in the library anymore; skipped`, "warning");
    const found = selection.controls.flatMap((id) => lib.controls.get(id) ?? []);
    return [...found.filter((c) => c.kind === "check"), ...found.filter((c) => c.kind === "review")];
  };
  const startRun = async (selection) => {
    const controls = definitions(await loadLibrary(root), selection);
    if (!controls.length) {
      notify("Control: none of the selected controls exist anymore", "error");
      if (state.auto === selection)
        state.auto = null;
      return refresh();
    }
    const { at, sha } = await base();
    if (await fingerprint(at, sha) === "clean") {
      notify(`Control: nothing to check, no changes since ${sha.slice(0, 7)}`, "info");
      return refresh();
    }
    state.run = { selection, nudges: 0, delivered: false };
    await refresh();
    send(runPrompt({ base: sha, approval: selection.approval, controls }));
  };
  const restore = async (ctx) => {
    sessionCtx = ctx;
    root = await repoRoot(ctx.cwd);
    promptFingerprint = null;
    lastNote = null;
    let saved;
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "custom" && e.customType === ENTRY)
        saved = e.data;
    }
    state = restored(saved);
    const lib = await loadLibrary(root);
    const id = process.env.OMP_CONTROL_SET;
    if (!saved && id) {
      const set = lib.sets.get(id);
      if (set) {
        state.auto = { label: set.name, controls: set.controls, approval: set.approval };
        persist();
      } else
        ctx.ui.notify(`Control: no set ${id} in the library; this session runs no controls`, "error");
    }
    await activate();
    show();
    pi.events.emit(CONTROL_SETS_EVENT, summarize(lib));
  };
  const follow = async (_event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    await restore(ctx);
  };
  pi.on("session_start", follow);
  pi.on("session_switch", follow);
  pi.on("session_branch", follow);
  pi.on("session_tree", follow);
  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    sessionCtx = ctx;
    if (!("prompt" in event) || typeof event.prompt !== "string" || !event.prompt.trim())
      return;
    promptFingerprint = state.auto ? await currentFingerprint().catch(() => null) : null;
    const run = state.run;
    if (!run)
      return;
    if (event.prompt.startsWith(RUN_HEAD) || event.prompt.startsWith(NUDGE))
      run.delivered = true;
    else if (run.delivered) {
      state.run = null;
      await activate();
      show();
    }
  });
  pi.on("session_stop", async (_event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    sessionCtx = ctx;
    if (!state.auto && !state.run || ctx.sessionModes?.getState().plan.status === "active")
      return;
    let sha;
    let fp;
    try {
      const from = await base();
      sha = from.sha;
      fp = await fingerprint(from.at, sha);
    } catch {
      return;
    }
    const stop = onStop(state, fp, promptFingerprint);
    if (stop.kind === "nudge")
      return { decision: "block", reason: NUDGE };
    if (stop.kind === "stalled") {
      await refresh();
      ctx.ui.notify("Control: the agent stopped twice without finishing the run; start it again with /control", "warning");
      return;
    }
    if (stop.kind !== "start")
      return;
    const controls = definitions(await loadLibrary(root), stop.selection);
    if (!controls.length) {
      state.run = null;
      state.auto = null;
      await refresh();
      ctx.ui.notify("Control: none of the selected controls exist anymore", "error");
      return;
    }
    show();
    return { decision: "block", reason: runPrompt({ base: sha, approval: stop.selection.approval, controls }) };
  });
  pi.events.on(CONTROL_ASK_EVENT, async (data) => {
    if (!isControlRequest(data))
      return;
    try {
      if (data.type === "sets")
        data.reply({ ok: true, message: "", sets: summarize(await loadLibrary(root)) });
      else
        data.reply({ ok: true, message: "", ...status(state, await currentFingerprint()) });
    } catch (e) {
      data.reply({ ok: false, message: errorText(e) });
    }
  });
  pi.registerTool({
    name: TOOL,
    label: "Control report",
    description: "Report the end of the control run in progress: call it once, when its last pass is done or you can't finish it. passed is true only when the last pass came back clean.",
    parameters: z.object({ passed: z.boolean() }),
    loadMode: "essential",
    defaultInactive: true,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      sessionCtx = ctx;
      const done = onReport(state, await currentFingerprint(), params.passed);
      if (!done)
        return toolReply("No control run is in progress.", true);
      await refresh();
      ctx.ui.notify(`Control: ${done.label} ${params.passed ? "passed" : "didn't pass"}`, params.passed ? "info" : "warning");
      return toolReply(params.passed ? "Recorded: the controls passed. Give your final answer." : "Recorded: the controls didn't pass. Say what is left in your final answer.");
    }
  });
  pi.registerCommand("control", {
    description: "Control: pick a set or controls to check the change, once or after every change",
    handler: async (_args, ctx) => {
      if (ctx.agent?.kind === "sub")
        return;
      sessionCtx = ctx;
      try {
        root ??= await repoRoot(ctx.cwd);
        if (!root)
          throw new Error("Control needs a git repository");
        const lib = await loadLibrary(root);
        pi.events.emit(CONTROL_SETS_EVENT, summarize(lib));
        for (const e of lib.errors)
          ctx.ui.notify(`Control: ${e.message}`, "warning");
        const controls = [...lib.controls.values()];
        if (!controls.length)
          throw new Error("The control library is empty");
        const sets = [...lib.sets.values()].sort((a, b) => a.name.localeCompare(b.name));
        const setLabel = (s) => `${s.name} (${s.id})`;
        const choice = await ctx.ui.select("Control", [
          ...sets.map((s) => ({
            label: setLabel(s),
            description: `${s.controls.map((id) => lib.controls.get(id)?.name ?? id).join(", ")} \xB7 ${s.approval === "ask" ? "asks before applying" : "applies right away"}`
          })),
          { label: PICK, description: `Choose among ${controls.length} controls` },
          ...state.auto ? [{ label: AUTO_OFF, description: `Auto runs ${state.auto.label}` }] : []
        ]);
        if (!choice)
          return;
        if (choice === AUTO_OFF) {
          state.auto = null;
          await refresh();
          ctx.ui.notify("Control: auto is off", "info");
          return;
        }
        let selection;
        let auto;
        const set = sets.find((s) => setLabel(s) === choice);
        if (set) {
          selection = { label: set.name, controls: set.controls, approval: set.approval };
          const when = await ctx.ui.select(`Run \xAB${set.name}\xBB`, [ONCE, AUTO]);
          if (!when)
            return;
          auto = when === AUTO;
        } else {
          if (!ctx.ui.askDialog)
            throw new Error("Picking controls needs omp's interactive terminal");
          const result = await ctx.ui.askDialog([
            { id: "controls", header: "Controls", question: "Which controls?", multi: true, options: controls.map((c) => ({ label: setLabel(c), description: c.description })) },
            { id: "approval", header: "Findings", question: "What happens to findings?", options: [{ label: APPLY }, { label: ASK }], recommended: 0 },
            { id: "when", header: "When", question: "When do they run?", options: [{ label: ONCE }, { label: AUTO }], recommended: 0 }
          ]);
          if (!result || result.kind === "chat")
            return;
          const picked = (id) => result.results.find((r) => r.id === id)?.selectedOptions ?? [];
          const ticked = controls.filter((c) => picked("controls").includes(setLabel(c)));
          if (!ticked.length)
            return;
          selection = { label: ticked.map((c) => c.name).join(", "), controls: ticked.map((c) => c.id), approval: picked("approval")[0] === ASK ? "ask" : "apply" };
          auto = picked("when")[0] === AUTO;
        }
        if (auto)
          state.auto = selection;
        await startRun(selection);
      } catch (e) {
        ctx.ui.notify(errorText(e), "error");
      }
    }
  });
}
export {
  control as default
};
