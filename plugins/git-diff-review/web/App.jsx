import { useEffect, useRef } from "react";
import { useReview, useStore } from "./context.jsx";
import { DiffView } from "./DiffView.jsx";
import { OpenInMenu } from "./Menus.jsx";
import { installShortcuts } from "./shortcuts.js";
import { Sidebar } from "./Sidebar.jsx";
import { CompareBar, ConnectionBanner, Toolbar } from "./Toolbar.jsx";

export function App() {
  const review = useReview();
  const sidebarHidden = useStore((s) => s.sidebarHidden);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const syntaxColors = useStore((s) => s.syntaxColors);
  const notRepo = useStore((s) => s.notRepo);

  useEffect(() => installShortcuts(review), [review]);

  const classes = ["review", sidebarHidden ? "sidebar-hidden" : "", syntaxColors ? "" : "default-syntax", notRepo ? "no-repo" : ""].join(" ");
  return (
    <div className={classes} style={{ "--sidebar-w": `${sidebarWidth}px` }}>
      <section className="main">
        <ConnectionBanner />
        <CompareBar />
        <Toolbar />
        <DiffView />
      </section>
      <Resizer />
      <Sidebar />
      <OpenInMenu />
    </div>
  );
}

function Resizer() {
  const review = useReview();
  const drag = useRef(null);

  function onPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { startX: e.clientX, startWidth: document.getElementById("file-sidebar").getBoundingClientRect().width, width: null };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.dataset.dragging = "";
  }

  function onPointerMove(e) {
    const d = drag.current;
    if (!d) return;
    d.width = Math.max(200, Math.min(window.innerWidth * 0.6, d.startWidth + d.startX - e.clientX));
    e.currentTarget.parentElement.style.setProperty("--sidebar-w", `${d.width}px`);
  }

  function onLostPointerCapture(e) {
    const d = drag.current;
    drag.current = null;
    delete e.currentTarget.dataset.dragging;
    if (d?.width != null) review.setSidebarWidth(d.width);
  }

  return (
    <div
      className="resizer"
      role="separator"
      aria-label="Resize file list"
      aria-orientation="vertical"
      title="Drag to resize file list"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onLostPointerCapture={onLostPointerCapture}
    />
  );
}
