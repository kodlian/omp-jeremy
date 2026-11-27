export const COLUMNS = [
  { id: "idle", title: "Idle", empty: "Checkouts with nothing going on" },
  { id: "planning", title: "Planning", empty: "Nothing is being planned. Press N to start a worktree with a prompt." },
  { id: "waiting", title: "Waiting", empty: "Nothing waits" },
  { id: "doing", title: "In progress", empty: "omp sessions at work show up here" },
  { id: "uncommitted", title: "Uncommitted", empty: "Worktrees with uncommitted changes and nothing at work" },
  { id: "paused", title: "Paused", empty: "Worktrees with commits and nothing at work" },
  { id: "pr", title: "Pull request", empty: "Worktrees with an open pull request" },
  { id: "done", title: "Done", empty: "Merged or landed worktrees end up here" },
];
export const columnTitle = id => COLUMNS.find(c => c.id === id)?.title || id;

export function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export function elapsed(iso) {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
}
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A worktree on a detached HEAD has no branch: it shows by its folder and the folder above it.
export const worktreeName = w => w.title || w.branch || w.path.split("/").slice(-2).join("/");
const worktreeText = w => [w.key, worktreeName(w), w.path.split("/").slice(-2).join("/"), ...w.tags, w.agent?.title, ...(w.agents || []).map(a => a.title)]
  .filter(Boolean).join(" ").toLowerCase();
export const matchesFilter = (w, filter) => !filter || worktreeText(w).includes(filter);

// One project's worktrees and links, with the lookups every view needs. Linked worktrees on a detached HEAD stay off.
export function projectView(board, projectId) {
  const project = board?.projects.find(p => p.id === projectId) || null;
  const worktrees = (board?.worktrees || []).filter(w => w.project === projectId && (w.main || !w.detached));
  const byKey = new Map(worktrees.map(w => [w.key, w]));
  const links = project?.links || [];
  const hidden = new Set(project?.hidden || []);
  return {
    project, worktrees, byKey, links,
    titleOf: key => { const w = byKey.get(key); return w ? worktreeName(w) : key.split("/").pop(); },
    prerequisites: w => links.filter(l => l.to === w.key).map(l => byKey.get(l.from)).filter(Boolean),
    dependents: w => links.filter(l => l.from === w.key).map(l => byKey.get(l.to)).filter(Boolean),
    madeFrom: (from, to) => links.some(l => l.madeFrom && l.from === from && l.to === to),
    isHidden: w => !!w.branch && hidden.has(w.branch),
  };
}

// The open worktree's prerequisites, transitively, the open one included.
export function upstreamOf(key, links) {
  const upstream = new Set(), todo = key ? [key] : [];
  while (todo.length) {
    const k = todo.pop();
    if (upstream.has(k)) continue;
    upstream.add(k);
    for (const l of links) if (l.to === k) todo.push(l.from);
  }
  return upstream;
}

export const needsYou = a => a.state === "needs_input" || a.state === "plan_ready";
const AGENT_LABEL = { working: "Working", thinking: "Thinking", planning: "Planning" };
export const isBusy = a => !!AGENT_LABEL[a.state];
export const waitText = (view, keys) => keys?.length ? "Waiting for " + keys.map(view.titleOf).join(", ") : "Waiting";

// What one running omp does, from its own report; "omp running" when it reports nothing.
export function agentInfo(a, view) {
  if (a.state === "waiting") return { tone: "idle", mark: "waiting", text: waitText(view, a.waitingFor), since: a.since };
  if (a.state === "needs_input") return { tone: "needs", mark: "needs", text: "Needs you", since: a.since };
  if (a.state === "plan_ready") return { tone: "needs", mark: "plan", text: "Plan ready for review", since: a.since };
  if (isBusy(a)) return { tone: "busy", mark: "busy", text: AGENT_LABEL[a.state], since: a.startedAt || a.since };
  return { tone: "idle", mark: "dot", text: a.state === "idle" ? "Idle" : "omp running" };
}
// The omp that needs you first, else one at work, else the newest; with the count when several run.
export const leadAgent = w => { const r = w.agents || []; return r.find(needsYou) || r.find(isBusy) || r[0]; };
export function worktreeStatus(w, view) {
  const running = w.agents || [];
  if (running.length) return { ...agentInfo(leadAgent(w), view), count: running.length };
  const a = w.agent || {};
  if (a.state === "asleep") return { tone: "faint", mark: "asleep", text: "Asleep", at: a.at, title: `Its omp session was last active ${ago(a.at)}; Resume reopens it` };
  return { tone: "faint", mark: "none", text: "No omp session" };
}

// What an omp is on, most telling first: the question it asks, the to-do in progress, its latest sentence, its step, then your latest prompt.
export function agentLines(a) {
  const lines = [];
  if (a.question) lines.push({ kind: "asks", label: "Asks", text: a.question, tone: "attention" });
  if (a.todo?.current) lines.push({ kind: "todo", label: "To-do", text: a.todo.current });
  if (a.said) lines.push({ kind: "says", label: "Says", text: a.said });
  if (a.step && !a.question) lines.push({ kind: "step", label: "Step", text: a.step });
  if (a.message) lines.push({ kind: "you", label: "You", text: a.message });
  return lines;
}
// The task tool's jobs an omp runs, one line each.
export const subagentLines = a => (a.subagents || []).map(s => ({ kind: "agent", label: s.name, text: s.step || "Starting" }));

// A pull request's state for Primer's StateLabel.
export const prStatus = pr => ({ open: "pullOpened", draft: "draft", merged: "pullMerged", closed: "pullClosed" })[pr.state] || "pullOpened";
