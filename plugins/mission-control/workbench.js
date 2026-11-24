"use strict";
// MARK: live workbench
const wb = { root: null, tiles: new Map() };

const wbClip = (text, max = 600) => { const s = String(text ?? "").trim(); return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s; };
const wbPending = w => [...pending].filter(k => k.endsWith(":" + w.path));

// MARK: agent detail
const wbTodo = todo => todo ? h("span", { class: "wb-todo", title: `${todo.done} of ${todo.total} to-dos done` }, `${todo.done}/${todo.total}`) : null;
function wbLine(label, icon, text, tone) {
  return h("div", { class: "wb-line" + (tone ? " " + tone : ""), title: text }, h("span", { class: "wb-k" }, I(icon, 11), label), h("span", { class: "wb-v" }, wbClip(text, 300)));
}
// What an omp is on: the question it asks, the to-do in progress, its latest sentence, its step, then your latest prompt.
function wbAgentLines(a) {
  const lines = [];
  if (a.question) lines.push(wbLine("Asks", "hand", a.question, "needs"));
  if (a.todo?.current) lines.push(wbLine("To-do", "check", a.todo.current));
  if (a.said) lines.push(wbLine("Says", "message", a.said));
  if (a.step && !a.question) lines.push(wbLine("Step", "wrench", a.step));
  if (a.message) lines.push(wbLine("You", "arrowRight", a.message));
  return lines;
}
// One omp among those running in a checkout: its session title, what it does, what it is on and its terminal.
function wbAgentBlock(w, a) {
  const info = agentInfo(a);
  const open = actionButton("Open terminal", "terminal", () => openAgentTerminal(current(w), a), needsYou(a), null, !a.terminal);
  return h("div", { class: "wb-agent" + (needsYou(a) ? " needs" : "") },
    h("div", { class: "wb-agent-head" }, h("span", { class: "wb-agent-name", title: a.title || a.id }, a.title || "omp session"),
      stateEl({ ...info, spin: false, dot: info.spin || info.dot }), wbTodo(a.todo)),
    ...wbAgentLines(a),
    h("div", { class: "wb-agent-foot", title: a.terminal ? "Bring its terminal forward" : "Mission Control doesn't know its terminal yet" }, open));
}
function wbCommitLine(git) {
  const last = git?.last;
  return last ? wbLine("Commit", "branch", `${last.subject} · ${ago(last.at)}${git.commits > 1 ? ` · ${plural(git.commits, "commit")}` : ""}`) : null;
}
function wbGitBits(w) {
  const out = [];
  if (w.git && (w.git.added || w.git.removed)) out.push(diffstat(w.git));
  if (w.git?.dirty > 0) out.push(h("span", { class: "udot", title: plural(w.git.dirty, "uncommitted file") }), h("span", {}, plural(w.git.dirty, "uncommitted file")));
  if (w.pr) out.push(h("span", { class: "spacer" }), prChip(w.pr));
  return out;
}

// MARK: tiles
function wbTileBody(w) {
  const parts = [h("header", { class: "wb-task-header" }, worktreeChip(w), h("strong", { class: "wb-title", title: w.path }, ...titleEl(w)))];
  parts.push(tagRow(w), depsLine(w));
  const bits = wbGitBits(w);
  if (bits.length) parts.push(h("div", { class: "wb-head" }, ...bits));
  const commit = wbCommitLine(w.git);
  if (commit) parts.push(commit);
  parts.push(...w.agents.map(a => wbAgentBlock(w, a)), worktreeActions(w));
  return parts.filter(Boolean);
}
function wbTile(w) {
  const tile = h("article", { class: "workbench-tile", "data-key": w.key, tabindex: "0" });
  tile.onclick = cardClick(tile, w);
  tile.onkeydown = cardKey(w);
  return tile;
}
function wbUpdateTile(tile, w) {
  const key = JSON.stringify([w, hiddenBranch(w.branch), wbPending(w), prerequisites(w).map(x => [x.key, x.column])]);
  if (tile.dataset.content !== key) { tile.dataset.content = key; tile.replaceChildren(...wbTileBody(w)); }
  tile.classList.toggle("needs", w.agents.some(needsYou));
  tile.classList.toggle("busy", w.agents.some(a => AGENT_LABEL[a.state]));
  tile.classList.toggle("is-hidden", hiddenBranch(w.branch));
}
function wbRow(w) {
  const row = h("div", { class: "workbench-tile wb-row" + (hiddenBranch(w.branch) ? " is-hidden" : ""), "data-key": w.key, title: w.path, tabindex: "0" },
    worktreeChip(w), h("span", { class: "wb-row-title" }, ...titleEl(w)), stateEl(worktreeStatus(w)));
  row.onclick = cardClick(row, w);
  row.onkeydown = cardKey(w);
  return row;
}
// Sleeping sessions first, the most recent on top, then checkouts without one.
function wbRest(section, trees) {
  section.hidden = !trees.length;
  const key = JSON.stringify(trees.map(w => [w.path, w.title, w.folder, w.agent, hiddenBranch(w.branch)]));
  if (section.dataset.key === key) return;
  section.dataset.key = key;
  section.replaceChildren(h("div", { class: "wb-quiet-h" }, "Other worktrees", h("span", { class: "meta" }, String(trees.length))),
    h("div", { class: "wb-rows" }, ...trees.map(wbRow)));
}

