// @bun
// plugins/plan-review/src/extension.ts
import { isNativeRendering } from "@oh-my-pi/pi-tui";

// packages/integrations/src/text.ts
var errorText = (e) => e instanceof Error ? e.message : String(e);

// plugins/plan-review/src/layer.ts
import { getKeybindings, Input, matchesKey, sliceByColumn, theme, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

// plugins/plan-review/src/anchor.ts
var MIN_PROBE = 8;
var WORD = /[\p{L}\p{N}]/u;
var NOTE_BAR = "\u258E";
function isPlanText(text) {
  return !text.startsWith(NOTE_BAR) && WORD.test(text);
}
function quoteOf(rows) {
  return rows.filter(isPlanText).join(`
`);
}
function lettersOf(text) {
  let letters = "";
  for (const char of text)
    if (WORD.test(char))
      letters += char;
  return letters;
}

class PlanSource {
  #letters;
  #offsets = [];
  #title;
  constructor(text) {
    let letters = "";
    let offset = 0;
    for (const char of text) {
      if (WORD.test(char)) {
        letters += char;
        for (let unit = 0;unit < char.length; unit++)
          this.#offsets.push(offset + unit);
      }
      offset += char.length;
    }
    this.#letters = letters;
    this.#title = titleLine(text);
  }
  target(rows, first, last) {
    const selected = rows.slice(first, last + 1);
    const quote = quoteOf(selected);
    const at = quote ? this.at(rows, first + selected.findIndex(isPlanText)) : null;
    return at === null ? null : { quote, at };
  }
  at(rows, row) {
    const offset = this.locate(rows, row);
    return offset === null ? null : this.#docOffset(offset);
  }
  locate(rows, target) {
    const keys = rows.map((row) => row.startsWith(NOTE_BAR) ? "" : lettersOf(row));
    if (!keys[target])
      return null;
    let pivot = null;
    for (let distance = 0;distance < rows.length && !pivot; distance++) {
      for (const row of distance === 0 ? [target] : [target - distance, target + distance]) {
        const match2 = this.#unique(keys[row] ?? "");
        if (match2) {
          pivot = { row, match: match2 };
          break;
        }
      }
    }
    if (!pivot) {
      const match2 = this.#find(keys[target], 0, true);
      return match2 ? this.#offsets[match2.at] ?? null : null;
    }
    let { match } = pivot;
    const step = target > pivot.row ? 1 : -1;
    for (let row = pivot.row;row !== target; ) {
      row += step;
      const key = keys[row];
      if (!key)
        continue;
      const next = step > 0 ? this.#find(key, match.at + match.length, true) : this.#find(key, match.at - 1, false);
      if (next)
        match = next;
    }
    return this.#offsets[match.at] ?? null;
  }
  #find(key, bound, forward) {
    if (bound < 0)
      return null;
    for (let length = key.length;length > 0 && length >= Math.min(key.length, MIN_PROBE); length--) {
      const part = key.slice(0, length);
      const at = forward ? this.#letters.indexOf(part, bound) : this.#letters.lastIndexOf(part, bound);
      if (at >= 0)
        return { at, length };
    }
    return null;
  }
  #unique(key) {
    if (!key)
      return null;
    const match = this.#find(key, 0, true);
    if (!match)
      return null;
    return this.#letters.indexOf(key.slice(0, match.length), match.at + 1) < 0 ? match : null;
  }
  #docOffset(offset) {
    const title = this.#title;
    if (!title || offset < title.start)
      return offset;
    return offset < title.start + title.length ? title.start : offset - title.length;
  }
}
function titleLine(text) {
  const headings = [];
  let fence = null;
  let start = 0;
  for (const line of text.split(`
`)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length)
        fence = null;
    } else if (marker) {
      fence = marker;
    } else {
      const level = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line)?.[1]?.length;
      if (level)
        headings.push({ start, level, length: Math.min(line.length + 1, text.length - start) });
    }
    start += line.length + 1;
  }
  const first = headings[0];
  if (!first)
    return null;
  const top = Math.min(...headings.map((heading) => heading.level));
  const shallowest = headings.filter((heading) => heading.level === top);
  return shallowest.length === 1 && shallowest[0] === first ? { start: first.start, length: first.length } : null;
}

