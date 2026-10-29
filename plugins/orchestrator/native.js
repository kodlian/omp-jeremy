"use strict";
// MARK: native helpers
const NATIVE_TEXT_MAX = 4000;
const MEMORY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const clipText = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const nativeValue = v => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 1));
const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
function nativeOpenTask(id) {
  if (!findTask(id)) { toast(`${taskNumber(id)} isn't on this board`, true); return; }
  while (modals.length) closeModal();
  openPanel(id);
}
function nativeTaskChip(id, extra) {
  const t = findTask(id);
  return h("button", { class: "chip mono", title: t ? t.title : "Not on this board", "aria-label": `Open ${taskNumber(id)}`, onclick: () => nativeOpenTask(id) }, taskNumber(id), extra || null);
}
function nativeStatus(text, error = false, retry = null) {
  return h("div", { class: "nv-state" + (error ? " error" : ""), role: error ? "alert" : "status" },
    error ? I("alert", 13) : null, h("span", {}, text), retry ? h("button", { class: "btn sm", onclick: retry }, "Retry") : null);
}
const nativeLoading = text => h("div", { class: "nv-state", role: "status" }, frag(spinner(12)), h("span", {}, text));
const busyContent = new WeakMap();
function nativeBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) { if (!busyContent.has(button)) busyContent.set(button, [...button.childNodes]); button.replaceChildren(frag(spinner(12)), label); }
  else if (busyContent.has(button)) { button.replaceChildren(...busyContent.get(button)); busyContent.delete(button); }
}
function nativeCounter(ta, max) {
  const c = h("span", { class: "nv-count", "aria-live": "polite" });
  const sync = () => { c.textContent = `${ta.value.length} / ${max}`; c.classList.toggle("over", ta.value.length > max); };
  ta.addEventListener("input", sync);
  sync();
  return { el: c, sync };
}

// MARK: line diff
function nativeDiff(before, after, maxLines = 40) {
  const a = before.split("\n"), b = after.split("\n");
  const rows = [];
  if (a.length * b.length > 90000) {
    rows.push(...a.map(l => ["-", l]), ...b.map(l => ["+", l]));
  } else {
    const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { rows.push([" ", a[i]]); i++; j++; }
      else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) rows.push(["+", b[j++]]);
      else rows.push(["-", a[i++]]);
    }
  }
  const keep = rows.map((r, k) => r[0] !== " " || rows.slice(Math.max(0, k - 1), k + 2).some(x => x[0] !== " "));
  const out = h("pre", { class: "nv-diff" });
  let shown = 0, hidden = 0, gap = false;
  rows.forEach((r, k) => {
    if (!keep[k]) { gap = true; return; }
    if (shown >= maxLines) { hidden++; return; }
    if (gap && shown) out.append(h("span", { class: "nv-gap" }, "…\n"));
    gap = false;
    out.append(h("span", { class: r[0] === "+" ? "nv-add" : r[0] === "-" ? "nv-del" : "" }, `${r[0]} ${clipText(r[1], 400)}\n`));
    shown++;
  });
  if (hidden) out.append(h("span", { class: "nv-gap" }, `… ${plural(hidden, "more changed line")}\n`));
  return out;
}

