const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunk(text) {
  const m = HUNK_RE.exec(text);
  if (!m) return null;
  const [a, b, c, d] = [m[1], m[2] ?? "1", m[3], m[4] ?? "1"].map(Number);
  return { oldStart: b === 0 ? a + 1 : a, newStart: d === 0 ? c + 1 : c, oldEnd: b === 0 ? a : a + b - 1, newEnd: d === 0 ? c : c + d - 1 };
}

const hunkRow = (text, gap) => ({ kind: "hunk", oldLineNumber: null, newLineNumber: null, oldText: null, newText: null, text, gap });
const contextRow = (n, delta, line) => ({ kind: "context", oldLineNumber: n + delta, newLineNumber: n, oldText: line, newText: line, text: ` ${line}` });

// Inserts revealed new-side lines between hunks. Each still-hidden run becomes a hunk row with `gap: { from, to, delta, trailing }`;
// `to` is Infinity after the last hunk until the file's lines are known.
export function expandRows(rows, lines, revealed) {
  if (!rows.some((r) => r.kind === "hunk" && parseHunk(r.text))) return rows;
  const shown = (n) => revealed.some(([lo, hi]) => n >= lo && n <= hi);
  const out = [];
  const fill = (from, to, delta, text, trailing) => {
    if (!Number.isFinite(to)) {
      out.push(hunkRow(text, { from, to, delta, trailing }));
      return;
    }
    const runs = [];
    for (let n = from; n <= to; n++) {
      if (lines && shown(n)) continue;
      const last = runs.at(-1);
      if (last && last.to === n - 1) last.to = n;
      else runs.push({ from: n, to: n });
    }
    let r = 0;
    for (let n = from; n <= to; ) {
      if (runs[r]?.from === n) {
        const run = runs[r++];
        out.push(hunkRow(r === runs.length ? text : "", { ...run, delta, trailing }));
        n = run.to + 1;
      } else {
        out.push(contextRow(n, delta, lines[n - 1]));
        n++;
      }
    }
  };
  let prevEnd = 0;
  let trailingDelta = 0;
  for (const row of rows) {
    const hunk = row.kind === "hunk" ? parseHunk(row.text) : null;
    if (!hunk) {
      out.push(row);
      continue;
    }
    if (hunk.newStart - 1 >= prevEnd + 1) fill(prevEnd + 1, hunk.newStart - 1, hunk.oldStart - hunk.newStart, row.text, false);
    else if (prevEnd === 0) out.push(row);
    prevEnd = hunk.newEnd;
    trailingDelta = hunk.oldEnd - hunk.newEnd;
  }
  fill(prevEnd + 1, lines ? lines.length : Number.POSITIVE_INFINITY, trailingDelta, "", true);
  return out;
}

export function revealRange(gap, dir, step = 20) {
  if (dir === "up") return [Math.max(gap.from, gap.to - step + 1), gap.to];
  if (dir === "down") return [gap.from, Math.min(gap.to, gap.from + step - 1)];
  return [gap.from, gap.to];
}
