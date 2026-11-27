import { useRef, useState } from "react";
import { ActionList, ActionMenu, BranchName, CounterLabel, Dialog, FormControl, IconButton, TextInput } from "@primer/react";
import { GitCommitIcon, PlusIcon, TagIcon, XIcon } from "@primer/octicons-react";
import { useBoard } from "./store.jsx";
import { columnTitle, worktreeName, worktreeStatus } from "./model.js";
import { AgentBlock, ColumnGlyph, ColumnLabel, DepsLine, GitFacts, PanelActions, PrState, StatusLine, TagLabels } from "./parts.jsx";

export function Panel() {
  const { view, openKey, setOpenKey, actions } = useBoard();
  const w = view.byKey.get(openKey), status = worktreeStatus(w, view);
  const pre = view.prerequisites(w), after = view.dependents(w), agents = w.agents || [];
  return (
    <aside className="panel" aria-label={`${worktreeName(w)} details`}>
      <header className="p-head">
        <ColumnLabel id={w.column} />
        <StatusLine info={status} />
        <span className="spacer" />
        <IconButton icon={XIcon} aria-label="Close" keybindingHint="Escape" variant="invisible" size="small" onClick={() => setOpenKey(null)} />
      </header>
      <div className="p-scroll">
        <div className="p-intro">
          <h2 className="p-title">{w.folder ? <span className="folder">{w.folder}</span> : null}{worktreeName(w)}</h2>
          <div className="p-sub">{w.branch ? <BranchName as="span">{w.branch}</BranchName> : <span>detached {w.detached}</span>}<span>{w.path}</span></div>
          <DepsLine w={w} />
          <PanelActions w={w} />
        </div>
        <Section title="omp" count={agents.length}>
          {agents.length ? agents.map(a => <AgentBlock key={a.id} w={w} a={a} />) : <p className="p-none">{status.text}</p>}
        </Section>
        <Section title="Git">
          {w.git ? (
            <>
              {w.git.last ? <div className="line" title={w.git.last.subject}><GitCommitIcon size={12} /><span className="line-text mono">{w.git.last.subject}</span></div> : null}
              <div className="facts"><GitFacts git={w.git} files /></div>
            </>
          ) : <p className="p-none">No git information yet</p>}
        </Section>
        {w.pr ? <Section title="Pull request"><PrDetails pr={w.pr} /></Section> : null}
        <Section title="Depends on" count={pre.length} action={<AddDependency w={w} />}>
          {pre.length
            ? <DepList list={pre} made={x => view.madeFrom(x.key, w.key)} onRemove={x => actions.setLink(x.key, w.key, false)} />
            : <p className="p-none">Nothing</p>}
        </Section>
        {after.length ? <Section title="Needed by" count={after.length}><DepList list={after} made={x => view.madeFrom(w.key, x.key)} onRemove={x => actions.setLink(w.key, x.key, false)} /></Section> : null}
        <Section title="Tags" action={<AddTag w={w} />}>
          {w.tags?.length
            ? <div className="tags"><TagLabels w={w} onRemove={t => actions.setTags(w, (w.ownTags || []).filter(x => x !== t))} /></div>
            : <p className="p-none">None</p>}
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, count, action, children }) {
  return (
    <section className="p-sec">
      <div className="p-sec-h"><h3>{title}</h3>{count ? <CounterLabel>{count}</CounterLabel> : null}<span className="spacer" />{action}</div>
      {children}
    </section>
  );
}

function PrDetails({ pr }) {
  const facts = [pr.checks ? `checks ${pr.checks}` : null, pr.review ? pr.review.replace(/_/g, " ") : null,
    pr.conflicts ? "conflicts" : null, pr.unresolved > 0 ? `${pr.unresolved} unresolved` : null].filter(Boolean);
  return (
    <>
      <div className="pr-row"><PrState pr={pr} /><a className="pr-title" href={pr.url} target="_blank" rel="noopener">{pr.title}</a></div>
      <p className="p-none">into <BranchName as="span">{pr.base}</BranchName>{facts.map(f => `, ${f}`).join("")}</p>
    </>
  );
}

