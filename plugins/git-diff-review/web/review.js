import { connectSocket, reloadAppearance, token, withToken } from "omp-web-client";
import { PROTOCOL } from "../src/shared/protocol.js";
import { PREFS_KEY, compareFromParams, compareKey, signature, viewedKey } from "./model.js";

export async function api(path, query = {}) {
  const q = new URLSearchParams(query).toString();
  const res = await fetch(withToken(q ? `${path}?${q}` : path));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function compareQuery(c) {
  const query = { kind: c.kind };
  if (c.kind === "branch" && c.base) query.base = c.base;
  if (c.kind === "commit" && c.sha) query.sha = c.sha;
  return query;
}

// The page's one store: state, preferences, the socket to omp and the review data. `diff` is the imperative diff body once mounted.
export function createReview() {
  const params = new URLSearchParams(location.search);
  const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
  const listeners = new Set();
  let seq = 0;
  let timer = null;
  let dirty = false;
  let socket = null;
  let state = {
    compare: compareFromParams(params),
    files: [],
    branch: null,
    base: null,
    commit: null,
    loading: true,
    error: null,
    notRepo: false,
    loadedKey: null,
    selected: params.get("file"),
    filter: "",
    tree: prefs.tree ?? true,
    collapsedDirs: new Set(),
    layout: prefs.layout === "split" ? "split" : "unified",
    wrap: Boolean(prefs.wrap),
    ignoreWhitespace: Boolean(prefs.ignoreWhitespace),
    syntaxColors: prefs.syntaxColors !== false,
    hideUnchanged: Boolean(prefs.hideUnchanged),
    sidebarWidth: prefs.sidebarWidth ?? 300,
    sidebarHidden: Boolean(prefs.sidebarHidden),
    openIn: typeof prefs.openIn === "string" ? prefs.openIn : null,
    fontSize: typeof prefs.fontSize === "number" ? prefs.fontSize : null,
    pins: [],
    viewed: {},
    root: null,
    session: null,
    name: null,
    stale: false,
    connected: false,
    composer: null,
    find: { open: false, query: "", total: 0, current: -1, focus: 0 },
    slots: [],
    openInMenu: null,
  };

  function savePrefs() {
    const { tree, layout, wrap, ignoreWhitespace, syntaxColors, hideUnchanged, sidebarWidth, sidebarHidden, openIn, fontSize } = state;
    localStorage.setItem(PREFS_KEY, JSON.stringify({ tree, layout, wrap, ignoreWhitespace, syntaxColors, hideUnchanged, sidebarWidth, sidebarHidden, openIn, fontSize }));
  }

  function syncUrl() {
    const p = new URLSearchParams({ token });
    const c = state.compare;
    if (c.kind !== "uncommitted") p.set("kind", c.kind);
    if (c.kind === "branch" && c.base) p.set("base", c.base);
    if (c.kind === "commit" && c.sha) p.set("sha", c.sha);
    if (state.selected) p.set("file", state.selected);
    history.replaceState(null, "", `?${p}`);
  }

  function onSocket(msg) {
    const { diff } = review;
    if (msg.type === "appearance" || (msg.type === "hello" && state.root)) reloadAppearance();
    if (msg.type === "hello") {
      const moved = state.root && state.root !== msg.root;
      review.set({ root: msg.root, name: msg.name, stale: msg.protocol !== PROTOCOL, session: msg.session, pins: msg.pins, viewed: msg.viewed });
      document.title = `Review · ${msg.name}`;
      if (moved) {
        review.set({ selected: null });
        review.setCompare({ kind: "uncommitted" });
      } else {
        diff?.syncCollapsed();
        diff?.rerenderBodies();
      }
    } else if (msg.type === "state") {
      const pinsChanged = JSON.stringify(msg.pins) !== JSON.stringify(state.pins);
      review.set({ pins: msg.pins, viewed: msg.viewed });
      diff?.syncCollapsed();
      if (pinsChanged) diff?.rerenderBodies();
    } else if (msg.type === "changed") {
      review.scheduleRefresh();
    } else if (msg.type === "error") {
      review.toast(msg.message, true);
    }
  }

  function clearStaleViewed() {
    const next = { ...state.viewed };
    let changed = false;
    for (const f of state.files) {
      const key = viewedKey(state, f.path);
      if (next[key] && next[key] !== signature(f)) {
        delete next[key];
        changed = true;
      }
    }
    if (changed) {
      review.set({ viewed: next });
      review.send({ type: "viewed", viewed: next });
    }
  }

  const review = {
    diff: null,
    toast: () => {},

    get state() {
      return state;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    set(patch) {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      for (const listener of listeners) listener();
    },

    start() {
      socket = connectSocket(onSocket, (connected) => review.set({ connected }));
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && dirty) {
          dirty = false;
          review.scheduleRefresh(50);
        }
      });
      window.addEventListener("focus", () => review.scheduleRefresh(50));
      void review.refresh();
    },

    send(msg) {
      if (socket?.send(msg)) return true;
      review.toast("Not connected to omp. Run /review again.", true);
      return false;
    },

    scheduleRefresh(ms = 400) {
      if (document.hidden) {
        dirty = true;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(review.refresh, ms);
    },

    async refresh() {
      const mine = ++seq;
      review.set({ loading: true });
      try {
        const c = state.compare;
        const loaded = await api("/api/review", { ...compareQuery(c), ws: state.ignoreWhitespace ? "1" : "0" });
        if (mine !== seq) return;
        const compare = c.kind === "commit" && !c.sha && loaded.commit ? { kind: "commit", sha: loaded.commit.sha } : c;
        review.set({ files: loaded.files, branch: loaded.branch, base: loaded.base, commit: loaded.commit, notRepo: Boolean(loaded.notRepo), error: null, compare, loadedKey: compareKey(compare) });
        clearStaleViewed();
      } catch (error) {
        if (mine !== seq) return;
        review.set({ error: error.message });
      } finally {
        if (mine === seq) {
          review.set({ loading: false });
          review.diff?.renderFiles();
        }
      }
    },

    setCompare(compare) {
      review.diff?.commitDraft();
      review.set({ compare, files: [], base: null, commit: null });
      syncUrl();
      review.diff?.resetFiles();
      void review.refresh();
      review.diff?.renderFiles();
    },

    setSelected(path) {
      review.set({ selected: path });
      syncUrl();
    },

    setFilter(filter) {
      review.set({ filter });
      review.diff?.renderFiles();
    },

    setDirCollapsed(dir, isCollapsed) {
      const collapsedDirs = new Set(state.collapsedDirs);
      if (isCollapsed) collapsedDirs.add(dir);
      else collapsedDirs.delete(dir);
      review.set({ collapsedDirs });
    },

    setPins(pins) {
      review.set({ pins });
      review.send({ type: "pins", pins });
      review.diff?.renderHeaders();
      review.diff?.rerenderBodies();
    },

    setViewed(path, viewed) {
      const next = { ...state.viewed };
      if (viewed) next[viewedKey(state, path)] = signature(state.files.find((f) => f.path === path));
      else delete next[viewedKey(state, path)];
      review.set({ viewed: next });
      review.send({ type: "viewed", viewed: next });
    },

    // MARK: preferences

    toggleSidebar() {
      review.set({ sidebarHidden: !state.sidebarHidden });
      savePrefs();
    },

    setSidebarWidth(sidebarWidth) {
      review.set({ sidebarWidth });
      savePrefs();
    },

    setTree(tree) {
      review.set({ tree });
      savePrefs();
      review.diff?.renderFiles();
    },

    setHideUnchanged(hideUnchanged) {
      review.set({ hideUnchanged });
      savePrefs();
      review.diff?.renderFiles();
    },

    setWrap(wrap) {
      review.set({ wrap });
      savePrefs();
    },

    setSyntaxColors(syntaxColors) {
      review.set({ syntaxColors });
      savePrefs();
    },

    setIgnoreWhitespace(ignoreWhitespace) {
      review.set({ ignoreWhitespace });
      savePrefs();
      void review.refresh();
    },

    setFontSize(fontSize) {
      review.set({ fontSize });
      savePrefs();
      review.diff?.syncFontSize();
    },

    setOpenIn(openIn) {
      review.set({ openIn });
      savePrefs();
    },

    setLayout(layout) {
      review.set({ layout });
      savePrefs();
    },
  };

  return review;
}
