"use strict";
// MARK: live workbench
const WB_PREVIEWS = 4, WB_CONCURRENCY = 2, WB_INTERVAL = 3000, WB_LINES = 22, WB_TEXT = 600, WB_DONE = 6;
const wb = { root: null, tiles: new Map(), order: new Map(), seq: 0, scope: null, previews: [], screens: new Map(), failed: new Map(), inflight: new Map(), queue: [], timer: null };

const wbClip = (text, max = WB_TEXT) => { const s = String(text ?? "").trim(); return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s; };
const wbLines = (text, n) => String(text ?? "").split("\n").slice(-n).map(l => l.length > 240 ? l.slice(0, 239) + "…" : l).join("\n");
const WB_BYTE = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const WB_COLOR = new RegExp(`^(?:#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\\(\\s*${WB_BYTE}\\s*,\\s*${WB_BYTE}\\s*,\\s*${WB_BYTE}\\s*\\))$`, "i");
const WB_FLAGS = ["bold", "dim", "italic", "underline", "strike", "inverse"];
function wbRun(r) {
  const text = typeof r?.text === "string" ? r.text.replace(/[\x00-\x1f\x7f-\x9f]/g, "") : "";
  if (!text) return null;
  const run = { text };
  for (const k of ["fg", "bg"]) if (typeof r[k] === "string" && WB_COLOR.test(r[k])) run[k] = r[k];
  for (const k of WB_FLAGS) if (r[k] === true) run[k] = true;
  return run;
}
function wbRows(rows, n) {
  if (!Array.isArray(rows) || !rows.every(Array.isArray)) return null;
  return rows.slice(-n).map(row => {
    const runs = row.map(wbRun).filter(Boolean);
    if (runs.reduce((len, r) => len + r.text.length, 0) <= 240) return runs;
    const out = [];
    let left = 239;
    for (const r of runs) {
      if (r.text.length >= left) { out.push({ ...r, text: r.text.slice(0, left) + "…" }); break; }
      out.push(r);
      left -= r.text.length;
    }
    return out;
  });
}
function wbScreen(data) {
  const rows = wbRows(data?.rows, WB_LINES);
  if (rows) return { key: "r" + JSON.stringify(rows), rows };
  const text = wbLines(data?.text ?? "", WB_LINES);
  return { key: "t" + text, text };
}
function wbRunEl(r) {
  if (Object.keys(r).length === 1) return document.createTextNode(r.text);
  let fg = r.fg, bg = r.bg;
  if (r.inverse) [fg, bg] = [bg ?? "var(--bg)", fg ?? "var(--fg)"];
  const el = document.createElement("span"), s = el.style;
  el.textContent = r.text;
  if (fg) s.color = fg;
  if (bg) s.backgroundColor = bg;
  if (r.bold) s.fontWeight = "700";
  if (r.dim) s.opacity = "0.6";
  if (r.italic) s.fontStyle = "italic";
  const deco = [r.underline && "underline", r.strike && "line-through"].filter(Boolean);
  if (deco.length) s.textDecorationLine = deco.join(" ");
  return el;
}
function wbPaint(term, view) {
  if (!view.rows) { term.textContent = view.text; return; }
  const nodes = [];
  view.rows.forEach((row, i) => {
    if (i) nodes.push(document.createTextNode("\n"));
    for (const r of row) nodes.push(wbRunEl(r));
  });
  term.replaceChildren(...nodes);
}
const wbRunning = t => !t.health?.worktreeMissing && t.execution?.kind === "managed" && t.execution.state === "running";
const wbExecutionKey = t => JSON.stringify([t?.execution, t?.session?.id]);

