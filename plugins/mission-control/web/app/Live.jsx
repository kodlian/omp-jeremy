import { useState } from "react";
import { Button, CounterLabel, SegmentedControl, Textarea } from "@primer/react";
import { GitBranchIcon, PulseIcon } from "@primer/octicons-react";
import { useBoard, useStored } from "./store.jsx";
import { isBusy, needsYou, worktreeName } from "./model.js";
import { WorktreeRow, WorktreeTile } from "./Card.jsx";

const byName = (a, b) => worktreeName(a).localeCompare(worktreeName(b));
const asleep = w => w.agent?.state === "asleep";
const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "needs", label: "Needs you", test: w => (w.agents || []).some(needsYou), none: "Nothing needs you" },
  { id: "working", label: "Working", test: w => (w.agents || []).some(isBusy), none: "No omp is at work" },
  { id: "waiting", label: "Waiting", test: w => w.column === "waiting", none: "Nothing waits" },
  { id: "uncommitted", label: "Uncommitted", test: w => w.column === "uncommitted", none: "No uncommitted work waits" },
  { id: "paused", label: "Paused", test: w => w.column === "paused", none: "Nothing is paused" },
  { id: "asleep", label: "Asleep", test: asleep, none: "No omp session sleeps" },
];
const decodeFilter = v => FILTERS.find(f => f.id === v) || FILTERS[0];
const encodeFilter = f => f.id;

// What every omp of the project is doing and what waits for you: a tile per running checkout, a line per quiet one.
export function Live({ trees, total }) {
  const { view, actions } = useBoard();
  const [filter, setFilter] = useStored("liveFilter", decodeFilter, encodeFilter);
  const shown = trees.filter(filter.test);
  const running = shown.filter(w => w.agents?.length).sort((a, b) => Number(b.main) - Number(a.main) || byName(a, b));
  // Sleeping sessions first, the most recent on top, then checkouts without one.
  const rest = shown.filter(w => !w.agents?.length)
    .sort((a, b) => Number(asleep(b)) - Number(asleep(a)) || (Date.parse(b.agent?.at || "") || 0) - (Date.parse(a.agent?.at || "") || 0) || byName(a, b));
  const empty = !view.project ? ["Project unavailable", "Run /mission in this project's checkout to see its omp sessions here."]
    : total && !trees.length ? ["No matching worktrees", "Nothing in this project matches the filter. Clear it to see every checkout."]
    : filter.none ? (shown.length ? null : [filter.none, "All shows every worktree."])
    : !running.length ? ["No omp is running in this project", rest.some(asleep) ? "Resume a sleeping session below, or start omp in a worktree." : "Start omp in a worktree to see it here."]
    : null;
  const onDoubleClick = e => { if (e.target === e.currentTarget || e.target.matches(".live-grid, .live-rows")) actions.newWorktree(); };
  return (
    <div className="live" onDoubleClick={onDoubleClick}>
      {view.project ? <Composer /> : null}
      <SegmentedControl aria-label="Show" size="small" className="live-filter" onChange={i => setFilter(FILTERS[i])}>
        {FILTERS.map(f => <SegmentedControl.Button key={f.id} selected={filter.id === f.id} count={trees.filter(f.test).length}>{f.label}</SegmentedControl.Button>)}
      </SegmentedControl>
      {empty ? <div className="live-empty"><strong><PulseIcon size={16} />{empty[0]}</strong><span>{empty[1]}</span></div> : null}
      {running.length ? <div className="live-grid">{running.map(w => <WorktreeTile key={w.key} w={w} />)}</div> : null}
      {rest.length ? (
        <section className="live-rest" aria-labelledby="live-rest-h">
          <h2 className="live-h" id="live-rest-h">Other worktrees<CounterLabel>{rest.length}</CounterLabel></h2>
          <div className="live-rows">{rest.map(w => <WorktreeRow key={w.key} w={w} />)}</div>
        </section>
      ) : null}
    </div>
  );
}

// A prompt straight into a new worktree from the default branch; the dialog also sets its branch and what it comes after.
function Composer() {
  const { view, actions } = useBoard();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const prompt = text.trim();
  const submit = async () => {
    if (!prompt || busy) return;
    setBusy(true);
    try { await actions.createWorktree({ prompt }); setText(""); }
    catch {}
    finally { setBusy(false); }
  };
  return (
    <form className="composer" onSubmit={e => { e.preventDefault(); submit(); }}>
      <Textarea block rows={2} resize="none" value={text} aria-label="Prompt for a new worktree" onChange={e => setText(e.target.value)}
        placeholder={`Describe a change: a new worktree from ${view.project.defaultBranch} plans it. ⌘↩ starts it`}
        onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }} />
      <div className="composer-bar">
        <Button size="small" variant="invisible" leadingVisual={GitBranchIcon} onClick={() => actions.newWorktree({ prompt: text, onCreated: () => setText("") })}>
          Branch and After…
        </Button>
        <span className="spacer" />
        <Button type="submit" size="small" variant="primary" loading={busy} disabled={!prompt}>Create worktree</Button>
      </div>
    </form>
  );
}
