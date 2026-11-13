import { esc, parsePlan } from "../src/shared/blocks.js";
import { feedbackMessage, lineRange } from "../src/shared/feedback.js";
import { PROTOCOL } from "../src/shared/protocol.js";
import { compareRevisions } from "../src/shared/revision.js";
import { icon } from "./icons.js";

const token = new URLSearchParams(location.search).get("token") ?? "";
const APPROVALS = new Set(["execute", "compact", "keep"]);
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl ";

const state = {
  connected: false,
  working: false,
  stale: false,
  review: null,
  blocks: [],
  html: "",
  hunks: [],
  hunk: -1,
  comments: [],
  note: "",
  composer: null,
  role: null,
  busy: false,
};

const app = document.getElementById("app");
app.innerHTML = `
  <header class="topbar">
    <div class="heading"><span class="plan-title"></span><span class="plan-path mono muted"></span></div>
    <span class="status"></span>
    <span class="spacer"></span>
    <div class="changes" hidden>
      <span class="changes-count"></span>
      <button type="button" class="tool-button" data-act="prev-change" title="Previous change (p)">${icon("chevronUp")}</button>
      <button type="button" class="tool-button" data-act="next-change" title="Next change (n)">${icon("chevronDown")}</button>
    </div>
  </header>
  <div class="banner" hidden></div>
  <div class="body">
    <nav class="outline" aria-label="Sections"></nav>
    <div class="scroller" tabindex="-1">
      <article class="doc"></article>
      <button type="button" class="gutter-add" data-act="comment-block" title="Comment (c) · shift-click extends the open comment" hidden>${icon("commentAdd", 13)}</button>
      <button type="button" class="btn sm sel-comment" data-act="comment-selection" hidden>${icon("commentAdd", 13)}<span>Comment</span></button>
    </div>
  </div>
  <footer class="actions" hidden></footer>`;

const scroller = app.querySelector(".scroller");
const doc = app.querySelector(".doc");
const outline = app.querySelector(".outline");
const gutterAdd = app.querySelector(".gutter-add");
const selComment = app.querySelector(".sel-comment");
const actions = app.querySelector(".actions");
let hovered = null;

// MARK: storage

const storageKey = (reviewId) => `plan-review:${reviewId}`;

function loadDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(state.review.reviewId)) ?? "null");
    state.comments = Array.isArray(saved?.comments) ? saved.comments : [];
    state.note = typeof saved?.note === "string" ? saved.note : "";
  } catch {
    state.comments = [];
    state.note = "";
  }
}

function saveDraft() {
  if (!state.review) return;
  if (state.comments.length || state.note.trim()) localStorage.setItem(storageKey(state.review.reviewId), JSON.stringify({ comments: state.comments, note: state.note }));
  else localStorage.removeItem(storageKey(state.review.reviewId));
}

// MARK: socket

let retry = 0;

function connect() {
  const socket = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
  socket.onopen = () => {
    retry = 0;
    state.connected = true;
    renderBanner();
  };
  socket.onmessage = (e) => onSocket(JSON.parse(e.data));
  socket.onclose = () => {
    state.connected = false;
    renderBanner();
    setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
  };
}

function onSocket(msg) {
  if (msg.type === "appearance" || msg.type === "hello") {
    document.getElementById("appearance").href = `/appearance.css?token=${encodeURIComponent(token)}&t=${Date.now()}`;
  }
  if (msg.type === "hello") {
    state.stale = msg.protocol !== PROTOCOL;
    state.working = Boolean(msg.working);
    renderBanner();
    setReview(msg.review);
  } else if (msg.type === "review") {
    setReview(msg.review);
  } else if (msg.type === "working") {
    state.working = msg.working;
    renderHeader();
    if (!state.review) renderDoc();
    renderActions();
  }
}