function wbKind(t) {
  if (t.health?.worktreeMissing) return "handoff";
  if (t.spawn.state === "failed") return "handoff";
  if (t.spawn.state === "running") return "active";
  if (t.column === "done") return "done";
  const s = t.agent?.state;
  if (!t.paused && (s === "needs_input" || s === "plan_ready" || s === "disconnected")) return "handoff";
  if (t.column === "review") return "handoff";
  if (!t.worktree) {
    if (t.column === "todo") return "queued";
    if (t.column === "backlog" && !t.paused && t.spawn.state === "none" && !t.blockedBy.length) return "ready";
    return null;
  }
  return "active";
}
function wbHandoff(t) {
  if (t.health?.worktreeMissing) return { tone: "err", icon: "alert", label: "Worktree missing" };
  if (t.spawn.state === "failed") return { tone: "err", icon: "alert", label: "Start failed" };
  const s = t.agent?.state;
  if (s === "needs_input") return { tone: "needs", icon: "hand", label: "Needs your answer" };
  if (s === "plan_ready") return { tone: "needs", icon: "file", label: "Plan ready for review" };
  if (s === "disconnected") return { tone: "needs", icon: "alert", label: "Session disconnected" };
  if (t.merge === "local" && !t.pr) return { tone: "ok", icon: "merge", label: "Ready to merge" };
  return { tone: "ok", icon: "pr", label: "Ready for review" };
}
function wbRank(t) {
  const s = t.agent?.state;
  if (t.health?.worktreeMissing || s === "needs_input" || s === "plan_ready" || t.spawn.state === "failed") return 0;
  if (wbKind(t) === "handoff") return 1;
  if (t.spawn.state === "running" || AGENT_LABEL[s]) return 2;
  return 3;
}

// MARK: actions
function wbWith(id, fn) { openPanel(id); fn(); }
function wbActions(t, kind) {
  const out = [], s = t.agent?.state, cur = () => findTask(t.id) || t;
  const btn = (label, icon, onclick, primary = false, title = null, disabled = false) =>
    h("button", { class: "btn sm" + (primary ? " primary" : ""), title, disabled, onclick: e => { e.stopPropagation(); onclick(); } }, I(icon, 11), label);
  if (t.health?.worktreeMissing) out.push(btn("Return to Backlog", "refresh", () => confirmRecover(cur()), true));
  else if (t.spawn.state === "failed") out.push(btn("Retry start", "play", () => requestMove(t.id, "todo"), true));
  else if (s === "plan_ready" && t.worktree) out.push(btn("Review plan", "file", () => showPlanReview(cur()), true));
  else if (s === "needs_input" && t.worktree) out.push(btn("Answer in terminal", "terminal", () => wbWith(t.id, openWorkspace), true, "The board can't answer this prompt; it opens the agent's terminal"));
  else if (s === "disconnected" && t.worktree) out.push(btn("Connect terminal", "terminal", () => wbWith(t.id, openWorkspace), true));
  else if (kind === "handoff" && t.worktree && t.merge === "local" && t.git?.commits > 0 && t.column !== "done")
    out.push(btn("Merge into " + t.base, "merge", () => showMergeModal(cur()), true, t.git.dirty > 0 ? "Commit the uncommitted changes first" : "git merge --no-ff into " + t.base, t.git.dirty > 0));
  if (!t.health?.worktreeMissing && t.worktree && kind === "active" && (sessionConnected(t) || wbRunning(t))) out.push(btn("Terminal", "terminal", () => wbWith(t.id, openWorkspace), false, "Connect to the agent terminal"));
  if (!t.health?.worktreeMissing && t.worktree) out.push(btn("Open worktree", "openIn", () => wbWith(t.id, openWorktree)));
  if (t.pr) out.push(prChip(t.pr));
  return out;
}

