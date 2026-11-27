import { Button, Spinner } from "@primer/react";
import { ArrowRightIcon, CommentIcon, CopyIcon } from "@primer/octicons-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { DiffSlots } from "./Cards.jsx";
import { useReview, useStore } from "./context.jsx";
import { createDiff } from "./diff.js";
import { filteredFiles, noMatch } from "./model.js";

export function DiffView() {
  const review = useReview();
  const wrap = useStore((s) => s.wrap);
  const scroller = useRef(null);
  const files = useRef(null);
  const selToolbar = useRef(null);

  useLayoutEffect(() => {
    const diff = createDiff(review, { scroller: scroller.current, files: files.current, selToolbar: selToolbar.current });
    review.diff = diff;
    return () => {
      review.diff = null;
      diff.dispose();
    };
  }, [review]);

  useEffect(() => {
    review.diff?.updateSelectionUi();
  }, [review, wrap]);

  return (
    <div className={wrap ? "scroller wrap" : "scroller"} tabIndex={-1} ref={scroller}>
      <DiffEmpty />
      <div className="files" ref={files} />
      <SelectionToolbar ref={selToolbar} />
      <DiffSlots />
    </div>
  );
}

function SelectionToolbar({ ref }) {
  const review = useReview();
  return (
    <div className="sel-toolbar" hidden ref={ref}>
      <Button size="small" variant="invisible" leadingVisual={CommentIcon} title="Comment (c)" onClick={() => review.diff.openComposer()}>
        Comment
      </Button>
      <Button size="small" variant="invisible" leadingVisual={ArrowRightIcon} title="Insert the reference into the omp prompt" onClick={() => review.diff.pasteSelection()}>
        Add to prompt
      </Button>
      <Button size="small" variant="invisible" leadingVisual={CopyIcon} aria-label="Copy reference (⌘C)" title="Copy reference (⌘C)" onClick={() => review.diff.copySelection()} />
    </div>
  );
}

function DiffEmpty() {
  const review = useReview();
  const error = useStore((s) => s.error);
  const loading = useStore((s) => s.loading);
  const notRepo = useStore((s) => s.notRepo);
  const files = useStore((s) => s.files);
  const filter = useStore((s) => s.filter);
  const visible = useStore((s) => (s.error ? 0 : filteredFiles(s).length));
  if (visible) return null;

  let body;
  if (error) {
    body = (
      <>
        <strong>Couldn’t load the diff</strong>
        <pre>{error}</pre>
      </>
    );
  } else if (loading) {
    body = (
      <>
        <Spinner size="small" />
        <span>Loading…</span>
      </>
    );
  } else if (notRepo) {
    body = (
      <>
        <strong>Not a git repository</strong>
        <span>Initialize one to review every file here and track changes as your agent edits.</span>
        <Button size="small" variant="primary" onClick={() => review.send({ type: "init" })}>
          Initialize git repository
        </Button>
      </>
    );
  } else if (files.length) {
    body = <span>{noMatch(filter)}</span>;
  } else {
    body = (
      <>
        <strong>Nothing to review</strong>
        <span>Changes appear here as your agent edits files.</span>
      </>
    );
  }
  return <div className="empty-state">{body}</div>;
}
