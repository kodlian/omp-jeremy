import { esc } from "omp-web-client/esc";

export function isTextField(el) {
  return el instanceof HTMLElement && (el.isContentEditable || el.matches("input, textarea, select"));
}

// A plain small icon button inside the diff's HTML; `act` names its delegated click action.
export function toolButton(act, title, glyph) {
  return `<button type="button" class="icon-button" data-act="${act}" title="${esc(title)}" aria-label="${esc(title)}">${glyph}</button>`;
}

export function splitPath(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
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
