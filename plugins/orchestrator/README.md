# Orchestrator

A local task board for omp, installed as an omp plugin. Cards come from wherever you are: a request in omp, a rough need the agent splits into tickets, the agent's own tools, or the board's composer. A card is a title and a description. A started card gets its own git worktree and an omp session in a durable agent host, which plans it with you, then implements it; you watch and answer that omp in a cmux workspace, a tmux window, or any terminal through its attach command (see [Terminals](#terminals)). The board follows that agent to the pull request and the merge, or merges the branch back locally. Every step works from the omp session as well as from the board.

## Install

```bash
brew install beads                                # runtime dependency (macOS)
omp plugin marketplace add kodlian/omp-jeremy
omp plugin install orchestrator@omp-jeremy
```

Restart omp. Requires `omp`, `bun`, `python3`, `git` and Beads (`brew install beads`); `cmux` and `tmux` are optional terminal presentations, and `gh` adds pull request status. The plugin starts the board server the first time it needs it (output in `~/.kanboard/server.log`) and restarts it when the plugin's server code is newer than the running one.

### Local development

For local development, install dependencies and build from the monorepo root. Marketplace releases already include the extension bundle and Python helper.

```bash
git clone https://github.com/kodlian/omp-jeremy.git && cd omp-jeremy
bun install --ignore-scripts
bun run build
omp plugin link plugins/orchestrator
```

The launcher and plugin run `python3 server.py --prepare` before starting the server. Preparation initializes the external Beads workspace and migrates legacy cards before the HTTP startup deadline begins. To prepare without opening the board, run that command directly with the desired `KANBOARD_HOME`; a running board should be stopped before migrating its data.

## Terminals

Each task's omp runs in a detached agent host (`agent_host.py`) that owns its terminal: the host outlives the board server and every terminal showing it, keeps the recent screen for the **Agent** tab and `orchestrator_screen`, and lives in a private directory under `$KANBOARD_HOME/hosts/`. Terminals only present it, according to where the omp session that created the card runs:

| Session runs in | A started task opens | The board opens in |
|---|---|---|
| cmux | a new background workspace in that cmux window | a browser split of the session's cmux workspace |
| tmux, including tmux inside cmux | a new background window in that tmux session | cmux's browser when cmux surrounds tmux, else the default browser |
| any other terminal | nothing: the card shows the attach command to run in any terminal | the default browser |

Each omp session reports its own terminal when it connects, so sessions in different terminals share one board without sending work to each other's terminals. Nothing opens in whichever workspace or window happens to be focused, and only opening a task or the board yourself brings it forward. `KANBOARD_TERMINAL` (or the shared `OMP_TERMINAL`) set to `cmux`, `tmux` or `plain` forces the presentation for sessions started with it; `auto`, the default, detects it. A forced terminal that isn't available is an error, never a fallback to another one.

The attach command runs `agent_host.py attach <host directory>`; **Ctrl-\\** detaches and omp keeps running. Closing a terminal, a cmux workspace or a tmux window only detaches it. The agent's state comes from its omp session, never from terminals: a host whose omp isn't connected to the board reads as **omp disconnected**, and an agent that exited or was stopped as **stopped**. The board has no diff viewer of its own: **Terminal diff** opens cmux's diff viewer and needs a cmux session; elsewhere, review changes in the worktree.

## Columns

| Column | What happens |
|---|---|
| Backlog | **New task** (`N`) opens a composer for the title, description, ticket and planning mode. New cards default to **Auto**; the panel can switch Auto, Plan or Fast until the task starts. A plan pasted into the panel becomes draft context. **Discuss in omp** brings the flow's orchestrator omp session to the front with the card's id typed in its prompt, so you change the card by talking to it. A started card moved here is paused and stays parked until you move it back (see [Pausing and stopping](#pausing-and-stopping)). |
| Todo | **Start** (or dragging the card here, or `/orchestrator start`) queues the card. Once its dependencies are Done and the flow has a concurrent-task slot, it creates the branch and worktree, then starts the task's agent host, whose omp follows the card's planning mode from a brief containing the title, description, sibling tasks and any draft plan, and presents it in the terminal of the session that created the card. The card moves to In Progress once the agent is up. Waiting cards start automatically, top first; dragging a card up or down within Todo changes which starts next without starting it. **Start now (ignore dependencies)** in the panel's ⋯ menu bypasses dependencies, but not the flow's concurrency limit. A started card moved back here pauses, then resumes on its own when it is first in line with its dependencies Done and a slot free. |
| In Progress | Shows the agent's state (planning, plan ready for review, thinking, working, needs you, idle, **omp disconnected** while its omp isn't connected to the board, or **stopped**) with how long it has been in that state and the step it is on, then +/− lines and uncommitted files. While a plan waits for you, **Review plan** opens the agent's terminal where omp's review is open, or shows its attach command. The panel's **Agent** tab shows the agent's screen, and its box sends the agent messages while it runs (not while its card is paused or it waits for your plan review or answer). It also opens cmux's diff viewer (**Terminal diff**) from cmux sessions; the board itself shows only change counts. The header's terminal button connects to the agent's terminal. **Open worktree** (panel or ⋯ menu, once the task has a worktree) works whatever the agent's state and never starts, resumes or closes anything: it brings forward a terminal already in the worktree (the agent's, or any cmux workspace or tmux window whose shell is in it), else opens a new shell there in the terminal of the session that created the card; in a plain terminal it shows the `cd` command to copy. Moving a working card out of In Progress asks for confirmation: to Todo or Backlog it pauses the agent, to Review or Done it only changes the card's status, and either way the card frees its concurrency slot. **Stop agent…** in the ⋯ menu ends its omp session instead. |
| Review | The card moves here when the branch has an open pull request. A task that merges locally moves here when its agent is idle (or stopped) with committed work and a clean worktree ("Ready to merge"). |
| Done | The card moves here when the pull request is merged, or when **Merge into &lt;base&gt;** or `/orchestrator done` merged the branch; you can also drag it here. Its title and description are then fixed—create a new card for more work. **Remove worktree** stops its agent, closes its terminal and deletes the worktree and the branch, without unlocking its branch, repository, base, merge mode or planning mode. |

Successful local merges stop the task agent and close its terminal even when keeping the worktree. The cleanup choice controls deletion of the worktree and branch, not whether a completed task's workspace stays open.

The board takes its background, monospace font and font size from the terminal's Ghostty configuration (`ghostty +show-config`, plus cmux's own terminal settings under cmux) and its colors from omp: the page shows its flow in the omp theme of that flow's orchestrator sessions, and follows theme changes. Text and controls scale from the terminal's font size with the same formula as `/review`. When the terminal's font is a Nerd Font, the agent's screen shows its icons too.

Selecting a card or graph node keeps its details docked on the right, including in narrow panes. Below 560px, double-clicking the task explicitly opens details full-width; a single click never takes over the board. At larger widths, double-clicking also stays docked.

## Graph and Live views

The three icons at the top left switch between **Board** (columns), **Graph** (a dependency canvas) and **Live** (what agents are doing and what waits for you); the choice is remembered in this browser. Search, the task panel and the scheduler apply to every view.

Task numbers display as `#74` (or `#74.1` for a child). One Beads counter is shared by every flow and worktree in the orchestrator home; stored IDs remain `KB-74`, so existing API references keep working.

- Connections run from prerequisite to dependent task without arrowheads, behind the cards. Small circular ports sit inside each card's left and right edges; connected ports are solid and unconnected ports outlined, even when the connected task is filtered out. Drag an output handle on the right to another task to add a dependency, or drag an input handle to choose its prerequisite. Working nodes use an accent tint and side rail; completed nodes keep a green status badge and ports. Task surfaces, rather than full-card frames, provide hierarchy.
- Click a connection to select it. Drag the dependent task's existing left input port to another prerequisite to reconnect the selected line, or choose **Remove connection**. There is no separate floating handle. The server rejects cycles and cross-flow dependencies. Removing the last blocker from a queued task can start or resume it; the canvas asks before doing that. Changing dependencies on an In Progress task asks for confirmation and does not pause it.
- Drag a task to position it; click it (or press Enter while focused) to open its usual panel. Drag the background to pan, scroll to zoom, use **Fit all** to frame visible tasks, or **Focus task** to center the open task. Clicking empty graph space clears task and connection selection; dragging or cancelling a background gesture keeps selection.
- Selecting a task highlights its entire upstream dependency path in all three views, including indirect prerequisites: completed cards and connections are green, unfinished ones red. Dependency cards use surface tints rather than outlines; only the selected task keeps a thin accent border, and unrelated context is subdued. Shared ancestors appear once, and selection changes or live updates refresh the colors. Hover or keyboard-focus a dependency in the detail panel to accent its visible card without changing the open task. Board and Live can scroll the card or tile into view, but highlighting never pans or rearranges the graph.
- **Auto-layout** uses Dagre to arrange visible tasks from prerequisites on the left to dependents on the right, aligning branches and reducing connection crossings. Search and **Hide done** exclude tasks from the layout, so hidden history does not leave empty columns. Live updates preserve manual positions and the viewport until you request another layout; positions last for this page session.
- Connection colors describe each prerequisite: completed inputs are green, working inputs use the accent color, and unfinished inputs are grey. Only paths into a connected In Progress task with every prerequisite completed are bold; other paths remain thin, even when green. Existing connections stay still. Creating or reconnecting a dependency draws it once from source to target at full opacity in its status color, then restores its normal emphasis; reduced motion skips the animation.
- Double-click empty canvas to describe a task to the main agent. Drag a task's right output port onto empty canvas to request a dependent task, or its left input port to request a prerequisite. The prompt includes the dependency direction; releasing outside the canvas or cancelling a reconnection creates no request.
- In Progress cards use an accent tint and side rail. Their workflow badge is separate from the agent activity label: In Progress can still mean Idle. Intentionally paused tasks are neutral, not connection-health warnings.

**Live** shows the page's flow, narrowed by the search field, as a mosaic of started work:

- **In progress** groups started work and handoffs. Each tile has a prominent task-number/title header, with its activity, terminal preview and actions contained beneath it. Every task element, including Ready/Start, Queued and Recently done rows, is capped at 560px rather than stretching across the row. Sections have 28px spacing; subtle surfaces provide hierarchy rather than nested borders.
- **Backlog · Ready to start** shows unblocked, unpaused backlog tasks as compact title-and-Start rows. Readiness includes inherited dependency blockers. Start still uses the normal confirmation and scheduler; if every agent slot is occupied, it queues the task rather than bypassing the limit. Other backlog tasks remain on the Board. Below the mosaic, **Queued** lists Todo tasks and **Recently done** lists up to six latest results.
- Handoffs expose existing actions: **Needs your answer** → **Answer in terminal**; **Plan ready** → **Review plan**; **Session disconnected** → **Connect terminal**; **Start failed** → **Retry start**; a local Review task → **Merge into &lt;base&gt;**, a pull request → its PR link. Available terminal and worktree actions stay inside their task's frame; clicking the tile opens the task panel. There is no embedded diff viewer. Nothing runs automatically.
- The terminal preview is a read-only excerpt of the agent host's recent screen, preserving foreground/background colors and text emphasis: it accepts no input and doesn't fetch older history. At most four previews refresh every 3 seconds, with at most two requests in flight, only while Live is visible. Leaving Live stops polling. Exited hosts show a stopped label rather than appearing live. Already-running hosts from older versions remain readable in plain text until their next natural restart; upgrading never restarts an agent to add colors.
- Tiles keep the place they got when first shown, and new ones are added at the end: live updates refresh tiles in place without reordering them or changing the open task.

If a worktree was deleted outside Orchestrator, the task shows **Worktree missing**. **Return to Backlog** clears stale execution state while preserving the task's description, plan, dependencies, shared context and any remaining branch commits. It refuses recovery while a worktree or live agent still exists and never starts an agent. The next Start can recreate a deleted worktree without discarding an existing branch.

## Ways in

- **A request.** `/orchestrator` turns orchestrator mode on for the checkout and shows the board on its flow, in a cmux browser split when the session runs in cmux, else in the default browser. Ask for a task and omp creates the card right away, a title and a description of what you want and what you decided, without exploring the code or planning. A bug report, missing behavior or other assertive request starts the new card immediately; an idea, a maybe/later request or an ongoing discussion stays in Backlog. omp says which cards it started, and dependencies still delay their work. The card's own omp briefly triages it after starting and plans only when useful. Plans proposed in the main session stay plans for work done there; they don't become cards.
- **Grouping.** Every card costs a worktree and a build, so an ask on the same subject as an open card goes to that card with `orchestrator_amend` instead of a new one, as long as it fits that card's branch and direction. A card that hasn't started takes it in its description. A started card's agent also receives it as a message, and a Review card moves back to In Progress (even past the flow's concurrent-task limit, since its worktree already exists). While that agent waits for plan review or an answer, only the card records it, marked as not sent, and omp tells you to include it there. A paused card also keeps it on the card, and its agent gets it when it resumes. A done card, or a started card without a running agent, refuses it and a new card is created instead; a card still creating its worktree asks you to retry shortly. omp says where each ask went.
- **A split.** Related asks from one request stay in one card. A request whose parts are large and touch independent areas, or must land in order (or "split this into tasks"), becomes several cards, created in the order you'd pick them, with their dependencies; each description starts with "Part of: <the overall need>".
- **Plain requests.** Every command below has a tool, so "what's on the board", "KB-12 should also cover the empty state", "12 needs 11 first", "start 12 and 13", "pause 12", "tell 12 to keep the old header", "approve 12's plan", "stop 12", "merge 12" or "drop 14" work as ordinary prompts. Merging and deleting this way ask you to confirm, and deleting a started card asks whether its worktree and branch go too (through the same cleanup as **Remove worktree**); entering `/orchestrator done` yourself is the merge approval.
- **The board.** The composer, as above, creates a card directly. Alternatively, double-click empty space or the header in a column to open a task prompt with that column as context. **Send to main agent** (or ⌘/Ctrl+Enter) delivers it to the page flow's connected Orchestrator session without changing focus. The main agent owns creating or updating cards and deciding when to start them. Delivery waits for acknowledgement; offline sessions and pending plan reviews leave the prompt open with its text preserved. Reload the main agent's Orchestrator plugin after updating it to enable this entry point.

## omp commands

| Command | |
|---|---|
| `/orchestrator`, `/orchestrator on`, `/orchestrator off` | orchestrator mode for this checkout: every omp session started there has it until `/orchestrator off`; turning it on shows the board on this checkout's flow |
| `/orchestrator open` | shows the board and focuses it, on this worktree's card or the last card this session created; in cmux, a split already showing the board is reused |
| `/orchestrator start KB-n … \| all` | queues cards in Todo (`all`: this session's backlog cards); each starts when its dependencies are Done and its flow has a concurrent-task slot |
| `/orchestrator done [KB-n]` | stages and commits pending task changes as `KB-n: <title>`, then merges the local task into its base; a commit failure stops the merge. A merge conflict starts a rebase in the task worktree: a clean rebase retries the merge, while a conflicted rebase asks the task agent to resolve it. In a task's worktree without an id, the command itself approves the merge, removes the worktree and ends that session with its agent host and terminal. With an id, from any session, it asks whether to keep the worktree (the choice is remembered). |
| `/orchestrator status` | the mode, the flow and the task |
Typing after `/orchestrator ` completes these subcommands and filters them by prefix.

Tools: `orchestrator_tasks`, `orchestrator_plan` (a card's description and plan), `orchestrator_create`, `orchestrator_edit`, `orchestrator_amend` (adds same-subject work to an open card), `orchestrator_link`, `orchestrator_start`, `orchestrator_move` (any column, as dragging does, so it pauses and resumes started cards), `orchestrator_stop`, `orchestrator_message` (a message to a started card's agent), `orchestrator_review` (answers a started card's open plan review with your decision), `orchestrator_screen` (the agent's terminal), `orchestrator_diff`, `orchestrator_cleanup` (removes a worktree after you confirm), `orchestrator_recover` (returns a card whose worktree was deleted outside the board to Backlog after you confirm, keeping its plan, description, dependencies and branch; starts no agent), `orchestrator_done`, `orchestrator_delete`.
Native Beads tools: `orchestrator_children` (direct task hierarchy), `orchestrator_history` (versioned task/plan changes or audit events), `orchestrator_ready` (dependency and queue explanations), and `orchestrator_memory` (repository-scoped durable decisions).

The browser exposes the same Beads operations in Board, Graph and Live. Task details include parent/child links, parent editing, a create-child shortcut, shared-context publication, Readiness and History (snapshots or audit events). The flow menu opens the page flow's Readiness and Shared memories; memory operations use that flow's repository. Clearing a parent uses the × in the browser, `parent: "none"` in the plugin, or `parent: null` in the HTTP API.
`orchestrator_edit` takes `dependsOn` as the complete replacement list; pass `[]` to clear every dependency. `orchestrator_link` remains the additive shortcut. `orchestrator_edit`'s `before` or `after` (a card in the same column) moves the card there without starting it, as dragging it within its column does. It also sets the plan text and, until the task starts, the merge mode, base and branch.

While orchestrator mode is on, a line under the prompt shows the flow's open cards by column, then the cards in Review, In Progress and Todo with their state (ready to merge, plan ready for review, working, needs input, paused, waiting for a task slot, starts or resumes after KB-n…), in the session's theme colors. The session also tells you when one of the flow's cards fails to start, has its plan ready for review, needs your input, is ready to merge, or got merged.

## Task sessions

A task's omp owns its implementation decisions in its worktree. Auto tasks briefly inspect enough to choose Fast implementation or Plan review; approving a plan there starts implementation, while Refine sends it back with your notes. The plan and the resolved Auto route show on the card. The omp knows its card, base branch and commits, including after restarting omp in its worktree. Tell it "ok merge", or that it's done: your request is the approval, so it stages and commits pending changes, merges into the base without asking again, and closes its worktree and agent. It never merges just because it considers the work finished. A task that lands through a pull request commits, pushes and opens it instead. Its brief lists sibling tasks from the same parent branch.

### Shared context

`orchestrator_publish {kind: "finding" | "outcome", text, id?}` appends a concise finding or completion outcome to the task's Beads notes. `id` defaults to the current task. Entries record their source, time and branch/commit reference; each publication is limited to 4000 characters. Record reusable decisions, APIs, caveats and verification results—not transcripts or unverified claims.

`orchestrator_context {id?}` reads the current notes and their revision. New task briefs include bounded handoffs from direct dependencies: the latest outcome and up to three other entries per dependency, with revision references. Other sibling context stays on demand. Existing workers fetch later updates explicitly; sessions do not share conversation history, and no token-cost reduction is assumed.

### Project memory

`orchestrator_memory {action, key?, text?, query?}` uses Beads' persistent memory store, namespaced by the canonical Git repository. Every linked worktree shares that scope; unrelated repositories do not. `remember` stores or replaces a decision under an explicit key (1–80 letters, digits, `.`, `_`, `-`); text is limited to 4000 characters. `search` accepts an optional query of up to 200 characters and returns bounded excerpts. `read` retrieves a key; `forget` reads it, asks for confirmation, and only then deletes it.

Search on demand when a previous project decision may apply. Memories are not injected automatically into prompts. Keep task-specific findings/outcomes in `orchestrator_publish` and personal omp preferences in omp's own memory. Search returns at most 20 memories and 16000 text characters; truncation is explicit. Native `bd remember` keys without this repository namespace are not silently assigned to a repository.

### History and readiness

`orchestrator_history {id, limit?, events?}` reads native Dolt-backed task snapshots, including prior plans and shared context. It shows bounded field changes, newest first; `events: true` reads Beads' audit events instead. The default limit is 10, with a maximum of 50.

`orchestrator_ready {id?, all?}` explains native dependency readiness alongside the board's actual queue state. By default it covers the current flow; `id` selects one card and `all` covers all flows. A native-ready Backlog card is not queued, and a Todo card may still wait for a flow slot. The tool never claims or starts work.

## Changing a started task

A started card's title and description stay editable in the panel until it is Done, so a change of direction doesn't need a new card. The agent keeps working from what it was given until you send the edit: the panel shows **Not sent to the agent** under the description and a dot on its **Task** tab. **Send to agent** (or ⌘↩ while editing) saves the edit and sends the agent the new title or description, which replaces its brief's, and moves a Review card back to In Progress. **Dismiss** keeps the edit on the card only. The edit waits while the agent wants your plan review or an answer (include it there), while its omp is disconnected, while the card is paused (resuming sends it), and while the task is still starting. `orchestrator_edit` from the flow's omp session sends a started card's new title or description right away when its agent can take it, and otherwise leaves it marked as not sent.

## Pausing and stopping

A started card's column decides whether its agent works:

- **Todo or Backlog pauses it.** Its agent's turn is interrupted; the worktree, branch, omp session and agent host stay, and the card frees its flow's task slot. The task's omp shows that the board paused it, and its prompt line reads paused.
- **Todo resumes it on its own** once it is first in line with its dependencies Done and a slot free, like a card waiting to start. **Backlog** keeps it parked until you move it.
- **In Progress resumes it now** when the flow has a slot: its agent is told to continue where it stopped, with any title or description edits made meanwhile. A card whose dependencies aren't Done waits in Todo instead.
- **Stop agent…** (⋯ menu, or `orchestrator_stop`) also ends its omp session and agent host, closes its terminal, and parks the card in Backlog (a Review card stays). Resuming starts a new host on the same omp session (`omp --resume`) and presents it in the task's terminal again, so the agent picks up where it stopped.

Pauses, resumes, messages, plan answers and stops reach the agent through its omp session, never by typing into its terminal. A task whose omp isn't connected to the board (its host stopped, or omp running without this plugin) can't take them, and the board says so; a pause still moves the card.

## Planning modes

- **Auto** (default): briefly triages in the task branch. Clear, straightforward work starts immediately; product decisions, unclear acceptance, architecture, migrations or meaningful cross-cutting risk open plan review.
- **Plan:** starts in plan mode and requires review before implementation.
- **Fast:** implements directly without plan review. Cards show a bolt-labeled **Fast** chip; an Auto card changes from **Auto** to **Fast** once its worktree first changes, or to **Plan** when it requests review.

The composer and task panel select the mode. It is fixed once the task starts. Each task gets its own omp configuration, so tasks with different modes can start concurrently without sharing startup state.


## Flows

One server serves every session, and each board page shows one flow. Each parent branch is a flow: `/orchestrator` in a checkout registers that checkout's branch, and the cards created there branch from it and merge back into it. A page stays on the flow it was opened for: the `?flow=` in its URL (set by `/orchestrator open` and the launcher), else the flow of the task in its `#KB-n` link, else the board's context checkout. There is no flow switcher and no all-flows view; open the board from another checkout to work on its flow, and other flows keep their cards untouched. The composer and the task prompt create cards in the page's flow. A flow whose checkout was deleted (or is no longer a git checkout) and has no connected omp session shows as **Flow unavailable**: the page stays empty of other flows' cards and refuses new cards until `/orchestrator` runs in its checkout again; its cards keep their dependencies and history. The flow menu in the top bar holds **Concurrent tasks**, to limit how many cards may be creating a worktree or In Progress at once (the default is unlimited, and lowering the limit never stops tasks already running), and **Setup script** and **Teardown script**, which edit the flow's [project scripts](#setup-and-teardown-scripts). `/orchestrator open` opens the session's flow. A dependency on a card of another flow is refused.

A flow is one level deep: a task's worktree can't have tasks of its own, so `/orchestrator` there is refused, and so is a card created from it.

## Base branch and merging

A card branches from the branch checked out where it was created and keeps that base; the panel changes it until the task starts. The branch, repository, base, merge mode and planning mode remain fixed after starting, including after merge and worktree removal. A task branched from the repository's default branch lands through a pull request. One branched from any other branch merges back locally: **Merge into &lt;base&gt;** requires a clean, committed worktree, while `/orchestrator done` first stages and commits pending task changes. Both run `git merge --no-ff` in the checkout where the base is checked out, optionally removing the worktree and ending its agent.

## Dependencies

Before creating cards for a request, the flow's orchestrator session performs one bounded dependency preflight over that flow's open cards, reads only plausible prerequisite cards, and fills `dependsOn` automatically; it does not inspect the repository or plan implementation. **Depends on** in the panel then lists what each task waits for: **+** adds one and **×** removes it. `orchestrator_edit` replaces the full list and accepts `[]` to clear it. A cycle, or a task from another flow, is refused. A queued task starts automatically once its dependencies are Done and its flow has capacity.

### Task hierarchy

Pass `parent` to `orchestrator_create` or `orchestrator_edit` to group a card under another card in the same flow; `orchestrator_edit` with `parent: "none"` clears the link (the HTTP API takes `parent: null`). `orchestrator_children {id}` lists the parent and direct children. New children use native IDs such as `KB-12.1`; reparenting keeps the ID.

Parent groups scope, while `dependsOn` expresses ordering. Beads also propagates a parent's blockers to its children; the board checks those native blockers before an explicit start/resume and before processing Todo. A failed native blocker read prevents starts for that decision/tick. Self-parenting, cycles, cross-flow hierarchy and moving a family member to another flow without first clearing its links are refused. Deleting a parent orphans its children without deleting them.

Task hierarchy does not create nested Git worktrees or permit task sessions to create their own worktrees. Existing approval, pause/resume, concurrency and merge rules still apply.

## Hooks

`~/.kanboard/config.json` replaces Orchestrator's worktree operations with your own commands. Orchestrator reads it at each operation, so a toolkit can register while the board runs:

```json
{
  "commands": {
    "createWorktree": "my-wt new \"$KANBOARD_BRANCH\" --run \"$KANBOARD_AGENT_COMMAND\"",
    "removeWorktree": "my-wt remove"
  }
}
```

Each command runs with `/bin/sh -c`; a non-zero exit fails the operation with its last output line.

| Command | cwd | Variables | Must | Without it |
|---|---|---|---|---|
| `createWorktree` | repository | `KANBOARD_TASK`, `KANBOARD_TITLE`, `KANBOARD_REPO`, `KANBOARD_BRANCH` (already created from its base), `KANBOARD_BASE`, `KANBOARD_AGENT_COMMAND`, `KANBOARD_SETUP_SCRIPT` | check the branch out in a worktree; Orchestrator then finds it with `git worktree list`. To show the agent in your own terminal, run `$KANBOARD_AGENT_COMMAND` there: it starts the task's agent host unless it runs, then attaches to it. A hook that only creates the worktree leaves the host to Orchestrator, and the card shows its attach command | `git worktree add` under `~/.kanboard/worktrees/<repo>/<branch>`, the setup script in a newly created worktree, then the agent host, presented in the creating session's terminal |
| `removeWorktree` | worktree | `KANBOARD_TASK`, `KANBOARD_REPO`, `KANBOARD_BRANCH`, `KANBOARD_WORKTREE`, `KANBOARD_TEARDOWN_SCRIPT` | remove the worktree and its branch; Orchestrator has already stopped the agent and closed its terminal | refuses with uncommitted changes, runs the teardown script in the worktree, then `git worktree remove` and `git branch -D` |

## Setup and teardown scripts

`config.json` also holds per-project scripts beside `commands`. A project is a flow's name, the basename of its repository:

```json
{
  "defaults": { "setupScript": "", "teardownScript": "" },
  "projects": {
    "monorepo": { "setupScript": "~/kit/setup.sh", "teardownScript": "~/kit/teardown.sh" }
  }
}
```

For each key, the project's own value applies when present, and an empty string means none; otherwise the `defaults` value applies, else none (like jq's `.projects[p][k] // .defaults[k]`). A value is a script path, `~` allowed, run as `bash <path>` with the worktree as working directory and `KANBOARD_TASK`, `KANBOARD_REPO`, `KANBOARD_BRANCH`, `KANBOARD_BASE` and `KANBOARD_WORKTREE` set.

- **Without hooks:** Orchestrator runs the setup script after it creates a new worktree (not when it reuses one) and before the agent host starts, and the teardown script in the worktree before `git worktree remove`. A failing script shows in the task's start log or removal output but doesn't stop either.
- **With `createWorktree` or `removeWorktree`:** only the hook knows when the agent starts, so Orchestrator runs neither script. It passes the resolved path, `~` expanded, as `KANBOARD_SETUP_SCRIPT` to `createWorktree` and `KANBOARD_TEARDOWN_SCRIPT` to `removeWorktree`. Both are always set; empty means none.

**Setup script** and **Teardown script** under the board's **Flow settings** edit both for the page flow's project. Saving rewrites `config.json` atomically and keeps every other key. A value equal to the default removes the project's own key, so the project keeps following `defaults`; any other value, including an empty one, becomes the project's own.

## Launcher (optional)

The plugin is enough. To manage the server from a terminal:

```bash
ln -s "$PWD/plugins/orchestrator/bin/orchestrator" ~/.local/bin/orchestrator   # once, from the repository root
orchestrator                                # start it if needed, make this checkout the composer's default, open the board on its flow
orchestrator stop | restart | status | logs | serve             # serve: run in the foreground
```

## Settings

| Variable | Default | |
|---|---|---|
| `KANBOARD_PORT` | `4747` | where the server listens and the plugin finds it |
| `KANBOARD_HOME` | `~/.kanboard` | shared Beads workspace, task execution artifacts, agent hosts, `config.json`, `server.log` and built-in worktrees |
| `KANBOARD_PYTHON` | `python3` | the interpreter the plugin and the launcher start the server with |
| `KANBOARD_BRANCH_PREFIX` | `feature/` | suggested branch: `<prefix><ticket>-<title slug>` |
| `KANBOARD_TERMINAL` | `auto` | where this session's tasks are presented: `auto`, `cmux`, `tmux` or `plain`; `OMP_TERMINAL` applies when it isn't set (see [Terminals](#terminals)) |

The rename from Kanboard keeps existing data and running sessions working, so these names stay as they were: the `~/.kanboard` home and every `KANBOARD_*` variable (settings, hook and agent-script environment), the `KB-<n>` IDs, the Beads `kanboard` metadata key, `kanboardReserved` marker and `kanboard` actor, memory keys prefixed `kanboard.`, the browser's `kanboard.*` local storage, the `kanboard.cleanup` omp session entry, and the per-checkout mode file.

Beads is authoritative for task titles, descriptions, plans (`design`), shared context (`notes`), statuses and native blocking dependencies. Existing `KB-<n>` references remain the native Beads issue IDs. Task routing (repository, base, branch, merge and planning mode) is stored in namespaced Beads metadata. All repositories, flows and worktrees served by this board use the external workspace at `$KANBOARD_HOME/beads`; code repositories receive no Beads hooks or agent-instruction changes.

`tasks/KB-<n>/execution.json` retains local execution state: ordering, launch progress, the worktree, agent host and terminal presentation, and merge observations. `board.json` retains flow settings and board context. These are not second copies of task content. The agent's `brief.md`, `omp.yml` and `launch.sh` are generated artifacts; the agent host launches the script rather than sending the full prompt through a terminal's canonical input limit.

Preparation imports legacy `task.json` and `plan.md` data, preserving IDs and dependencies, and keeps a legacy backup before retiring the old task-content files. Stop the old board before preparation; do not run old and new server versions against the same home. Back up the whole home before upgrading; subsequent Beads backups should use its native backup facilities, not only the execution JSON.

Upgrading from a board that ran agents directly in cmux workspaces keeps every worktree and branch, and never restarts or merges a task by itself. A started task whose omp still runs in its old cmux workspace keeps running there: the board adopts that workspace as its terminal and controls the agent through its omp session while that session is connected; otherwise its state is unknown until a complete scan of your processes (every 30 s, `ps` and `lsof`, never terminals) finds none whose working directory is in its worktree, which counts as stopped. A scan that can't read every process leaves the state unknown. That omp can't move into an agent host while it runs, so resuming or cleaning up a task whose state is unknown asks you to confirm it has ended, and stopping it counts only once its connected session has acknowledged and left. From then on, resuming runs it in an agent host. Each card's recorded cmux workspace and surface become its origin terminal once.

To inspect the shared tracker directly:

```bash
BEADS_DIR="${KANBOARD_HOME:-$HOME/.kanboard}/beads/.beads" bd list --all
BEADS_DIR="${KANBOARD_HOME:-$HOME/.kanboard}/beads/.beads" bd show KB-12
```

The default workspace uses embedded Dolt. Board operations serialize its own Beads calls; independent concurrent CLI writers are subject to Beads' embedded-writer locking. This is local task sharing, not automatic cross-machine synchronization.

The plugin retains CLI transport: Beads 1.3.2's HTTP API requires SQL-server mode and cannot serve this embedded workspace. Its events journal works locally but does not cover pulled/merged changes, so the board retains full reconciliation when the database changes. Claims/leases and workflow gates are not enabled.

The integration is verified against Beads 1.3.2. The status mapping is Backlog → `open`, Todo → `todo`, In Progress → `in_progress`, Review → `review`, Done → `closed`. Ordinary `bd create` uses the same sequential ID allocator as the board; preparation reserves previously issued legacy IDs, which can leave a gap.

Outside `bd` edits to task content appear on the board at the next refresh. A new native bead joins the current flow in Backlog. Beads status changes cannot start/resume work or move an already-started task: use the board or `orchestrator_*` tools for those operations so existing approval and concurrency rules still apply. The board restores rejected external status/routing changes and reports why in `server.log`. Deleting a bead removes its card but leaves any worktree; `bd delete` may also rewrite references to that ID in other task descriptions.

## How it works

`server.py` uses only the Python standard library. It serves `index.html` and a JSON API, and pushes board snapshots and agent steps over server-sent events (`/api/events`); an omp session subscribes with its id, its terminal and, in orchestrator mode, its flow, which is how **Discuss in omp** reaches it. A task's omp also subscribes with its task id: the board sends it pause, resume, message, plan review and stop commands, which it carries out through omp's extension API and answers at `/api/control/<id>`.

Module boundaries: `runtime.py` owns process/environment/file helpers, `gitops.py` owns Git operations, `agent_host.py` owns the detached agent hosts and their attach clients, `integrations.py` loads the shared terminal adapters (`omp_terminals.py` from `omp-integrations`), `cmux.py` reads the terminal's Ghostty appearance, and `beads_store.py` owns native task persistence. `server.py` retains scheduling, API routes and live state. Root Python modules all participate in restart detection. The browser keeps task/agent editing in `index.html`, dependency visualization in `pipeline.js`, the Live mosaic in `workbench.js`, native capability controls in `native.js`, and Markdown rendering in `markdown.js`. Tokens, reset, type scale, buttons, tool buttons, segmented controls and fields come from `design-system.css`, a copy of `packages/web-design-system/design-system.css` that `bun run build` refreshes and the plugin ships as is; `index.html`, `pipeline.css`, `workbench.css` and `native.css` hold only board-specific layout and status visuals, and the served `/appearance.css` overrides the tokens last.

- **Agent state:** each task agent's omp reports planning, thinking, working, plan ready for review, needs you (while its question waits) or idle, with the step it is on, its session and its latest prompt. A host whose omp isn't connected reads as **omp disconnected**; a confirmed exit or stop reads as **stopped**. Terminal titles and presentations never decide state.
- **Git stats and Auto route:** refreshed every 10 s; the first task-branch change resolves an undecided Auto task to Fast.
- **Pull requests:** `gh pr list` runs once a minute.
- **Local merges:** `git merge --no-ff --no-edit` with the message `Merge <branch> (KB-n: <title>)`. A conflict aborts that merge, starts `git rebase <base>` in the clean task worktree and retries the merge when rebase succeeds. If rebase conflicts, it remains paused there and the task agent is automatically asked to resolve it. A merge already in progress in the base checkout is left alone.
- **Safety:** the server listens on 127.0.0.1 only. It refuses requests with a foreign `Host` or cross-site `Origin`, and accepts writes only as JSON.
