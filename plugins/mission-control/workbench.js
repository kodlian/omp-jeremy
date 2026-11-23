"use strict";
// MARK: live workbench
const WB_TEXT = 600, WB_DONE = 6;
const wb = { root: null, tiles: new Map(), treeTiles: new Map(), order: new Map(), seq: 0, scope: null };

const wbClip = (text, max = WB_TEXT) => { const s = String(text ?? "").trim(); return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s; };
const wbRunning = t => !t.health?.worktreeMissing && t.execution?.state === "running";

function wbKind(t) {
  if (t.health?.worktreeMissing) return "handoff";
  if (t.spawn.state === "failed") return "handoff";
  if (t.spawn.state === "running") return "active";
  if (t.column === "done") return "done";
  const s = t.agent?.state;
  if (!t.paused && (s === "needs_input" || s === "plan_ready" || s === "disconnected")) return "handoff";
  if (t.column === "review" || t.column === "pr") return "handoff";
  if (t.column === "waiting") return "queued";
  return "active";
}
function wbHandoff(t) {
  if (t.health?.worktreeMissing) return { tone: "err", icon: "alert", label: "Worktree missing" };
  if (t.spawn.state === "failed") return { tone: "err", icon: "alert", label: "Start failed" };
  const s = t.agent?.state;
  if (s === "needs_input") return { tone: "needs", icon: "hand", label: "Needs your answer" };
  if (s === "plan_ready") return { tone: "needs", icon: "file", label: "Plan ready for review" };
  if (s === "disconnected") return { tone: "needs", icon: "alert", label: "Session disconnected" };
  if (t.column === "pr") { const info = statusOf(t); return { tone: info?.tone === "needs" ? "needs" : "ok", icon: "pr", label: info?.text || "Pull request open" }; }
  return t.land?.mergeInto ? { tone: "ok", icon: "merge", label: "Ready to merge" } : { tone: "ok", icon: "pr", label: "Ready for pull request" };
}
function wbRank(t) {
  const s = t.agent?.state;
  if (t.health?.worktreeMissing || s === "needs_input" || s === "plan_ready" || t.spawn.state === "failed") return 0;
  if (wbKind(t) === "handoff") return 1;
  if (t.spawn.state === "running" || AGENT_LABEL[s]) return 2;
  return 3;
}

// MARK: actions
// A tile's only action reaches the agent's terminal; the task panel has the rest.
function wbTerminalButton(t) {
  if (t.health?.worktreeMissing || !t.worktree) return null;
  const s = t.agent?.state, go = () => { openPanel(t.id); openWorkspace(); };
  if (s === "plan_ready") return actionButton("Review plan", "file", go, true, "Opens the agent's terminal, where its plan waits for review");
  if (s === "needs_input") return actionButton("Answer in terminal", "terminal", go, true, "The board can't answer this prompt; it opens the agent's terminal");
  if (s === "disconnected") return actionButton("Connect terminal", "terminal", go, true);
  return sessionConnected(t) || wbRunning(t) ? actionButton("Open terminal", "terminal", go, false, "Jump to the agent's terminal") : null;
}

