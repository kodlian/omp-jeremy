// Inline items are Row objects; side-by-side items are { left, right } pairs or { hunk }.

export function pairRows(rows) {
  const out = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) out.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.kind === "deletion") {
      if (adds.length) flush();
      dels.push(row);
    } else if (row.kind === "addition") {
      adds.push(row);
    } else {
      flush();
      if (row.kind === "hunk") out.push({ left: null, right: null, hunk: row });
      else out.push({ left: row, right: row });
    }
  }
  flush();
  return out;
}

export function isChangeRow(item) {
  if (!item) return false;
  if ("kind" in item) return item.kind === "addition" || item.kind === "deletion";
  return item.left?.kind === "deletion" || item.right?.kind === "addition";
}

export function rowsIn(items, lo, hi) {
  const seen = new Set();
  const rows = [];
  for (let i = lo; i <= hi; i++) {
    const item = items[i];
    if (!item) continue;
    const candidates = "kind" in item ? [item] : [item.hunk, item.left, item.right];
    for (const row of candidates) {
      if (row && !seen.has(row)) {
        seen.add(row);
        rows.push(row);
      }
    }
  }
  return rows;
}

export function changeBlockAround(items, idx) {
  if (!isChangeRow(items[idx])) return [idx, idx];
  let lo = idx;
  let hi = idx;
  while (lo > 0 && isChangeRow(items[lo - 1])) lo--;
  while (hi < items.length - 1 && isChangeRow(items[hi + 1])) hi++;
  return [lo, hi];
}

export function blockStarts(items) {
  const starts = [];
  for (let i = 0; i < items.length; i++) if (isChangeRow(items[i]) && !isChangeRow(items[i - 1])) starts.push(i);
  return starts;
}
