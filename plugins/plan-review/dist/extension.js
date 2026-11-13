// @bun
// plugins/plan-review/src/extension.ts
import * as omp from "@oh-my-pi/pi-coding-agent";

// packages/control-view/src/protocol.ts
var RUN_EVENT = "control:run";
var COMMAND_EVENT = "control:command";

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
  "--syn-punctuation": "syntaxPunctuation",
  "--md-heading": "mdHeading",
  "--md-link": "mdLink",
  "--md-link-url": "mdLinkUrl",
  "--md-code": "mdCode",
  "--md-code-block": "mdCodeBlock",
  "--md-code-border": "mdCodeBlockBorder",
  "--md-quote": "mdQuote",
  "--md-quote-border": "mdQuoteBorder",
  "--md-hr": "mdHr",
  "--md-bullet": "mdListBullet"
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

// packages/integrations/src/page.ts
function recordedPort(ctx, entryType) {
  let port = null;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === entryType && typeof entry.data?.port === "number")
      port = entry.data.port;
  }
  return port;
}
function appearanceSync(omp, page) {
  const api = hasThemeApi(omp) ? omp : null;
  let epoch = null;
  let timer;
  const sync = async (force = false) => {
    if (!api || !page())
      return;
    const now = api.getThemeEpoch();
    if (now === epoch && !force)
      return;
    epoch = now;
    const [theme, terminal] = await Promise.all([currentTheme(api), terminalConfig()]);
    if (epoch === now)
      page()?.setAppearance(toAppearance(theme, terminal));
  };
  return {
    sync,
    start() {
      if (api && !timer)
        timer = setInterval(() => void sync().catch(() => {}), 1000);
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      epoch = null;
    }
  };
}

// packages/integrations/src/text.ts
var errorText = (e) => e instanceof Error ? e.message : String(e);

// plugins/plan-review/src/server.ts
import { homedir as homedir2 } from "os";
import { join as join3, resolve as resolve3 } from "path";

// packages/integrations/src/server.ts
import { randomBytes, timingSafeEqual } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { extname as extname2, join as join2, resolve as resolve2, sep } from "path";
var CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2"
};
var portRange = (base) => Array.from({ length: 10 }, (_, i) => base + i);
function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

class HttpError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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
async function serveStatic(webDir, pathname, token) {
  const file = resolve2(webDir, `.${pathname === "/" ? "/index.html" : pathname}`);
  const type = CONTENT_TYPES[extname2(file)];
  if (!type || !file.startsWith(webDir + sep))
    return new Response("Not found", { status: 404 });
  if (!await Bun.file(file).exists())
    return new Response("Not found", { status: 404 });
  const headers = { "Content-Type": type, "Cache-Control": "no-store" };
  if (type.startsWith("text/html")) {
    const html = await Bun.file(file).text();
    return new Response(html.replace('href="/appearance.css"', `href="/appearance.css?token=${token}"`), { headers });
  }
  return new Response(Bun.file(file), { headers });
}
function startPageServer(options) {
  const token = storedToken(options.stateDir);
  const expected = Buffer.from(token);
  let css = "";
  let font;
  const authorized = (url) => {
    const given = Buffer.from(url.searchParams.get("token") ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  async function fetch(req, srv2) {
    const url = new URL(req.url);
    const ok = authorized(url);
    if (url.pathname === "/ws") {
      if (options.websocket && ok && srv2.upgrade(req, { data: undefined }))
        return;
      return new Response("Forbidden", { status: 403 });
    }
    if (options.fonts && url.pathname === "/api/font") {
      if (!ok)
        return new Response("Forbidden", { status: 403 });
      if (!font || url.searchParams.get("id") !== font.id)
        return new Response("Not found", { status: 404 });
      return new Response(Bun.file(font.path), { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!ok)
        return json({ error: "forbidden" }, 403);
      try {
        return await options.api(req, url);
      } catch (e) {
        return json({ error: errorText(e) }, e instanceof HttpError ? e.status : 500);
      }
    }
    if (url.pathname === "/appearance.css") {
      if (!ok)
        return new Response("Forbidden", { status: 403 });
      return new Response(css, { headers: { "Content-Type": CONTENT_TYPES[".css"], "Cache-Control": "no-store" } });
    }
    return serveStatic(options.webDir, url.pathname, ok ? token : "");
  }
  let server = null;
  for (const port of [...options.ports, 0]) {
    try {
      server = options.websocket ? Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: options.idleTimeout, fetch, websocket: options.websocket }) : Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: options.idleTimeout, fetch });
      break;
    } catch {}
  }
  if (!server)
    throw new Error(`${options.name}: could not bind a local port`);
  const srv = server;
  return {
    port: srv.port,
    token,
    server: srv,
    url: () => `http://127.0.0.1:${srv.port}/?token=${token}`,
    setAppearance(appearance) {
      font = options.fonts ? appearance?.font : undefined;
      const next = appearance ? options.fonts ? appearanceCss(appearance, `/api/font?token=${token}&id=${font?.id}`) : appearanceCss({ ...appearance, font: undefined }) : "";
      if (next === css)
        return;
      css = next;
      options.onAppearance();
    },
    stop() {
      srv.stop(true);
    }
  };
}

