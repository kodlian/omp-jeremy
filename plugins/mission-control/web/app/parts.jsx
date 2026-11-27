import { Fragment, useSyncExternalStore } from "react";
import { ActionList, ActionMenu, Button, IconButton, IssueLabelToken, Label, LinkButton, ProgressBar, RelativeTime, Spinner, StateLabel, VisuallyHidden } from "@primer/react";
import {
  AgentIcon, AlertIcon, BellIcon, CheckIcon, ClockIcon, CommentIcon, DotFillIcon, EyeClosedIcon, EyeIcon, FileDiffIcon, FileIcon, GitCommitIcon,
  GitPullRequestIcon, KebabHorizontalIcon, LinkIcon, MoonIcon, PersonIcon, PlayIcon, QuestionIcon, TasklistIcon, TerminalIcon, ToolsIcon, TrashIcon, XIcon,
} from "@primer/octicons-react";
import { useBoard } from "./store.jsx";
import { agentInfo, agentLines, ago, columnTitle, elapsed, needsYou, plural, prStatus, subagentLines, waitText, worktreeName } from "./model.js";

// MARK: columns
const COLUMN_GLYPH = {
  planning: <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.2 2.2" />,
  waiting: <><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M6.6 6v4M9.4 6v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>,
  doing: <><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M8 4.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" /></>,
  uncommitted: <><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="8" cy="8" r="2" fill="currentColor" /></>,
  paused: <><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M8 4.5a3.5 3.5 0 1 1-3.5 3.5H8z" fill="currentColor" /></>,
  pr: <><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="8" cy="8" r="3.5" fill="currentColor" /></>,
  idle: <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />,
  done: <><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="M5 8.2l2 2 4-4.2" fill="none" stroke="var(--bgColor-default)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>,
};
// The column's glyph; `label` names the column where no column heading does.
export const ColumnGlyph = ({ id, label = false }) => (
  <svg className="col-glyph" data-col={id} viewBox="0 0 16 16" width="14" height="14" {...(label ? { role: "img", "aria-label": columnTitle(id) } : { "aria-hidden": true })}>
    {label ? <title>{columnTitle(id)}</title> : null}{COLUMN_GLYPH[id]}
  </svg>
);
export const ColumnLabel = ({ id, children }) => <span className="col-label"><ColumnGlyph id={id} />{children ?? columnTitle(id)}</span>;

// MARK: clock
const ticker = { listeners: new Set(), timer: 0 };
function subscribe(fn) {
  ticker.listeners.add(fn);
  ticker.timer ||= setInterval(() => ticker.listeners.forEach(l => l()), 1000);
  return () => {
    ticker.listeners.delete(fn);
    if (!ticker.listeners.size) { clearInterval(ticker.timer); ticker.timer = 0; }
  };
}
const second = () => Math.floor(Date.now() / 1000);
export function Elapsed({ since }) {
  useSyncExternalStore(subscribe, second);
  return <span className="num">{elapsed(since)}</span>;
}
// "6h ago", updating itself, with the date on hover.
export const TimeAgo = ({ at }) => <RelativeTime date={new Date(at)} formatStyle="narrow" className="num" />;

// MARK: status
const MARK = { waiting: ClockIcon, plan: FileIcon, asleep: MoonIcon, dot: DotFillIcon, none: DotFillIcon };
// A state from `worktreeStatus` or `agentInfo`: what needs you as a label, the rest as a line in its color, with its clock while an omp runs.
export function StatusLine({ info }) {
  const Mark = MARK[info.mark];
  return (
    <div className="status" data-tone={info.tone} title={info.title}>
      {info.tone === "needs"
        ? <Label variant="attention" size="large">{info.mark === "plan" ? <FileIcon size={12} /> : <BellIcon size={12} />}{info.text}</Label>
        : <>{info.mark === "busy" ? <Spinner size="small" srText={null} className="status-spin" /> : <Mark size={12} />}<span className="status-text">{info.text}</span></>}
      {info.since ? <Elapsed since={info.since} /> : null}
      {info.at ? <TimeAgo at={info.at} /> : null}
      {info.count > 1 ? <span className="num">{plural(info.count, "omp")}</span> : null}
    </div>
  );
}