// MARK: parent
function nativeDescendants(id, seen = new Set()) {
  for (const c of (findTask(id) || {}).children || []) if (!seen.has(c)) { seen.add(c); nativeDescendants(c, seen); }
  return seen;
}
function nativeAncestors(id) {
  const out = [];
  for (let p = (findTask(id) || {}).parent; p && !out.includes(p); p = (findTask(p) || {}).parent) out.push(p);
  return out;
}
function nativeReaches(from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const t = findTask(from);
  return !!t && [...t.dependsOn, ...(t.parent ? [t.parent] : [])].some(n => nativeReaches(n, target, seen));
}
function nativeParentItems(childId, flowId, current, choose) {
  const child = childId && findTask(childId);
  const banned = childId ? nativeDescendants(childId).add(childId) : new Set();
  const eligible = x => !banned.has(x.id) && x.flow === flowId &&
    (!child || (!nativeReaches(x.id, child.id) && ![x.id, ...nativeAncestors(x.id)].some(a => child.dependsOn.includes(a))));
  const list = board.tasks.filter(eligible).sort(byId);
  const items = [{ icon: "x", label: "No parent", checked: !current, action: () => choose(null) }];
  if (list.length) items.push("-", { header: "Same flow" });
  for (const x of list) items.push({ label: `${taskNumber(x.id)} ${x.title}`, sub: colTitle(x.column), checked: x.id === current, action: () => choose(x.id) });
  if (!list.length) items.push({ header: "No eligible open task" });
  return items;
}
function nativeParentPicker(initial, flowId) {
  const state = { value: initial || null };
  const el = h("button", { class: "prop-chip", type: "button" });
  const render = () => {
    el.replaceChildren(I("link", 13), state.value ? `Parent ${taskNumber(state.value)}` : "No parent", I("chevronDown", 11));
    el.setAttribute("aria-label", state.value ? `Parent: ${taskNumber(state.value)}` : "Parent: none");
    el.title = state.value ? `Child of ${taskNumber(state.value)}: inherits its repository, base and blockers` : "Choose a parent task";
  };
  el.onclick = () => openMenu(el, nativeParentItems(null, flowId, state.value, v => { state.value = v; render(); }));
  render();
  state.el = el;
  return state;
}