function setReview(review) {
  const same = review && state.review?.reviewId === review.reviewId;
  state.review = review;
  if (!same) {
    state.composer = null;
    state.hunk = -1;
    if (review) {
      ({ html: state.html, blocks: state.blocks } = parsePlan(review.planContent));
      state.hunks = review.previous === null ? [] : compareRevisions(parsePlan(review.previous).blocks, state.blocks);
      const roles = review.tiers?.map((t) => t.role) ?? [];
      state.role = roles.includes("default") ? "default" : (roles[0] ?? null);
      loadDraft();
    } else {
      state.html = "";
      state.blocks = [];
      state.hunks = [];
      state.comments = [];
      state.note = "";
    }
  }
  document.title = review ? `Plan · ${review.title}` : "Plan review";
  renderHeader();
  if (!same) renderDoc();
  renderActions();
}

// MARK: header and banner

function resolutionText({ choice, by }) {
  const label = state.review.options.find((o) => o.id === choice)?.label;
  if (!label) return "Review closed without an answer";
  if (choice === "refine") {
    const who = by === "page" ? "Feedback sent" : by === "local" ? "Refinement asked in the terminal" : "An extension (such as Control's plan checks) asked for a refinement";
    return `${who}; the revised plan opens here`;
  }
  return by === "page" ? label : `${label} · answered ${by === "local" ? "in the terminal" : "by an extension"}`;
}

function statusText() {
  const review = state.review;
  if (!review) return state.working ? "Working" : "";
  if (!review.resolution) return review.previous === null ? "Waiting for review" : "Revised plan";
  if (!state.working) return review.resolution.choice === "refine" ? "Sent for refinement" : "Answered";
  return review.resolution.choice === "refine" ? "Revising" : APPROVALS.has(review.resolution.choice) ? "Executing" : "Working";
}

/** What omp is doing after the answer, while its turn runs. */
function activityText() {
  const choice = state.review?.resolution?.choice;
  if (!state.working) return "";
  if (choice === "refine") return "omp is revising the plan…";
  return APPROVALS.has(choice) ? "omp is executing the plan…" : "omp is working…";
}

function renderHeader() {
  const review = state.review;
  app.querySelector(".plan-title").textContent = review?.title ?? "Plan review";
  const path = app.querySelector(".plan-path");
  path.textContent = review?.planFilePath ?? "";
  path.title = review?.planFilePath ?? "";
  const status = app.querySelector(".status");
  const text = statusText();
  status.hidden = !text;
  status.className = `status ${review && !review.resolution ? "waiting" : "done"}`;
  status.innerHTML = `${state.working && (!review || review.resolution) ? icon("loader", 11, "spin") : ""}${esc(text)}`;
  const changes = app.querySelector(".changes");
  changes.hidden = !state.hunks.length;
  app.querySelector(".changes-count").textContent = state.hunk < 0 ? `${state.hunks.length} change${state.hunks.length > 1 ? "s" : ""}` : `Change ${state.hunk + 1} of ${state.hunks.length}`;
}

function renderBanner() {
  const banner = app.querySelector(".banner");
  const text = !state.connected
    ? "Not connected to omp. This page reconnects when the session is back; /plan-review reopens it."
    : state.stale
      ? "This page is newer than the running Plan Review plugin: restart omp."
      : "";
  banner.hidden = !text;
  banner.textContent = text;
}

// MARK: document

const blockEl = (id) => doc.querySelector(`.block[data-block="${id}"]`);
// Gutter columns inside .doc's 64px left padding (app.css): the + button, then the change bars.
const GUTTER_X = 16;
const BAR_X = 44;

function previousHtml(texts, removal, hunk) {
  const summary = removal ? `Removed ${texts.length} block${texts.length > 1 ? "s" : ""}` : "Previous version";
  return `<details class="previous${removal ? " removal" : ""}"${hunk === null ? "" : ` data-hunk="${hunk}"`}><summary>${icon("history", 12)}<span>${summary}</span></summary><pre>${esc(texts.join("\n\n"))}</pre></details>`;
}

function insertAfter(anchorId, html) {
  const anchor = anchorId && blockEl(anchorId);
  if (anchor) anchor.insertAdjacentHTML("afterend", html);
  else doc.insertAdjacentHTML("afterbegin", html);
}

function threadHtml(comment) {
  return `<section class="thread" data-comment="${esc(comment.id)}">
    <div class="thread-head">${icon("comment", 12)}<span class="thread-ref">${lineRange(comment)}</span><span class="spacer"></span>
      <button type="button" class="tool-button" data-act="edit-comment" title="Edit">${icon("edit", 12)}</button>
      <button type="button" class="tool-button" data-act="delete-comment" title="Delete">${icon("trash", 12)}</button>
    </div>
    <div class="thread-body">${esc(comment.note)}</div>
  </section>`;
}

