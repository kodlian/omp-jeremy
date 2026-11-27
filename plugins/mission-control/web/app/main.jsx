import { useDeferredValue, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActionList, ActionMenu, BaseStyles, Button, IconButton, IssueLabelToken, SegmentedControl, Spinner, TextInput, ThemeProvider } from "@primer/react";
import {
  EyeClosedIcon, EyeIcon, GitBranchIcon, PlayIcon, PlusIcon, ProjectIcon, PulseIcon, RepoIcon, RocketIcon,
  SearchIcon, SyncIcon, TagIcon, TrashIcon, WorkflowIcon,
} from "@primer/octicons-react";
import { BoardProvider, LS, useBoard, useScheme, useStored } from "./store.jsx";
import { ToastProvider } from "omp-web-design-system/toasts";
import { matchesFilter, plural } from "./model.js";
import { tagColor } from "./parts.jsx";
import { Board } from "./Board.jsx";
import { Graph } from "./Graph.jsx";
import { Live } from "./Live.jsx";
import { Panel } from "./Panel.jsx";
import { ScriptsDialog, TagRulesDialog } from "./Dialogs.jsx";
import "omp-web-design-system/primer-theme.css";
import "./app.css";

const VIEWS = [
  { id: "board", label: "Board", icon: ProjectIcon, description: "Board: every worktree by where it stands" },
  { id: "pipeline", label: "Graph", icon: WorkflowIcon, description: "Graph: which branch each worktree comes from" },
  { id: "live", label: "Live", icon: PulseIcon, description: "Live: what every omp is doing and what waits for you" },
];
const decodeView = v => VIEWS.some(x => x.id === v) ? v : "board";
const asIs = v => v;
const decodeList = v => { try { const list = JSON.parse(v); return Array.isArray(list) ? list : []; } catch { return []; } };
const decodeFlag = v => v === "1";
const encodeFlag = v => v ? "1" : "0";
const scriptName = path => path ? path.split("/").pop() : "None";
const typingIn = target => target.closest?.("input, textarea, select, [contenteditable]");

