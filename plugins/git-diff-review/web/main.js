import { expandRows, revealRange } from "../src/shared/expand.js";
import { PROTOCOL } from "../src/shared/protocol.js";
import { blockStarts, changeBlockAround, pairRows, rowsIn } from "../src/shared/layout.js";
import { formatPin, pinCovers, pinFromSelection, referenceFor, reviewMessage, singleMessage } from "../src/shared/reference.js";
import { copyText, esc, isTextField, openMenu, splitPath, toast } from "./dom.js";
import { icon } from "./icons.js";
import { bodyHtml, composerHtml, highlightRows, wordSpans } from "./render.js";

const PREFS_KEY = "git-diff-review:prefs";
const LARGE_DIFF_ROWS = 1500;
const RENDER_MARGIN = 1500;
const FONT_SIZES = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const params = new URLSearchParams(location.search);
const token = params.get("token") ?? "";
const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");

const state = {
  compare: compareFromParams(params),
  files: [],
  branch: null,
  base: null,
  commit: null,
  loading: true,
  error: null,
  notRepo: false,
  loadedKey: null,
  selected: params.get("file"),
  filter: "",
  tree: prefs.tree ?? true,
  collapsedDirs: new Set(),
  collapsed: new Set(),
  expanded: new Set(),
  loadedLarge: new Set(),
  layout: prefs.layout === "split" ? "split" : "unified",
  wrap: Boolean(prefs.wrap),
  ignoreWhitespace: Boolean(prefs.ignoreWhitespace),
  syntaxColors: prefs.syntaxColors !== false,
  sidebarWidth: prefs.sidebarWidth ?? 300,
  sidebarHidden: Boolean(prefs.sidebarHidden),
  openIn: typeof prefs.openIn === "string" ? prefs.openIn : null,
  fontSize: typeof prefs.fontSize === "number" ? prefs.fontSize : null,
  pins: [],
  viewed: {},
  root: null,
  session: null,
  connected: false,
};

const fileStates = new Map();
let sel = null;
let composer = null;
let drag = null;
let pinCursor = null;
let pendingScroll = state.selected;

function compareFromParams(p) {
  const kind = p.get("kind");
  if (kind === "branch") return { kind, base: p.get("base") || null };
  if (kind === "commit") return { kind, sha: p.get("sha") || null };
  return { kind: "uncommitted" };
}

function compareKey(c) {
  if (c.kind === "commit") return `commit:${c.sha}`;
  if (c.kind === "branch") return `branch:${c.base ?? ""}`;
  return "uncommitted";
}

// Which file version a pin's new-side line numbers refer to.
const side = () => (state.compare.kind === "commit" ? `commit:${state.compare.sha}` : "worktree");
const viewedKey = (path) => `${compareKey(state.compare)}|${path}`;
const pinsFor = (path) => state.pins.filter((p) => p.path === path && p.side === side());