// MARK: task panel
function nativePanel(props, taskPane) {
  const N = { id: openId, seq: 0, busy: false };
  N.parent = h("div", { class: "deps" });
  N.parentPick = toolButton("pencil", "Change the parent", () => {
    const t = findTask(N.id);
    openMenu(N.parentPick, nativeParentItems(t.id, t.flow, t.parent, v => nativeSetParent(N, t, v)));
  }, 13);
  N.children = h("div", { class: "deps" });
  N.childAdd = toolButton("plus", "Create a child task", () => openComposer({ parent: N.id }), 13);
  N.readyBtn = h("button", { class: "btn sm", onclick: () => showReadiness({ id: N.id }) }, I("link", 12), "Readiness");
  N.historyBtn = h("button", { class: "btn sm", onclick: () => showHistory(N.id) }, I("refresh", 12), "History");
  props.append(
    h("label", {}, I("prMerged", 13), "Parent"), N.parent,
    h("label", {}, I("kanban", 13), "Children"), N.children,
    h("label", {}, I("search", 13), "Beads"), h("div", { class: "nv-actions" }, N.readyBtn, N.historyBtn));

  N.meta = h("span", { class: "meta" });
  N.list = h("div", { class: "nv-list" });
  N.kind = h("select", { class: "field nv-kind", "aria-label": "Context entry kind" },
    h("option", { value: "finding" }, "Finding"), h("option", { value: "outcome" }, "Outcome"));
  N.text = h("textarea", { class: "field nv-text", rows: "3", maxlength: String(NATIVE_TEXT_MAX), "aria-label": "Context entry text",
    placeholder: "A reusable finding or outcome for dependents and children…" });
  N.text.value = drafts.get(`${N.id}:context`) || "";
  N.counter = nativeCounter(N.text, NATIVE_TEXT_MAX);
  N.error = h("div", { class: "nv-error", role: "alert", hidden: true });
  N.publish = h("button", { class: "btn sm primary", onclick: () => nativePublish(N) }, "Publish");
  N.text.addEventListener("input", () => { drafts.set(`${N.id}:context`, N.text.value); N.error.hidden = true; });
  N.text.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); nativePublish(N); } });
  taskPane.append(h("section", { class: "sec" },
    h("div", { class: "sec-h" }, "Shared context", N.meta, h("span", { class: "spacer" }), toolButton("refresh", "Reload shared context", () => nativeLoadContext(N), 14)),
    N.list,
    h("div", { class: "nv-form" }, N.text, N.error, h("div", { class: "nv-form-bar" }, N.kind, N.counter.el, h("span", { class: "spacer" }), N.publish))));
  nativeLoadContext(N);
  return N;
}
function nativePanelUpdate(t) {
  const N = P && P.native;
  if (!N || N.id !== t.id) return;
  const parentRemove = t.parent ? h("span", { class: "x", title: "Clear the parent", role: "button", "aria-label": `Clear parent ${taskNumber(t.parent)}`,
    onclick: e => { e.stopPropagation(); nativeSetParent(N, t, null); } }, I("x", 10)) : null;
  N.parent.replaceChildren(...(t.parent ? [nativeTaskChip(t.parent, parentRemove)] : [h("span", { class: "nv-none" }, "None")]), N.parentPick);
  N.children.replaceChildren(...(t.children || []).slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(id => nativeTaskChip(id)), N.childAdd);
  N.parentPick.disabled = N.busy;
}
function nativeSetParent(N, t, value) {
  if ((t.parent || null) === value) return;
  const go = async () => {
    N.busy = true;
    nativePanelUpdate(t);
    try {
      const r = await act("PATCH", tpath(t.id), { parent: value }, value ? `${taskNumber(t.id)} is now under ${taskNumber(value)}` : `${taskNumber(t.id)} has no parent`);
      const cur = findTask(t.id);
      if (cur && r && r.id) Object.assign(cur, r);
      renderBoard();
    } catch {} finally {
      N.busy = false;
      if (P && P.native === N) updatePanel();
    }
  };
  if (t.column === "backlog" && !t.worktree) { go(); return; }
  confirmModal(value ? `Move ${taskNumber(t.id)} under ${taskNumber(value)}?` : `Clear ${taskNumber(t.id)}'s parent?`,
    `${taskNumber(t.id)} ${value ? "inherits the blockers of " + taskNumber(value) + "'s tree" : "stops inheriting its parent tree's blockers"}, which may change when the queue starts or resumes it.`,
    value ? "Reparent" : "Clear parent", go, { cls: "primary" });
}
async function nativeLoadContext(N) {
  const seq = ++N.seq, id = N.id;
  N.list.replaceChildren(nativeLoading("Loading shared context…"));
  try {
    const r = await api("GET", tpath(id, "/context"));
    if (seq === N.seq && P && P.native === N) nativeRenderContext(N, r);
  } catch (e) {
    if (seq === N.seq && P && P.native === N) N.list.replaceChildren(nativeStatus(e.message, true, () => nativeLoadContext(N)));
  }
}
function nativeRenderContext(N, r) {
  N.meta.textContent = r.updatedAt ? `${taskNumber(r.beadId || "")} · updated ${ago(r.updatedAt)}` : taskNumber(r.beadId || "");
  const entries = (r.entries || []).slice().reverse();
  N.list.replaceChildren(...(entries.length ? entries.map(e => h("article", { class: "nv-item" },
    h("div", { class: "nv-item-h" }, h("span", { class: "chip" + (e.kind === "outcome" ? " nv-outcome" : "") }, e.kind || "note"),
      e.source ? nativeTaskChip(e.source) : null, e.ref ? h("span", { class: "mono nv-ref", title: e.ref }, e.ref) : null,
      h("span", { class: "spacer" }), e.at ? h("time", { datetime: e.at, title: e.at }, ago(e.at)) : null),
    h("div", { class: "md", html: md(e.text || "") })))
    : [nativeStatus("No shared context yet. Findings and outcomes published here reach this task's dependents and children.")]));
}
async function nativePublish(N) {
  if (N.publish.disabled) return;
  const text = N.text.value.trim();
  const fail = msg => { N.error.textContent = msg; N.error.hidden = false; N.text.focus(); };
  if (!text) return fail("Write a finding or outcome first");
  if (text.length > NATIVE_TEXT_MAX) return fail(`Keep it under ${NATIVE_TEXT_MAX} characters`);
  const id = N.id, seq = ++N.seq;
  nativeBusy(N.publish, true, "Publishing…");
  N.text.disabled = N.kind.disabled = true;
  try {
    const r = await api("POST", tpath(id, "/context"), { kind: N.kind.value, text });
    drafts.delete(`${id}:context`);
    toast(`${N.kind.value === "outcome" ? "Outcome" : "Finding"} published on ${taskNumber(id)}`);
    if (P && P.native === N) { N.text.value = ""; N.counter.sync(); if (seq === N.seq) nativeRenderContext(N, r); else nativeLoadContext(N); }
  } catch (e) {
    if (P && P.native === N) fail(e.message); else toast(e.message, true);
  } finally {
    nativeBusy(N.publish, false);
    N.text.disabled = N.kind.disabled = false;
  }
}

