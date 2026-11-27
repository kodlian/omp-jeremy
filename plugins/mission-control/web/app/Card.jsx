import { Label, Truncate } from "@primer/react";
import { useBoard } from "./store.jsx";
import { agentLines, leadAgent, subagentLines, worktreeName, worktreeStatus } from "./model.js";
import { AgentBlock, AgentLine, CardActions, ColumnGlyph, CommitAge, DepsLine, GitFacts, PrState, StatusLine, TagLabels, TodoBar } from "./parts.jsx";

const PATH_LABEL = { ready: ["success", "Prerequisite done"], blocked: ["danger", "Prerequisite open"] };

// A worktree's box in every view: its place on the open worktree's dependency path, dimmed when hidden from the board.
function CardShell({ w, className = "card", children }) {
  const { view, pathOf } = useBoard();
  return <article className={className} data-key={w.key} data-path={pathOf(w)} data-hidden={view.isHidden(w) || undefined} title={w.path}>{children}</article>;
}

// The name opens the panel; its click area covers the whole box. One line, whole on hover.
function OpenButton({ w, folder = true }) {
  const { setOpenKey } = useBoard();
  const name = worktreeName(w), shown = folder && w.folder;
  return (
    <button type="button" className="card-open" onClick={() => setOpenKey(w.key)}>
      <Truncate as="span" title={shown ? `${w.folder}/${name}` : name} maxWidth="100%">{shown ? <span className="folder">{w.folder}</span> : null}{name}</Truncate>
    </button>
  );
}

function CardHead({ w }) {
  const { pathOf } = useBoard();
  const subtitle = leadAgent(w)?.title || w.agent?.title, pathLabel = PATH_LABEL[pathOf(w)];
  return (
    <header className="card-head">
      <div className="card-title-row">
        <ColumnGlyph id={w.column} label />
        <h3 className="card-title"><OpenButton w={w} /></h3>
        {w.main ? <Label>main checkout</Label> : null}
        {pathLabel ? <Label variant={pathLabel[0]}>{pathLabel[1]}</Label> : null}
      </div>
      {subtitle ? <p className="card-sub">{subtitle}</p> : null}
    </header>
  );
}

function CardFacts({ w }) {
  return (
    <div className="facts">
      {w.pr ? <PrState pr={w.pr} /> : null}
      <GitFacts git={w.git} />
      <TagLabels w={w} />
    </div>
  );
}

// Board and Graph: the lead omp's state and its most telling line.
export function WorktreeCard({ w }) {
  const { view } = useBoard();
  const lead = leadAgent(w), first = lead ? agentLines(lead)[0] : null;
  return (
    <CardShell w={w}>
      <CardHead w={w} />
      <div className="card-activity">
        <StatusLine info={worktreeStatus(w, view)} />
        {lead ? <TodoBar todo={lead.todo} /> : null}
        {first ? <AgentLine line={first} /> : null}
        {(w.agents || []).flatMap(subagentLines).map((line, i) => <AgentLine key={i} line={line} />)}
        <DepsLine w={w} />
      </div>
      <CardFacts w={w} />
      <CardActions w={w} />
    </CardShell>
  );
}

// Live: every omp running in the checkout, whole.
export function WorktreeTile({ w }) {
  return (
    <CardShell w={w}>
      <CardHead w={w} />
      <div className="card-activity">
        {w.agents.map(a => <AgentBlock key={a.id} w={w} a={a} />)}
        <DepsLine w={w} />
      </div>
      <CardFacts w={w} />
      <CardActions w={w} />
    </CardShell>
  );
}

// Live's quiet checkouts: one line each.
export function WorktreeRow({ w }) {
  const { view } = useBoard();
  return (
    <CardShell w={w} className="row">
      <ColumnGlyph id={w.column} label />
      <span className="row-name"><OpenButton w={w} /></span>
      <StatusLine info={worktreeStatus(w, view)} />
      {w.agent?.state === "asleep" ? null : <CommitAge last={w.git?.last} />}
    </CardShell>
  );
}

// Graph: what tells it apart on one line, its state on the next; the panel has the rest. `folder` names its folder where no group box does.
export function WorktreeNode({ w, folder }) {
  const { view } = useBoard();
  return (
    <CardShell w={w} className="node">
      <div className="node-row">
        <ColumnGlyph id={w.column} label />
        <h3 className="node-title"><OpenButton w={w} folder={folder} /></h3>
        {w.pr ? <PrState pr={w.pr} /> : null}
      </div>
      <StatusLine info={worktreeStatus(w, view)} />
    </CardShell>
  );
}