function signature(file) {
  let h = 2166136261;
  const text = JSON.stringify(file.rows ?? [file.additions, file.deletions, file.status]);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function savePrefs() {
  const { tree, layout, wrap, ignoreWhitespace, syntaxColors, sidebarWidth, sidebarHidden, openIn, fontSize } = state;
  localStorage.setItem(PREFS_KEY, JSON.stringify({ tree, layout, wrap, ignoreWhitespace, syntaxColors, sidebarWidth, sidebarHidden, openIn, fontSize }));
}

function syncUrl() {
  const p = new URLSearchParams({ token });
  const c = state.compare;
  if (c.kind !== "uncommitted") p.set("kind", c.kind);
  if (c.kind === "branch" && c.base) p.set("base", c.base);
  if (c.kind === "commit" && c.sha) p.set("sha", c.sha);
  if (state.selected) p.set("file", state.selected);
  history.replaceState(null, "", `?${p}`);
}

// MARK: layout

const app = document.getElementById("app");
app.innerHTML = `
  <section class="main">
    <div class="banner" hidden></div>
    <header class="review-context">
      <div class="segmented icons comparison-mode" role="group" aria-label="Comparison mode">${[["uncommitted", "diff", "Working tree"], ["branch", "branch", "Branch comparison"], ["commit", "commit", "Single commit"]].map(([kind, glyph, label]) => `<button type="button" data-act="compare" data-kind="${kind}" title="${label}" aria-label="${label}" aria-pressed="false">${icon(glyph, 14)}</button>`).join("")}</div>
      <div class="compare-context"></div>
    </header>
    <header class="toolbar">
      <span class="totals stats"></span>
      <div class="review-actions" hidden></div>
      <span class="spacer"></span>
      <div class="findbar" hidden>
        ${icon("search", 13)}<input class="find-input" type="text" placeholder="Find in diff" spellcheck="false" />
        <span class="find-count"></span>
        <button class="tool-button" data-act="find-prev" title="Previous match (⇧↩)">${icon("chevronUp", 13)}</button>
        <button class="tool-button" data-act="find-next" title="Next match (↩)">${icon("chevronDown", 13)}</button>
        <button class="tool-button" data-act="find-close" title="Close (Esc)">${icon("close", 13)}</button>
      </div>
      <button class="tool-button" data-act="find" title="Find in diff (⌘F)">${icon("search")}</button>
      <button class="tool-button" data-act="prev-change" title="Previous change ([)">${icon("chevronUp")}</button>
      <button class="tool-button" data-act="next-change" title="Next change (])">${icon("chevronDown")}</button>
      <span class="toolbar-divider"></span>
      <button class="tool-button" data-act="layout"></button>
      <button class="tool-button" data-act="view-options" title="View options" aria-label="View options">${icon("settings")}</button>
      <button class="tool-button" data-act="sidebar" title="Toggle file list (b or ⌘\\)" aria-label="Toggle file list" aria-controls="file-sidebar">${icon("sidebar")}</button>
    </header>
    <div class="scroller" tabindex="-1">
      <div class="files"></div>
      <div class="sel-toolbar" hidden>
        <button data-act="comment-selection" title="Comment (c)">${icon("commentAdd", 13)}<span>Comment</span></button>
        <button data-act="paste-selection" title="Insert the reference into the omp prompt">${icon("arrowRight", 13)}<span>Add to prompt</span></button>
        <button data-act="copy-selection" title="Copy reference (⌘C)">${icon("copy", 13)}</button>
      </div>
    </div>
  </section>
  <div class="resizer" role="separator" aria-label="Resize file list" aria-orientation="vertical" title="Drag to resize file list"></div>
  <aside class="sidebar" id="file-sidebar" aria-label="Changed files">
    <div class="top">
      <div class="search">${icon("search", 13)}<input class="filter" type="search" placeholder="Filter files" spellcheck="false" />
        <button class="tool-button" data-act="tree" title="Group by folder">${icon("tree")}</button></div>
    </div>
    <div class="progress"></div>
    <div class="list" tabindex="0"></div>
  </aside>`;

const list = app.querySelector(".list");
const scroller = app.querySelector(".scroller");
const filesEl = app.querySelector(".files");
const selToolbar = app.querySelector(".sel-toolbar");
const filterInput = app.querySelector(".filter");
app.style.setProperty("--sidebar-w", `${state.sidebarWidth}px`);
app.classList.toggle("sidebar-hidden", state.sidebarHidden);
app.classList.toggle("default-syntax", !state.syntaxColors);
app.querySelector('[data-act="sidebar"]').setAttribute("aria-expanded", String(!state.sidebarHidden));

function toggleSidebar() {
  state.sidebarHidden = !state.sidebarHidden;
  app.classList.toggle("sidebar-hidden", state.sidebarHidden);
  app.querySelector('[data-act="sidebar"]').setAttribute("aria-expanded", String(!state.sidebarHidden));
  savePrefs();
  updateSelectionUi();
}

// MARK: socket

let socket = null;
let retry = 0;

function connect() {
  socket = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
  socket.onopen = () => {
    retry = 0;
    state.connected = true;
    renderBanner();
  };
  socket.onmessage = (e) => onSocket(JSON.parse(e.data));
  socket.onclose = () => {
    state.connected = false;
    renderBanner();
    setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
  };
}

function send(msg) {
  if (socket?.readyState !== WebSocket.OPEN) {
    toast("Not connected to omp. Run /review again.");
    return false;
  }
  socket.send(JSON.stringify(msg));
  return true;
}

function onSocket(msg) {
  if (msg.type === "appearance" || (msg.type === "hello" && state.root)) {
    document.getElementById("appearance").href = `/appearance.css?token=${encodeURIComponent(token)}&t=${Date.now()}`;
  }
  if (msg.type === "hello") {
    const moved = state.root && state.root !== msg.root;
    state.root = msg.root;
    state.stale = msg.protocol !== PROTOCOL;
    renderBanner();
    state.session = msg.session;
    state.pins = msg.pins;
    state.viewed = msg.viewed;
    app.querySelector(".review-context").title = msg.session ? `${msg.root}\nSession: ${msg.session}` : msg.root;
    document.title = `Review · ${msg.name}`;
    if (moved) {
      state.selected = null;
      setCompare({ kind: "uncommitted" });
    } else {
      renderSidebar();
      syncCollapsed();
      rerenderBodies();
    }
  } else if (msg.type === "state") {
    const pinsChanged = JSON.stringify(msg.pins) !== JSON.stringify(state.pins);
    state.pins = msg.pins;
    state.viewed = msg.viewed;
    renderSidebar();
    syncCollapsed();
    if (pinsChanged) rerenderBodies();
  } else if (msg.type === "changed") {
    scheduleRefresh();
  } else if (msg.type === "error") {
    toast(msg.message);
  }
}

function setPins(pins) {
  state.pins = pins;
  send({ type: "pins", pins });
  renderSidebar();
  renderHeaders();
  rerenderBodies();
}

function setViewed(path, viewed) {
  const next = { ...state.viewed };
  if (viewed) next[viewedKey(path)] = signature(state.files.find((f) => f.path === path));
  else delete next[viewedKey(path)];
  state.viewed = next;
  state.collapsed.delete(path);
  state.expanded.delete(path);
  send({ type: "viewed", viewed: next });
  renderSidebar();
  syncCollapsed();
}

// MARK: data

async function api(path, query = {}) {
  const res = await fetch(`${path}?${new URLSearchParams({ token, ...query })}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function compareQuery() {
  const c = state.compare;
  const query = { kind: c.kind };
  if (c.kind === "branch" && c.base) query.base = c.base;
  if (c.kind === "commit" && c.sha) query.sha = c.sha;
  return query;
}

let seq = 0;
let timer = null;
let dirty = false;

function scheduleRefresh(ms = 400) {
  if (document.hidden) {
    dirty = true;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(refresh, ms);
}

async function refresh() {
  const mine = ++seq;
  state.loading = true;
  renderProgress();
  try {
    const c = state.compare;
    const review = await api("/api/review", { ...compareQuery(), ws: state.ignoreWhitespace ? "1" : "0" });
    if (mine !== seq) return;
    Object.assign(state, { files: review.files, branch: review.branch, base: review.base, commit: review.commit, notRepo: Boolean(review.notRepo), error: null });
    app.classList.toggle("no-repo", state.notRepo);
    if (c.kind === "commit" && !c.sha && review.commit) state.compare = { kind: "commit", sha: review.commit.sha };
    state.loadedKey = compareKey(state.compare);
    clearStaleViewed();
  } catch (error) {
    if (mine !== seq) return;
    state.error = error.message;
  } finally {
    if (mine === seq) {
      state.loading = false;
      renderProgress();
      renderSidebar();
      renderFiles();
    }
  }
}

function clearStaleViewed() {
  const next = { ...state.viewed };
  let changed = false;
  for (const f of state.files) {
    const key = viewedKey(f.path);
    if (next[key] && next[key] !== signature(f)) {
      delete next[key];
      changed = true;
    }
  }
  if (changed) {
    state.viewed = next;
    send({ type: "viewed", viewed: next });
  }
}

function setCompare(compare) {
  commitDraft();
  state.compare = compare;
  state.files = [];
  state.base = null;
  state.commit = null;
  state.collapsed.clear();
  state.expanded.clear();
  sel = null;
  pendingScroll = state.selected;
  syncUrl();
  resetFiles();
  refresh();
  renderSidebar();
  renderFiles();
}

// MARK: file order

function filteredFiles() {
  const q = state.filter.trim().toLowerCase();
  return q ? state.files.filter((f) => f.path.toLowerCase().includes(q)) : state.files;
}

function treeOf(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    let node = root;
    for (const part of f.path.split("/").slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(f);
  }
  return root;
}

// Display order of the tree: folders first, single-child folder chains compressed into one row.
function* walk(node, prefix = "", depth = 0) {
  for (const [first, firstChild] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
    let name = first;
    let child = firstChild;
    while (!child.files.length && child.dirs.size === 1) {
      const [[n, c]] = child.dirs;
      name = `${name}/${n}`;
      child = c;
    }
    const path = prefix ? `${prefix}/${name}` : name;
    yield { dir: path, name, depth };
    yield* walk(child, path, depth + 1);
  }
  for (const file of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) yield { file, depth };
}

function orderedFiles() {
  const files = filteredFiles();
  return state.tree ? [...walk(treeOf(files))].filter((e) => e.file).map((e) => e.file) : files;
}

function markCurrent(path, { reveal = true } = {}) {
  if (!path || state.selected === path) return;
  state.selected = path;
  syncUrl();
  for (const row of list.querySelectorAll(".file-row.selected")) row.classList.remove("selected");
  const row = list.querySelector(`.file-row[data-path="${CSS.escape(path)}"]`);
  row?.classList.add("selected");
  if (reveal) row?.scrollIntoView({ block: "nearest" });
}

function select(path, { focusList = false } = {}) {
  if (!path) return;
  let reveal = false;
  for (const d of [...state.collapsedDirs]) {
    if (path.startsWith(`${d}/`)) {
      state.collapsedDirs.delete(d);
      reveal = true;
    }
  }
  if (reveal) renderList();
  markCurrent(path);
  scrollToFile(path);
  if (focusList) list.querySelector(`.file-row[data-path="${CSS.escape(path)}"]`)?.focus();
}

function stepFile(direction) {
  const files = orderedFiles();
  const idx = files.findIndex((f) => f.path === state.selected);
  const next = direction > 0 ? files[idx + 1] : idx > 0 ? files[idx - 1] : null;
  if (next) select(next.path, { focusList: list.contains(document.activeElement) });
  return Boolean(next);
}

// MARK: sidebar

function renderProgress() {
  app.querySelector(".progress").classList.toggle("active", state.loading);
}

function renderBanner() {
  const banner = app.querySelector(".banner");
  banner.hidden = state.connected && !state.stale;
  banner.textContent = !state.connected
    ? "Disconnected from omp. Comments can't be sent; run /review again if the session ended."
    : "This omp session is running an older review plugin. Restart omp, then run /review to load the current version.";
}

function relative(date) {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function contextRow() {
  const c = state.compare;
  const fresh = state.loadedKey === compareKey(c);
  const branch = `<span class="ctx-branch">${icon("branch", 13)}<span>${esc(state.branch ?? (fresh ? "detached HEAD" : ""))}</span></span>`;
  const refresh = `<button class="tool-button" data-act="refresh" title="Refresh (r)">${icon("refresh")}</button>`;
  if (c.kind === "branch") {
    const base = c.base ?? state.base?.ref ?? (fresh ? "choose a base" : "…");
    return `${branch}<span class="muted">→</span><button class="chip" data-act="base" title="Change the comparison base: ${esc(base)}"><span class="chip-label">${esc(base)}</span>${icon("chevronDown", 12)}</button><span class="spacer"></span>${refresh}`;
  }
  if (c.kind === "commit") {
    const commit = state.commit;
    const label = commit ? `<span class="mono">${esc(commit.short)}</span> ${esc(commit.subject)}` : fresh ? "No commits" : "…";
    return `<button class="chip commit-chip" data-act="commit" title="Choose another commit">${icon("commit", 13)}<span class="chip-label">${label}</span>${icon("chevronDown", 12)}</button><span class="spacer"></span>${refresh}`;
  }
  return `${branch}<span class="muted">→ HEAD</span><span class="spacer"></span>${refresh}`;
}

function fileRow(file, depth) {
  const { dir, name } = splitPath(file.path);
  const comments = pinsFor(file.path).length;
  const viewed = Boolean(state.viewed[viewedKey(file.path)]);
  const title = file.origPath ? `${file.origPath} → ${file.path}` : file.path;
  return `<div class="file-row nav${viewed ? " viewed" : ""}${state.selected === file.path ? " selected" : ""}" tabindex="-1" data-path="${esc(file.path)}" title="${esc(title)}" style="padding-left:${state.tree ? 18 + depth * 10 : 8}px">
    <span class="status-letter status-${esc(file.status)}">${esc(file.status === "?" ? "U" : file.status)}</span>
    <span class="file-name">${esc(name)}</span>
    ${state.tree || !dir ? "" : `<span class="file-dir">${esc(dir)}</span>`}
    <span class="spacer"></span>
    ${comments ? `<span class="row-badge" title="${comments} comment${comments > 1 ? "s" : ""}">${icon("comment", 12)}${comments}</span>` : ""}
    ${viewed ? `<span class="row-viewed" title="Viewed">${icon("check", 12)}</span>` : ""}
    <span class="stats">${file.additions ? `<span class="add">+${file.additions}</span>` : ""} ${file.deletions ? `<span class="remove">−${file.deletions}</span>` : ""}</span>
  </div>`;
}

function listHtml() {
  if (state.error) return `<div class="empty-state"><strong>Couldn't read changes</strong><pre>${esc(state.error)}</pre><button class="btn" data-act="refresh">Try again</button></div>`;
  if (!state.files.length) {
    if (state.loading || state.notRepo) return "";
    const what = { uncommitted: "No uncommitted changes", branch: "No changes on this branch", commit: "This commit has no file changes" }[state.compare.kind];
    return `<div class="empty-state"><strong>${what}</strong><span>Edits show up here as your agent makes them.</span></div>`;
  }
  const files = filteredFiles();
  if (!files.length) return `<div class="empty-state"><span>No files match “${esc(state.filter)}”</span></div>`;
  if (!state.tree) return files.map((f) => fileRow(f, 0)).join("");
  const out = [];
  for (const entry of walk(treeOf(files))) {
    const path = entry.dir ?? entry.file.path;
    if ([...state.collapsedDirs].some((d) => path.startsWith(`${d}/`))) continue;
    if (entry.file) {
      out.push(fileRow(entry.file, entry.depth));
      continue;
    }
    const collapsed = state.collapsedDirs.has(entry.dir);
    out.push(
      `<div class="dir-row nav" tabindex="-1" aria-expanded="${!collapsed}" data-dir="${esc(entry.dir)}" style="padding-left:${4 + entry.depth * 10}px">${icon(collapsed ? "chevronRight" : "chevronDown", 12)}${icon(collapsed ? "folder" : "folderOpen", 14)}<span>${esc(entry.name)}</span></div>`,
    );
  }
  return out.join("");
}

function renderList() {
  const focused = document.activeElement?.closest?.(".list .nav");
  const key = focused?.dataset.path ?? focused?.dataset.dir;
  list.innerHTML = listHtml();
  if (key) list.querySelector(`[data-path="${CSS.escape(key)}"], [data-dir="${CSS.escape(key)}"]`)?.focus();
}

function renderReviewActions() {
  const draft = composer && !composer.editing && filesEl.querySelector(".composer textarea")?.value.trim() ? 1 : 0;
  const count = state.pins.length + draft;
  const actions = app.querySelector(".review-actions");
  actions.hidden = count === 0;
  actions.innerHTML = count ? `<div class="split-button">
      <button class="btn primary" data-act="send-review" title="Send review to ${esc(state.session ?? "omp")}">${icon("send", 13)}<span class="btn-label">Send review (${count})</span></button>
      <button class="btn primary" data-act="review-menu" title="Review actions">${icon("chevronDown", 13)}</button>
    </div>` : "";
}

function renderSidebar() {
  for (const button of app.querySelectorAll('[data-act="compare"]')) {
    button.setAttribute("aria-pressed", String(button.dataset.kind === state.compare.kind));
  }
  app.querySelector(".compare-context").innerHTML = contextRow();
  app.querySelector('[data-act="tree"]').classList.toggle("active", state.tree);
  renderList();
  renderToolbar();
}

// MARK: main

function renderToolbar() {
  renderReviewActions();
  const adds = state.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const dels = state.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const viewed = state.files.filter((f) => state.viewed[viewedKey(f.path)]).length;
  app.querySelector(".totals").innerHTML = state.files.length
    ? `<span class="muted">${viewed}/${state.files.length} viewed</span>${adds ? ` <span class="add">+${adds}</span>` : ""}${dels ? ` <span class="remove">−${dels}</span>` : ""}`
    : "";
  const layoutBtn = app.querySelector('[data-act="layout"]');
  layoutBtn.innerHTML = icon(state.layout === "split" ? "unified" : "split");
  layoutBtn.title = state.layout === "split" ? "Unified view" : "Side by side";
  scroller.classList.toggle("wrap", state.wrap);
}

// MARK: files

const isCollapsed = (path) => state.collapsed.has(path) || (Boolean(state.viewed[viewedKey(path)]) && !state.expanded.has(path));
const isDeferred = (fs) => (fs.file.rows?.length ?? 0) > LARGE_DIFF_ROWS && !state.loadedLarge.has(fs.file.path);
const itemsFor = (rows) => (state.layout === "split" ? pairRows(rows) : rows);
const canExpand = (file) => (file.status === "M" || file.status === "R") && !file.truncated && Boolean(file.rows?.length);

function setRows(fs) {
  fs.rows = canExpand(fs.file) ? expandRows(fs.file.rows, fs.lines, fs.revealed) : (fs.file.rows ?? []);
  fs.items = itemsFor(fs.rows);
  fs.tokens = null;
  fs.spans = null;
  fs.highlighting = null;
}

function headerHtml(file) {
  const { dir, name } = splitPath(file.path);
  const viewed = Boolean(state.viewed[viewedKey(file.path)]);
  const comments = pinsFor(file.path).length;
  return `${icon(isCollapsed(file.path) ? "chevronRight" : "chevronDown", 14)}
    <span class="status-letter status-${esc(file.status)}">${esc(file.status === "?" ? "U" : file.status)}</span>
    <span class="path">${dir ? `<span class="dir">${esc(dir)}/</span>` : ""}<b>${esc(name)}</b></span>
    ${file.origPath ? `<span class="muted renamed">from ${esc(file.origPath)}</span>` : ""}
    <span class="stats">${file.additions ? `<span class="add">+${file.additions}</span>` : ""} ${file.deletions ? `<span class="remove">−${file.deletions}</span>` : ""}</span>
    ${comments ? `<span class="badge-comments">${icon("comment", 12)}${comments}</span>` : ""}
    <span class="spacer"></span>
    <button class="tool-button" data-act="copy-path" title="Copy path">${icon("copy", 13)}</button>
    ${file.status === "D" ? "" : `<button class="tool-button" data-act="open-in" title="Open in…">${icon("openIn", 13)}</button>`}
    <label class="viewed-toggle${viewed ? " on" : ""}" title="Mark as viewed and collapse (v)"><input type="checkbox" data-act="viewed" ${viewed ? "checked" : ""}/>Viewed</label>`;
}

function emptyHtml() {
  if (state.error) return `<strong>Couldn't load the diff</strong><pre>${esc(state.error)}</pre>`;
  if (state.loading) return `<span>Loading…</span>`;
  if (state.notRepo) {
    return `<strong>Not a git repository</strong><span>Initialize one to review every file here and track changes as your agent edits.</span><button class="btn primary" data-act="git-init">Initialize git repository</button>`;
  }
  if (state.files.length) return `<span>No files match “${esc(state.filter)}”</span>`;
  return `<strong>Nothing to review</strong><span>Changes appear here as your agent edits files.</span>`;
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const fs = fileStates.get(e.target.closest(".file")?.dataset.path);
      if (!fs || isCollapsed(fs.file.path)) continue;
      if (e.isIntersecting && !fs.rendered) renderBody(fs);
      else if (!e.isIntersecting && fs.rendered && sel?.path !== fs.file.path && composer?.path !== fs.file.path) unrender(fs);
    }
  },
  { root: scroller, rootMargin: `${RENDER_MARGIN}px 0px` },
);