function composerHtml(composer) {
  return `<section class="thread composer">
    <div class="thread-head">${icon("commentAdd", 12)}<span class="thread-ref">${lineRange(composer)}</span></div>
    <textarea class="field" placeholder="Comment on ${composer.start === composer.end ? "this line" : "these lines"}…" spellcheck="true">${esc(composer.note)}</textarea>
    <div class="composer-actions">
      <span class="hint">⌘↵ to save · Esc to cancel</span><span class="spacer"></span>
      <button type="button" class="btn sm ghost" data-act="cancel-comment">Cancel</button>
      <button type="button" class="btn sm primary" data-act="save-comment">Save comment</button>
    </div>
  </section>`;
}

function renderDoc() {
  hideFloating();
  if (!state.review) {
    doc.innerHTML = state.working
      ? `<div class="empty">${icon("loader", 16, "spin")}<p>omp is working. Its plan opens here when it asks you to review it.</p></div>`
      : `<div class="empty"><p>No plan is waiting for review. When omp asks you to review a plan, it opens here.</p></div>`;
    renderOutline();
    return;
  }
  doc.innerHTML = state.html;
  state.hunks.forEach((hunk, i) => {
    const kind = hunk.before.length ? "changed" : "added";
    for (const id of hunk.blocks) blockEl(id)?.classList.add(kind);
    if (hunk.blocks.length) {
      blockEl(hunk.blocks[0])?.setAttribute("data-hunk", String(i));
      if (hunk.before.length) insertAfter(hunk.blocks.at(-1), previousHtml(hunk.before, false, null));
    } else {
      insertAfter(hunk.after, previousHtml(hunk.before, true, i));
    }
  });
  // Change bars share one gutter column, whatever the block's list depth.
  const docLeft = doc.getBoundingClientRect().left;
  for (const el of doc.querySelectorAll(".block.added, .block.changed")) el.style.setProperty("--bar-x", `${BAR_X - (el.getBoundingClientRect().left - docLeft)}px`);
  for (const comment of state.comments) if (state.composer?.editing !== comment.id) threadAfter(comment.to, threadHtml(comment));
  if (state.composer) {
    threadAfter(state.composer.to, composerHtml(state.composer));
    const textarea = doc.querySelector(".composer textarea");
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.closest(".composer").scrollIntoView({ block: "nearest" });
  }
  renderOutline();
}

// MARK: outline

/** The plan's h1–h3 sections, each with the changes and comments between its heading and the next one. */
function sections() {
  const headings = [...doc.querySelectorAll(".block > :is(h1, h2, h3):first-child")].map((h) => ({
    id: h.parentElement.dataset.block,
    level: Number(h.tagName[1]),
    text: h.textContent,
  }));
  const index = new Map(state.blocks.map((b, i) => [b.id, i]));
  const starts = headings.map((h) => index.get(h.id));
  const sectionOf = (id) => starts.findLastIndex((start) => start <= (index.get(id) ?? 0));
  const out = headings.map((h) => ({ ...h, comments: 0, change: null }));
  for (const c of state.comments) if (sectionOf(c.from) >= 0) out[sectionOf(c.from)].comments++;
  for (const hunk of state.hunks) {
    const section = out[sectionOf(hunk.blocks[0] ?? hunk.after)];
    if (section && section.change !== "changed") section.change = hunk.before.length ? "changed" : "added";
  }
  return out;
}

function renderOutline() {
  const list = state.review ? sections() : [];
  app.classList.toggle("no-outline", list.length < 2);
  outline.innerHTML = list
    .map(
      (s) => `<button type="button" class="level-${s.level}" data-section="${s.id}" title="${esc(s.text)}">
        <span class="label">${esc(s.text)}</span>
        ${s.comments ? `<span class="badge">${icon("comment", 11)}${s.comments}</span>` : ""}
        ${s.change ? `<span class="dot ${s.change}" title="${s.change === "added" ? "Added" : "Changed"} since the previous plan"></span>` : ""}
      </button>`,
    )
    .join("");
  markCurrentSection();
}

