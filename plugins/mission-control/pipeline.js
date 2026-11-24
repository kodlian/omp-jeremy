"use strict";
// MARK: graph canvas
const pipeline = { local: new Map(), nodes: new Map(), edges: new Map(), x: 40, y: 60, zoom: 1, gesture: null, selected: null, scope: null };
const NODE_W = 410, NODE_H = 132, PORT_X = 14, PORT_Y = 66, PIPELINE_ROW = NODE_H + 20, PIPELINE_COLUMN = NODE_W + 120, PIPELINE_GROUP_GAP = 56, PIPELINE_SPAWN_MIN = 24;
function pipelineSVG(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}
function pipelinePoint(e) {
  const r = pipeline.root.getBoundingClientRect();
  return { x: (e.clientX - r.left - pipeline.x) / pipeline.zoom, y: (e.clientY - r.top - pipeline.y) / pipeline.zoom };
}
function pipelineTransform() {
  pipeline.world.style.transform = `translate(${pipeline.x}px,${pipeline.y}px) scale(${pipeline.zoom})`;
}
const pipelineLinks = () => selectedProject()?.links || [];
// A node's place: the one being saved, else the project's saved one.
const placeOf = key => pipeline.local.get(key) || selectedProject()?.positions?.[key] || null;
const pipelineVisible = () => projectWorktrees().filter(w => worktreeMatches(w) && (!pipeline.hideDone.checked || w.column !== "done"));
async function savePositions(places, reset = false) {
  const project = selectedProject();
  if (!project) return;
  for (const [key, p] of Object.entries(places)) pipeline.local.set(key, p);
  try {
    const r = await api("PATCH", "/api/projects/positions", { id: project.id, positions: places, ...(reset ? { reset: true } : {}) });
    Object.assign(projects().find(p => p.id === project.id) || {}, r.project);
  } catch (e) { failed(e); }
  for (const [key, p] of Object.entries(places)) if (pipeline.local.get(key) === p) pipeline.local.delete(key);
}

