export function compactLineRefs(nums) {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const runs = [];
  for (const n of sorted) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([s, e]) => (s === e ? `L${s}` : `L${s}-L${e}`)).join(", ");
}

function lineSets(rows) {
  const newNums = [];
  const delOld = [];
  for (const row of rows) {
    if ((row.kind === "addition" || row.kind === "context") && row.newLineNumber != null) newNums.push(row.newLineNumber);
    else if (row.kind === "deletion" && row.oldLineNumber != null) delOld.push(row.oldLineNumber);
  }
  return { newNums, delOld };
}

function format(path, hasNew, start, end, deletedOld) {
  let ref = `@${path}`;
  if (hasNew) ref += start === end ? `#L${start}` : `#L${start}-L${end}`;
  if (deletedOld.length) ref += ` (deleted: ${compactLineRefs(deletedOld)})`;
  return ref;
}

export function referenceFor(path, rows) {
  const { newNums, delOld } = lineSets(rows);
  if (!newNums.length && !delOld.length) return "";
  return format(path, newNums.length > 0, Math.min(...newNums), Math.max(...newNums), delOld);
}

export function pinFromSelection(path, rows, side) {
  const { newNums, delOld } = lineSets(rows);
  if (!newNums.length && !delOld.length) return null;
  const nums = newNums.length ? newNums : delOld;
  const content = rows.filter((r) => r.kind !== "hunk");
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    path,
    startLine: Math.min(...nums),
    endLine: Math.max(...nums),
    hasNew: newNums.length > 0,
    deletedOld: [...new Set(delOld)].sort((a, b) => a - b),
    note: "",
    side,
    snippet: content.slice(0, 3).map((r) => r.newText ?? r.oldText ?? "").join("\n"),
    createdAt: Date.now(),
  };
}

export function formatPin(pin) {
  return format(pin.path, pin.hasNew, pin.startLine, pin.endLine, pin.deletedOld);
}

export function pinCovers(pin, row) {
  if (pin.hasNew && row.newLineNumber != null && row.kind !== "deletion" && pin.startLine <= row.newLineNumber && row.newLineNumber <= pin.endLine) return true;
  return row.kind === "deletion" && pin.deletedOld.includes(row.oldLineNumber);
}

export function singleMessage(pin) {
  return `${formatPin(pin)} — ${pin.note.trim()}`;
}

export function sortPins(pins) {
  return [...pins].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine));
}

export function reviewMessage(pins) {
  const lines = ["Please address these review comments:"];
  for (const pin of sortPins(pins)) {
    const [first, ...rest] = pin.note.trim().split("\n");
    lines.push(first ? `- ${formatPin(pin)} — ${first}` : `- ${formatPin(pin)}`);
    for (const line of rest) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}