function resetFiles() {
  for (const fs of fileStates.values()) {
    observer.unobserve(fs.el.querySelector(".file-body"));
    fs.el.remove();
  }
  fileStates.clear();
  scroller.scrollTop = 0;
}

function renderFiles() {
  renderToolbar();
  const files = state.error ? [] : orderedFiles();
  const keep = new Set(state.files.map((f) => f.path));
  for (const [path, fs] of fileStates) {
    if (keep.has(path)) continue;
    observer.unobserve(fs.el.querySelector(".file-body"));
    fs.el.remove();
    fileStates.delete(path);
    if (sel?.path === path) sel = null;
    if (composer?.path === path) composer = null;
  }
  let empty = filesEl.querySelector(".empty-state");
  if (!files.length) {
    for (const fs of fileStates.values()) fs.el.remove();
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "empty-state";
      filesEl.prepend(empty);
    }
    empty.innerHTML = emptyHtml();
    updateSelectionUi();
    return;
  }
  empty?.remove();
  const shown = new Set(files.map((f) => f.path));
  for (const fs of fileStates.values()) if (!shown.has(fs.file.path)) fs.el.remove();
  let prev = null;
  for (const file of files) {
    let fs = fileStates.get(file.path);
    const sig = signature(file);
    if (!fs) {
      const el = document.createElement("section");
      el.className = "file";
      el.dataset.path = file.path;
      el.innerHTML = `<header class="file-header"></header><div class="file-body"></div>`;
      fs = { file, sig, el, rows: [], items: [], lines: null, revealed: [], tokens: null, spans: null, rendered: false, highlighting: null };
      setRows(fs);
      fileStates.set(file.path, fs);
      observer.observe(el.querySelector(".file-body"));
    } else if (fs.sig !== sig) {
      if (sel?.path === file.path) sel = null;
      if (composer?.path === file.path && composer.editing == null) commitDraft();
      Object.assign(fs, { file, sig, lines: null, revealed: [] });
      setRows(fs);
    } else {
      fs.file = file;
    }
    if (prev ? prev.nextSibling !== fs.el : filesEl.firstChild !== fs.el) {
      if (prev) prev.after(fs.el);
      else filesEl.prepend(fs.el);
    }
    prev = fs.el;
    fs.el.querySelector(".file-header").innerHTML = headerHtml(file);
    fs.el.classList.toggle("collapsed", isCollapsed(file.path));
    if (fs.rendered && fs.tokens == null && fs.highlighting == null) renderBody(fs);
    else if (!fs.rendered) placeholder(fs);
  }
  if (pendingScroll && fileStates.has(pendingScroll)) {
    const path = pendingScroll;
    pendingScroll = null;
    markCurrent(path);
    scrollToFile(path, { flash: false });
  } else {
    pendingScroll = null;
    spy();
  }
  updateSelectionUi();
  refreshFind();
}

