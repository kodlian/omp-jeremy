import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnchoredOverlay, Button, ButtonGroup, Checkbox, FormControl, IconButton } from "@primer/react";
import { QuestionIcon, ScreenFullIcon, XIcon, ZoomInIcon, ZoomOutIcon } from "@primer/octicons-react";
import { useBoard } from "./store.jsx";
import { isBusy, needsYou, upstreamOf, worktreeName } from "./model.js";
import { WorktreeNode } from "./Card.jsx";
import { NODE_H, NODE_W, PORT_X, SPAWN_MIN, edge, fitCamera, folderBoxes, halfDash, layout, placeMissing, spread } from "./graph.js";

const edgeKey = l => l.from + "\n" + l.to;
// The camera zoomed by `factor` around the view point (sx, sy).
const zoomAt = (c, sx, sy, factor) => {
  const zoom = Math.min(2, Math.max(0.15, c.zoom * factor));
  return { zoom, x: sx - (sx - c.x) * zoom / c.zoom, y: sy - (sy - c.y) * zoom / c.zoom };
};

// A free canvas of the project's checkouts: drag to place them, connect a prerequisite to what depends on it, spawn new ones off a node.
export function Graph({ trees: matching, filtered }) {
  const { view, openKey, setOpenKey, actions } = useBoard();
  const [hideDone, setHideDone] = useState(false);
  const trees = hideDone ? matching.filter(w => w.column !== "done") : matching;
  const [local, setLocal] = useState(() => new Map());
  const [heights, setHeights] = useState(() => new Map());
  const [camera, setCamera] = useState({ x: 40, y: 60, zoom: 1 });
  const [selected, setSelected] = useState(null);
  const [ghost, setGhost] = useState(null);
  const [preview, setPreview] = useState(null);
  const [help, setHelp] = useState(false);
  const root = useRef(null), gesture = useRef(null), first = useRef(true), nodes = useRef(new Map());
  const [observer] = useState(() => new ResizeObserver(entries => setHeights(h => {
    let next = null;
    for (const e of entries) {
      const key = e.target.dataset.key, height = e.target.offsetHeight;
      if (h.get(key) !== height) (next ??= new Map(h)).set(key, height);
    }
    return next || h;
  })));
  useEffect(() => () => observer.disconnect(), [observer]);
  const register = useCallback((key, el) => {
    nodes.current.set(key, el);
    observer.observe(el);
    return () => { observer.unobserve(el); if (nodes.current.get(key) === el) nodes.current.delete(key); };
  }, [observer]);

  const positions = view.project?.positions;
  const placeOf = key => local.get(key) || positions?.[key] || null;
  const heightOf = key => heights.get(key) || NODE_H;
  const measured = key => nodes.current.get(key)?.offsetHeight || NODE_H;

  // Shows `places` at once and saves them; the server's copy replaces them once saved.
  const save = async (places, reset = false) => {
    const entries = Object.entries(places);
    if (!entries.length) return;
    setLocal(m => { const n = new Map(m); for (const [k, p] of entries) n.set(k, p); return n; });
    if (await actions.savePositions(places, reset)) setLocal(m => {
      const n = new Map(m);
      for (const [k, p] of entries) if (n.get(k) === p) n.delete(k);
      return n;
    });
  };
  const fit = (readable, at = placeOf) => {
    const el = root.current, next = el && fitCamera(trees.map(w => w.key), at, measured, el.clientWidth, el.clientHeight, readable);
    if (next) setCamera(next);
  };
  const zoomBy = factor => { const el = root.current; setCamera(c => zoomAt(c, el.clientWidth / 2, el.clientHeight / 2, factor)); };

  // New checkouts get a place; the first render with nodes also untangles saved places that overlap now, then fits.
  useLayoutEffect(() => {
    const placed = placeMissing(trees, placeOf, measured);
    save(placed);
    if (!first.current || !trees.length) return;
    first.current = false;
    const at = key => placed[key] || placeOf(key);
    const moved = spread(trees.map(w => w.key), at, measured);
    save(moved);
    fit(true, key => moved[key] || at(key));
  });

  // Scrolling zooms around the pointer; React's wheel listener is passive, so this one is added by hand.
  useEffect(() => {
    const el = root.current;
    const onWheel = e => {
      if (e.target.closest(".graph-controls, .graph-zoom")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setCamera(c => zoomAt(c, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const visible = new Set(trees.map(w => w.key));
  const links = view.links.filter(l => visible.has(l.from) && visible.has(l.to) && placeOf(l.from) && placeOf(l.to));
  const selectedLink = links.find(l => edgeKey(l) === selected && !l.madeFrom);
  const remove = l => { setSelected(null); actions.setLink(l.from, l.to, false); };

  useEffect(() => {
    if (!selectedLink) return;
    const onKey = e => {
      if (e.defaultPrevented || e.target.closest?.("input, textarea, [contenteditable], [role=dialog]")) return;
      if (e.key === "Delete" || e.key === "Backspace") remove(selectedLink);
      else if (e.key === "Escape") setSelected(null);
      else return;
      e.preventDefault();
    };
    // Capture phase: an Escape here deselects the dependency before the page's Escape closes the panel.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  // MARK: geometry
  const point = e => {
    const r = root.current.getBoundingClientRect();
    return { x: (e.clientX - r.left - camera.x) / camera.zoom, y: (e.clientY - r.top - camera.y) / camera.zoom };
  };
  const portAt = (key, side) => {
    const p = placeOf(key);
    return { x: side === "out" ? p.x + NODE_W - PORT_X : p.x + PORT_X, y: p.y + heightOf(key) / 2 };
  };
  const nodeAt = e => document.elementFromPoint(e.clientX, e.clientY)?.closest(".graph-node")?.dataset.key;
  // Opens New worktree for a node at `p`, after `from` when given, with an outline where it will go.
  const createAt = (p, from) => {
    const at = { x: Math.round(p.x - PORT_X), y: Math.round(p.y - NODE_H / 2) };
    const opened = actions.newWorktree({ after: from, onCreated: key => save({ [key]: at }), onClosed: () => setGhost(null) });
    if (opened) setGhost({ at, text: from ? `New worktree after ${worktreeName(view.byKey.get(from))}` : "New worktree" });
  };

  // MARK: gestures
  // Events from Primer's overlays reach here through their portal; only the canvas's own start a gesture.
  const onPointerDown = e => {
    if (e.button !== 0 || !root.current.contains(e.target) || e.target.closest(".graph-controls, .graph-zoom, .graph-edge, .graph-edge-x")) return;
    const port = e.target.closest("[data-port]"), node = e.target.closest(".graph-node");
    if (!port && e.target.closest(":is(a, button, input, [role=button]):not(.card-open)")) return;
    const p = point(e);
    if (port) gesture.current = { kind: "connect", key: node.dataset.key, side: port.dataset.port, start: p };
    else if (node) gesture.current = { kind: "node", key: node.dataset.key, start: p, from: placeOf(node.dataset.key), moved: false };
    else gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, camera, moved: false };
    root.current.setPointerCapture(e.pointerId);
    if (port || node) e.preventDefault();
  };
  const onPointerMove = e => {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      g.moved ||= Math.hypot(dx, dy) > 3;
      setCamera({ ...g.camera, x: g.camera.x + dx, y: g.camera.y + dy });
    } else if (g.kind === "node") {
      const p = point(e);
      g.moved ||= Math.hypot(p.x - g.start.x, p.y - g.start.y) * camera.zoom > 3;
      if (!g.moved) return;
      g.to = { x: Math.round(g.from.x + p.x - g.start.x), y: Math.round(g.from.y + p.y - g.start.y) };
      setLocal(m => new Map(m).set(g.key, g.to));
    } else {
      const p = point(e), a = portAt(g.key, g.side);
      setPreview(g.side === "out" ? edge(a, p) : edge(p, a));
      const far = g.side === "out" && !nodeAt(e) && Math.hypot(p.x - g.start.x, p.y - g.start.y) > SPAWN_MIN;
      setGhost(far ? { at: { x: p.x - PORT_X, y: p.y - NODE_H / 2 }, text: `New worktree after ${worktreeName(view.byKey.get(g.key))}` } : null);
    }
  };
  const finish = (e, cancelled) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    setPreview(null);
    setGhost(null);
    if (root.current.hasPointerCapture(e.pointerId)) root.current.releasePointerCapture(e.pointerId);
    if (g.kind === "node" && g.moved) save({ [g.key]: g.to });
    if (cancelled) return;
    if (g.kind === "node" && !g.moved) setOpenKey(g.key);
    else if (g.kind === "pan" && !g.moved) { setSelected(null); setOpenKey(null); }
    else if (g.kind === "connect") {
      const target = nodeAt(e), p = point(e);
      if (target && target !== g.key) g.side === "out" ? actions.setLink(g.key, target, true) : actions.setLink(target, g.key, true);
      else if (!target && g.side === "out" && Math.hypot(p.x - g.start.x, p.y - g.start.y) > SPAWN_MIN) createAt(p, g.key);
    }
  };
  // Pointer capture makes the root every click's target, so what was double-clicked is looked up under the pointer.
  const onDoubleClick = e => {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (!root.current.contains(hit) || hit.closest(".graph-node, .graph-controls, .graph-zoom, .graph-edge, .graph-edge-x")) return;
    const p = point(e);
    createAt({ x: p.x - NODE_W / 2 + PORT_X, y: p.y });
  };

  // MARK: rendering
  const connected = side => new Set(view.links.map(l => side === "in" ? l.to : l.from));
  const hasIn = connected("in"), hasOut = connected("out");
  const upstream = upstreamOf(openKey, view.links);
  const edgePath = l => !openKey ? undefined : !upstream.has(l.to) ? "unrelated" : view.byKey.get(l.from)?.column === "done" ? "ready" : "blocked";
  const mid = selectedLink ? (() => { const a = portAt(selectedLink.from, "out"), b = portAt(selectedLink.to, "in"); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; })() : null;
  const boxes = folderBoxes(trees, placeOf, heightOf), boxed = new Set(boxes.flatMap(b => b.members));
  return (
    <div className="graph" ref={root} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={e => finish(e, false)} onPointerCancel={e => finish(e, true)} onDoubleClick={onDoubleClick}>
      <div className="graph-world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
        {boxes.map(b => (
          <div key={b.folder} className="graph-group" style={{ transform: `translate(${b.x}px, ${b.y}px)`, width: b.width, height: b.height }}>
            <span className="graph-group-h">{b.folder}</span>
          </div>
        ))}
        <svg className="graph-lines" aria-hidden={links.length ? undefined : true}>
          {links.map(l => {
            const from = view.byKey.get(l.from), key = edgeKey(l), d = edge(portAt(l.from, "out"), portAt(l.to, "in"));
            const started = from.column === "pr";
            return (
              <g key={key} className="graph-edge" data-complete={from.column === "done" || undefined} data-active={(from.agents || []).some(isBusy) || undefined}
                data-selected={key === selected || undefined} data-path={edgePath(l)} data-made={l.madeFrom || undefined}>
                <path className="edge-line" d={d} ref={el => { if (el) el.style.strokeDasharray = started ? halfDash(el.getTotalLength()) : ""; }} />
                {l.madeFrom ? null : (
                  <path className="edge-hit" d={d} role="button" tabIndex={0} aria-label={`${worktreeName(view.byKey.get(l.to))} depends on ${worktreeName(from)}`}
                    onClick={() => setSelected(key)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(key); } }} />
                )}
              </g>
            );
          })}
          {preview ? <path className="graph-preview" d={preview} /> : null}
        </svg>
        {trees.map(w => {
          const p = placeOf(w.key);
          return <GraphNode key={w.key} w={w} x={p?.x ?? 0} y={p?.y ?? 0} placed={!!p} boxed={boxed.has(w.key)} hasIn={hasIn.has(w.key)} hasOut={hasOut.has(w.key)} register={register} />;
        })}
        {ghost ? <div className="graph-ghost" style={{ transform: `translate(${ghost.at.x}px, ${ghost.at.y}px)`, width: NODE_W, height: NODE_H }}>{ghost.text}</div> : null}
        {mid ? (
          <div className="graph-edge-x" style={{ transform: `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%) scale(${1 / camera.zoom})` }}>
            <IconButton icon={XIcon} aria-label="Remove the dependency" description="Remove the dependency (Delete)" size="small" onClick={() => remove(selectedLink)} />
          </div>
        ) : null}
      </div>
      <div className="graph-controls">
        <Button size="small" onClick={() => { const places = layout(trees, measured); save(places, true); fit(true, key => places[key]); }}>Auto-layout</Button>
        <FormControl layout="horizontal">
          <Checkbox checked={hideDone} onChange={e => setHideDone(e.target.checked)} />
          <FormControl.Label>Hide done</FormControl.Label>
        </FormControl>
        <AnchoredOverlay open={help} onOpen={() => setHelp(true)} onClose={() => setHelp(false)} side="outside-bottom" align="start"
          renderAnchor={props => <IconButton {...props} icon={QuestionIcon} aria-label="How the graph works" variant="invisible" size="small" />}>
          <p className="graph-help">Drag the background to pan and scroll to zoom. Drag a worktree to move it, or a handle onto another worktree to connect them. Drag a right handle onto empty space, or double-click it, for a new worktree.</p>
        </AnchoredOverlay>
      </div>
      <ButtonGroup className="graph-zoom">
        <IconButton icon={ZoomOutIcon} aria-label="Zoom out" size="small" onClick={() => zoomBy(1 / 1.25)} />
        <IconButton icon={ZoomInIcon} aria-label="Zoom in" size="small" onClick={() => zoomBy(1.25)} />
        <IconButton icon={ScreenFullIcon} aria-label="Fit all" size="small" onClick={() => fit(false)} />
      </ButtonGroup>
      {trees.length ? null : <p className="graph-empty">{filtered ? "No matching worktrees. Change the filter to see them." : "No checkouts in this project."}</p>}
    </div>
  );
}

// The ports take the color of what the checkout's omps are doing.
const nodeState = w => (w.agents || []).some(needsYou) ? "needs" : (w.agents || []).some(isBusy) ? "running" : w.column === "done" ? "done" : undefined;

const GraphNode = memo(function GraphNode({ w, x, y, placed, boxed, hasIn, hasOut, register }) {
  const ref = useCallback(el => el ? register(w.key, el) : undefined, [register, w.key]);
  return (
    <div className="graph-node" data-key={w.key} data-state={nodeState(w)} ref={ref}
      style={{ transform: `translate(${x}px, ${y}px)`, width: NODE_W, visibility: placed ? undefined : "hidden" }}>
      <WorktreeNode w={w} folder={!boxed} />
      <span className="graph-port" data-port="in" data-connected={hasIn || undefined} aria-hidden="true" title="Drag onto a checkout this one depends on" />
      <span className="graph-port" data-port="out" data-connected={hasOut || undefined} aria-hidden="true" title="Drag onto a checkout that depends on this one, or onto empty space for a new worktree after it" />
    </div>
  );
});
