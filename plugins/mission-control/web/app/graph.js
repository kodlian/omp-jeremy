import { worktreeName } from "./model.js";

// NODE_H is a node's height before it is measured, and the new-worktree outline's.
export const NODE_W = 260, NODE_H = 60, PORT_X = 0, SPAWN_MIN = 24;
const GAP = 24, COLUMN = NODE_W + 100, GROUP_GAP = 56;
// A folder box's margin around its nodes, and its heading's height above them.
const BOX_PAD = 12, BOX_HEAD = 28;

// The cmux sidebar's order: main checkout, checkouts without a folder, then each folder alphabetically.
const groupOf = w => w.main ? 0 : w.folder ? 2 : 1;
const byGroup = (a, b) => groupOf(a) - groupOf(b) || (a.folder || "").localeCompare(b.folder || "") || worktreeName(a).localeCompare(worktreeName(b));
const sameGroup = (a, b) => groupOf(a) === groupOf(b) && (a.folder || "") === (b.folder || "");
// A node's height plus the gap below it, from its measured `height`.
const rowOf = height => key => height(key) + GAP;

// The sidebar's order top to bottom; each checkout's dependents in the next column to its right, it level with their middle.
export function layout(trees, height) {
  const row = rowOf(height), keys = new Set(trees.map(w => w.key)), parent = new Map(), kids = new Map(), places = {}, seen = new Set();
  for (const w of trees) {
    const p = (w.dependsOn || []).find(k => k !== w.key && keys.has(k));
    if (p) { parent.set(w.key, p); kids.set(p, [...(kids.get(p) || []), w]); }
  }
  // `w` and its dependents, one column per level, y from the chain's top.
  const chain = w => {
    seen.add(w.key);
    const nodes = [], middles = [];
    let total = 0;
    for (const c of (kids.get(w.key) || []).sort(byGroup)) {
      if (seen.has(c.key)) continue;
      const sub = chain(c);
      for (const n of sub.nodes) nodes.push({ key: n.key, depth: n.depth + 1, y: n.y + total });
      middles.push(sub.at + total);
      total += sub.height;
    }
    const at = middles.length ? (middles[0] + middles[middles.length - 1]) / 2 : 0;
    nodes.push({ key: w.key, depth: 0, y: at });
    return { nodes, at, height: Math.max(total, at + row(w.key)) };
  };
  // Each chain goes as high as its columns allow: below the bottom of each column so far, below the folder above.
  const bottom = [];
  let floor = 0, last = null;
  const sorted = [...trees].sort(byGroup);
  for (const w of [...sorted.filter(w => !parent.has(w.key)), ...sorted]) {
    if (seen.has(w.key)) continue;
    if (last && !sameGroup(last, w)) floor = Math.max(floor, ...bottom.filter(y => y != null)) + GROUP_GAP;
    last = w;
    const { nodes } = chain(w);
    const shift = Math.max(...nodes.map(n => Math.max(bottom[n.depth] ?? floor, floor) - n.y));
    for (const n of nodes) {
      places[n.key] = { x: n.depth * COLUMN, y: n.y + shift };
      bottom[n.depth] = Math.max(bottom[n.depth] ?? floor, n.y + shift + row(n.key));
    }
  }
  return places;
}

// Places for the checkouts without one: all at once on a blank canvas, else each below its prerequisite, its folder's group or everything; what sits below moves down to make room, so folders never interleave.
export function placeMissing(trees, placeOf, height) {
  const missing = trees.filter(w => !placeOf(w.key));
  if (!missing.length) return {};
  const row = rowOf(height), places = trees.some(w => placeOf(w.key)) ? {} : layout(trees, height);
  const at = key => places[key] || placeOf(key);
  const placed = () => trees.filter(w => at(w.key));
  const below = list => Math.max(...list.map(o => at(o.key).y + row(o.key)));
  // The placed node that `key` at `p` would cover, if any.
  const blocker = (key, p) => placed().find(o => o.key !== key && Math.abs(at(o.key).x - p.x) < NODE_W + 20 && p.y < at(o.key).y + row(o.key) && at(o.key).y < p.y + row(key));
  for (const w of missing.sort(byGroup)) {
    if (places[w.key]) continue;
    const prerequisite = (w.dependsOn || []).map(at).find(Boolean);
    const group = trees.filter(x => x !== w && sameGroup(x, w) && at(x.key)), all = placed();
    let p;
    if (prerequisite) p = { x: prerequisite.x + COLUMN, y: prerequisite.y };
    else if (group.length) p = { x: Math.min(...group.map(o => at(o.key).x)), y: below(group) };
    else p = { x: all.length ? Math.min(...all.map(o => at(o.key).x)) : 0, y: all.length ? below(all) + GROUP_GAP : 0 };
    const above = () => placed().find(o => o.key !== w.key && at(o.key).y < p.y && Math.abs(at(o.key).x - p.x) < NODE_W + 20 && p.y < at(o.key).y + row(o.key));
    for (let o = above(); o; o = above()) p = { x: p.x, y: at(o.key).y + row(o.key) };
    if (blocker(w.key, p)) for (const o of placed()) if (at(o.key).y >= p.y) places[o.key] = { x: at(o.key).x, y: at(o.key).y + row(w.key) };
    places[w.key] = p;
  }
  return places;
}