let rowHeight = 0;

function placeholder(fs) {
  const body = fs.el.querySelector(".file-body");
  body.innerHTML = "";
  body.style.height = isCollapsed(fs.file.path) ? "0px" : `${isDeferred(fs) ? 44 : Math.max(1, fs.items.length) * rowHeight + 8}px`;
  fs.rendered = false;
}

// Rendered rows reflow on their own; placeholders are sized from the row height.
function syncFontSize() {
  const root = document.documentElement;
  if (state.fontSize) root.style.setProperty("--font-size", `${state.fontSize}px`);
  else root.style.removeProperty("--font-size");
  const next = parseFloat(getComputedStyle(root).getPropertyValue("--row-h"));
  if (next === rowHeight) return;
  rowHeight = next;
  for (const fs of fileStates.values()) if (!fs.rendered) placeholder(fs);
  updateSelectionUi();
}

function unrender(fs) {
  const body = fs.el.querySelector(".file-body");
  body.style.height = `${body.getBoundingClientRect().height}px`;
  body.innerHTML = "";
  fs.rendered = false;
}

function renderHeaders() {
  for (const fs of fileStates.values()) fs.el.querySelector(".file-header").innerHTML = headerHtml(fs.file);
}

function nearViewport(el) {
  const rect = el.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  return rect.top < view.bottom + RENDER_MARGIN && rect.bottom > view.top - RENDER_MARGIN;
}

function syncCollapsed() {
  for (const fs of fileStates.values()) {
    const collapsed = isCollapsed(fs.file.path);
    fs.el.classList.toggle("collapsed", collapsed);
    fs.el.querySelector(".file-header").innerHTML = headerHtml(fs.file);
    if (collapsed) {
      if (fs.rendered || fs.el.querySelector(".file-body").style.height !== "0px") placeholder(fs);
    } else if (!fs.rendered) {
      placeholder(fs);
      if (fs.el.isConnected && nearViewport(fs.el)) renderBody(fs);
    }
  }
  updateSelectionUi();
}

async function highlight(fs) {
  const sig = fs.sig;
  const run = highlightRows(fs.rows, fs.file.path);
  fs.highlighting = run;
  try {
    const tokens = await run;
    if (fs.sig !== sig || fs.highlighting !== run || !tokens) return;
    fs.tokens = tokens;
    if (fs.rendered) renderBody(fs);
  } catch (error) {
    console.warn("highlight failed", fs.file.path, error);
  }
}

function pinForItem(fs, item) {
  const rows = "kind" in item ? [item] : [item.left, item.right];
  for (const row of rows) {
    if (!row || row.kind === "hunk") continue;
    const pin = state.pins.find((p) => p.path === fs.file.path && p.side === side() && pinCovers(p, row));
    if (pin) return pin;
  }
  return null;
}

function renderBody(fs) {
  const body = fs.el.querySelector(".file-body");
  const above = fs.el.getBoundingClientRect().top < scroller.getBoundingClientRect().top;
  const before = body.getBoundingClientRect().height;
  const composing = composer?.path === fs.file.path ? composer : null;
  const draft = composing ? body.querySelector(".composer textarea")?.value : null;
  body.style.height = "";
  if (isDeferred(fs)) {
    body.innerHTML = `<div class="body-note">Large diff (${fs.file.rows.length.toLocaleString()} lines) hidden to keep scrolling smooth.<button class="btn" data-act="load-diff">Load diff</button></div>`;
  } else {
    fs.spans ??= wordSpans(fs.rows);
    if (fs.tokens == null && fs.highlighting == null) highlight(fs);
    body.innerHTML = bodyHtml({ ...fs.file, rows: fs.rows }, {
      items: fs.items,
      layout: state.layout,
      tokens: fs.tokens,
      spans: fs.spans,
      pinFor: (item) => pinForItem(fs, item),
      pins: pinsFor(fs.file.path),
      composer: composing ? { afterIndex: composing.afterIndex, editing: composing.editing, html: composerHtml(composing) } : null,
    });
  }
  fs.rendered = true;
  if (above) scroller.scrollTop += body.getBoundingClientRect().height - before;
  if (composing) {
    const ta = body.querySelector(".composer textarea");
    if (draft != null) ta.value = draft;
    if (composing.focus) {
      composing.focus = false;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.closest(".composer").scrollIntoView({ block: "nearest" });
    }
  }
  paintSelection();
  scheduleFindPaint();
}

