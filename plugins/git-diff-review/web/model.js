export const PREFS_KEY = "git-diff-review:prefs";

export function compareFromParams(p) {
  const kind = p.get("kind");
  if (kind === "branch") return { kind, base: p.get("base") || null };
  if (kind === "commit") return { kind, sha: p.get("sha") || null };
  return { kind: "uncommitted" };
}

export function compareKey(c) {
  if (c.kind === "commit") return `commit:${c.sha}`;
  if (c.kind === "branch") return `branch:${c.base ?? ""}`;
  return "uncommitted";
}

// Which file version a pin's new-side line numbers refer to.
export const side = (s) => (s.compare.kind === "commit" ? `commit:${s.compare.sha}` : "worktree");
export const viewedKey = (s, path) => `${compareKey(s.compare)}|${path}`;
export const pinsFor = (s, path) => s.pins.filter((p) => p.path === path && p.side === side(s));

export function signature(file) {
  let h = 2166136261;
  const text = JSON.stringify(file.rows ?? [file.additions, file.deletions, file.status]);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function relative(date) {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// MARK: file order

// Pure renames and moves, mode-only changes and empty files: nothing to read in the diff.
export const lineless = (f) => !f.additions && !f.deletions && !f.binary && !f.truncated && !f.note;

export const reviewFiles = (files, hideUnchanged) => (hideUnchanged ? files.filter((f) => !lineless(f)) : files);

export function filterFiles(files, filter) {
  const q = filter.trim().toLowerCase();
  return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
}

export const filteredFiles = (s) => filterFiles(reviewFiles(s.files, s.hideUnchanged), s.filter);

export const noMatch = (filter) => (filter.trim() ? `No files match “${filter}”` : "No files with line changes");

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

export const treeEntries = (files) => [...walk(treeOf(files))];

export function orderedFiles(s) {
  const files = filteredFiles(s);
  return s.tree ? treeEntries(files).filter((e) => e.file).map((e) => e.file) : files;
}