// plugins/plan-review/src/layer.ts
var ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;
var MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
var SELECTION_HINT = "\u2191/\u2193 move \xB7 shift+\u2191/\u2193 extend \xB7 alt+\u2191/\u2193 scroll \xB7 a, c or enter comment \xB7 esc clear";
var UNPLACED = "This line isn't text from the plan, so it can't take a comment \xB7 esc clear the selection";
var OMP_EDITING = /^(?:Annotate|Edit annotation)\b/;
var MAX_SCROLLS = 500;
function isReview(component) {
  return typeof component === "object" && component !== null && "handleNativeEvent" in component && typeof component.handleNativeEvent === "function" && "selectOption" in component && typeof component.selectOption === "function";
}
function findReview(tui) {
  for (const { component } of [...tui.overlayStack].reverse())
    if (isReview(component))
      return component;
  return null;
}
function readFrame(styled, width) {
  const lines = styled.map((line) => line.replace(ANSI, ""));
  const box = theme.boxRound;
  const dividers = lines.flatMap((line, row) => row > 0 && line.startsWith(box.teeRight) ? [row] : []);
  const body = dividers[0];
  const footer = dividers.at(-1);
  if (body === undefined || footer === undefined || body < 2)
    return null;
  const top = lines[0] ?? "";
  const split = top.indexOf(box.teeDown);
  const editing = OMP_EDITING.test(sliceByColumn(lines[footer + 1] ?? "", 2, width - 4).trim());
  return { lines, start: split > 0 ? visibleWidth(top.slice(0, split)) + 2 : 2, end: width - 3, first: 1, last: body - 1, editing };
}

