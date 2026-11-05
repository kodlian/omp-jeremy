// Small DOM helpers for the Control page.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value;
    else if (key === "checked" || key === "disabled" || key === "selected") el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

let toastTimer = null;
export function toast(text, error = false) {
  let el = document.getElementById("toast");
  if (!el) {
    el = h("div", { id: "toast", role: "status" });
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.toggle("error", error);
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), error ? 6000 : 3000);
}

// A modal confirm; resolves true on OK.
export function confirmBox(text, { ok = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    const close = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    };
    const overlay = h(
      "div",
      { class: "overlay", onmousedown: (e) => e.target === overlay && close(false) },
      h(
        "div",
        { class: "dialog", role: "dialog" },
        h("div", { class: "dialog-text" }, text),
        h(
          "div",
          { class: "dialog-actions" },
          h("button", { class: "btn", type: "button", onclick: () => close(false) }, "Cancel"),
          h("button", { class: `btn ${danger ? "danger-solid" : "primary"}`, type: "button", onclick: () => close(true) }, ok),
        ),
      ),
    );
    document.body.append(overlay);
    document.addEventListener("keydown", onKey, true);
    overlay.querySelector(".btn.primary, .btn.danger-solid")?.focus();
  });
}

// A modal holding arbitrary content; returns a close function.
export function modal(content, onClose = () => {}) {
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    onClose();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const overlay = h("div", { class: "overlay", onmousedown: (e) => e.target === overlay && close() }, h("div", { class: "dialog wide", role: "dialog" }, content));
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);
  return close;
}

export function slug(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

// A dropdown under `anchor`; items: { label, sub?, danger?, disabled?, checked?, action } or "-" for a divider.
export function openMenu(anchor, items) {
  document.querySelector(".menu")?.remove();
  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const outside = (e) => !menu.contains(e.target) && e.target !== anchor && close();
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };
  const menu = h(
    "div",
    { class: "menu", role: "menu" },
    items.map((it) =>
      it === "-"
        ? h("div", { class: "menu-sep" })
        : h(
            "button",
            {
              type: "button",
              role: "menuitem",
              class: [it.danger ? "danger" : "", it.checked ? "checked" : ""].filter(Boolean).join(" ") || null,
              disabled: it.disabled,
              onclick: () => {
                close();
                it.action();
              },
            },
            h("span", { class: "menu-label" }, it.label),
            it.sub ? h("span", { class: "menu-sub" }, it.sub) : null,
          ),
    ),
  );
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 4 + menu.offsetHeight > innerHeight ? r.top - menu.offsetHeight - 4 : r.bottom + 4;
  menu.style.top = `${Math.max(4, top)}px`;
  menu.style.left = `${Math.max(4, Math.min(innerWidth - menu.offsetWidth - 4, r.left))}px`;
  document.addEventListener("mousedown", outside, true);
  document.addEventListener("keydown", onKey, true);
}

export const LEVELS = [
  ["repo", "Project", "Everyone on this project (committed in .omp/control)"],
  ["global", "Global", "You, in every project (~/.omp/control)"],
];

// Precedence for the "overrides" hints: a narrower level wins over a wider one with the same id.
const RANK = { repo: 0, global: 1, "built-in": 2 };

/** The Save to menu's hint for saving `id` at `level`, given the item that wins for it now (if any). */
export function levelHint(level, existing) {
  if (!existing) return "";
  const at = existing.source;
  if (at === level) return "Replaces the version saved there";
  if (RANK[at] < RANK[level]) return `Your ${at} version still wins in this repo`;
  return `Overrides the ${at} version here`;
}

export const levelLabel = (source) => (source === "built-in" ? "Preset" : LEVELS.find(([id]) => id === source)?.[1] ?? source);