function App() {
  const { board, view, openKey, setOpenKey, actions } = useBoard();
  const project = view.project, scope = project?.id || "";
  const [mode, setMode] = useStored("boardView", decodeView, asIs);
  const [chosenTags, setChosenTags] = useStored(`tags.${scope}`, decodeList, JSON.stringify);
  const [showHidden, setShowHidden] = useStored(`showHidden.${scope}`, decodeFlag, encodeFlag);
  const [filter, setFilter] = useState("");
  const query = useDeferredValue(filter.trim().toLowerCase());
  const search = useRef(null);

  // Tags no worktree carries anymore stop filtering.
  const tags = chosenTags.filter(t => project?.tags.includes(t));
  const hiddenCount = view.worktrees.filter(view.isHidden).length;
  const trees = view.worktrees.filter(w => (showHidden || !view.isHidden(w)) && (!tags.length || w.tags.some(t => tags.includes(t))) && matchesFilter(w, query));
  const filtered = !!query || tags.length > 0;

  useEffect(() => {
    const onKey = e => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("[role=dialog]")) return;
      const typing = typingIn(e.target);
      if (e.key === "Escape" && typing) e.target.blur();
      else if (e.key === "Escape" && openKey) setOpenKey(null);
      else if (typing) return;
      else if (e.key === "/") search.current?.focus();
      else if (e.key === "n" || e.key === "N") actions.newWorktree();
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // A click on empty space in a view closes the panel; Graph tells its own clicks from drags.
  const closeOnEmpty = e => {
    if (!openKey || !e.currentTarget.contains(e.target) || !getSelection().isCollapsed) return;
    if (!e.target.closest("[data-key], .panel, .resizer, .graph, a, button, input, textarea, label, [role=button], [role=separator]")) setOpenKey(null);
  };

  const content = !board ? <Spinner className="loading" srText="Reading checkouts" />
    : mode === "pipeline" ? <Graph key={scope} trees={trees} filtered={filtered} />
    : mode === "live" ? <Live trees={trees} total={view.worktrees.length} />
    : <Board trees={trees} filtered={filtered} />;
  return (
    <>
      <header className="toolbar">
        <SegmentedControl aria-label="View" onChange={i => setMode(VIEWS[i].id)}>
          {VIEWS.map(v => <SegmentedControl.IconButton key={v.id} icon={v.icon} aria-label={v.label} description={v.description} selected={mode === v.id} />)}
        </SegmentedControl>
        <span className="brand"><RocketIcon size={16} />Mission Control</span>
        <ProjectMenu />
        <ConnectionDot />
        <span className="spacer" />
        <TextInput ref={search} className="search" leadingVisual={SearchIcon} trailingVisual={filter ? undefined : <kbd>/</kbd>}
          placeholder="Filter worktrees…" aria-label="Filter worktrees" autoComplete="off" spellCheck={false} value={filter}
          onChange={e => setFilter(e.target.value)} onKeyDown={e => { if (e.key === "Escape" && filter) { e.preventDefault(); setFilter(""); } }} />
        <IconButton icon={SyncIcon} aria-label="Refresh" description="Refresh omp sessions, git and pull requests" variant="invisible" onClick={actions.refresh} />
        <Button variant="primary" leadingVisual={PlusIcon} onClick={() => actions.newWorktree()}>New worktree</Button>
      </header>
      {project && (project.tags.length || hiddenCount) ? (
        <nav className="tagbar" aria-label="Filter by tag">
          {project.tags.map(t => {
            const on = tags.includes(t);
            return (
              <IssueLabelToken key={t} as="button" text={t} fillColor={tagColor(t)} className="tag-toggle" isSelected={on} aria-pressed={on}
                title={on ? `Stop filtering by ${t}` : `Show only worktrees tagged ${t}`}
                onClick={() => setChosenTags(on ? tags.filter(x => x !== t) : [...tags, t])} />
            );
          })}
          <span className="spacer" />
          {hiddenCount ? (
            <Button size="small" variant="invisible" leadingVisual={showHidden ? EyeIcon : EyeClosedIcon} aria-pressed={showHidden}
              title={showHidden ? "Leave hidden worktrees out again" : "Show the worktrees hidden from the board"}
              onClick={() => setShowHidden(!showHidden)}>{hiddenCount} hidden</Button>
          ) : null}
        </nav>
      ) : null}
      <div className="main" onClick={closeOnEmpty}>
        {content}
        {openKey ? <><PanelResizer /><Panel key={openKey} /></> : null}
      </div>
    </>
  );
}

function ProjectMenu() {
  const { board, view, actions } = useBoard();
  const [dialog, setDialog] = useState(null);
  const project = view.project, close = () => setDialog(null);
  return (
    <>
      <ActionMenu>
        <ActionMenu.Button variant="invisible" leadingVisual={RepoIcon} className="project"
          title={project ? `${project.repo}: new worktrees start from ${project.defaultBranch}` : undefined}>
          {project
            ? <><strong>{project.name}</strong><span className="project-branch"><GitBranchIcon size={14} /><span className="mono">{project.defaultBranch}</span></span></>
            : board ? "Project unavailable" : "Loading…"}
        </ActionMenu.Button>
        <ActionMenu.Overlay width="medium">
          <ActionList>
            {project ? (
              <ActionList.Group>
                <ActionList.GroupHeading>Project settings</ActionList.GroupHeading>
                <ActionList.Item onSelect={() => setDialog("tags")}>
                  <ActionList.LeadingVisual><TagIcon /></ActionList.LeadingVisual>Tag rules
                  <ActionList.Description>{project.tagRules.length ? plural(project.tagRules.length, "rule") : "None"}</ActionList.Description>
                </ActionList.Item>
                <ActionList.Item onSelect={() => setDialog("scripts")}>
                  <ActionList.LeadingVisual><PlayIcon /></ActionList.LeadingVisual>Setup script
                  <ActionList.Description>{scriptName(project.setupScript)}</ActionList.Description>
                </ActionList.Item>
                <ActionList.Item onSelect={() => setDialog("scripts")}>
                  <ActionList.LeadingVisual><TrashIcon /></ActionList.LeadingVisual>Teardown script
                  <ActionList.Description>{scriptName(project.teardownScript)}</ActionList.Description>
                </ActionList.Item>
              </ActionList.Group>
            ) : <ActionList.Item disabled>Project unavailable: run /mission in its checkout</ActionList.Item>}
            <ActionList.Divider />
            <ActionList.Item onSelect={actions.restart}>
              <ActionList.LeadingVisual><RocketIcon /></ActionList.LeadingVisual>Restart Mission Control
              <ActionList.Description variant="block">Runs its latest code and reads every checkout again</ActionList.Description>
            </ActionList.Item>
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
      {dialog === "tags" ? <TagRulesDialog onClose={close} /> : dialog === "scripts" ? <ScriptsDialog onClose={close} /> : null}
    </>
  );
}

function ConnectionDot() {
  const { connected } = useBoard();
  const label = connected ? "Connected" : "Disconnected";
  return <span className="conn" data-on={connected || undefined} role="status" aria-label={label} title={label} />;
}

// MARK: panel width
const setPanelWidth = width => document.documentElement.style.setProperty("--panel-w", `${width}px`);
const clampWidth = width => Math.round(Math.min(Math.max(width, 200), innerWidth * (innerWidth <= 900 ? 0.6 : 0.72)));
const savedWidth = parseInt(LS.get("panelWidth"), 10);
if (savedWidth) setPanelWidth(savedWidth);

// Drags or arrow keys resize the panel; the width is kept for next time. The CSS variable moves while dragging, without re-rendering.
function PanelResizer() {
  const [dragging, setDragging] = useState(false);
  const commit = width => { setPanelWidth(width); LS.set("panelWidth", String(width)); };
  return (
    <div className="resizer" role="separator" aria-orientation="vertical" aria-label="Resize the details panel" tabIndex={0} data-dragging={dragging || undefined}
      onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); }}
      onPointerMove={e => { if (dragging) setPanelWidth(clampWidth(innerWidth - e.clientX)); }}
      onPointerUp={e => { if (dragging) { setDragging(false); commit(clampWidth(innerWidth - e.clientX)); } }}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={e => {
        const step = e.key === "ArrowLeft" ? 16 : e.key === "ArrowRight" ? -16 : 0;
        if (step) { e.preventDefault(); commit(clampWidth((document.querySelector(".panel")?.offsetWidth || 460) + step)); }
      }} />
  );
}

function Root() {
  return (
    <ThemeProvider colorMode={useScheme()}>
      <BaseStyles className="app">
        <ToastProvider>
          <BoardProvider>
            <App />
          </BoardProvider>
        </ToastProvider>
      </BaseStyles>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")).render(<Root />);
