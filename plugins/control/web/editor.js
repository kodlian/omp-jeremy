import { KIND_LABELS, renderLoop } from "omp-control-view/render";
import { h, LEVELS, levelHint, levelLabel, modal, openMenu, slug, toast } from "./dom.js";

const NODE_KEYS = ["id", "name", "kind", "description", "command", "timeout", "ask", "model", "thinking", "tools", "resources", "instructions"];
const THINKING = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
const ASK_MODES = [
  ["doubts", "Only doubts", "Findings the AI isn't sure of come to you; certain ones go straight to the agent"],
  ["all", "Everything", "Every finding comes to you first"],
  ["never", "Nothing", "Every finding goes straight to the agent"],
];

/** A node definition without the library's source, path and overrides. */
export function cleanNode(node) {
  return Object.fromEntries(NODE_KEYS.map((k) => [k, structuredClone(node[k] ?? null)]));
}

function blankNode(kind, id) {
  const base = { id, kind, description: "", command: null, timeout: 0, ask: "doubts", model: null, thinking: null, tools: [], resources: [], instructions: "" };
  if (kind === "check") return { ...base, name: "New command check", command: "", timeout: 900 };
  if (kind === "review") return { ...base, name: "New AI check", timeout: 600, tools: ["read", "grep", "glob"] };
  return { ...base, name: "You", instructions: "Approve this change?" };
}

const same = (a, b) => JSON.stringify(cleanNode(a)) === JSON.stringify(cleanNode(b));

function field(label, control, hint) {
  return h("label", { class: "form-field" }, h("span", { class: "form-label" }, label), control, hint ? h("span", { class: "form-hint" }, hint) : null);
}

/** Form fields for one node, editing it in place; onChange(key, previous) runs after each edit. */
export function nodeForm(node, onChange, { idEditable = false } = {}) {
  const set = (key, value) => {
    const previous = node[key];
    node[key] = value;
    onChange(key, previous);
  };
  const text = (key, attrs = {}) => h("input", { class: "field", value: node[key] ?? "", spellcheck: "false", ...attrs, oninput: (e) => set(key, e.target.value || (key === "description" ? "" : null)) });
  const number = (key, min, max) => h("input", { class: "field", type: "number", min, max, value: node[key], oninput: (e) => e.target.value !== "" && set(key, Number(e.target.value)) });
  const main = [field("Name", h("input", { class: "field", value: node.name, oninput: (e) => set("name", e.target.value) }))];
  const advanced = [field("Id", h("input", { class: "field mono", value: node.id, disabled: !idEditable, spellcheck: "false", oninput: (e) => set("id", slug(e.target.value)) }), idEditable ? "Its file name in the library" : "Saved checks keep their id")];
  if (node.kind === "check") {
    main.push(
      field("Command", h("textarea", { class: "field mono", rows: 3, spellcheck: "false", value: node.command ?? "", oninput: (e) => set("command", e.target.value) }), "Runs from the repository root; the check passes when it exits 0"),
      field("Description", text("description")),
    );
    advanced.push(field("Timeout (seconds)", number("timeout", 1, 7200)));
  } else if (node.kind === "review") {
    const ask = h(
      "div",
      { class: "segmented" },
      ASK_MODES.map(([id, label, title]) =>
        h("button", { type: "button", title, class: node.ask === id ? "active" : null, onclick: (e) => {
          for (const b of e.currentTarget.parentElement.children) b.classList.toggle("active", b === e.currentTarget);
          set("ask", id);
        } }, label),
      ),
    );
    main.push(
      field("What to check", h("textarea", { class: "field instructions", rows: 10, value: node.instructions, oninput: (e) => set("instructions", e.target.value) }), "What counts as certain, and what's a judgment call for you"),
      field("Read first", h("textarea", { class: "field mono", rows: 3, spellcheck: "false", value: node.resources.join("\n"), oninput: (e) => set("resources", e.target.value.split("\n").map((l) => l.trim()).filter(Boolean)) }), "One per line: repository paths, skill:// URLs, web URLs"),
      field("Ask you about", ask),
      field("Description", text("description")),
    );
    advanced.push(
      field("Model", text("model", { placeholder: "Default model" })),
      field("Thinking", h("select", { class: "field", onchange: (e) => set("thinking", e.target.value || null) }, THINKING.map((t) => h("option", { value: t, selected: (node.thinking ?? "") === t }, t || "Default")))),
      field("Timeout (seconds)", number("timeout", 30, 3600)),
    );
  } else {
    main.push(field("Question", h("input", { class: "field", value: node.instructions, oninput: (e) => set("instructions", e.target.value) }), "You answer Approve, or Send back with what to change"), field("Description", text("description")));
  }
  return h("div", { class: "form" }, main, h("details", { class: "advanced" }, h("summary", {}, "Advanced"), h("div", { class: "form" }, advanced)));
}