function markCurrentSection() {
  const top = scroller.getBoundingClientRect().top + 24;
  let current = null;
  for (const button of outline.querySelectorAll("[data-section]")) {
    if (blockEl(button.dataset.section)?.getBoundingClientRect().top <= top) current = button;
  }
  current ??= outline.querySelector("[data-section]");
  for (const button of outline.querySelectorAll("[data-section]")) button.classList.toggle("current", button === current);
}

// Threads stack under their block, after any previous-version disclosure and earlier threads.
function threadAfter(blockId, html) {
  let anchor = blockEl(blockId);
  if (!anchor) return;
  while (anchor.nextElementSibling?.matches(".previous, .thread")) anchor = anchor.nextElementSibling;
  anchor.insertAdjacentHTML("afterend", html);
}

// MARK: comments

function openComposer(fromId, toId, { excerpt = null, note = "" } = {}) {
  commitComposer();
  let [a, b] = [state.blocks.findIndex((x) => x.id === fromId), state.blocks.findIndex((x) => x.id === toId)];
  if (a < 0 || b < 0) return;
  if (a > b) [a, b] = [b, a];
  const range = state.blocks.slice(a, b + 1);
  state.composer = {
    from: range[0].id,
    to: range.at(-1).id,
    start: range[0].start,
    end: range.at(-1).end,
    excerpt: excerpt ?? range.map((r) => r.text).join("\n"),
    note,
    editing: null,
  };
  renderDoc();
}

function extendComposer(toId) {
  const { from } = state.composer;
  const note = doc.querySelector(".composer textarea")?.value ?? "";
  state.composer = null;
  openComposer(from, toId, { note });
}

function editComment(id) {
  commitComposer();
  const comment = state.comments.find((c) => c.id === id);
  if (!comment) return;
  state.composer = { ...comment, editing: id };
  renderDoc();
}

/** Keeps the open composer's text as a comment (or edit); an empty one is dropped. */
function commitComposer() {
  const composer = state.composer;
  if (!composer) return;
  const note = (doc.querySelector(".composer textarea")?.value ?? composer.note).trim();
  state.composer = null;
  const { editing, ...fields } = composer;
  if (editing) state.comments = note ? state.comments.map((c) => (c.id === editing ? { ...c, note } : c)) : state.comments.filter((c) => c.id !== editing);
  else if (note) state.comments = [...state.comments, { ...fields, id: crypto.randomUUID(), note }];
  state.comments.sort((x, y) => x.start - y.start || x.end - y.end);
  saveDraft();
}

function saveComposer() {
  commitComposer();
  renderDoc();
  renderActions();
  scroller.focus({ preventScroll: true });
}

function cancelComposer() {
  state.composer = null;
  renderDoc();
  scroller.focus({ preventScroll: true });
}

function deleteComment(id) {
  state.comments = state.comments.filter((c) => c.id !== id);
  saveDraft();
  renderDoc();
  renderActions();
}

// MARK: floating controls

function hideFloating() {
  gutterAdd.hidden = true;
  selComment.hidden = true;
  hovered = null;
}

function placeGutter(block) {
  hovered = block.dataset.block;
  const top = block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  gutterAdd.style.top = `${top}px`;
  gutterAdd.style.left = `${doc.offsetLeft + GUTTER_X}px`;
  gutterAdd.hidden = !state.review || Boolean(state.review.resolution);
}

function selectionRange() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return null;
  const blockOf = (node) => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest(".doc .block");
  const from = blockOf(sel.anchorNode);
  const to = blockOf(sel.focusNode);
  return from && to ? { from: from.dataset.block, to: to.dataset.block, text: sel.toString().trim(), rect: sel.getRangeAt(0).getBoundingClientRect() } : null;
}

function updateSelectionButton() {
  const range = !state.review?.resolution && selectionRange();
  selComment.hidden = !range;
  if (!range) return;
  const box = scroller.getBoundingClientRect();
  selComment.style.top = `${range.rect.bottom - box.top + scroller.scrollTop + 6}px`;
  selComment.style.left = `${Math.max(8, range.rect.left - box.left)}px`;
}

