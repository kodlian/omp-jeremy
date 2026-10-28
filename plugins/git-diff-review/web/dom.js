const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function isTextField(el) {
  return el instanceof HTMLElement && (el.isContentEditable || el.matches("input, textarea, select"));
}

export function splitPath(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}

let toastTimer = null;
export function toast(message, ms = 3000) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), ms);
}

function execCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
  const active = document.activeElement;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  ta.remove();
  active?.focus?.({ preventScroll: true });
  return ok;
}

// execCommand runs synchronously inside the user gesture; navigator.clipboard can stay pending without clipboard permission.
export async function copyText(text) {
  if (execCopy(text)) return true;
  if (!navigator.clipboard) return false;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 500));
  return Promise.race([navigator.clipboard.writeText(text).then(() => true, () => false), timeout]);
}

// Anchored dropdown menu; items: [{ id, label, subtitle?, icon?, danger? }]. `search` adds a filter field.
export function openMenu(anchor, items, onPick, { search = null } = {}) {
  document.querySelector(".menu")?.remove();
  const menu = document.createElement("div");
  menu.className = `menu${search ? " searchable" : ""}`;
  const buttons = items
    .map(
      (it) =>
        `<button type="button" data-id="${esc(it.id)}" data-text="${esc(`${it.label} ${it.subtitle ?? ""}`.toLowerCase())}" class="${it.danger ? "danger" : ""}">${it.icon ?? ""}<span>${esc(it.label)}</span>${it.subtitle ? `<span class="muted menu-sub">${esc(it.subtitle)}</span>` : ""}</button>`,
    )
    .join("");
  menu.innerHTML = search ? `<input class="field menu-search" type="search" placeholder="${esc(search)}" spellcheck="false" /><div class="menu-items">${buttons}</div>` : buttons;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 4 + menu.offsetHeight > window.innerHeight ? r.top - menu.offsetHeight - 4 : r.bottom + 4;
  menu.style.top = `${Math.max(4, top)}px`;
  menu.style.left = `${Math.max(4, Math.min(window.innerWidth - menu.offsetWidth - 4, r.left))}px`;
  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
  };
  const outside = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const pick = (id) => {
    close();
    onPick(id);
  };
  setTimeout(() => document.addEventListener("mousedown", outside, true));
  menu.addEventListener("click", (e) => {
    const id = e.target.closest("[data-id]")?.dataset.id;
    if (id != null) pick(id);
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      anchor.focus?.();
    }
  });
  const input = menu.querySelector(".menu-search");
  if (!input) return;
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    for (const b of menu.querySelectorAll("[data-id]")) b.hidden = Boolean(q) && !b.dataset.text.includes(q);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const first = [...menu.querySelectorAll("[data-id]")].find((b) => !b.hidden);
    if (first) pick(first.dataset.id);
    else if (input.value.trim()) pick(input.value.trim());
  });
  input.focus();
}
