"use strict";
// MARK: saved flow page
const FX_PAD = 40;
// The saved page's own script: the graph opens fitted to the width; pinch or ⌘-scroll zooms, dragging pans, double-click fits again.
const FX_SCRIPT = `
const graph = document.querySelector(".fx-graph"), world = graph && graph.firstElementChild;
if (world) {
  const W = world.offsetWidth, H = world.offsetHeight;
  let k = 1, x = 0, y = 0, drag = null;
  const apply = () => { world.style.transform = "translate(" + x + "px," + y + "px) scale(" + k + ")"; };
  const fit = () => { k = Math.min(1, graph.clientWidth / W); graph.style.height = Math.max(H * k, 240) + "px"; x = (graph.clientWidth - W * k) / 2; y = (graph.clientHeight - H * k) / 2; apply(); };
  graph.addEventListener("wheel", e => {
    if (e.ctrlKey || e.metaKey) {
      const r = graph.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, next = Math.max(0.1, Math.min(2, k * Math.exp(-e.deltaY * 0.005)));
      x = px - (px - x) * next / k; y = py - (py - y) * next / k; k = next;
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) x -= e.deltaX;
    else return;
    e.preventDefault(); apply();
  }, { passive: false });
  graph.addEventListener("pointerdown", e => { if (e.button === 0) drag = { cx: e.clientX, cy: e.clientY, x, y, moved: false }; });
  addEventListener("pointermove", e => { if (!drag) return; const dx = e.clientX - drag.cx, dy = e.clientY - drag.cy; if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true; if (drag.moved) { x = drag.x + dx; y = drag.y + dy; apply(); } });
  addEventListener("pointerup", () => setTimeout(() => { drag = null; }));
  graph.addEventListener("click", e => { if (drag && drag.moved) { e.preventDefault(); e.stopPropagation(); } }, true);
  graph.addEventListener("dblclick", fit);
  addEventListener("resize", fit); fit();
}
document.addEventListener("click", e => { const a = e.target.closest('a[href^="#task-"]'); const d = a && document.getElementById(a.getAttribute("href").slice(1)); if (d) d.open = true; });
`;

let fxSaving = false;
async function saveFlow() {
  const tasks = board.tasks.filter(inFlow);
  if (!tasks.length) { toast("This flow has no tasks yet", true); return; }
  if (fxSaving) return;
  fxSaving = true;
  toast("Saving the flow…");
  try {
    const recap = await api("POST", "/api/flows/recap", { flow: flowSel });
    const saved = await api("POST", "/api/exports", { flow: flowSel, html: flowPage(tasks, recap.tasks, flowPageCss()) });
    // cmux's browser opens it as a new surface but returns no window, and a slow save can lose a browser's click allowance: the toast links it too.
    window.open(saved.url, "_blank");
    toast(h("span", {}, "Saved to ", h("span", { class: "mono" }, saved.path), " · ", h("a", { href: saved.url, target: "_blank", rel: "noopener" }, "Open")), false, 10000);
  } catch (e) {
    toast(e.message, true);
  } finally {
    fxSaving = false;
  }
}

// The board loads flow-export.css with this script, so the page's markup and styles always come from the same version.
function flowPageCss() {
  return [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules].map(r => r.cssText); } catch { return []; } }).join("\n");
}

const FX_COLUMNS = { todo: "Queued in Todo", doing: "In progress, agent idle", review: "In review" };
const FX_UNRECORDED = "In progress, no agent session found";

/** A task's time on the board: the stretches it spent queued, in progress or in review, when its agent worked, and its merge. */
function taskTimeline(t, facts, now) {
  const end = Date.parse(t.merged?.at || (t.column === "done" && (facts?.closedAt || t.updatedAt)) || "") || now;
  const changes = (facts?.columns ?? []).map(c => ({ at: Date.parse(c.at), column: c.column }));
  if (!changes.length && (facts?.startedAt || hasStarted(t))) changes.push({ at: Date.parse(facts?.startedAt || t.createdAt), column: "doing" });
  const segments = changes.map((c, i) => ({ column: c.column, start: c.at, end: Math.min(changes[i + 1]?.at ?? end, end) }))
    .filter(s => FX_COLUMNS[s.column] && s.end > s.start);
  const work = (facts?.activity ?? []).map(([a, b]) => ({ start: Date.parse(a), end: Date.parse(b) }));
  if (!segments.length && !work.length) return null;
  const total = (list, column) => list.filter(s => !column || s.column === column).reduce((n, s) => n + s.end - s.start, 0);
  return {
    segments, work, merged: t.merged?.at ? Date.parse(t.merged.at) : null,
    start: Math.min(...segments.map(s => s.start), ...work.map(w => w.start)), end: Math.max(...segments.map(s => s.end), ...work.map(w => w.end)),
    began: segments.find(s => s.column === "doing")?.start ?? null, finished: t.column === "done" ? end : null,
    worked: total(work), queued: total(segments, "todo"), progress: total(segments, "doing"), review: total(segments, "review"),
  };
}

