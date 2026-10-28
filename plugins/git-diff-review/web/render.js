import { changedSpan } from "../src/shared/diff.js";
import { isChangeRow } from "../src/shared/layout.js";
import { formatPin } from "../src/shared/reference.js";
import { esc } from "./dom.js";
import { tokenize } from "./highlight.js";
import { icon } from "./icons.js";

// MARK: syntax + intraline

function hunks(rows) {
  const out = [];
  let current = [];
  for (const row of rows) {
    if (row.kind === "hunk") {
      if (current.length) out.push(current);
      current = [];
    } else {
      current.push(row);
    }
  }
  if (current.length) out.push(current);
  return out;
}

// Tokens per row side, highlighted hunk by hunk so multi-line constructs keep their context.
export async function highlightRows(rows, path) {
  const map = new Map();
  for (const hunk of hunks(rows)) {
    const oldRows = hunk.filter((r) => r.kind !== "addition");
    const newRows = hunk.filter((r) => r.kind !== "deletion");
    const [oldTokens, newTokens] = await Promise.all([
      tokenize(oldRows.map((r) => r.oldText ?? ""), path),
      tokenize(newRows.map((r) => r.newText ?? ""), path),
    ]);
    if (!oldTokens && !newTokens) return null;
    oldRows.forEach((r, i) => map.set(r, { ...map.get(r), old: oldTokens?.[i] }));
    newRows.forEach((r, i) => map.set(r, { ...map.get(r), new: newTokens?.[i] }));
  }
  return map;
}

export function wordSpans(rows) {
  const spans = new Map();
  for (let i = 0; i < rows.length; ) {
    if (rows[i].kind !== "deletion") {
      i++;
      continue;
    }
    const dels = [];
    while (rows[i]?.kind === "deletion") dels.push(rows[i++]);
    const adds = [];
    while (rows[i]?.kind === "addition") adds.push(rows[i++]);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const a = dels[k].oldText ?? "";
      const b = adds[k].newText ?? "";
      const span = changedSpan(a, b);
      const kept = span.a[0] + (a.length - span.a[1]);
      if (kept < 3 || kept < Math.min(a.length, b.length) * 0.25) continue;
      spans.set(dels[k], span.a);
      spans.set(adds[k], span.b);
    }
  }
  return spans;
}

function codeHtml(text, tokens, span) {
  if (!text) return "";
  const parts = tokens?.length ? tokens : [{ content: text }];
  let html = "";
  let pos = 0;
  for (const t of parts) {
    const style = t.color ? ` style="color:${t.color}"` : "";
    const end = pos + t.content.length;
    const cuts = [pos];
    if (span) for (const c of span) if (c > pos && c < end) cuts.push(c);
    cuts.push(end);
    for (let k = 0; k < cuts.length - 1; k++) {
      const seg = t.content.slice(cuts[k] - pos, cuts[k + 1] - pos);
      const inSpan = span && cuts[k] >= span[0] && cuts[k + 1] <= span[1] && span[1] > span[0];
      const inner = `<span${style}>${esc(seg)}</span>`;
      html += inSpan ? `<mark>${inner}</mark>` : inner;
    }
    pos = end;
  }
  return html;
}

// MARK: rows

const SIGN = { addition: "+", deletion: "−", context: " " };

function gutterButton() {
  return `<button class="gutter-add" data-act="comment-line" title="Comment on this line" tabindex="-1">${icon("plus", 12)}</button>`;
}

const EXPAND_ICON = { up: "chevronUp", down: "chevronDown", all: "unfold" };

function hunkRow(row, i) {
  const gap = row.gap;
  const size = gap && Number.isFinite(gap.to) ? gap.to - gap.from + 1 : Number.POSITIVE_INFINITY;
  const dirs = !gap ? [] : size <= 20 ? ["all"] : gap.from === 1 ? ["up"] : gap.trailing ? ["down"] : ["down", "up"];
  const title = { up: "Show 20 lines above", down: "Show 20 lines below", all: `Show ${size} hidden line${size === 1 ? "" : "s"}` };
  const buttons = dirs.map((d) => `<button class="expand" data-act="expand" data-dir="${d}" title="${title[d]}" tabindex="-1">${icon(EXPAND_ICON[d], 12)}</button>`).join("");
  return `<div class="row hunk" data-row="${i}">${buttons ? `<span class="expanders">${buttons}</span>` : ""}<span class="hunk-text">${esc(row.text)}</span></div>`;
}

function unifiedRow(row, i, ctx) {
  if (row.kind === "hunk") return hunkRow(row, i);
  const side = row.kind === "deletion" ? "old" : "new";
  const text = side === "old" ? row.oldText : row.newText;
  const pin = ctx.pinFor(row);
  return `<div class="row ${row.kind}${pin ? " pinned" : ""}" data-row="${i}">
    ${ctx.single ? `<span class="num">${row.newLineNumber ?? row.oldLineNumber ?? ""}${gutterButton()}</span>` : `<span class="num">${row.oldLineNumber ?? ""}</span><span class="num">${row.newLineNumber ?? ""}${gutterButton()}</span>`}
    <span class="sign">${SIGN[row.kind]}</span><span class="code">${codeHtml(text, ctx.tokens?.get(row)?.[side], ctx.spans.get(row))}</span></div>`;
}

