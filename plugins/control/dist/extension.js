// @bun
// plugins/control/src/extension.ts
import { rm as rm3 } from "fs/promises";
import { homedir as homedir4 } from "os";
import { join as join5 } from "path";
import * as omp from "@oh-my-pi/pi-coding-agent";

// packages/control-view/src/protocol.ts
var RUN_EVENT = "control:run";
var LIBRARY_EVENT = "control:library";
var COMMAND_EVENT = "control:command";
function questionAnswer(f, picked) {
  if (!f.question || !picked)
    return null;
  if (picked === f.question.chose)
    return { decision: "dismiss" };
  return { decision: "fix", note: f.question.options.includes(picked) ? `Use \xAB${picked}\xBB instead of \xAB${f.question.chose}\xBB` : picked };
}

// packages/control-view/src/render.ts
var STATUS_LABELS = {
  idle: "Idle",
  planning: "Planning",
  implementing: "Implementing",
  checking: "Checking",
  deciding: "Needs you",
  fixing: "Fixing",
  passed: "Done",
  deferred: "Deferred",
  paused: "Paused",
  stalled: "Stalled"
};

// packages/integrations/src/theme.ts
import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

// packages/integrations/src/fonts.ts
import { createHash } from "crypto";
import { extname } from "path";
import { dlopen, ptr, read } from "bun:ffi";
var macFont;
var fonts = new Map;
function loadCoreText() {
  const { symbols: cf } = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFStringCreateWithCString: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
    CFStringGetCString: { args: ["ptr", "ptr", "i64", "u32"], returns: "bool" },
    CFURLGetFileSystemRepresentation: { args: ["ptr", "bool", "ptr", "i64"], returns: "bool" },
    CFRelease: { args: ["ptr"], returns: "void" }
  });
  const { symbols: ct } = dlopen("/System/Library/Frameworks/CoreText.framework/CoreText", {
    CTFontCreateWithName: { args: ["ptr", "f64", "ptr"], returns: "ptr" },
    CTFontCopyFamilyName: { args: ["ptr"], returns: "ptr" },
    CTFontCopyFullName: { args: ["ptr"], returns: "ptr" },
    CTFontCopyPostScriptName: { args: ["ptr"], returns: "ptr" },
    CTFontCopyAttribute: { args: ["ptr", "ptr"], returns: "ptr" }
  });
  const dyld = dlopen("/usr/lib/libSystem.B.dylib", { dlsym: { args: ["i64", "ptr"], returns: "ptr" } });
  const symbol = dyld.symbols.dlsym(-2, ptr(Buffer.from("kCTFontURLAttribute\x00")));
  const urlAttribute = read.ptr(symbol);
  return (family) => {
    const refs = [];
    try {
      const name = cf.CFStringCreateWithCString(null, ptr(Buffer.from(`${family}\x00`)), 134217984);
      refs.push(name);
      const font = ct.CTFontCreateWithName(name, 0, null);
      refs.push(font);
      const names = [ct.CTFontCopyFamilyName(font), ct.CTFontCopyPostScriptName(font), ct.CTFontCopyFullName(font)];
      refs.push(...names);
      const buffer = Buffer.alloc(4096);
      const decoded = names.map((value) => {
        if (!cf.CFStringGetCString(value, ptr(buffer), buffer.length, 134217984))
          return "";
        return buffer.toString("utf8", 0, buffer.indexOf(0));
      });
      if (!decoded.some((value) => value.toLowerCase() === family.toLowerCase()))
        return null;
      const url = ct.CTFontCopyAttribute(font, urlAttribute);
      if (!url)
        return null;
      refs.push(url);
      if (!cf.CFURLGetFileSystemRepresentation(url, true, ptr(buffer), buffer.length))
        return null;
      return { family: decoded[0], postscriptName: decoded[1], path: buffer.toString("utf8", 0, buffer.indexOf(0)) };
    } finally {
      for (const ref of refs)
        cf.CFRelease(ref);
    }
  };
}
async function terminalFont(families) {
  for (const family of families) {
    const cached = fonts.get(family);
    if (cached)
      return cached;
    try {
      let font;
      if (process.platform === "darwin")
        font = (macFont ??= loadCoreText())(family);
      else {
        const proc = Bun.spawn(["fc-match", `--format=%{family}
%{postscriptname}
%{file}`, family], { stdout: "pipe", stderr: "ignore", timeout: 2000 });
        const [matched, postscriptName, path] = (await new Response(proc.stdout).text()).split(`
`);
        if (await proc.exited !== 0 || !matched.split(",").some((value) => value.toLowerCase() === family.toLowerCase()))
          continue;
        font = { family: matched, postscriptName, path };
      }
      if (!font || ![".ttf", ".otf", ".ttc", ".otc", ".woff", ".woff2"].includes(extname(font.path).toLowerCase()))
        continue;
      const resolved = { ...font, id: createHash("sha256").update(`${font.path}#${font.postscriptName}`).digest("hex").slice(0, 16) };
      fonts.set(family, resolved);
      return resolved;
    } catch {}
  }
  return null;
}

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
async function terminalCellHeight(options = {}) {
  try {
    const context = await detectTerminalContext(options);
    const cmux = context.cmux;
    const surface = cmux?.surface;
    if (!cmux || !surface)
      return;
    const proc = Bun.spawn([cmux.cli, "--socket", cmux.socket, "list-panes", "--workspace", cmux.workspace, "--json"], {
      env: options.env ?? process.env,
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2000
    });
    const data = await new Response(proc.stdout).json();
    if (await proc.exited !== 0)
      return;
    const pane = data.panes?.find((pane2) => pane2.surface_ids?.includes(surface));
    const height = pane?.cell_height_points;
    return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
  } catch {
    return;
  }
}
async function openBoard(url, options = {}) {
  const args = ["board", url, options.focus ? "--focus" : "--no-focus"];
  if (options.context)
    args.push("--context", JSON.stringify(options.context));
  await helper(args, options);
}

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
function parseGhosttyConfig(config) {
  const parsed = {};
  for (const line of config.split(`
`)) {
    const [, key, value = ""] = /^\s*([\w-]+)\s*=\s*(.*?)\s*$/.exec(line) ?? [];
    if ((key === "background" || key === "foreground") && HEX.test(value))
      parsed[key] = value;
    else if (key === "font-size" && Number(value) > 0)
      parsed.fontSize = Number(value);
    else if (key === "font-family") {
      if (value)
        (parsed.fontFamilies ??= []).push(value);
      else
        parsed.fontFamilies = [];
    }
  }
  return parsed;
}
var GHOSTTY_FONT_SIZE = process.platform === "darwin" ? 13 : 12;
async function terminalConfig(resources = process.env.GHOSTTY_RESOURCES_DIR) {
  if (!resources)
    return null;
  const cli = ["../bin/ghostty", "../../MacOS/ghostty", "../../bin/ghostty"].map((p) => resolve(resources, p)).find((p) => existsSync(p));
  if (!cli)
    return null;
  try {
    const proc = Bun.spawn([cli, "+show-config"], { stdout: "pipe", stderr: "ignore", timeout: 2000 });
    const out = await new Response(proc.stdout).text();
    if (await proc.exited !== 0)
      return null;
    const bundle = process.env.CMUX_BUNDLE_ID;
    const cmux = bundle ? await Bun.file(join(homedir(), "Library/Application Support", bundle, "config.ghostty")).text().catch(() => "") : "";
    const config = parseGhosttyConfig(`${out}
${cmux}`);
    return {
      ...config,
      fontSize: config.fontSize ?? GHOSTTY_FONT_SIZE,
      cellHeight: await terminalCellHeight(),
      font: await terminalFont(config.fontFamilies ?? []) ?? undefined
    };
  } catch {
    return null;
  }
}