function spanText(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 600) return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

const fxDay = ms => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fxWhen = ms => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function fxNodeFacts(t, merge, line) {
  const change = merge ? [`+${merge.added} \u2212${merge.removed}`, merge.commits && plural(merge.commits, "commit")]
    : t.git && (t.git.added || t.git.removed) ? [`+${t.git.added} \u2212${t.git.removed}`] : [];
  return [...change, line?.work.length && `agent ${spanText(line.worked)}`].filter(Boolean).join(" · ");
}

/** The flow's graph at its on-screen positions (else a fresh layout), built off-screen so started lines can be measured for their dashes. */
function flowGraph(tasks, facts, lines) {
  const ids = new Set(tasks.map(t => t.id));
  const placed = tasks.every(t => pipeline.positions.has(t.id)) ? pipeline.positions : layoutTaskGraph(tasks);
  const ps = tasks.map(t => placed.get(t.id));
  const minX = Math.min(...ps.map(p => p.x)), minY = Math.min(...ps.map(p => p.y));
  const at = id => ({ x: placed.get(id).x - minX + FX_PAD, y: placed.get(id).y - minY + FX_PAD });
  const width = Math.max(...ps.map(p => p.x)) - minX + 260 + 2 * FX_PAD, height = Math.max(...ps.map(p => p.y)) - minY + 130 + 2 * FX_PAD;
  const svg = pipelineSVG("svg", { class: "pipeline-lines" });
  const world = h("div", { class: "pipeline-world", style: `width:${width}px;height:${height}px` }, svg);
  const host = h("div", { style: "position:fixed;left:-100000px;top:0;visibility:hidden" }, world);
  document.body.append(host);
  try {
    const prerequisites = new Set(tasks.flatMap(t => t.dependsOn));
    for (const t of tasks) {
      const p = at(t.id);
      world.append(h("a", { class: `pipeline-node${t.column === "done" ? " done" : ""}`, href: `#task-${t.id}`, draggable: "false", "data-column": t.column, style: `transform:translate(${p.x}px,${p.y}px)` },
        ...pipelineNodeParts(t), h("div", { class: "pipeline-step" }, fxNodeFacts(t, facts[t.id]?.merge, lines.get(t.id))),
        h("span", { class: `pipeline-port in${t.dependsOn.length ? " connected" : ""}` }), h("span", { class: `pipeline-port out${prerequisites.has(t.id) ? " connected" : ""}` })));
      for (const from of t.dependsOn) {
        if (!ids.has(from)) continue;
        const a = at(from), state = pipelineEdgeState(findTask(from));
        const path = pipelineSVG("path", { class: "edge-line", d: pipelineCurve({ x: a.x + 245, y: a.y + 65 }, { x: p.x + 15, y: p.y + 65 }) });
        const group = pipelineSVG("g", { class: ["pipeline-edge", ...Object.keys(state).filter(k => state[k])].join(" ") });
        group.append(path); svg.append(group);
        if (state.started) path.style.strokeDasharray = pipelineHalfDash(path);
      }
    }
    return world.outerHTML;
  } finally {
    host.remove();
  }
}