function splitRow(pair, i, ctx) {
  if (pair.hunk) return hunkRow(pair.hunk, i);
  const { left, right } = pair;
  const cls = (row, kind) => (!row ? "empty" : row.kind === "context" ? "context" : kind);
  const pin = ctx.pinFor(pair);
  return `<div class="row ${isChangeRow(pair) ? "change" : "context"}${pin ? " pinned" : ""}" data-row="${i}">
    <span class="num ${cls(left, "deletion")}">${left?.oldLineNumber ?? ""}</span>
    <span class="code ${cls(left, "deletion")}">${left ? codeHtml(left.oldText, ctx.tokens?.get(left)?.old, ctx.spans.get(left)) : ""}</span>
    <span class="num ${cls(right, "addition")}">${right?.newLineNumber ?? ""}${right ? gutterButton() : ""}</span>
    <span class="code ${cls(right, "addition")}">${right ? codeHtml(right.newText, ctx.tokens?.get(right)?.new, ctx.spans.get(right)) : ""}</span></div>`;
}

export function threadHtml(pin, { outdated = false } = {}) {
  return `<div class="thread" data-pin="${esc(pin.id)}">
    <div class="thread-head">${icon("comment", 12)}<span class="thread-ref">${esc(formatPin(pin))}</span>${outdated ? `<span class="badge">outdated</span>` : ""}<span class="spacer"></span>
      <button class="tool-button" data-act="edit-pin" title="Edit">${icon("edit", 13)}</button>
      <button class="tool-button" data-act="delete-pin" title="Delete">${icon("trash", 13)}</button>
    </div>
    <div class="thread-body">${pin.note ? esc(pin.note) : `<span class="muted">No comment, reference only</span>`}</div>
  </div>`;
}

export function composerHtml({ reference, note = "" }) {
  return `<div class="thread composer">
    <div class="thread-head">${icon("commentAdd", 12)}<span class="thread-ref">${esc(reference)}</span></div>
    <textarea class="field" rows="3" placeholder="Leave a comment for the agent">${esc(note)}</textarea>
    <div class="composer-actions">
      <span class="hint">⌘↩ send review · ⌘⌥↩ send this now</span>
      <span class="spacer"></span>
      <button class="btn" data-act="cancel-composer">Cancel</button>
      <button class="btn primary" data-act="send-review">${icon("send", 12)}Send review</button>
    </div>
  </div>`;
}

// ctx: { items, layout, tokens, spans, pinFor(item), pins: Pin[], composer: { afterIndex, html } | null, truncated }
export function bodyHtml(file, ctx) {
  if (file.note) return `<div class="body-note">${esc(file.note)}</div>`;
  if (file.binary && !file.rows?.length) return `<div class="body-note">Binary file not shown</div>`;
  if (!ctx.items.length) return `<div class="body-note">${file.status === "R" ? "Renamed without content changes" : "No content changes"}</div>`;
  const placed = new Map();
  const outdated = [];
  for (const pin of ctx.pins) {
    let last = -1;
    ctx.items.forEach((item, i) => {
      if (ctx.pinFor(item)?.id === pin.id) last = i;
    });
    if (last < 0) outdated.push(pin);
    else placed.set(last, [...(placed.get(last) ?? []), pin]);
  }
  const rowFn = ctx.layout === "split" ? splitRow : unifiedRow;
  let maxLine = 0;
  let hasOld = false;
  let hasNew = false;
  for (const row of file.rows ?? []) {
    if (row.oldLineNumber != null) hasOld = true;
    if (row.newLineNumber != null) hasNew = true;
    maxLine = Math.max(maxLine, row.oldLineNumber ?? 0, row.newLineNumber ?? 0);
  }
  const single = ctx.layout === "unified" && hasOld !== hasNew;
  ctx = { ...ctx, single };
  const parts = [`<div class="rows ${ctx.layout}${single ? " single" : ""}" style="--num-w:${Math.max(2, String(maxLine).length)}ch">`];
  for (const pin of outdated) parts.push(ctx.composer?.editing === pin.id ? ctx.composer.html : threadHtml(pin, { outdated: true }));
  ctx.items.forEach((item, i) => {
    parts.push(rowFn(item, i, ctx));
    for (const pin of placed.get(i) ?? []) {
      if (ctx.composer?.editing === pin.id) continue;
      parts.push(threadHtml(pin));
    }
    if (ctx.composer?.afterIndex === i) parts.push(ctx.composer.html);
  });
  if (file.truncated) parts.push(`<div class="body-note">Diff truncated at 5000 lines</div>`);
  parts.push("</div>");
  return parts.join("");
}
