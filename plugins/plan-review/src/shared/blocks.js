// The plan's Markdown as commentable blocks: headings, paragraphs, code, tables, quotes and each list item, with source lines.
import { Marked } from "marked";
import { esc } from "omp-web-client/esc";

export { esc };

const SAFE_URL = /^(https?:|mailto:|#)/i;
// Inline code naming a file: a path with a folder, or a bare name with a known extension, optionally followed by :line.
const PATH = /^(?:(?:~|\.{1,2})?\/)?[\w@.+-]+(?:\/[\w@.+-]+)+\/?(?::\d+(?:-\d+)?)?$|^[\w.-]+\.(?:[cm]?[jt]sx?|json|md|swift|py|rs|go|css|html|ya?ml|toml|sh|kts?|java|rb|plist|xcconfig|lock)(?::\d+(?:-\d+)?)?$/;

// Plans come from the agent: raw HTML shows as text, links keep only safe schemes, images show their alt text.
const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return esc(text);
    },
    code({ text, lang }) {
      const name = (lang ?? "").match(/^\S+/)?.[0] ?? "";
      return `<pre${name ? ` data-lang="${esc(name)}"` : ""}><code${name ? ` class="language-${esc(name)}"` : ""}>${esc(text.replace(/\n$/, ""))}\n</code></pre>\n`;
    },
    codespan({ text }) {
      return `<code${PATH.test(text) ? ' class="path"' : ""}>${esc(text)}</code>`;
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!SAFE_URL.test(href)) return label;
      return `<a href="${esc(href)}" target="_blank" rel="noopener"${title ? ` title="${esc(title)}"` : ""}>${label}</a>`;
    },
    image({ text }) {
      return esc(text);
    },
  },
});

/**
 * @typedef {{ id: string, start: number, end: number, text: string, key: string }} Block
 * `start`/`end` are 1-based source lines; `text` is the block's own Markdown, without nested lists.
 */

function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Parses `source` into the rendered HTML, whose `.block[data-block]` elements match the returned blocks in document order. */
export function parsePlan(source) {
  const text = String(source ?? "").replace(/\r\n?/g, "\n");
  const starts = lineStarts(text);
  /** @type {Block[]} */
  const blocks = [];

  // The offset of `raw` in [from, to), else of its first line (nested list items are lexed de-indented).
  const locate = (raw, from, to) => {
    let at = text.indexOf(raw, from);
    if (at >= 0 && at < to) return at;
    const first = raw.trim().split("\n")[0];
    at = first ? text.indexOf(first, from) : -1;
    return at >= 0 && at < to ? at : from;
  };

  const addBlock = (raw, at) => {
    const own = raw.replace(/\n+$/, "");
    const start = lineOf(starts, at + (own.length - own.trimStart().length));
    const block = { id: `b${blocks.length}`, start, end: start + own.trim().split("\n").length - 1, text: own.trim(), key: own.trim().replace(/\s+/g, " ") };
    blocks.push(block);
    return block;
  };

  const blockHtml = (block, inner) => `<div class="block" data-block="${block.id}">${inner}</div>`;

  const renderList = (list, from, to) => {
    const tag = list.ordered ? "ol" : "ul";
    const startAttr = list.ordered && list.start !== "" && list.start !== 1 ? ` start="${list.start}"` : "";
    let cursor = from;
    let items = "";
    for (const item of list.items) {
      const at = locate(item.raw, cursor, to);
      const end = Math.min(to, at + item.raw.length);
      cursor = Math.max(cursor, end);
      const own = item.tokens.filter((t) => t.type !== "list");
      const firstNested = item.tokens.find((t) => t.type === "list");
      const cut = firstNested ? item.raw.indexOf(firstNested.raw.trim().split("\n")[0]) : -1;
      const block = addBlock(cut > 0 ? item.raw.slice(0, cut) : item.raw, at);
      let body = blockHtml(block, marked.parser(own));
      let nestedFrom = at;
      for (const nested of item.tokens) {
        if (nested.type !== "list") continue;
        const nestedAt = locate(nested.raw, nestedFrom, end);
        body += renderList(nested, nestedAt, end);
        nestedFrom = nestedAt + 1;
      }
      items += `<li${item.task ? ' class="task"' : ""}>${body}</li>`;
    }
    return `<${tag}${startAttr}>${items}</${tag}>`;
  };

  let html = "";
  let cursor = 0;
  for (const token of marked.lexer(text)) {
    const at = locate(token.raw, cursor, text.length);
    cursor = Math.max(cursor, at + token.raw.length);
    if (token.type === "space" || token.type === "def") continue;
    if (token.type === "hr") html += "<hr>";
    else if (token.type === "list") html += renderList(token, at, at + token.raw.length);
    else html += blockHtml(addBlock(token.raw, at), marked.parser([token]));
  }
  return { html, blocks };
}