// MARK: readiness
function showReadiness({ flow = null, id = null } = {}) {
  closeMenu();
  const f = flow && flows().find(x => x.id === flow);
  const body = h("div", { class: "m-body nv-scroll" });
  const refresh = h("button", { class: "btn ghost" }, I("refresh", 12), "Refresh");
  const box = openModal([
    h("div", { class: "m-body nv-head" }, h("h2", {}, id ? `Readiness · ${taskNumber(id)}` : `Readiness · ${f ? `${f.name} · ${f.base}` : "this flow"}`),
      h("p", { class: "m-text" }, "Why Beads and the board's queue would or wouldn't start each task now. Nothing is started.")),
    body,
    h("div", { class: "m-foot" }, refresh, h("span", { class: "spacer" }), h("button", { class: "btn", onclick: closeModal }, "Close"))], "nv-wide");
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    refresh.disabled = true;
    body.replaceChildren(nativeLoading("Asking Beads…"));
    try {
      const r = await api("POST", "/api/readiness", id ? { id } : flow ? { flow } : {});
      if (mine !== seq || !box.isConnected) return;
      const s = r.native.summary || {};
      const rows = r.tasks.map(t => {
        const blockers = [...new Set([...(t.nativeBlockedBy || []), ...(t.blockedBy || [])])];
        return h("article", { class: "nv-item" },
          h("div", { class: "nv-item-h" }, nativeTaskChip(t.id), h("strong", { class: "nv-title" }, t.title),
            h("span", { class: "spacer" }), h("span", { class: "chip" }, colTitle(t.column)),
            h("span", { class: "chip " + (t.native === "ready" ? "nv-ok" : t.native === "blocked" ? "nv-bad" : "") }, t.native ? `Beads ${t.native}` : `Beads ${t.status}`),
            h("span", { class: "chip " + (t.queued ? "nv-ok" : "") }, t.queued ? "Queue would start" : "Queue waits")),
          h("p", { class: "m-text" }, t.reason),
          blockers.length ? h("div", { class: "m-note" }, "Blockers:", ...blockers.map(b => nativeTaskChip(b))) : null);
      });
      body.replaceChildren(
        h("div", { class: "m-note" }, h("span", { class: "chip nv-ok" }, `${s.total_ready || 0} ready`), h("span", { class: "chip nv-bad" }, `${s.total_blocked || 0} blocked`),
          s.cycle_count ? h("span", { class: "chip nv-bad" }, plural(s.cycle_count, "cycle")) : null),
        ...(rows.length ? rows : [nativeStatus("No open task in this scope.")]),
        ...(r.disclaimer ? [h("div", { class: "m-note" }, I("alert", 12), r.disclaimer)] : []));
    } catch (e) {
      if (mine === seq && box.isConnected) body.replaceChildren(nativeStatus(e.message, true, load));
    } finally { if (mine === seq) refresh.disabled = false; }
  };
  refresh.onclick = load;
  load();
}