// MARK: agent detail
const wbTodo = todo => todo ? h("span", { class: "wb-todo", title: `${todo.done} of ${todo.total} to-dos done` }, `${todo.done}/${todo.total}`) : null;
function wbLine(label, icon, text, tone) {
  return h("div", { class: "wb-line" + (tone ? " " + tone : ""), title: text }, h("span", { class: "wb-k" }, I(icon, 11), label), h("span", { class: "wb-v" }, wbClip(text, 300)));
}
// What an agent is on: the question it asks, the to-do in progress, its latest sentence, then its step.
function wbAgentLines(a) {
  const lines = [];
  if (a.question) lines.push(wbLine("Asks", "hand", a.question, "needs"));
  if (a.todo?.current) lines.push(wbLine("To-do", "check", a.todo.current));
  if (a.said) lines.push(wbLine("Says", "message", a.said));
  if (a.step && !a.question) lines.push(wbLine("Step", "wrench", a.step));
  return lines;
}
// One omp among those running in a checkout: its session title, what it does, then what it is on.
function wbAgentBlock(a) {
  const info = agentInfo(a);
  return h("div", { class: "wb-agent" },
    h("div", { class: "wb-agent-head" }, h("span", { class: "wb-agent-name", title: a.title || a.id }, a.title || "omp session"),
      stateEl({ ...info, spin: false, dot: info.spin || info.dot }), wbTodo(a.todo)),
    ...wbAgentLines(a));
}
function wbCommitLine(git) {
  const last = git?.last;
  return last ? wbLine("Commit", "branch", `${last.subject} · ${ago(last.at)}${git.commits > 1 ? ` · ${plural(git.commits, "commit")}` : ""}`) : null;
}
function wbGitBits(x) {
  const out = [];
  if (x.git && (x.git.added || x.git.removed)) out.push(diffstat(x.git));
  if (x.git?.dirty > 0) out.push(h("span", { class: "udot", title: plural(x.git.dirty, "uncommitted file") }));
  if (x.pr) out.push(prChip(x.pr));
  return out;
}