function rerenderBodies() {
  for (const fs of fileStates.values()) if (fs.rendered) renderBody(fs);
  updateSelectionUi();
}

function ensureRendered(path) {
  const fs = fileStates.get(path);
  if (!fs) return null;
  if (isCollapsed(path)) {
    state.collapsed.delete(path);
    state.expanded.add(path);
    syncCollapsed();
  }
  if (!fs.rendered) renderBody(fs);
  return fs;
}

function scrollToFile(path, { flash = true } = {}) {
  const fs = fileStates.get(path);
  if (!fs?.el.isConnected) return false;
  if (!isCollapsed(path) && !fs.rendered) renderBody(fs);
  scroller.scrollTop = fs.el.offsetTop - 8;
  spyHoldUntil = performance.now() + 200;
  if (flash) {
    fs.el.classList.add("flash");
    setTimeout(() => fs.el.classList.remove("flash"), 900);
  }
  return true;
}

// The file whose header is pinned at the top of the scroller.
function currentFile() {
  const top = scroller.getBoundingClientRect().top + 1;
  let last = null;
  for (const el of filesEl.children) {
    if (!el.classList.contains("file")) continue;
    if (el.getBoundingClientRect().bottom > top) return fileStates.get(el.dataset.path) ?? null;
    last = el;
  }
  return last ? (fileStates.get(last.dataset.path) ?? null) : null;
}

let spyTimer = 0;
let spyHoldUntil = 0;
function spy() {
  if (spyTimer) return;
  spyTimer = setTimeout(() => {
    spyTimer = 0;
    const fs = currentFile();
    if (fs) markCurrent(fs.file.path);
  }, 60);
}

// MARK: selection

function selRange() {
  return [Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head)];
}

function paintSelection() {
  for (const el of filesEl.querySelectorAll(".row.selected")) el.classList.remove("selected");
  if (!sel) return;
  const fs = fileStates.get(sel.path);
  if (!fs?.rendered) return;
  const [lo, hi] = selRange();
  for (let i = lo; i <= hi; i++) fs.el.querySelector(`.row[data-row="${i}"]`)?.classList.add("selected");
}

function selRows() {
  const fs = sel && fileStates.get(sel.path);
  return fs ? rowsIn(fs.items, ...selRange()) : null;
}

function selReference() {
  const rows = selRows();
  return rows ? referenceFor(sel.path, rows) : "";
}

function updateSelectionUi() {
  paintSelection();
  const fs = sel && !drag && !composer && fileStates.get(sel.path);
  const first = fs?.rendered && fs.el.querySelector(`.row[data-row="${selRange()[0]}"]`);
  if (!first || !selReference()) {
    selToolbar.hidden = true;
    return;
  }
  const last = fs.el.querySelector(`.row[data-row="${selRange()[1]}"]`);
  const view = scroller.getBoundingClientRect();
  const top = first.getBoundingClientRect().top - view.top + scroller.scrollTop;
  const bottom = last.getBoundingClientRect().bottom - view.top + scroller.scrollTop;
  selToolbar.hidden = false;
  const above = top - selToolbar.offsetHeight - 4;
  selToolbar.style.top = `${above > scroller.scrollTop + 40 ? above : bottom + 4}px`;
}

function clearSelection() {
  if (!sel) return false;
  sel = null;
  updateSelectionUi();
  return true;
}

function rowTarget(target) {
  const row = target?.closest?.(".row[data-row]");
  const section = row?.closest(".file");
  return row && section && !row.classList.contains("hunk") ? { path: section.dataset.path, index: Number(row.dataset.row) } : null;
}

function rowAt(clientY) {
  const view = scroller.getBoundingClientRect();
  const y = Math.max(view.top + 1, Math.min(view.bottom - 1, clientY));
  return rowTarget(document.elementFromPoint(view.left + 60, y));
}

filesEl.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.target.closest("button, input, textarea, label, .thread, .file-header")) return;
  const t = rowTarget(e.target);
  if (!t) return;
  e.preventDefault();
  scroller.focus({ preventScroll: true });
  if (e.shiftKey && sel?.path === t.path) {
    sel.head = t.index;
    updateSelectionUi();
    return;
  }
  drag = { path: t.path, y: e.clientY, raf: 0 };
  sel = { path: t.path, anchor: t.index, head: t.index };
  updateSelectionUi();
  autoScroll();
});

function dragTo(clientY) {
  const t = rowAt(clientY);
  if (t && t.path === drag.path && t.index !== sel.head) {
    sel.head = t.index;
    paintSelection();
  }
}

document.addEventListener("mousemove", (e) => {
  if (!drag) return;
  drag.y = e.clientY;
  dragTo(e.clientY);
});

function autoScroll() {
  if (!drag) return;
  const view = scroller.getBoundingClientRect();
  const delta = drag.y < view.top + 40 ? -18 : drag.y > view.bottom - 24 ? 18 : 0;
  if (delta) {
    scroller.scrollTop += delta;
    dragTo(drag.y);
  }
  drag.raf = requestAnimationFrame(autoScroll);
}

document.addEventListener("mouseup", () => {
  if (!drag) return;
  cancelAnimationFrame(drag.raf);
  drag = null;
  if (sel.anchor === sel.head) [sel.anchor, sel.head] = changeBlockAround(fileStates.get(sel.path).items, sel.anchor);
  updateSelectionUi();
});

scroller.addEventListener("scroll", () => {
  if (performance.now() > spyHoldUntil) spy();
  if (!selToolbar.hidden) updateSelectionUi();
});

// MARK: comments

function openComposer({ editing = null } = {}) {
  commitDraft();
  if (editing) {
    const pin = state.pins.find((p) => p.id === editing);
    const fs = pin && ensureRendered(pin.path);
    if (!fs) return;
    let afterIndex = -1;
    fs.items.forEach((item, i) => {
      if (pinForItem(fs, item)?.id === pin.id) afterIndex = i;
    });
    composer = { path: pin.path, afterIndex, reference: formatPin(pin), note: pin.note, editing, pin, focus: true };
  } else {
    const rows = selRows();
    const pin = rows && pinFromSelection(sel.path, rows, side());
    if (!pin) return toast("Select lines to comment on");
    composer = { path: sel.path, afterIndex: selRange()[1], reference: formatPin(pin), note: "", editing: null, pin, focus: true };
  }
  selToolbar.hidden = true;
  const fs = ensureRendered(composer.path);
  if (fs) renderBody(fs);
  renderReviewActions();
}

function renderComposerFile(path) {
  const fs = path && fileStates.get(path);
  if (fs?.rendered) renderBody(fs);
  updateSelectionUi();
  renderReviewActions();
}

function closeComposer() {
  const path = composer?.path;
  composer = null;
  renderComposerFile(path);
  scroller.focus({ preventScroll: true });
}

function commitDraft() {
  if (!composer) return;
  const note = (filesEl.querySelector(".composer textarea")?.value ?? "").trim();
  const { editing, pin, path } = composer;
  composer = null;
  if (!note) return renderComposerFile(path);
  if (editing) setPins(state.pins.map((p) => (p.id === editing ? { ...p, note } : p)));
  else setPins([...state.pins, { ...pin, note }]);
}

function sendReview() {
  commitDraft();
  if (!state.pins.length) return;
  if (!send({ type: "send", text: reviewMessage(state.pins) })) return;
  setPins([]);
  toast("Review sent to omp");
}