// MARK: history
const HISTORY_SKIP = /(^|_)(id|at|time|date)$|^(created|updated|closed)/i;
function showHistory(id) {
  closeMenu();
  const body = h("div", { class: "m-body nv-scroll" });
  const mode = h("select", { class: "field nv-kind", "aria-label": "History kind" },
    h("option", { value: "snapshots" }, "Snapshots"), h("option", { value: "events" }, "Audit events"));
  const limit = h("select", { class: "field nv-kind", "aria-label": "How many entries" },
    ...[10, 25, 50].map(n => h("option", { value: String(n) }, `Last ${n}`)));
  const box = openModal([
    h("div", { class: "m-body nv-head" }, h("h2", {}, `History · ${taskNumber(id)}`),
      h("div", { class: "nv-form-bar" }, mode, limit, h("span", { class: "spacer" }), h("span", { class: "m-note" }, "Newest first"))),
    body,
    h("div", { class: "m-foot" }, h("button", { class: "btn", onclick: closeModal }, "Close"))], "nv-wide");
  let seq = 0;
  const load = async () => {
    const mine = ++seq, events = mode.value === "events";
    mode.disabled = limit.disabled = true;
    body.replaceChildren(nativeLoading("Reading Beads history…"));
    try {
      const r = await api("POST", tpath(id, "/history"), { limit: Number(limit.value), events });
      if (mine !== seq || !box.isConnected) return;
      const list = Array.isArray(r.history) ? r.history : [];
      body.replaceChildren(...(list.length ? (events ? list.map(nativeEvent) : list.map((s, i) => nativeSnapshot(s, list[i + 1])))
        : [nativeStatus(events ? "No audit events recorded." : "No snapshots recorded.")]));
    } catch (e) {
      if (mine === seq && box.isConnected) body.replaceChildren(nativeStatus(e.message, true, load));
    } finally { if (mine === seq) mode.disabled = limit.disabled = false; }
  };
  mode.onchange = limit.onchange = load;
  load();
}
function nativeSnapshot(s, older) {
  const issue = s.Issue || {}, prev = older && older.Issue;
  const changes = [];
  if (prev) {
    for (const k of [...new Set([...Object.keys(prev), ...Object.keys(issue)])]) {
      if (HISTORY_SKIP.test(k)) continue;
      const a = nativeValue(prev[k]), b = nativeValue(issue[k]);
      if (a !== b) changes.push(h("div", { class: "nv-change" }, h("div", { class: "m-label" }, k), nativeDiff(a, b)));
    }
  }
  return h("article", { class: "nv-item" },
    h("div", { class: "nv-item-h" }, h("span", { class: "mono nv-ref", title: s.CommitHash }, String(s.CommitHash || "").slice(0, 10)),
      s.Committer ? h("span", {}, s.Committer) : null, h("span", { class: "spacer" }),
      issue.status ? h("span", { class: "chip" }, issue.status) : null,
      s.CommitDate ? h("time", { datetime: s.CommitDate, title: s.CommitDate }, ago(s.CommitDate)) : null),
    prev ? (changes.length ? changes : [h("p", { class: "m-text" }, "No tracked field changed.")])
      : [h("p", { class: "m-text" }, "Oldest snapshot shown: ", h("strong", {}, issue.title || ""))]);
}
function nativeEvent(e) {
  const a = nativeValue(e.old_value), b = nativeValue(e.new_value);
  const short = a.length < 120 && b.length < 120 && !a.includes("\n") && !b.includes("\n");
  return h("article", { class: "nv-item" },
    h("div", { class: "nv-item-h" }, h("span", { class: "chip" }, e.event_type || "event"), e.actor ? h("span", {}, e.actor) : null,
      h("span", { class: "spacer" }), e.created_at ? h("time", { datetime: e.created_at, title: e.created_at }, ago(e.created_at)) : null),
    a || b ? (short ? h("div", { class: "m-note" }, h("span", { class: "mono nv-del" }, a || "∅"), I("arrowRight", 11), h("span", { class: "mono nv-add" }, b || "∅"))
      : nativeDiff(a, b)) : null);
}