// packages/integrations/src/appearance.ts
var TOKEN_VARS = {
  "--muted": "muted",
  "--accent": "accent",
  "--badge": "mdLink",
  "--add": "toolDiffAdded",
  "--remove": "toolDiffRemoved",
  "--warning": "warning",
  "--syn-comment": "syntaxComment",
  "--syn-keyword": "syntaxKeyword",
  "--syn-function": "syntaxFunction",
  "--syn-variable": "syntaxVariable",
  "--syn-string": "syntaxString",
  "--syn-number": "syntaxNumber",
  "--syn-type": "syntaxType",
  "--syn-operator": "syntaxOperator",
  "--syn-punctuation": "syntaxPunctuation"
};
function toAppearance(omp, terminal) {
  const theme = resolveTheme(omp, terminal);
  const { scheme, colors } = theme;
  const vars = {};
  if (theme.background)
    vars["--bg"] = theme.background;
  if (theme.foreground)
    vars["--fg"] = theme.foreground;
  for (const [name, token] of Object.entries(TOKEN_VARS)) {
    const value = colors[token];
    if (value)
      vars[name] = value;
  }
  const accent = colors.accent;
  if (accent) {
    vars["--accent-fg"] = isLightColor(accent) ? "#000000" : "#ffffff";
    vars["--accent-soft"] = `color-mix(in srgb, ${accent} ${scheme === "light" ? 12 : 18}%, transparent)`;
  }
  if (terminal?.fontSize)
    vars["--terminal-font-size"] = `${terminal.fontSize}px`;
  if (terminal?.fontSize && terminal.cellHeight)
    vars["--terminal-line-height"] = String(terminal.cellHeight / terminal.fontSize);
  return { scheme, vars, font: terminal?.font };
}
function appearanceCss({ scheme, vars, font }, fontUrl) {
  const decls = Object.entries(vars).map(([name, value]) => `  ${name}: ${value};
`);
  let face = "";
  if (font && fontUrl) {
    const family = `"Review Terminal ${font.id}"`;
    face = `@font-face {
  font-family: ${family};
  src: url(${JSON.stringify(`${fontUrl}#${encodeURIComponent(font.postscriptName)}`)});
  font-display: swap;
}
`;
    decls.push(`  --terminal-font: ${family}, "Fira Code";
`);
  }
  return `${face}:root {
  color-scheme: ${scheme};
${decls.join("")}}
`;
}

// plugins/control/src/library.ts
import { realpathSync } from "fs";
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { homedir as homedir2 } from "os";
import { basename, dirname, join as join2 } from "path";

// plugins/control/src/frontmatter.ts
var NODE_KEYS = ["name", "kind", "description", "command", "timeout", "ask", "model", "thinking", "tools", "resources"];
var BARE = /^[A-Za-z0-9][A-Za-z0-9 ._/@+-]*$/;
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
function parseNodeFile(text, path) {
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
    if (!NODE_KEYS.includes(key))
      throw new Error(`${path}: unknown key "${key}"`);
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
function quote(value) {
  return BARE.test(value) && value === value.trim() ? value : JSON.stringify(value);
}
function serializeNode(node) {
  const out = ["---", `name: ${quote(node.name)}`, `kind: ${node.kind}`];
  if (node.description)
    out.push(`description: ${quote(node.description)}`);
  if (node.kind === "check" && node.command !== null)
    out.push(`command: ${quote(node.command)}`);
  out.push(`timeout: ${node.timeout}`, `ask: ${node.ask}`);
  if (node.model)
    out.push(`model: ${quote(node.model)}`);
  if (node.thinking)
    out.push(`thinking: ${quote(node.thinking)}`);
  if (node.kind === "review")
    out.push("tools:", ...node.tools.map((t) => `  - ${quote(t)}`));
  if (node.resources.length)
    out.push("resources:", ...node.resources.map((r) => `  - ${quote(r)}`));
  out.push("---");
  return `${out.join(`
`)}
${node.instructions ? `
${node.instructions}
` : ""}`;
}

// plugins/control/src/library.ts
var ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
var REVIEWER_TOOLS = ["read", "grep", "glob", "find", "ast_grep", "web_search"];
var DEFAULT_TOOLS = ["read", "grep", "glob"];
var ASK_MODES = ["doubts", "all", "never"];
var BUILT_IN = join2(dirname(realpathSync(import.meta.path)), "..", "library");
function libraryRoots(root) {
  return {
    repo: root ? join2(root, ".omp", "control") : null,
    global: process.env.OMP_CONTROL_HOME || join2(homedir2(), ".omp", "control"),
    builtIn: BUILT_IN
  };
}
function optionalText(fields, key, where) {
  const value = fields[key];
  if (value === undefined || value === null || value === "")
    return null;
  if (typeof value !== "string")
    throw new Error(`${where}: ${key} must be text`);
  return value;
}
function textList(fields, key, where) {
  const value = fields[key];
  if (value === undefined || value === null)
    return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim()))
    throw new Error(`${where}: ${key} must be a list of text`);
  return value.map((v) => v.trim());
}
function checkId(id, where, what) {
  if (!ID.test(id))
    throw new Error(`${where}: ${what} "${id}" must be lowercase letters, digits and dashes (at most 63)`);
}
function nodeFrom(id, fields, body, where) {
  checkId(id, where, "node id");
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (name.length < 1 || name.length > 60)
    throw new Error(`${where}: name must be 1\u201360 characters`);
  const kind = fields.kind;
  if (kind !== "check" && kind !== "review")
    throw new Error(`${where}: kind must be check or review`);
  const description = optionalText(fields, "description", where) ?? "";
  const ask = optionalText(fields, "ask", where) ?? "doubts";
  if (!ASK_MODES.includes(ask))
    throw new Error(`${where}: ask must be doubts, all or never`);
  const [min, max, fallback] = kind === "check" ? [1, 7200, 900] : [30, 3600, 600];
  const timeout = fields.timeout ?? fallback;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < min || timeout > max) {
    throw new Error(`${where}: timeout must be ${min}\u2013${max} seconds`);
  }
  const resources = textList(fields, "resources", where) ?? [];
  if (resources.length > 20)
    throw new Error(`${where}: resources has at most 20 entries`);
  let command = null;
  let tools = [];
  if (kind === "check") {
    command = optionalText(fields, "command", where)?.trim() || null;
    if (!command)
      throw new Error(`${where}: a check needs a command`);
  } else {
    if (!body.trim())
      throw new Error(`${where}: a reviewer needs instructions (the text after the header)`);
    tools = textList(fields, "tools", where) ?? DEFAULT_TOOLS;
    const bad = tools.filter((t) => !REVIEWER_TOOLS.includes(t));
    if (bad.length)
      throw new Error(`${where}: tools can only be ${REVIEWER_TOOLS.join(", ")}; reviewers never modify files (not ${bad.join(", ")})`);
  }
  return {
    id,
    name,
    kind,
    description,
    command,
    timeout,
    ask,
    model: optionalText(fields, "model", where),
    thinking: optionalText(fields, "thinking", where),
    tools,
    resources,
    instructions: body.trim()
  };
}
function flowFrom(raw, where, node, idOf) {
  const seen = new Set;
  const parse = (value, label, min) => {
    if (!Array.isArray(value) || value.length < min || value.length > 8)
      throw new Error(`${where}: ${label} must list ${min}\u20138 stages`);
    return value.map((stage, i) => {
      const nodes = stage && typeof stage === "object" && "nodes" in stage ? stage.nodes : undefined;
      if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 6)
        throw new Error(`${where}: ${label} stage ${i + 1} must hold 1\u20136 nodes`);
      return {
        nodes: nodes.map((v) => {
          const n = node(v, `${where}: ${label} stage ${i + 1}`);
          const id = idOf(n);
          if (seen.has(id))
            throw new Error(`${where}: node ${id} appears twice in the loop`);
          seen.add(id);
          return n;
        })
      };
    });
  };
  const planStages = raw.planStages === undefined ? [] : parse(raw.planStages, "planStages", 0);
  return { planStages, stages: parse(raw.stages ?? [], "stages", 0) };
}
function loopHeader(raw, where) {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length < 1 || name.length > 60)
    throw new Error(`${where}: name must be 1\u201360 characters`);
  const description = raw.description ?? "";
  if (typeof description !== "string")
    throw new Error(`${where}: description must be text`);
  const maxPasses = raw.maxPasses ?? 4;
  if (typeof maxPasses !== "number" || !Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 10)
    throw new Error(`${where}: maxPasses must be 1\u201310`);
  const plan = raw.plan ?? false;
  if (typeof plan !== "boolean")
    throw new Error(`${where}: plan must be true or false`);
  const finish = raw.finish ?? "review";
  if (finish !== "review" && finish !== "auto")
    throw new Error(`${where}: finish must be review or auto`);
  return { name, description, maxPasses, plan: plan || Array.isArray(raw.planStages) && raw.planStages.length > 0, finish };
}
function loopFrom(id, raw, where) {
  checkId(id, where, "loop id");
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${where}: must be a JSON object`);
  const value = raw;
  const flow = flowFrom(value, where, (n, at) => {
    if (typeof n !== "string")
      throw new Error(`${at}: nodes must be node ids`);
    checkId(n, at, "node id");
    return n;
  }, (n) => n);
  return { id, ...loopHeader(value, where), ...flow };
}
function validateSnapshot(value) {
  const where = "loop";
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${where}: must be an object`);
  const raw = value;
  const id = raw.id === null || raw.id === undefined || raw.id === "" ? null : raw.id;
  if (id !== null) {
    if (typeof id !== "string")
      throw new Error(`${where}: id must be text`);
    checkId(id, where, "loop id");
  }
  const flow = flowFrom(raw, where, (n, at) => {
    if (!n || typeof n !== "object")
      throw new Error(`${at}: each node must be an object`);
    const fields = n;
    if (typeof fields.id !== "string")
      throw new Error(`${at}: each node needs an id`);
    const body = typeof fields.instructions === "string" ? fields.instructions : "";
    return nodeFrom(fields.id, fields, body, `${at}: node ${fields.id}`);
  }, (n) => n.id);
  return { id, ...loopHeader(raw, where), ...flow };
}
async function listDir(dir, ext) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(ext)).sort();
  } catch {
    return [];
  }
}
async function loadLibrary(root) {
  const roots = libraryRoots(root);
  const library = { loops: new Map, nodes: new Map, errors: [] };
  const sources = [
    ["built-in", roots.builtIn],
    ["global", roots.global],
    ["repo", roots.repo]
  ];
  for (const [source, dir] of sources) {
    if (!dir)
      continue;
    for (const file of await listDir(join2(dir, "nodes"), ".md")) {
      const path = join2(dir, "nodes", file);
      const id = basename(file, ".md");
      try {
        const { fields, body } = parseNodeFile(await readFile(path, "utf8"), path);
        const below = library.nodes.get(id);
        library.nodes.set(id, { node: nodeFrom(id, fields, body, path), source, path, overrides: below ? [below.source, ...below.overrides] : [] });
      } catch (e) {
        library.errors.push({ path, message: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const file of await listDir(join2(dir, "loops"), ".json")) {
      const path = join2(dir, "loops", file);
      const id = basename(file, ".json");
      try {
        let raw;
        try {
          raw = JSON.parse(await readFile(path, "utf8"));
        } catch (e) {
          throw new Error(`${path}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
        }
        const below = library.loops.get(id);
        library.loops.set(id, { loop: loopFrom(id, raw, path), source, path, overrides: below ? [below.source, ...below.overrides] : [] });
      } catch (e) {
        library.errors.push({ path, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return library;
}
function scopeDir(root, scope) {
  const dir = libraryRoots(root)[scope];
  if (!dir)
    throw new Error(`The ${scope} library needs a git repository`);
  return dir;
}
async function saveNode(root, scope, node) {
  const text = serializeNode(nodeFrom(node.id, { ...node }, node.instructions, `node ${node.id}`));
  const { fields, body } = parseNodeFile(text, `node ${node.id}`);
  nodeFrom(node.id, fields, body, `node ${node.id}`);
  const path = join2(await scopeDir(root, scope), "nodes", `${node.id}.md`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}
async function saveLoop(root, scope, loop, library) {
  const valid = loopFrom(loop.id, loop, `loop ${loop.id}`);
  const missing = [...valid.planStages, ...valid.stages].flatMap((s) => s.nodes).filter((n) => !library.nodes.has(n));
  if (missing.length)
    throw new Error(`Loop ${loop.id} needs missing nodes: ${missing.join(", ")}`);
  const path = join2(await scopeDir(root, scope), "loops", `${loop.id}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ name: valid.name, description: valid.description, maxPasses: valid.maxPasses, plan: valid.plan, planStages: valid.planStages, stages: valid.stages, finish: valid.finish }, null, 2)}
`);
  return path;
}
async function deleteItem(root, scope, kind, id) {
  checkId(id, kind, `${kind} id`);
  const dir = libraryRoots(root)[scope];
  const path = dir && join2(dir, kind === "node" ? "nodes" : "loops", `${id}${kind === "node" ? ".md" : ".json"}`);
  try {
    if (!path)
      throw new Error;
    await readFile(path);
  } catch {
    throw new Error(`No ${kind} ${id} in the ${scope} library; built-in ${kind}s can't be deleted`);
  }
  await rm(path);
}
async function copyItem(root, library, kind, id, to, move) {
  const entry = kind === "node" ? library.nodes.get(id) : library.loops.get(id);
  if (!entry)
    throw new Error(`No ${kind} ${id} in the library`);
  if (entry.source === to)
    throw new Error(`${id} is already in the ${to} library`);
  if (move && entry.source === "built-in")
    throw new Error(`Built-in ${kind}s can't move; copy ${id} instead`);
  const path = "node" in entry ? await saveNode(root, to, entry.node) : await saveLoop(root, to, entry.loop, library);
  if (move && entry.source !== "built-in")
    await deleteItem(root, entry.source, kind, id);
  return path;
}
function resolveLoop(library, id) {
  const entry = library.loops.get(id);
  if (!entry)
    throw new Error(`No loop ${id} in the library`);
  const missing = [...entry.loop.planStages, ...entry.loop.stages].flatMap((s) => s.nodes).filter((n) => !library.nodes.has(n));
  if (missing.length)
    throw new Error(`Loop ${id} needs missing nodes: ${missing.join(", ")}`);
  const { loop } = entry;
  const resolve2 = (stages) => stages.map((s) => ({ nodes: s.nodes.map((n) => library.nodes.get(n).node) }));
  return { id, name: loop.name, description: loop.description, maxPasses: loop.maxPasses, plan: loop.plan, planStages: resolve2(loop.planStages), stages: resolve2(loop.stages), finish: loop.finish };
}
function shape(loop) {
  return {
    id: loop.id,
    name: loop.name,
    description: loop.description,
    maxPasses: loop.maxPasses,
    plan: loop.plan,
    finish: loop.finish,
    planStages: loop.planStages.map((s) => ({ nodes: s.nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind })) })),
    stages: loop.stages.map((s) => ({ nodes: s.nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind })) }))
  };
}
function summarize(library, repo) {
  const loops = [...library.loops.values()].flatMap(({ loop, source }) => {
    const lookup = (stages) => stages.map((s) => s.nodes.map((id) => library.nodes.get(id)?.node));
    const [plan, change] = [lookup(loop.planStages), lookup(loop.stages)];
    if ([...plan, ...change].some((s) => s.some((n) => !n)))
      return [];
    const full = (stages) => stages.map((s) => ({ nodes: s }));
    return [{ ...shape({ ...loop, planStages: full(plan), stages: full(change) }), id: loop.id, source }];
  });
  return { repo, loops: loops.sort((a, b) => a.name.localeCompare(b.name)) };
}

