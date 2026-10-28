"use strict";
// MARK: pipeline canvas
const pipeline = { positions: new Map(), nodes: new Map(), edges: new Map(), x: 40, y: 60, zoom: 1, gesture: null, selected: null, scope: null };
let boardView = LS.get("boardView") === "pipeline" ? "pipeline" : "board";
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
function pipelineLayout(tasks) {
  const missing = tasks.filter(t => !pipeline.positions.has(t.id));
  if (!missing.length) return;
  const positions = layoutTaskGraph(tasks);
  for (const t of missing) {
    const p = positions.get(t.id);
    while ([...pipeline.positions.values()].some(other =>
      Math.abs(other.x - p.x) < 340 && Math.abs(other.y - p.y) < 210)) p.y += 210;
    pipeline.positions.set(t.id, p);
  }
}
function pipelineCurve(a, b) {
  const bend = Math.max(60, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + bend},${a.y} ${b.x - bend},${b.y} ${b.x},${b.y}`;
}
function pipelineDrawEdges() {
  for (const edge of pipeline.edges.values()) {
    const a = pipeline.positions.get(edge.from), b = pipeline.positions.get(edge.to);
    const d = pipelineCurve({ x: a.x + 245, y: a.y + 65 }, { x: b.x + 15, y: b.y + 65 });
    edge.path.setAttribute("d", d); edge.hit.setAttribute("d", d);
    edge.group.classList.toggle("selected", pipeline.selected === edge.key);
  }
}
function pipelineFit() {
  const ps = [...pipeline.nodes.keys()].map(id => pipeline.positions.get(id));
  if (!ps.length) return;
  const minX = Math.min(...ps.map(p => p.x)), minY = Math.min(...ps.map(p => p.y));
  const w = Math.max(...ps.map(p => p.x)) + 260 - minX, ht = Math.max(...ps.map(p => p.y)) + 130 - minY;
  pipeline.zoom = Math.min(1, Math.max(.15, Math.min((pipeline.root.clientWidth - 80) / w, (pipeline.root.clientHeight - 120) / ht)));
  pipeline.x = (pipeline.root.clientWidth - w * pipeline.zoom) / 2 - minX * pipeline.zoom;
  pipeline.y = 80 - minY * pipeline.zoom;
  pipelineTransform();
}
function pipelineAnimateConnection(edge) {
  if (!edge || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const length = edge.path.getTotalLength();
  const stroke = getComputedStyle(edge.path).stroke;
  edge.path.animate([
    { strokeDasharray: `${length} ${length}`, strokeDashoffset: length, stroke, opacity: 1, strokeWidth: 4 },
    { strokeDasharray: `${length} ${length}`, strokeDashoffset: 0, stroke, opacity: 1, strokeWidth: 4 },
  ], { duration: Math.min(1200, Math.max(700, length * .8)), easing: "linear" });
}
async function pipelineChange(from, to, previous = null) {
  const task = findTask(to);
  if (!task || from === to || (previous && previous.from === from && previous.to === to)) return;
  if (!previous && task.dependsOn.includes(from)) return;
  if (previous && previous.to !== to) { toast("Reconnect the prerequisite end, or remove this connection first", true); return; }
  const deps = task.dependsOn.filter(id => !previous || id !== previous.from);
  if (from) deps.push(from);
  const removedBlocker = previous && task.blockedBy.includes(previous.from) && !deps.some(id => findTask(id)?.column !== "done");
  const warning = removedBlocker && task.column === "todo" ? "This may start or resume the queued task immediately. " : "";
  const running = task.column === "doing" ? "Changing dependencies does not pause an already running task. " : "";
  if ((warning || running) && !confirm(warning + running + "Change this dependency?")) return;
  try {
    const updated = await act("PATCH", tpath(to), { dependsOn: [...new Set(deps)] });
    const current = findTask(to);
    if (current && updated?.id === to) Object.assign(current, updated);
    pipeline.selected = null;
    renderPipeline();
    if (from) pipelineAnimateConnection(pipeline.edges.get(from + ":" + to));
  }
  catch {}
}
function pipelineInit() {
  const root = h("div", { class: "pipeline", tabindex: "0", "aria-label": "Task dependency pipeline" });
  const world = h("div", { class: "pipeline-world" });
  const svg = pipelineSVG("svg", { class: "pipeline-lines" });
  world.append(svg); root.append(world);
  Object.assign(pipeline, { root, world, svg });
  const controls = h("div", { class: "pipeline-controls" });
  controls.append(h("button", { class: "btn sm", onclick: pipelineFit }, "Fit all"), h("button", { class: "btn sm", onclick: () => { pipeline.positions.clear(); renderPipeline(); pipelineFit(); } }, "Auto-layout"));
  controls.append(h("button", { class: "btn sm", onclick: () => {
    const p = pipeline.positions.get(openId);
    if (!p || !pipeline.nodes.has(openId)) { toast("Open a visible task to focus it"); return; }
    pipeline.zoom = 1;
    pipeline.x = pipeline.root.clientWidth / 2 - p.x - 130;
    pipeline.y = pipeline.root.clientHeight / 2 - p.y - 65;
    pipelineTransform();
  } }, "Focus task"));
  const done = h("input", { type: "checkbox" });
  done.onchange = () => renderPipeline(); pipeline.hideDone = done;
  controls.append(h("label", {}, done, " Hide done"), h("span", { class: "pipeline-help" }, "Drag background to pan · scroll to zoom · drag handles to connect"));
  const remove = h("button", { class: "btn sm danger", hidden: true, onclick: () => { const edge = pipeline.edges.get(pipeline.selected); if (edge) pipelineChange(null, edge.to, edge); } }, "Remove connection");
  pipeline.remove = remove; controls.append(remove); root.append(controls);
  pipeline.empty = h("div", { class: "pipeline-empty" }, "No matching tasks. Create a task or change the filter.");
  root.append(pipeline.empty);
  root.addEventListener("dblclick", e => {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const node = hit?.closest(".pipeline-node");
    if (node && !hit.closest("button,[data-port]")) openPanel(node.dataset.id, true);
    else if (!hit?.closest(".pipeline-node,.pipeline-controls,.pipeline-edge")) openTaskPrompt();
  });
  root.addEventListener("wheel", e => {
    e.preventDefault(); const p = pipelinePoint(e);
    pipeline.zoom = Math.max(.15, Math.min(2, pipeline.zoom * Math.exp(-e.deltaY * .002)));
    const r = root.getBoundingClientRect(); pipeline.x = e.clientX - r.left - p.x * pipeline.zoom; pipeline.y = e.clientY - r.top - p.y * pipeline.zoom; pipelineTransform();
  }, { passive: false });
  root.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest(".pipeline-controls")) return;
    const handle = e.target.closest("[data-port]"), node = e.target.closest(".pipeline-node");
    if (e.target.closest(".pipeline-edge")) return;
    const p = pipelinePoint(e);
    if (handle) {
      const selected = pipeline.edges.get(pipeline.selected);
      const edge = handle.dataset.port === "in" && selected?.to === node.dataset.id ? selected : null;
      pipeline.gesture = { kind: "connect", from: edge ? null : node.dataset.id, to: edge?.to, previous: edge, port: handle.dataset.port, cx: e.clientX, cy: e.clientY };
      pipeline.preview = pipelineSVG("path", { class: "pipeline-preview" }); svg.append(pipeline.preview);
    } else if (node) {
      if (e.target.closest("button")) return;
      pipeline.gesture = { kind: "node", id: node.dataset.id, p, original: { ...pipeline.positions.get(node.dataset.id) }, moved: false };
    } else pipeline.gesture = { kind: "pan", cx: e.clientX, cy: e.clientY, x: pipeline.x, y: pipeline.y, moved: false };
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
      if (Math.hypot(p.x - g.p.x, p.y - g.p.y) > 4) g.moved = true;
      if (g.moved) { const pos = { x: g.original.x + p.x - g.p.x, y: g.original.y + p.y - g.p.y }; pipeline.positions.set(g.id, pos); pipeline.nodes.get(g.id).style.transform = `translate(${pos.x}px,${pos.y}px)`; pipelineDrawEdges(); }
    }
    if (g.kind === "connect") {
      const pos = pipeline.positions.get(g.to || g.from), input = g.port === "in";
      pipeline.preview.setAttribute("d", pipelineCurve(input ? p : { x: pos.x + 245, y: pos.y + 65 }, input ? { x: pos.x + 15, y: pos.y + 65 } : p));
    }
  });
  const finish = (e, cancel = false) => {
    const g = pipeline.gesture; if (!g) return;
    pipeline.gesture = null; pipeline.preview?.remove();
    if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    if (!cancel && g.kind === "node" && !g.moved) openPanel(g.id);
    if (!cancel && g.kind === "pan" && !g.moved) { pipeline.selected = null; closePanel(); }
    if (!cancel && g.kind === "connect") {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const target = hit?.closest(".pipeline-node");
      if (target) pipelineChange(g.port === "in" ? target.dataset.id : g.from, g.port === "in" ? (g.to || g.from) : target.dataset.id, g.previous);
      else if (!g.previous && hit && root.contains(hit) && !hit.closest(".pipeline-controls,.pipeline-edge") &&
        Math.hypot(e.clientX - g.cx, e.clientY - g.cy) > 5) {
        openTaskPrompt({ task: findTask(g.from), relation: g.port === "in" ? "before" : "after" });
      }
    }
    renderPipeline();
  };
  root.addEventListener("pointerup", e => finish(e)); root.addEventListener("pointercancel", e => finish(e, true));
  return root;
}
function renderPipeline() {
  if (!board || boardView !== "pipeline") return;
  if (!pipeline.root) pipelineInit();
  const host = $("#board");
  if (pipeline.root.parentNode !== host) host.replaceChildren(pipeline.root);
  if (pipeline.gesture) return;
  const scope = flowSel || "all";
  if (pipeline.scope !== scope) { pipeline.positions.clear(); pipeline.scope = scope; pipeline.fit = true; }
  const all = board.tasks.filter(inFlow);
  const tasks = all.filter(t => matches(t) && (!pipeline.hideDone.checked || t.column !== "done"));
  pipelineLayout(tasks);
  const ids = new Set(tasks.map(t => t.id));
  pipeline.empty.hidden = tasks.length > 0;
  for (const [id, node] of pipeline.nodes) if (!ids.has(id)) { node.remove(); pipeline.nodes.delete(id); }
  const prerequisites = new Set(all.flatMap(t => t.dependsOn));
  for (const t of tasks) {
    let node = pipeline.nodes.get(t.id);
    if (!node) {
      node = h("article", { class: "pipeline-node", "data-id": t.id, tabindex: "0", onkeydown: e => { if (e.key === "Enter") openPanel(t.id); } });
      pipeline.nodes.set(t.id, node); pipeline.world.append(node);
    }
    const content = JSON.stringify([t.title, t.column, t.agent, t.spawn, t.blockedBy, t.waitingForSlot, t.paused, t.plan, t.merged, t.base]);
    if (node.dataset.content !== content) {
      node.dataset.content = content;
      const info = statusOf(t), line = cardLine(t);
      node.replaceChildren(h("div", { class: "pipeline-node-head" }, taskNumber(t.id), h("span", {}, colTitle(t.column))), h("strong", { class: "pipeline-title" }, t.title), info ? stateEl(info) : h("span", {}, colTitle(t.column)), h("div", { class: "pipeline-step", title: line?.text || "" }, line?.text || ""));
      for (const port of ["in", "out"]) node.append(h("button", { class: "pipeline-port " + port, "data-port": port, title: port === "in" ? "Drag to choose a prerequisite" : "Drag to a dependent task", "aria-label": port === "in" ? "Prerequisite connection" : "Dependent connection" }));
    }
    node.dataset.column = t.column;
    node.classList.toggle("running", t.column === "doing" && !t.paused && (sessionConnected(t) || t.execution?.state === "running"));
    node.querySelector(".pipeline-port.in").classList.toggle("connected", t.dependsOn.length > 0);
    node.querySelector(".pipeline-port.out").classList.toggle("connected", prerequisites.has(t.id));
    node.classList.toggle("busy", t.column === "doing" && !!t.agent && !!AGENT_LABEL[t.agent.state]);
    node.classList.toggle("done", t.column === "done");
    node.classList.toggle("blocked", t.blockedBy.length > 0 && t.column === "todo");
    node.classList.toggle("needs", needsAttention(t));
    node.classList.toggle("sel", t.id === openId);
    node.classList.toggle("dep-highlight", t.id === highlightedDependency);
    const p = pipeline.positions.get(t.id); node.style.transform = `translate(${p.x}px,${p.y}px)`;
  }
  const keys = new Set();
  const activeTargets = new Set(tasks.filter(t => t.column === "doing" && !t.paused && sessionConnected(t) &&
    !needsAttention(t) && t.dependsOn.every(id => findTask(id)?.column === "done")).map(t => t.id));
  for (const t of tasks) for (const from of t.dependsOn) {
    if (!ids.has(from)) continue;
    const key = from + ":" + t.id; keys.add(key);
    let edge = pipeline.edges.get(key);
    if (!edge) {
      const group = pipelineSVG("g", { class: "pipeline-edge" }), path = pipelineSVG("path", { class: "edge-line" }), hit = pipelineSVG("path", { class: "edge-hit", tabindex: "0", role: "button", "aria-label": `${taskNumber(from)} must finish before ${taskNumber(t.id)}` });
      const select = () => { pipeline.selected = key; pipeline.remove.hidden = false; pipelineDrawEdges(); };
      hit.onclick = select; hit.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); } };
      group.append(path, hit); pipeline.svg.append(group);
      edge = { key, from, to: t.id, group, path, hit }; pipeline.edges.set(key, edge);
    }
    const source = findTask(from);
    const complete = source.column === "done";
    const active = source.column === "doing" && !!source.agent && !!AGENT_LABEL[source.agent.state];
    edge.group.classList.toggle("active", active);
    edge.group.classList.toggle("complete", complete);
    edge.group.classList.toggle("history", t.column === "done");
    edge.group.classList.toggle("active-path", activeTargets.has(t.id));
    edge.hit.setAttribute("aria-label", `${taskNumber(from)} must finish before ${taskNumber(t.id)} · ${complete ? "Prerequisite complete" : active ? "Prerequisite working" : "Waiting"}${activeTargets.has(t.id) ? " · Active path" : ""}`);
  }
  for (const [key, edge] of pipeline.edges) if (!keys.has(key)) { edge.group.remove(); pipeline.edges.delete(key); }
  pipeline.remove.hidden = !pipeline.edges.has(pipeline.selected);
  pipelineDrawEdges(); pipelineTransform();
  highlightDependencyPath();
  if (pipeline.fit) { pipeline.fit = false; requestAnimationFrame(pipelineFit); }
}