// MARK: shared memories
function showMemories() {
  closeMenu();
  const cur = selectedFlow();
  const S = { gen: 0, search: 0, form: 0, editing: null };
  const repo = h("select", { class: "field", id: "nv-mem-repo" },
    ...(cur ? [h("option", { value: cur.checkout }, `${cur.name} · ${cur.checkout}`)] : [h("option", { value: "" }, "Flow unavailable")]));
  repo.value = cur ? cur.checkout : "";
  const scope = h("div", { class: "m-note mono nv-ref" });
  const query = h("input", { class: "field", id: "nv-mem-query", maxlength: "200", placeholder: "Search shared memories", spellcheck: "false", autocomplete: "off" });
  const search = h("button", { class: "btn" }, "Search");
  const results = h("div", { class: "nv-list" });
  const key = h("input", { class: "field mono", id: "nv-mem-key", maxlength: "80", placeholder: "memory-key", spellcheck: "false", autocomplete: "off" });
  const text = h("textarea", { class: "field nv-text", id: "nv-mem-text", rows: "4", maxlength: String(NATIVE_TEXT_MAX), placeholder: "What every task in this repository should know…" });
  const counter = nativeCounter(text, NATIVE_TEXT_MAX);
  const formError = h("div", { class: "nv-error", role: "alert", hidden: true });
  const formTitle = h("div", { class: "sec-h" }, "New memory");
  const fresh = h("button", { class: "btn sm ghost", hidden: true }, "New memory");
  const save = h("button", { class: "btn primary" }, "Save memory");
  const body = h("div", { class: "m-body nv-scroll" },
    h("label", { class: "m-label", for: "nv-mem-repo" }, "Repository"), repo, scope,
    h("label", { class: "m-label", for: "nv-mem-query" }, "Search"), h("div", { class: "nv-form-bar" }, query, search),
    results,
    h("div", { class: "nv-form" }, h("div", { class: "nv-form-bar" }, formTitle, h("span", { class: "spacer" }), fresh),
      h("label", { class: "m-label", for: "nv-mem-key" }, "Key"), key,
      h("label", { class: "m-label", for: "nv-mem-text" }, "Text"), text,
      h("div", { class: "nv-form-bar" }, formError, h("span", { class: "spacer" }), counter.el)));
  const box = openModal([
    h("div", { class: "m-body nv-head" }, h("h2", {}, "Shared memories"),
      h("p", { class: "m-text" }, "Shared by every task in one repository, across its flows.")),
    body,
    h("div", { class: "m-foot" }, h("button", { class: "btn ghost", onclick: closeModal }, "Close"), save)], "nv-wide");
  const live = gen => box.isConnected && gen === S.gen && repo.value;
  const setForm = (k, v) => {
    S.form++;
    S.editing = k;
    key.value = k || ""; key.readOnly = !!k; text.value = v || ""; counter.sync(); formError.hidden = true;
    formTitle.textContent = k ? `Edit ${k}` : "New memory";
    fresh.hidden = !k;
  };
  const syncEnabled = () => { const off = !repo.value; for (const el of [query, search, key, text, save]) el.disabled = off; };
  const call = body2 => api("POST", "/api/memories", { repo: repo.value, ...body2 });
  const doSearch = async () => {
    if (!repo.value) { results.replaceChildren(nativeStatus("Choose the repository whose memories to show.")); return; }
    const gen = S.gen, request = ++S.search;
    nativeBusy(search, true, "Searching…");
    results.replaceChildren(nativeLoading("Searching…"));
    try {
      const r = await call({ action: "search", query: query.value.trim() });
      if (!live(gen) || request !== S.search) return;
      scope.textContent = `Scope: ${r.scope}`;
      results.replaceChildren(...(r.memories.length ? r.memories.map(memoryRow) : [nativeStatus(query.value.trim() ? "No memory matches." : "No shared memory in this repository yet.")]),
        ...(r.truncated ? [h("div", { class: "m-note" }, I("alert", 12), "More matched or texts were cut; refine the search or open one.")] : []));
    } catch (e) {
      if (live(gen) && request === S.search) results.replaceChildren(nativeStatus(e.message, true, doSearch));
    } finally { if (gen === S.gen && request === S.search) nativeBusy(search, false); }
  };
  const memoryRow = m => {
    const edit = h("button", { class: "btn sm" }, I("pencil", 11), "Edit");
    const forget = h("button", { class: "btn sm danger", "aria-label": `Forget ${m.key}` }, I("trash", 11), "Forget");
    edit.onclick = async () => {
      const gen = S.gen, request = ++S.form;
      nativeBusy(edit, true, "Opening…");
      try {
        const r = await call({ action: "read", key: m.key });
        if (live(gen) && request === S.form) { setForm(m.key, r.memories[0] ? r.memories[0].text : ""); text.focus(); }
      } catch (e) { if (live(gen)) toast(e.message, true); }
      finally { nativeBusy(edit, false); }
    };
    forget.onclick = () => {
      const gen = S.gen, where = repo.options[repo.selectedIndex].textContent;
      confirmModal(`Forget ${m.key}?`, `Every task in ${where} loses this shared memory. This can't be undone.`, "Forget", async () => {
        if (!live(gen)) return;
        nativeBusy(forget, true, "Forgetting…");
        try {
          await call({ action: "forget", key: m.key });
          toast(`Forgot ${m.key}`);
          if (!live(gen)) return;
          if (S.editing === m.key) setForm(null);
          doSearch();
        } catch (e) { toast(e.message, true); nativeBusy(forget, false); }
      });
    };
    return h("article", { class: "nv-item" },
      h("div", { class: "nv-item-h" }, h("strong", { class: "mono" }, m.key), h("span", { class: "spacer" }), edit, forget),
      h("p", { class: "m-text nv-pre" }, clipText(m.text, 400)));
  };
  const doSave = async () => {
    if (save.disabled) return;
    const k = key.value.trim(), v = text.value.trim(), gen = S.gen;
    const fail = msg => { formError.textContent = msg; formError.hidden = false; };
    if (!repo.value) return fail("Choose a repository first");
    if (!MEMORY_KEY.test(k)) { key.focus(); return fail("Key: 1–80 letters, digits, dots, underscores or hyphens, starting with a letter or digit"); }
    if (!v) { text.focus(); return fail("Write the memory text"); }
    if (v.length > NATIVE_TEXT_MAX) return fail(`Keep it under ${NATIVE_TEXT_MAX} characters`);
    const write = async () => {
      if (!live(gen)) return;
      repo.disabled = true;
      nativeBusy(save, true, "Saving…");
      try {
        await call({ action: "remember", key: k, text: v });
        toast(`Saved ${k}`);
        if (live(gen)) { setForm(k, v); doSearch(); }
      } catch (e) { if (live(gen)) fail(e.message); else toast(e.message, true); }
      finally { repo.disabled = false; nativeBusy(save, false); syncEnabled(); }
    };
    if (S.editing === k) { write(); return; }
    nativeBusy(save, true, "Checking…");
    let exists = false;
    try { exists = !!(await call({ action: "read", key: k })).memories.length; }
    catch (e) { if (e.status !== 404) { nativeBusy(save, false); if (live(gen)) fail(e.message); return; } }
    nativeBusy(save, false);
    if (!live(gen)) return;
    if (exists) confirmModal(`Replace ${k}?`, "A shared memory with this key already exists; saving replaces its text for every task in this repository.", "Replace", write, { cls: "primary" });
    else write();
  };
  repo.onchange = () => { S.gen++; scope.textContent = ""; query.value = ""; setForm(null); syncEnabled(); doSearch(); };
  search.onclick = doSearch;
  query.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doSearch(); } });
  fresh.onclick = () => { setForm(null); key.focus(); };
  save.onclick = doSave;
  text.addEventListener("input", () => { formError.hidden = true; });
  key.addEventListener("input", () => { formError.hidden = true; });
  text.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSave(); } });
  const observer = new MutationObserver(() => { if (!box.isConnected) { S.gen++; observer.disconnect(); } });
  observer.observe(document.body, { childList: true });
  setForm(null);
  syncEnabled();
  doSearch();
  setTimeout(() => (repo.value ? query : repo).focus(), 0);
}