export function TodoBar({ todo }) {
  if (!todo?.total) return null;
  return (
    <div className="todo" title={`${todo.done} of ${todo.total} to-dos done`}>
      <ProgressBar className="todo-bar" progress={Math.round(todo.done / todo.total * 100)} barSize="small" aria-label={`${todo.done} of ${todo.total} to-dos done`} />
      <span className="num">{todo.done}/{todo.total}</span>
    </div>
  );
}

// MARK: agent lines
const LINE_ICON = { asks: QuestionIcon, todo: TasklistIcon, says: CommentIcon, step: ToolsIcon, you: PersonIcon, agent: AgentIcon };
// One line of what an omp is on, for a card: its icon names the kind.
export function AgentLine({ line }) {
  const Icon = LINE_ICON[line.kind];
  return (
    <div className="line" data-tone={line.tone} title={`${line.label}: ${line.text}`}>
      <Icon size={12} aria-label={line.label} />
      <span className="line-text">{line.kind === "agent" ? <><span className="mono">{line.label}</span> {line.text}</> : line.text}</span>
    </div>
  );
}
// Every line of what an omp is on, for the panel: labelled and whole.
export function AgentDetails({ lines }) {
  if (!lines.length) return null;
  return (
    <dl className="agent-lines">
      {lines.map((line, i) => {
        const Icon = LINE_ICON[line.kind];
        return (
          <Fragment key={i}>
            <dt><Icon size={12} />{line.kind === "agent" ? <span className="mono">{line.label}</span> : line.label}</dt>
            <dd data-tone={line.tone}>{line.text}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

// One omp among those running in a checkout: its session, terminal, state, progress and every line of what it is on.
export function AgentBlock({ w, a }) {
  const { view, actions } = useBoard();
  const status = <StatusLine info={agentInfo(a, view)} />;
  return (
    <div className="agent" data-needs={needsYou(a) || undefined}>
      <div className="agent-h">
        {a.title ? <span className="agent-title" title={a.title}>{a.title}</span> : status}
        <IconButton icon={TerminalIcon} aria-label="Open its terminal" variant="invisible" size="small" disabled={!a.terminal}
          description={a.terminal ? "Bring this omp's terminal forward" : "Mission Control doesn't know its terminal yet"} onClick={() => actions.openTerminal(w, a)} />
      </div>
      {a.title ? status : null}
      <TodoBar todo={a.todo} />
      <AgentDetails lines={[...agentLines(a), ...subagentLines(a)]} />
    </div>
  );
}

// "Waiting for" what holds it, else "Builds on" its prerequisites once all are Done; nothing without either.
export function DepsLine({ w }) {
  const { view } = useBoard();
  const names = keys => keys.map((k, i) => <Fragment key={k}>{i ? ", " : ""}<span className="mono">{k}</span></Fragment>);
  const waiting = w.waitingFor || [];
  if (waiting.length) return <div className="line" title={waitText(view, waiting)}><ClockIcon size={12} /><span className="line-text">Waiting for {names(waiting.map(view.titleOf))}</span></div>;
  const pre = view.prerequisites(w);
  if (!pre.length || pre.some(x => x.column !== "done")) return null;
  return (
    <div className="line" title={`Builds on ${pre.map(worktreeName).join(", ")}, all done`}>
      <LinkIcon size={12} /><span className="line-text">Builds on {names(pre.map(worktreeName))}</span><CheckIcon size={12} className="ok" />
    </div>
  );
}

// MARK: git and pull request
const CHECKS = { passing: [CheckIcon, "success", "Checks pass"], failing: [XIcon, "danger", "Checks fail"], pending: [DotFillIcon, "attention", "Checks running"] };
export function PrState({ pr }) {
  const [Check, tone, checkText] = CHECKS[pr.checks] || [];
  return (
    <a className="pr" href={pr.url} target="_blank" rel="noopener" title={`${pr.state} pull request into ${pr.base}: ${pr.title}`}>
      <StateLabel status={prStatus(pr)} size="small">#{pr.number}</StateLabel>
      {Check ? <span className="fact" data-tone={tone} title={checkText}><Check size={12} /><VisuallyHidden>{checkText}</VisuallyHidden></span> : null}
      {pr.review === "changes_requested" ? <span className="fact" data-tone="attention" title="Changes requested"><FileDiffIcon size={12} /><VisuallyHidden>Changes requested</VisuallyHidden></span> : null}
      {pr.conflicts ? <span className="fact" data-tone="danger" title="Conflicts"><AlertIcon size={12} /><VisuallyHidden>Conflicts</VisuallyHidden></span> : null}
      {pr.unresolved > 0 ? <span className="fact" title={plural(pr.unresolved, "unresolved comment")}><CommentIcon size={12} />{pr.unresolved}</span> : null}
    </a>
  );
}

function Fact({ icon: Icon, tone, label, children }) {
  return <span className="fact" data-tone={tone} title={label}><Icon size={12} />{children}<VisuallyHidden> {label}</VisuallyHidden></span>;
}
// GitHub's five squares: up to one per changed line, green for the added share and red for the removed, grey for the rest.
function DiffBar({ added, removed }) {
  const colored = Math.min(5, added + removed);
  const green = Math.min(Math.max(Math.round(colored * added / (added + removed)), added ? 1 : 0), removed ? colored - 1 : colored);
  return <span className="diffbar" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <span key={i} data-kind={i < green ? "add" : i < colored ? "remove" : undefined} />)}</span>;
}
// A checkout's git facts in one order everywhere: size, uncommitted files, commits, files when asked, the newest commit's age.
export function GitFacts({ git, files = false }) {
  if (!git) return null;
  return (
    <>
      {git.added || git.removed ? (
        <span className="diffstat" title={`${git.added} lines added, ${git.removed} removed`}>
          <span className="add">+{git.added}</span> <span className="remove">−{git.removed}</span><DiffBar added={git.added} removed={git.removed} />
        </span>
      ) : null}
      {git.dirty ? <Fact icon={FileDiffIcon} tone="attention" label="uncommitted">{git.dirty}</Fact> : null}
      {git.commits ? <Fact icon={GitCommitIcon} label={git.commits === 1 ? "commit" : "commits"}>{git.commits}</Fact> : null}
      {files && git.files ? <Fact icon={FileIcon} label={git.files === 1 ? "file changed" : "files changed"}>{git.files}</Fact> : null}
      <CommitAge last={git.last} />
    </>
  );
}
// How long ago the newest commit landed, its subject on hover.
export function CommitAge({ last }) {
  return last ? <Fact icon={ClockIcon} label={`since the newest commit: ${last.subject}`}><TimeAgo at={last.at} /></Fact> : null;
}

const TAG_COLORS = ["#0075ca", "#008672", "#7057ff", "#d876e3", "#d73a4a", "#e99695", "#fbca04", "#0e8a16"];
// A tag's color, the same for the same name everywhere.
export const tagColor = tag => TAG_COLORS[[...tag].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TAG_COLORS.length];
// A worktree's tags in their colors; `onRemove` lets its own tags go, a tag rule's stay.
export function TagLabels({ w, onRemove }) {
  const own = new Set(w.ownTags || []);
  return (w.tags || []).map(t => (
    <IssueLabelToken key={t} text={t} fillColor={tagColor(t)} title={own.has(t) ? undefined : "From a tag rule (project settings)"}
      onRemove={onRemove && own.has(t) ? () => onRemove(t) : undefined} />
  ));
}

// MARK: actions
// The same actions on every card and in the panel, from the actions the server computed.
function useWorktreeActions(w) {
  const { actions, pending } = useBoard();
  const a = w.actions || {}, busy = op => pending.has(`${op}:${w.path}`);
  const list = [{ id: "open", label: "Open terminal", icon: TerminalIcon, title: "Bring forward a terminal in this checkout", onClick: () => actions.openTerminal(w), loading: busy("open") }];
  if (a.pr === "open" && w.pr) list.push({ id: "pr", label: `PR #${w.pr.number}`, icon: GitPullRequestIcon, title: `Open pull request #${w.pr.number} into ${w.pr.base}: ${w.pr.title}`, href: w.pr.url });
  else if (a.pr === "create") list.push({ id: "pr", label: "Create PR", icon: GitPullRequestIcon, title: `Push ${w.branch} and open a pull request into ${w.base}`, onClick: () => actions.createPr(w), loading: busy("pr") });
  if (a.resume) list.push({ id: "resume", label: "Resume", icon: PlayIcon, title: `Reopen its omp session in a new terminal; last active ${ago(w.agent.at)}`, onClick: () => actions.resume(w), loading: busy("resume") });
  return list;
}

export function CardActions({ w }) {
  const list = useWorktreeActions(w);
  return (
    <div className="card-actions">
      {list.map(x => x.href
        ? <IconButton key={x.id} as="a" href={x.href} target="_blank" rel="noopener" icon={x.icon} aria-label={x.label} description={x.title} variant="invisible" size="small" />
        : <IconButton key={x.id} icon={x.icon} aria-label={x.label} description={x.title} variant="invisible" size="small" loading={x.loading} onClick={x.onClick} />)}
      <MoreMenu w={w} />
    </div>
  );
}

export function PanelActions({ w }) {
  const list = useWorktreeActions(w);
  return (
    <div className="p-actions">
      {list.map(x => x.href
        ? <LinkButton key={x.id} href={x.href} target="_blank" rel="noopener" leadingVisual={x.icon} size="small" title={x.title}>{x.label}</LinkButton>
        : <Button key={x.id} leadingVisual={x.icon} size="small" title={x.title} loading={x.loading} onClick={x.onClick}>{x.label}</Button>)}
      <MoreMenu w={w} variant="default" />
    </div>
  );
}

function MoreMenu({ w, variant = "invisible" }) {
  const { view, actions, pending } = useBoard();
  const others = view.worktrees.filter(x => x.key !== w.key);
  const linked = new Set(view.prerequisites(w).map(x => x.key));
  const hidden = view.isHidden(w);
  return (
    <ActionMenu>
      <ActionMenu.Anchor>
        <IconButton icon={KebabHorizontalIcon} aria-label="More actions" variant={variant} size="small" loading={pending.has(`remove:${w.path}`)} />
      </ActionMenu.Anchor>
      <ActionMenu.Overlay width="medium" align="end">
        <ActionList>
          <ActionList.Group>
            <ActionList.GroupHeading>{worktreeName(w)}</ActionList.GroupHeading>
            <ActionMenu>
              <ActionMenu.Anchor>
                <ActionList.Item>
                  <ActionList.LeadingVisual><LinkIcon /></ActionList.LeadingVisual>
                  Depends on…
                  {linked.size ? <ActionList.TrailingVisual>{linked.size}</ActionList.TrailingVisual> : null}
                </ActionList.Item>
              </ActionMenu.Anchor>
              <ActionMenu.Overlay width="medium">
                <ActionList selectionVariant="multiple" aria-label={`${worktreeName(w)} depends on`}>
                  {others.length ? others.map(x => (
                    <ActionList.Item key={x.key} selected={linked.has(x.key)} onSelect={() => actions.setLink(x.key, w.key, !linked.has(x.key))}>
                      {worktreeName(x)}<ActionList.Description variant="inline">{view.madeFrom(x.key, w.key) ? "made from" : columnTitle(x.column)}</ActionList.Description>
                    </ActionList.Item>))
                    : <ActionList.Item disabled>The project has no other checkout</ActionList.Item>}
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
            {w.branch && !w.detached ? (
              <ActionList.Item onSelect={() => actions.setHidden(w.branch, !hidden)}>
                <ActionList.LeadingVisual>{hidden ? <EyeIcon /> : <EyeClosedIcon />}</ActionList.LeadingVisual>
                {hidden ? "Show on the board" : "Hide from the board"}
              </ActionList.Item>
            ) : null}
          </ActionList.Group>
          <ActionList.Divider />
          <ActionList.Item variant="danger" disabled={!w.actions?.remove} onSelect={() => actions.remove(w)}>
            <ActionList.LeadingVisual><TrashIcon /></ActionList.LeadingVisual>
            Remove worktree…
            {w.actions?.remove ? null : <ActionList.Description variant="block">{w.main ? "The main checkout stays" : "End its omp to remove it"}</ActionList.Description>}
          </ActionList.Item>
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  );
}
