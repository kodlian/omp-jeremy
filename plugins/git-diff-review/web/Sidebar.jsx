import { Button, TextInput } from "@primer/react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CommentIcon, FileDirectoryFillIcon, FileDirectoryIcon, FileDirectoryOpenFillIcon, SearchIcon } from "@primer/octicons-react";
import { memo, useEffect, useMemo, useRef } from "react";
import { useReview, useStore } from "./context.jsx";
import { splitPath } from "./dom.js";
import { filterFiles, noMatch, orderedFiles, reviewFiles, side, treeEntries, viewedKey } from "./model.js";

export function Sidebar() {
  const loading = useStore((s) => s.loading);
  return (
    <aside className="sidebar" id="file-sidebar" aria-label="Changed files">
      <div className="top">
        <FileFilter />
      </div>
      <div className={loading ? "progress active" : "progress"} />
      <FileList />
    </aside>
  );
}

function FileFilter() {
  const review = useReview();
  const filter = useStore((s) => s.filter);
  const tree = useStore((s) => s.tree);
  return (
    <TextInput
      id="file-filter"
      className="search"
      block
      size="small"
      leadingVisual={SearchIcon}
      placeholder="Filter files"
      aria-label="Filter files"
      autoComplete="off"
      spellCheck={false}
      value={filter}
      onChange={(e) => review.setFilter(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && filter) {
          e.preventDefault();
          e.stopPropagation();
          review.setFilter("");
        } else if (e.key === "Enter" || e.key === "ArrowDown") {
          const first = orderedFiles(review.state)[0];
          if (first) {
            e.preventDefault();
            review.diff?.select(first.path, { focusList: true });
          }
        }
      }}
      trailingAction={<TextInput.Action icon={FileDirectoryIcon} aria-label="Group by folder" aria-pressed={tree} className={tree ? "toggle on" : "toggle"} onClick={() => review.setTree(!tree)} />}
    />
  );
}

const EMPTY = { uncommitted: "No uncommitted changes", branch: "No changes on this branch", commit: "This commit has no file changes" };

