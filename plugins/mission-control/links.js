"use strict";
// MARK: links helpers
const LINKS_TEXT_MAX = 4000;
const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
function linksOpenTask(id) {
  if (!findTask(id)) { toast(`${taskNumber(id)} isn't on this board`, true); return; }
  while (modals.length) closeModal();
  openPanel(id);
}
function linksTaskChip(id, extra) {
  const t = findTask(id);
  return h("button", { class: "chip mono", title: t ? t.title : "Not on this board", "aria-label": `Open ${taskNumber(id)}`, onclick: () => linksOpenTask(id) }, taskNumber(id), extra || null);
}
function linksStatus(text, error = false, retry = null) {
  return h("div", { class: "nv-state" + (error ? " error" : ""), role: error ? "alert" : "status" },
    error ? I("alert", 13) : null, h("span", {}, text), retry ? h("button", { class: "btn sm", onclick: retry }, "Retry") : null);
}
const linksLoading = text => h("div", { class: "nv-state", role: "status" }, frag(spinner(12)), h("span", {}, text));
const busyContent = new WeakMap();
function linksBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) { if (!busyContent.has(button)) busyContent.set(button, [...button.childNodes]); button.replaceChildren(frag(spinner(12)), label); }
  else if (busyContent.has(button)) { button.replaceChildren(...busyContent.get(button)); busyContent.delete(button); }
}
function linksCounter(ta, max) {
  const c = h("span", { class: "nv-count", "aria-live": "polite" });
  const sync = () => { c.textContent = `${ta.value.length} / ${max}`; c.classList.toggle("over", ta.value.length > max); };
  ta.addEventListener("input", sync);
  sync();
  return { el: c, sync };
}

// MARK: parent
function linksDescendants(id, seen = new Set()) {
  for (const c of (findTask(id) || {}).children || []) if (!seen.has(c)) { seen.add(c); linksDescendants(c, seen); }
  return seen;
}
function linksAncestors(id) {
  const out = [];
  for (let p = (findTask(id) || {}).parent; p && !out.includes(p); p = (findTask(p) || {}).parent) out.push(p);
  return out;
}
function linksReaches(from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const t = findTask(from);
  return !!t && [...t.dependsOn, ...(t.parent ? [t.parent] : [])].some(n => linksReaches(n, target, seen));
}
function linksParentItems(childId, projectId, current, choose) {
  const child = childId && findTask(childId);
  const banned = childId ? linksDescendants(childId).add(childId) : new Set();
  const eligible = x => !banned.has(x.id) && x.project === projectId &&
    (!child || (!linksReaches(x.id, child.id) && ![x.id, ...linksAncestors(x.id)].some(a => child.dependsOn.includes(a))));
  const list = board.tasks.filter(eligible).sort(byId);
  const items = [{ icon: "x", label: "No parent", checked: !current, action: () => choose(null) }];
  if (list.length) items.push("-", { header: "Same project" });
  for (const x of list) items.push({ label: `${taskNumber(x.id)} ${x.title}`, sub: colTitle(x.column), checked: x.id === current, action: () => choose(x.id) });
  if (!list.length) items.push({ header: "No eligible open task" });
  return items;
}
function linksParentPicker(initial, projectId) {
  const state = { value: initial || null };
  const el = h("button", { class: "prop-chip", type: "button" });
  const render = () => {
    el.replaceChildren(I("link", 13), state.value ? `Parent ${taskNumber(state.value)}` : "No parent", I("chevronDown", 11));
    el.setAttribute("aria-label", state.value ? `Parent: ${taskNumber(state.value)}` : "Parent: none");
    el.title = state.value ? `Child of ${taskNumber(state.value)}: inherits the blockers of its tree` : "Choose a parent task";
  };
  el.onclick = () => openMenu(el, linksParentItems(null, projectId, state.value, v => { state.value = v; render(); }));
  render();
  state.el = el;
  return state;
}

