import { confirmBox, h, toast } from "./dom.js";
import { createEditor } from "./editor.js";
import { renderLibrary } from "./library.js";
import { renderHome } from "./run.js";

const token = new URLSearchParams(location.search).get("token") ?? "";

async function api(method, path, body) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}token=${encodeURIComponent(token)}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `${method} ${path} failed (${res.status})`);
  return data;
}

const parse = (hash) => hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
const isEditor = (route) => route[0] === "edit" || route[0] === "node";

/** The screen one level up: a node sheet closes into its editor, everything else returns home. */
function parentOf(route) {
  const node = route.indexOf("node");
  if (route[0] === "edit" && node > 0) return `#/${route.slice(0, node).map(encodeURIComponent).join("/")}`;
  if (route[0] === "node") return "#/library";
  return "#/";
}

// Screens: home (#/), the loop picker (#/pick), the library (#/library), a flow editor (#/edit/…, and …/node/<id> for
// its node sheet) and a library node (#/node/<id>). Each is a history entry, so Back and Esc go up one level.
const page = {
  payload: null,
  route: parse(location.hash),
  async act(method, path, body, done) {
    try {
      const r = await api(method, path, body);
      if (done) toast(done);
      return r;
    } catch (e) {
      toast(e.message, true);
      return null;
    }
  },
  go(hash) {
    if (location.hash !== hash) location.hash = hash;
    else render();
  },
  up() {
    page.go(parentOf(page.route));
  },
  render: () => render(),
};
page.editor = createEditor(page);

const app = document.getElementById("app");

function render() {
  page.route = parse(location.hash);
  if (!page.payload) return app.replaceChildren(h("p", { class: "connecting" }, "Connecting…"));
  const [screen] = page.route;
  if (isEditor(page.route)) {
    page.editor.show(page.route);
    if (app.firstChild !== page.editor.root) app.replaceChildren(page.editor.root);
  } else if (screen === "library") app.replaceChildren(renderLibrary(page));
  else app.replaceChildren(renderHome(page, screen === "pick"));
}

let current = location.hash;
addEventListener("hashchange", async () => {
  if (isEditor(parse(current)) && !isEditor(parse(location.hash)) && page.editor.dirty()) {
    if (!(await confirmBox("Leave without saving your changes?", { ok: "Discard", danger: true }))) {
      history.replaceState(null, "", current);
      return;
    }
    page.editor.reset();
  }
  current = location.hash;
  render();
});

addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || document.querySelector(".overlay, .menu")) return;
  if (e.target instanceof HTMLElement && e.target.matches("input, textarea, select")) return e.target.blur();
  if (page.route.length) page.up();
});

function connect() {
  const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events.addEventListener("state", (e) => {
    const first = !page.payload;
    page.payload = JSON.parse(e.data);
    // The editor keeps its DOM between states so typing isn't interrupted; it merges library changes itself.
    if (!first && isEditor(page.route)) page.editor.onState();
    else render();
  });
  events.addEventListener("appearance", () => {
    document.getElementById("appearance").href = `/appearance.css?token=${encodeURIComponent(token)}&t=${Date.now()}`;
  });
}

render();
connect();