// MARK: tiles
function wbStateEl(t) {
  if (wbKind(t) === "handoff") {
    const handoff = wbHandoff(t);
    return stateEl({ tone: handoff.tone, icon: handoff.icon, text: handoff.label, since: AGENT_LABEL[t.agent?.state] ? t.agent.startedAt || t.agent.since : t.agent?.since });
  }
  const info = statusOf(t);
  return info ? stateEl({ ...info, spin: false, dot: info.spin || info.dot }) : h("span", { class: "state faint" }, colTitle(t.column));
}
function wbBody(t) {
  const parts = [], a = t.agent || {};
  parts.push(h("header", { class: "wb-task-header" }, h("span", { class: "wb-task-id" }, taskNumber(t.id)),
    h("strong", { class: "wb-title", title: t.title || "" }, t.title || "Untitled")));
  const tags = tagRow(t);
  if (tags) parts.push(tags);
  parts.push(h("div", { class: "wb-head" }, h("span", { class: "wb-col", "data-col": t.column }, colTitle(t.column)), wbStateEl(t), wbTodo(a.todo),
    h("span", { class: "spacer" }), t.ticket ? h("span", { class: "chip mono", title: "Ticket" }, t.ticket) : null, ...wbGitBits(t)));
  parts.push(...wbAgentLines(a));
  if (t.spawn.state === "failed" && t.spawn.error) parts.push(h("div", { class: "wb-msg err" }, I("alert", 12), h("span", {}, wbClip(t.spawn.error))));
  else if (t.spawn.state === "running") parts.push(h("div", { class: "wb-note" }, "Creating the worktree and starting omp"));
  if (a.message) parts.push(wbLine("You", "arrowRight", a.message));
  const commit = wbCommitLine(t.git);
  if (commit) parts.push(commit);
  if (t.agents?.length) parts.push(h("div", { class: "wb-agents" }, h("div", { class: "wb-agents-h" }, `Also in this worktree · ${t.agents.length}`), ...t.agents.map(wbAgentBlock)));
  return parts;
}
function wbTile(t) {
  const top = h("div", { class: "wb-top" }), foot = h("div", { class: "wb-foot" });
  const tile = h("article", { class: "workbench-tile", "data-id": t.id, tabindex: "0",
    onclick: e => { if (!e.target.closest("button,a")) openPanel(t.id); },
    onkeydown: e => { if (e.key === "Enter" && e.target === tile) openPanel(t.id); } }, top, foot);
  tile.wb = { top, foot };
  return tile;
}
function wbUpdateTile(tile, t, kind) {
  const p = tile.wb;
  tile.dataset.kind = kind;
  const key = JSON.stringify([kind, t.title, t.ticket, t.column, t.agent, t.agents, t.spawn, t.git, t.pr, t.paused, t.held, t.blockedBy, t.land, t.base, t.tags, t.worktree, t.execution, t.session?.connected, t.merged, t.health]);
  if (tile.dataset.content !== key) {
    tile.dataset.content = key;
    p.top.replaceChildren(...wbBody(t));
    p.foot.replaceChildren(...[wbTerminalButton(t)].filter(Boolean));
  }
  const s = t.agent?.state;
  tile.classList.toggle("needs", kind === "handoff" && (s === "needs_input" || s === "plan_ready" || s === "disconnected"));
  tile.classList.toggle("failed", t.spawn.state === "failed" || !!t.health?.worktreeMissing);
  tile.classList.toggle("busy", !t.paused && (t.spawn.state === "running" || !!AGENT_LABEL[s]));
  tile.classList.toggle("quiet", t.paused || s === "stopped");
  tile.classList.toggle("sel", t.id === openId);
}
function wbRow(t) {
  const info = statusOf(t);
  const row = h("button", { class: "workbench-tile wb-row" + (t.id === openId ? " sel" : ""), "data-id": t.id, onclick: () => openPanel(t.id) },
    h("span", { class: "wb-id" }, taskNumber(t.id)), h("span", { class: "wb-row-title" }, t.title || "Untitled"),
    info ? stateEl({ ...info, spin: false, dot: info.spin || info.dot }) : h("span", { class: "state faint" }, colTitle(t.column)));
  row.dataset.kind = t.column === "done" ? "done" : "queued";
  return row;
}
// A checkout no task owns where omp runs: every omp there, and a way to its terminal.
function wbTreeBody(w) {
  const parts = [h("header", { class: "wb-task-header" }, worktreeChip(w), h("strong", { class: "wb-title", title: w.path }, worktreeName(w)))];
  const tags = tagRow(w);
  if (tags) parts.push(tags);
  // Several omp get a summary above their blocks; a single one says what it does in its own block.
  const info = w.agents.length > 1 ? worktreeStatus(w) : null, bits = wbGitBits(w);
  if (info || bits.length) parts.push(h("div", { class: "wb-head" }, info ? stateEl({ ...info, spin: false, dot: info.spin || info.dot }) : null, h("span", { class: "spacer" }), ...bits));
  const commit = wbCommitLine(w.git);
  if (commit) parts.push(commit);
  parts.push(...w.agents.map(wbAgentBlock));
  return parts;
}
function wbTreeTile(w) {
  const top = h("div", { class: "wb-top" });
  const open = actionButton("Open terminal", "terminal", () => { const cur = worktreeAt(w.path); if (cur) openListedWorktree(cur); }, false, "Jump to the terminal omp runs in");
  const tile = h("article", { class: "workbench-tile wb-tree", "data-path": w.path, tabindex: "0" }, top, h("div", { class: "wb-foot" }, open));
  tile.onclick = e => { if (e.target.closest("button,a")) return; const cur = worktreeAt(w.path); if (cur) openMenu(tile, worktreeMenu(cur, tile)); };
  tile.onkeydown = e => { if (e.key === "Enter" && e.target === tile) tile.click(); };
  tile.dataset.kind = "active";
  tile.wb = { top };
  return tile;
}
function wbUpdateTreeTile(tile, w) {
  const key = JSON.stringify([w.branch, w.detached, w.main, w.agents, w.git, w.pr, w.tags]);
  if (tile.dataset.content !== key) { tile.dataset.content = key; tile.wb.top.replaceChildren(...wbTreeBody(w)); }
  tile.classList.toggle("needs", w.agents.some(a => a.state === "needs_input" || a.state === "plan_ready"));
  tile.classList.toggle("busy", w.agents.some(a => AGENT_LABEL[a.state]));
}
// The most recently active sessions first, then checkouts without one.
const wbTreeRank = w => (w.agent?.state === "asleep" ? 0 : 1);
function wbTreeRow(w) {
  const row = h("button", { class: "workbench-tile wb-row", "data-path": w.path, title: w.path },
    w.detached || w.main ? worktreeChip(w) : null, h("span", { class: "wb-row-title" }, worktreeName(w)), stateEl(worktreeStatus(w)));
  row.onclick = () => { const current = worktreeAt(w.path); if (current) openMenu(row, worktreeMenu(current, row)); };
  row.dataset.kind = "queued";
  return row;
}
function wbTrees(section, trees) {
  section.hidden = !trees.length;
  const key = JSON.stringify(trees.map(w => [w.path, w.branch, w.detached, w.main, w.agent]));
  if (section.dataset.key === key) return;
  section.dataset.key = key;
  section.replaceChildren(h("div", { class: "wb-quiet-h" }, "Worktrees without a task", h("span", { class: "meta" }, String(trees.length))),
    h("div", { class: "wb-rows" }, ...trees.map(wbTreeRow)));
}