// MARK: tiles
function wbStateEl(t) {
  if (wbKind(t) === "handoff") {
    const handoff = wbHandoff(t);
    return stateEl({ tone: handoff.tone, icon: handoff.icon, text: handoff.label, since: t.agent?.since });
  }
  const info = statusOf(t);
  return info ? stateEl({ ...info, spin: false, dot: info.spin || info.dot }) : h("span", { class: "state faint" }, colTitle(t.column));
}
function wbBody(t, kind) {
  const parts = [], s = t.agent?.state;
  parts.push(h("header", { class: "wb-task-header" }, h("span", { class: "wb-task-id" }, taskNumber(t.id)),
    h("strong", { class: "wb-title", title: t.title || "" }, t.title || "Untitled")));
  const head = h("div", { class: "wb-head" }, h("span", { class: "wb-col", "data-col": t.column }, colTitle(t.column)), wbStateEl(t), h("span", { class: "spacer" }));
  if (t.git && (t.git.added || t.git.removed)) head.append(diffstat(t.git));
  if (t.git?.dirty > 0) head.append(h("span", { class: "udot", title: plural(t.git.dirty, "uncommitted file") }));
  parts.push(head);
  const step = t.agent && (AGENT_LABEL[s] || s === "needs_input") ? t.agent.step : null;
  if (step) parts.push(h("div", { class: "wb-step", title: step }, I(s === "needs_input" ? "hand" : "wrench", 12), h("span", {}, wbClip(step, 200))));
  if (t.spawn.state === "failed") {
    if (t.spawn.error) parts.push(h("div", { class: "wb-msg err" }, I("alert", 12), h("span", {}, wbClip(t.spawn.error))));
    if (t.spawn.log) parts.push(h("pre", { class: "wb-log" }, wbLines(t.spawn.log, 8)));
  } else if (t.spawn.state === "running") {
    parts.push(h("div", { class: "wb-note" }, "Creating the worktree and starting omp"));
    if (t.spawn.log) parts.push(h("pre", { class: "wb-log" }, wbLines(t.spawn.log, 6)));
  }
  if (t.agent?.message && t.agent.message.trim() !== String(step ?? "").trim()) parts.push(h("div", { class: "wb-msg" }, I("message", 12), h("span", {}, wbClip(t.agent.message))));
  if (s === "plan_ready" && t.plan) parts.push(h("div", { class: "wb-plan" }, h("div", { class: "wb-label" }, "Proposed plan"), h("div", { class: "wb-plan-text" }, wbClip(t.plan, 900))));
  if (s === "needs_input") parts.push(h("div", { class: "wb-note" }, "Answer in the agent's terminal; the board can't reply to this prompt."));
  return parts;
}
function wbTerminalNote(t) {
  if (!t.worktree || t.spawn.state !== "done" && t.spawn.state !== "none") return null;
  const ex = t.execution;
  if (!ex) return null;
  if (ex.kind === "legacy") return "Runs in a terminal the board doesn't manage; its screen shows only there.";
  if (!wbRunning(t)) return ex.exitCode != null ? `Agent host exited (code ${ex.exitCode}). The screen no longer updates.` : "Agent host stopped. The screen no longer updates.";
  return null;
}
function wbTile(t) {
  const term = h("pre", { class: "wb-term", "aria-label": "Agent terminal (read-only)" });
  const termLabel = h("span", {});
  const termWrap = h("div", { class: "wb-term-wrap", hidden: true }, h("div", { class: "wb-label" }, I("terminal", 11), termLabel), term);
  const top = h("div", { class: "wb-top" }), foot = h("div", { class: "wb-foot" });
  const tile = h("article", { class: "workbench-tile", "data-id": t.id, tabindex: "0",
    onclick: e => { if (!e.target.closest("button,a")) openPanel(t.id); },
    onkeydown: e => { if (e.key === "Enter" && e.target === tile) openPanel(t.id); } }, top, termWrap, foot);
  tile.wb = { top, foot, term, termWrap, termLabel };
  return tile;
}
function wbUpdateTile(tile, t, kind, preview) {
  const p = tile.wb;
  tile.dataset.kind = kind;
  const key = JSON.stringify([kind, t.title, t.column, t.agent, t.spawn, t.plan && t.agent?.state === "plan_ready" ? t.plan : null, t.git, t.pr, t.paused, t.blockedBy, t.waitingForSlot, t.merge, t.base, t.worktree, t.execution, t.session?.connected, t.merged, t.health]);
  if (tile.dataset.content !== key) {
    tile.dataset.content = key;
    p.top.replaceChildren(...wbBody(t, kind));
  }
  const actionsKey = JSON.stringify([kind, t.agent?.state, t.spawn.state, t.worktree, t.merge, t.base, t.git?.commits, t.git?.dirty, t.pr, t.execution, t.session?.connected, t.health]);
  if (tile.dataset.actions !== actionsKey) {
    tile.dataset.actions = actionsKey;
    p.foot.replaceChildren(...wbActions(t, kind));
  }
  const s = t.agent?.state;
  tile.classList.toggle("needs", kind === "handoff" && (s === "needs_input" || s === "plan_ready" || s === "disconnected"));
  tile.classList.toggle("failed", t.spawn.state === "failed" || !!t.health?.worktreeMissing);
  tile.classList.toggle("busy", !t.paused && (t.spawn.state === "running" || !!AGENT_LABEL[s]));
  tile.classList.toggle("quiet", t.paused || s === "stopped");
  tile.classList.toggle("sel", t.id === openId);
  const screen = wb.screens.get(t.id), note = wbTerminalNote(t), failure = wb.failed.get(t.id);
  const live = preview && wbRunning(t);
  let label = null, view = null;
  if (live && failure) { label = "Terminal unavailable"; view = { key: "e" + failure.message, text: failure.message }; }
  else if (live) { label = "Terminal · live, read-only"; view = screen ?? { key: "t", text: "" }; }
  else if (screen != null && note) { label = "Last screen · " + note; view = screen; }
  else if (note) { label = note; }
  else if (wbRunning(t) && kind !== "done") { label = `Terminal preview shows ${WB_PREVIEWS} tiles at a time; click this task to see its terminal`; }
  p.termWrap.hidden = label == null;
  p.termWrap.classList.toggle("ended", !live);
  p.termWrap.classList.toggle("loading", live && screen == null && !failure);
  if (p.termLabel.textContent !== (label || "")) p.termLabel.textContent = label || "";
  p.term.hidden = view == null;
  if (view && p.termKey !== view.key) { p.termKey = view.key; wbPaint(p.term, view); p.term.scrollTop = p.term.scrollHeight; }
}
function wbRow(t) {
  const ready = wbKind(t) === "ready";
  const info = ready ? null : statusOf(t);
  const row = h(ready ? "div" : "button", { class: "workbench-tile wb-row" + (t.id === openId ? " sel" : ""), "data-id": t.id,
    tabindex: ready ? "0" : null,
    onclick: e => { if (!e.target.closest("[data-start-task]")) openPanel(t.id); },
    onkeydown: e => { if (ready && e.target === row && e.key === "Enter") openPanel(t.id); } },
    h("span", { class: "wb-id" }, taskNumber(t.id)), h("span", { class: "wb-row-title" }, t.title || "Untitled"),
    ready ? null : info ? stateEl({ ...info, spin: false, dot: info.spin || info.dot }) : h("span", { class: "state faint" }, colTitle(t.column)));
  if (ready) row.append(h("button", { class: "btn sm", "data-start-task": t.id,
    title: wb.readyAvailable ? "Start this task" : "Queue this task until an agent slot is free",
    onclick: e => { e.stopPropagation(); requestMove(t.id, "todo"); } }, I("play", 11), "Start"));
  row.dataset.kind = ready ? "ready" : t.column === "done" ? "done" : "queued";
  return row;
}