// plugins/control/src/prompts.ts
var SEVERITIES = ["blocker", "major", "minor"];
var FENCE = "```";
function reviewerSystemPrompt(node) {
  const parts = [
    `You are "${node.name}", a reviewer in a control loop. You never modify files and you only use the ${node.tools.join(", ")} tools. Review the change attached to the user message against the instructions below; read any repository file you need for context.`,
    `## Instructions
${node.instructions}`
  ];
  if (node.resources.length)
    parts.push(`## Read these first
${node.resources.map((r) => `- ${r}`).join(`
`)}
Skip any that don't exist.`);
  parts.push([
    "## Report",
    "Report only problems in the changed code, or in callers it breaks. No praise, no summary of what is fine.",
    "End your final message with exactly one fenced json block:",
    `${FENCE}json`,
    `{"findings":[{"file":"path/from/repo/root","line":42,"rule":"short name of the rule or expectation","observed":"what the code does","expected":"what it should do instead","alternatives":["a concrete acceptable fix"],"severity":"blocker|major|minor","certain":true}]}`,
    FENCE,
    "certain is true only when the code must change according to the instructions or project rules; use false for judgment calls the user should decide. An empty findings list means the change passes."
  ].join(`
`));
  return parts.join(`

`);
}
function planPacketText(input) {
  return [
    "# Plan to review",
    `Loop: ${input.loopName} \xB7 reviewer: ${input.nodeName}`,
    "Nothing is implemented yet: review the plan below, not code. Report a finding for each problem in the plan (file and line may be null, or name the files the plan should touch).",
    `## What the user asked
${input.prompts.join(`

---

`) || "(no prompt recorded)"}`,
    `## Proposed plan
${input.plan}`
  ].join(`

`);
}
function reviewPacketText(input) {
  const asked = input.plan ?? input.prompts.join(`

---

`);
  const parts = [
    "# Change to review",
    `Loop: ${input.loopName} \xB7 reviewer: ${input.nodeName} \xB7 pass ${input.pass}`,
    `## What the user asked
${asked || "(no prompt recorded)"}`,
    `## Changed files
${input.packet.stat || "(none)"}`,
    `## Diff (since ${input.baseline.slice(0, 12)})
${FENCE}diff
${input.packet.diff.trimEnd()}
${FENCE}`
  ];
  if (input.packet.truncated)
    parts.push("The diff was cut at 80,000 characters; read the remaining changed files directly.");
  if (input.answers?.length) {
    parts.push(`## The user already answered
Don't flag these again, however you'd phrase them, unless the answer says to and the change still doesn't do it:
${input.answers.map((a) => `- ${a}`).join(`
`)}`);
  }
  return `${parts.join(`

`)}
`;
}
function finalText(lines) {
  let text = "";
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || !("type" in event) || event.type !== "message_end" || !("message" in event))
      continue;
    const message = event.message;
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant" || !("content" in message))
      continue;
    const content = Array.isArray(message.content) ? message.content : [];
    text = content.filter((b) => b && typeof b === "object" && ("type" in b) && b.type === "text" && ("text" in b) && typeof b.text === "string").map((b) => b.text).join("");
  }
  return text;
}
function cut(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}\u2026` : value;
}
function requiredText(raw, key, i) {
  const value = raw[key];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Reviewer output had no valid findings JSON: finding ${i + 1} has no ${key}`);
  return cut(value.trim(), 600);
}
function parseFindings(text) {
  const fail = (reason) => new Error(`Reviewer output had no valid findings JSON: ${reason}`);
  const blocks = [...text.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)];
  const block = blocks.at(-1);
  if (!block)
    throw fail("no ```json block");
  let parsed;
  try {
    parsed = JSON.parse(block[1]);
  } catch (e) {
    throw fail(e instanceof Error ? e.message : String(e));
  }
  if (!parsed || typeof parsed !== "object" || !("findings" in parsed) || !Array.isArray(parsed.findings))
    throw fail('expected {"findings": [...]}');
  return parsed.findings.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw fail(`finding ${i + 1} isn't an object`);
    const raw = item;
    const file = raw.file === undefined || raw.file === null || raw.file === "" ? null : raw.file;
    if (file !== null && typeof file !== "string")
      throw fail(`finding ${i + 1} has a non-text file`);
    const line = raw.line === undefined || raw.line === null ? null : raw.line;
    if (line !== null && (typeof line !== "number" || !Number.isInteger(line) || line < 1))
      throw fail(`finding ${i + 1} has an invalid line`);
    const alternatives = raw.alternatives ?? [];
    if (!Array.isArray(alternatives) || alternatives.some((a) => typeof a !== "string"))
      throw fail(`finding ${i + 1} has invalid alternatives`);
    const severity = raw.severity ?? "major";
    if (!SEVERITIES.includes(severity))
      throw fail(`finding ${i + 1} has severity ${String(severity)}`);
    const certain = raw.certain ?? false;
    if (typeof certain !== "boolean")
      throw fail(`finding ${i + 1} has a non-boolean certain`);
    return {
      file,
      line,
      rule: requiredText(raw, "rule", i),
      observed: requiredText(raw, "observed", i),
      expected: requiredText(raw, "expected", i),
      alternatives: alternatives.slice(0, 5).map((a) => cut(a, 300)),
      severity,
      certain
    };
  });
}
function tail(output) {
  const lines = output.trimEnd().split(`
`).slice(-60).join(`
`);
  return lines.length > 6000 ? lines.slice(-6000) : lines;
}
function checkFinding(node, code, output) {
  return { file: null, line: null, rule: `command failed (exit ${code})`, observed: tail(output) || "(no output)", expected: `\`${node.command}\` exits 0 from the repository root`, alternatives: [], severity: "blocker", certain: true };
}
function timeoutFinding(node, output) {
  return { ...checkFinding(node, 0, output), rule: `command timed out after ${node.timeout}s` };
}
function numbered(items, start) {
  return items.map((f, i) => {
    if (f.approval)
      return `${start + i}. [${f.nodeName}] The user sent the change back: ${f.decision?.note || "no note; ask what to change"}`;
    const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""} \u2014` : "";
    const lines = [`${start + i}. [${f.nodeName}]${where} ${f.rule}`, `   Observed: ${f.observed}`, `   Expected: ${f.expected}`];
    if (f.alternatives.length)
      lines.push(`   Acceptable fixes: ${f.alternatives.join("; ")}`);
    if (f.decision?.note)
      lines.push(`   User note: ${f.decision.note}`);
    return lines.join(`
`);
  });
}
function fixMessage(loopName, pass, maxPasses, fix, consider, dismissed) {
  const what = fix.length === 1 ? "this finding" : `these ${fix.length} findings`;
  const parts = [`Control loop \xAB${loopName}\xBB \u2014 pass ${pass} of ${maxPasses}: fix ${what}, then call control_check again before your final answer.`, numbered(fix, 1).join(`
`)];
  if (consider.length)
    parts.push(`Judgment calls \u2014 apply only if you agree, and say which you skipped:
${numbered(consider, fix.length + 1).join(`
`)}`);
  if (dismissed > 0)
    parts.push(`The user dismissed ${dismissed} finding${dismissed === 1 ? "" : "s"}; don't act on them.`);
  return parts.join(`

`);
}
function passedMessage(loopName, pass, nodes, dismissed = 0) {
  const extra = dismissed > 0 ? ` (${dismissed} dismissed by the user.)` : "";
  return `Control loop \xAB${loopName}\xBB passed on pass ${pass}: ${nodes.join(" \u2713, ")} \u2713. Give your final answer.${extra}`;
}
function judgmentCalls(consider) {
  return `Judgment calls \u2014 apply only if you agree, and say which you skipped:
${numbered(consider, 1).join(`
`)}`;
}
var MAX_GROUPS = 12;
function reviewSummary(input) {
  const lines = [];
  const requests = input.requests.map((r) => cut(r.replace(/\s+/g, " ").trim(), 240));
  if (requests.length === 1)
    lines.push(`Request: ${requests[0]}`);
  else if (requests.length)
    lines.push("Requests:", ...requests.map((r) => `  - ${r}`));
  const added = input.files.reduce((n, f) => n + f.added, 0);
  const removed = input.files.reduce((n, f) => n + f.removed, 0);
  lines.push(`Changed: ${input.files.length} file${input.files.length === 1 ? "" : "s"}, +${added} \u2212${removed}`);
  const groups = new Map;
  for (const f of input.files) {
    const slash = f.path.lastIndexOf("/");
    const dir = slash < 0 ? "." : f.path.slice(0, slash);
    groups.set(dir, [...groups.get(dir) ?? [], f]);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].reduce((n, f) => n + f.added + f.removed, 0) - a[1].reduce((n, f) => n + f.added + f.removed, 0));
  for (const [dir, files] of sorted.slice(0, MAX_GROUPS)) {
    const names = files.map((f) => `${f.path.slice(dir === "." ? 0 : dir.length + 1)}${f.isNew ? " (new)" : ""}`).join(", ");
    lines.push(`  ${dir === "." ? "" : `${dir}/ \u2014 `}${names}  +${files.reduce((n, f) => n + f.added, 0)} \u2212${files.reduce((n, f) => n + f.removed, 0)}`);
  }
  if (sorted.length > MAX_GROUPS)
    lines.push(`  \u2026and ${sorted.length - MAX_GROUPS} more folders`);
  if (input.fixed.length) {
    lines.push(`Fixed during the loop:`);
    for (const f of input.fixed.slice(0, 10))
      lines.push(`  - [${f.nodeName}] ${f.file ? `${f.file} \u2014 ` : ""}${f.rule}`);
    if (input.fixed.length > 10)
      lines.push(`  \u2026and ${input.fixed.length - 10} more`);
  }
  if (input.answered)
    lines.push(`You already answered ${input.answered} finding${input.answered === 1 ? "" : "s"}.`);
  return lines.join(`
`);
}
var CHECK_REQUEST = "Run control_check on the current changes and fix what it reports before your final answer.";
function stopReason(loopName) {
  return `Control loop \xAB${loopName}\xBB: your latest changes haven't been checked. Call control_check before your final answer. If you're stopping to ask the user something or you can't finish, call control_check with incomplete set to the reason.`;
}
function stagesText(loop) {
  return loop.stages.map((s) => s.nodes.map((n) => n.name).join(" + ")).join(" \u2192 ");
}
function contextMessage(loop) {
  return `This session runs the control loop \xAB${loop.name}\xBB (${stagesText(loop)}). When your implementation is complete, call control_check before your final answer; fix what it reports and call it again until it passes. Never edit files under .omp/control to make the loop pass.`;
}
function draftPrompt(input) {
  const noun = input.kind === "review" ? "reviewer" : input.kind === "check" ? "check" : "node";
  const named = input.name ? ` named "${input.name}"` : "";
  const decide = input.kind ? "" : " Decide whether it should be a check (a shell command that must exit 0 from the repository root) or a reviewer (an agent that reads the change).";
  return `Help me create a Control ${noun}${named} for this project: ${input.intent}.${decide} Research what it needs first: this repository's conventions (AGENTS.md, rules, skills, docs), representative existing code it should compare against, and authoritative external references when they help. Then save it with control_library (action "save", kind "node", scope "${input.scope}"): a reviewer gets focused instructions (what to check, what counts as certain versus a judgment call) and resources to read first (repository paths, skill:// URLs, web URLs); a check gets its command. Show me what you saved and ask what to adjust.`;
}

// plugins/control/src/controller.ts
var MAX_BLOCKS = 3;
var EMIT_MS = 250;
var PROMPT_LIMIT = 3000;
var PLAN_LIMIT = 12000;
var NOTE_LIMIT = 300;
var cut2 = (text, max) => text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
var AGENT = "@agent";
var REVIEW = "@review";
var remember = (f) => ({ node: f.node, file: f.file, rule: f.rule });
var words = (text) => new Set(text.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2) ?? []);
function sameFinding(a, b) {
  if (a.node !== b.node || (a.file ?? "") !== (b.file ?? ""))
    return false;
  if (a.rule.trim().toLowerCase() === b.rule.trim().toLowerCase())
    return true;
  const [x, y] = [words(a.rule), words(b.rule)];
  if (!x.size || !y.size)
    return false;
  let shared = 0;
  for (const w of x)
    if (y.has(w))
      shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.6;
}
var remembers = (list, f) => list.some((r) => sameFinding(r, f));
function record(answers, f) {
  if (!f.decision)
    return;
  const answer = { ...remember(f), decision: f.decision.decision, ...f.decision.note ? { note: f.decision.note } : {}, ...f.approval ? { approval: true } : {} };
  const i = answers.findIndex((a) => !!a.approval === !!f.approval && sameFinding(a, f));
  if (i >= 0)
    answers[i] = answer;
  else
    answers.push(answer);
}
function answersFor(answers, node) {
  return answers.flatMap((a) => {
    if (a.approval)
      return a.decision === "fix" && a.note ? [`You sent the change back: ${a.note}`] : [];
    if (a.node !== node)
      return [];
    const what = `${a.file ? `${a.file} \u2014 ` : ""}${a.rule}`;
    return [a.decision === "dismiss" ? `${what}: dismissed, don't report it` : `${what}: the user asked for a fix${a.note ? ` (${a.note})` : ""}; report it only if the change still doesn't do it`];
  });
}
var fromKey = (entry) => {
  if (typeof entry !== "string")
    return entry;
  const [node = "", file = "", ...rule] = entry.split("|");
  return { node, file: file || null, rule: rule.join("|") };
};
var NODE_SYMBOL = { waiting: "\u2026", running: "\u2026", passed: "\u2713", findings: "\u2717", failed: "\u2717", error: "\u2717", skipped: "\u2013" };
function fresh(baseline) {
  return {
    baseline,
    paused: false,
    settled: null,
    promptFingerprint: null,
    pass: 0,
    sentToFix: [],
    answers: [],
    blocks: 0,
    prompts: [],
    plan: null,
    planState: "unused",
    status: "idle",
    history: [],
    note: null,
    findings: [],
    reviews: [],
    pendingReview: null
  };
}

