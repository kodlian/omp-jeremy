import { flushSync } from "react-dom";
import { esc } from "omp-web-client/esc";
import { expandRows, revealRange } from "../src/shared/expand.js";
import { blockStarts, changeBlockAround, pairRows, rowsIn } from "../src/shared/layout.js";
import { formatPin, pinCovers, pinFromSelection, referenceFor, reviewMessage, singleMessage } from "../src/shared/reference.js";
import { copyText, splitPath, toolButton } from "./dom.js";
import { icon } from "./icons.js";
import { orderedFiles, pinsFor, side, signature, viewedKey } from "./model.js";
import { bodyHtml, highlightRows, wordSpans } from "./render.js";
import { api, compareQuery } from "./review.js";

const LARGE_DIFF_ROWS = 1500;
const RENDER_MARGIN = 1500;

// The diff body: file sections, virtualized rows as HTML strings, selection, pins, find and navigation. Driven imperatively; the chrome reads and writes the review store.
export function createDiff(review, { scroller, files: filesEl, selToolbar }) {
  const st = () => review.state;
  const composer = () => st().composer;
  const abort = new AbortController();
  const { signal } = abort;
  const fileStates = new Map();
  const collapsed = new Set();
  const expanded = new Set();
  const loadedLarge = new Set();
  const find = { matches: [], current: -1 };
  let sel = null;
  let drag = null;
  let pinCursor = null;
  let pendingScroll = st().selected;
  let rowHeight = 0;
  let spyTimer = 0;
  let spyHoldUntil = 0;
  let findFrame = 0;

  // MARK: files

  const isCollapsed = (path) => collapsed.has(path) || (Boolean(st().viewed[viewedKey(st(), path)]) && !expanded.has(path));
  const isDeferred = (fs) => (fs.file.rows?.length ?? 0) > LARGE_DIFF_ROWS && !loadedLarge.has(fs.file.path);
  const itemsFor = (rows) => (st().layout === "split" ? pairRows(rows) : rows);
  const canExpand = (file) => (file.status === "M" || file.status === "R") && !file.truncated && Boolean(file.rows?.length);
  const bodyOf = (fs) => fs.el.querySelector(".file-body");
  const headerOf = (fs) => fs.el.querySelector(".file-header");
  const pinnedAbove = (fs) => fs && fs.el.getBoundingClientRect().top < scroller.getBoundingClientRect().top;

  function setRows(fs) {
    fs.rows = canExpand(fs.file) ? expandRows(fs.file.rows, fs.lines, fs.revealed) : (fs.file.rows ?? []);
    fs.items = itemsFor(fs.rows);
    fs.tokens = null;
    fs.spans = null;
    fs.highlighting = null;
  }

  function headerHtml(file) {
    const { dir, name } = splitPath(file.path);
    const viewed = Boolean(st().viewed[viewedKey(st(), file.path)]);
    const comments = pinsFor(st(), file.path).length;
    return `${icon(isCollapsed(file.path) ? "chevronRight" : "chevronDown", 14)}
    <span class="status-letter status-${esc(file.status)}">${esc(file.status === "?" ? "U" : file.status)}</span>
    <span class="path">${dir ? `<span class="dir">${esc(dir)}/</span>` : ""}<b>${esc(name)}</b></span>
    ${file.origPath ? `<span class="muted renamed">from ${esc(file.origPath)}</span>` : ""}
    <span class="stats">${file.additions ? `<span class="add">+${file.additions}</span>` : ""} ${file.deletions ? `<span class="remove">−${file.deletions}</span>` : ""}</span>
    ${comments ? `<span class="badge-comments">${icon("comment", 12)}${comments}</span>` : ""}
    <span class="spacer"></span>
    ${toolButton("copy-path", "Copy path", icon("copy", 13))}
    ${file.status === "D" ? "" : toolButton("open-in", "Open in…", icon("openIn", 13))}
    <label class="viewed-toggle${viewed ? " on" : ""}" title="Mark as viewed and collapse (v)"><input type="checkbox" data-act="viewed" ${viewed ? "checked" : ""}/>Viewed</label>`;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const fs = fileStates.get(e.target.closest(".file")?.dataset.path);
        if (!fs || isCollapsed(fs.file.path)) continue;
        if (e.isIntersecting && !fs.rendered) renderBody(fs);
        else if (!e.isIntersecting && fs.rendered && sel?.path !== fs.file.path && composer()?.path !== fs.file.path) unrender(fs);
      }
    },
    { root: scroller, rootMargin: `${RENDER_MARGIN}px 0px` },
  );

  function resetFiles() {
    for (const fs of fileStates.values()) {
      observer.unobserve(bodyOf(fs));
      fs.el.remove();
    }
    fileStates.clear();
    collapsed.clear();
    expanded.clear();
    sel = null;
    pendingScroll = st().selected;
    scroller.scrollTop = 0;
    publishSlots(false);
  }

  function renderFiles() {
    const files = st().error ? [] : orderedFiles(st());
    const keep = new Set(st().files.map((f) => f.path));
    for (const [path, fs] of fileStates) {
      if (keep.has(path)) continue;
      observer.unobserve(bodyOf(fs));
      fs.el.remove();
      fileStates.delete(path);
      if (sel?.path === path) sel = null;
      if (composer()?.path === path) review.set({ composer: null });
    }
    if (!files.length) {
      for (const fs of fileStates.values()) fs.el.remove();
      publishSlots(false);
      updateSelectionUi();
      return;
    }
    const shown = new Set(files.map((f) => f.path));
    for (const fs of fileStates.values()) if (!shown.has(fs.file.path)) fs.el.remove();
    let prev = null;
    for (const file of files) {
      let fs = fileStates.get(file.path);
      const sig = signature(file);
      if (!fs) {
        const el = document.createElement("section");
        el.className = "file";
        el.dataset.path = file.path;
        el.innerHTML = `<header class="file-header"></header><div class="file-body"></div>`;
        fs = { file, sig, el, rows: [], items: [], lines: null, revealed: [], tokens: null, spans: null, rendered: false, highlighting: null, slots: [] };
        setRows(fs);
        fileStates.set(file.path, fs);
        observer.observe(bodyOf(fs));
      } else if (fs.sig !== sig) {
        if (sel?.path === file.path) sel = null;
        if (composer()?.path === file.path && composer().editing == null) commitDraft();
        Object.assign(fs, { file, sig, lines: null, revealed: [] });
        setRows(fs);
      } else {
        fs.file = file;
      }
      if (prev ? prev.nextSibling !== fs.el : filesEl.firstChild !== fs.el) {
        if (prev) prev.after(fs.el);
        else filesEl.prepend(fs.el);
      }
      prev = fs.el;
      headerOf(fs).innerHTML = headerHtml(file);
      fs.el.classList.toggle("collapsed", isCollapsed(file.path));
      if (fs.rendered && fs.tokens == null && fs.highlighting == null) renderBody(fs);
      else if (!fs.rendered) placeholder(fs);
    }
    publishSlots(false);
    if (pendingScroll && fileStates.has(pendingScroll)) {
      const path = pendingScroll;
      pendingScroll = null;
      markCurrent(path);
      scrollToFile(path, { flash: false });
    } else {
      pendingScroll = null;
      spy();
    }
    updateSelectionUi();
    refreshFind();
  }

  function placeholder(fs) {
    const body = bodyOf(fs);
    body.innerHTML = "";
    body.style.height = isCollapsed(fs.file.path) ? "0px" : `${isDeferred(fs) ? 44 : Math.max(1, fs.items.length) * rowHeight + 8}px`;
    fs.rendered = false;
    clearSlots(fs);
  }

  // Rendered rows reflow on their own; placeholders are sized from the row height.
  function syncFontSize() {
    const root = document.documentElement;
    if (st().fontSize) root.style.setProperty("--font-size", `${st().fontSize}px`);
    else root.style.removeProperty("--font-size");
    const next = parseFloat(getComputedStyle(root).getPropertyValue("--row-h"));
    if (next === rowHeight) return;
    rowHeight = next;
    for (const fs of fileStates.values()) if (!fs.rendered) placeholder(fs);
    updateSelectionUi();
  }

  function unrender(fs) {
    const body = bodyOf(fs);
    body.style.height = `${body.getBoundingClientRect().height}px`;
    body.innerHTML = "";
    fs.rendered = false;
    clearSlots(fs);
  }

  function renderHeaders() {
    for (const fs of fileStates.values()) headerOf(fs).innerHTML = headerHtml(fs.file);
  }

  function nearViewport(el) {
    const rect = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    return rect.top < view.bottom + RENDER_MARGIN && rect.bottom > view.top - RENDER_MARGIN;
  }

  function syncCollapsed() {
    for (const fs of fileStates.values()) {
      const isShut = isCollapsed(fs.file.path);
      fs.el.classList.toggle("collapsed", isShut);
      headerOf(fs).innerHTML = headerHtml(fs.file);
      if (isShut) {
        if (fs.rendered || bodyOf(fs).style.height !== "0px") placeholder(fs);
      } else if (!fs.rendered) {
        placeholder(fs);
        if (fs.el.isConnected && nearViewport(fs.el)) renderBody(fs);
      }
    }
    updateSelectionUi();
  }

  async function highlight(fs) {
    const sig = fs.sig;
    const run = highlightRows(fs.rows, fs.file.path);
    fs.highlighting = run;
    try {
      const tokens = await run;
      if (fs.sig !== sig || fs.highlighting !== run || !tokens) return;
      fs.tokens = tokens;
      if (fs.rendered) renderBody(fs);
    } catch (error) {
      console.warn("highlight failed", fs.file.path, error);
    }
  }

  function pinForItem(fs, item) {
    const rows = "kind" in item ? [item] : [item.left, item.right];
    for (const row of rows) {
      if (!row || row.kind === "hunk") continue;
      const pin = st().pins.find((p) => p.path === fs.file.path && p.side === side(st()) && pinCovers(p, row));
      if (pin) return pin;
    }
    return null;
  }

  function renderBody(fs) {
    const body = bodyOf(fs);
    const above = pinnedAbove(fs);
    const before = body.getBoundingClientRect().height;
    const composing = composer()?.path === fs.file.path ? composer() : null;
    const keepFocus = Boolean(composing && !composing.focus && body.querySelector(".composer")?.contains(document.activeElement));
    body.style.height = "";
    if (isDeferred(fs)) {
      body.innerHTML = `<div class="body-note">Large diff (${fs.file.rows.length.toLocaleString()} lines) hidden to keep scrolling smooth.<button type="button" class="note-button" data-act="load-diff">Load diff</button></div>`;
    } else {
      fs.spans ??= wordSpans(fs.rows);
      if (fs.tokens == null && fs.highlighting == null) highlight(fs);
      body.innerHTML = bodyHtml({ ...fs.file, rows: fs.rows }, {
        items: fs.items,
        layout: st().layout,
        tokens: fs.tokens,
        spans: fs.spans,
        pinFor: (item) => pinForItem(fs, item),
        pins: pinsFor(st(), fs.file.path),
        composer: composing ? { afterIndex: composing.afterIndex, editing: composing.editing } : null,
      });
    }
    fs.rendered = true;
    const hadSlots = fs.slots.length > 0;
    fs.slots = [...body.querySelectorAll("[data-slot]")].map((el) => ({ key: el.dataset.slot === "composer" ? "composer" : `thread:${el.dataset.pin}`, el, pinId: el.dataset.pin, outdated: el.dataset.outdated === "1" }));
    if (keepFocus) review.set({ composer: { ...composing, focus: true } });
    if (hadSlots || fs.slots.length) publishSlots(true);
    if (above) scroller.scrollTop += body.getBoundingClientRect().height - before;
    paintSelection();
    scheduleFindPaint();
  }

  // The threads and the composer are React components portaled into the slots renderBody lays out.
  function publishSlots(sync) {
    const all = [...fileStates.values()].flatMap((fs) => fs.slots);
    const prev = st().slots;
    if (all.length === prev.length && all.every((s, i) => s.el === prev[i].el)) return;
    if (sync) flushSync(() => review.set({ slots: all }));
    else review.set({ slots: all });
  }

  function clearSlots(fs) {
    if (!fs.slots.length) return;
    fs.slots = [];
    publishSlots(false);
  }

  function rerenderBodies() {
    for (const fs of fileStates.values()) if (fs.rendered) renderBody(fs);
    updateSelectionUi();
  }

  function ensureRendered(path) {
    const fs = fileStates.get(path);
    if (!fs) return null;
    if (isCollapsed(path)) {
      collapsed.delete(path);
      expanded.add(path);
      syncCollapsed();
    }
    if (!fs.rendered) renderBody(fs);
    return fs;
  }

  function scrollToFile(path, { flash = true } = {}) {
    const fs = fileStates.get(path);
    if (!fs?.el.isConnected) return false;
    if (!isCollapsed(path) && !fs.rendered) renderBody(fs);
    scroller.scrollTop = fs.el.offsetTop - 8;
    spyHoldUntil = performance.now() + 200;
    if (flash) {
      fs.el.classList.add("flash");
      setTimeout(() => fs.el.classList.remove("flash"), 900);
    }
    return true;
  }

  // The file whose header is pinned at the top of the scroller.
  function currentFile() {
    const top = scroller.getBoundingClientRect().top + 1;
    let last = null;
    for (const el of filesEl.children) {
      if (!el.classList.contains("file")) continue;
      if (el.getBoundingClientRect().bottom > top) return fileStates.get(el.dataset.path) ?? null;
      last = el;
    }
    return last ? (fileStates.get(last.dataset.path) ?? null) : null;
  }

  function spy() {
    if (spyTimer) return;
    spyTimer = setTimeout(() => {
      spyTimer = 0;
      const fs = currentFile();
      if (fs) markCurrent(fs.file.path);
    }, 60);
  }

  function markCurrent(path) {
    if (!path || st().selected === path) return;
    review.setSelected(path);
  }

  function select(path, { focusList = false } = {}) {
    if (!path) return;
    flushSync(() => {
      const collapsedDirs = new Set(st().collapsedDirs);
      for (const d of [...collapsedDirs]) if (path.startsWith(`${d}/`)) collapsedDirs.delete(d);
      if (collapsedDirs.size !== st().collapsedDirs.size) review.set({ collapsedDirs });
      markCurrent(path);
    });
    scrollToFile(path);
    if (focusList) document.querySelector(`.list [data-path="${CSS.escape(path)}"]`)?.focus();
  }

  function stepFile(direction) {
    const files = orderedFiles(st());
    const idx = files.findIndex((f) => f.path === st().selected);
    const next = direction > 0 ? files[idx + 1] : idx > 0 ? files[idx - 1] : null;
    if (next) select(next.path, { focusList: Boolean(document.activeElement?.closest(".list")) });
    return Boolean(next);
  }

  // MARK: selection

  function selRange() {
    return [Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head)];
  }

  function paintSelection() {
    for (const el of filesEl.querySelectorAll(".row.selected")) el.classList.remove("selected");
    if (!sel) return;
    const fs = fileStates.get(sel.path);
    if (!fs?.rendered) return;
    const [lo, hi] = selRange();
    for (let i = lo; i <= hi; i++) fs.el.querySelector(`.row[data-row="${i}"]`)?.classList.add("selected");
  }

  function selRows() {
    const fs = sel && fileStates.get(sel.path);
    return fs ? rowsIn(fs.items, ...selRange()) : null;
  }

  function selReference() {
    const rows = selRows();
    return rows ? referenceFor(sel.path, rows) : "";
  }

  function updateSelectionUi() {
    paintSelection();
    const fs = sel && !drag && !composer() && fileStates.get(sel.path);
    const first = fs?.rendered && fs.el.querySelector(`.row[data-row="${selRange()[0]}"]`);
    if (!first || !selReference()) {
      selToolbar.hidden = true;
      return;
    }
    const last = fs.el.querySelector(`.row[data-row="${selRange()[1]}"]`);
    const view = scroller.getBoundingClientRect();
    const top = first.getBoundingClientRect().top - view.top + scroller.scrollTop;
    const bottom = last.getBoundingClientRect().bottom - view.top + scroller.scrollTop;
    selToolbar.hidden = false;
    const above = top - selToolbar.offsetHeight - 4;
    selToolbar.style.top = `${above > scroller.scrollTop + 40 ? above : bottom + 4}px`;
  }

  function clearSelection() {
    if (!sel) return false;
    sel = null;
    updateSelectionUi();
    return true;
  }

  function rowTarget(target) {
    const row = target?.closest?.(".row[data-row]");
    const section = row?.closest(".file");
    return row && section && !row.classList.contains("hunk") ? { path: section.dataset.path, index: Number(row.dataset.row) } : null;
  }

  function rowAt(clientY) {
    const view = scroller.getBoundingClientRect();
    const y = Math.max(view.top + 1, Math.min(view.bottom - 1, clientY));
    return rowTarget(document.elementFromPoint(view.left + 60, y));
  }

  function dragTo(clientY) {
    const t = rowAt(clientY);
    if (t && t.path === drag.path && t.index !== sel.head) {
      sel.head = t.index;
      paintSelection();
    }
  }

  function autoScroll() {
    if (!drag) return;
    const view = scroller.getBoundingClientRect();
    const delta = drag.y < view.top + 40 ? -18 : drag.y > view.bottom - 24 ? 18 : 0;
    if (delta) {
      scroller.scrollTop += delta;
      dragTo(drag.y);
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  filesEl.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0 || e.target.closest("button, input, textarea, label, .thread, .file-header")) return;
      const t = rowTarget(e.target);
      if (!t) return;
      e.preventDefault();
      scroller.focus({ preventScroll: true });
      if (e.shiftKey && sel?.path === t.path) {
        sel.head = t.index;
        updateSelectionUi();
        return;
      }
      drag = { path: t.path, y: e.clientY, raf: 0 };
      sel = { path: t.path, anchor: t.index, head: t.index };
      updateSelectionUi();
      autoScroll();
    },
    { signal },
  );

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!drag) return;
      drag.y = e.clientY;
      dragTo(e.clientY);
    },
    { signal },
  );

  document.addEventListener(
    "mouseup",
    () => {
      if (!drag) return;
      cancelAnimationFrame(drag.raf);
      drag = null;
      if (sel.anchor === sel.head) [sel.anchor, sel.head] = changeBlockAround(fileStates.get(sel.path).items, sel.anchor);
      updateSelectionUi();
    },
    { signal },
  );

  scroller.addEventListener(
    "scroll",
    () => {
      if (performance.now() > spyHoldUntil) spy();
      if (!selToolbar.hidden) updateSelectionUi();
    },
    { signal },
  );

  async function pasteSelection() {
    const ref = selReference();
    if (ref && review.send({ type: "paste", text: `${ref} ` })) review.toast(`Added ${ref} to the omp prompt`);
  }

  async function copySelection() {
    const ref = selReference();
    if (!ref) return;
    const ok = await copyText(ref);
    review.toast(ok ? `Copied ${ref}` : "Copy failed", !ok);
  }

  // MARK: comments

  function openComposer({ editing = null } = {}) {
    commitDraft();
    let next;
    if (editing) {
      const pin = st().pins.find((p) => p.id === editing);
      const fs = pin && ensureRendered(pin.path);
      if (!fs) return;
      let afterIndex = -1;
      fs.items.forEach((item, i) => {
        if (pinForItem(fs, item)?.id === pin.id) afterIndex = i;
      });
      next = { path: pin.path, afterIndex, reference: formatPin(pin), note: pin.note, editing, pin, focus: true };
    } else {
      const rows = selRows();
      const pin = rows && pinFromSelection(sel.path, rows, side(st()));
      if (!pin) {
        review.toast("Select lines to comment on", true);
        return;
      }
      next = { path: sel.path, afterIndex: selRange()[1], reference: formatPin(pin), note: "", editing: null, pin, focus: true };
    }
    review.set({ composer: next });
    selToolbar.hidden = true;
    const fs = ensureRendered(next.path);
    if (fs) renderBody(fs);
  }

  function renderComposerFile(path) {
    const fs = path && fileStates.get(path);
    if (fs?.rendered) renderBody(fs);
    updateSelectionUi();
  }

  function closeComposer() {
    const path = composer()?.path;
    review.set({ composer: null });
    renderComposerFile(path);
    scroller.focus({ preventScroll: true });
  }

  function commitDraft() {
    const draft = composer();
    if (!draft) return;
    const note = draft.note.trim();
    const { editing, pin, path } = draft;
    review.set({ composer: null });
    if (!note) {
      renderComposerFile(path);
      return;
    }
    if (editing) review.setPins(st().pins.map((p) => (p.id === editing ? { ...p, note } : p)));
    else review.setPins([...st().pins, { ...pin, note }]);
  }

  function discardDraft() {
    commitDraft();
    closeComposer();
  }

  function sendReview() {
    commitDraft();
    if (!st().pins.length) return;
    if (!review.send({ type: "send", text: reviewMessage(st().pins) })) return;
    review.setPins([]);
    review.toast("Review sent to omp");
  }

  function sendDraftNow() {
    const draft = composer();
    const note = draft?.note.trim();
    if (!draft || !note) return;
    const { editing, pin, path } = draft;
    if (!review.send({ type: "send", text: singleMessage({ ...pin, note }) })) return;
    review.set({ composer: null });
    sel = null;
    if (editing) review.setPins(st().pins.filter((p) => p.id !== editing));
    else renderComposerFile(path);
    review.toast("Sent to omp");
  }

  function scrollToPin(id) {
    const pin = st().pins.find((p) => p.id === id);
    const fs = pin && ensureRendered(pin.path);
    if (!fs) return;
    pinCursor = id;
    markCurrent(pin.path);
    const thread = fs.el.querySelector(`.thread[data-pin="${CSS.escape(id)}"]`);
    if (!thread) return;
    thread.scrollIntoView({ block: "center" });
    thread.classList.add("flash");
    setTimeout(() => thread.classList.remove("flash"), 1200);
  }

  function stepPin(direction) {
    const order = new Map(orderedFiles(st()).map((f, i) => [f.path, i]));
    const key = (p) => [order.get(p.path), p.startLine ?? 0];
    const pins = st().pins.filter((p) => p.side === side(st()) && order.has(p.path)).sort((a, b) => {
      const [fa, la] = key(a);
      const [fb, lb] = key(b);
      return fa - fb || la - lb;
    });
    if (!pins.length) return;
    let idx = pins.findIndex((p) => p.id === pinCursor && p.path === st().selected);
    if (idx < 0) {
      const here = order.get(st().selected) ?? -1;
      if (direction > 0) {
        const first = pins.findIndex((p) => key(p)[0] >= here);
        idx = (first < 0 ? pins.length : first) - 1;
      } else {
        idx = pins.findLastIndex((p) => key(p)[0] <= here) + 1;
      }
    }
    scrollToPin(pins[(idx + direction + pins.length) % pins.length].id);
  }

  // MARK: navigation

  function changePositions() {
    const out = [];
    for (const file of orderedFiles(st())) {
      const fs = fileStates.get(file.path);
      if (!fs || isCollapsed(file.path) || isDeferred(fs)) continue;
      for (const start of blockStarts(fs.items)) out.push({ path: file.path, index: start });
    }
    return out;
  }

  function currentPosition() {
    if (sel) return { path: sel.path, index: selRange()[0] };
    const fs = currentFile();
    if (!fs) return null;
    const top = scroller.getBoundingClientRect().top + 40;
    const rows = fs.rendered ? [...fs.el.querySelectorAll(".row[data-row]")] : [];
    const row = rows.find((r) => r.getBoundingClientRect().bottom > top);
    return { path: fs.file.path, index: row ? Number(row.dataset.row) - 1 : -1 };
  }

  function jumpChange(direction) {
    const all = changePositions();
    if (!all.length) return;
    const here = currentPosition();
    const order = new Map(orderedFiles(st()).map((f, i) => [f.path, i]));
    const cmp = (a, b) => order.get(a.path) - order.get(b.path) || a.index - b.index;
    const target = !here
      ? direction > 0
        ? all[0]
        : all.at(-1)
      : direction > 0
        ? (all.find((p) => cmp(p, here) > 0) ?? all[0])
        : (all.findLast((p) => cmp(p, here) < 0) ?? all.at(-1));
    const fs = ensureRendered(target.path);
    const [lo, hi] = changeBlockAround(fs.items, target.index);
    sel = { path: target.path, anchor: lo, head: hi };
    paintSelection();
    fs.el.querySelector(`.row[data-row="${lo}"]`)?.scrollIntoView({ block: "center" });
    markCurrent(target.path);
    updateSelectionUi();
  }

  function nextUnviewed(path) {
    const files = orderedFiles(st());
    const idx = files.findIndex((f) => f.path === path);
    const unviewed = (f) => f.path !== path && !st().viewed[viewedKey(st(), f.path)];
    return files.slice(idx + 1).find(unviewed) ?? files.slice(0, Math.max(idx, 0)).find(unviewed);
  }

  function toggleViewed(path, viewed) {
    const fs = fileStates.get(path);
    const pinned = pinnedAbove(fs);
    if (viewed && sel?.path === path) sel = null;
    if (viewed && composer()?.path === path) commitDraft();
    collapsed.delete(path);
    expanded.delete(path);
    review.setViewed(path, viewed);
    syncCollapsed();
    if (viewed && pinned) scroller.scrollTop = fs.el.offsetTop - 8;
  }

  function toggleCollapsed(path) {
    if (isCollapsed(path)) {
      collapsed.delete(path);
      expanded.add(path);
    } else {
      collapsed.add(path);
      expanded.delete(path);
      if (sel?.path === path) sel = null;
    }
    const pinned = pinnedAbove(fileStates.get(path));
    syncCollapsed();
    if (pinned) scroller.scrollTop = fileStates.get(path).el.offsetTop - 8;
  }

  function setLayout(layout) {
    commitDraft();
    review.setLayout(layout);
    sel = null;
    for (const fs of fileStates.values()) {
      fs.items = itemsFor(fs.rows);
      if (fs.rendered) renderBody(fs);
      else placeholder(fs);
    }
    updateSelectionUi();
    refreshFind();
  }

  async function expandGap(fs, gap, dir) {
    if (!fs.lines) {
      const sig = fs.sig;
      const lines = await api("/api/lines", { ...compareQuery(st().compare), path: fs.file.path }).catch((error) => review.toast(`Couldn't read ${fs.file.path}: ${error.message}`, true));
      if (!lines || fs.sig !== sig) return;
      fs.lines = lines;
    }
    const bounded = Number.isFinite(gap.to) ? gap : { ...gap, to: fs.lines.length };
    if (bounded.from <= bounded.to) fs.revealed.push(revealRange(bounded, dir));
    if (composer()?.path === fs.file.path && composer().editing == null) commitDraft();
    if (sel?.path === fs.file.path) sel = null;
    setRows(fs);
    renderBody(fs);
    updateSelectionUi();
    refreshFind();
  }

  // The line an editor opens at: the first added line of the selection, else of the file.
  function openLine(path) {
    const rows = sel?.path === path ? selRows() : fileStates.get(path)?.rows;
    return rows?.find((r) => r.kind === "addition" && r.newLineNumber != null)?.newLineNumber ?? rows?.find((r) => r.newLineNumber != null)?.newLineNumber ?? null;
  }

  // MARK: find

  const findState = () => st().find;

  function itemTexts(item) {
    if ("kind" in item) return item.kind === "hunk" ? [] : [item.kind === "deletion" ? item.oldText : item.newText];
    if (item.hunk) return [];
    return item.left === item.right ? [item.right?.newText] : [item.left?.oldText, item.right?.newText];
  }

  // Smart case: lowercase queries match case-insensitively.
  function findNeedle() {
    const { open, query } = findState();
    const q = open ? query : "";
    return q ? { q, ci: q === q.toLowerCase() } : null;
  }

  const hasNeedle = (text, n) => text != null && (n.ci ? text.toLowerCase() : text).includes(n.q);

  function publishFind() {
    review.set((s) => ({ find: { ...s.find, total: find.matches.length, current: find.current } }));
  }

  function computeFind({ fromView = false } = {}) {
    const prev = find.matches[find.current];
    const n = findNeedle();
    find.matches = [];
    if (n) {
      for (const file of orderedFiles(st())) {
        const fs = fileStates.get(file.path);
        fs?.items.forEach((item, index) => {
          if (itemTexts(item).some((t) => hasNeedle(t, n))) find.matches.push({ path: file.path, index });
        });
      }
    }
    const order = new Map(orderedFiles(st()).map((f, i) => [f.path, i]));
    const anchor = fromView ? { path: currentFile()?.file.path, index: 0 } : prev;
    find.current = !find.matches.length ? -1 : anchor?.path ? find.matches.findIndex((m) => order.get(m.path) > order.get(anchor.path) || (m.path === anchor.path && m.index >= anchor.index)) : 0;
    if (find.matches.length && find.current < 0) find.current = 0;
    publishFind();
    scheduleFindPaint();
  }

  function refreshFind() {
    if (findState().query && findState().open) computeFind();
  }

  function revealMatch() {
    const m = find.matches[find.current];
    if (!m) return;
    loadedLarge.add(m.path);
    const fs = ensureRendered(m.path);
    fs?.el.querySelector(`.row[data-row="${m.index}"]`)?.scrollIntoView({ block: "center" });
    markCurrent(m.path);
    publishFind();
    scheduleFindPaint();
  }

  function stepFind(step) {
    if (!find.matches.length) return;
    find.current = (Math.max(find.current, step > 0 ? -1 : 0) + step + find.matches.length) % find.matches.length;
    revealMatch();
  }

  function setFindQuery(query) {
    review.set((s) => ({ find: { ...s.find, query } }));
    computeFind({ fromView: true });
    revealMatch();
  }

  function openFind() {
    const prev = findState().query;
    const picked = String(getSelection() ?? "").trim();
    const query = picked && !picked.includes("\n") ? picked : prev;
    review.set((s) => ({ find: { ...s.find, open: true, query, focus: s.find.focus + 1 } }));
    if (query !== prev || !find.matches.length) {
      computeFind({ fromView: true });
      revealMatch();
    }
  }

  function closeFind() {
    review.set((s) => ({ find: { ...s.find, open: false } }));
    paintFind();
    scroller.focus({ preventScroll: true });
  }

  function rangesIn(el, n) {
    const nodes = [];
    let text = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, start: text.length });
      text += node.data;
    }
    const hay = n.ci ? text.toLowerCase() : text;
    const at = (pos) => {
      let k = nodes.length - 1;
      while (k > 0 && nodes[k].start > pos) k--;
      return [nodes[k].node, pos - nodes[k].start];
    };
    const out = [];
    for (let i = hay.indexOf(n.q); i >= 0 && n.q; i = hay.indexOf(n.q, i + n.q.length)) {
      const range = new Range();
      range.setStart(...at(i));
      range.setEnd(...at(i + n.q.length));
      out.push(range);
    }
    return out;
  }

  function scheduleFindPaint() {
    cancelAnimationFrame(findFrame);
    findFrame = requestAnimationFrame(paintFind);
  }

  function paintFind() {
    for (const el of filesEl.querySelectorAll(".row.find-current")) el.classList.remove("find-current");
    const n = findNeedle();
    const current = find.matches[find.current];
    const currentRow = n && current ? fileStates.get(current.path)?.el.querySelector(`.row[data-row="${current.index}"]`) : null;
    currentRow?.classList.add("find-current");
    if (!("highlights" in CSS)) return;
    if (!n) {
      CSS.highlights.delete("find");
      CSS.highlights.delete("find-current");
      return;
    }
    const all = [];
    const now = [];
    for (const fs of fileStates.values()) {
      if (!fs.rendered) continue;
      for (const code of fs.el.querySelectorAll(".row:not(.hunk) .code")) {
        for (const range of rangesIn(code, n)) (code.closest(".row") === currentRow ? now : all).push(range);
      }
    }
    CSS.highlights.set("find", new Highlight(...all));
    CSS.highlights.set("find-current", new Highlight(...now));
  }

  // MARK: events

  filesEl.addEventListener(
    "click",
    async (e) => {
      const actEl = e.target.closest("[data-act]");
      const act = actEl?.dataset.act;
      const header = e.target.closest(".file-header");
      if (!act && header && !e.target.closest("label")) {
        toggleCollapsed(header.closest(".file").dataset.path);
        return;
      }
      if (!act) return;
      const path = actEl.closest(".file")?.dataset.path;
      if (act === "load-diff") {
        if (path) {
          loadedLarge.add(path);
          renderBody(fileStates.get(path));
        }
      } else if (act === "copy-path") {
        if (path) {
          const ok = await copyText(path);
          review.toast(ok ? `Copied ${path}` : "Copy failed", !ok);
        }
      } else if (act === "open-in") {
        if (path) review.set({ openInMenu: { anchor: actEl, path, line: openLine(path) } });
      } else if (act === "expand") {
        const fs = path && fileStates.get(path);
        const item = fs?.items[Number(actEl.closest(".row")?.dataset.row)];
        const gap = item && ("kind" in item ? item : item.hunk)?.gap;
        if (gap) expandGap(fs, gap, actEl.dataset.dir);
      } else if (act === "comment-line") {
        const t = rowTarget(e.target);
        if (t) {
          sel = { path: t.path, anchor: t.index, head: t.index };
          openComposer();
        }
      }
    },
    { signal },
  );

  filesEl.addEventListener(
    "change",
    (e) => {
      const path = e.target.closest(".file")?.dataset.path;
      if (e.target.dataset.act === "viewed" && path) toggleViewed(path, e.target.checked);
    },
    { signal },
  );

  const resize = new ResizeObserver(() => updateSelectionUi());
  resize.observe(scroller);

  syncFontSize();
  renderFiles();

  return {
    renderFiles,
    renderHeaders,
    rerenderBodies,
    resetFiles,
    syncCollapsed,
    syncFontSize,
    updateSelectionUi,
    select,
    stepFile,
    stepPin,
    jumpChange,
    nextUnviewed,
    toggleViewed,
    setLayout,
    clearSelection,
    hasSelection: () => Boolean(sel),
    hasFile: (path) => fileStates.has(path),
    selReference,
    pasteSelection,
    copySelection,
    openComposer,
    discardDraft,
    closeComposer,
    sendReview,
    sendDraftNow,
    commitDraft,
    openLine,
    openFind,
    closeFind,
    stepFind,
    setFindQuery,
    dispose() {
      abort.abort();
      observer.disconnect();
      resize.disconnect();
      clearTimeout(spyTimer);
      cancelAnimationFrame(findFrame);
    },
  };
}
