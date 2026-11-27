import { flushSync } from "react-dom";
import { isTextField } from "./dom.js";
import { viewedKey } from "./model.js";

const OVERLAY = "[role=menu], [role=listbox], [role=dialog]";

// Page-wide keys: find, sidebar, file and change navigation, copying the selection reference.
export function installShortcuts(review) {
  const abort = new AbortController();
  const { signal } = abort;

  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const find = review.state.find;
      if (e.code === "Backslash" && !e.shiftKey) review.toggleSidebar();
      else if (key === "f" && !e.shiftKey) review.diff?.openFind();
      else if (key === "g" && find.query && find.open) review.diff?.stepFind(e.shiftKey ? -1 : 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true, signal },
  );

  document.addEventListener(
    "keydown",
    (e) => {
      const diff = review.diff;
      if (!diff || isTextField(e.target) || e.target.closest?.(OVERLAY) || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = review.state;
      if (e.key === "j" || e.key === "k") {
        diff.stepFile(e.key === "j" ? 1 : -1);
      } else if (e.key === "]" || e.key === "[") {
        diff.jumpChange(e.key === "]" ? 1 : -1);
      } else if (e.key === "n" || e.key === "N") {
        diff.stepPin(e.key === "n" ? 1 : -1);
      } else if (e.key === "b") {
        review.toggleSidebar();
      } else if (e.key === "u") {
        diff.select(diff.nextUnviewed(s.selected)?.path);
      } else if (e.key === "v" && s.selected && diff.hasFile(s.selected)) {
        diff.toggleViewed(s.selected, !s.viewed[viewedKey(s, s.selected)]);
      } else if (e.key === "c" && diff.hasSelection()) {
        diff.openComposer();
      } else if (e.key === "r") {
        review.refresh();
      } else if (e.key === "/") {
        if (s.sidebarHidden) flushSync(() => review.toggleSidebar());
        document.getElementById("file-filter")?.focus();
      } else if (e.key !== "Escape" || !diff.clearSelection()) {
        return;
      }
      // An unhandled key makes WebKit hosts such as cmux's browser pane play the system alert sound.
      e.preventDefault();
    },
    { signal },
  );

  document.addEventListener(
    "copy",
    (e) => {
      const diff = review.diff;
      if (!diff || isTextField(document.activeElement)) return;
      const ref = diff.selReference();
      if (!ref) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", ref);
      review.toast(`Copied ${ref}`);
    },
    { signal },
  );

  return () => abort.abort();
}
