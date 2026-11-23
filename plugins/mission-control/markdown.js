"use strict";
// MARK: markdown
function mdInline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`);
  s = s.replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}
function md(src) {
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  let out = "", i = 0;
  const isList = l => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const blockStart = l => /^\s*(#{1,6}\s|```|~~~|>|([-*_])\s*\2\s*\2[\s\-*_]*$)/.test(l) || isList(l) || /^\s*\|/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^\s*(```|~~~)\s*([\w+-]*)/))) {
      const fence = m[1], body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++;
      out += `<pre><code>${esc(body.join("\n"))}</code></pre>`;
    } else if ((m = l.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      out += `<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`; i++;
    } else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(l)) {
      out += "<hr>"; i++;
    } else if (/^\s*>/.test(l)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out += `<blockquote>${md(body.join("\n"))}</blockquote>`;
    } else if (isList(l)) {
      const items = [];
      let fence = null;
      while (i < lines.length) {
        const cur = lines[i], t = cur.trim();
        if (fence) { items.push(cur); i++; if (t.startsWith(fence)) fence = null; continue; }
        if (isList(cur) || (t && /^\s/.test(cur))) {
          const fm = t.match(/^(```|~~~)/);
          if (fm) fence = fm[1];
          items.push(cur); i++; continue;
        }
        if (!t) {
          let j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && (isList(lines[j]) || /^\s+\S/.test(lines[j]))) { while (i < j) items.push(lines[i++]); continue; }
        }
        break;
      }
      out += mdList(items);
    } else if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = r => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
      const head = cells(l);
      const al = cells(lines[i + 1]).map(c => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "");
      i += 2;
      let t = "<table><thead><tr>" + head.map((c, j) => `<th${al[j] ? ` style="text-align:${al[j]}"` : ""}>${mdInline(c)}</th>`).join("") + "</tr></thead><tbody>";
      while (i < lines.length && /^\s*\|/.test(lines[i])) t += "<tr>" + cells(lines[i++]).map((c, j) => `<td${al[j] ? ` style="text-align:${al[j]}"` : ""}>${mdInline(c)}</td>`).join("") + "</tr>";
      out += t + "</tbody></table>";
    } else {
      const body = [];
      while (i < lines.length && lines[i].trim() && !(body.length && blockStart(lines[i]))) body.push(lines[i++].trim());
      out += `<p>${mdInline(body.join(" "))}</p>`;
    }
  }
  return out;
}
function mdList(lines) {
  const indentOf = l => l.match(/^\s*/)[0].replace(/\t/g, "    ").length;
  const base = indentOf(lines.find(l => l.trim()));
  const items = [];
  let fence = null;
  for (const l of lines) {
    const t = l.trim();
    const m = fence ? null : l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (m && indentOf(l) <= base + 1) items.push({ ordered: /\d/.test(m[2]), start: parseInt(m[2]), first: m[3], rest: [] });
    else if (items.length) items[items.length - 1].rest.push(l);
    if (fence) { if (t.startsWith(fence)) fence = null; }
    else { const fm = t.match(/^(```|~~~)/); if (fm) fence = fm[1]; }
  }
  if (!items.length) return "";
  const ordered = items[0].ordered;
  let out = ordered ? `<ol${items[0].start !== 1 ? ` start="${items[0].start}"` : ""}>` : "<ul>";
  for (const it of items) {
    let first = it.first, cls = "";
    const cb = first.match(/^\[([ xX])\]\s+(.*)$/);
    if (cb) { cls = ' class="task"'; first = `<input type="checkbox" disabled${cb[1] !== " " ? " checked" : ""}> ${mdInline(cb[2])}`; }
    else first = mdInline(first);
    const rest = it.rest.filter(l => l.trim());
    let inner = "";
    if (rest.length) {
      const minInd = Math.min(...rest.map(indentOf));
      inner = md(it.rest.map(l => l.replace(/\t/g, "    ").slice(Math.min(minInd, indentOf(l)))).join("\n"));
    }
    out += `<li${cls}>${first}${inner}</li>`;
  }
  return out + (ordered ? "</ol>" : "</ul>");
}