/** "Draft with omp": the session's agent researches the project and saves the check. */
export function draftPanel(page, node) {
  const intent = h("textarea", { class: "field", rows: 3, placeholder: "What should it check?", value: node?.description ?? "" });
  const scope = h("select", { class: "field" }, LEVELS.filter(([id]) => id !== "repo" || page.payload.session.repo).map(([id, label, sub]) => h("option", { value: id }, `${label} · ${sub}`)));
  return h(
    "div",
    { class: "form" },
    field("What should it check?", intent),
    field("Save to", scope),
    h("div", { class: "row" }, h("button", { class: "btn primary sm", type: "button", onclick: async () => {
      if (!intent.value.trim()) return toast("Say what it should check", true);
      const kind = node?.kind;
      if (await page.act("POST", "/api/draft", { kind, name: node?.name, intent: intent.value.trim(), scope: scope.value })) toast("Sent to the agent; the check appears here once it saves it");
    } }, "Send to omp")),
  );
}

/** Save to ▾: one item per level, with what saving there means for the item that wins today. */
export function saveMenu(anchor, existing, onPick, page) {
  openMenu(
    anchor,
    LEVELS.map(([id, label, sub]) => ({
      label,
      sub: [sub, levelHint(id, existing)].filter(Boolean).join(" · "),
      disabled: id === "repo" && !page.payload.session.repo,
      action: () => onPick(id),
    })),
  );
}