// MARK: placement
// The cmux sidebar's order: main checkout, checkouts without a folder, then each folder alphabetically.
const groupOf = w => w.main ? 0 : w.folder ? 2 : 1;
const byGroup = (a, b) => groupOf(a) - groupOf(b) || (a.folder || "").localeCompare(b.folder || "") || worktreeName(a).localeCompare(worktreeName(b));
const sameGroup = (a, b) => groupOf(a) === groupOf(b) && (a.folder || "") === (b.folder || "");
// The sidebar's order top to bottom; each checkout's dependents in the next column to its right, it level with their middle.
function pipelineLayout(trees) {
  const keys = new Set(trees.map(w => w.key)), parent = new Map(), kids = new Map(), places = {}, seen = new Set();
  for (const w of trees) {
    const p = (w.dependsOn || []).find(k => k !== w.key && keys.has(k));
    if (p) { parent.set(w.key, p); kids.set(p, [...(kids.get(p) || []), w]); }
  }
  // `w` and its dependents, one column per level, y from the chain's top.
  const chain = w => {
    seen.add(w.key);
    const nodes = [], middles = [];
    let height = 0;
    for (const c of (kids.get(w.key) || []).sort(byGroup)) {
      if (seen.has(c.key)) continue;
      const sub = chain(c);
      for (const n of sub.nodes) nodes.push({ key: n.key, depth: n.depth + 1, y: n.y + height });
      middles.push(sub.at + height);
      height += sub.height;
    }
    const at = middles.length ? (middles[0] + middles[middles.length - 1]) / 2 : 0;
    nodes.push({ key: w.key, depth: 0, y: at });
    return { nodes, at, height: Math.max(height, PIPELINE_ROW) };
  };
  // Each chain goes as high as its columns allow: one row below the lowest node already in each, below the folder above.
  const low = [];
  let floor = -PIPELINE_ROW, last = null;
  const sorted = [...trees].sort(byGroup);
  for (const w of [...sorted.filter(w => !parent.has(w.key)), ...sorted]) {
    if (seen.has(w.key)) continue;
    if (last && !sameGroup(last, w)) floor = Math.max(floor, ...low.filter(y => y != null)) + PIPELINE_GROUP_GAP;
    last = w;
    const { nodes } = chain(w);
    const shift = Math.max(...nodes.map(n => Math.max(low[n.depth] ?? floor, floor) + PIPELINE_ROW - n.y));
    for (const n of nodes) {
      places[n.key] = { x: n.depth * PIPELINE_COLUMN, y: n.y + shift };
      low[n.depth] = Math.max(low[n.depth] ?? floor, n.y + shift);
    }
  }
  return places;
}
// Places the checkouts without a saved place and saves them: all at once on a blank canvas, else each below its prerequisite, its folder's group or everything.
function pipelinePlace(trees) {
  const missing = trees.filter(w => !placeOf(w.key));
  if (!missing.length) return;
  const places = trees.some(w => placeOf(w.key)) ? {} : pipelineLayout(trees);
  const at = key => places[key] || placeOf(key);
  const placed = () => trees.map(w => at(w.key)).filter(Boolean);
  const free = p => !placed().some(o => Math.abs(o.x - p.x) < NODE_W + 20 && Math.abs(o.y - p.y) < PIPELINE_ROW);
  for (const w of missing.sort(byGroup)) {
    if (places[w.key]) continue;
    const prerequisite = (w.dependsOn || []).map(at).find(Boolean);
    const group = trees.filter(x => x !== w && sameGroup(x, w)).map(x => at(x.key)).filter(Boolean), all = placed();
    let p;
    if (prerequisite) p = { x: prerequisite.x + PIPELINE_COLUMN, y: prerequisite.y };
    else if (group.length) p = { x: Math.min(...group.map(q => q.x)), y: Math.max(...group.map(q => q.y)) + PIPELINE_ROW };
    else p = { x: all.length ? Math.min(...all.map(q => q.x)) : 0, y: all.length ? Math.max(...all.map(q => q.y)) + PIPELINE_ROW + PIPELINE_GROUP_GAP : 0 };
    while (!free(p)) p = { x: p.x, y: p.y + PIPELINE_ROW };
    places[w.key] = p;
  }
  savePositions(places);
}
// A faint folder heading above the topmost node of each folder group.
function pipelineLabels(trees) {
  const keys = new Set(trees.map(w => w.key)), groups = new Map();
  for (const w of trees) {
    const p = placeOf(w.key);
    if (!w.folder || w.main || !p || (w.dependsOn || []).some(k => keys.has(k))) continue;
    const g = groups.get(w.folder);
    if (!g || p.y < g.y) groups.set(w.folder, { x: p.x, y: p.y });
  }
  pipeline.labels.replaceChildren(...[...groups].map(([folder, p]) => h("div", { class: "pipeline-folder", style: `transform:translate(${p.x}px,${p.y - 26}px)` }, folder)));
}
function pipelineAutoLayout() {
  savePositions(pipelineLayout(pipelineVisible()), true).then(() => { renderPipeline(); pipelineFit(true); });
}