function sendDraftNow() {
  const note = (filesEl.querySelector(".composer textarea")?.value ?? "").trim();
  if (!composer || !note) return;
  const { editing, pin, path } = composer;
  if (!send({ type: "send", text: singleMessage({ ...pin, note }) })) return;
  composer = null;
  sel = null;
  if (editing) setPins(state.pins.filter((p) => p.id !== editing));
  else renderComposerFile(path);
  toast("Sent to omp");
}

function scrollToPin(id) {
  const pin = state.pins.find((p) => p.id === id);
  const fs = pin && ensureRendered(pin.path);
  if (!fs) return;
  pinCursor = id;
  markCurrent(pin.path);
  const thread = fs.el.querySelector(`.thread[data-pin="${CSS.escape(id)}"]`);
  if (!thread) return;
  thread.scrollIntoView({ block: "center" });
  thread.classList.add("flash");
  setTimeout(() => thread.classList.remove("flash"), 1200);
}

function stepPin(direction) {
  const order = new Map(orderedFiles().map((f, i) => [f.path, i]));
  const key = (p) => [order.get(p.path), p.startLine ?? 0];
  const pins = state.pins.filter((p) => p.side === side() && order.has(p.path)).sort((a, b) => {
    const [fa, la] = key(a);
    const [fb, lb] = key(b);
    return fa - fb || la - lb;
  });
  if (!pins.length) return;
  let idx = pins.findIndex((p) => p.id === pinCursor && p.path === state.selected);
  if (idx < 0) {
    const here = order.get(state.selected) ?? -1;
    if (direction > 0) {
      const first = pins.findIndex((p) => key(p)[0] >= here);
      idx = (first < 0 ? pins.length : first) - 1;
    } else {
      idx = pins.findLastIndex((p) => key(p)[0] <= here) + 1;
    }
  }
  scrollToPin(pins[(idx + direction + pins.length) % pins.length].id);
}

// MARK: navigation

function changePositions() {
  const out = [];
  for (const file of orderedFiles()) {
    const fs = fileStates.get(file.path);
    if (!fs || isCollapsed(file.path) || isDeferred(fs)) continue;
    for (const start of blockStarts(fs.items)) out.push({ path: file.path, index: start });
  }
  return out;
}

function currentPosition() {
  if (sel) return { path: sel.path, index: selRange()[0] };
  const fs = currentFile();
  if (!fs) return null;
  const top = scroller.getBoundingClientRect().top + 40;
  const rows = fs.rendered ? [...fs.el.querySelectorAll(".row[data-row]")] : [];
  const row = rows.find((r) => r.getBoundingClientRect().bottom > top);
  return { path: fs.file.path, index: row ? Number(row.dataset.row) - 1 : -1 };
}

function jumpChange(direction) {
  const all = changePositions();
  if (!all.length) return;
  const here = currentPosition();
  const order = new Map(orderedFiles().map((f, i) => [f.path, i]));
  const cmp = (a, b) => order.get(a.path) - order.get(b.path) || a.index - b.index;
  const target = !here
    ? direction > 0
      ? all[0]
      : all.at(-1)
    : direction > 0
      ? (all.find((p) => cmp(p, here) > 0) ?? all[0])
      : (all.findLast((p) => cmp(p, here) < 0) ?? all.at(-1));
  const fs = ensureRendered(target.path);
  const [lo, hi] = changeBlockAround(fs.items, target.index);
  sel = { path: target.path, anchor: lo, head: hi };
  paintSelection();
  fs.el.querySelector(`.row[data-row="${lo}"]`)?.scrollIntoView({ block: "center" });
  markCurrent(target.path);
  updateSelectionUi();
}

function nextUnviewed(path) {
  const files = orderedFiles();
  const idx = files.findIndex((f) => f.path === path);
  const unviewed = (f) => f.path !== path && !state.viewed[viewedKey(f.path)];
  return files.slice(idx + 1).find(unviewed) ?? files.slice(0, Math.max(idx, 0)).find(unviewed);
}

function toggleViewed(path, viewed) {
  const fs = fileStates.get(path);
  const pinned = fs && fs.el.getBoundingClientRect().top < scroller.getBoundingClientRect().top;
  if (viewed && sel?.path === path) sel = null;
  if (viewed && composer?.path === path) commitDraft();
  setViewed(path, viewed);
  if (viewed && pinned) scroller.scrollTop = fs.el.offsetTop - 8;
}

function toggleCollapsed(path) {
  if (isCollapsed(path)) {
    state.collapsed.delete(path);
    state.expanded.add(path);
  } else {
    state.collapsed.add(path);
    state.expanded.delete(path);
    if (sel?.path === path) sel = null;
  }
  const fs = fileStates.get(path);
  const pinned = fs && fs.el.getBoundingClientRect().top < scroller.getBoundingClientRect().top;
  syncCollapsed();
  if (pinned) scroller.scrollTop = fs.el.offsetTop - 8;
}

// MARK: pickers

async function pickBase(anchor) {
  const names = await api("/api/branches").catch((error) => toast(`Couldn't list branches: ${error.message}`));
  if (!names) return;
  const items = [{ id: "__auto__", label: "Automatic", subtitle: "where this branch forked" }, ...names.filter((n) => n !== state.branch).map((n) => ({ id: n, label: n }))];
  openMenu(anchor, items, (id) => setCompare({ kind: "branch", base: id === "__auto__" ? null : id }), { search: "Compare against… (any ref)" });
}

async function pickCommit(anchor) {
  const commits = await api("/api/commits").catch((error) => toast(`Couldn't list commits: ${error.message}`));
  if (!commits) return;
  const items = commits.map((c) => ({ id: c.sha, label: `${c.short}  ${c.subject}`, subtitle: relative(c.date) }));
  openMenu(anchor, items, (sha) => setCompare({ kind: "commit", sha }), { search: "Find a commit…" });
}

function pickFontSize(anchor) {
  const terminal = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-size"));
  const items = [
    { id: "terminal", size: null, label: terminal ? "Terminal" : "Default", subtitle: terminal ? String(terminal) : null },
    ...FONT_SIZES.map((size) => ({ id: String(size), size, label: String(size) })),
  ].map((it) => ({ ...it, icon: it.size === state.fontSize ? icon("check", 13) : '<svg class="icon" width="13" height="13"></svg>' }));
  openMenu(anchor, items, (id) => {
    state.fontSize = id === "terminal" ? null : Number(id);
    savePrefs();
    syncFontSize();
  });
}

function pickViewOptions(anchor) {
  openMenu(anchor, [
    { id: "wrap", label: "Wrap long lines", icon: state.wrap ? icon("check", 13) : icon("wrap", 13) },
    { id: "whitespace", label: "Ignore whitespace", icon: state.ignoreWhitespace ? icon("check", 13) : icon("whitespace", 13) },
    { id: "syntax-colors", label: "Use omp syntax colors", icon: state.syntaxColors ? icon("check", 13) : null },
    { id: "font-size", label: "Text size", icon: icon("textSize", 13) },
    { id: "prev-file", label: "Previous file", subtitle: "k" },
    { id: "next-file", label: "Next file", subtitle: "j" },
  ], (id) => {
    if (id === "font-size") pickFontSize(anchor);
    else if (id === "prev-file" || id === "next-file") stepFile(id === "prev-file" ? -1 : 1);
    else {
      if (id === "wrap") state.wrap = !state.wrap;
      else if (id === "syntax-colors") state.syntaxColors = !state.syntaxColors;
      else state.ignoreWhitespace = !state.ignoreWhitespace;
      savePrefs();
      renderToolbar();
      updateSelectionUi();
      if (id === "whitespace") refresh();
      if (id === "syntax-colors") app.classList.toggle("default-syntax", !state.syntaxColors);
    }
  });
}