// Saved places that overlap now that nodes are taller than when they were placed move down just enough, keeping each column's order.
export function spread(keys, placeOf, height) {
  const row = rowOf(height), done = [], moved = {};
  const placed = keys.map(key => [key, placeOf(key)]).filter(([, p]) => p).sort(([, a], [, b]) => a.y - b.y);
  for (const [key, p] of placed) {
    let y = p.y;
    for (const [k, q] of done) if (Math.abs(q.x - p.x) < NODE_W) y = Math.max(y, q.y + row(k));
    const place = y === p.y ? p : { x: p.x, y };
    if (place !== p) moved[key] = place;
    done.push([key, place]);
  }
  return moved;
}

// A box around each folder's checkouts whose prerequisites all sit in its box, sized to their measured heights: the folder named in its heading.
export function folderBoxes(trees, placeOf, height) {
  const byKey = new Map(trees.map(w => [w.key, w])), boxed = new Map(), groups = new Map();
  const inBox = w => {
    if (!boxed.has(w.key)) {
      boxed.set(w.key, false);
      const deps = (w.dependsOn || []).map(k => byKey.get(k)).filter(Boolean);
      boxed.set(w.key, !!w.folder && !w.main && !!placeOf(w.key) && deps.every(d => d.folder === w.folder && inBox(d)));
    }
    return boxed.get(w.key);
  };
  for (const w of trees) if (inBox(w)) groups.set(w.folder, [...(groups.get(w.folder) || []), w.key]);
  return [...groups].map(([folder, members]) => {
    const ps = members.map(k => ({ ...placeOf(k), bottom: placeOf(k).y + height(k) }));
    const x = Math.min(...ps.map(p => p.x)) - BOX_PAD, y = Math.min(...ps.map(p => p.y)) - BOX_PAD - BOX_HEAD;
    return { folder, members, x, y, width: Math.max(...ps.map(p => p.x)) + NODE_W + BOX_PAD - x, height: Math.max(...ps.map(p => p.bottom)) + BOX_PAD - y };
  });
}

// The camera that fits every place; `readable` keeps nodes legible on a tall canvas, showing its top.
export function fitCamera(keys, placeOf, height, width, viewHeight, readable) {
  const ps = keys.map(placeOf).filter(Boolean);
  if (!ps.length) return null;
  const minX = Math.min(...ps.map(p => p.x)), minY = Math.min(...ps.map(p => p.y));
  const w = Math.max(...ps.map(p => p.x)) + NODE_W - minX, ht = Math.max(...keys.filter(placeOf).map(k => placeOf(k).y + height(k))) - minY;
  const fit = Math.min((width - 80) / w, (viewHeight - 140) / ht);
  const zoom = Math.min(1, Math.max(readable ? Math.min(0.85, (width - 80) / w) : 0.15, fit));
  return { zoom, x: (width - w * zoom) / 2 - minX * zoom, y: 100 - minY * zoom };
}

function curve(a, b) {
  const bend = Math.max(60, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + bend},${a.y} ${b.x - bend},${b.y} ${b.x},${b.y}`;
}
// Right angles with rounded corners, turning halfway across; a curve when `b` is not to the right of `a`. Either way the endpoints' midpoint lies on it.
export function edge(a, b) {
  const mx = (a.x + b.x) / 2, dy = b.y - a.y, s = Math.sign(dy), r = Math.min(10, Math.abs(dy) / 2, (b.x - a.x) / 2);
  if (b.x - a.x < 24) return curve(a, b);
  if (Math.abs(dy) < 1) return `M${a.x},${a.y} H${b.x}`;
  return `M${a.x},${a.y} H${mx - r} Q${mx},${a.y} ${mx},${a.y + s * r} V${b.y - s * r} Q${mx},${b.y} ${mx + r},${b.y} H${b.x}`;
}
// Solid for the first half from the prerequisite, then dashed like a waiting connection (`stroke-dasharray: 8 7`).
export const halfDash = length => `${length / 2} 7` + " 8 7".repeat(Math.ceil(length / 2 / 15));