// MARK: edges
function pipelineCurve(a, b) {
  const bend = Math.max(60, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + bend},${a.y} ${b.x - bend},${b.y} ${b.x},${b.y}`;
}
// Solid for the first half from the prerequisite, then dashed like a waiting connection (pipeline.css `stroke-dasharray:8 7`).
function pipelineHalfDash(path) {
  const length = path.getTotalLength();
  return `${length / 2} 7` + " 8 7".repeat(Math.ceil(length / 2 / 15));
}
function pipelineDrawEdges() {
  for (const edge of pipeline.edges.values()) {
    const a = placeOf(edge.from), b = placeOf(edge.to);
    const d = pipelineCurve({ x: a.x + NODE_W - PORT_X, y: a.y + PORT_Y }, { x: b.x + PORT_X, y: b.y + PORT_Y });
    edge.path.setAttribute("d", d); edge.hit.setAttribute("d", d);
    edge.path.style.strokeDasharray = edge.group.classList.contains("started") ? pipelineHalfDash(edge.path) : "";
    edge.group.classList.toggle("selected", pipeline.selected === edge.key);
  }
  const selected = pipeline.edges.get(pipeline.selected);
  pipeline.removeEdge.hidden = !selected;
  if (selected) {
    const mid = selected.path.getPointAtLength(selected.path.getTotalLength() / 2);
    pipeline.removeEdge.style.transform = `translate(${mid.x - 11}px,${mid.y - 11}px)`;
  }
}
function pipelineSelect(key) {
  pipeline.selected = key;
  pipelineDrawEdges();
}
function pipelineRemoveSelected() {
  const edge = pipeline.edges.get(pipeline.selected);
  pipeline.selected = null;
  if (edge) setLink(edge.from, edge.to, false);
  pipelineDrawEdges();
}

// MARK: canvas
// Fits every node; `readable` keeps nodes legible on a tall canvas, showing its top.
function pipelineFit(readable = false) {
  const ps = [...pipeline.nodes.keys()].map(placeOf).filter(Boolean);
  if (!ps.length) return;
  const minX = Math.min(...ps.map(p => p.x)), minY = Math.min(...ps.map(p => p.y));
  const w = Math.max(...ps.map(p => p.x)) + NODE_W - minX, ht = Math.max(...ps.map(p => p.y)) + NODE_H - minY;
  const fit = Math.min((pipeline.root.clientWidth - 80) / w, (pipeline.root.clientHeight - 140) / ht);
  pipeline.zoom = Math.min(1, Math.max(readable ? Math.min(.6, (pipeline.root.clientWidth - 80) / w) : .15, fit));
  pipeline.x = (pipeline.root.clientWidth - w * pipeline.zoom) / 2 - minX * pipeline.zoom;
  pipeline.y = 100 - minY * pipeline.zoom;
  pipelineTransform();
}
// A line let go on empty canvas (not over a node or the toolbar) creates a worktree there.
function pipelineEmptyAt(e) {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  return !!hit && pipeline.root.contains(hit) && !hit.closest(".pipeline-node,.pipeline-controls,.pipeline-edge");
}
// The outline of the worktree a released line or a double-click creates, with its input port at `point`.
function pipelineGhost(text, point) {
  if (!point) { pipeline.ghost?.remove(); pipeline.ghost = null; return; }
  if (!pipeline.ghost) { pipeline.ghost = h("div", { class: "pipeline-ghost" }); pipeline.world.append(pipeline.ghost); }
  pipeline.ghost.textContent = text;
  pipeline.ghost.style.transform = `translate(${point.x - PORT_X}px,${point.y - PORT_Y}px)`;
}
// Opens New worktree with its outline at `point` and `from` as its After; the new worktree is placed there.
function pipelineCreateAt(point, from = null) {
  const at = { x: Math.round(point.x - PORT_X), y: Math.round(point.y - PORT_Y) };
  const opened = openNewWorktree({ after: from || "", onCreated: key => savePositions({ [key]: at }), onClosed: () => pipelineGhost(null, null) });
  const source = from && worktreeByKey(from);
  if (opened) pipelineGhost(source ? "New worktree after " + worktreeName(source) : "New worktree", point);
}
function pipelineConnect(g, e) {
  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".pipeline-node");
  if (target && target.dataset.key !== g.key) {
    if (g.port === "out") setLink(g.key, target.dataset.key, true);
    else setLink(target.dataset.key, g.key, true);
    return;
  }
  if (!target && g.port === "out" && Math.hypot(e.clientX - g.cx, e.clientY - g.cy) > PIPELINE_SPAWN_MIN && pipelineEmptyAt(e)) pipelineCreateAt(pipelinePoint(e), g.key);
}
function pipelineInit() {
  const root = h("div", { class: "pipeline", tabindex: "0", "aria-label": "Dependencies between the project's checkouts" });
  const world = h("div", { class: "pipeline-world" });
  const svg = pipelineSVG("svg", { class: "pipeline-lines" });
  const removeEdge = h("button", { class: "pipeline-edge-x", title: "Remove the dependency (Delete)", "aria-label": "Remove the dependency", hidden: true, onclick: pipelineRemoveSelected }, I("x", 12));
  const labels = h("div", { class: "pipeline-labels" });
  world.append(labels, svg, removeEdge); root.append(world);
  pipeline.labels = labels;
  Object.assign(pipeline, { root, world, svg, removeEdge });
  const done = h("input", { type: "checkbox" });
  done.onchange = () => renderPipeline(); pipeline.hideDone = done;
  root.append(h("div", { class: "pipeline-controls" }, h("button", { class: "btn sm", onclick: () => pipelineFit() }, "Fit all"),
    h("button", { class: "btn sm", onclick: pipelineAutoLayout }, "Auto-layout"), h("label", {}, done, " Hide done"),
    h("span", { class: "pipeline-help" }, "Drag background to pan · scroll to zoom · drag a node to move it · double-click empty space for a new worktree · drag a handle onto a checkout to connect, onto empty space for a new worktree after it")));
  pipeline.empty = h("div", { class: "pipeline-empty" });
  root.append(pipeline.empty);
  root.addEventListener("dblclick", e => {
    if (!pipelineEmptyAt(e)) return;
    const p = pipelinePoint(e);
    pipelineCreateAt({ x: p.x - NODE_W / 2 + PORT_X, y: p.y - NODE_H / 2 + PORT_Y });
  });
  root.addEventListener("wheel", e => {
    e.preventDefault(); const p = pipelinePoint(e);
    pipeline.zoom = Math.max(.15, Math.min(2, pipeline.zoom * Math.exp(-e.deltaY * .002)));
    const r = root.getBoundingClientRect(); pipeline.x = e.clientX - r.left - p.x * pipeline.zoom; pipeline.y = e.clientY - r.top - p.y * pipeline.zoom; pipelineTransform();
  }, { passive: false });
  root.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest(".pipeline-controls,.pipeline-edge,.pipeline-edge-x")) return;
    const port = e.target.closest("[data-port]"), node = e.target.closest(".pipeline-node");
    if (!port && e.target.closest("button,a")) return;
    if (port) {
      pipeline.gesture = { kind: "connect", key: node.dataset.key, port: port.dataset.port, cx: e.clientX, cy: e.clientY };
      pipeline.preview = pipelineSVG("path", { class: "pipeline-preview" }); svg.append(pipeline.preview);
    } else if (node) pipeline.gesture = { kind: "node", key: node.dataset.key, node, p: pipelinePoint(e), original: { ...placeOf(node.dataset.key) }, moved: false };
    else pipeline.gesture = { kind: "pan", cx: e.clientX, cy: e.clientY, x: pipeline.x, y: pipeline.y, moved: false };
    root.setPointerCapture(e.pointerId);
    if (pipeline.gesture.kind !== "pan") e.preventDefault();
  });
  root.addEventListener("pointermove", e => {
    const g = pipeline.gesture; if (!g) return;
    const p = pipelinePoint(e);
    if (g.kind === "pan") {
      if (Math.hypot(e.clientX - g.cx, e.clientY - g.cy) > 4) g.moved = true;
      if (g.moved) { pipeline.x = g.x + e.clientX - g.cx; pipeline.y = g.y + e.clientY - g.cy; pipelineTransform(); }
    }
    if (g.kind === "node") {
      if (Math.hypot(p.x - g.p.x, p.y - g.p.y) * pipeline.zoom > 4) g.moved = true;
      if (g.moved) {
        const pos = { x: Math.round(g.original.x + p.x - g.p.x), y: Math.round(g.original.y + p.y - g.p.y) };
        pipeline.local.set(g.key, pos);
        g.node.style.transform = `translate(${pos.x}px,${pos.y}px)`;
        pipelineDrawEdges();
      }
    }
    if (g.kind === "connect") {
      const pos = placeOf(g.key), input = g.port === "in";
      pipeline.preview.setAttribute("d", pipelineCurve(input ? p : { x: pos.x + NODE_W - PORT_X, y: pos.y + PORT_Y }, input ? { x: pos.x + PORT_X, y: pos.y + PORT_Y } : p));
      if (g.port === "out") pipelineGhost("New worktree after " + worktreeName(projectWorktrees().find(w => w.key === g.key) || { branch: g.key }),
        Math.hypot(e.clientX - g.cx, e.clientY - g.cy) > PIPELINE_SPAWN_MIN && pipelineEmptyAt(e) ? p : null);
    }
  });
  const finish = (e, cancel = false) => {
    const g = pipeline.gesture; if (!g) return;
    pipeline.gesture = null; pipeline.preview?.remove(); pipelineGhost(null, null);
    if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    if (g.kind === "node" && g.moved) savePositions({ [g.key]: pipeline.local.get(g.key) });
    else if (!cancel && g.kind === "node") openPanel(g.key);
    if (!cancel && g.kind === "pan" && !g.moved) { pipelineSelect(null); closeMenu(); }
    if (!cancel && g.kind === "connect") pipelineConnect(g, e);
    renderPipeline();
  };
  root.addEventListener("pointerup", e => finish(e)); root.addEventListener("pointercancel", e => finish(e, true));
  return root;
}
document.addEventListener("keydown", e => {
  if (boardView !== "pipeline" || !pipeline.selected || isTyping() || modals.length) return;
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); pipelineRemoveSelected(); }
  else if (e.key === "Escape") pipelineSelect(null);
});

// MARK: render
function pipelineNode(w) {
  let node = pipeline.nodes.get(w.key);
  if (!node) {
    node = h("article", { class: "pipeline-node", "data-key": w.key, tabindex: "0", title: w.path,
      onkeydown: cardKey(w) });
    pipeline.nodes.set(w.key, node); pipeline.world.append(node);
  }
  const content = JSON.stringify([w, hiddenBranch(w.branch), [...pending].filter(k => k.endsWith(":" + w.path))]);
  if (node.dataset.content !== content) {
    node.dataset.content = content;
    const head = [worktreeChip(w), tagRow(w), w.pr ? h("span", { class: "spacer" }) : null, w.pr ? prChip(w.pr) : null].filter(Boolean);
    node.replaceChildren(head.length ? h("div", { class: "pipeline-node-head" }, ...head) : "",
      h("strong", { class: "pipeline-title" }, ...titleEl(w)), stateEl(worktreeStatus(w)), worktreeActions(w));
    for (const port of ["in", "out"]) node.append(h("button", { class: "pipeline-port " + port, "data-port": port,
      title: port === "in" ? "Drag onto a checkout it depends on" : "Drag onto a checkout that depends on it, or onto empty space for a new worktree",
      "aria-label": port === "in" ? "Prerequisite connection" : "Dependent connection" }));
  }
  const running = w.agents || [], links = pipelineLinks();
  node.dataset.column = w.column;
  node.classList.toggle("running", running.length > 0);
  node.classList.toggle("needs", running.some(needsYou));
  node.classList.toggle("done", w.column === "done");
  node.classList.toggle("is-hidden", hiddenBranch(w.branch));
  node.querySelector(".pipeline-port.in").classList.toggle("connected", links.some(l => l.to === w.key));
  node.querySelector(".pipeline-port.out").classList.toggle("connected", links.some(l => l.from === w.key));
  const p = placeOf(w.key); node.style.transform = `translate(${p.x}px,${p.y}px)`;
}
function renderPipeline() {
  if (!board || boardView !== "pipeline") return;
  if (!pipeline.root) pipelineInit();
  const host = $("#board");
  if (pipeline.root.parentNode !== host) host.replaceChildren(pipeline.root);
  if (pipeline.gesture) return;
  if (pipeline.scope !== projectSel) { pipeline.scope = projectSel; pipeline.local.clear(); pipeline.selected = null; pipeline.fit = true; }
  const all = projectWorktrees(), trees = pipelineVisible();
  pipelinePlace(trees);
  pipelineLabels(trees);
  pipeline.empty.hidden = trees.length > 0;
  pipeline.empty.textContent = all.length ? "No matching worktrees. Change the filter to see them." : "No checkouts in this project.";
  const keys = new Set(trees.map(w => w.key));
  for (const [key, node] of pipeline.nodes) if (!keys.has(key)) { node.remove(); pipeline.nodes.delete(key); }
  for (const w of trees) pipelineNode(w);
  const byKey = new Map(trees.map(w => [w.key, w])), edgeKeys = new Set();
  for (const l of pipelineLinks()) {
    const source = byKey.get(l.from), target = byKey.get(l.to);
    if (!source || !target) continue;
    const key = l.from + "\n" + l.to; edgeKeys.add(key);
    let edge = pipeline.edges.get(key);
    if (!edge) {
      const group = pipelineSVG("g", { class: "pipeline-edge" }), path = pipelineSVG("path", { class: "edge-line" }), hit = pipelineSVG("path", { class: "edge-hit", role: "button" });
      group.append(path, hit); pipeline.svg.append(group);
      edge = { key, from: l.from, to: l.to, group, path, hit }; pipeline.edges.set(key, edge);
    }
    edge.hit.onclick = l.madeFrom ? null : () => pipelineSelect(key);
    edge.hit.onkeydown = l.madeFrom ? null : e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pipelineSelect(key); } };
    edge.hit.setAttribute("tabindex", l.madeFrom ? "-1" : "0");
    edge.group.classList.toggle("complete", source.column === "done");
    edge.group.classList.toggle("started", source.column === "pr");
    edge.group.classList.toggle("active", (source.agents || []).some(a => AGENT_LABEL[a.state]));
    edge.hit.setAttribute("aria-label", `${worktreeName(target)} ${l.madeFrom ? "is made from" : "depends on"} ${worktreeName(source)} · ${columnTitle(source.column)}`);
  }
  for (const [key, edge] of pipeline.edges) if (!edgeKeys.has(key)) { edge.group.remove(); pipeline.edges.delete(key); }
  if (!pipeline.edges.has(pipeline.selected)) pipeline.selected = null;
  pipelineDrawEdges(); pipelineTransform();
  if (pipeline.fit && trees.length) { pipeline.fit = false; requestAnimationFrame(() => pipelineFit(true)); }
}
