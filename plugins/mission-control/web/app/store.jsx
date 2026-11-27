import { createContext, use, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Dialog, Textarea, useConfirm } from "@primer/react";
import { needsYou, plural, projectView, upstreamOf, worktreeName } from "./model.js";
import { useToast } from "omp-web-design-system/toasts";
import { NewWorktreeDialog } from "./Dialogs.jsx";

export async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (method !== "GET") { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body ?? {}); }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data?.error || `${res.status} ${res.statusText}`); e.data = data; e.status = res.status; throw e; }
  return data;
}

export const LS = {
  get: k => { try { return localStorage.getItem("mission-control." + k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem("mission-control." + k, v); } catch {} },
};
// A preference kept in localStorage under `key`; a new key reads its own stored value.
export function useStored(key, decode, encode) {
  const [state, setState] = useState(() => ({ key, value: decode(LS.get(key)) }));
  const value = state.key === key ? state.value : decode(LS.get(key));
  const set = useCallback(next => { LS.set(key, encode(next)); setState({ key, value: next }); }, [key, encode]);
  return [value, set];
}

// Primer's themes follow the light or dark scheme omp's colors set.
const schemeListeners = new Set();
let scheme = "dark";
function syncScheme() {
  scheme = getComputedStyle(document.documentElement).colorScheme.includes("dark") ? "dark" : "light";
  document.documentElement.dataset.colorMode = scheme;
  schemeListeners.forEach(l => l());
}
const subscribeScheme = fn => { schemeListeners.add(fn); return () => schemeListeners.delete(fn); };
export const useScheme = () => useSyncExternalStore(subscribeScheme, () => scheme);

const BoardContext = createContext(null);
export const useBoard = () => use(BoardContext);

export function BoardProvider({ children }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [board, setBoard] = useState(null);
  const [connected, setConnected] = useState(false);
  const [wanted] = useState(() => new URLSearchParams(location.search).get("project"));
  const [selected, setOpenKey] = useState(null);
  const [pending, setPending] = useState(() => new Set());
  const [command, setCommand] = useState(null);
  const [creating, setCreating] = useState(null);

  useEffect(() => {
    let es, retry, closed = false;
    api("GET", "/api/state").then(setBoard, e => toast(e.message, true));
    const connect = () => {
      es = new EventSource("/api/events");
      es.onopen = () => setConnected(true);
      es.onerror = () => { setConnected(false); if (es.readyState === EventSource.CLOSED && !closed) retry = setTimeout(connect, 2000); };
      es.addEventListener("snapshot", e => { setConnected(true); setBoard(JSON.parse(e.data)); });
    };
    connect();
    return () => { closed = true; clearTimeout(retry); es.close(); };
  }, [toast]);

  // The page shows one project: the URL's, else the first live one, else the first.
  const list = board?.projects || [];
  const projectId = list.some(p => p.id === wanted) ? wanted : list.find(p => p.live)?.id || list[0]?.id || wanted;
  const view = useMemo(() => projectView(board, projectId), [board, projectId]);
  const openKey = selected && view.byKey.has(selected) ? selected : null;
  const upstream = useMemo(() => upstreamOf(openKey, view.links), [openKey, view.links]);
  // Where a checkout stands to the open one: itself, a prerequisite done or still open, or unrelated.
  const pathOf = w => !openKey ? undefined : w.key === openKey ? "selected" : !upstream.has(w.key) ? "unrelated" : w.column === "done" ? "ready" : "blocked";
  useEffect(() => {
    if (!projectId || projectId === wanted) return;
    const q = new URLSearchParams(location.search);
    q.set("project", projectId);
    history.replaceState(null, "", `${location.pathname}?${q}`);
  }, [projectId, wanted]);

  // Loads the project's omp colors without flashing the previous theme.
  const themeHref = board ? `/appearance.css?project=${encodeURIComponent(projectId || "")}&v=${board.themeVersion || 0}` : null;
  useEffect(() => {
    if (!themeHref) { syncScheme(); return; }
    const old = [...document.querySelectorAll('link[href^="/appearance.css"]')];
    if (old.some(l => l.getAttribute("href") === themeHref)) return;
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: themeHref });
    link.onload = () => { old.forEach(l => l.remove()); syncScheme(); };
    document.head.append(link);
  }, [themeHref]);

  const waiting = view.worktrees.filter(w => !view.isHidden(w)).flatMap(w => w.agents || []).filter(needsYou).length;
  useEffect(() => { document.title = waiting ? `${waiting} waiting · Mission Control` : "Mission Control"; }, [waiting]);

  const failed = useCallback(e => {
    const out = e.data?.output?.trim();
    toast(out && !e.message.includes(out) ? `${e.message}\n${out}` : e.message, true);
  }, [toast]);
  const act = async (method, path, body, ok) => {
    try { const r = await api(method, path, body); if (ok) toast(ok); return r; }
    catch (e) { failed(e); throw e; }
  };
  // Operations in flight, as "op:path": the button that started one shows a spinner until it ends.
  const run = async (key, fn) => {
    setPending(s => new Set(s).add(key));
    try { return await fn(); } catch {} finally { setPending(s => { const n = new Set(s); n.delete(key); return n; }); }
  };
  const patchProject = project => setBoard(b => ({ ...b, projects: b.projects.map(p => p.id === project.id ? { ...p, ...project } : p) }));
  const reload = () => api("GET", "/api/state").then(setBoard, failed);

  const actions = {
    refresh: () => act("POST", "/api/refresh", {}, "Refreshing omp sessions, git and pull requests").catch(() => {}),
    // The server runs its current code again; the page reloads on it once it answers.
    restart: () => run("restart", async () => {
      const { started } = await act("GET", "/api/health");
      await act("POST", "/api/restart", {}, "Restarting Mission Control…");
      for (const end = Date.now() + 60_000; Date.now() < end;) {
        await new Promise(r => setTimeout(r, 300));
        if (await api("GET", "/api/health").then(h => h.started !== started, () => false)) return location.reload();
      }
      toast("Mission Control didn't come back. Run /mission in omp to start it.", true);
    }),
    openTerminal: (w, agent) => run(`open:${w.path}`, async () => {
      const r = await act("POST", "/api/worktrees/open", agent ? { path: w.path, session: agent.id } : { path: w.path });
      if (!r.opened) setCommand({ title: `Open ${worktreeName(w)}`, command: r.cd,
        text: agent ? "Its omp's terminal can't be brought forward. Run this in a terminal to go there." : "No terminal is open in this checkout. Run this in a terminal to go there." });
    }),
    resume: w => run(`resume:${w.path}`, async () => {
      const r = await act("POST", "/api/worktrees/resume", { path: w.path, session: w.agent.session.id });
      if (!r.opened) setCommand({ title: `Resume ${worktreeName(w)}`, text: "Run this in any terminal to reopen its omp session.", command: r.command });
    }),
    createPr: w => run(`pr:${w.path}`, async () => {
      const r = await act("POST", "/api/worktrees/pr", { path: w.path });
      toast(r.url ? <>Pull request opened: <a href={r.url} target="_blank" rel="noopener">{r.url}</a></> : "Pull request opened");
    }),
    setLink: async (from, to, linked) => {
      try { patchProject((await api("PATCH", "/api/projects/links", { id: projectId, from, to, linked })).project); }
      catch (e) { failed(e); }
    },
    // Opens New worktree once at a time; `after` preselects its After, `prompt` fills its prompt, `onCreated` gets the new key, `onClosed` runs however it closes.
    newWorktree: (opts = {}) => {
      if (creating || !board) return false;
      if (!view.project) { toast("This project is unavailable: run /mission in its checkout", true); return false; }
      setCreating(opts);
      return true;
    },
    createWorktree: async ({ branch, prompt, after }) => {
      const r = await act("POST", "/api/worktrees/new", { project: projectId, ...(branch ? { branch } : {}), ...(prompt ? { prompt } : {}), ...(after ? { after } : {}) });
      toast(r.output || `Created ${r.path}`);
      creating?.onCreated?.(r.key);
      if (prompt && !r.opened && r.command) setCommand({ title: `Start ${r.key}`, command: r.command,
        text: "No terminal could be opened there. Run this in a terminal to start its omp in plan mode on the prompt." });
      reload();
    },
    setTagRules: async rules => patchProject((await act("PATCH", "/api/projects/tag-rules", { id: projectId, rules },
      rules.length ? `${plural(rules.length, "tag rule")} saved` : "Tag rules cleared")).project),
    setScripts: async (setupScript, teardownScript) => patchProject((await act("PATCH", "/api/projects/scripts",
      { id: projectId, setupScript, teardownScript }, `Scripts saved for ${view.project.name}`)).project),
    // True once saved; a failure keeps the caller's in-flight places so the canvas doesn't place them again.
    savePositions: async (positions, reset = false) => {
      try { patchProject((await api("PATCH", "/api/projects/positions", { id: projectId, positions, ...(reset ? { reset: true } : {}) })).project); return true; }
      catch (e) { failed(e); return false; }
    },
    setHidden: async (branch, hidden) => {
      try {
        const r = await act("PATCH", "/api/projects/hidden", { id: projectId, branch, hidden },
          hidden ? `${branch} is hidden; "hidden" in the tag bar shows it` : `${branch} is back on the board`);
        patchProject(r.project);
      } catch {}
    },
    setTags: async (w, tags) => {
      try {
        const r = await api("PATCH", "/api/projects/tags", { id: projectId, key: w.key, tags });
        const own = new Set(w.ownTags || []), rules = (w.tags || []).filter(x => !own.has(x));
        setBoard(b => ({
          ...b,
          projects: b.projects.map(p => p.id === r.project.id ? { ...p, ...r.project } : p),
          worktrees: b.worktrees.map(x => x.path === w.path ? { ...x, ownTags: tags, tags: [...new Set([...tags, ...rules])].slice(0, 8) } : x),
        }));
      } catch (e) { failed(e); }
    },
    remove: async function remove(w, dirty = 0) {
      const what = `${w.path} and branch ${w.branch}`;
      const ok = await confirm({
        title: dirty ? `${plural(dirty, "uncommitted file")} will be lost` : "Remove the worktree?",
        content: dirty ? `${worktreeName(w)} has uncommitted changes. Removing it anyway deletes them with ${what}.` : `Deletes ${what}.`,
        confirmButtonContent: dirty ? "Remove anyway" : "Remove worktree",
        confirmButtonType: "danger",
      });
      if (!ok) return;
      const again = await run(`remove:${w.path}`, async () => {
        try {
          const r = await api("POST", "/api/worktrees/remove", dirty ? { path: w.path, force: true } : { path: w.path });
          setBoard(b => ({ ...b, worktrees: b.worktrees.filter(x => x.path !== w.path) }));
          toast(r.output || `${worktreeName(w)} removed`);
        } catch (e) {
          if (e.status === 409 && e.data?.dirty && !dirty) return e.data.dirty;
          failed(e);
        }
      });
      if (again) remove(w, again);
    },
  };

  const value = { board, view, connected, openKey, setOpenKey, pathOf, pending, actions };
  return (
    <BoardContext value={value}>
      {children}
      {command ? <CommandDialog {...command} onClose={() => setCommand(null)} /> : null}
      {creating ? <NewWorktreeDialog after={creating.after} prompt={creating.prompt} onClose={() => { setCreating(null); creating.onClosed?.(); }} /> : null}
    </BoardContext>
  );
}

function CommandDialog({ title, text, command, onClose }) {
  const toast = useToast();
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); toast("Command copied"); }
    catch { toast("Couldn't copy to the clipboard", true); }
  };
  return (
    <Dialog title={title} onClose={onClose} footerButtons={[{ content: "Close", onClick: onClose }, { content: "Copy command", buttonType: "primary", onClick: copy }]}>
      <p className="dialog-text">{text}</p>
      <Textarea className="mono" value={command} readOnly rows={2} resize="none" block aria-label="Command" />
    </Dialog>
  );
}