/** Ticks for the timeline: the smallest whole-hour or whole-day step that keeps about ten of them, on round hours or midnights. */
function fxTicks(from, to) {
  const HOUR = 3600000;
  const hours = [1, 2, 3, 6, 12, 24, 48, 72, 168, 336, 720].find(n => (to - from) / (n * HOUR) <= 10) ?? 24 * Math.ceil((to - from) / (240 * HOUR));
  const tick = new Date(from);
  tick.setMinutes(0, 0, 0);
  tick.setHours(hours >= 24 ? 0 : tick.getHours() - tick.getHours() % hours);
  const ticks = [];
  for (; tick.getTime() < to; hours >= 24 ? tick.setDate(tick.getDate() + hours / 24) : tick.setHours(tick.getHours() + hours)) {
    const at = tick.getTime();
    if (at > from) ticks.push({ at, label: hours >= 24 || tick.getHours() === 0 ? fxDay(at) : tick.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) });
  }
  return ticks;
}

function flowTimeline(rows, from, to) {
  const pct = ms => `${((ms - from) / Math.max(1, to - from) * 100).toFixed(3)}%`;
  const width = (a, b) => `${((b - a) / Math.max(1, to - from) * 100).toFixed(3)}%`;
  const swatch = (cls, label) => h("span", {}, h("span", { class: `fx-swatch ${cls}` }), label);
  return h("div", { class: "fx-timeline" },
    h("div", { class: "fx-row fx-axis-row" }, h("span"), h("span", { class: "fx-axis" }, fxTicks(from, to).map(t => h("span", { style: `left:${pct(t.at)}` }, t.label)))),
    rows.map(({ t, line }) => h("a", { class: "fx-row", href: `#task-${t.id}` },
      h("span", { class: "fx-row-label" }, h("span", { class: "mono" }, taskNumber(t.id)), " ", t.title),
      h("span", { class: "fx-track" }, line ? [
        ...line.segments.map(s => {
          const unrecorded = s.column === "doing" && !line.work.length;
          return h("span", { class: `fx-seg ${s.column}${unrecorded ? " unrecorded" : ""}`, style: `left:${pct(s.start)};width:${width(s.start, s.end)}`, title: `${unrecorded ? FX_UNRECORDED : FX_COLUMNS[s.column]} · ${fxWhen(s.start)} → ${fxWhen(s.end)}` });
        }),
        ...line.work.map(w => h("span", { class: "fx-work", style: `left:${pct(w.start)};width:${width(w.start, w.end)}`, title: `Agent working · ${fxWhen(w.start)} → ${fxWhen(w.end)}` })),
        line.merged ? h("span", { class: "fx-merged", style: `left:${pct(line.merged)}`, title: `Merged ${fxWhen(line.merged)}` }) : null,
      ] : h("span", { class: "fx-none" }, "Not started")))),
    h("div", { class: "fx-row fx-legend" }, h("span"), h("span", {},
      swatch("fx-work", "agent working"), swatch("fx-seg doing", "in progress, agent idle"), swatch("fx-seg todo", "queued in Todo"),
      swatch("fx-seg review", "in review"), swatch("fx-merged", "merged"),
      rows.some(r => r.line && !r.line.work.length && r.line.segments.some(s => s.column === "doing")) ? swatch("fx-seg doing unrecorded", FX_UNRECORDED.toLowerCase()) : null)));
}

