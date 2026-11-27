import { ActionList, ActionMenu, Button, ButtonGroup, IconButton } from "@primer/react";
import { GearIcon, PaperAirplaneIcon, TriangleDownIcon } from "@primer/octicons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { reviewMessage } from "../src/shared/reference.js";
import { useReview, useStore } from "./context.jsx";
import { copyText } from "./dom.js";
import { api } from "./review.js";

const FONT_SIZES = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

export function ViewMenu() {
  const review = useReview();
  const [panel, setPanel] = useState(null);
  const anchor = useRef(null);
  const wrap = useStore((s) => s.wrap);
  const ignoreWhitespace = useStore((s) => s.ignoreWhitespace);
  const hideUnchanged = useStore((s) => s.hideUnchanged);
  const syntaxColors = useStore((s) => s.syntaxColors);
  const fontSize = useStore((s) => s.fontSize);

  // Picking "Text size" closes this menu and opens the size menu in the same gesture.
  const track = (name) => (open) => setPanel((p) => (open ? name : p === name ? null : p));
  const terminal = panel === "size" ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-size")) : 0;

  return (
    <>
      <ActionMenu open={panel === "options"} onOpenChange={track("options")} anchorRef={anchor}>
        <ActionMenu.Anchor>
          <IconButton ref={anchor} icon={GearIcon} variant="invisible" size="small" aria-label="View options" />
        </ActionMenu.Anchor>
        <ActionMenu.Overlay width="medium">
          <ActionList selectionVariant="multiple">
            <ActionList.Item selected={wrap} onSelect={() => review.setWrap(!wrap)}>
              Wrap long lines
            </ActionList.Item>
            <ActionList.Item selected={ignoreWhitespace} onSelect={() => review.setIgnoreWhitespace(!ignoreWhitespace)}>
              Ignore whitespace
            </ActionList.Item>
            <ActionList.Item selected={hideUnchanged} onSelect={() => review.setHideUnchanged(!hideUnchanged)}>
              Hide renamed and unchanged files
            </ActionList.Item>
            <ActionList.Item selected={syntaxColors} onSelect={() => review.setSyntaxColors(!syntaxColors)}>
              Use omp syntax colors
            </ActionList.Item>
          </ActionList>
          <ActionList>
            <ActionList.Divider />
            <ActionList.Item onSelect={() => setPanel("size")}>
              Text size
            </ActionList.Item>
            <ActionList.Item onSelect={() => review.diff?.stepFile(-1)}>
              Previous file
              <ActionList.TrailingVisual>k</ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Item onSelect={() => review.diff?.stepFile(1)}>
              Next file
              <ActionList.TrailingVisual>j</ActionList.TrailingVisual>
            </ActionList.Item>
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
      <ActionMenu open={panel === "size"} onOpenChange={track("size")} anchorRef={anchor}>
        <ActionMenu.Overlay width="small">
          <ActionList selectionVariant="single">
            <ActionList.Item selected={fontSize == null} onSelect={() => review.setFontSize(null)}>
              {terminal ? "Terminal" : "Default"}
              {terminal ? <ActionList.TrailingVisual>{terminal}</ActionList.TrailingVisual> : null}
            </ActionList.Item>
            {FONT_SIZES.map((size) => (
              <ActionList.Item key={size} selected={fontSize === size} onSelect={() => review.setFontSize(size)}>
                {size}
              </ActionList.Item>
            ))}
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
    </>
  );
}

export function OpenInMenu() {
  const review = useReview();
  const menu = useStore((s) => s.openInMenu);
  const openIn = useStore((s) => s.openIn);
  const [targets, setTargets] = useState(null);
  const anchorRef = useMemo(() => ({ current: menu?.anchor ?? null }), [menu]);

  useEffect(() => {
    if (!menu) return;
    let live = true;
    api("/api/open-targets").then(
      (list) => live && setTargets(list),
      (error) => {
        review.toast(`Couldn't list editors: ${error.message}`, true);
        review.set({ openInMenu: null });
      },
    );
    return () => {
      live = false;
      setTargets(null);
    };
  }, [menu, review]);

  const ordered = targets && [...targets.filter((t) => t.id === openIn), ...targets.filter((t) => t.id !== openIn)];

  function pick(id) {
    review.setOpenIn(id);
    api("/api/open", { path: menu.path, target: id, line: String(menu.line ?? "") }).catch((error) => review.toast(`Open failed: ${error.message}`, true));
  }

  return (
    <ActionMenu open={Boolean(menu)} onOpenChange={(open) => !open && review.set({ openInMenu: null })} anchorRef={anchorRef}>
      <ActionMenu.Overlay width="small" align="end">
        <ActionList>
          {ordered ? (
            ordered.map((t) => (
              <ActionList.Item key={t.id} onSelect={() => pick(t.id)}>
                {t.label}
              </ActionList.Item>
            ))
          ) : (
            <ActionList.Item disabled>Loading…</ActionList.Item>
          )}
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  );
}

export function ReviewActions() {
  const review = useReview();
  const pinCount = useStore((s) => s.pins.length);
  const draft = useStore((s) => Boolean(s.composer && !s.composer.editing && s.composer.note.trim()));
  const session = useStore((s) => s.session);
  const count = pinCount + (draft ? 1 : 0);
  if (!count) return null;

  async function copyReview() {
    const ok = await copyText(reviewMessage(review.state.pins));
    review.toast(ok ? "Review copied" : "Copy failed", !ok);
  }

  return (
    <ButtonGroup className="review-actions">
      <Button size="small" variant="primary" leadingVisual={PaperAirplaneIcon} title={`Send review to ${session ?? "omp"}`} onClick={() => review.diff.sendReview()}>
        Send review ({count})
      </Button>
      <ActionMenu onOpenChange={(open) => open && review.diff?.commitDraft()}>
        <ActionMenu.Anchor>
          <IconButton icon={TriangleDownIcon} variant="primary" size="small" aria-label="Review actions" />
        </ActionMenu.Anchor>
        <ActionMenu.Overlay width="medium" align="end">
          <ActionList>
            <ActionList.Item
              onSelect={() => {
                if (review.send({ type: "paste", text: reviewMessage(review.state.pins) })) review.toast("Review added to the omp prompt");
              }}
            >
              Add review to prompt
            </ActionList.Item>
            <ActionList.Item onSelect={copyReview}>Copy review</ActionList.Item>
            <ActionList.Divider />
            <ActionList.Item variant="danger" onSelect={() => review.setPins([])}>
              Clear all comments
            </ActionList.Item>
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
    </ButtonGroup>
  );
}