export function createEditor(page) {
  let st = null;
  const root = h("div", { class: "screen editor" });
  const libNodes = () => page.payload?.library.nodes ?? [];
  const libNode = (id) => libNodes().find((n) => n.id === id);
  const allStages = () => [...(st.draft.planReviewer ? [{ nodes: [st.draft.planReviewer] }] : []), ...st.draft.stages];
  const draftNodes = () => allStages().flatMap((s) => s.nodes);
  const brief = (n) => ({ id: n.id, name: n.name, kind: n.kind });
  const toShape = (stages) => stages.map((s) => ({ nodes: s.nodes.map(brief) }));

  function uniqueId(base) {
    const taken = new Set([...(st ? draftNodes().map((n) => n.id) : []), ...libNodes().map((n) => n.id)]);
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  function loopDraft(entry, extra = {}) {
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      maxPasses: entry.maxPasses,
      plan: entry.plan ?? "none",
      finish: entry.finish ?? "review",
      planReviewer: entry.planReviewer && libNode(entry.planReviewer) ? cleanNode(libNode(entry.planReviewer)) : null,
      stages: entry.stages.map((s) => ({ nodes: s.nodes.flatMap((id) => (libNode(id) ? [cleanNode(libNode(id))] : [])) })),
      ...extra,
    };
  }

  /** Loads the draft a route names: the session's flow, a library flow, a new one, or a single library node. */
  function load(key, route) {
    const p = page.payload;
    let draft;
    let target;
    if (route[0] === "node") {
      const n = libNode(route[1]);
      target = { kind: "node", id: route[1], source: n?.source ?? null };
      draft = { node: n ? cleanNode(n) : null };
    } else if (route[1] === "session" && p.attached) {
      const loop = p.attached.loop;
      target = { kind: "session" };
      draft = { id: loop.id, name: loop.name, description: loop.description, maxPasses: loop.maxPasses, plan: loop.plan, finish: loop.finish ?? "review", planReviewer: loop.planReviewer ? cleanNode(loop.planReviewer) : null, stages: loop.stages.map((s) => ({ nodes: s.nodes.map(cleanNode) })) };
    } else if (route[1] === "loop" && p.library.loops.some((l) => l.id === route[2])) {
      const entry = p.library.loops.find((l) => l.id === route[2]);
      target = { kind: "loop", id: entry.id, source: entry.source };
      draft = loopDraft(entry);
    } else {
      target = { kind: "new" };
      draft = { id: null, name: "New flow", description: "", maxPasses: 4, plan: "none", finish: "review", planReviewer: null, stages: [] };
    }
    st = { key, target, draft, dirtyNodes: new Set(), fresh: new WeakSet(), dirty: false };
  }

  const shapeOf = () => ({
    id: st.draft.id,
    name: st.draft.name,
    description: st.draft.description,
    maxPasses: st.draft.maxPasses,
    plan: st.draft.plan,
    finish: st.draft.finish,
    planReviewer: st.draft.planReviewer ? brief(st.draft.planReviewer) : null,
    stages: toShape(st.draft.stages),
  });

  const touch = () => {
    st.dirty = true;
    renderBody();
  };
  const base = () => `#/${st.key}`;

  /** The Add a check dialog: a new check of each kind, or one from the library. */
  function addDialog(place) {
    const inFlow = new Set(draftNodes().map((n) => n.id));
    const pick = (node, fresh) => {
      close();
      if (fresh) {
        st.fresh.add(node);
        st.dirtyNodes.add(node.id);
      }
      place(node);
      touch();
      page.go(`${base()}/node/${encodeURIComponent(node.id)}`);
    };
    const fresh = (kind, sub) => h("button", { type: "button", class: "add-item", onclick: () => pick(blankNode(kind, uniqueId(slug(blankNode(kind, "").name))), true) }, h("strong", {}, `+ ${KIND_LABELS[kind]}`), h("span", { class: "muted" }, sub));
    const library = libNodes().filter((n) => !inFlow.has(n.id));
    const close = modal(
      h(
        "div",
        { class: "form" },
        h("h3", {}, "Add a check"),
        h("div", { class: "add-grid" }, fresh("check", "A command that must exit 0"), fresh("review", "An AI reads the change")),
        library.length ? h("h4", {}, "From the library") : null,
        h(
          "div",
          { class: "add-list" },
          library.map((n) => h("button", { type: "button", class: "add-item", onclick: () => pick(cleanNode(n), false) }, h("strong", {}, n.name), h("span", { class: "muted" }, `${KIND_LABELS[n.kind]} · ${levelLabel(n.source)}${n.description ? ` · ${n.description}` : ""}`))),
        ),
      ),
    );
  }

  function saveLoopTo(level) {
    const d = st.draft;
    const stages = d.stages.filter((s) => s.nodes.length);
    if (!stages.length) return toast("Add at least one change check first", true);
    if (d.plan === "ai" && !d.planReviewer) return toast("Pick the AI reviewer that approves the plan first", true);
    const id = d.id ?? uniqueId(slug(d.name) || "flow");
    const nodes = [...(d.planReviewer ? [d.planReviewer] : []), ...stages.flatMap((s) => s.nodes)].filter((n) => st.dirtyNodes.has(n.id) || !libNode(n.id));
    const ids = (list) => list.map((s) => ({ nodes: s.nodes.map((n) => n.id) }));
    const loop = { id, name: d.name, description: d.description, maxPasses: d.maxPasses, plan: d.plan, finish: d.finish, planReviewer: d.planReviewer?.id ?? null, stages: ids(stages) };
    void page.act("POST", "/api/library/loop", { scope: level, loop, nodes }, `Saved «${d.name}» to ${levelLabel(level)}`).then((r) => {
      if (!r) return;
      d.id = id;
      st.target = { kind: "loop", id, source: level };
      st.dirtyNodes.clear();
      st.dirty = false;
      renderBody();
    });
  }

  function renderSheet(node, inFlow) {
    const saved = !!libNode(node.id) && !st.fresh.has(node);
    const form = nodeForm(
      node,
      (key, previous) => {
        if (key === "id") st.dirtyNodes.delete(previous);
        st.dirtyNodes.add(node.id);
        st.dirty = true;
        if (key === "id") history.replaceState(null, "", `${base()}/node/${encodeURIComponent(node.id)}`);
        if (inFlow) renderDiagram();
      },
      { idEditable: !saved },
    );
    const remove = () => {
      if (st.draft.planReviewer === node) st.draft.planReviewer = null;
      for (const s of st.draft.stages) s.nodes = s.nodes.filter((n) => n !== node);
      st.draft.stages = st.draft.stages.filter((s) => s.nodes.length);
      st.dirty = true;
      page.up();
    };
    let draftBox = null;
    const draft = h("button", { class: "btn sm", type: "button", onclick: () => {
      draftBox ??= draftPanel(page, node);
      draft.replaceWith(draftBox);
    } }, "Draft with omp");
    return h(
      "aside",
      { class: "sheet" },
      h("header", { class: "bar" }, h("button", { class: "btn ghost sm", type: "button", onclick: () => page.up() }, "‹ Done"), h("h2", {}, KIND_LABELS[node.kind]), h("span", { class: "spacer" }), inFlow ? h("button", { class: "btn sm danger", type: "button", onclick: remove }, "Remove") : null),
      form,
      draft,
    );
  }

  let diagramEl = null;
  function renderDiagram() {
    if (!diagramEl) return;
    const selected = page.route.at(-2) === "node" ? page.route.at(-1) : null;
    renderLoop(diagramEl, shapeOf(), null, {
      edit: {
        selected,
        onSelect: (id) => page.go(id ? `${base()}/node/${encodeURIComponent(id)}` : base()),
        onPlanMode: (mode) => {
          st.draft.plan = mode;
          const fallback = libNode("plan-reviewer");
          if (mode !== "ai") st.draft.planReviewer = null;
          else if (!st.draft.planReviewer && fallback && !draftNodes().some((n) => n.id === fallback.id)) st.draft.planReviewer = cleanNode(fallback);
          touch();
        },
        onToggleFinish: () => {
          st.draft.finish = st.draft.finish === "review" ? "auto" : "review";
          touch();
        },
        onAddStage: (phase, index) => addDialog((node) => (phase === "plan" ? (st.draft.planReviewer = node) : st.draft.stages.splice(index, 0, { nodes: [node] }))),
        onAddToStage: (_phase, i) => addDialog((node) => st.draft.stages[i].nodes.push(node)),
      },
    });
  }

  function renderBody() {
    const route = page.route;
    if (st.target.kind === "node") return renderNodeScreen();
    const d = st.draft;
    const title = st.target.kind === "new" ? "New flow" : `Edit «${d.name}»`;
    const where = st.target.kind === "session" ? "This session's flow" : st.target.kind === "loop" ? `${levelLabel(st.target.source)} library` : "Not saved yet";
    diagramEl = h("div", { class: "edit-diagram" });
    renderDiagram();
    const saveBtn = h("button", { class: "btn", type: "button" }, "Save to ▾");
    saveBtn.onclick = () => saveMenu(saveBtn, page.payload.library.loops.find((l) => l.id === (d.id ?? slug(d.name))), saveLoopTo, page);
    const nodeId = route.at(-2) === "node" ? route.at(-1) : null;
    const node = nodeId ? draftNodes().find((n) => n.id === nodeId) : null;
    // h() drops null children; replaceChildren would print them.
    root.replaceChildren(...h("div", {},
      h("header", { class: "bar" }, h("button", { class: "btn ghost sm", type: "button", onclick: () => page.go("#/") }, "‹ Back"), h("h1", {}, title), h("span", { class: "tag" }, where), st.dirty ? h("span", { class: "dirty" }, "unsaved") : null),
      h(
        "div",
        { class: "flow-fields" },
        field("Name", h("input", { class: "field", value: d.name, oninput: (e) => ((d.name = e.target.value), (st.dirty = true)) })),
        field("Description", h("input", { class: "field", value: d.description, placeholder: "What this flow is for", oninput: (e) => ((d.description = e.target.value), (st.dirty = true)) })),
        field("Passes", h("input", { class: "field", type: "number", min: 1, max: 10, value: d.maxPasses, oninput: (e) => e.target.value && ((d.maxPasses = Math.max(1, Math.min(10, Number(e.target.value)))), touch()) }), "Then what's left comes to you"),
      ),
      diagramEl,
      h("p", { class: "hint" }, "Click a check to edit it. Checks run left to right; checks stacked in one column run together."),
      h(
        "footer",
        { class: "bar footer" },
        h("button", { class: "btn primary", type: "button", disabled: !page.payload.session.repo, onclick: async () => {
          const stages = d.stages.filter((s) => s.nodes.length);
          if (!stages.length) return toast("Add at least one change check first", true);
          if (d.plan === "ai" && !d.planReviewer) return toast("Pick the AI reviewer that approves the plan first", true);
          const loop = { ...shapeOf(), planReviewer: d.planReviewer ? cleanNode(d.planReviewer) : null, stages: stages.map((s) => ({ nodes: s.nodes.map(cleanNode) })) };
          if (await page.act("PUT", "/api/session-loop", { loop }, `«${d.name}» runs in this session from now on`)) {
            st.dirty = false;
            page.go("#/");
          }
        } }, "Use in this session"),
        saveBtn,
        h("button", { class: "btn ghost", type: "button", onclick: () => ((st = null), editor.show(page.route)) }, "Revert"),
      ),
      node ? renderSheet(node, true) : null,
    ).childNodes);
  }

  function renderNodeScreen() {
    const node = st.draft.node;
    if (!node) return root.replaceChildren(h("header", { class: "bar" }, h("button", { class: "btn ghost sm", type: "button", onclick: () => page.up() }, "‹ Library"), h("h1", {}, "Not found")), h("p", { class: "muted" }, "That check isn't in the library anymore."));
    const existing = libNode(node.id);
    const saveBtn = h("button", { class: "btn primary", type: "button" }, "Save to ▾");
    saveBtn.onclick = () =>
      saveMenu(saveBtn, existing, (level) => {
        void page.act("POST", "/api/library/node", { scope: level, node }, `Saved ${node.name} to ${levelLabel(level)}`).then((r) => {
          if (!r) return;
          st.dirty = false;
          st.dirtyNodes.clear();
          page.go("#/library");
        });
      }, page);
    root.replaceChildren(...h("div", {},
      h("header", { class: "bar" }, h("button", { class: "btn ghost sm", type: "button", onclick: () => page.up() }, "‹ Library"), h("h1", {}, node.name), h("span", { class: "tag" }, `${KIND_LABELS[node.kind]} · ${levelLabel(st.target.source)}`), st.dirty ? h("span", { class: "dirty" }, "unsaved") : null),
      existing?.source === "built-in" ? h("p", { class: "hint" }, "Presets come with the extension and don't change; saving writes your own version, which takes their place.") : null,
      h("div", { class: "node-page" }, nodeForm(node, () => {
        st.dirty = true;
        st.dirtyNodes.add(node.id);
      })),
      h("details", { class: "advanced" }, h("summary", {}, "Draft with omp"), draftPanel(page, node)),
      h("footer", { class: "bar footer" }, saveBtn, h("button", { class: "btn ghost", type: "button", onclick: () => page.up() }, "Cancel")),
    ).childNodes);
  }

  const editor = {
    root,
    dirty: () => !!st?.dirty,
    reset() {
      st = null;
    },
    show(route) {
      const node = route.indexOf("node");
      const key = (route[0] === "edit" && node > 0 ? route.slice(0, node) : route).map(encodeURIComponent).join("/");
      if (!st || st.key !== key) load(key, route);
      renderBody();
    },
    /** Library changes reach the draft: every check you haven't edited takes its saved version. */
    onState() {
      if (!st || st.target.kind === "node") return;
      let changed = false;
      for (const stage of allStages()) {
        stage.nodes.forEach((n, i) => {
          const lib = libNode(n.id);
          if (st.dirtyNodes.has(n.id) || !lib || same(n, lib)) return;
          stage.nodes[i] = cleanNode(lib);
          changed = true;
        });
      }
      if (changed) renderDiagram();
    },
  };
  return editor;
}
