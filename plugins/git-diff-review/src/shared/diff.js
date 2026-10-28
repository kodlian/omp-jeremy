export const MAX_ROWS = 5000;

const KINDS = { " ": "context", "+": "addition", "-": "deletion" };

function hunkStart(part) {
  const n = Number.parseInt((part ?? "").slice(1).split(",")[0], 10);
  return Number.isNaN(n) ? 0 : n;
}

export function parseUnifiedDiff(raw) {
  const result = { rows: [], additions: 0, deletions: 0, truncated: false };
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (result.rows.length >= MAX_ROWS) {
      result.truncated = true;
      break;
    }
    if (line.startsWith("diff --git ")) inHunk = false;
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) continue;
    if (line.startsWith("@@ ")) {
      const parts = line.split(/\s+/).filter(Boolean);
      oldLine = hunkStart(parts[1]);
      newLine = hunkStart(parts[2]);
      inHunk = true;
      result.rows.push({ kind: "hunk", oldLineNumber: null, newLineNumber: null, oldText: null, newText: null, text: line });
      continue;
    }
    if (!inHunk || line.length === 0) continue;
    const kind = KINDS[line[0]];
    if (!kind) continue;
    const content = line.slice(1);
    const hasOld = kind !== "addition";
    const hasNew = kind !== "deletion";
    result.rows.push({
      kind,
      oldLineNumber: hasOld ? oldLine : null,
      newLineNumber: hasNew ? newLine : null,
      oldText: hasOld ? content : null,
      newText: hasNew ? content : null,
      text: line,
    });
    if (hasOld) oldLine += 1;
    if (hasNew) newLine += 1;
    if (kind === "addition") result.additions += 1;
    if (kind === "deletion") result.deletions += 1;
  }
  return result;
}

function unquote(path) {
  if (!path.startsWith('"')) return path;
  try {
    return JSON.parse(path);
  } catch {
    return path.slice(1, -1);
  }
}

const stripPrefix = (path) => unquote(path).replace(/^[ab]\//, "");

// Splits `git diff` / `git show` output for many files into per-file parsed diffs.
export function splitDiff(raw) {
  const files = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    const parsed = parseUnifiedDiff(current.lines.join("\n"));
    files.push({
      path: current.path,
      origPath: current.origPath,
      status: current.status,
      binary: current.binary,
      rows: parsed.rows,
      additions: parsed.additions,
      deletions: parsed.deletions,
      truncated: parsed.truncated,
    });
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      const m = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(line);
      const path = m ? stripPrefix(m[2]) : line.slice(11);
      current = { path, origPath: null, status: "M", binary: false, lines: [line], inHunk: false };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (current.inHunk) continue;
    if (line.startsWith("@@ ")) current.inHunk = true;
    else if (line.startsWith("new file mode")) current.status = "A";
    else if (line.startsWith("deleted file mode")) current.status = "D";
    else if (line.startsWith("rename from ")) {
      current.status = "R";
      current.origPath = unquote(line.slice(12));
    } else if (line.startsWith("rename to ")) current.path = unquote(line.slice(10));
    else if (line.startsWith("copy from ")) {
      current.status = "C";
      current.origPath = unquote(line.slice(10));
    } else if (line.startsWith("copy to ")) current.path = unquote(line.slice(8));
    else if (line.startsWith("Binary files ")) current.binary = true;
    else if (line.startsWith("+++ ") && line !== "+++ /dev/null") current.path = stripPrefix(line.slice(4).replace(/\t.*$/, ""));
  }
  finish();
  return files;
}

// Common prefix/suffix trim → [start, end) of the changed span in each string.
export function changedSpan(a, b) {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { a: [start, endA], b: [start, endB] };
}