// MARK: render
function wbInit() {
  wb.summary = h("div", { class: "wb-summary" });
  wb.work = h("section", { class: "wb-work" });
  wb.workHead = h("div", { class: "wb-quiet-h" });
  wb.grid = h("div", { class: "wb-grid" });
  wb.work.append(wb.workHead, wb.grid);
  wb.empty = h("div", { class: "wb-empty" });
  wb.queued = h("section", { class: "wb-quiet" });
  wb.trees = h("section", { class: "wb-quiet" });
  wb.done = h("section", { class: "wb-quiet" });
  wb.root = h("div", { class: "workbench", "aria-label": "Live agent workbench" }, wb.summary, wb.empty, wb.work, wb.queued, wb.trees, wb.done);
}
function renderWorkbench() {
  if (!board || boardView !== "live") return;
  if (!wb.root) wbInit();
  const host = $("#board");
  if (wb.root.parentNode !== host) host.replaceChildren(wb.root);
  if (wb.scope !== projectSel) { wb.scope = projectSel; wb.order.clear(); wb.seq = 0; }
  const scoped = board.tasks.filter(inProject), shown = scoped.filter(matches);
  const groups = { handoff: [], active: [], queued: [], done: [] };
  for (const t of shown) groups[wbKind(t)].push(t);
  const primary = [...groups.handoff, ...groups.active];
  const fresh = primary.filter(t => !wb.order.has(t.id)).sort((a, b) => wbRank(a) - wbRank(b) || a.order - b.order);
  for (const t of fresh) wb.order.set(t.id, wb.seq++);
  primary.sort((a, b) => wb.order.get(a.id) - wb.order.get(b.id));
  const trees = projectWorktrees().filter(worktreeMatches);
  const running = trees.filter(w => w.agents?.length).sort((a, b) => Number(b.main) - Number(a.main) || worktreeName(a).localeCompare(worktreeName(b)));

  const keep = new Set(primary.map(t => t.id)), keepTrees = new Set(running.map(w => w.path));
  for (const [id, tile] of wb.tiles) if (!keep.has(id)) { tile.remove(); wb.tiles.delete(id); }
  for (const [path, tile] of wb.treeTiles) if (!keepTrees.has(path)) { tile.remove(); wb.treeTiles.delete(path); }
  primary.forEach((t, i) => {
    let tile = wb.tiles.get(t.id);
    if (!tile) { tile = wbTile(t); wb.tiles.set(t.id, tile); }
    if (wb.grid.children[i] !== tile) wb.grid.insertBefore(tile, wb.grid.children[i] || null);
    wbUpdateTile(tile, t, wbKind(t));
  });
  running.forEach((w, j) => {
    let tile = wb.treeTiles.get(w.path);
    if (!tile) { tile = wbTreeTile(w); wb.treeTiles.set(w.path, tile); }
    const i = primary.length + j;
    if (wb.grid.children[i] !== tile) wb.grid.insertBefore(tile, wb.grid.children[i] || null);
    wbUpdateTreeTile(tile, w);
  });

  const doneSorted = groups.done.sort((a, b) => (Date.parse(b.merged?.at || "") || 0) - (Date.parse(a.merged?.at || "") || 0) || b.order - a.order);
  wbQuiet(wb.queued, "Waiting", groups.queued.sort((a, b) => a.order - b.order), groups.queued.length);
  wbQuiet(wb.done, "Recently done", doneSorted.slice(0, WB_DONE), doneSorted.length);
  wbTrees(wb.trees, trees.filter(w => !w.agents?.length)
    .sort((a, b) => wbTreeRank(a) - wbTreeRank(b) || (Date.parse(b.agent?.at || "") || 0) - (Date.parse(a.agent?.at || "") || 0) || worktreeName(a).localeCompare(worktreeName(b))));

  const others = [...primary.flatMap(t => t.agents || []), ...running.flatMap(w => w.agents)];
  const handoffs = groups.handoff.length + others.filter(a => a.state === "needs_input" || a.state === "plan_ready").length;
  const working = groups.active.filter(t => !t.paused && (t.spawn.state === "running" || AGENT_LABEL[t.agent?.state])).length + others.filter(a => AGENT_LABEL[a.state]).length;
  const summary = [h("span", { class: "wb-count needs" }, I("hand", 12), plural(handoffs, "handoff")),
    h("span", { class: "wb-count busy" }, I("activity", 12), `${working} working`),
    h("span", { class: "wb-count" }, `${groups.queued.length} waiting`), h("span", { class: "wb-count" }, `${groups.done.length} done`)];
  const sumKey = JSON.stringify([handoffs, working, groups.queued.length, groups.done.length]);
  if (wb.summary.dataset.key !== sumKey) { wb.summary.dataset.key = sumKey; wb.summary.replaceChildren(...summary); }

  const count = primary.length + running.length;
  let empty = null;
  if (!selectedProject()) empty = ["Project unavailable", "Run /mission in this project's checkout to see its agents here."];
  else if (!scoped.length && !running.length) empty = ["No tasks in this project yet", "Create a task; its agent's activity shows up here."];
  else if (scoped.length && !shown.length && !running.length) empty = ["No matching tasks", "Nothing in this project matches the filter. Clear it to see every agent."];
  else if (!count) empty = ["No agent is working or waiting for you", groups.queued.length
    ? "Waiting tasks resume on their own once what they build on lands."
    : "Create a task (N) to see its agent here."];
  wb.empty.hidden = !empty;
  if (empty && wb.empty.dataset.key !== empty.join()) { wb.empty.dataset.key = empty.join(); wb.empty.replaceChildren(h("strong", {}, I("activity", 14), empty[0]), h("span", {}, empty[1])); }
  const workHeadKey = JSON.stringify([count, handoffs, working]);
  if (wb.workHead.dataset.key !== workHeadKey) {
    wb.workHead.dataset.key = workHeadKey;
    wb.workHead.replaceChildren("In progress", h("span", { class: "meta" }, handoffs ? `${count} · ${handoffs} need${handoffs === 1 ? "s" : ""} you` : String(count)));
  }
  wb.work.hidden = !count;
}
function wbQuiet(section, title, tasks, total) {
  section.hidden = !tasks.length;
  const key = JSON.stringify([total, tasks.map(t => [t.id, t.title, statusOf(t)?.text, t.id === openId])]);
  if (section.dataset.key === key) return;
  section.dataset.key = key;
  section.replaceChildren(h("div", { class: "wb-quiet-h" }, title, h("span", { class: "meta" }, total > tasks.length ? `${tasks.length} of ${total}` : String(total))),
    h("div", { class: "wb-rows" }, ...tasks.map(wbRow)));
}