class ReviewLayer {
  tui;
  review;
  onGone;
  debugKind = "plan-review-layer";
  #source;
  #width = 0;
  #frame = null;
  #rows = [];
  #selection = null;
  #anchor = null;
  #box = null;
  #notice = null;
  constructor(tui, review, plan, onGone) {
    this.tui = tui;
    this.review = review;
    this.onGone = onGone;
    this.#source = new PlanSource(plan);
  }
  render(width) {
    if (!this.tui.overlayStack.some((entry) => entry.component === this.review))
      queueMicrotask(this.onGone);
    const lines = [...this.review.render(width)];
    this.#read(lines, width);
    const frame = this.#frame;
    if (!frame)
      return lines;
    const span = this.#locate();
    if (span) {
      for (let row = Math.max(span.first, frame.first);row <= Math.min(span.last, frame.last); row++) {
        lines[row] = this.#highlight(lines[row] ?? "", frame, width);
      }
    }
    const count = lines.length;
    const box = this.#box;
    if (box) {
      const quote = box.target.quote.split(`
`);
      const more = quote.length > 1 ? ` and ${quote.length - 1} more line${quote.length > 2 ? "s" : ""}` : "";
      lines[count - 3] = boxRule(theme.boxRound.teeRight, theme.boxRound.teeLeft, theme.fg("accent", `Comment on \u201C${quote[0]}\u201D${more}`), width);
      lines[count - 2] = boxRow(box.input.render(width - 4)[0] ?? "", width);
      lines[count - 1] = boxRule(theme.boxRound.bottomLeft, theme.boxRound.bottomRight, theme.fg("dim", "enter save \xB7 esc cancel"), width);
    } else if (this.#selection) {
      lines[count - 2] = boxRow(this.#notice ? theme.fg("warning", this.#notice) : theme.fg("dim", SELECTION_HINT), width);
    }
    return lines;
  }
  handleInput(data) {
    const cancel = getKeybindings().matches(data, "tui.select.cancel");
    const box = this.#box;
    if (box) {
      if (cancel)
        this.#box = null;
      else if (matchesKey(data, "enter"))
        this.#save(box);
      else if (data.startsWith("\x1B[<")) {
        for (const [report, button] of data.matchAll(MOUSE))
          if (Number(button) & 64)
            this.review.handleInput(report);
      } else
        box.input.handleInput(data);
      this.tui.requestRender();
      return;
    }
    const reports = data.startsWith("\x1B[<") ? [...data.matchAll(MOUSE)] : [];
    if (reports.length > 0) {
      for (const [report, button, col, row, kind] of reports) {
        if (!this.#mouse(Number(button), Number(col) - 1, Number(row) - 1, kind === "m"))
          this.review.handleInput(report);
      }
      this.tui.requestRender();
      return;
    }
    if (this.#frame?.editing) {
      this.review.handleInput(data);
      return;
    }
    const scroll = matchesKey(data, "alt+up") ? -1 : matchesKey(data, "alt+down") ? 1 : 0;
    if (scroll !== 0 && this.#frame) {
      this.#scroll(scroll);
      this.tui.requestRender();
      return;
    }
    const selection = this.#selection;
    if (!selection) {
      if (matchesKey(data, "a") && this.#selectTop())
        this.tui.requestRender();
      else
        this.review.handleInput(data);
      return;
    }
    if (cancel) {
      this.#clear();
      return;
    }
    if (matchesKey(data, "a") || matchesKey(data, "c") || matchesKey(data, "enter")) {
      this.#openBox(selection);
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      this.review.handleInput(data);
      return;
    }
    const extend = matchesKey(data, "shift+up") || matchesKey(data, "shift+down");
    const direction = matchesKey(data, "up") || matchesKey(data, "shift+up") ? -1 : matchesKey(data, "down") || matchesKey(data, "shift+down") ? 1 : 0;
    if (direction !== 0 && this.#reveal()) {
      this.#notice = null;
      if (extend)
        this.#extend(selection, direction);
      else
        this.#move(direction);
      this.tui.requestRender();
      return;
    }
    this.#clear();
    this.review.handleInput(data);
  }
  invalidate() {
    this.review.invalidate?.();
  }
  #read(styled, width) {
    const frame = readFrame(styled, width);
    this.#width = width;
    this.#frame = frame;
    this.#rows = frame ? frame.lines.map((line, row) => row >= frame.first && row <= frame.last ? sliceByColumn(line, frame.start, frame.end - frame.start).trim() : "") : [];
  }
  #mouse(button, col, row, release) {
    const frame = this.#frame;
    if (!frame || frame.editing)
      return false;
    const left = (button & 3) === 0 && (button & 64) === 0;
    const drag = left && (button & 32) !== 0;
    if (left && !drag && !release && row >= frame.first && row <= frame.last && col >= frame.start && col < frame.end) {
      this.#notice = null;
      this.#anchor = isPlanText(this.#rows[row] ?? "") ? row : null;
      this.#selection = this.#anchor === null ? null : this.#select(row, row);
      return true;
    }
    if (drag && this.#anchor !== null) {
      this.#selection = this.#select(this.#anchor, Math.max(frame.first, Math.min(frame.last, row)));
      return true;
    }
    if (release && this.#anchor !== null) {
      this.#anchor = null;
      return true;
    }
    return false;
  }
  #select(from, to) {
    const [first, last] = from <= to ? [from, to] : [to, from];
    return { lines: this.#rows.slice(first, last + 1), row: first, target: this.#source.target(this.#rows, first, last), moving: from <= to ? "last" : "first" };
  }
  #selectTop() {
    const frame = this.#frame;
    if (!frame)
      return false;
    for (let row = frame.first;row <= frame.last; row++) {
      if (isPlanText(this.#rows[row] ?? "")) {
        this.#selection = this.#select(row, row);
        return true;
      }
    }
    return false;
  }
  #locate() {
    const frame = this.#frame;
    const selection = this.#selection;
    if (!frame || !selection)
      return null;
    const count = selection.lines.length;
    let best = null;
    for (let start = frame.first - count + 1;start <= frame.last; start++) {
      let shown = 0;
      let fits = true;
      for (let i = 0;i < count && fits; i++) {
        const row = start + i;
        if (row < frame.first || row > frame.last)
          continue;
        const line = selection.lines[i] ?? "";
        fits = this.#rows[row] === line;
        if (fits && isPlanText(line))
          shown++;
      }
      if (fits && shown > 0 && (best === null || Math.abs(start - selection.row) < Math.abs(best - selection.row)))
        best = start;
    }
    if (best === null)
      return null;
    selection.row = best;
    return { first: best, last: best + count - 1 };
  }
  #reveal() {
    const frame = this.#frame;
    const selection = this.#selection;
    if (!frame || !selection)
      return null;
    const toward = selection.row < (frame.first + frame.last) / 2 ? -1 : 1;
    for (const direction of [toward, -toward]) {
      for (let scrolls = 0;scrolls < MAX_SCROLLS; scrolls++) {
        const span = this.#locate();
        if (span)
          return span;
        if (!this.#scroll(direction))
          break;
      }
    }
    return this.#locate();
  }
  #move(direction) {
    const next = this.#beyond(direction > 0 ? "last" : "first", direction);
    if (next)
      this.#selection = this.#select(next.row, next.row);
  }
  #extend(selection, direction) {
    const single = selection.lines.filter(isPlanText).length === 1;
    const moving = single ? direction > 0 ? "last" : "first" : selection.moving;
    if (moving === "last" === direction > 0)
      this.#grow(selection, moving, direction);
    else
      this.#shrink(selection, moving);
  }
  #grow(selection, moving, direction) {
    const next = this.#beyond(moving, direction);
    if (!next)
      return;
    const { span, row } = next;
    const lines = direction > 0 ? [...selection.lines, ...this.#rows.slice(span.last + 1, row + 1)] : [...this.#rows.slice(row, span.first), ...selection.lines];
    const first = direction > 0 ? span.first : row;
    this.#selection = { lines, row: first, moving, target: this.#targetFor(lines, first, selection.target) };
  }
  #shrink(selection, moving) {
    const span = this.#locate();
    if (!span)
      return;
    const lines = [...selection.lines];
    let first = span.first;
    if (moving === "last") {
      lines.pop();
      while (lines.length > 0 && !isPlanText(lines.at(-1) ?? ""))
        lines.pop();
    } else {
      do {
        lines.shift();
        first++;
      } while (lines.length > 0 && !isPlanText(lines[0] ?? ""));
    }
    this.#selection = { lines, row: first, moving, target: this.#targetFor(lines, first, selection.target) };
  }
  #targetFor(lines, first, previous) {
    const quote = quoteOf(lines);
    const row = first + lines.findIndex(isPlanText);
    const frame = this.#frame;
    const at = frame && row >= frame.first && row <= frame.last ? this.#source.at(this.#rows, row) : previous?.at ?? null;
    return quote && at !== null ? { quote, at } : null;
  }
  #beyond(end, direction) {
    for (let scrolls = 0;scrolls <= MAX_SCROLLS; scrolls++) {
      const frame = this.#frame;
      const span = this.#locate();
      if (!frame || !span)
        return null;
      for (let row = span[end] + direction;row >= frame.first && row <= frame.last; row += direction) {
        if (isPlanText(this.#rows[row] ?? ""))
          return { span, row };
      }
      if (!this.#scroll(direction))
        return null;
    }
    return null;
  }
  #scroll(direction) {
    const frame = this.#frame;
    if (!frame)
      return false;
    const before = this.#rows.join(`
`);
    this.review.handleInput(`\x1B[<${direction > 0 ? 65 : 64};${frame.start + 1};${frame.first + 1}M`);
    this.#read(this.review.render(this.#width), this.#width);
    return this.#rows.join(`
`) !== before;
  }
  #highlight(line, frame, width) {
    const body = sliceByColumn(line.replace(ANSI, ""), frame.start, frame.end - frame.start);
    return `${sliceByColumn(line, 0, frame.start)}\x1B[0m${theme.bg("selectedBg", theme.fg("text", body))}${sliceByColumn(line, frame.end, width - frame.end)}`;
  }
  #openBox(selection) {
    if (selection.target) {
      const input = new Input;
      input.focused = true;
      this.#box = { input, target: selection.target };
    } else {
      this.#notice = UNPLACED;
    }
    this.tui.requestRender();
  }
  #save(box) {
    this.#box = null;
    const note = box.input.getValue().trim();
    if (!note)
      return;
    this.review.handleNativeEvent({ type: "comment", key: "doc", quote: box.target.quote, at: box.target.at, note });
    this.#selection = null;
  }
  #clear() {
    this.#selection = null;
    this.#notice = null;
    this.#anchor = null;
    this.tui.requestRender();
  }
}
function boxRow(content, width) {
  const bar = theme.fg("border", theme.boxRound.vertical);
  return `${bar} ${truncateToWidth(content, Math.max(0, width - 4), undefined, true)} ${bar}`;
}
function boxRule(left, right, label, width) {
  const text = truncateToWidth(` ${label} `, Math.max(0, width - 4));
  const fill = Math.max(0, width - 3 - visibleWidth(text));
  return `${theme.fg("border", left + theme.boxRound.horizontal)}${text}${theme.fg("border", theme.boxRound.horizontal.repeat(fill) + right)}`;
}

// plugins/plan-review/src/extension.ts
var FULLSCREEN = { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true };
function planReview(pi) {
  let open = null;
  const close = () => {
    const current = open;
    open = null;
    current?.close();
  };
  pi.on("plan_review_requested", (event, ctx) => {
    if (ctx.agent?.kind === "sub" || isNativeRendering())
      return;
    close();
    ctx.ui.custom((tui, _theme, _keybindings, done) => {
      const review = findReview(tui);
      if (!review) {
        done();
        return { render: () => [] };
      }
      const layer = { reviewId: event.reviewId, close: () => done() };
      open = layer;
      return new ReviewLayer(tui, review, event.planContent, () => {
        if (open === layer)
          open = null;
        done();
      });
    }, { overlay: true, overlayOptions: FULLSCREEN }).catch((error) => ctx.ui.notify(`Plan review: ${errorText(error)}`, "warning"));
  });
  pi.on("plan_review_resolved", (event, ctx) => {
    if (ctx.agent?.kind !== "sub" && open?.reviewId === event.reviewId)
      close();
  });
  pi.on("session_switch", (_event, ctx) => {
    if (ctx.agent?.kind !== "sub")
      close();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent?.kind !== "sub")
      close();
  });
}
export {
  planReview as default
};
