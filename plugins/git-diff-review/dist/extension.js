// @bun
// plugins/git-diff-review/src/extension.ts
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

// plugins/git-diff-review/src/appearance.ts
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

// plugins/git-diff-review/src/git.ts
import { join as join2, resolve as resolve2, sep } from "path";

// plugins/git-diff-review/src/shared/diff.js
var MAX_ROWS = 5000;
var KINDS = { " ": "context", "+": "addition", "-": "deletion" };
function hunkStart(part) {
  const n = Number.parseInt((part ?? "").slice(1).split(",")[0], 10);
  return Number.isNaN(n) ? 0 : n;
}
function parseUnifiedDiff(raw) {
  const result = { rows: [], additions: 0, deletions: 0, truncated: false };
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const lines = raw.split(`
`);
  if (lines.at(-1) === "")
    lines.pop();
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (result.rows.length >= MAX_ROWS) {
      result.truncated = true;
      break;
    }
    if (line.startsWith("diff --git "))
      inHunk = false;
    if (line.startsWith("Binary files ") && line.endsWith(" differ"))
      continue;
    if (line.startsWith("@@ ")) {
      const parts = line.split(/\s+/).filter(Boolean);
      oldLine = hunkStart(parts[1]);
      newLine = hunkStart(parts[2]);
      inHunk = true;
      result.rows.push({ kind: "hunk", oldLineNumber: null, newLineNumber: null, oldText: null, newText: null, text: line });
      continue;
    }
    if (!inHunk || line.length === 0)
      continue;
    const kind = KINDS[line[0]];
    if (!kind)
      continue;
    const content = line.slice(1);
    const hasOld = kind !== "addition";
    const hasNew = kind !== "deletion";
    result.rows.push({
      kind,
      oldLineNumber: hasOld ? oldLine : null,
      newLineNumber: hasNew ? newLine : null,
      oldText: hasOld ? content : null,
      newText: hasNew ? content : null,
      text: line
    });
    if (hasOld)
      oldLine += 1;
    if (hasNew)
      newLine += 1;
    if (kind === "addition")
      result.additions += 1;
    if (kind === "deletion")
      result.deletions += 1;
  }
  return result;
}
function unquote(path) {
  if (!path.startsWith('"'))
    return path;
  try {
    return JSON.parse(path);
  } catch {
    return path.slice(1, -1);
  }
}
var stripPrefix = (path) => unquote(path).replace(/^[ab]\//, "");
function splitDiff(raw) {
  const files = [];
  let current = null;
  const finish = () => {
    if (!current)
      return;
    const parsed = parseUnifiedDiff(current.lines.join(`
`));
    files.push({
      path: current.path,
      origPath: current.origPath,
      status: current.status,
      binary: current.binary,
      rows: parsed.rows,
      additions: parsed.additions,
      deletions: parsed.deletions,
      truncated: parsed.truncated
    });
  };
  for (const line of raw.split(`
`)) {
    if (line.startsWith("diff --git ")) {
      finish();
      const m = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(line);
      const path = m ? stripPrefix(m[2]) : line.slice(11);
      current = { path, origPath: null, status: "M", binary: false, lines: [line], inHunk: false };
      continue;
    }
    if (!current)
      continue;
    current.lines.push(line);
    if (current.inHunk)
      continue;
    if (line.startsWith("@@ "))
      current.inHunk = true;
    else if (line.startsWith("new file mode"))
      current.status = "A";
    else if (line.startsWith("deleted file mode"))
      current.status = "D";
    else if (line.startsWith("rename from ")) {
      current.status = "R";
      current.origPath = unquote(line.slice(12));
    } else if (line.startsWith("rename to "))
      current.path = unquote(line.slice(10));
    else if (line.startsWith("copy from ")) {
      current.status = "C";
      current.origPath = unquote(line.slice(10));
    } else if (line.startsWith("copy to "))
      current.path = unquote(line.slice(8));
    else if (line.startsWith("Binary files "))
      current.binary = true;
    else if (line.startsWith("+++ ") && line !== "+++ /dev/null")
      current.path = stripPrefix(line.slice(4).replace(/\t.*$/, ""));
  }
  finish();
  return files;
}

// plugins/git-diff-review/src/git.ts
var EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
var DIFF_ARGS = ["--no-color", "--no-ext-diff", "-U3", "-M"];
var BASE_REFS = ["origin/main", "origin/master", "main", "master"];
var CHECKOUT_RE = /^checkout: moving from (\S+) to (\S+)$/;
var REBASE_ONTO_RE = /^rebase(?: -i)?(?: \(start\))?: checkout (\S+)$/;
var SHA_RE = /^[0-9a-f]{7,40}$/;
var UNTRACKED_MAX_FILES = 500;
var UNTRACKED_MAX_BYTES = 1048576;

class GitError extends Error {
  exitCode;
  stderr;
  constructor(message, exitCode, stderr) {
    super(message);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}
async function git(root, args, ok = [0]) {
  const proc = Bun.spawn(["git", "-C", root, "-c", "core.quotePath=false", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (!ok.includes(code))
    throw new GitError(stderr.trim() || `git ${args[0]} failed (${code})`, code, stderr);
  return stdout;
}
async function repoRoot(cwd) {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}
async function isRepo(root) {
  return (await git(root, ["rev-parse", "--is-inside-work-tree"], [0, 128]).catch(() => "")).trim() === "true";
}
async function gitDir(root) {
  return (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
}
async function initRepo(root) {
  await git(root, ["init", "--quiet"]);
}
async function headSha(root) {
  return (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1, 128])).trim() || null;
}
async function currentBranch(root) {
  return (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1, 128])).trim() || null;
}
async function mergeBase(root) {
  if (!await headSha(root))
    return null;
  const subjects = (await git(root, ["reflog", "show", "HEAD", "--format=%gs"], [0, 128])).split(`
`).filter(Boolean);
  const candidates = [];
  const add = (ref) => {
    if (ref && !candidates.includes(ref))
      candidates.push(ref);
  };
  for (const line of subjects) {
    const m = REBASE_ONTO_RE.exec(line);
    if (m) {
      if (!SHA_RE.test(m[1]))
        add(m[1]);
      break;
    }
  }
  const current = await currentBranch(root);
  if (current) {
    let parent = null;
    for (const line of subjects) {
      const m = CHECKOUT_RE.exec(line);
      if (m && m[2] === current && m[1] !== current)
        parent = m[1];
    }
    add(parent);
  }
  for (const ref of BASE_REFS)
    if (ref !== current)
      add(ref);
  let best = null;
  for (const ref of candidates) {
    const sha = (await git(root, ["merge-base", ref, "HEAD"], [0, 1, 128])).trim();
    if (!sha)
      continue;
    const newer = best && sha !== best.sha && await git(root, ["merge-base", "--is-ancestor", best.sha, sha]).then(() => true, () => false);
    if (!best || newer)
      best = { ref, sha };
  }
  return best;
}
async function readUntracked(root, path) {
  const file = { path, origPath: null, status: "?", binary: false, rows: [], additions: 0, deletions: 0, truncated: false };
  const blob = Bun.file(join2(root, path));
  if (blob.size > UNTRACKED_MAX_BYTES)
    return { ...file, note: `File too large to show (${Math.round(blob.size / 1024)} KB)` };
  const bytes = new Uint8Array(await blob.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (bytes.subarray(0, 8000).includes(0))
    return { ...file, binary: true };
  const lines = new TextDecoder().decode(bytes).split(`
`);
  if (lines.at(-1) === "")
    lines.pop();
  if (!lines.length)
    return file;
  const parsed = parseUnifiedDiff([`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join(`
`));
  return { ...file, ...parsed };
}
async function untrackedFiles(root) {
  const paths = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\x00").filter(Boolean);
  return Promise.all(paths.map((path, i) => i < UNTRACKED_MAX_FILES ? readUntracked(root, path) : { path, origPath: null, status: "?", binary: false, rows: [], additions: 0, deletions: 0, truncated: false, note: "Too many untracked files to show" }));
}
var byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
async function withUntracked(root, tracked) {
  const seen = new Set(tracked.map((f) => f.path));
  const untracked = (await untrackedFiles(root)).filter((f) => !seen.has(f.path));
  return [...tracked, ...untracked].sort(byPath);
}
function resolveInRoot(root, path) {
  const abs = resolve2(root, path);
  if (!abs.startsWith(root + sep))
    throw new Error(`Path outside the repository: ${path}`);
  return abs;
}
async function fileLines(root, compare, path) {
  const text = compare.kind === "commit" ? await git(root, ["show", `${compare.sha ?? await headSha(root) ?? "HEAD"}:${path}`]) : await Bun.file(resolveInRoot(root, path)).text();
  const lines = text.split(`
`).map((l) => l.endsWith("\r") ? l.slice(0, -1) : l);
  if (lines.at(-1) === "")
    lines.pop();
  return lines;
}
async function loadReview(root, compare, { ignoreWhitespace = false } = {}) {
  const ws = ignoreWhitespace ? ["-w"] : [];
  const branch = await currentBranch(root);
  if (compare.kind === "commit") {
    const sha = compare.sha ?? await headSha(root);
    if (!sha)
      return { files: [], branch, base: null, commit: null };
    const raw = await git(root, ["show", "--format=", "--diff-merges=first-parent", ...DIFF_ARGS, ...ws, sha, "--"]);
    const [commit] = await listCommits(root, 1, sha);
    return { files: splitDiff(raw).sort(byPath), branch, base: null, commit: commit ?? null };
  }
  if (compare.kind === "branch") {
    const head = await headSha(root);
    const fork = compare.base ? { ref: compare.base, sha: (await git(root, ["merge-base", compare.base, "HEAD"])).trim() } : await mergeBase(root);
    const base = fork ?? (head ? { ref: "HEAD", sha: head } : null);
    const tracked2 = splitDiff(await git(root, ["diff", ...DIFF_ARGS, ...ws, base?.sha ?? EMPTY_TREE, "--"]));
    return { files: await withUntracked(root, tracked2), branch, base, commit: null };
  }
  const target = await headSha(root) ?? EMPTY_TREE;
  const tracked = splitDiff(await git(root, ["diff", ...DIFF_ARGS, ...ws, target, "--"]));
  return { files: await withUntracked(root, tracked), branch, base: null, commit: null };
}
async function listBranches(root) {
  const out = await git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(refname:short)", "refs/heads", "refs/remotes"]);
  return out.split(`
`).filter(Boolean).map((line) => line.split("\x00")).filter(([ref]) => !ref.endsWith("/HEAD")).map(([, short]) => short);
}
async function listCommits(root, max = 100, rev = "HEAD") {
  const out = await git(root, ["log", "-n", String(max), "--format=%H%x1f%h%x1f%s%x1f%cI%x1e", rev, "--"], [0, 128]);
  return out.split("\x1E").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [sha, short, subject, date] = entry.split("\x1F");
    return { sha, short, subject, date };
  });
}

// plugins/git-diff-review/src/server.ts
import { watch } from "fs";
import { basename, extname as extname2, resolve as resolve3, sep as sep2 } from "path";

// plugins/git-diff-review/src/open-in.ts
var fileUrl = (scheme) => (abs, line) => `${scheme}://file${encodeURI(abs)}${line ? `:${line}` : ""}`;
var EDITORS = [
  { id: "vscode", label: "Visual Studio Code", app: "Visual Studio Code", url: fileUrl("vscode") },
  { id: "cursor", label: "Cursor", app: "Cursor", url: fileUrl("cursor") },
  { id: "zed", label: "Zed", app: "Zed", url: fileUrl("zed") },
  { id: "xcode", label: "Xcode", app: "Xcode" },
  { id: "sublime", label: "Sublime Text", app: "Sublime Text", url: (abs, line) => `subl://open?url=${encodeURIComponent(`file://${abs}`)}${line ? `&line=${line}` : ""}` },
  { id: "nova", label: "Nova", app: "Nova" }
];
var DEFAULT = { id: "default", label: "Default App" };
var FINDER = { id: "finder", label: "Reveal in Finder" };
async function run(argv) {
  return Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }).exited;
}
var installed = null;
async function openTargets() {
  if (process.platform !== "darwin")
    return [DEFAULT];
  installed ??= Promise.all(EDITORS.map((e) => run(["open", "-Ra", e.app]))).then((codes) => EDITORS.filter((_, i) => codes[i] === 0));
  const editors = await installed;
  return [...editors.map(({ id, label }) => ({ id, label })), DEFAULT, FINDER];
}
async function openIn(id, abs, line) {
  const editor = EDITORS.find((e) => e.id === id);
  const argv = process.platform !== "darwin" ? ["xdg-open", abs] : id === FINDER.id ? ["open", "-R", abs] : !editor ? ["open", abs] : editor.url ? ["open", editor.url(abs, line)] : ["open", "-a", editor.app, abs];
  const code = await run(argv);
  if (code !== 0)
    throw new Error(`${argv[0]} exited with ${code}`);
}

// plugins/git-diff-review/src/shared/protocol.js
var PROTOCOL = 3;

// plugins/git-diff-review/src/store.ts
import { createHash as createHash2, randomBytes } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir as homedir2 } from "os";
import { join as join3 } from "path";
var DEFAULT_STATE_DIR = join3(homedir2(), ".omp", "cache", "git-diff-review");

class ReviewStore {
  dir;
  #cache = new Map;
  constructor(dir = DEFAULT_STATE_DIR) {
    this.dir = dir;
  }
  #file(root) {
    return join3(this.dir, `${createHash2("sha1").update(root).digest("hex").slice(0, 16)}.json`);
  }
  token() {
    const file = join3(this.dir, "token");
    try {
      const token2 = readFileSync(file, "utf8").trim();
      if (token2)
        return token2;
    } catch {}
    const token = randomBytes(16).toString("hex");
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(file, token, { mode: 384 });
    return token;
  }
  get(root) {
    let state = this.#cache.get(root);
    if (!state) {
      try {
        const raw = JSON.parse(readFileSync(this.#file(root), "utf8"));
        state = { pins: Array.isArray(raw.pins) ? raw.pins : [], viewed: raw.viewed && typeof raw.viewed === "object" ? raw.viewed : {} };
      } catch {
        state = { pins: [], viewed: {} };
      }
      this.#cache.set(root, state);
    }
    return state;
  }
  update(root, patch) {
    const state = { ...this.get(root), ...patch };
    this.#cache.set(root, state);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.#file(root), JSON.stringify({ root, ...state }));
    return state;
  }
}

// plugins/git-diff-review/src/server.ts
var WEB_DIR = resolve3(import.meta.dir, "..", "web");
var DEFAULT_PORTS = Array.from({ length: 10 }, (_, i) => 9890 + i);
var CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2"
};
function parseCompare(params) {
  const kind = params.get("kind");
  if (kind === "branch")
    return { kind, base: params.get("base") || null };
  if (kind === "commit")
    return { kind, sha: params.get("sha") || null };
  return { kind: "uncommitted" };
}
function compareQuery(compare) {
  if (compare.kind === "branch")
    return compare.base ? `&kind=branch&base=${encodeURIComponent(compare.base)}` : "&kind=branch";
  if (compare.kind === "commit")
    return compare.sha ? `&kind=commit&sha=${encodeURIComponent(compare.sha)}` : "&kind=commit";
  return "";
}
function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
async function serveStatic(pathname, token) {
  const file = resolve3(WEB_DIR, `.${pathname === "/" ? "/index.html" : pathname}`);
  const type = CONTENT_TYPES[extname2(file)];
  if (!type || !file.startsWith(WEB_DIR + sep2))
    return new Response("Not found", { status: 404 });
  const headers = { "Content-Type": type, "Cache-Control": "no-store" };
  if (type.startsWith("text/html")) {
    const html = await Bun.file(file).text();
    return new Response(html.replace('href="/appearance.css"', `href="/appearance.css?token=${token}"`), { headers });
  }
  return new Response(Bun.file(file), { headers });
}
function startReviewServer(initialRoot, hooks, { store = new ReviewStore, ports = DEFAULT_PORTS } = {}) {
  const token = store.token();
  let root = initialRoot;
  let watcher = null;
  let changeTimer;
  let themeCss = "";
  let font;
  const notifyChanged = () => server?.publish("review", JSON.stringify({ type: "changed" }));
  async function watchGit() {
    const watched = root;
    const dir = await gitDir(watched).catch(() => null);
    if (watched !== root)
      return;
    watcher?.close();
    watcher = null;
    if (!dir)
      return;
    try {
      watcher = watch(dir, { persistent: false }, () => {
        clearTimeout(changeTimer);
        changeTimer = setTimeout(notifyChanged, 250);
      });
    } catch {}
  }
  const hello = () => JSON.stringify({ type: "hello", protocol: PROTOCOL, root, name: basename(root), session: hooks.sessionName(), ...store.get(root) });
  async function api(pathname, params) {
    try {
      switch (pathname) {
        case "/api/review":
          if (!await isRepo(root))
            return json({ files: [], branch: null, base: null, commit: null, notRepo: true });
          return json(await loadReview(root, parseCompare(params), { ignoreWhitespace: params.get("ws") === "1" }));
        case "/api/branches":
          return json(await listBranches(root));
        case "/api/commits":
          return json(await listCommits(root));
        case "/api/lines":
          return json(await fileLines(root, parseCompare(params), params.get("path") ?? ""));
        case "/api/open-targets":
          return json(await openTargets());
        case "/api/open": {
          const line = Number(params.get("line"));
          await openIn(params.get("target") ?? "default", resolveInRoot(root, params.get("path") ?? ""), line > 0 ? line : null);
          return json({ ok: true });
        }
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }
  function onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "pins" && Array.isArray(msg.pins)) {
      ws.publish("review", JSON.stringify({ type: "state", ...store.update(root, { pins: msg.pins }) }));
    } else if (msg.type === "viewed" && msg.viewed && typeof msg.viewed === "object") {
      ws.publish("review", JSON.stringify({ type: "state", ...store.update(root, { viewed: msg.viewed }) }));
    } else if (msg.type === "send" && typeof msg.text === "string" && msg.text.trim()) {
      hooks.send(msg.text);
    } else if (msg.type === "paste" && typeof msg.text === "string" && msg.text) {
      hooks.paste(msg.text);
    } else if (msg.type === "init") {
      isRepo(root).then((repo) => repo || initRepo(root)).then(() => {
        notifyChanged();
        return watchGit();
      }).catch((error) => ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })));
    }
  }
  let server = null;
  for (const port of [...ports, 0]) {
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch(req, srv2) {
          const url = new URL(req.url);
          const authorized = url.searchParams.get("token") === token;
          if (url.pathname === "/ws") {
            if (authorized && srv2.upgrade(req, { data: null }))
              return;
            return new Response("Forbidden", { status: 403 });
          }
          if (url.pathname === "/api/font") {
            if (!authorized)
              return new Response("Forbidden", { status: 403 });
            if (!font || url.searchParams.get("id") !== font.id)
              return new Response("Not found", { status: 404 });
            return new Response(Bun.file(font.path), { headers: { "Cache-Control": "no-store" } });
          }
          if (url.pathname.startsWith("/api/")) {
            return authorized ? api(url.pathname, url.searchParams) : json({ error: "forbidden" }, 403);
          }
          if (url.pathname === "/appearance.css") {
            if (!authorized)
              return new Response("Forbidden", { status: 403 });
            return new Response(themeCss, { headers: { "Content-Type": CONTENT_TYPES[".css"], "Cache-Control": "no-store" } });
          }
          return serveStatic(url.pathname, authorized ? token : "");
        },
        websocket: {
          open(ws) {
            ws.subscribe("review");
            ws.send(hello());
          },
          message: onMessage
        }
      });
      break;
    } catch {}
  }
  if (!server)
    throw new Error("git-diff-review: could not bind a local port");
  const srv = server;
  watchGit();
  return {
    port: srv.port,
    token,
    get root() {
      return root;
    },
    url: (compare) => `http://127.0.0.1:${srv.port}/?token=${token}${compareQuery(compare)}`,
    setRoot(next) {
      if (next === root)
        return;
      root = next;
      srv.publish("review", hello());
      watchGit();
    },
    setAppearance(appearance) {
      font = appearance?.font;
      const next = appearance ? appearanceCss(appearance, `/api/font?token=${token}&id=${font?.id}`) : "";
      if (next === themeCss)
        return;
      themeCss = next;
      srv.publish("review", JSON.stringify({ type: "appearance" }));
    },
    notifyChanged,
    stop() {
      watcher?.close();
      clearTimeout(changeTimer);
      srv.stop(true);
    }
  };
}