function DepList({ list, made, onRemove }) {
  const { setOpenKey } = useBoard();
  return (
    <ActionList className="deps">
      {list.map(x => (
        <ActionList.Item key={x.key} onSelect={() => setOpenKey(x.key)}>
          <ActionList.LeadingVisual><ColumnGlyph id={x.column} /></ActionList.LeadingVisual>
          <span className="mono">{worktreeName(x)}</span>
          <ActionList.Description variant="inline">{made(x) ? "made from its branch" : columnTitle(x.column)}</ActionList.Description>
          {onRemove ? <ActionList.TrailingAction label={`Remove the dependency with ${worktreeName(x)}`} icon={XIcon} onClick={() => onRemove(x)} /> : null}
        </ActionList.Item>
      ))}
    </ActionList>
  );
}

function AddDependency({ w }) {
  const { view, actions } = useBoard();
  const has = new Set(view.prerequisites(w).map(x => x.key)), below = new Set(), todo = [w.key];
  while (todo.length) { const k = todo.pop(); for (const l of view.links) if (l.from === k && !below.has(l.to)) { below.add(l.to); todo.push(l.to); } }
  const others = view.worktrees.filter(x => x.key !== w.key && !has.has(x.key) && !below.has(x.key));
  return (
    <ActionMenu>
      <ActionMenu.Anchor><IconButton icon={PlusIcon} aria-label="Add a dependency" variant="invisible" size="small" /></ActionMenu.Anchor>
      <ActionMenu.Overlay width="medium" align="end">
        <ActionList>
          <ActionList.Group>
            <ActionList.GroupHeading>{worktreeName(w)} depends on</ActionList.GroupHeading>
            {others.length ? others.map(x => (
              <ActionList.Item key={x.key} onSelect={() => actions.setLink(x.key, w.key, true)}>
                <ActionList.LeadingVisual><ColumnGlyph id={x.column} /></ActionList.LeadingVisual>
                {worktreeName(x)}<ActionList.Description variant="inline">{columnTitle(x.column)}</ActionList.Description>
              </ActionList.Item>
            )) : <ActionList.Item disabled>No other checkout can be a prerequisite</ActionList.Item>}
          </ActionList.Group>
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  );
}

function AddTag({ w }) {
  const { view, actions } = useBoard();
  const [naming, setNaming] = useState(false);
  const own = w.ownTags || [], unused = (view.project?.tags || []).filter(x => !own.includes(x));
  const add = tags => actions.setTags(w, [...new Set([...own, ...tags])]);
  return (
    <>
      <ActionMenu>
        <ActionMenu.Anchor><IconButton icon={PlusIcon} aria-label="Add a tag" variant="invisible" size="small" /></ActionMenu.Anchor>
        <ActionMenu.Overlay width="small" align="end">
          <ActionList>
            <ActionList.Item onSelect={() => setNaming(true)}><ActionList.LeadingVisual><PlusIcon /></ActionList.LeadingVisual>New tag…</ActionList.Item>
            {unused.length ? (
              <>
                <ActionList.Divider />
                <ActionList.Group>
                  <ActionList.GroupHeading>Tags in this project</ActionList.GroupHeading>
                  {unused.map(x => <ActionList.Item key={x} onSelect={() => add([x])}><ActionList.LeadingVisual><TagIcon /></ActionList.LeadingVisual>{x}</ActionList.Item>)}
                </ActionList.Group>
              </>
            ) : null}
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
      {naming ? <NewTagDialog onAdd={add} onClose={() => setNaming(false)} /> : null}
    </>
  );
}

function NewTagDialog({ onAdd, onClose }) {
  const [text, setText] = useState("");
  const field = useRef(null);
  const submit = () => {
    const tags = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (tags.length) { onAdd(tags); onClose(); }
  };
  return (
    <Dialog title="New tag" width="small" initialFocusRef={field} onClose={onClose}
      footerButtons={[{ content: "Cancel", onClick: onClose }, { content: "Add tag", buttonType: "primary", onClick: submit }]}>
      <FormControl>
        <FormControl.Label>Tags</FormControl.Label>
        <TextInput ref={field} block value={text} placeholder="nutrition ui…" autoComplete="off" spellCheck={false}
          onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submit(); } }} />
        <FormControl.Caption>Separate several with spaces or commas</FormControl.Caption>
      </FormControl>
    </Dialog>
  );
}