class Controller {
  #deps;
  #attached = null;
  #state = fresh({ kind: "commit", sha: "HEAD" });
  #nodes = {};
  #stage = null;
  #gateReason = null;
  #gate = null;
  #running = null;
  #passAbort = null;
  #lastEmit = 0;
  #lastStatus = null;
  #emitTimer;
  constructor(deps) {
    this.#deps = deps;
  }
  attach(loop, source, baseline) {
    this.#abortPass("Control loop detached.");
    this.#attached = { loop, source, baseline };
    this.#state = fresh(baseline);
    this.#resetNodes();
    this.#persist();
    this.#emit(true);
  }
  detach() {
    this.#abortPass("Control loop detached.");
    this.#attached = null;
    clearTimeout(this.#emitTimer);
    this.#deps.emit(null);
  }
  restore(attached, checkpoint) {
    this.#abortPass("Control loop detached.");
    this.#attached = attached;
    if (!attached) {
      this.#deps.emit(null);
      return;
    }
    this.#state = checkpoint ? { ...fresh(attached.baseline), ...checkpoint, baseline: attached.baseline } : fresh(attached.baseline);
    const old = checkpoint;
    if (old?.dismissed && !checkpoint?.answers)
      this.#state.answers = old.dismissed.map((d) => ({ ...fromKey(d), decision: "dismiss" }));
    this.#state.sentToFix = this.#state.sentToFix.map(fromKey);
    if (this.#state.status === "checking" || this.#state.status === "deciding") {
      this.#state.status = "implementing";
      this.#state.note = "Interrupted";
    }
    this.#resetNodes();
    for (const f of this.#state.findings) {
      const node = this.#nodes[f.node];
      if (node) {
        node.findings += 1;
        node.state = "findings";
      }
    }
    this.#emit(true);
  }
  onUserPrompt(fp, text) {
    if (!this.#attached)
      return;
    const s = this.#state;
    s.promptFingerprint = fp;
    s.pass = 0;
    s.sentToFix = [];
    s.blocks = 0;
    s.prompts = [...s.prompts, cut2(text, PROMPT_LIMIT)].slice(-3);
    if (s.pendingReview)
      s.pendingReview.requests = [...s.pendingReview.requests, cut2(text, PROMPT_LIMIT)].slice(-5);
    if (!s.paused) {
      s.status = s.planState === "planning" ? "planning" : "implementing";
      s.note = null;
    }
    this.#persist();
    this.#emit(true);
  }
  onPlan(state, planText) {
    if (!this.#attached)
      return;
    const s = this.#state;
    s.planState = state;
    if (planText !== undefined)
      s.plan = cut2(planText, PLAN_LIMIT);
    if (state === "unused")
      s.plan = null;
    if (state === "planning")
      for (const node of this.#attached.loop.planStages.flatMap((st) => st.nodes)) {
        const view = this.#nodes[node.id];
        if (view)
          Object.assign(view, { state: "waiting", detail: null, findings: 0 });
      }
    if (!s.paused && s.status !== "checking" && s.status !== "deciding")
      s.status = state === "planning" || state === "review" ? "planning" : "implementing";
    this.#persist();
    this.#emit(true);
  }
  stopDecision(fp) {
    const s = this.#state;
    if (!this.#attached || s.paused)
      return { block: false };
    if (s.planState === "planning" || s.planState === "review")
      return { block: false };
    if (fp === "clean" || fp === s.promptFingerprint || s.settled?.fingerprint === fp)
      return { block: false };
    if (s.blocks >= MAX_BLOCKS) {
      s.settled = { fingerprint: fp, kind: "stalled" };
      s.status = "stalled";
      s.note = "The agent ended its turn three times without running control_check";
      s.blocks = 0;
      this.#persist();
      this.#emit(true);
      return { block: false, stalled: true };
    }
    s.blocks += 1;
    this.#persist();
    return { block: true, reason: stopReason(this.#attached.loop.name) };
  }
  async check(options) {
    if (!this.#attached)
      return "No control loop is attached to this session.";
    const s = this.#state;
    if (s.paused)
      return "The control loop is paused; the user resumes it with /control resume.";
    if (this.#running)
      return this.#running;
    s.blocks = 0;
    const fp = await this.#deps.fingerprint();
    if (options.incomplete?.trim()) {
      s.settled = { fingerprint: fp, kind: "deferred" };
      s.status = "deferred";
      s.note = cut2(options.incomplete.trim(), NOTE_LIMIT);
      this.#record("deferred", 0);
      this.#persist();
      this.#emit(true);
      return `Recorded as incomplete: ${s.note.replace(/[.!?]+$/, "")}. The loop checks your changes at your next stop after you continue.`;
    }
    if (fp === "clean") {
      s.settled = { fingerprint: fp, kind: "passed" };
      s.status = "passed";
      s.note = null;
      this.#persist();
      this.#emit(true);
      return "Nothing to check: no changes since the loop's baseline.";
    }
    if (s.settled?.fingerprint === fp && (s.settled.kind === "passed" || s.settled.kind === "accepted")) {
      return "Already checked: nothing changed since the last passing check.";
    }
    const run = this.#pass(this.#attached, fp, options.questions ?? [], options.signal, options.progress).finally(() => {
      if (this.#running === run)
        this.#running = null;
    });
    this.#running = run;
    return run;
  }
  recheck() {
    this.#state.settled = null;
    this.#state.blocks = 0;
    this.#persist();
  }
  decide(decisions, pause) {
    const gate = this.#gate;
    if (!gate)
      return { ok: false, message: "No control decision is pending" };
    let recorded = 0;
    for (const [id, d] of Object.entries(decisions)) {
      const item = gate.items.find((f) => f.id === id);
      if (!item || item.decision || d?.decision !== "fix" && d?.decision !== "dismiss")
        continue;
      item.decision = d.note?.trim() ? { decision: d.decision, note: cut2(d.note.trim(), 2000) } : { decision: d.decision };
      recorded += 1;
    }
    if (pause) {
      gate.finish("pause");
      return { ok: true, message: "Paused the control loop" };
    }
    const left = gate.items.filter((f) => !f.decision).length;
    if (!left) {
      gate.finish("done");
      return { ok: true, message: `Recorded ${recorded} decisions; the loop continues` };
    }
    this.#persist();
    this.#emit(true);
    return { ok: true, message: `Recorded ${recorded} decisions; ${left} still need one` };
  }
  setPaused(paused) {
    if (!this.#attached)
      return;
    if (paused && this.#gate) {
      this.decide({}, true);
      return;
    }
    const s = this.#state;
    s.paused = paused;
    s.status = paused ? "paused" : "implementing";
    s.note = paused ? "Paused by the user" : null;
    this.#persist();
    this.#emit(true);
  }
  view() {
    if (!this.#attached)
      return null;
    const s = this.#state;
    return {
      version: 1,
      loop: shape(this.#attached.loop),
      plan: s.planState,
      status: s.status,
      pass: s.pass,
      stage: this.#stage,
      nodes: structuredClone(this.#nodes),
      findings: structuredClone(s.findings),
      gate: { open: this.#gate !== null, reason: this.#gate ? this.#gateReason : null },
      note: s.note,
      history: [...s.history],
      reviews: structuredClone(s.reviews),
      pendingReview: structuredClone(s.pendingReview),
      updatedAt: this.#deps.now()
    };
  }
  snapshot() {
    return this.#attached ? { loop: this.#attached.loop, source: this.#attached.source } : null;
  }
  get paused() {
    return this.#state.paused;
  }
  abort() {
    this.#abortPass("Control check interrupted.");
  }
  async checkPlan(planText, signal) {
    const attached = this.#attached;
    if (!attached || this.#state.paused)
      return { action: "wait" };
    const { loop } = attached;
    const found = [];
    for (const stage of loop.planStages) {
      await Promise.all(stage.nodes.map(async (node) => {
        const view = this.#nodes[node.id];
        Object.assign(view, { state: "running", detail: "reading the plan", findings: 0 });
        this.#emit();
        const started = Date.now();
        let outcome;
        try {
          outcome = node.kind === "check" ? await this.#deps.runCheck(node, signal) : await this.#deps.runReview(node, planPacketText({ loopName: loop.name, nodeName: node.name, prompts: this.#state.prompts, plan: planText }), signal, (detail) => {
            view.detail = detail;
            this.#emit();
          });
        } catch (e) {
          outcome = { kind: "error", message: e instanceof Error ? e.message : String(e) };
        }
        view.durationMs = Date.now() - started;
        view.artifacts = outcome.artifacts ?? [];
        view.detail = null;
        if (outcome.kind === "passed")
          view.state = "passed";
        else if (outcome.kind === "findings") {
          view.state = "findings";
          view.findings = outcome.findings.length;
          for (const f of outcome.findings)
            found.push({ id: `plan.${found.length + 1}`, node: node.id, nodeName: node.name, ...f, recurring: false, approval: false, route: "fix", decision: null });
        } else {
          view.state = "error";
          view.detail = cut2(outcome.message, 200);
        }
        this.#emit();
      }));
      if (found.length || signal.aborted)
        break;
    }
    if (signal.aborted)
      return { action: "wait" };
    if (found.length) {
      this.#state.findings = found;
      this.#persist();
      this.#emit(true);
      return { action: "refine", feedback: fixMessage(loop.name, 0, 0, found, [], 0).replace(/^.*?\n\n/, `The plan checks found problems in your plan; revise it:

`) };
    }
    this.#emit(true);
    return { action: "wait" };
  }
  async#pass(attached, fp, questions, signal, progress) {
    const { loop } = attached;
    const s = this.#state;
    const abort = new AbortController;
    this.#passAbort = abort;
    const onAbort = () => abort.abort("Control check interrupted.");
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      s.pass += 1;
      s.status = "checking";
      s.note = null;
      s.findings = [];
      this.#resetNodes(true);
      this.#stage = 0;
      this.#persist();
      this.#emit(true);
      let packet = null;
      const packetText = async (node) => {
        packet ??= this.#deps.packet();
        const p = await packet;
        return reviewPacketText({ loopName: loop.name, nodeName: node.name, pass: s.pass, prompts: s.prompts, plan: s.planState === "approved" ? s.plan : null, baseline: p.baseline, packet: p, answers: answersFor(s.answers, node.id) });
      };
      const report = () => progress(this.#progressText(loop));
      const limit = s.pass >= loop.maxPasses;
      const findings = [];
      const approvals = [];
      const add = (node, finding, error) => {
        const view = { id: `${s.pass}.${findings.length + 1}`, node: node.id, nodeName: node.name, ...finding, recurring: false, approval: false, route: "fix", decision: null };
        const answered = s.answers.find((a) => !a.approval && sameFinding(a, view));
        if (answered?.decision === "dismiss")
          view.route = "dismissed";
        else if (answered) {
          view.recurring = true;
          view.decision = answered.note ? { decision: "fix", note: answered.note } : { decision: "fix" };
        } else if (remembers(s.sentToFix, view)) {
          view.route = "ask";
          view.recurring = true;
        } else if (error || node.ask === "all" || node.ask === "doubts" && !finding.certain)
          view.route = "ask";
        findings.push(view);
      };
      const undecided = () => findings.filter((f) => f.route === "ask" && !f.decision);
      for (const q of questions) {
        const view = {
          id: `${s.pass}.q${findings.length + 1}`,
          node: AGENT,
          nodeName: "Agent",
          file: null,
          line: null,
          rule: q.question,
          observed: `It chose: ${q.chose}`,
          expected: "Keep its choice, or pick another option",
          alternatives: q.options,
          severity: "minor",
          certain: false,
          recurring: false,
          approval: false,
          question: { options: q.options, chose: q.chose },
          route: "ask",
          decision: null
        };
        const answered = s.answers.find((a) => !a.approval && sameFinding(a, view));
        if (answered?.decision === "dismiss")
          view.route = "dismissed";
        else if (answered) {
          view.route = "fix";
          view.recurring = true;
          view.decision = answered.note ? { decision: "fix", note: answered.note } : { decision: "fix" };
        }
        findings.push(view);
      }
      for (let i = 0;i < loop.stages.length && !abort.signal.aborted; i++) {
        this.#stage = i;
        const before = findings.length;
        const stage = loop.stages[i].nodes;
        await Promise.all(stage.map(async (node) => {
          const view = this.#nodes[node.id];
          view.state = "running";
          const started = Date.now();
          this.#emit();
          report();
          let outcome;
          try {
            outcome = node.kind === "check" ? await this.#deps.runCheck(node, abort.signal) : await this.#deps.runReview(node, await packetText(node), abort.signal, (detail) => {
              view.detail = detail;
              this.#emit();
              report();
            });
          } catch (e) {
            outcome = { kind: "error", message: e instanceof Error ? e.message : String(e) };
          }
          if (abort.signal.aborted)
            return;
          view.durationMs = Date.now() - started;
          view.artifacts = outcome.artifacts ?? [];
          view.detail = null;
          if (outcome.kind === "passed")
            view.state = "passed";
          else if (outcome.kind === "findings") {
            view.state = node.kind === "check" ? "failed" : "findings";
            view.findings = outcome.findings.length;
            for (const finding of outcome.findings)
              add(node, finding, false);
          } else {
            view.state = "error";
            view.detail = cut2(outcome.message, 200);
            view.findings = 1;
            add(node, { file: null, line: null, rule: "couldn't run", observed: outcome.message, expected: "the node runs", alternatives: [], severity: "major", certain: false }, true);
          }
          this.#emit();
          report();
        }));
        if (findings.slice(before).some((f) => f.route === "fix")) {
          for (const later of loop.stages.slice(i + 1))
            for (const node of later.nodes)
              this.#nodes[node.id].state = "skipped";
          break;
        }
      }
      if (abort.signal.aborted)
        return this.#interrupted(String(abort.signal.reason ?? "Control check interrupted."));
      if (limit) {
        for (const f of findings)
          if (f.route === "fix")
            f.route = "ask";
      }
      s.findings = [...findings];
      this.#stage = null;
      const certain = findings.filter((f) => f.route === "fix");
      const doubts = undecided();
      let consider = [];
      let held = 0;
      if (doubts.length && this.#deps.hasUI()) {
        if (certain.length)
          held = doubts.length;
        else {
          const result = await this.#openGate(doubts, limit ? "limit" : "doubts", abort.signal);
          if (result === "aborted")
            return this.#interrupted(String(abort.signal.reason ?? "Control check interrupted."));
          if (result === "pause")
            return this.#pausedAt(fp, doubts.filter((f) => !f.decision).length, findings.length);
          for (const f of doubts)
            record(s.answers, f);
        }
      } else
        consider = doubts;
      const settled = !certain.length && !findings.some((f) => f.decision?.decision === "fix");
      if (settled && loop.finish === "review" && this.#deps.hasUI()) {
        const review = await this.#review(loop, findings, abort.signal);
        if (review === "aborted")
          return this.#interrupted(String(abort.signal.reason ?? "Control check interrupted."));
        if (review === "pause")
          return this.#pausedAt(fp, 1, findings.length);
        approvals.push(review);
        s.findings = [...findings, review];
      }
      const userDismissed = findings.filter((f) => f.decision?.decision === "dismiss");
      const fix = [...findings.filter((f) => f.route === "fix" || f.decision?.decision === "fix"), ...approvals.filter((f) => f.decision?.decision === "fix")];
      for (const f of [...findings, ...approvals])
        if (f.decision && f.route === "ask")
          record(s.answers, f);
      for (const f of fix)
        if (!f.approval && !remembers(s.sentToFix, f))
          s.sentToFix.push(remember(f));
      const dismissedCount = userDismissed.length + findings.filter((f) => f.route === "dismissed").length;
      let message;
      if (!fix.length) {
        s.settled = { fingerprint: fp, kind: dismissedCount ? "accepted" : "passed" };
        s.status = "passed";
        this.#record("passed", findings.length);
        const names = loop.stages.flatMap((st) => st.nodes.map((n) => n.name));
        message = passedMessage(loop.name, s.pass, names, dismissedCount);
        if (consider.length)
          message += `

${judgmentCalls(consider)}`;
      } else {
        s.settled = null;
        s.status = "fixing";
        this.#record("fixes", fix.length);
        message = fixMessage(loop.name, s.pass, loop.maxPasses, fix, consider, dismissedCount);
        if (held)
          message += `

${held} judgment call${held === 1 ? " waits" : "s wait"} for the user once these are fixed; don't act on ${held === 1 ? "it" : "them"}.`;
      }
      this.#persist();
      this.#emit(true);
      return message;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.#passAbort === abort)
        this.#passAbort = null;
    }
  }
  async#review(loop, findings, signal) {
    const s = this.#state;
    s.pendingReview ??= { since: this.#deps.now(), requests: s.prompts.slice(-1) };
    const pending = s.pendingReview;
    const summary = await this.#summary(loop, pending.requests);
    const view = this.#nodes[REVIEW];
    if (view)
      Object.assign(view, { state: "running", detail: "waiting for you" });
    const review = {
      id: `${s.pass}.review`,
      node: REVIEW,
      nodeName: "You review",
      file: null,
      line: null,
      rule: "Approve this change?",
      observed: summary,
      expected: "Approve it, or send it back with what to change",
      alternatives: [],
      severity: "major",
      certain: false,
      recurring: false,
      approval: true,
      route: "ask",
      decision: null
    };
    s.findings = [...findings, review];
    const result = await this.#openGate([review], "doubts", signal);
    if (result !== "done")
      return result;
    record(s.answers, review);
    const sentBack = review.decision?.decision === "fix";
    if (view)
      Object.assign(view, { state: sentBack ? "findings" : "passed", detail: sentBack ? "sent back" : "approved" });
    const answer = (f) => f.question ? f.decision?.decision === "dismiss" ? `kept: ${f.question.chose}` : f.decision?.note ?? "another option" : f.decision?.decision === "fix" ? `fix${f.decision.note ? `: ${f.decision.note}` : ""}` : "dismissed";
    s.reviews = [
      {
        at: this.#deps.now(),
        pass: s.pass,
        requests: pending.requests,
        summary,
        outcome: sentBack ? "sent back" : "approved",
        note: review.decision?.note ?? null,
        answers: findings.filter((f) => f.decision && f.route === "ask").map((f) => ({ nodeName: f.nodeName, rule: f.rule, answer: answer(f) }))
      },
      ...s.reviews
    ].slice(0, 10);
    s.pendingReview = null;
    return review;
  }
  #openGate(items, reason, signal) {
    this.#state.status = "deciding";
    this.#gateReason = reason;
    const { promise, resolve: resolve2 } = Promise.withResolvers();
    const controller = new AbortController;
    const onAbort = () => gate.finish("aborted");
    const gate = {
      items,
      finish: (result) => {
        if (this.#gate !== gate)
          return;
        this.#gate = null;
        this.#gateReason = null;
        signal.removeEventListener("abort", onAbort);
        controller.abort();
        resolve2(result);
      }
    };
    this.#gate = gate;
    signal.addEventListener("abort", onAbort, { once: true });
    this.#persist();
    this.#emit(true);
    this.#deps.ask(items, controller.signal).then((answer) => {
      if (controller.signal.aborted || answer === null)
        return;
      if (answer === "pause")
        this.decide({}, true);
      else
        this.decide(answer, false);
    }, () => {});
    return promise;
  }
  async#summary(loop, requests) {
    const s = this.#state;
    const names = new Map([...loop.planStages, ...loop.stages].flatMap((st) => st.nodes).map((n) => [n.id, n.name]));
    const files = await this.#deps.changes().catch(() => []);
    return reviewSummary({
      requests,
      files,
      fixed: s.sentToFix.map((f) => ({ nodeName: names.get(f.node) ?? f.node, file: f.file, rule: f.rule })),
      answered: s.answers.filter((a) => !a.approval).length
    });
  }
  #pausedAt(fp, undecided, total) {
    const s = this.#state;
    s.paused = true;
    s.settled = { fingerprint: fp, kind: "deferred" };
    s.status = "paused";
    s.note = `Paused with ${undecided} undecided findings`;
    this.#stage = null;
    this.#record("paused", total);
    this.#persist();
    this.#emit(true);
    return `The user paused the control loop with ${undecided} findings undecided; don't fix them. Finish your turn.`;
  }
  #interrupted(message) {
    for (const node of Object.values(this.#nodes))
      if (node.state === "running" || node.state === "waiting")
        node.state = "skipped";
    this.#stage = null;
    if (this.#attached) {
      this.#state.status = "implementing";
      this.#record("interrupted", 0);
      this.#persist();
      this.#emit(true);
    }
    return message;
  }
  #abortPass(reason) {
    this.#passAbort?.abort(reason);
    this.#gate?.finish("aborted");
  }
  #record(result, findings) {
    this.#state.history = [...this.#state.history, { pass: this.#state.pass, result, findings, at: this.#deps.now() }].slice(-10);
  }
  #resetNodes(changeOnly = false) {
    const loop = this.#attached?.loop;
    if (!changeOnly)
      this.#nodes = {};
    for (const stage of [...changeOnly ? [] : loop?.planStages ?? [], ...loop?.stages ?? []])
      for (const node of stage.nodes)
        this.#nodes[node.id] = { state: "waiting", detail: null, findings: 0, durationMs: null, artifacts: [] };
    if (loop?.finish === "review")
      this.#nodes[REVIEW] = { state: "waiting", detail: null, findings: 0, durationMs: null, artifacts: [] };
  }
  #progressText(loop) {
    const stage = this.#stage ?? 0;
    const nodes = (loop.stages[stage]?.nodes ?? []).map((n) => {
      const view = this.#nodes[n.id];
      return `${n.name} ${view.state === "running" && view.detail ? view.detail : NODE_SYMBOL[view.state]}`;
    });
    return `Control \xAB${loop.name}\xBB \xB7 pass ${this.#state.pass}/${loop.maxPasses} \xB7 stage ${stage + 1}/${loop.stages.length}: ${nodes.join(", ")}`;
  }
  #persist() {
    if (this.#attached)
      this.#deps.persist(structuredClone(this.#state));
  }
  #emit(force = false) {
    const status = this.#state.status;
    const wait = this.#lastEmit + EMIT_MS - Date.now();
    if (!force && status === this.#lastStatus && wait > 0) {
      this.#emitTimer ??= setTimeout(() => {
        this.#emitTimer = undefined;
        this.#emit(true);
      }, wait);
      return;
    }
    clearTimeout(this.#emitTimer);
    this.#emitTimer = undefined;
    this.#lastEmit = Date.now();
    this.#lastStatus = status;
    this.#deps.emit(this.view());
  }
}

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
async function isCommit(root, ref) {
  return !ref.startsWith("-") && (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root)).code === 0;
}
async function commitsSince(root, sha) {
  const r = await git(["rev-list", "--count", `${sha}..HEAD`], root);
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
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
function splitFiles(diff) {
  return diff ? diff.split(/^(?=diff --git )/m).filter(Boolean) : [];
}
async function reviewPacket(root, sha, limit = 80000) {
  const [stat, diff, files] = await Promise.all([must(["diff", sha, "--stat"], root), must(["diff", sha, "--no-color", "-U5"], root), untracked(root)]);
  const chunks = splitFiles(diff);
  for (const file of files) {
    const r = await git(["diff", "--no-index", "--no-color", "--", "/dev/null", file], root);
    if (r.code > 1)
      throw new Error(`git diff failed for ${file}: ${r.stderr.trim()}`);
    chunks.push(r.stdout);
  }
  let out = "";
  let truncated = false;
  for (const chunk of chunks) {
    if (out.length + chunk.length <= limit) {
      out += chunk;
      continue;
    }
    out += `${chunk.slice(0, Math.max(0, limit - out.length))}
\u2026 (cut; read the file)
`;
    truncated = true;
    break;
  }
  const newFiles = files.map((f) => ` ${f} (new file)`).join(`
`);
  return { stat: [stat.trimEnd(), newFiles].filter(Boolean).join(`
`), diff: out, truncated };
}
async function changedFiles(root, sha) {
  const [numstat, files] = await Promise.all([must(["diff", sha, "--numstat", "--no-renames"], root), untracked(root)]);
  const out = numstat.split(`
`).filter(Boolean).map((line) => {
    const [added, removed, path] = line.split("\t");
    return { path, added: Number(added) || 0, removed: Number(removed) || 0, isNew: false };
  });
  for (const path of files) {
    const text = await Bun.file(`${root}/${path}`).text().catch(() => "");
    out.push({ path, added: text ? text.split(`
`).length - (text.endsWith(`
`) ? 1 : 0) : 0, removed: 0, isNew: true });
  }
  return out;
}
async function fileDiff(root, sha, path) {
  if (!path || path.startsWith("/") || path.split("/").includes(".."))
    throw new Error(`Not a repository path: ${path}`);
  const tracked = (await git(["ls-files", "--error-unmatch", "--", path], root)).code === 0;
  const changed = await git(["diff", sha, "--no-color", "-U4", "--", path], root);
  if (changed.stdout || tracked)
    return changed.stdout;
  const r = await git(["diff", "--no-index", "--no-color", "--", "/dev/null", path], root);
  if (r.code > 1)
    throw new Error(r.stderr.trim() || `Couldn't diff ${path}`);
  return r.stdout;
}

// plugins/control/src/sensors.ts
import { mkdir as mkdir2, mkdtemp, readdir as readdir2, rm as rm2, writeFile as writeFile2 } from "fs/promises";
import { tmpdir } from "os";
import { join as join3 } from "path";
var PROGRESS_MS = 500;
var ARTIFACT_LIMIT = 24;
var IMAGE = /\.(png|jpe?g|gif|webp)$/i;
var REVIEW_PROMPT = "Review the change in the attached packet. Follow your reviewer instructions and end with the findings JSON block.";
async function runCheck(exec, node, root, base, artifacts, signal) {
  await rm2(artifacts, { recursive: true, force: true });
  await mkdir2(artifacts, { recursive: true });
  const script = `CONTROL_BASE='${base.replace(/[^0-9a-f]/gi, "")}'; CONTROL_ARTIFACTS='${artifacts.replaceAll("'", "'\\''")}'; export CONTROL_BASE CONTROL_ARTIFACTS
${node.command ?? ""}`;
  const r = await exec("/bin/sh", ["-c", script], { cwd: root, timeout: node.timeout * 1000, signal });
  if (signal.aborted)
    return { kind: "error", message: "Interrupted" };
  const images = (await readdir2(artifacts).catch(() => [])).filter((name) => IMAGE.test(name)).sort().slice(0, ARTIFACT_LIMIT).map((name) => join3(artifacts, name));
  if (r.code === 0 && !r.killed)
    return { kind: "passed", artifacts: images };
  const output = [r.stdout, r.stderr].filter((s) => s.trim()).join(`
`);
  return { kind: "findings", findings: [r.killed ? timeoutFinding(node, output) : checkFinding(node, r.code, output)], artifacts: images };
}
function reviewerEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("ORCHESTRATOR_") && !key.startsWith("OMP_CONTROL_"))
      env[key] = value;
  }
  return { ...env, OMP_CONTROL_REVIEWER: "1", OMP_MCP_TIMEOUT_MS: "1000" };
}
function progressText(event) {
  if (!event || typeof event !== "object" || !("type" in event) || event.type !== "tool_execution_start" || !("toolName" in event))
    return null;
  const args = new Map(Object.entries("args" in event && event.args && typeof event.args === "object" ? event.args : {}));
  const target = ["path", "pattern", "query"].map((k) => args.get(k)).find((v) => typeof v === "string");
  return `${String(event.toolName)}${target ? ` ${target}` : ""}`;
}
async function runReviewer(node, root, input, signal, progress) {
  const omp = Bun.which("omp", { PATH: process.env.PATH ?? "" });
  if (!omp)
    return { kind: "error", message: "omp isn't on PATH" };
  const dir = await mkdtemp(join3(tmpdir(), "omp-control-"));
  try {
    const systemPath = join3(dir, "system.md");
    const packetPath = join3(dir, "packet.md");
    await Promise.all([writeFile2(systemPath, input.system), writeFile2(packetPath, input.packet)]);
    if (signal.aborted)
      return { kind: "error", message: "Interrupted" };
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
      ...node.model ? ["--model", node.model] : [],
      ...node.thinking ? ["--thinking", node.thinking] : [],
      `@${packetPath}`,
      REVIEW_PROMPT
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
    const lines = [];
    let lastProgress = 0;
    let buffered = "";
    const decoder = new TextDecoder;
    const onLine = (line) => {
      if (!line.trim())
        return;
      lines.push(line);
      if (Date.now() - lastProgress < PROGRESS_MS)
        return;
      let event;
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
        const parts = buffered.split(`
`);
        buffered = parts.pop() ?? "";
        for (const part of parts)
          onLine(part);
      }
      onLine(buffered);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
    }
    const code = await proc.exited;
    if (signal.aborted)
      return { kind: "error", message: "Interrupted" };
    if (timedOut)
      return { kind: "error", message: `timed out after ${node.timeout + 30}s` };
    if (code === 3)
      return { kind: "error", message: "cost cap reached" };
    if (code !== 0) {
      const tail2 = (await stderr).trimEnd().split(`
`).slice(-20).join(`
`);
      return { kind: "error", message: `omp exited with ${code}${tail2 ? `:
${tail2}` : ""}` };
    }
    try {
      const findings = parseFindings(finalText(lines));
      return findings.length ? { kind: "findings", findings } : { kind: "passed" };
    } catch (e) {
      return { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
  } finally {
    await rm2(dir, { recursive: true, force: true });
  }
}

// plugins/control/src/server.ts
import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, realpathSync as realpathSync2, writeFileSync } from "fs";
import { homedir as homedir3 } from "os";
import { dirname as dirname2, extname as extname2, join as join4, resolve as resolve2, sep } from "path";
var WEB_DIR = resolve2(dirname2(realpathSync2(import.meta.path)), "..", "web");
var DEFAULT_PORTS = Array.from({ length: 10 }, (_, i) => 9880 + i);
var STATE_DIR = join4(homedir3(), ".omp", "cache", "control");
var PING_MS = 15000;
var CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