// MARK: task panel
function linksPanel(props, taskPane) {
  const N = { id: openId, seq: 0, busy: false };
  N.parent = h("div", { class: "deps" });
  N.parentPick = toolButton("pencil", "Change the parent", () => {
    const t = findTask(N.id);
    openMenu(N.parentPick, linksParentItems(t.id, t.project, t.parent, v => linksSetParent(N, t, v)));
  }, 13);
  N.children = h("div", { class: "deps" });
  N.childAdd = toolButton("plus", "Create a child task", () => openComposer({ parent: N.id }), 13);
  props.append(
    h("label", {}, I("prMerged", 13), "Parent"), N.parent,
    h("label", {}, I("kanban", 13), "Children"), N.children);

  N.meta = h("span", { class: "meta" });
  N.list = h("div", { class: "nv-list" });
  N.kind = h("select", { class: "field nv-kind", "aria-label": "Context entry kind" },
    h("option", { value: "finding" }, "Finding"), h("option", { value: "outcome" }, "Outcome"));
  N.text = h("textarea", { class: "field nv-text", rows: "3", maxlength: String(LINKS_TEXT_MAX), "aria-label": "Context entry text",
    placeholder: "A reusable finding or outcome for dependents and children…" });
  N.text.value = drafts.get(`${N.id}:context`) || "";
  N.counter = linksCounter(N.text, LINKS_TEXT_MAX);
  N.error = h("div", { class: "nv-error", role: "alert", hidden: true });
  N.publish = h("button", { class: "btn sm primary", onclick: () => linksPublish(N) }, "Publish");
  N.text.addEventListener("input", () => { drafts.set(`${N.id}:context`, N.text.value); N.error.hidden = true; });
  N.text.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); linksPublish(N); } });
  taskPane.append(h("section", { class: "sec" },
    h("div", { class: "sec-h" }, "Shared context", N.meta, h("span", { class: "spacer" }), toolButton("refresh", "Reload shared context", () => linksLoadContext(N), 14)),
    N.list,
    h("div", { class: "nv-form" }, N.text, N.error, h("div", { class: "nv-form-bar" }, N.kind, N.counter.el, h("span", { class: "spacer" }), N.publish))));
  linksLoadContext(N);
  return N;
}
function linksPanelUpdate(t) {
  const N = P && P.links;
  if (!N || N.id !== t.id) return;
  const parentRemove = t.parent ? h("span", { class: "x", title: "Clear the parent", role: "button", "aria-label": `Clear parent ${taskNumber(t.parent)}`,
    onclick: e => { e.stopPropagation(); linksSetParent(N, t, null); } }, I("x", 10)) : null;
  N.parent.replaceChildren(...(t.parent ? [linksTaskChip(t.parent, parentRemove)] : [h("span", { class: "nv-none" }, "None")]), N.parentPick);
  N.children.replaceChildren(...(t.children || []).slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(id => linksTaskChip(id)), N.childAdd);
  N.parentPick.disabled = N.busy;
}
function linksSetParent(N, t, value) {
  if ((t.parent || null) === value) return;
  const go = async () => {
    N.busy = true;
    linksPanelUpdate(t);
    try {
      const r = await act("PATCH", tpath(t.id), { parent: value }, value ? `${taskNumber(t.id)} is now under ${taskNumber(value)}` : `${taskNumber(t.id)} has no parent`);
      const cur = findTask(t.id);
      if (cur && r && r.id) Object.assign(cur, r);
      renderBoard();
    } catch {} finally {
      N.busy = false;
      if (P && P.links === N) updatePanel();
    }
  };
  confirmModal(value ? `Move ${taskNumber(t.id)} under ${taskNumber(value)}?` : `Clear ${taskNumber(t.id)}'s parent?`,
    `${taskNumber(t.id)} ${value ? "inherits the blockers of " + taskNumber(value) + "'s tree" : "stops inheriting its parent tree's blockers"}, which may change when the board resumes it.`,
    value ? "Reparent" : "Clear parent", go, { cls: "primary" });
}
async function linksLoadContext(N) {
  const seq = ++N.seq, id = N.id;
  N.list.replaceChildren(linksLoading("Loading shared context…"));
  try {
    const r = await api("GET", tpath(id, "/context"));
    if (seq === N.seq && P && P.links === N) linksRenderContext(N, r);
  } catch (e) {
    if (seq === N.seq && P && P.links === N) N.list.replaceChildren(linksStatus(e.message, true, () => linksLoadContext(N)));
  }
}
function linksRenderContext(N, r) {
  N.meta.textContent = r.updatedAt ? `updated ${ago(r.updatedAt)}` : "";
  const entries = (r.entries || []).slice().reverse();
  N.list.replaceChildren(...(entries.length ? entries.map(e => h("article", { class: "nv-item" },
    h("div", { class: "nv-item-h" }, h("span", { class: "chip" + (e.kind === "outcome" ? " nv-outcome" : "") }, e.kind || "note"),
      e.source ? linksTaskChip(e.source) : null, e.ref ? h("span", { class: "mono nv-ref", title: e.ref }, e.ref) : null,
      h("span", { class: "spacer" }), e.at ? h("time", { datetime: e.at, title: e.at }, ago(e.at)) : null),
    h("div", { class: "md", html: md(e.text || "") })))
    : [linksStatus("No shared context yet. Findings and outcomes published here reach this task's dependents and children.")]));
}
async function linksPublish(N) {
  if (N.publish.disabled) return;
  const text = N.text.value.trim();
  const fail = msg => { N.error.textContent = msg; N.error.hidden = false; N.text.focus(); };
  if (!text) return fail("Write a finding or outcome first");
  if (text.length > LINKS_TEXT_MAX) return fail(`Keep it under ${LINKS_TEXT_MAX} characters`);
  const id = N.id, seq = ++N.seq;
  linksBusy(N.publish, true, "Publishing…");
  N.text.disabled = N.kind.disabled = true;
  try {
    const r = await api("POST", tpath(id, "/context"), { kind: N.kind.value, text });
    drafts.delete(`${id}:context`);
    toast(`${N.kind.value === "outcome" ? "Outcome" : "Finding"} published on ${taskNumber(id)}`);
    if (P && P.links === N) { N.text.value = ""; N.counter.sync(); if (seq === N.seq) linksRenderContext(N, r); else linksLoadContext(N); }
  } catch (e) {
    if (P && P.links === N) fail(e.message); else toast(e.message, true);
  } finally {
    linksBusy(N.publish, false);
    N.text.disabled = N.kind.disabled = false;
  }
}