// plugins/plan-review/src/shared/protocol.js
var PROTOCOL = 2;

// plugins/plan-review/src/server.ts
var WEB_DIR = resolve3(import.meta.dir, "..", "web");
var DEFAULT_PORTS = portRange(9900);
var DEFAULT_STATE_DIR = join3(homedir2(), ".omp", "cache", "plan-review");
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
function startPlanReviewServer(hooks, { ports = DEFAULT_PORTS, stateDir = DEFAULT_STATE_DIR } = {}) {
  let review = null;
  let working = false;
  const publish = () => page.server.publish("plan", JSON.stringify({ type: "review", review }));
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
  const page = startPageServer({
    name: "plan-review",
    webDir: WEB_DIR,
    stateDir,
    ports,
    fonts: true,
    api: (req, url) => url.pathname !== "/api/resolve" ? json({ error: "not found" }, 404) : req.method === "POST" ? resolveReview(req) : json({ error: "method not allowed" }, 405),
    websocket: {
      open(ws) {
        ws.subscribe("plan");
        ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, session: hooks.sessionName(), review, working }));
      },
      message() {}
    },
    onAppearance: () => page.server.publish("plan", JSON.stringify({ type: "appearance" }))
  });
  return {
    port: page.port,
    token: page.token,
    url: page.url,
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
      page.server.publish("plan", JSON.stringify({ type: "working", working }));
    },
    setAppearance: page.setAppearance,
    stop: page.stop
  };
}

// plugins/plan-review/src/extension.ts
var SERVER_ENTRY = "plan-review.server";
var CONTROL_ASK_MS = 150;
function planReview(pi) {
  let server = null;
  let ctx = null;
  let resumePort = null;
  let pending = null;
  let opened = null;
  const appearance = appearanceSync(omp, () => server);
  async function ensureServer(sessionCtx, port = recordedPort(sessionCtx, SERVER_ENTRY)) {
    if (!server) {
      server = startPlanReviewServer({
        resolve: (reviewId, choice, options) => ctx?.resolvePlanReview(reviewId, choice, options) ?? false,
        sessionName: () => pi.getSessionName() || "omp"
      }, { ports: port ? [port, ...DEFAULT_PORTS] : DEFAULT_PORTS });
      appearance.start();
    }
    if (recordedPort(sessionCtx, SERVER_ENTRY) !== server.port)
      pi.appendEntry(SERVER_ENTRY, { port: server.port });
    await appearance.sync(true);
    return server;
  }
  const show = async (reviewId) => {
    if (opened === reviewId || pending !== reviewId || !ctx || process.env.ORCHESTRATOR_TASK)
      return;
    opened = reviewId;
    await openBoard((await ensureServer(ctx)).url(), { focus: true });
  };
  const showFailed = (error) => ctx?.ui.notify(`Plan review: the page didn't open: ${errorText(error)}`, "warning");
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
    pending = event.reviewId;
    (async () => {
      (await ensureServer(eventCtx)).present(event);
      const run = (await busAsk(pi.events, COMMAND_EVENT, { type: "run" }, CONTROL_ASK_MS, "")).run;
      if (run?.loop.plan === "ai" && run.status !== "paused" && run.plan !== "review")
        return;
      await show(event.reviewId);
    })().catch(showFailed);
  });
  pi.events.on(RUN_EVENT, (data) => {
    const view = data ?? null;
    if (view?.plan === "review" && pending)
      show(pending).catch(showFailed);
  });
  pi.on("plan_review_resolved", (event, eventCtx) => {
    if (eventCtx.agent?.kind === "sub")
      return;
    if (event.reviewId === pending)
      pending = null;
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
    if (sessionCtx.agent?.kind === "sub")
      return;
    ctx = sessionCtx;
    const port = resumePort ?? recordedPort(sessionCtx, SERVER_ENTRY);
    resumePort = null;
    if (process.env.OMP_CONTROL_REVIEWER === "1")
      return;
    await ensureServer(sessionCtx, port).catch((e) => sessionCtx.ui.notify(`Plan review: the page didn't start: ${errorText(e)}`, "warning"));
  });
  pi.on("session_switch", async (_event, sessionCtx) => {
    if (sessionCtx.agent?.kind === "sub")
      return;
    ctx = sessionCtx;
    if (server)
      server.clear();
    else
      await ensureServer(sessionCtx).catch((e) => sessionCtx.ui.notify(`Plan review: the page didn't start: ${errorText(e)}`, "warning"));
  });
  pi.on("session_shutdown", (_event, sessionCtx) => {
    if (sessionCtx.agent?.kind === "sub")
      return;
    ctx = null;
    pending = null;
    resumePort = server?.port ?? null;
    appearance.stop();
    server?.stop();
    server = null;
  });
}
export {
  planReview as default
};