// plugins/git-diff-review/src/extension.ts
var USAGE = "Usage: /review [branch [base] | uncommitted | commit [sha]]";
var themeApi = hasThemeApi(omp);
function parseArgs(args) {
  const [kind, value] = args.trim().split(/\s+/).filter(Boolean);
  if (!kind || kind === "branch")
    return { kind: "branch", base: value ?? null };
  if (kind === "uncommitted")
    return { kind };
  if (kind === "commit")
    return { kind, sha: value ?? null };
  return null;
}
async function reviewRoot(cwd) {
  return await isRepo(cwd) ? await repoRoot(cwd) : cwd;
}
function gitDiffReview(pi) {
  let server = null;
  let ctx = null;
  let resumePort = null;
  let themeEpoch = null;
  let themeTimer;
  const hooks = {
    send(text) {
      if (!ctx || ctx.isIdle())
        pi.sendUserMessage(text);
      else
        pi.sendUserMessage(text, { deliverAs: "followUp" });
    },
    paste(text) {
      ctx?.ui.pasteToEditor(text);
    },
    sessionName: () => pi.getSessionName() || "omp"
  };
  async function syncAppearance(force = false) {
    if (!themeApi)
      return;
    const epoch = omp.getThemeEpoch();
    if (!server || epoch === themeEpoch && !force)
      return;
    themeEpoch = epoch;
    const [theme, terminal] = await Promise.all([currentTheme(omp), terminalConfig()]);
    if (themeEpoch === epoch)
      server?.setAppearance(toAppearance(theme, terminal));
  }
  async function ensureServer(cwd, port) {
    const root = await reviewRoot(cwd);
    if (server)
      server.setRoot(root);
    else {
      server = startReviewServer(root, hooks, { ports: port ? [port, ...DEFAULT_PORTS] : DEFAULT_PORTS });
      if (themeApi)
        themeTimer = setInterval(() => syncAppearance(), 1000);
    }
    if (themeApi)
      await syncAppearance(true);
    return server;
  }
  async function follow(sessionCtx) {
    ctx = sessionCtx;
    if (!server)
      return;
    server.setRoot(await reviewRoot(sessionCtx.cwd));
    server.notifyChanged();
  }
  pi.registerCommand("review", {
    description: `Review changes in the browser with a file tree and line comments for the agent. ${USAGE}`,
    handler: async (args, commandCtx) => {
      ctx = commandCtx;
      const compare = parseArgs(args);
      if (!compare) {
        commandCtx.ui.notify(USAGE, "error");
        return;
      }
      const url = (await ensureServer(commandCtx.cwd, null)).url(compare);
      await openBoard(url, { focus: true });
      commandCtx.ui.notify(`review open at ${url}`, "info");
    }
  });
  pi.on("session_start", async (_event, sessionCtx) => {
    ctx = sessionCtx;
    if (resumePort === null)
      return;
    const port = resumePort;
    resumePort = null;
    await ensureServer(sessionCtx.cwd, port);
  });
  pi.on("session_switch", async (_event, sessionCtx) => {
    await follow(sessionCtx);
  });
  pi.on("tool_result", async (_event, sessionCtx) => {
    await follow(sessionCtx);
  });
  pi.on("agent_end", async (_event, sessionCtx) => {
    await follow(sessionCtx);
  });
  pi.on("session_shutdown", async () => {
    if (!server)
      return;
    resumePort = server.port;
    clearInterval(themeTimer);
    themeEpoch = null;
    server.stop();
    server = null;
  });
}
export {
  gitDiffReview as default
};
