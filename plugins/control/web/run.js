import { renderDecisions, renderLoop, runHeadline } from "omp-control-view/render";
import { h, levelLabel, modal, openMenu } from "./dom.js";
import { describeFlow, libraryShape } from "./flows.js";

let chosen = null;

/** Images the checks wrote to $CONTROL_ARTIFACTS on their last run, with the check's name. */
function artifacts(run) {
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const shots = run.loop.stages.flatMap((s) => s.nodes).flatMap((n) => (run.nodes[n.id]?.artifacts ?? []).map((path) => ({ node: n.name, path })));
  if (!shots.length) return null;
  return h(
    "div",
    { class: "review-shots" },
    shots.map(({ node, path }) => {
      const src = `/api/artifact?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}&pass=${run.pass}`;
      const name = path.slice(path.lastIndexOf("/") + 1);
      return h("a", { class: "review-shot", href: src, target: "_blank", title: `${node} · ${name}` }, h("img", { src, alt: name, loading: "lazy" }), h("span", { class: "small muted" }, `${node} · ${name}`));
    }),
  );
}

/** The change in one line, with a button to read it in git-diff-review when it's loaded, and the screenshots its checks took. */
function changePanel(page, run) {
  const line = h("p", { class: "muted small" }, "Loading the change…");
  void page.act("GET", "/api/changes").then((files) => {
    if (!files) return;
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    line.replaceChildren(files.length ? `${files.length} file${files.length === 1 ? "" : "s"} changed, +${added} −${removed}` : "No changes yet.");
  });
  const open = page.payload.review ? h("button", { class: "btn sm", type: "button", title: "Read the change and comment on its lines in git-diff-review", onclick: () => page.act("POST", "/api/review", {}) }, "Open in Review") : null;
  return h("div", { class: "section-body" }, h("div", { class: "change-line" }, line, open), artifacts(run));
}

/** Reviews you finished, newest first. */
function pastReviews(run) {
  if (!run.reviews?.length) return null;
  return h(
    "details",
    { class: "past-reviews" },
    h("summary", {}, `Past reviews (${run.reviews.length})`),
    run.reviews.map((r) =>
      h(
        "div",
        { class: "past-review" },
        h("div", { class: "past-head" }, h("span", { class: `tag ${r.outcome === "approved" ? "ok" : "warn"}` }, r.outcome === "approved" ? "Approved" : "Sent back"), h("span", { class: "muted small" }, new Date(r.at).toLocaleString())),
        r.note ? h("p", {}, r.note) : null,
        h("pre", { class: "past-summary" }, r.summary),
        r.answers.length ? h("ul", { class: "past-answers" }, r.answers.map((a) => h("li", {}, h("span", { class: "muted" }, `${a.nodeName} · `), `${a.rule} → `, h("strong", {}, a.answer)))) : null,
      ),
    ),
  );
}

function picker(page, switching) {
  const { library, session, attached } = page.payload;
  const loops = library.loops;
  if (!loops.some((l) => l.id === chosen)) chosen = attached?.loop.id && loops.some((l) => l.id === attached.loop.id) ? attached.loop.id : (loops[0]?.id ?? null);
  const entry = loops.find((l) => l.id === chosen) ?? null;
  const list = h(
    "div",
    { class: "pick-list", role: "listbox" },
    loops.map((l) =>
      h(
        "button",
        { type: "button", role: "option", class: `pick-item${l.id === chosen ? " selected" : ""}`, "aria-selected": String(l.id === chosen), onclick: () => ((chosen = l.id), page.render()) },
        h("span", { class: "pick-name" }, l.name, attached?.loop.id === l.id ? h("span", { class: "tag" }, "current") : null),
        h("span", { class: "pick-sub" }, l.description || `${l.stages.reduce((n, s) => n + s.nodes.length, 0)} checks`),
        h("span", { class: "tag" }, levelLabel(l.source)),
      ),
    ),
    h("button", { type: "button", class: "pick-item pick-new", onclick: () => page.go("#/edit/new") }, h("span", { class: "pick-name" }, "+ New flow"), h("span", { class: "pick-sub" }, "Start from an empty flow")),
  );
  let preview = h("div", { class: "pick-preview empty" }, h("p", { class: "muted" }, "Pick a flow to see what it does."));
  if (entry) {
    const shape = libraryShape(page.payload, entry);
    const diagram = h("div", { class: "pick-diagram" });
    renderLoop(diagram, shape, null);
    const using = attached?.loop.id === entry.id;
    preview = h(
      "div",
      { class: "pick-preview" },
      h("h2", {}, entry.name),
      entry.description ? h("p", { class: "muted" }, entry.description) : null,
      diagram,
      h("h3", {}, "From now on"),
      h("ol", { class: "steps" }, describeFlow(shape).map((s) => h("li", {}, s))),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn primary",
            type: "button",
            disabled: using || !session.repo,
            title: session.repo ? null : "This session isn't in a git repository",
            onclick: async () => {
              if (await page.act("POST", "/api/attach", { loop: entry.id }, `«${entry.name}» runs from now on`)) page.go("#/");
            },
          },
          using ? "In use" : "Use from now on",
        ),
        h("button", { class: "btn", type: "button", onclick: () => page.go(`#/edit/loop/${encodeURIComponent(entry.id)}`) }, entry.source === "built-in" ? "Customize" : "Edit"),
      ),
    );
  }
  return h(
    "div",
    { class: "screen" },
    h(
      "header",
      { class: "bar" },
      switching ? h("button", { class: "btn ghost sm", type: "button", onclick: () => page.up() }, "‹ Back") : null,
      h("h1", {}, switching ? "Switch flow" : "No control flow in this session"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn ghost sm", type: "button", onclick: () => page.go("#/library") }, "Library"),
    ),
    switching ? null : h("p", { class: "lead muted" }, "Pick the flow that checks this session's changes from now on."),
    session.repo ? null : h("p", { class: "warning-text" }, "This session isn't in a git repository; flows need one."),
    page.payload.run?.note && !attached ? h("p", { class: "warning-text" }, page.payload.run.note) : null,
    h("div", { class: "pick" }, list, preview),
  );
}

