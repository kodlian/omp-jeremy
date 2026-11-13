import { KIND_LABELS } from "omp-control-view/render";
import { confirmBox, h, LEVELS, levelLabel, modal, openMenu } from "./dom.js";
import { draftPanel } from "./editor.js";

const editable = (entry) => entry.source !== "built-in";
const overrides = (entry) => (entry.overrides?.length ? `overrides ${entry.overrides.map(levelLabel).join(", ")}` : "");

function moreMenu(page, anchor, kind, entry) {
  const others = LEVELS.filter(([id]) => id !== entry.source && (id !== "repo" || page.payload.session.repo));
  const items = [];
  if (kind === "loop") items.push({ label: "Use from now on", action: () => page.act("POST", "/api/attach", { loop: entry.id }, `«${entry.name}» runs from now on`).then((r) => r && page.go("#/")) });
  items.push({ label: entry.source === "built-in" ? "Customize" : "Edit", action: () => page.go(kind === "loop" ? `#/edit/loop/${encodeURIComponent(entry.id)}` : `#/node/${encodeURIComponent(entry.id)}`) });
  if (kind === "node") items.push({ label: "Draft with omp…", action: () => draftDialog(page, entry) });
  items.push("-");
  for (const [id, label, sub] of others) items.push({ label: `Copy to ${label}`, sub, action: () => page.act("POST", "/api/library/copy", { kind, id: entry.id, to: id, move: false }, `Copied to ${label}`) });
  if (editable(entry)) for (const [id, label] of others) items.push({ label: `Move to ${label}`, action: () => page.act("POST", "/api/library/copy", { kind, id: entry.id, to: id, move: true }, `Moved to ${label}`) });
  if (editable(entry)) {
    items.push("-", {
      label: "Delete",
      danger: true,
      sub: entry.overrides?.length ? `The ${levelLabel(entry.overrides[0])} version takes its place` : null,
      action: async () => {
        if (!(await confirmBox(`Delete ${entry.name} from the ${levelLabel(entry.source)} library?\n${entry.path}`, { ok: "Delete", danger: true }))) return;
        await page.act("DELETE", `/api/library/${kind}/${entry.source}/${encodeURIComponent(entry.id)}`, undefined, `Deleted ${entry.name}`);
      },
    });
  }
  openMenu(anchor, items);
}

function draftDialog(page, node = null) {
  const close = modal(
    h("div", { class: "form" }, h("h3", {}, node ? `Improve ${node.name} with omp` : "Draft a check with omp"), h("p", { class: "hint" }, "The agent researches the project, then saves the check to your library."), draftPanel(page, node), h("div", { class: "dialog-actions" }, h("button", { class: "btn", type: "button", onclick: () => close() }, "Close"))),
  );
}

function row(page, kind, entry, sub) {
  const more = h("button", { class: "tool-button", type: "button", title: "More", "aria-label": `More for ${entry.name}` }, "⋯");
  more.onclick = (e) => {
    e.stopPropagation();
    moreMenu(page, more, kind, entry);
  };
  const open = () => page.go(kind === "loop" ? `#/edit/loop/${encodeURIComponent(entry.id)}` : `#/node/${encodeURIComponent(entry.id)}`);
  return h(
    "div",
    { class: "lib-row", role: "button", tabindex: "0", onclick: open, onkeydown: (e) => e.key === "Enter" && open() },
    h("div", { class: "lib-main" }, h("span", { class: "lib-name" }, entry.name), h("span", { class: "tag" }, levelLabel(entry.source)), overrides(entry) ? h("span", { class: "muted small" }, overrides(entry)) : null),
    h("div", { class: "lib-sub" }, sub),
    more,
  );
}

export function renderLibrary(page) {
  const { library } = page.payload;
  const names = new Map(library.nodes.map((n) => [n.id, n.name]));
  const summary = (l) => l.stages.map((s) => s.nodes.map((id) => names.get(id) ?? `${id} (missing)`).join(" + ")).join(" → ");
  return h(
    "div",
    { class: "screen" },
    h("header", { class: "bar" }, h("button", { class: "btn ghost sm", type: "button", onclick: () => page.go("#/") }, "‹ Back"), h("h1", {}, "Library"), h("span", { class: "spacer" }), h("button", { class: "btn sm", type: "button", onclick: () => page.go("#/edit/new") }, "New flow")),
    h("p", { class: "hint" }, "Presets come with the extension. Global items are yours, in every project (~/.omp/control). Project items are committed in .omp/control and shared with everyone on it. Project overrides Global, which overrides a Preset with the same id."),
    h("section", {}, h("h2", {}, "Flows"), library.loops.length ? library.loops.map((l) => row(page, "loop", l, [{ none: "", you: "Plan, you approve → ", ai: "Plan, AI approves → " }[l.plan], summary(l)].join(""))) : h("p", { class: "muted" }, "No flows yet.")),
    h(
      "section",
      {},
      h("div", { class: "section-head" }, h("h2", {}, "Checks"), h("span", { class: "spacer" }), h("button", { class: "btn sm", type: "button", onclick: () => draftDialog(page) }, "Draft with omp")),
      library.nodes.length ? library.nodes.map((n) => row(page, "node", n, `${KIND_LABELS[n.kind]}${n.description ? ` · ${n.description}` : ""}`)) : h("p", { class: "muted" }, "No checks yet."),
    ),
    library.errors.length ? h("section", { class: "errors" }, h("h2", {}, "Files with errors"), h("ul", {}, library.errors.map((e) => h("li", { class: "mono small" }, e.message)))) : null,
  );
}