// MARK: render
function wbInit() {
  wb.summary = h("div", { class: "wb-summary" });
  wb.ready = h("section", { class: "wb-quiet" });
  wb.work = h("section", { class: "wb-work" });
  wb.workHead = h("div", { class: "wb-quiet-h" });
  wb.grid = h("div", { class: "wb-grid" });
  wb.work.append(wb.workHead, wb.grid);
  wb.empty = h("div", { class: "wb-empty" });
  wb.queued = h("section", { class: "wb-quiet" });
  wb.done = h("section", { class: "wb-quiet" });
  wb.root = h("div", { class: "workbench", "aria-label": "Live agent workbench" }, wb.summary, wb.ready, wb.empty, wb.work, wb.queued, wb.done);
}
function renderWorkbench() {
  if (!board || boardView !== "live") return;
  if (!wb.root) wbInit();
  const host = $("#board");
  if (wb.root.parentNode !== host) host.replaceChildren(wb.root);
  if (wb.scope !== flowSel) { wb.scope = flowSel; wb.order.clear(); wb.seq = 0; }
  const scoped = board.tasks.filter(inFlow), shown = scoped.filter(matches);
  const groups = { handoff: [], active: [], ready: [], queued: [], done: [] };
  for (const t of shown) { const k = wbKind(t); if (k) groups[k].push(t); }
  const limit = selectedFlow()?.concurrencyLimit;
  const active = scoped.filter(t => (t.column === "doing" && t.worktree) || t.spawn.state === "running").length;
  wb.readyAvailable = limit == null || active < limit;
  const primary = [...groups.handoff, ...groups.active];
  const fresh = primary.filter(t => !wb.order.has(t.id)).sort((a, b) => wbRank(a) - wbRank(b) || a.order - b.order);
  for (const t of fresh) wb.order.set(t.id, wb.seq++);
  primary.sort((a, b) => wb.order.get(a.id) - wb.order.get(b.id));

  const eligible = primary.filter(t => wbRunning(t) && t.worktree);
  wb.previews = [...eligible].sort((a, b) => wbRank(a) - wbRank(b) || wb.order.get(a.id) - wb.order.get(b.id)).slice(0, WB_PREVIEWS).map(t => t.id);
  const previewSet = new Set(wb.previews);

  const keep = new Set(primary.map(t => t.id));
  for (const [id, tile] of wb.tiles) if (!keep.has(id)) { tile.remove(); wb.tiles.delete(id); }
  for (const id of [...wb.screens.keys()]) if (!keep.has(id)) { wb.screens.delete(id); wb.failed.delete(id); }
  for (const [id, c] of wb.inflight) if (!previewSet.has(id)) { c.abort(); wb.inflight.delete(id); }
  for (const id of [...wb.failed.keys()]) { const t = findTask(id); if (!t || wb.failed.get(id).key !== wbExecutionKey(t)) wb.failed.delete(id); }
  primary.forEach((t, i) => {
    let tile = wb.tiles.get(t.id);
    if (!tile) { tile = wbTile(t); wb.tiles.set(t.id, tile); }
    if (wb.grid.children[i] !== tile) wb.grid.insertBefore(tile, wb.grid.children[i] || null);
    wbUpdateTile(tile, t, wbKind(t), previewSet.has(t.id));
  });

  const doneSorted = groups.done.sort((a, b) => (Date.parse(b.merged?.at || "") || 0) - (Date.parse(a.merged?.at || "") || 0) || b.order - a.order);
  wbQuiet(wb.queued, "Queued", groups.queued.sort((a, b) => a.order - b.order), groups.queued.length);
  wbQuiet(wb.ready, "Backlog · Ready to start", groups.ready.sort((a, b) => a.order - b.order), groups.ready.length);
  wbQuiet(wb.done, "Recently done", doneSorted.slice(0, WB_DONE), doneSorted.length);

  const backlog = shown.filter(t => t.column === "backlog" && !wbKind(t)).length;
  const working = groups.active.filter(t => !t.paused && (t.spawn.state === "running" || AGENT_LABEL[t.agent?.state])).length;
  const summary = [h("span", { class: "wb-count needs" }, I("hand", 12), plural(groups.handoff.length, "handoff")),
    h("span", { class: "wb-count busy" }, I("activity", 12), `${working} working`),
    h("span", { class: "wb-count ok" }, `${groups.ready.length} ready`),
    h("span", { class: "wb-count" }, `${groups.queued.length} queued`), h("span", { class: "wb-count" }, `${groups.done.length} done`)];
  if (backlog) summary.push(h("span", { class: "wb-count faint", title: "Other backlog tasks show on the Board" }, `${backlog} other backlog`));
  summary.push(h("span", { class: "spacer" }), h("span", { class: "wb-hint" }, eligible.length
    ? `Terminal previews are read-only and refresh while this tab is visible (${Math.min(eligible.length, WB_PREVIEWS)} of ${eligible.length})`
    : "No managed agent terminals are running"));
  const sumKey = JSON.stringify([groups.handoff.length, working, groups.ready.length, groups.queued.length, groups.done.length, backlog, eligible.length]);
  if (wb.summary.dataset.key !== sumKey) { wb.summary.dataset.key = sumKey; wb.summary.replaceChildren(...summary); }

  let empty = null;
  if (!selectedFlow()) empty = ["Flow unavailable", "Run /orchestrator in this flow's checkout to see its agents here."];
  else if (!scoped.length) empty = ["No tasks in this flow yet", "Create a task and start it; its agent's activity shows up here."];
  else if (!shown.length) empty = ["No matching tasks", `Nothing in this flow matches "${filter}". Clear the filter to see every agent.`];
  else if (!primary.length) empty = ["No agent is working or waiting for you", groups.queued.length
    ? "Queued tasks start on their own once their blockers clear or a task slot frees up."
    : groups.ready.length ? "Pick a dependency-ready task above to start work." : "Start a task from the Board (drag it to Todo) to see its agent here."];
  wb.empty.hidden = !empty;
  if (empty && wb.empty.dataset.key !== empty.join()) { wb.empty.dataset.key = empty.join(); wb.empty.replaceChildren(h("strong", {}, I("activity", 14), empty[0]), h("span", {}, empty[1])); }
  const attention = groups.handoff.length;
  const workHeadKey = JSON.stringify([primary.length, attention, working]);
  if (wb.workHead.dataset.key !== workHeadKey) {
    wb.workHead.dataset.key = workHeadKey;
    wb.workHead.replaceChildren("In progress", h("span", { class: "meta" }, attention ? `${primary.length} · ${attention} need${attention === 1 ? "s" : ""} you` : String(primary.length)));
  }
  wb.work.hidden = !primary.length;
  wbKick();
}
function wbQuiet(section, title, tasks, total) {
  section.hidden = !tasks.length;
  const key = JSON.stringify([total, wb.readyAvailable, tasks.map(t => [t.id, t.title, statusOf(t)?.text, t.id === openId])]);
  if (section.dataset.key === key) return;
  section.dataset.key = key;
  section.replaceChildren(h("div", { class: "wb-quiet-h" }, title, h("span", { class: "meta" }, total > tasks.length ? `${tasks.length} of ${total}` : String(total))),
    h("div", { class: "wb-rows" }, ...tasks.map(wbRow)));
}