async function expandGap(fs, gap, dir) {
  if (!fs.lines) {
    const sig = fs.sig;
    const lines = await api("/api/lines", { ...compareQuery(), path: fs.file.path }).catch((error) => toast(`Couldn't read ${fs.file.path}: ${error.message}`));
    if (!lines || fs.sig !== sig) return;
    fs.lines = lines;
  }
  const bounded = Number.isFinite(gap.to) ? gap : { ...gap, to: fs.lines.length };
  if (bounded.from <= bounded.to) fs.revealed.push(revealRange(bounded, dir));
  if (composer?.path === fs.file.path && composer.editing == null) commitDraft();
  if (sel?.path === fs.file.path) sel = null;
  setRows(fs);
  renderBody(fs);
  updateSelectionUi();
  refreshFind();
}

// MARK: find

const findBar = app.querySelector(".findbar");
const findInput = findBar.querySelector(".find-input");
const find = { query: "", matches: [], current: -1 };
let findFrame = 0;

function itemTexts(item) {
  if ("kind" in item) return item.kind === "hunk" ? [] : [item.kind === "deletion" ? item.oldText : item.newText];
  if (item.hunk) return [];
  return item.left === item.right ? [item.right?.newText] : [item.left?.oldText, item.right?.newText];
}

// Smart case: lowercase queries match case-insensitively.
function findNeedle() {
  const q = findBar.hidden ? "" : find.query;
  return q ? { q, ci: q === q.toLowerCase() } : null;
}

const hasNeedle = (text, n) => text != null && (n.ci ? text.toLowerCase() : text).includes(n.q);

function computeFind({ fromView = false } = {}) {
  const prev = find.matches[find.current];
  const n = findNeedle();
  find.matches = [];
  if (n) {
    for (const file of orderedFiles()) {
      const fs = fileStates.get(file.path);
      fs?.items.forEach((item, index) => {
        if (itemTexts(item).some((t) => hasNeedle(t, n))) find.matches.push({ path: file.path, index });
      });
    }
  }
  const order = new Map(orderedFiles().map((f, i) => [f.path, i]));
  const anchor = fromView ? { path: currentFile()?.file.path, index: 0 } : prev;
  find.current = !find.matches.length ? -1 : anchor?.path ? find.matches.findIndex((m) => order.get(m.path) > order.get(anchor.path) || (m.path === anchor.path && m.index >= anchor.index)) : 0;
  if (find.matches.length && find.current < 0) find.current = 0;
  renderFindCount();
  scheduleFindPaint();
}

function refreshFind() {
  if (find.query && !findBar.hidden) computeFind();
}

function renderFindCount() {
  const el = findBar.querySelector(".find-count");
  el.textContent = !find.query ? "" : find.matches.length ? `${find.current + 1}/${find.matches.length}` : "No results";
  findBar.classList.toggle("no-results", Boolean(find.query) && !find.matches.length);
}

function revealMatch() {
  const m = find.matches[find.current];
  if (!m) return;
  state.loadedLarge.add(m.path);
  const fs = ensureRendered(m.path);
  fs?.el.querySelector(`.row[data-row="${m.index}"]`)?.scrollIntoView({ block: "center" });
  markCurrent(m.path);
  renderFindCount();
  scheduleFindPaint();
}

function stepFind(step) {
  if (!find.matches.length) return;
  find.current = (Math.max(find.current, step > 0 ? -1 : 0) + step + find.matches.length) % find.matches.length;
  revealMatch();
}

function openFind() {
  findBar.hidden = false;
  app.querySelector('[data-act="find"]').hidden = true;
  const picked = String(getSelection() ?? "").trim();
  if (picked && !picked.includes("\n")) findInput.value = picked;
  findInput.focus();
  findInput.select();
  if (findInput.value !== find.query || !find.matches.length) {
    find.query = findInput.value;
    computeFind({ fromView: true });
    revealMatch();
  }
}

function closeFind() {
  findBar.hidden = true;
  app.querySelector('[data-act="find"]').hidden = false;
  paintFind();
  scroller.focus({ preventScroll: true });
}

function rangesIn(el, n) {
  const nodes = [];
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  const hay = n.ci ? text.toLowerCase() : text;
  const at = (pos) => {
    let k = nodes.length - 1;
    while (k > 0 && nodes[k].start > pos) k--;
    return [nodes[k].node, pos - nodes[k].start];
  };
  const out = [];
  for (let i = hay.indexOf(n.q); i >= 0 && n.q; i = hay.indexOf(n.q, i + n.q.length)) {
    const range = new Range();
    range.setStart(...at(i));
    range.setEnd(...at(i + n.q.length));
    out.push(range);
  }
  return out;
}

function scheduleFindPaint() {
  cancelAnimationFrame(findFrame);
  findFrame = requestAnimationFrame(paintFind);
}

function paintFind() {
  for (const el of filesEl.querySelectorAll(".row.find-current")) el.classList.remove("find-current");
  const n = findNeedle();
  const current = find.matches[find.current];
  const currentRow = n && current ? fileStates.get(current.path)?.el.querySelector(`.row[data-row="${current.index}"]`) : null;
  currentRow?.classList.add("find-current");
  if (!("highlights" in CSS)) return;
  if (!n) {
    CSS.highlights.delete("find");
    CSS.highlights.delete("find-current");
    return;
  }
  const all = [];
  const now = [];
  for (const fs of fileStates.values()) {
    if (!fs.rendered) continue;
    for (const code of fs.el.querySelectorAll(".row:not(.hunk) .code")) {
      for (const range of rangesIn(code, n)) (code.closest(".row") === currentRow ? now : all).push(range);
    }
  }
  CSS.highlights.set("find", new Highlight(...all));
  CSS.highlights.set("find-current", new Highlight(...now));
}

findInput.addEventListener("input", () => {
  find.query = findInput.value;
  computeFind({ fromView: true });
  revealMatch();
});

findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});

window.addEventListener(
  "keydown",
  (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "f" && !e.shiftKey) openFind();
    else if (key === "g" && find.query && !findBar.hidden) stepFind(e.shiftKey ? -1 : 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  },
  { capture: true },
);

async function openInMenu(anchor, path) {
  const targets = await api("/api/open-targets").catch((error) => toast(`Couldn't list editors: ${error.message}`));
  if (!targets) return;
  const i = targets.findIndex((t) => t.id === state.openIn);
  if (i > 0) targets.unshift(...targets.splice(i, 1));
  const rows = sel?.path === path ? selRows() : fileStates.get(path)?.rows;
  const line = rows?.find((r) => r.kind === "addition" && r.newLineNumber != null)?.newLineNumber ?? rows?.find((r) => r.newLineNumber != null)?.newLineNumber;
  openMenu(anchor, targets, (id) => {
    state.openIn = id;
    savePrefs();
    api("/api/open", { path, target: id, line: String(line ?? "") }).catch((error) => toast(`Open failed: ${error.message}`));
  });
}

// MARK: events

