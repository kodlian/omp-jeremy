// @bun
// plugins/plan-review/src/extension.ts
import * as omp from "@oh-my-pi/pi-coding-agent";

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

// plugins/plan-review/src/server.ts
import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir as homedir2 } from "os";
import { extname as extname2, join as join2, resolve as resolve2, sep } from "path";

// plugins/plan-review/src/shared/protocol.js
var PROTOCOL = 2;

// plugins/plan-review/src/server.ts
var WEB_DIR = resolve2(import.meta.dir, "..", "web");
var DEFAULT_PORTS = Array.from({ length: 10 }, (_, i) => 9900 + i);
var DEFAULT_STATE_DIR = join2(homedir2(), ".omp", "cache", "plan-review");
var CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};
function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
async function serveStatic(pathname, token) {
  const file = resolve2(WEB_DIR, `.${pathname === "/" ? "/index.html" : pathname}`);
  const type = CONTENT_TYPES[extname2(file)];
  if (!type || !file.startsWith(WEB_DIR + sep))
    return new Response("Not found", { status: 404 });
  const headers = { "Content-Type": type, "Cache-Control": "no-store" };
  if (type.startsWith("text/html")) {
    const html = await Bun.file(file).text();
    return new Response(html.replace('href="/appearance.css"', `href="/appearance.css?token=${token}"`), { headers });
  }
  return new Response(Bun.file(file), { headers });
}
function parseResolve(body) {
  if (!body || typeof body !== "object")
    return null;
  const { reviewId, choice, feedback, role } = body;
  if (typeof reviewId !== "string" || typeof choice !== "string")
    return null;
  if (feedback !== undefined && typeof feedback !== "string")
    return null;
  if (role !== undefined && typeof role !== "string")
    return null;
  return { reviewId, choice, feedback, role };
}
function storedToken(dir) {
  const file = join2(dir, "token");
  try {
    const token2 = readFileSync(file, "utf8").trim();
    if (token2)
      return token2;
  } catch {}
  const token = randomBytes(16).toString("hex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, token, { mode: 384 });
  return token;
}
function startPlanReviewServer(hooks, { ports = DEFAULT_PORTS, stateDir = DEFAULT_STATE_DIR } = {}) {
  const token = storedToken(stateDir);
  let review = null;
  let working = false;
  let themeCss = "";
  let font;
  const publish = () => server?.publish("plan", JSON.stringify({ type: "review", review }));
  async function resolveReview(req) {
    const body = parseResolve(await req.json().catch(() => null));
    if (!body)
      return json({ error: "Expected { reviewId, choice, feedback?, role? }" }, 400);
    if (!review || review.reviewId !== body.reviewId || review.resolution)
      return json({ error: "This plan review is no longer waiting for an answer" }, 409);
    const { reviewId, choice, feedback, role } = body;
    if (!hooks.resolve(reviewId, choice, { feedback, role }))
      return json({ error: "omp didn't take this answer" }, 422);
    if (review?.reviewId === reviewId) {
      review.resolution = { choice, by: "page" };
      publish();
    }
    return json({ ok: true });
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
            if (authorized && srv2.upgrade(req, { data: undefined }))
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
          if (url.pathname === "/api/resolve") {
            if (!authorized)
              return json({ error: "forbidden" }, 403);
            return req.method === "POST" ? resolveReview(req) : json({ error: "method not allowed" }, 405);
          }
          if (url.pathname.startsWith("/api/"))
            return json({ error: authorized ? "not found" : "forbidden" }, authorized ? 404 : 403);
          if (url.pathname === "/appearance.css") {
            if (!authorized)
              return new Response("Forbidden", { status: 403 });
            return new Response(themeCss, { headers: { "Content-Type": CONTENT_TYPES[".css"], "Cache-Control": "no-store" } });
          }
          return serveStatic(url.pathname, authorized ? token : "");
        },
        websocket: {
          open(ws) {
            ws.subscribe("plan");
            ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, session: hooks.sessionName(), review, working }));
          },
          message() {}
        }
      });
      break;
    } catch {}
  }
  if (!server)
    throw new Error("plan-review: could not bind a local port");
  const srv = server;
  return {
    port: srv.port,
    token,
    url: () => `http://127.0.0.1:${srv.port}/?token=${token}`,
    present(request) {
      const previous = review && review.planFilePath === request.planFilePath && review.resolution?.choice === "refine" ? review.planContent : null;
      const { reviewId, title, planFilePath, planContent, options, tiers } = request;
      review = { reviewId, title, planFilePath, planContent, options, tiers, previous, resolution: null };
      publish();
    },
    resolved(reviewId, choice, by) {
      if (!review || review.reviewId !== reviewId || review.resolution)
        return;
      review.resolution = { choice, by };
      publish();
    },
    clear() {
      if (!review)
        return;
      review = null;
      publish();
    },
    setWorking(next) {
      if (next === working)
        return;
      working = next;
      srv.publish("plan", JSON.stringify({ type: "working", working }));
    },
    setAppearance(appearance) {
      font = appearance?.font;
      const next = appearance ? appearanceCss(appearance, `/api/font?token=${token}&id=${font?.id}`) : "";
      if (next === themeCss)
        return;
      themeCss = next;
      srv.publish("plan", JSON.stringify({ type: "appearance" }));
    },
    stop() {
      srv.stop(true);
    }
  };
}

