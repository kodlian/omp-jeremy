import { Button, IconButton, Label, Textarea } from "@primer/react";
import { CommentIcon, PaperAirplaneIcon, PencilIcon, TrashIcon } from "@primer/octicons-react";
import { memo, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useReview, useStore } from "./context.jsx";
import { formatPin } from "../src/shared/reference.js";

// Threads and the composer render into the slots the diff body lays out between rows.
export function DiffSlots() {
  const slots = useStore((s) => s.slots);
  return slots.map(({ key, el, pinId, outdated }) => createPortal(key === "composer" ? <Composer /> : <Thread pinId={pinId} outdated={outdated} />, el, key));
}

const Thread = memo(function Thread({ pinId, outdated }) {
  const review = useReview();
  const pin = useStore((s) => s.pins.find((p) => p.id === pinId));
  if (!pin) return null;
  return (
    <>
      <div className="thread-head">
        <CommentIcon size={12} />
        <span className="thread-ref">{formatPin(pin)}</span>
        {outdated ? <Label size="small">outdated</Label> : null}
        <span className="spacer" />
        <IconButton icon={PencilIcon} size="small" variant="invisible" aria-label="Edit comment" onClick={() => review.diff.openComposer({ editing: pinId })} />
        <IconButton icon={TrashIcon} size="small" variant="invisible" aria-label="Delete comment" onClick={() => review.setPins(review.state.pins.filter((p) => p.id !== pinId))} />
      </div>
      <div className="thread-body">{pin.note || <span className="muted">No comment, reference only</span>}</div>
    </>
  );
});

function Composer() {
  const review = useReview();
  const composer = useStore((s) => s.composer);
  const area = useRef(null);
  const focus = composer?.focus;

  useLayoutEffect(() => {
    const el = area.current;
    if (!focus || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.closest(".composer")?.scrollIntoView({ block: "nearest" });
    review.set((s) => (s.composer ? { composer: { ...s.composer, focus: false } } : {}));
  }, [focus, review]);

  if (!composer) return null;
  const diff = review.diff;

  function onKeyDown(e) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      diff.discardDraft();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.altKey) diff.sendDraftNow();
      else diff.sendReview();
    }
  }

  return (
    <>
      <div className="thread-head">
        <CommentIcon size={12} />
        <span className="thread-ref">{composer.reference}</span>
      </div>
      <Textarea
        ref={area}
        block
        rows={3}
        resize="vertical"
        aria-label="Comment"
        placeholder="Leave a comment for the agent"
        value={composer.note}
        onChange={(e) => review.set((s) => ({ composer: { ...s.composer, note: e.target.value } }))}
        onKeyDown={onKeyDown}
      />
      <div className="composer-actions">
        <span className="hint">⌘↩ send review, ⌘⌥↩ send this now</span>
        <span className="spacer" />
        <Button size="small" onClick={() => diff.closeComposer()}>
          Cancel
        </Button>
        <Button size="small" variant="primary" leadingVisual={PaperAirplaneIcon} onClick={() => diff.sendReview()}>
          Send review
        </Button>
      </div>
    </>
  );
}