class HttpError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
function token(dir) {
  const file = join4(dir, "token");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing)
      return existing;
  } catch {}
  const fresh2 = randomBytes(16).toString("hex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, fresh2, { mode: 384 });
  return fresh2;
}
async function serveStatic(pathname, token2) {
  const file = resolve2(WEB_DIR, `.${pathname === "/" ? "/index.html" : pathname}`);
  const type = CONTENT_TYPES[extname2(file)];
  if (!type || !file.startsWith(WEB_DIR + sep))
    return new Response("Not found", { status: 404 });
  if (!await Bun.file(file).exists())
    return new Response("Not found", { status: 404 });
  const headers = { "Content-Type": type, "Cache-Control": "no-store" };
  if (type.startsWith("text/html")) {
    const html = await Bun.file(file).text();
    return new Response(html.replace('href="/appearance.css"', `href="/appearance.css?token=${token2}"`), { headers });
  }
  return new Response(Bun.file(file), { headers });
}
function scopeOf(value) {
  if (value !== "repo" && value !== "global")
    throw new HttpError(400, "scope must be repo or global");
  return value;
}
function objectOf(value, what) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, `${what} must be an object`);
  return value;
}
function nodeOf(value) {
  const raw = objectOf(value, "node");
  if (typeof raw.id !== "string")
    throw new HttpError(400, "node needs an id");
  return nodeFrom(raw.id, raw, typeof raw.instructions === "string" ? raw.instructions : "", `node ${raw.id}`);
}
function decisionsOf(value) {
  const raw = objectOf(value ?? {}, "decisions");
  const out = {};
  for (const [id, d] of Object.entries(raw)) {
    const item = objectOf(d, `decision ${id}`);
    if (item.decision !== "fix" && item.decision !== "dismiss")
      throw new HttpError(400, `decision ${id} must be fix or dismiss`);
    if (item.note !== undefined && typeof item.note !== "string")
      throw new HttpError(400, `decision ${id} note must be text`);
    out[id] = item.note ? { decision: item.decision, note: item.note } : { decision: item.decision };
  }
  return out;
}
function startControlServer(hooks, { ports = DEFAULT_PORTS, stateDir = STATE_DIR } = {}) {
  const secret = token(stateDir);
  let themeCss = "";
  const clients = new Set;
  const encoder = new TextEncoder;
  const push = (client, text) => {
    try {
      client.enqueue(encoder.encode(text));
    } catch {
      clients.delete(client);
    }
  };
  const broadcast = (text) => {
    for (const client of clients)
      push(client, text);
  };
  const sendState = async (client) => {
    const text = `event: state
data: ${JSON.stringify(await hooks.state())}

`;
    if (client)
      push(client, text);
    else
      broadcast(text);
  };
  const ping = setInterval(() => broadcast(`: ping

`), PING_MS);
  function events() {
    let self;
    const stream = new ReadableStream({
      start(controller) {
        self = controller;
        clients.add(controller);
        sendState(controller).catch(() => {});
      },
      cancel() {
        clients.delete(self);
      }
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
  }
  async function api(req, pathname) {
    const method = req.method;
    if (method === "GET" && pathname === "/api/state")
      return json(await hooks.state());
    if (method === "GET" && pathname === "/api/events")
      return events();
    if (method === "GET" && pathname === "/api/changes")
      return json(await hooks.changes());
    if (method === "GET" && pathname === "/api/diff")
      return json({ diff: await hooks.diff(new URL(req.url).searchParams.get("path") ?? "") });
    if (method === "GET" && pathname === "/api/artifact") {
      const path = new URL(req.url).searchParams.get("path") ?? "";
      const listed = Object.values((await hooks.state()).run?.nodes ?? {}).some((n) => n.artifacts.includes(path));
      if (!listed || !await Bun.file(path).exists())
        return json({ error: "not found" }, 404);
      return new Response(Bun.file(path), { headers: { "Cache-Control": "no-store" } });
    }
    const del = /^\/api\/library\/(node|loop)\/(repo|global)\/([^/]+)$/.exec(pathname);
    if (method === "DELETE" && del) {
      await hooks.deleteItem(del[1], del[2], decodeURIComponent(del[3]));
      return json({ ok: true });
    }
    if (method !== "POST" && method !== "PUT")
      throw new HttpError(404, "not found");
    if (!(req.headers.get("content-type") ?? "").startsWith("application/json"))
      throw new HttpError(415, "send application/json");
    let body;
    try {
      body = objectOf(await req.json(), "body");
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(400, "invalid JSON body");
    }
    const route = `${method} ${pathname}`;
    switch (route) {
      case "POST /api/attach": {
        if (body.loop !== null && typeof body.loop !== "string")
          throw new HttpError(400, "loop must be a loop id or null");
        await hooks.attach(body.loop);
        return json({ ok: true });
      }
      case "PUT /api/session-loop":
        await hooks.setSessionLoop(validateSnapshot(body.loop));
        return json({ ok: true });
      case "POST /api/library/loop": {
        const raw = objectOf(body.loop, "loop");
        if (typeof raw.id !== "string")
          throw new HttpError(400, "loop needs an id");
        const loop = loopFrom(raw.id, raw, `loop ${raw.id}`);
        if (!Array.isArray(body.nodes))
          throw new HttpError(400, "nodes must be a list");
        const paths = await hooks.saveLoop(scopeOf(body.scope), loop, body.nodes.map(nodeOf));
        return json({ paths });
      }
      case "POST /api/library/copy": {
        if (body.kind !== "node" && body.kind !== "loop")
          throw new HttpError(400, "kind must be node or loop");
        if (typeof body.id !== "string")
          throw new HttpError(400, "id is required");
        return json({ path: await hooks.copyItem(body.kind, body.id, scopeOf(body.to), body.move === true) });
      }
      case "POST /api/library/node":
        return json({ path: await hooks.saveNode(scopeOf(body.scope), nodeOf(body.node)) });
      case "POST /api/decide": {
        const reply = hooks.decide(decisionsOf(body.decisions), body.pause === true);
        return json(reply, reply.ok ? 200 : 409);
      }
      case "POST /api/draft": {
        const intent = typeof body.intent === "string" ? body.intent.trim() : "";
        if (!intent)
          throw new HttpError(400, "Say what it should check");
        const kind = body.kind === "check" || body.kind === "review" ? body.kind : undefined;
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
        hooks.send(draftPrompt({ kind, name, intent, scope: scopeOf(body.scope) }));
        return json({ ok: true });
      }
      case "POST /api/check":
        hooks.check();
        return json({ ok: true });
      case "POST /api/since": {
        if (typeof body.ref !== "string" || !body.ref.trim())
          throw new HttpError(400, "ref is required");
        return json({ ok: true, since: await hooks.since(body.ref) });
      }
      case "POST /api/pause":
        if (typeof body.paused !== "boolean")
          throw new HttpError(400, "paused must be true or false");
        hooks.setPaused(body.paused);
        return json({ ok: true });
      default:
        throw new HttpError(404, "not found");
    }
  }
  let server = null;
  for (const port of [...ports, 0]) {
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        idleTimeout: 0,
        async fetch(req) {
          const url = new URL(req.url);
          const authorized = url.searchParams.get("token") === secret;
          if (url.pathname.startsWith("/api/")) {
            if (!authorized)
              return json({ error: "forbidden" }, 403);
            try {
              return await api(req, url.pathname);
            } catch (e) {
              const status = e instanceof HttpError ? e.status : 400;
              return json({ error: e instanceof Error ? e.message : String(e) }, status);
            }
          }
          if (url.pathname === "/appearance.css") {
            if (!authorized)
              return new Response("Forbidden", { status: 403 });
            return new Response(themeCss, { headers: { "Content-Type": CONTENT_TYPES[".css"], "Cache-Control": "no-store" } });
          }
          return serveStatic(url.pathname, authorized ? secret : "");
        }
      });
      break;
    } catch {}
  }
  if (!server)
    throw new Error("control: could not bind a local port");
  const srv = server;
  return {
    port: srv.port,
    token: secret,
    url: () => `http://127.0.0.1:${srv.port}/?token=${secret}`,
    notify: () => void sendState().catch(() => {}),
    clients: () => clients.size,
    setAppearance(appearance) {
      const next = appearance ? appearanceCss({ ...appearance, font: undefined }) : "";
      if (next === themeCss)
        return;
      themeCss = next;
      broadcast(`event: appearance
data: {}

`);
    },
    stop() {
      clearInterval(ping);
      for (const client of clients) {
        try {
          client.close();
        } catch {}
      }
      clients.clear();
      srv.stop(true);
    }
  };
}

