import { CounterLabel } from "@primer/react";
import { useBoard } from "./store.jsx";
import { COLUMNS } from "./model.js";
import { ColumnLabel } from "./parts.jsx";
import { WorktreeCard } from "./Card.jsx";

export function Board({ trees, filtered }) {
  const { actions } = useBoard();
  // A double-click on empty space starts a new worktree.
  const onDoubleClick = e => { if (e.target === e.currentTarget || e.target.matches(".col-b, .col-empty")) actions.newWorktree(); };
  return (
    <div className="board" onDoubleClick={onDoubleClick}>
      {COLUMNS.map(col => {
        const list = trees.filter(w => w.column === col.id);
        return (
          <section key={col.id} className="col" data-col={col.id} aria-labelledby={`col-${col.id}`}>
            <h2 className="col-h" id={`col-${col.id}`}><ColumnLabel id={col.id} /><CounterLabel>{list.length}</CounterLabel></h2>
            <div className="col-b">
              {list.length
                ? list.map(w => <WorktreeCard key={w.key} w={w} />)
                : <p className="col-empty">{filtered ? "No matching worktrees" : col.empty}</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
