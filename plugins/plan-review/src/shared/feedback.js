// The refine feedback omp hands the agent: each comment quotes the plan lines it's about, then the overall note.

const EXCERPT_LINES = 4;
const EXCERPT_CHARS = 280;

function excerpt(text) {
  let lines = text.trim().split("\n");
  let cut = lines.length > EXCERPT_LINES;
  lines = lines.slice(0, EXCERPT_LINES);
  let body = lines.join("\n");
  if (body.length > EXCERPT_CHARS) {
    body = body.slice(0, EXCERPT_CHARS).trimEnd();
    cut = true;
  }
  return `${body}${cut ? " …" : ""}`
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** "Line 4" or "Lines 4–7", for a comment's { start, end } source lines. */
export function lineRange({ start, end }) {
  return start === end ? `Line ${start}` : `Lines ${start}–${end}`;
}

/** comments: [{ start, end, excerpt, note }] in plan order; note: the overall comment. Empty when there's nothing to send. */
export function feedbackMessage(comments, note) {
  const general = String(note ?? "").trim();
  const items = comments.filter((c) => c.note.trim());
  if (!items.length) return general;
  const parts = [`Plan review: ${items.length} comment${items.length > 1 ? "s" : ""} on the plan.`];
  items.forEach((c, i) => parts.push(`${i + 1}. ${lineRange(c)}:\n${excerpt(c.excerpt)}\n${c.note.trim()}`));
  if (general) parts.push(`Overall: ${general}`);
  return parts.join("\n\n");
}