// MARK: render
function wbInit() {
  wb.summary = h("div", { class: "wb-summary" });
  wb.grid = h("div", { class: "wb-grid" });
  wb.empty = h("div", { class: "wb-empty" });
  wb.rest = h("section", { class: "wb-quiet" });
  wb.root = h("div", { class: "workbench", "aria-label": "Live: every omp of the project" }, wb.summary, wb.empty, wb.grid, wb.rest);
}
function renderWorkbench() {
  if (!board || boardView !== "live") return;
  if (!wb.root) wbInit();
  const host = $("#board");
  if (wb.root.parentNode !== host) host.replaceChildren(wb.root);
  const all = projectWorktrees(), trees = all.filter(worktreeMatches);
  const running = trees.filter(w => w.agents?.length).sort((a, b) => Number(b.main) - Number(a.main) || worktreeName(a).localeCompare(worktreeName(b)));
  const asleep = w => w.agent?.state === "asleep";
  const rest = trees.filter(w => !w.agents?.length)
    .sort((a, b) => Number(asleep(b)) - Number(asleep(a)) || (Date.parse(b.agent?.at || "") || 0) - (Date.parse(a.agent?.at || "") || 0) || worktreeName(a).localeCompare(worktreeName(b)));

  const keep = new Set(running.map(w => w.path));
  for (const [path, tile] of wb.tiles) if (!keep.has(path)) { tile.remove(); wb.tiles.delete(path); }
  running.forEach((w, i) => {
    let tile = wb.tiles.get(w.path);
    if (!tile) { tile = wbTile(w); wb.tiles.set(w.path, tile); }
    if (wb.grid.children[i] !== tile) wb.grid.insertBefore(tile, wb.grid.children[i] || null);
    wbUpdateTile(tile, w);
  });
  wb.grid.hidden = !running.length;
  wbRest(wb.rest, rest);

  const agents = running.flatMap(w => w.agents);
  const counts = [agents.filter(needsYou).length, agents.filter(a => AGENT_LABEL[a.state]).length, trees.filter(w => w.column === "waiting").length,
    trees.filter(w => w.column === "review").length, trees.filter(asleep).length];
  const sumKey = JSON.stringify(counts);
  if (wb.summary.dataset.key !== sumKey) {
    wb.summary.dataset.key = sumKey;
    wb.summary.replaceChildren(h("span", { class: "wb-count needs" }, I("hand", 12), `${counts[0]} need${counts[0] === 1 ? "s" : ""} you`),
      h("span", { class: "wb-count busy" }, I("activity", 12), `${counts[1]} working`),
      h("span", { class: "wb-count" }, I("pause", 12), `${counts[2]} waiting`),
      h("span", { class: "wb-count ok" }, I("check", 12), `${counts[3]} in review`),
      h("span", { class: "wb-count faint" }, I("pause", 12), `${counts[4]} asleep`));
  }

  let empty = null;
  if (!selectedProject()) empty = ["Project unavailable", "Run /mission in this project's checkout to see its omp sessions here."];
  else if (all.length && !trees.length) empty = ["No matching worktrees", "Nothing in this project matches the filter. Clear it to see every checkout."];
  else if (!running.length) empty = ["No omp is running in this project", rest.some(asleep) ? "Resume a sleeping session below, or start omp in a worktree." : "Start omp in a worktree to see it here."];
  wb.empty.hidden = !empty;
  if (empty && wb.empty.dataset.key !== empty.join()) { wb.empty.dataset.key = empty.join(); wb.empty.replaceChildren(h("strong", {}, I("activity", 14), empty[0]), h("span", {}, empty[1])); }
}