function commentOnSelection() {
  const range = selectionRange();
  if (!range) return false;
  getSelection().removeAllRanges();
  openComposer(range.from, range.to, { excerpt: range.text });
  return true;
}

// MARK: changes

function goToChange(step) {
  if (!state.hunks.length) return;
  state.hunk = (state.hunk + step + state.hunks.length) % state.hunks.length;
  renderHeader();
  const el = doc.querySelector(`[data-hunk="${state.hunk}"]`);
  if (!el) return;
  if (el.matches("details")) el.open = true;
  el.scrollIntoView({ block: "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1200);
}

// MARK: actions

function pendingFeedback() {
  const draft = doc.querySelector(".composer textarea")?.value.trim();
  return state.comments.length + (draft ? 1 : 0) + (state.note.trim() ? 1 : 0);
}

function renderActions() {
  const review = state.review;
  actions.hidden = !review;
  app.classList.toggle("resolved", Boolean(review?.resolution));
  if (!review) return;
  if (review.resolution) {
    const activity = activityText();
    actions.innerHTML = `<div class="resolution">${icon("check", 14)}<span>${esc(resolutionText(review.resolution))}</span>${activity ? `<span class="activity">${icon("loader", 13, "spin")}${esc(activity)}</span>` : ""}</div>`;
    return;
  }
  const feedback = pendingFeedback();
  const refine = review.options.find((o) => o.id === "refine");
  const [primary, ...others] = review.options.filter((o) => o.id !== "refine");
  const tiers = review.tiers?.length > 1 ? review.tiers : null;
  const choice = (o, cls, keys = "") =>
    `<button type="button" class="btn ${cls}" data-choice="${esc(o.id)}"${o.disabled || state.busy ? " disabled" : ""}>${o.id === "execute" ? icon("check", 13) : ""}<span>${esc(o.label)}</span>${keys ? `<kbd>${keys}</kbd>` : ""}</button>`;
  const count = state.comments.length;
  actions.innerHTML = `
    <textarea class="field note" rows="3" placeholder="Overall feedback on the plan${count ? " (optional)" : ", or hover a line and press + to comment on it"}…" spellcheck="true">${esc(state.note)}</textarea>
    <div class="action-bar">
    ${count ? `<span class="count" title="Comments on the plan's lines">${icon("comment", 12)}${count} comment${count > 1 ? "s" : ""}</span>` : ""}
    <span class="spacer"></span>
    ${tiers ? `<select class="field tier" data-act="tier" title="Model to continue with">${tiers.map((t) => `<option value="${esc(t.role)}"${t.role === state.role ? " selected" : ""}>${esc(t.role)} · ${esc(t.model)}</option>`).join("")}</select>` : ""}
    ${refine ? `<button type="button" class="btn ${feedback ? "primary" : ""}" data-choice="refine"${refine.disabled || !feedback || state.busy ? " disabled" : ""} title="Send your comments and ask for a revised plan">${icon("send", 13)}<span>${esc(refine.label)}</span><kbd>${MOD}↵</kbd></button>` : ""}
    ${primary ? `<div class="split-button">${choice(primary, feedback ? "" : "primary", primary === approval() ? `${MOD}⇧↵` : "")}${others.length ? `<details class="more"><summary class="btn ${feedback ? "" : "primary"}" title="Other answers">${icon("chevronDown", 13)}</summary><div class="menu">${others.map((o) => choice(o, "ghost")).join("")}</div></details>` : ""}</div>` : ""}
  </div>`;
}

/** The approval ⌘⇧↵ picks: omp's first enabled one, as Enter in its dialog would. */
function approval() {
  return state.review?.options.find((o) => APPROVALS.has(o.id) && !o.disabled);
}

async function choose(choice) {
  const review = state.review;
  if (!review || review.resolution || state.busy) return;
  commitComposer();
  renderDoc();
  const body = { reviewId: review.reviewId, choice };
  if (choice === "refine") {
    body.feedback = feedbackMessage(state.comments, state.note);
    if (!body.feedback) return;
  } else {
    const pending = state.comments.length + (state.note.trim() ? 1 : 0);
    if (pending && !confirm(`${pending === 1 ? "Your feedback isn't sent" : `${pending} pieces of feedback aren't sent`}. Answer without ${pending === 1 ? "it" : "them"}?`)) return renderActions();
    if (APPROVALS.has(choice) && state.role && review.tiers?.length > 1) body.role = state.role;
  }
  state.busy = true;
  renderActions();
  try {
    const res = await fetch(`/api/resolve?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error ?? `omp answered ${res.status}`);
    if (choice === "refine" || APPROVALS.has(choice)) localStorage.removeItem(storageKey(review.reviewId));
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  } finally {
    state.busy = false;
    renderDoc();
    renderActions();
  }
}

let toastTimer = null;
function toast(message) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 4000);
}

// MARK: events

doc.addEventListener("mousemove", (e) => {
  const block = e.target.closest(".block");
  if (block && block.dataset.block !== hovered) placeGutter(block);
});

scroller.addEventListener("mouseleave", (e) => {
  if (scroller.contains(e.relatedTarget)) return;
  gutterAdd.hidden = true;
  hovered = null;
});

// Keep the text selection the button comments on.
selComment.addEventListener("mousedown", (e) => e.preventDefault());

document.addEventListener("selectionchange", () => requestAnimationFrame(updateSelectionButton));

let scrollFrame = 0;
scroller.addEventListener("scroll", () => {
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(markCurrentSection);
});

app.addEventListener("click", (e) => {
  const section = e.target.closest("[data-section]");
  if (section) return void blockEl(section.dataset.section)?.scrollIntoView({ block: "start" });
  const target = e.target.closest("[data-act], [data-choice]");
  if (!target) return;
  const thread = target.closest(".thread")?.dataset.comment;
  if (target.dataset.choice) return void choose(target.dataset.choice);
  switch (target.dataset.act) {
    case "comment-block":
      if (!hovered) return;
      if (e.shiftKey && state.composer && !state.composer.editing) extendComposer(hovered);
      else openComposer(hovered, hovered);
      break;
    case "comment-selection":
      commentOnSelection();
      break;
    case "save-comment":
      saveComposer();
      break;
    case "cancel-comment":
      cancelComposer();
      break;
    case "edit-comment":
      editComment(thread);
      break;
    case "delete-comment":
      deleteComment(thread);
      break;
    case "prev-change":
      goToChange(-1);
      break;
    case "next-change":
      goToChange(1);
      break;
  }
});

app.addEventListener("change", (e) => {
  if (e.target.matches('[data-act="tier"]')) state.role = e.target.value;
});

// Typed feedback makes Refine the primary action without re-rendering the field being typed in.
app.addEventListener("input", (e) => {
  if (!e.target.matches(".note, .composer textarea")) return;
  if (e.target.matches(".note")) {
    state.note = e.target.value;
    saveDraft();
  }
  const feedback = pendingFeedback();
  const refine = actions.querySelector('[data-choice="refine"]');
  if (refine) {
    refine.disabled = !feedback || state.busy || Boolean(state.review.options.find((o) => o.id === "refine")?.disabled);
    refine.classList.toggle("primary", Boolean(feedback));
  }
  for (const el of actions.querySelectorAll(".split-button > .btn, .more > summary")) el.classList.toggle("primary", !feedback);
});

document.addEventListener("keydown", (e) => {
  const inField = e.target instanceof HTMLElement && e.target.matches("input, textarea, select");
  const submit = e.key === "Enter" && (e.metaKey || e.ctrlKey);
  if (submit && e.shiftKey) {
    e.preventDefault();
    const option = approval();
    if (option) void choose(option.id);
    return;
  }
  if (e.target.matches?.(".composer textarea")) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveComposer();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelComposer();
    }
    return;
  }
  if (submit) {
    e.preventDefault();
    if (pendingFeedback()) void choose("refine");
    else toast("Comment on a line or write overall feedback to refine");
    return;
  }
  if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "n" || e.key === "p") {
    e.preventDefault();
    goToChange(e.key === "n" ? 1 : -1);
  } else if (e.key === "c" && !state.review?.resolution) {
    e.preventDefault();
    if (!commentOnSelection() && hovered) openComposer(hovered, hovered);
  }
});

renderHeader();
renderDoc();
renderBanner();
connect();