function FileList() {
  const review = useReview();
  const files = useStore((s) => s.files);
  const error = useStore((s) => s.error);
  const loading = useStore((s) => s.loading);
  const notRepo = useStore((s) => s.notRepo);
  const filter = useStore((s) => s.filter);
  const compareKind = useStore((s) => s.compare.kind);
  const tree = useStore((s) => s.tree);
  const hideUnchanged = useStore((s) => s.hideUnchanged);
  const collapsedDirs = useStore((s) => s.collapsedDirs);
  const selected = useStore((s) => s.selected);
  const pins = useStore((s) => s.pins);
  const viewed = useStore((s) => s.viewed);
  const pinSide = useStore(side);
  const keyPrefix = useStore((s) => viewedKey(s, ""));
  const list = useRef(null);

  const reviewable = useMemo(() => reviewFiles(files, hideUnchanged), [files, hideUnchanged]);
  const hidden = files.length - reviewable.length;
  const shown = useMemo(() => filterFiles(reviewable, filter), [reviewable, filter]);
  const entries = useMemo(() => {
    const all = tree ? treeEntries(shown) : shown.map((file) => ({ file, depth: 0 }));
    return all.filter((e) => ![...collapsedDirs].some((d) => (e.dir ?? e.file.path).startsWith(`${d}/`)));
  }, [shown, tree, collapsedDirs]);
  const comments = useMemo(() => {
    const counts = new Map();
    for (const p of pins) if (p.side === pinSide) counts.set(p.path, (counts.get(p.path) ?? 0) + 1);
    return counts;
  }, [pins, pinSide]);

  useEffect(() => {
    if (selected) list.current?.querySelector(`[data-path="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function onKeyDown(e) {
    const rows = [...list.current.querySelectorAll(".nav")];
    const row = e.target.closest(".nav");
    const idx = rows.indexOf(row);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next?.dataset.path) review.diff?.select(next.dataset.path, { focusList: true });
      else next?.focus();
    } else if (row?.dataset.dir && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      review.setDirCollapsed(row.dataset.dir, e.key === "ArrowLeft");
    } else if (row?.dataset.dir && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      review.setDirCollapsed(row.dataset.dir, !collapsedDirs.has(row.dataset.dir));
    } else if ((e.key === "Enter" || e.key === " ") && row?.dataset.path) {
      e.preventDefault();
      review.diff?.select(row.dataset.path, { focusList: true });
    }
  }

  let message = null;
  if (error) {
    message = (
      <div className="empty-state">
        <strong>Couldn’t read changes</strong>
        <pre>{error}</pre>
        <Button size="small" onClick={() => review.refresh()}>
          Try again
        </Button>
      </div>
    );
  } else if (!files.length) {
    if (!loading && !notRepo) {
      message = (
        <div className="empty-state">
          <strong>{EMPTY[compareKind]}</strong>
          <span>Edits show up here as your agent makes them.</span>
        </div>
      );
    }
  } else if (!shown.length) {
    message = (
      <div className="empty-state">
        <span>{noMatch(filter)}</span>
      </div>
    );
  }

  return (
    <div className="list" role="tree" aria-label="Changed files" tabIndex={0} ref={list} onKeyDown={onKeyDown}>
      {message}
      {entries.map((e) =>
        e.dir ? (
          <DirRow key={`dir:${e.dir}`} dir={e.dir} name={e.name} depth={e.depth} collapsed={collapsedDirs.has(e.dir)} />
        ) : (
          <FileRow
            key={e.file.path}
            file={e.file}
            tree={tree}
            depth={e.depth}
            selected={e.file.path === selected}
            viewed={Boolean(viewed[`${keyPrefix}${e.file.path}`])}
            comments={comments.get(e.file.path) ?? 0}
          />
        ),
      )}
      {hidden > 0 && !error ? (
        <div className="hidden-note">
          <span>
            {hidden} renamed or unchanged file{hidden === 1 ? "" : "s"} hidden
          </span>
          <Button size="small" variant="invisible" onClick={() => review.setHideUnchanged(false)}>
            Show
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const DirRow = memo(function DirRow({ dir, name, depth, collapsed }) {
  const review = useReview();
  return (
    <div
      role="treeitem"
      aria-expanded={!collapsed}
      className="dir-row nav"
      tabIndex={-1}
      data-dir={dir}
      title={dir}
      style={{ paddingLeft: 4 + depth * 10 }}
      onClick={() => review.setDirCollapsed(dir, !collapsed)}
    >
      {collapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
      {collapsed ? <FileDirectoryFillIcon size={14} /> : <FileDirectoryOpenFillIcon size={14} />}
      <span className="dir-name">{name}</span>
    </div>
  );
});

const FileRow = memo(function FileRow({ file, tree, depth, selected, viewed, comments }) {
  const review = useReview();
  const { dir, name } = splitPath(file.path);
  const classes = ["file-row", "nav", viewed ? "viewed" : "", selected ? "selected" : ""].join(" ");
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      className={classes}
      tabIndex={-1}
      data-path={file.path}
      title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
      style={{ paddingLeft: tree ? 18 + depth * 10 : 8 }}
      onClick={() => review.diff?.select(file.path, { focusList: true })}
    >
      <span className={`status-letter status-${file.status}`}>{file.status === "?" ? "U" : file.status}</span>
      <span className="file-name">{name}</span>
      {!tree && dir ? <span className="file-dir">{dir}</span> : null}
      <span className="spacer" />
      {comments ? (
        <span className="row-badge" title={`${comments} comment${comments === 1 ? "" : "s"}`}>
          <CommentIcon size={12} />
          {comments}
        </span>
      ) : null}
      {viewed ? (
        <span className="row-viewed" title="Viewed">
          <CheckIcon size={12} />
        </span>
      ) : null}
      <span className="stats">
        {file.additions ? <span className="add">+{file.additions}</span> : null} {file.deletions ? <span className="remove">−{file.deletions}</span> : null}
      </span>
    </div>
  );
});
