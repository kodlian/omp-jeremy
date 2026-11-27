import { Banner, IconButton, SegmentedControl, TextInput } from "@primer/react";
import { ChevronDownIcon, ChevronUpIcon, ColumnsIcon, DiffIcon, GitBranchIcon, GitCommitIcon, RowsIcon, SearchIcon, SidebarExpandIcon, SyncIcon, XIcon } from "@primer/octicons-react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useReview, useStore } from "./context.jsx";
import { compareKey, reviewFiles } from "./model.js";
import { ReviewActions, ViewMenu } from "./Menus.jsx";
import { BasePicker, CommitPicker } from "./Pickers.jsx";

const MODES = [
  { kind: "uncommitted", label: "Working tree", icon: DiffIcon },
  { kind: "branch", label: "Branch comparison", icon: GitBranchIcon },
  { kind: "commit", label: "Single commit", icon: GitCommitIcon },
];

export function ConnectionBanner() {
  const connected = useStore((s) => s.connected);
  const stale = useStore((s) => s.stale);
  if (connected && !stale) return null;
  return (
    <Banner
      className="banner"
      variant={connected ? "warning" : "critical"}
      hideTitle
      title={connected ? "Older review plugin" : "Disconnected"}
      description={connected ? "This omp session is running an older review plugin. Restart omp, then run /review to load the current version." : "Disconnected from omp. Comments can't be sent; run /review again if the session ended."}
    />
  );
}

export function CompareBar() {
  const review = useReview();
  const kind = useStore((s) => s.compare.kind);
  const root = useStore((s) => s.root);
  const session = useStore((s) => s.session);
  return (
    <header className="review-context" title={session ? `${root}\nSession: ${session}` : (root ?? undefined)}>
      <SegmentedControl
        className="comparison-mode"
        aria-label="Comparison mode"
        size="small"
        onChange={(i) => {
          const next = MODES[i].kind;
          if (next !== kind) review.setCompare(next === "branch" ? { kind: next, base: null } : next === "commit" ? { kind: next, sha: null } : { kind: next });
        }}
      >
        {MODES.map((m) => (
          <SegmentedControl.IconButton key={m.kind} aria-label={m.label} icon={m.icon} selected={m.kind === kind} />
        ))}
      </SegmentedControl>
      <CompareContext />
    </header>
  );
}

function CompareContext() {
  const review = useReview();
  const kind = useStore((s) => s.compare.kind);
  const branch = useStore((s) => s.branch);
  const fresh = useStore((s) => s.loadedKey === compareKey(s.compare));
  const name = (
    <span className="ctx-branch">
      <GitBranchIcon size={14} />
      <span>{branch ?? (fresh ? "detached HEAD" : "")}</span>
    </span>
  );
  return (
    <div className="compare-context">
      {kind === "commit" ? (
        <CommitPicker />
      ) : (
        <>
          {name}
          {kind === "branch" ? (
            <>
              <span className="muted">→</span>
              <BasePicker />
            </>
          ) : (
            <span className="muted">→ HEAD</span>
          )}
        </>
      )}
      <span className="spacer" />
      <IconButton icon={SyncIcon} variant="invisible" size="small" aria-label="Refresh (r)" onClick={() => review.refresh()} />
    </div>
  );
}

function Totals() {
  const files = useStore((s) => s.files);
  const hideUnchanged = useStore((s) => s.hideUnchanged);
  const compare = useStore((s) => s.compare);
  const viewed = useStore((s) => s.viewed);
  const shown = useMemo(() => reviewFiles(files, hideUnchanged), [files, hideUnchanged]);
  if (!shown.length) return <span className="totals stats" />;
  const adds = shown.reduce((n, f) => n + (f.additions ?? 0), 0);
  const dels = shown.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const key = compareKey(compare);
  const done = shown.filter((f) => viewed[`${key}|${f.path}`]).length;
  return (
    <span className="totals stats">
      <span className="muted">
        {done}/{shown.length} viewed
      </span>
      {adds ? <span className="add"> +{adds}</span> : null}
      {dels ? <span className="remove"> −{dels}</span> : null}
    </span>
  );
}

export function Toolbar() {
  const review = useReview();
  const layout = useStore((s) => s.layout);
  const sidebarHidden = useStore((s) => s.sidebarHidden);
  const findOpen = useStore((s) => s.find.open);
  const diff = () => review.diff;
  return (
    <header className="toolbar">
      <Totals />
      <ReviewActions />
      <span className="spacer" />
      {findOpen ? <FindBar /> : <IconButton icon={SearchIcon} variant="invisible" size="small" aria-label="Find in diff (⌘F)" onClick={() => diff()?.openFind()} />}
      <IconButton icon={ChevronUpIcon} variant="invisible" size="small" aria-label="Previous change ([)" onClick={() => diff()?.jumpChange(-1)} />
      <IconButton icon={ChevronDownIcon} variant="invisible" size="small" aria-label="Next change (])" onClick={() => diff()?.jumpChange(1)} />
      <span className="toolbar-divider" />
      <IconButton
        icon={layout === "split" ? RowsIcon : ColumnsIcon}
        variant="invisible"
        size="small"
        aria-label={layout === "split" ? "Unified view" : "Side by side"}
        onClick={() => diff()?.setLayout(layout === "split" ? "unified" : "split")}
      />
      <ViewMenu />
      <IconButton
        className="sidebar-toggle"
        icon={SidebarExpandIcon}
        variant="invisible"
        size="small"
        aria-label="Toggle file list (b or ⌘\)"
        aria-controls="file-sidebar"
        aria-expanded={!sidebarHidden}
        onClick={() => review.toggleSidebar()}
      />
    </header>
  );
}

function FindBar() {
  const review = useReview();
  const { query, total, current, focus } = useStore((s) => s.find);
  const input = useRef(null);

  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focus]);

  const diff = review.diff;
  const noResults = query && total === 0;
  return (
    <div className={noResults ? "findbar no-results" : "findbar"}>
      <TextInput
        ref={input}
        className="find-input"
        leadingVisual={SearchIcon}
        size="small"
        placeholder="Find in diff"
        aria-label="Find in diff"
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => diff.setFindQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            diff.stepFind(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            diff.closeFind();
          }
        }}
      />
      <span className="find-count">{!query ? "" : total ? `${current + 1}/${total}` : "No results"}</span>
      <IconButton icon={ChevronUpIcon} variant="invisible" size="small" aria-label="Previous match (⇧↩)" onClick={() => diff.stepFind(-1)} />
      <IconButton icon={ChevronDownIcon} variant="invisible" size="small" aria-label="Next match (↩)" onClick={() => diff.stepFind(1)} />
      <IconButton icon={XIcon} variant="invisible" size="small" aria-label="Close (Esc)" onClick={() => diff.closeFind()} />
    </div>
  );
}