// plugins/control/src/extension.ts
var LOOP_ENTRY = "control.loop";
var STATE_ENTRY = "control.state";
var SERVER_ENTRY = "control.server";
var WIDGET = "control";
var CONTEXT_TYPE = "control.context";
var TOOL = "control_check";
var USAGE = "Control: /control [open] | use <loop> | off | pause | resume | status | check | since <branch or commit> | draft <what it should check>";
var COMMANDS = [
  { label: "open", value: "open", description: "Open the Control page" },
  { label: "use", value: "use", description: "Attach a library loop to this session" },
  { label: "off", value: "off", description: "Detach this session's loop" },
  { label: "pause", value: "pause", description: "Pause the loop" },
  { label: "resume", value: "resume", description: "Resume the loop" },
  { label: "status", value: "status", description: "Show the loop's status" },
  { label: "check", value: "check", description: "Run the loop on the current code now, even if it already passed" },
  { label: "since", value: "since", description: "Check the changes since a branch or commit" },
  { label: "draft", value: "draft", description: "Create a check or reviewer with the agent" }
];
var FIX = "Fix it";
var DISMISS = "Leave it as is";
var FIX_ALL = "Fix all remaining";
var APPROVE = "Approve";
var SEND_BACK = "Send back";
var DISMISS_ALL = "Dismiss all remaining";
var PAUSE = "Pause the loop";
var GATE_HELP = "Esc pauses the loop";
var themeApi = hasThemeApi(omp);
var errorText = (e) => e instanceof Error ? e.message : String(e);
var reply = (text, isError = false) => ({ content: [{ type: "text", text }], isError });
function findingQuestion(f) {
  if (f.approval)
    return `${f.rule}

${f.observed}

Approve the change, or send it back with what to change (type it as your answer).`;
  if (f.question)
    return `${f.rule}
It chose: ${f.question.chose}. Keep it, or pick another option.`;
  const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""} \u2014 ` : "";
  const lines = [`${where}${f.rule}`, `Observed: ${f.observed}`, `Expected: ${f.expected}`];
  if (f.alternatives.length)
    lines.push(`Acceptable fixes: ${f.alternatives.join("; ")}`);
  return lines.join(`