function flowTask(t, facts, line) {
  const merge = facts?.merge;
  const links = ids => ids.flatMap((id, i) => [i ? ", " : null, h("a", { href: `#task-${id}` }, taskNumber(id))]);
  const meta = [
    ["Status", colTitle(t.column)],
    t.merged && ["Merged into", t.merged.sha ? `${t.merged.into} at ${t.merged.sha.slice(0, 7)}` : t.merged.into],
    ["Branch", t.branch],
    line?.began && ["Started", fxWhen(line.began)],
    line?.finished && ["Finished", fxWhen(line.finished)],
    line?.work.length && ["Agent worked", spanText(line.worked)],
    line?.queued && ["Queued in Todo", spanText(line.queued)],
    line?.progress && ["In progress", spanText(line.progress)],
    line?.review && ["In review", spanText(line.review)],
    t.planningOutcome && ["Planning", t.planningOutcome === "plan" ? "Planned first" : "Direct"],
    merge && ["Change", `${plural(merge.files, "file")}, +${merge.added} \u2212${merge.removed}${merge.commits ? `, ${plural(merge.commits, "commit")}` : ""}`],
    t.dependsOn.length && ["Depends on", links(t.dependsOn)],
    t.pr && ["Pull request", h("a", { href: t.pr.url, target: "_blank", rel: "noopener" }, `#${t.pr.number}`)],
  ].filter(Boolean);
  return h("details", { class: "fx-task", id: `task-${t.id}` },
    h("summary", {}, h("span", { class: "mono fx-id" }, taskNumber(t.id)), h("span", { class: "fx-task-title" }, t.title), merge ? diffstat(merge) : null),
    h("dl", { class: "fx-meta" }, meta.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    facts?.outcome ? h("div", { class: "fx-block" }, h("h3", {}, "Outcome"), h("div", { class: "md", html: md(facts.outcome) })) : null,
    t.description ? h("details", { class: "fx-more" }, h("summary", {}, "Description"), h("div", { class: "md", html: md(t.description) })) : null,
    t.plan ? h("details", { class: "fx-more" }, h("summary", {}, "Plan"), h("div", { class: "md", html: md(t.plan) })) : null);
}

/** The whole page: headline numbers, the graph, a timeline of each task's columns and agent work, then every task's details. */
function flowPage(tasks, facts, css) {
  const flow = board.flows.find(f => f.id === flowSel);
  const now = Date.now();
  const lines = new Map(tasks.map(t => [t.id, taskTimeline(t, facts[t.id], now)]));
  const rows = tasks.map(t => ({ t, line: lines.get(t.id) }))
    .sort((a, b) => (a.line?.start ?? Infinity) - (b.line?.start ?? Infinity) || a.t.id.localeCompare(b.t.id, undefined, { numeric: true }));
  const timed = rows.map(r => r.line).filter(Boolean);
  const from = timed.length ? Math.min(...timed.map(l => l.start)) : null;
  const to = timed.length ? Math.max(...timed.map(l => l.end)) : null;
  const worked = timed.reduce((n, l) => n + l.worked, 0);
  const merges = tasks.map(t => facts[t.id]?.merge).filter(Boolean);
  const sum = key => merges.reduce((n, m) => n + (m[key] ?? 0), 0);
  const done = tasks.filter(t => t.column === "done").length;
  const planned = tasks.filter(t => t.planningOutcome === "plan").length, direct = tasks.filter(t => t.planningOutcome === "fast").length;
  const stat = (value, label, cls) => h("div", {}, h("dt", {}, label), h("dd", { class: cls }, value));
  const range = from === null ? "" : fxDay(from) === fxDay(to) ? fxDay(from) : `${fxDay(from)} – ${fxDay(to)}`;
  const body = h("body", { class: "fx" },
    h("header", { class: "fx-head" },
      h("div", {}, h("h1", {}, flow?.base ?? flowSel), h("p", {}, [flow?.name, range, from !== null && spanText(to - from)].filter(Boolean).join(" · "))),
      h("dl", { class: "fx-stats" },
        stat(`${done} of ${tasks.length}`, "tasks done", done === tasks.length ? "add" : null),
        worked ? stat(spanText(worked), "agents working") : null,
        merges.length ? stat(h("span", {}, h("span", { class: "add" }, `+${sum("added").toLocaleString()}`), " ", h("span", { class: "remove" }, `\u2212${sum("removed").toLocaleString()}`)), `lines in ${plural(merges.length, "merge")}`) : null,
        merges.length ? stat(sum("commits").toLocaleString(), "commits") : null,
        planned + direct ? stat(`${planned} / ${direct}`, "planned first / direct") : null)),
    h("section", {}, h("h2", {}, "Graph"), h("div", { class: "pipeline fx-graph", html: flowGraph(tasks, facts, lines) }),
      h("p", { class: "fx-hint" }, "Pinch or \u2318-scroll to zoom · drag to pan · double-click to fit · click a task for its details")),
    from !== null ? h("section", {}, h("h2", {}, "Timeline"), flowTimeline(rows, from, to)) : null,
    h("section", {}, h("h2", {}, "Tasks"), rows.map(({ t, line }) => flowTask(t, facts[t.id], line))),
    h("footer", {}, `Saved from the Orchestrator board on ${new Date(now).toLocaleString()}`),
    h("script", { html: FX_SCRIPT }));
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(flow?.base ?? flowSel)} · Orchestrator</title><style>${css}</style></head>${body.outerHTML}</html>\n`;
}