app.addEventListener("click", async (e) => {
  const dirRow = e.target.closest(".dir-row");
  if (dirRow) {
    const dir = dirRow.dataset.dir;
    if (!state.collapsedDirs.delete(dir)) state.collapsedDirs.add(dir);
    renderList();
    list.querySelector(`[data-dir="${CSS.escape(dir)}"]`)?.focus();
    return;
  }
  const fileRowEl = e.target.closest(".file-row");
  if (fileRowEl) {
    select(fileRowEl.dataset.path, { focusList: true });
    return;
  }
  const actEl = e.target.closest("[data-act]");
  const act = actEl?.dataset.act;
  const header = e.target.closest(".file-header");
  if (!act && header && !e.target.closest("label")) {
    toggleCollapsed(header.closest(".file").dataset.path);
    return;
  }
  if (!act) return;
  const path = actEl.closest(".file")?.dataset.path;
  const pinId = actEl.closest("[data-pin]")?.dataset.pin;
  switch (act) {
    case "compare":
      {
        const kind = actEl.dataset.kind;
        if (kind !== state.compare.kind) setCompare(kind === "branch" ? { kind, base: null } : kind === "commit" ? { kind, sha: null } : { kind });
      }
      break;
    case "git-init":
      send({ type: "init" });
      break;
    case "refresh":
      refresh();
      break;
    case "sidebar":
      toggleSidebar();
      break;
    case "tree":
      state.tree = !state.tree;
      savePrefs();
      renderSidebar();
      renderFiles();
      break;
    case "base":
      pickBase(actEl);
      break;
    case "commit":
      pickCommit(actEl);
      break;
    case "prev-change":
      jumpChange(-1);
      break;
    case "next-change":
      jumpChange(1);
      break;
    case "layout":
      commitDraft();
      state.layout = state.layout === "split" ? "unified" : "split";
      sel = null;
      for (const fs of fileStates.values()) {
        fs.items = itemsFor(fs.rows);
        if (fs.rendered) renderBody(fs);
        else placeholder(fs);
      }
      savePrefs();
      renderToolbar();
      updateSelectionUi();
      refreshFind();
      break;
    case "view-options":
      pickViewOptions(actEl);
      break;
    case "load-diff":
      if (path) {
        state.loadedLarge.add(path);
        renderBody(fileStates.get(path));
      }
      break;
    case "copy-path":
      if (path) toast((await copyText(path)) ? `Copied ${path}` : "Copy failed");
      break;
    case "find":
      openFind();
      break;
    case "find-next":
      stepFind(1);
      break;
    case "find-prev":
      stepFind(-1);
      break;
    case "find-close":
      closeFind();
      break;
    case "open-in":
      if (path) openInMenu(actEl, path);
      break;
    case "expand": {
      const fs = path && fileStates.get(path);
      const item = fs?.items[Number(actEl.closest(".row")?.dataset.row)];
      const gap = item && ("kind" in item ? item : item.hunk)?.gap;
      if (gap) expandGap(fs, gap, actEl.dataset.dir);
      break;
    }
    case "comment-line": {
      const t = rowTarget(e.target);
      if (t) {
        sel = { path: t.path, anchor: t.index, head: t.index };
        openComposer();
      }
      break;
    }
    case "comment-selection":
      openComposer();
      break;
    case "paste-selection": {
      const ref = selReference();
      if (ref && send({ type: "paste", text: `${ref} ` })) toast(`Added ${ref} to the omp prompt`);
      break;
    }
    case "copy-selection": {
      const ref = selReference();
      if (ref) toast((await copyText(ref)) ? `Copied ${ref}` : "Copy failed");
      break;
    }
    case "cancel-composer":
      closeComposer();
      break;
    case "edit-pin":
      openComposer({ editing: pinId });
      break;
    case "delete-pin":
      setPins(state.pins.filter((p) => p.id !== pinId));
      break;
    case "send-review":
      sendReview();
      break;
    case "review-menu":
      commitDraft();
      openMenu(
        app.querySelector('.review-actions [data-act="review-menu"]'),
        [
          { id: "paste", label: "Add review to prompt", icon: icon("arrowRight", 13) },
          { id: "copy", label: "Copy review", icon: icon("copy", 13) },
          { id: "clear", label: "Clear all comments", icon: icon("trash", 13), danger: true },
        ],
        async (id) => {
          const text = reviewMessage(state.pins);
          if (id === "paste" && send({ type: "paste", text })) toast("Review added to the omp prompt");
          else if (id === "copy") toast((await copyText(text)) ? "Review copied" : "Copy failed");
          else if (id === "clear") setPins([]);
        },
      );
      break;
  }
});

app.addEventListener("input", (e) => {
  if (e.target.matches(".composer textarea")) renderReviewActions();
});

app.addEventListener("change", (e) => {
  const path = e.target.closest(".file")?.dataset.path;
  if (e.target.dataset.act === "viewed" && path) toggleViewed(path, e.target.checked);
});

filterInput.addEventListener("input", () => {
  state.filter = filterInput.value;
  renderList();
  renderFiles();
});

filterInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && filterInput.value) {
    e.preventDefault();
    filterInput.value = "";
    state.filter = "";
    renderList();
    renderFiles();
  } else if (e.key === "ArrowDown" || e.key === "Enter") {
    const first = orderedFiles()[0];
    if (!first) return;
    e.preventDefault();
    select(first.path, { focusList: true });
  }
});

list.addEventListener("keydown", (e) => {
  const navs = [...list.querySelectorAll(".nav")];
  const at = navs.indexOf(document.activeElement);
  const current = navs[at];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = navs[Math.max(0, Math.min(navs.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next?.dataset.path) select(next.dataset.path, { focusList: true });
    else next?.focus();
  } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && current?.dataset.dir) {
    e.preventDefault();
    const dir = current.dataset.dir;
    if (e.key === "ArrowLeft") state.collapsedDirs.add(dir);
    else state.collapsedDirs.delete(dir);
    renderList();
    list.querySelector(`[data-dir="${CSS.escape(dir)}"]`)?.focus();
  } else if (e.key === "Enter" && current?.dataset.dir) {
    e.preventDefault();
    current.click();
  }
});

app.addEventListener("keydown", (e) => {
  const ta = e.target.closest?.(".composer textarea");
  if (!ta) return;
  e.stopPropagation();
  if (e.key === "Escape") {
    e.preventDefault();
    commitDraft();
    closeComposer();
  } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (e.altKey) sendDraftNow();
    else sendReview();
  }
});

window.addEventListener(
  "keydown",
  (e) => {
    if (e.code !== "Backslash" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    toggleSidebar();
  },
  { capture: true },
);

document.addEventListener("keydown", (e) => {
  if (isTextField(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "j" || e.key === "k") {
    stepFile(e.key === "j" ? 1 : -1);
  } else if (e.key === "]" || e.key === "[") {
    e.preventDefault();
    jumpChange(e.key === "]" ? 1 : -1);
  } else if (e.key === "n" || e.key === "N") {
    stepPin(e.key === "n" ? 1 : -1);
  } else if (e.key === "b") {
    toggleSidebar();
  } else if (e.key === "u") {
    select(nextUnviewed(state.selected)?.path);
  } else if (e.key === "v" && state.selected && fileStates.has(state.selected)) {
    toggleViewed(state.selected, !state.viewed[viewedKey(state.selected)]);
  } else if (e.key === "c" && sel) {
    e.preventDefault();
    openComposer();
  } else if (e.key === "r") {
    refresh();
  } else if (e.key === "/") {
    e.preventDefault();
    if (state.sidebarHidden) toggleSidebar();
    filterInput.focus();
  } else if (e.key === "Escape" && clearSelection()) {
    e.preventDefault();
  }
});

document.addEventListener("copy", (e) => {
  if (isTextField(document.activeElement)) return;
  const ref = selReference();
  if (!ref) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", ref);
  toast(`Copied ${ref}`);
});

const resizer = app.querySelector(".resizer");
resizer.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = app.querySelector(".sidebar").getBoundingClientRect().width;
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add("dragging");
  const move = (ev) => {
    state.sidebarWidth = Math.max(200, Math.min(window.innerWidth * 0.6, startWidth + startX - ev.clientX));
    app.style.setProperty("--sidebar-w", `${state.sidebarWidth}px`);
    updateSelectionUi();
  };
  const finish = () => {
    resizer.classList.remove("dragging");
    resizer.removeEventListener("pointermove", move);
    resizer.removeEventListener("lostpointercapture", finish);
    savePrefs();
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("lostpointercapture", finish);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && dirty) {
    dirty = false;
    scheduleRefresh(50);
  }
});
window.addEventListener("focus", () => scheduleRefresh(50));
window.addEventListener("resize", () => updateSelectionUi());

document.getElementById("appearance").addEventListener("load", syncFontSize);
syncFontSize();
renderSidebar();
renderFiles();
connect();
refresh();