// plugins/plan-review/src/extension.ts
var themeApi = hasThemeApi(omp);
var SERVER_ENTRY = "plan-review.server";
function recordedPort(sessionCtx) {
  let port = null;
  for (const entry of sessionCtx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === SERVER_ENTRY && typeof entry.data?.port === "number")
      port = entry.data.port;
  }
  return port;
}
function planReview(pi) {
  let server = null;
  let ctx = null;
  let themeEpoch = null;
  let themeTimer;
  let resumePort = null;
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
  async function ensureServer(sessionCtx, port = recordedPort(sessionCtx)) {
    if (!server) {
      server = startPlanReviewServer({
        resolve: (reviewId, choice, options) => ctx?.resolvePlanReview(reviewId, choice, options) ?? false,
        sessionName: () => pi.getSessionName() || "omp"
      }, { ports: port ? [port, ...DEFAULT_PORTS] : DEFAULT_PORTS });
      if (themeApi)
        themeTimer = setInterval(() => syncAppearance(), 1000);
    }
    if (recordedPort(sessionCtx) !== server.port)
      pi.appendEntry(SERVER_ENTRY, { port: server.port });
    if (themeApi)
      await syncAppearance(true);
    return server;
  }
  pi.registerCommand("plan-review", {
    description: "Open the plan review page: comment on the plan's lines, then refine or approve it",
    handler: async (_args, commandCtx) => {
      ctx = commandCtx;
      const url = (await ensureServer(commandCtx)).url();
      await openBoard(url, { focus: true });
      commandCtx.ui.notify(`plan review open at ${url}`, "info");
    }
  });
  pi.on("plan_review_requested", (event, eventCtx) => {
    if (eventCtx.agent?.kind === "sub")
      return;
    ctx = eventCtx;
    (async () => {
      const reviewServer = await ensureServer(eventCtx);
      reviewServer.present(event);
      if (!process.env.ORCHESTRATOR_TASK)
        await openBoard(reviewServer.url(), { focus: true });
    })().catch((error) => eventCtx.ui.notify(`Plan review: the page didn't open: ${error instanceof Error ? error.message : String(error)}`, "warning"));
  });
  pi.on("plan_review_resolved", (event, eventCtx) => {
    if (eventCtx.agent?.kind === "sub")
      return;
    server?.resolved(event.reviewId, event.choice ?? null, event.by);
  });
  pi.on("before_agent_start", (_event, eventCtx) => {
    if (eventCtx.agent?.kind !== "sub")
      server?.setWorking(true);
  });
  pi.on("agent_end", (_event, eventCtx) => {
    if (eventCtx.agent?.kind !== "sub")
      server?.setWorking(false);
  });
  pi.on("session_start", async (_event, sessionCtx) => {
    ctx = sessionCtx;
    const port = resumePort ?? recordedPort(sessionCtx);
    resumePort = null;
    if (sessionCtx.agent?.kind !== "sub" && process.env.OMP_CONTROL_REVIEWER !== "1")
      await ensureServer(sessionCtx, port);
  });
  pi.on("session_switch", async (_event, sessionCtx) => {
    ctx = sessionCtx;
    if (server)
      server.clear();
    else
      await ensureServer(sessionCtx);
  });
  pi.on("session_shutdown", () => {
    resumePort = server?.port ?? null;
    clearInterval(themeTimer);
    themeEpoch = null;
    server?.stop();
    server = null;
  });
}
export {
  planReview as default
};