function section(n, title, cls, ...body) {
  return h("section", { class: `run-section ${cls}` }, h("h2", {}, h("span", { class: "section-n" }, String(n)), title), ...body);
}

/** Asks for a branch or commit; the loop then checks everything since it. */
function sinceDialog(page) {
  const ref = h("input", { class: "field mono", placeholder: "main, origin/main, HEAD~3 or a commit", spellcheck: "false" });
  const submit = async (e) => {
    e.preventDefault();
    if (!ref.value.trim()) return ref.focus();
    const r = await page.act("POST", "/api/since", { ref: ref.value.trim() });
    if (r) close();
  };
  const close = modal(
    h(
      "form",
      { class: "form", onsubmit: submit },
      h("h3", {}, "Check changes since…"),
      h("p", { class: "muted small" }, "A branch checks everything since this branch left it; a commit checks everything after it, uncommitted changes included. The loop starts right away."),
      ref,
      h("div", { class: "dialog-actions" }, h("button", { class: "btn", type: "button", onclick: () => close() }, "Cancel"), h("button", { class: "btn primary", type: "submit" }, "Check")),
    ),
  );
  ref.focus();
}

function running(page) {
  const { attached, run, session } = page.payload;
  const paused = run.status === "paused";
  const onDecide = (decisions, pause) => page.act("POST", "/api/decide", { decisions, pause });
  const name = h("button", { class: "flow-name", type: "button", title: "Switch, edit or detach this flow" }, run.loop.name, h("span", { class: "chev" }, "▾"));
  name.onclick = () =>
    openMenu(name, [
      { label: "Switch flow…", action: () => page.go("#/pick") },
      { label: "Check changes since…", sub: attached.since ? `Now: ${attached.since}` : "Pick a branch or commit to measure from", action: () => sinceDialog(page) },
      { label: "Edit this flow", sub: "Changes apply to this session; save them to keep them", action: () => page.go("#/edit/session") },
      { label: "Library", action: () => page.go("#/library") },
      "-",
      { label: "Detach", danger: true, sub: "This session stops checking its changes", action: () => page.act("POST", "/api/attach", { loop: null }, "Detached the flow") },
    ]);
  const requests = run.pendingReview?.requests.length ? run.pendingReview.requests : [];
  const waiting = run.gate.open && run.findings.some((f) => (f.route === "ask" || f.approval) && !f.decision);
  const reviewDue = run.gate.open && run.findings.some((f) => f.approval && !f.decision);
  let n = 0;
  const needs = waiting
    ? section(++n, "Needs you", "needs", (() => {
        const el = h("div");
        renderDecisions(el, run, { onDecide });
        return el;
      })())
    : run.pendingReview && !reviewDue
      ? section(++n, "Needs you", "needs", h("p", { class: "review-wait" }, "Your review is still waiting. The agent is working on your newer request; the review opens again with every change once it's done."))
      : null;
  const progress = h("div", { class: "run-view" });
  renderLoop(progress, run.loop, run, { onDecide }, { decisions: false });
  return h(
    "div",
    { class: "screen" },
    h(
      "header",
      { class: "bar" },
      name,
      attached.source === "session" ? h("span", { class: "tag" }, "edited for this session") : null,
      h("span", { class: "spacer" }),
      h(
        "button",
        { class: "btn sm", type: "button", title: session.idle ? "Run the checks on the code as it is now, even if it already passed" : "The agent is working; the checks run on the code as it is when it's done", onclick: () => page.act("POST", "/api/check", {}, "The loop runs on the current code") },
        "Check now",
      ),
      h("button", { class: "btn sm", type: "button", onclick: () => page.act("POST", "/api/pause", { paused: !paused }, paused ? "Resumed" : "Paused") }, paused ? "Resume" : "Pause"),
    ),
    h(
      "div",
      { class: `run-headline${waiting ? " is-waiting" : ""}` },
      h("div", { class: "run-status" }, runHeadline(run)),
      attached.since ? h("div", { class: "run-request muted" }, `Checking the changes ${attached.since}`) : null,
      requests.length > 1
        ? h("ul", { class: "review-requests" }, requests.map((r) => h("li", {}, r.length > 200 ? `${r.slice(0, 199)}…` : r)))
        : requests.length
          ? h("div", { class: "run-request muted" }, `Request: ${requests[0].slice(0, 200)}`)
          : null,
    ),
    needs,
    section(++n, "The change", "change", changePanel(page, run)),
    section(++n, "Progress", "progress", h("p", { class: "muted small" }, "Where the flow is: the agent implements, the checks run in order, findings go back to the agent or to you."), progress),
    pastReviews(run),
  );
}

export function renderHome(page, switching) {
  const { attached, run } = page.payload;
  return attached && run && !switching ? running(page) : picker(page, switching && !!attached);
}