// MARK: screen polling
const wbActive = () => boardView === "live" && document.visibilityState === "visible" && !!wb.root?.isConnected;
function wbKick() {
  if (!wbActive()) { stopWorkbench(); return; }
  const missing = wb.previews.filter(id => !wb.screens.has(id) && !wb.failed.has(id) && !wb.inflight.has(id));
  if ((wb.stale || missing.length) && !wb.inflight.size) { wb.stale = false; clearTimeout(wb.timer); wb.timer = null; wbTick(); }
  else if (missing.length) { wb.queue.push(...missing.filter(id => !wb.queue.includes(id))); clearTimeout(wb.timer); wb.timer = null; wbPump(); }
  else wbSchedule();
}
function wbSchedule() {
  if (wb.timer || wb.inflight.size || wb.queue.length || !wb.previews.some(id => !wb.failed.has(id)) || !wbActive()) return;
  wb.timer = setTimeout(wbTick, WB_INTERVAL);
}
function wbTick() {
  wb.timer = null;
  if (!wbActive()) return;
  wb.queue = wb.previews.filter(id => !wb.inflight.has(id) && !wb.failed.has(id));
  wbPump();
}
function wbPump() {
  if (!wbActive()) { wb.queue = []; return; }
  while (wb.inflight.size < WB_CONCURRENCY && wb.queue.length) {
    const id = wb.queue.shift();
    if (wb.previews.includes(id) && !wb.inflight.has(id)) wbFetch(id);
  }
  wbSchedule();
}
async function wbFetch(id) {
  const c = new AbortController();
  wb.inflight.set(id, c);
  try {
    const res = await fetch(tpath(id, "/screen"), { signal: c.signal });
    let data = null;
    try { data = await res.json(); } catch {}
    if (c.signal.aborted || !wb.previews.includes(id)) return;
    if (res.ok) { wb.screens.set(id, wbScreen(data)); wb.failed.delete(id); }
    else wb.failed.set(id, { key: wbExecutionKey(findTask(id)), message: data?.error || `${res.status} ${res.statusText}` });
    const t = findTask(id), tile = wb.tiles.get(id);
    if (t && tile && inFlow(t)) wbUpdateTile(tile, t, wbKind(t), true);
  } catch (error) {
    if (!c.signal.aborted && wb.previews.includes(id)) {
      const t = findTask(id), tile = wb.tiles.get(id);
      wb.failed.set(id, { key: wbExecutionKey(t), message: error.message || String(error) });
      if (t && tile && inFlow(t)) wbUpdateTile(tile, t, wbKind(t), true);
    }
  }
  finally {
    if (wb.inflight.get(id) === c) wb.inflight.delete(id);
    wbPump();
  }
}
function stopWorkbench() {
  clearTimeout(wb.timer);
  wb.timer = null;
  wb.queue = [];
  for (const c of wb.inflight.values()) c.abort();
  wb.inflight.clear();
  wb.failed.clear();
  wb.stale = true;
}
document.addEventListener("visibilitychange", () => {
  if (boardView !== "live") return;
  if (document.visibilityState === "visible") renderWorkbench(); else stopWorkbench();
});