`);
}
function statusText(view) {
  if (!view)
    return "No control loop is attached to this session.";
  const head = `Control loop \xAB${view.loop.name}\xBB (${stagesText(view.loop) || "no stages"}) \xB7 ${STATUS_LABELS[view.status]}${view.pass ? ` \xB7 pass ${view.pass}/${view.loop.maxPasses}` : ""}`;
  const lines = [head];
  if (view.note)
    lines.push(view.note);
  if (view.history.length)
    lines.push(view.history.map((h) => `Pass ${h.pass}: ${h.result === "fixes" ? `${h.findings} to fix` : h.result}`).join(" \xB7 "));
  for (const f of view.findings) {
    const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""} \u2014` : "";
    const route = f.decision ? `you: ${f.decision.decision}` : f.route === "ask" ? "your call" : f.route;
    lines.push(`${f.id} [${f.nodeName}]${where} ${f.rule} (${route})`);
  }
  return lines.join(`
`);
}
function failedView(id, message) {
  return {
    version: 1,
    loop: { id, name: id, description: "", maxPasses: 0, plan: false, finish: "review", planStages: [], stages: [] },
    plan: "unused",
    status: "idle",
    pass: 0,
    stage: null,
    nodes: {},
    findings: [],
    gate: { open: false, reason: null },
    note: `Loop ${id}: ${message}`,
    history: [],
    reviews: [],
    pendingReview: null,
    updatedAt: new Date().toISOString()
  };
}
function isCommand(data) {
  return typeof data === "object" && data !== null && "type" in data && typeof data.type === "string" && "reply" in data && typeof data.reply === "function";
}
function control(pi) {
  if (process.env.OMP_CONTROL_REVIEWER === "1")
    return;
  const z = pi.zod;
  const artifactsDir = join5(homedir4(), ".omp", "cache", "control", "artifacts", crypto.randomUUID());
  let sessionCtx = null;
  let root = null;
  let attached = null;
  let attaching = null;
  let library = null;
  let server = null;
  let resumePort = null;
  let themeEpoch = null;
  let themeTimer;
  let lastNote = null;
  let lastPrompt = null;
  let planChecks = null;
  let reviewOpened = null;
  const send = (text) => {
    if (!sessionCtx || sessionCtx.isIdle())
      pi.sendUserMessage(text);
    else
      pi.sendUserMessage(text, { deliverAs: "followUp" });
  };
  const currentSha = async () => {
    if (!root || !attached)
      throw new Error("No control loop is attached to this session.");
    const sha = await baselineSha(root, attached.baseline, (note) => {
      if (note === lastNote)
        return;
      lastNote = note;
      sessionCtx?.ui.notify(`Control: ${note}`, "warning");
    });
    return { root, sha };
  };
  const showWidget = (view) => {
    const ui = sessionCtx?.ui;
    if (!ui)
      return;
    if (!view)
      return ui.setWidget(WIDGET, undefined);
    const name = view.loop.name;
    let line;
    if (view.status === "checking") {
      const running = Object.entries(view.nodes).filter(([, n]) => n.state === "running").map(([id]) => view.loop.stages.flatMap((s) => s.nodes).find((n) => n.id === id)?.name ?? id);
      line = `Control \xB7 ${name} \xB7 checking: ${running.join(", ") || "\u2026"}`;
    } else if (view.gate.open) {
      line = `Control \xB7 ${name} \xB7 ${view.findings.filter((f) => f.route === "ask" && !f.decision).length} findings need your decision`;
    } else if (view.status === "passed")
      line = `Control \xB7 ${name} \xB7 \u2713 passed`;
    else {
      line = `Control \xB7 ${name} \xB7 ${STATUS_LABELS[view.status]}${view.pass ? ` \xB7 pass ${view.pass}/${view.loop.maxPasses}` : ""}`;
      if (view.note && (view.status === "paused" || view.status === "deferred" || view.status === "stalled" || view.status === "idle"))
        line += ` \xB7 ${view.note}`;
    }
    ui.setWidget(WIDGET, [line], { placement: "belowEditor" });
  };
  const ask = async (items, signal) => {
    const ctx = sessionCtx;
    if (!ctx?.hasUI)
      return null;
    const ui = ctx.ui;
    const out = {};
    if (ui.askDialog) {
      const result = await ui.askDialog(items.map((f) => ({
        id: f.id,
        header: `${f.nodeName}${f.recurring ? " \xB7 again" : ""}`,
        question: findingQuestion(f),
        options: f.question ? f.question.options.map((o) => ({ label: o })) : f.approval ? [{ label: APPROVE }, { label: SEND_BACK }] : [...f.alternatives.length ? f.alternatives.map((a) => ({ label: a })) : [{ label: FIX }], { label: DISMISS }],
        recommended: f.question ? Math.max(0, f.question.options.indexOf(f.question.chose)) : f.approval ? 0 : f.certain ? 0 : undefined
      })), { signal, helpText: GATE_HELP });
      if (signal.aborted)
        return null;
      if (!result || result.kind === "chat")
        return "pause";
      for (const r of result.results) {
        const custom = r.customInput?.trim();
        const choice = r.selectedOptions[0];
        const item = items.find((f) => f.id === r.id);
        if (item?.question) {
          const answer = questionAnswer(item, custom || choice);
          if (answer)
            out[r.id] = answer;
          continue;
        }
        const alternative = item?.alternatives.includes(choice ?? "") ? choice : null;
        const decision = custom || alternative || choice === FIX || choice === SEND_BACK ? "fix" : choice === DISMISS || choice === APPROVE ? "dismiss" : null;
        if (!decision)
          continue;
        const note = [alternative ? `Fix it this way: ${alternative}` : null, custom, r.note?.trim()].filter(Boolean).join(`
`);
        out[r.id] = note ? { decision, note } : { decision };
      }
      return out;
    }
    for (let i = 0;i < items.length; i++) {
      const f = items[i];
      const title = `${f.nodeName}${f.recurring ? " \xB7 again" : ""} (${i + 1}/${items.length})
${findingQuestion(f)}`;
      if (f.question) {
        const choice2 = await ui.select(title, [...f.question.options, PAUSE], { signal, helpText: GATE_HELP, initialIndex: Math.max(0, f.question.options.indexOf(f.question.chose)) });
        if (signal.aborted)
          return null;
        if (!choice2 || choice2 === PAUSE)
          return "pause";
        const answer = questionAnswer(f, choice2);
        if (answer)
          out[f.id] = answer;
        continue;
      }
      if (f.approval) {
        const choice2 = await ui.select(title, [APPROVE, SEND_BACK, PAUSE], { signal, helpText: GATE_HELP });
        if (signal.aborted)
          return null;
        if (!choice2 || choice2 === PAUSE)
          return "pause";
        const note = choice2 === SEND_BACK ? (await ui.input("What should change?", undefined, { signal }))?.trim() : undefined;
        out[f.id] = choice2 === APPROVE ? { decision: "dismiss" } : note ? { decision: "fix", note } : { decision: "fix" };
        continue;
      }
      const choice = await ui.select(title, [FIX, DISMISS, FIX_ALL, DISMISS_ALL, PAUSE], { signal, helpText: GATE_HELP });
      if (signal.aborted)
        return null;
      if (!choice || choice === PAUSE)
        return "pause";
      if (choice === FIX_ALL || choice === DISMISS_ALL) {
        for (const rest of items.slice(i))
          out[rest.id] = { decision: choice === FIX_ALL ? "fix" : "dismiss" };
        break;
      }
      out[f.id] = { decision: choice === FIX ? "fix" : "dismiss" };
    }
    return out;
  };
  const deps = {
    fingerprint: async () => {
      const at = await currentSha();
      return fingerprint(at.root, at.sha);
    },
    packet: async () => {
      const at = await currentSha();
      return { ...await reviewPacket(at.root, at.sha), baseline: at.sha };
    },
    changes: async () => {
      const at = await currentSha();
      return changedFiles(at.root, at.sha);
    },
    runCheck: async (node, signal) => {
      const at = await currentSha();
      return runCheck((command, args, options) => pi.exec(command, args, options), node, at.root, at.sha, join5(artifactsDir, node.id), signal);
    },
    runReview: (node, packet, signal, progress) => runReviewer(node, root ?? ".", { system: reviewerSystemPrompt(node), packet }, signal, progress),
    hasUI: () => sessionCtx?.hasUI === true,
    ask,
    emit: (view) => {
      pi.events.emit(RUN_EVENT, view);
      server?.notify();
      showWidget(view);
      const review = view?.gate.open ? view.findings.find((f) => f.approval && !f.decision) : undefined;
      if (review && review.id !== reviewOpened && (!server || server.clients() === 0)) {
        reviewOpened = review.id;
        openPage().catch(() => {});
      }
    },
    persist: (checkpoint) => pi.appendEntry(STATE_ENTRY, checkpoint),
    now: () => new Date().toISOString()
  };
  const controller = new Controller(deps);
  const refreshLibrary = async () => {
    library = await loadLibrary(root);
    return library;
  };
  const emitLibrary = async () => {
    const lib = await refreshLibrary();
    pi.events.emit(LIBRARY_EVENT, summarize(lib, root));
    server?.notify();
  };
  const activate = async (on) => {
    const tools = pi.getActiveTools();
    if (tools.includes(TOOL) === on)
      return;
    await pi.setActiveTools(on ? [...tools, TOOL] : tools.filter((t) => t !== TOOL));
  };
  const armPlan = (ctx) => {
    const modes = ctx?.sessionModes;
    if (!attached?.loop.plan || !modes || controller.paused)
      return;
    (async () => {
      for (let attempt = 0;attempt < 20 && attached?.loop.plan && modes.getState().plan.status === "inactive"; attempt++) {
        const r = await modes.set({ mode: "plan", action: "enter" }).catch(() => null);
        if (!r || r.ok || r.code !== "busy")
          return;
        await Bun.sleep(250);
      }
    })();
  };
  const setLoop = async (next) => {
    attached = next;
    lastNote = null;
    controller.attach(next.loop, next.source, next.baseline);
    pi.appendEntry(LOOP_ENTRY, next);
    await activate(true);
    armPlan(sessionCtx);
  };
  const detach = async () => {
    attached = null;
    controller.detach();
    pi.appendEntry(LOOP_ENTRY, { loop: null, source: null, baseline: null });
    await activate(false);
  };
  const startBaseline = async (at) => {
    const ref = process.env.OMP_CONTROL_BASE ?? await defaultBranch(at);
    if (ref)
      return { kind: "merge-base", ref };
    const head = await git(["rev-parse", "HEAD"], at);
    if (head.code !== 0)
      throw new Error("Control loops need a commit to compare against");
    return { kind: "commit", sha: head.stdout.trim() };
  };
  const checkNow = () => {
    if (!attached)
      throw new Error("No control loop is attached to this session.");
    controller.recheck();
    send(CHECK_REQUEST);
  };
  const startIfChanged = async () => {
    if (!attached || controller.paused || attached.loop.plan)
      return;
    if (await deps.fingerprint().catch(() => "clean") !== "clean")
      checkNow();
  };
  const attach = async (cwd, id) => {
    const at = await repoRoot(cwd);
    if (!at)
      throw new Error("Control loops need a git repository");
    root = at;
    const lib = await refreshLibrary();
    const loop = resolveLoop(lib, id);
    await setLoop({ loop, source: `${lib.loops.get(id)?.source ?? "repo"}:${id}`, baseline: await startBaseline(at) });
    await startIfChanged();
    return loop;
  };
  const since = async (ref) => {
    if (!attached || !root)
      throw new Error("No control loop is attached to this session.");
    const name = ref.trim();
    if (!name || !await isCommit(root, name))
      throw new Error(`${name || "That"} isn't a branch or commit in this repository`);
    await setLoop({ ...attached, baseline: { kind: "merge-base", ref: name } });
    await startIfChanged();
    return sinceLabel();
  };
  const sinceLabel = async () => {
    if (!attached || !root)
      return "";
    const at = await currentSha();
    const from = attached.baseline.kind === "merge-base" ? attached.baseline.ref : at.sha.slice(0, 7);
    const [commits, dirty] = await Promise.all([commitsSince(at.root, at.sha), git(["status", "--porcelain"], at.root).then((r) => r.stdout.trim() !== "")]);
    const parts = [commits ? `${commits} commit${commits === 1 ? "" : "s"}` : null, dirty ? "uncommitted changes" : null].filter(Boolean);
    return `since ${from} \xB7 ${parts.length ? parts.join(" and ") : "no changes yet"}`;
  };
  const syncAppearance = async (force = false) => {
    if (!themeApi)
      return;
    const epoch = omp.getThemeEpoch();
    if (!server || epoch === themeEpoch && !force)
      return;
    themeEpoch = epoch;
    const [theme, terminal] = await Promise.all([currentTheme(omp), terminalConfig()]);
    if (themeEpoch === epoch)
      server?.setAppearance(toAppearance(theme, terminal));
  };
  const state = async () => {
    const lib = library ?? await refreshLibrary();
    return {
      session: { name: pi.getSessionName() || "omp", cwd: sessionCtx?.cwd ?? process.cwd(), repo: root, idle: sessionCtx?.isIdle() ?? true },
      attached: await (async () => {
        const snap = controller.snapshot();
        return snap ? { ...snap, since: await sinceLabel().catch(() => "") } : null;
      })(),
      run: controller.view(),
      library: {
        loops: [...lib.loops.values()].map((e) => ({ ...e.loop, source: e.source, path: e.path, overrides: e.overrides })),
        nodes: [...lib.nodes.values()].map((e) => ({ ...e.node, source: e.source, path: e.path, overrides: e.overrides })),
        errors: lib.errors
      }
    };
  };
  const ensureServer = async (port) => {
    if (!server) {
      server = startControlServer({
        state,
        attach: async (id) => {
          if (id === null)
            await detach();
          else
            await attach(sessionCtx?.cwd ?? process.cwd(), id);
        },
        setSessionLoop: async (loop) => {
          const at = root ?? await repoRoot(sessionCtx?.cwd ?? process.cwd());
          if (!at)
            throw new Error("Control loops need a git repository");
          root = at;
          await setLoop({ loop, source: "session", baseline: attached?.baseline ?? await startBaseline(at) });
        },
        saveLoop: async (scope, loop, nodes) => {
          const paths = [];
          for (const node of nodes)
            paths.push(await saveNode(root, scope, node));
          paths.push(await saveLoop(root, scope, loop, await refreshLibrary()));
          await emitLibrary();
          return paths;
        },
        saveNode: async (scope, node) => {
          const path = await saveNode(root, scope, node);
          await emitLibrary();
          return path;
        },
        deleteItem: async (kind, scope, id) => {
          await deleteItem(root, scope, kind, id);
          await emitLibrary();
        },
        copyItem: async (kind, id, to, move) => {
          const path = await copyItem(root, await refreshLibrary(), kind, id, to, move);
          await emitLibrary();
          return path;
        },
        changes: () => deps.changes(),
        diff: async (path) => {
          const at = await currentSha();
          return fileDiff(at.root, at.sha, path);
        },
        decide: (decisions, pause) => controller.decide(decisions, pause),
        send,
        check: checkNow,
        since,
        setPaused: (paused) => controller.setPaused(paused)
      }, { ports: port ? [port, ...DEFAULT_PORTS] : DEFAULT_PORTS });
      if (themeApi)
        themeTimer = setInterval(() => syncAppearance(), 1000);
    }
    if (themeApi)
      await syncAppearance(true);
    return server;
  };
  const recordedPort = (ctx) => {
    let port = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === SERVER_ENTRY && typeof entry.data?.port === "number")
        port = entry.data.port;
    }
    return port;
  };
  const openPage = async () => {
    const page = await ensureServer(null);
    if (sessionCtx && recordedPort(sessionCtx) !== page.port)
      pi.appendEntry(SERVER_ENTRY, { port: page.port });
    await openBoard(page.url(), { focus: true });
    return page.url();
  };
  const restore = async (ctx, withServer) => {
    sessionCtx = ctx;
    root = await repoRoot(ctx.cwd);
    library = null;
    let entry;
    let checkpoint = null;
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type !== "custom")
        continue;
      if (e.customType === LOOP_ENTRY) {
        entry = e.data;
        checkpoint = null;
      } else if (e.customType === STATE_ENTRY)
        checkpoint = e.data;
    }
    const envLoop = process.env.OMP_CONTROL_LOOP;
    if (entry === undefined && envLoop) {
      attaching = attach(ctx.cwd, envLoop).then(() => {}, (e) => {
        ctx.ui.notify(`Control: loop ${envLoop}: ${errorText(e)}`, "error");
        deps.emit(failedView(envLoop, errorText(e)));
      });
    } else {
      attached = entry?.loop && entry.source && entry.baseline ? { loop: entry.loop, source: entry.source, baseline: entry.baseline } : null;
      controller.restore(attached, attached ? checkpoint : null);
      await activate(attached !== null);
      armPlan(ctx);
    }
    if (withServer) {
      const port = resumePort ?? recordedPort(ctx);
      resumePort = null;
      if (port !== null)
        await ensureServer(port);
    }
    await emitLibrary();
  };
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    await restore(ctx, true);
  });
  const follow = async (_event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    await restore(ctx, !server);
  };
  pi.on("session_switch", follow);
  pi.on("session_branch", follow);
  pi.on("session_tree", follow);
  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    sessionCtx = ctx;
    if (!("prompt" in event) || typeof event.prompt !== "string" || !event.prompt.trim())
      return;
    await attaching;
    if (!attached)
      return;
    const fp = await deps.fingerprint().catch(() => "unknown");
    if (lastPrompt !== `${fp}\x00${event.prompt}`) {
      lastPrompt = `${fp}\x00${event.prompt}`;
      controller.onUserPrompt(fp, event.prompt);
      if (controller.view()?.pendingReview) {
        ctx.ui.notify("Control: your review is still waiting on the Control page; it now covers this request too", "warning");
        if (!server || server.clients() === 0)
          openPage().catch(() => {});
      }
    }
    if (controller.paused)
      return;
    return { message: { customType: CONTEXT_TYPE, content: contextMessage(attached.loop), display: false, attribution: "agent" } };
  });
  pi.on("mode_changed", (event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    const plan = controller.view()?.plan;
    if (event.state.plan.status === "active" && event.previous.plan.status !== "active")
      controller.onPlan("planning");
    else if (event.previous.plan.status === "active" && event.state.plan.status !== "active" && plan === "planning")
      controller.onPlan("unused");
  });
  pi.on("plan_review_requested", (event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    controller.onPlan("review", event.planContent);
    if (!attached?.loop.planStages.length)
      return;
    planChecks?.abort();
    const ctl = new AbortController;
    planChecks = ctl;
    controller.checkPlan(event.planContent, ctl.signal).then((r) => {
      if (ctl.signal.aborted || ctx.getPendingPlanReview()?.reviewId !== event.reviewId)
        return;
      if (r.action === "refine")
        ctx.resolvePlanReview(event.reviewId, "refine", { feedback: r.feedback });
    }, (e) => ctx.ui.notify(`Control: plan checks failed: ${errorText(e)}`, "warning"));
  });
  pi.on("plan_review_resolved", (event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    if (event.choice === "execute" || event.choice === "compact" || event.choice === "keep")
      controller.onPlan("approved");
    else if (event.choice === "refine")
      controller.onPlan("planning");
    else
      controller.onPlan(ctx.sessionModes?.getState().plan.status === "active" ? "planning" : "unused");
  });
  pi.on("agent_end", (event, ctx) => {
    if (ctx.agent?.kind === "sub" || "willContinue" in event && event.willContinue === true)
      return;
    sessionCtx = ctx;
    armPlan(ctx);
  });
  pi.on("session_stop", async (_event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    sessionCtx = ctx;
    if (!attached || controller.paused || ctx.sessionModes?.getState().plan.status === "active")
      return;
    let fp;
    try {
      fp = await deps.fingerprint();
    } catch {
      return;
    }
    const d = controller.stopDecision(fp);
    if (!d.block && d.stalled)
      ctx.ui.notify("Control: the agent ended its turn three times without running control_check; the loop let it stop", "warning");
    return d.block ? { decision: "block", reason: d.reason } : undefined;
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.agent?.kind === "sub")
      return;
    controller.abort();
    planChecks?.abort();
    clearInterval(themeTimer);
    themeTimer = undefined;
    themeEpoch = null;
    await rm3(artifactsDir, { recursive: true, force: true });
    if (!server)
      return;
    resumePort = server.port;
    server.stop();
    server = null;
  });
  pi.events.on(COMMAND_EVENT, async (data) => {
    if (!isCommand(data))
      return;
    try {
      if (data.type === "library")
        data.reply({ ok: true, message: "", library: summarize(await refreshLibrary(), root) });
      else if (data.type === "run")
        data.reply({ ok: true, message: "", run: controller.view() });
      else if (data.type === "decide")
        data.reply(controller.decide(data.decisions ?? {}, data.pause === true));
      else if (data.type === "open") {
        data.reply({ ok: true, message: "Opening Control" });
        openPage().catch((e) => sessionCtx?.ui.notify(`Control: ${errorText(e)}`, "error"));
      }
    } catch (e) {
      data.reply({ ok: false, message: errorText(e) });
    }
  });
  pi.registerTool({
    name: TOOL,
    label: "Control check",
    description: "Run this session's control loop on your changes: its checks and focused reviewers measure the change since the loop started and return findings to fix. Call it when your implementation is complete, before your final answer; fix what it returns and call it again until it passes. When you made a choice you weren't sure of (an approach, a name, a UI variant, an assumption about behavior), don't stop to ask: keep going and list it in questions with the options you considered and the one you chose; the user answers them all at once at the end, and a different answer comes back to you as a fix. If you must end your turn before finishing (you're blocked), pass incomplete with the reason instead. Never edit files under .omp/control to make the loop pass.",
    parameters: z.object({
      incomplete: z.string().optional().describe("Why you're ending your turn before the work is complete"),
      questions: z.array(z.object({ question: z.string(), options: z.array(z.string()).min(2), chose: z.string() })).max(10).optional().describe("Choices you weren't sure of, with the options you considered and the one you went with")
    }),
    loadMode: "essential",
    defaultInactive: true,
    approval: "exec",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      sessionCtx = ctx;
      const text = await controller.check({
        incomplete: params.incomplete,
        questions: params.questions,
        signal: signal ?? new AbortController().signal,
        progress: (t) => onUpdate?.({ content: [{ type: "text", text: t }], details: undefined })
      });
      return { content: [{ type: "text", text }], details: controller.view() };
    }
  });
  const nodeShape = z.object({
    name: z.string(),
    kind: z.enum(["check", "review"]),
    description: z.string().optional(),
    command: z.string().optional(),
    timeout: z.number().int().optional(),
    ask: z.enum(["doubts", "all", "never"]).optional(),
    model: z.string().optional(),
    thinking: z.string().optional(),
    tools: z.array(z.string()).optional(),
    resources: z.array(z.string()).optional(),
    instructions: z.string().optional()
  });
  const loopShape = z.object({
    name: z.string(),
    description: z.string().optional(),
    maxPasses: z.number().int().optional(),
    plan: z.boolean().optional().describe("Each request starts in omp plan mode; you approve the plan before it implements"),
    planStages: z.array(z.object({ nodes: z.array(z.string()) })).optional().describe("Checks that read the plan before you approve it (implies plan)"),
    stages: z.array(z.object({ nodes: z.array(z.string()) })),
    finish: z.enum(["review", "auto"]).optional().describe('"review" (default): you review the final change; "auto": done once the checks pass, and a local Orchestrator task merges')
  });
  pi.registerTool({
    name: "control_library",
    label: "Control library",
    description: "Read or save Control loops and nodes. list shows the library: repo (.omp/control, committed), global (~/.omp/control, every repo), built-in; a repo item overrides a global one with the same id, which overrides a built-in. read returns one definition with its path; save writes a node (a check: a shell command that must exit 0 from the repository root; a reviewer: focused instructions plus resources to read first) or a loop (stages of node ids; nodes in a stage run together). Use it when the user asks to create or change a loop or node: research the project's conventions first, and save to the repo scope unless they say global.",
    parameters: z.object({
      action: z.enum(["list", "read", "save"]),
      kind: z.enum(["node", "loop"]).optional(),
      id: z.string().optional(),
      scope: z.enum(["repo", "global"]).optional(),
      node: nodeShape.optional(),
      loop: loopShape.optional()
    }),
    approval: (args) => args && typeof args === "object" && ("action" in args) && args.action === "save" ? "write" : "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      sessionCtx = ctx;
      try {
        root ??= await repoRoot(ctx.cwd);
        const lib = await refreshLibrary();
        if (params.action === "list") {
          const loops = [...lib.loops.values()].map(({ loop, source }) => {
            const names = { stages: loop.stages.map((s) => ({ nodes: s.nodes.map((id) => ({ name: id })) })) };
            return `- ${loop.id} \xB7 ${loop.name} (${source}) \u2014 ${stagesText(names)}`;
          });
          const nodes = [...lib.nodes.values()].map(({ node, source }) => `- ${node.id} \xB7 ${node.name} \xB7 ${node.kind} (${source})`);
          const parts = [`Loops:
${loops.join(`
`) || "(none)"}`, `Nodes:
${nodes.join(`
`) || "(none)"}`];
          if (lib.errors.length)
            parts.push(`Files with errors:
${lib.errors.map((e) => `- ${e.message}`).join(`
`)}`);
          return reply(parts.join(`

`));
        }
        if (!params.kind || !params.id)
          return reply(`${params.action} needs kind and id`, true);
        if (params.action === "read") {
          const entry = params.kind === "node" ? lib.nodes.get(params.id) : lib.loops.get(params.id);
          if (!entry)
            return reply(`No ${params.kind} ${params.id} in the library`, true);
          return reply(`${entry.path} (${entry.source})

${await Bun.file(entry.path).text()}`);
        }
        const scope = params.scope ?? (root ? "repo" : "global");
        let path;
        if (params.kind === "node") {
          if (!params.node)
            return reply("save of a node needs node", true);
          const node = nodeFrom(params.id, params.node, params.node.instructions ?? "", `node ${params.id}`);
          path = await saveNode(root, scope, node);
        } else {
          if (!params.loop)
            return reply("save of a loop needs loop", true);
          path = await saveLoop(root, scope, loopFrom(params.id, params.loop, `loop ${params.id}`), lib);
        }
        const existed = (params.kind === "node" ? lib.nodes.get(params.id) : lib.loops.get(params.id))?.path === path;
        await emitLibrary();
        return reply(existed ? `Updated ${params.kind} ${params.id} at ${path}` : `Saved ${params.kind} ${params.id} to ${path}`);
      } catch (e) {
        return reply(errorText(e), true);
      }
    }
  });
  pi.registerTool({
    name: "control_attach",
    label: "Control attach",
    description: 'Attach a library loop to this session (or "none" to detach) when the user asks to use one; it then checks your changes before you finish.',
    parameters: z.object({ loop: z.string() }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      sessionCtx = ctx;
      try {
        if (params.loop === "none") {
          await detach();
          return reply("Detached the control loop");
        }
        const loop = await attach(ctx.cwd, params.loop);
        return reply(`Attached \xAB${loop.name}\xBB (${stagesText(loop)}). Call control_check when your implementation is complete.`);
      } catch (e) {
        return reply(errorText(e), true);
      }
    }
  });
  pi.registerTool({
    name: "control_status",
    label: "Control status",
    description: "Show this session's control loop: its stages, the current pass and the latest findings.",
    parameters: z.object({}),
    approval: "read",
    async execute() {
      return reply(statusText(controller.view()));
    }
  });
  pi.registerCommand("control", {
    description: USAGE,
    getArgumentCompletions(argumentPrefix) {
      const normalized = argumentPrefix.trimStart().toLowerCase();
      if (/\s/.test(normalized))
        return null;
      if (!normalized)
        return COMMANDS;
      const matches = COMMANDS.filter((command) => command.value.startsWith(normalized));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      if (ctx.agent?.kind === "sub")
        return;
      sessionCtx = ctx;
      const [verb = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        switch (verb.toLowerCase()) {
          case "":
          case "open":
            ctx.ui.notify(`Control open at ${await openPage()}`, "info");
            break;
          case "use": {
            let id = rest[0];
            if (!id) {
              root ??= await repoRoot(ctx.cwd);
              const loops = [...(await refreshLibrary()).loops.values()].map((e) => e.loop);
              if (!loops.length)
                throw new Error("The library has no loops");
              const labels = loops.map((l) => `${l.name} (${l.id})`);
              const choice = await ctx.ui.select("Attach a control loop", labels);
              if (!choice)
                return;
              id = loops[labels.indexOf(choice)].id;
            }
            const loop = await attach(ctx.cwd, id);
            ctx.ui.notify(`Control: \xAB${loop.name}\xBB checks this session's changes (${stagesText(loop)})`, "info");
            break;
          }
          case "off":
            await detach();
            ctx.ui.notify("Control: loop detached", "info");
            break;
          case "pause":
          case "resume":
            if (!attached)
              throw new Error("No control loop is attached to this session.");
            controller.setPaused(verb.toLowerCase() === "pause");
            ctx.ui.notify(`Control: loop ${verb.toLowerCase() === "pause" ? "paused" : "resumed"}`, "info");
            break;
          case "status":
            ctx.ui.notify(statusText(controller.view()), "info");
            break;
          case "check":
            checkNow();
            break;
          case "since": {
            const ref = rest.join(" ").trim();
            if (!ref)
              throw new Error("Say where to measure from: /control since <branch or commit>");
            ctx.ui.notify(`Control: checking ${await since(ref)}`, "info");
            break;
          }
          case "draft": {
            const intent = rest.join(" ").trim();
            if (!intent)
              throw new Error("Say what it should check: /control draft <what it should check>");
            root ??= await repoRoot(ctx.cwd);
            send(draftPrompt({ intent, scope: root ? "repo" : "global" }));
            break;
          }
          default:
            ctx.ui.notify(USAGE, "warning");
        }
      } catch (e) {
        ctx.ui.notify(errorText(e), "error");
      }
    }
  });
}
export {
  control as default
};
