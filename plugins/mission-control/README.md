# Mission Control

Mission Control is a local board for omp, installed as an omp plugin. For one repository it shows every git worktree, the ones it started and the ones you made yourself, with each worktree's agent, what it waits for, its tags and its pull request. A task is a worktree with its own omp: creating one checks a branch out, starts omp in plan mode on your prompt, and you review that plan in its omp. A task can build on another one: it branches from that task's branch, waits for it after its plan is approved, and resumes on its own once it has landed. Work lands by merging into its parent branch when it was stacked on another task, or through a pull request. Every step works from any omp session as well as from the page.

## Install

```bash
omp plugin marketplace add kodlian/omp-jeremy
omp plugin install mission-control@omp-jeremy
```

Restart omp. Requires `omp`, `bun`, `python3`, `git` and `tmux` (`brew install tmux`); `cmux` is an optional terminal presentation, and `gh` adds pull requests: their state on the cards and **Create pull request**. The plugin starts the server the first time it needs it (output in `~/.mission-control/server.log`) and restarts it when the plugin's server code is newer than the running one. A session that used a Mission Control command or tool brings the server back when it resumes, so pages left open reconnect; task sessions never start it.

### Local development

```bash
git clone https://github.com/kodlian/omp-jeremy.git && cd omp-jeremy
bun install --ignore-scripts
bun run build
omp plugin link plugins/mission-control
```

`bun run test` includes lifecycle tests (`tests/lifecycle.test.ts`) that run a real server in a temporary home against a fake `omp` (`tests/fake_omp.py`), a fake `cmux` CLI (`tests/fake_cmux.py`), a stubbed `gh` and fake `createWorktree`/`removeWorktree` commands. They need tmux and are skipped without it. `tests/import.test.ts` covers the import below and needs Beads.

## Import from the Orchestrator

The first time the server prepares a new home (no `board.json` yet) while `~/.orchestrator/beads` exists, it imports the Orchestrator's started cards once:

- Uninstall the Orchestrator plugin (`omp plugin uninstall orchestrator@omp-jeremy`) and stop its board (`orchestrator stop`) first: both serve port 4747, and the import refuses while the old board answers there.
- It reads the cards with Beads (`bd`), needed only for this. `MISSION_CONTROL_IMPORT=skip` starts empty instead.
- Every open card whose worktree still exists comes over with its `KB-<n>` id and number, title, description (its prompt), ticket, shared context, dependencies and parent among the imported cards, repository, base, branch, Control loop, agent and terminal records, and pull request. Backlog and Todo cards land in Waiting, held; In Progress stays In Progress; Review goes to Pull Request when its pull request is open, else Review. Each card's files under `tasks/<id>/` are copied.
- Open cards without a worktree aren't imported: `not-imported.md` in the new home lists their numbers, titles and descriptions. Stored plans are dropped.
- Projects keep their concurrent-task limit and Control loops, `config.json` comes over with `ORCHESTRATOR_` renamed `MISSION_CONTROL_` (unless the new home already has one), and new cards continue the old numbering as `MC-<n>`.
- The import only reads `~/.orchestrator`: its cards, settings and files stay as they were (Beads updates its own bookkeeping files in `beads/` when it reads). An agent the Orchestrator started keeps running in its tmux session; stop it and resume it from the page so it restarts with this plugin.

## Terminals

Each task's omp runs in a tmux session: cmux's `local-tmux` server when the task's terminal is cmux, otherwise a board-owned `tmux -L mission-control` server (`detach: auto|tmux|cmux` in `config.json` picks one; `auto` is the default). The session outlives the server and every terminal showing it, and its screen feeds the **Agent** tab and `mission_control_screen`. Terminals only present it, according to where the omp session that created the task runs, else the latest omp session that uses the project:

| Session runs in | A new task opens | The page opens in |
|---|---|---|
| cmux | a new background workspace in that cmux window | a browser split of the session's cmux workspace |
| tmux, including tmux inside cmux | a new background window in that tmux session | cmux's browser when cmux surrounds tmux, else the default browser |
| any other terminal | nothing: the card shows the attach command to run in any terminal | the default browser |

Each omp session reports its own terminal when it connects, so sessions in different terminals share one server without sending work to each other's terminals. `MISSION_CONTROL_TERMINAL` (or the shared `OMP_TERMINAL`) set to `cmux`, `tmux` or `plain` forces the presentation for sessions started with it; `auto`, the default, detects it. A forced terminal that isn't available is an error, never a fallback to another one.

The attach command is the card's `tmux … attach-session -t =mc-<id>`; **Ctrl-b d** detaches and omp keeps running. Closing a terminal, a cmux workspace or a tmux window only detaches it. When nothing is attached to its session, resuming or opening the task attaches it, into the task's existing cmux workspace for a session on cmux's `local-tmux` server, else in a new terminal. A page the task's omp opens (Plan Review, `/review`) goes to the cmux workspace named in the agent's `OMP_TERMINAL_PRESENTER`. Whether the agent runs comes from omp's session lease and the tmux pane, never from terminals: a running omp that isn't connected to the server reads as **omp disconnected**, and an agent that exited or was stopped as **stopped**. Resuming an agent that exited cleanly uses `omp --resume`; one that was killed uses `omp --restore`.

## Columns

| Column | What happens |
|---|---|
| Planning | A new task: its worktree is created and its omp starts in plan mode on the prompt. Review the plan in that omp (Plan Review opens it in the browser); **Review plan** on the card opens its terminal. Approving the plan moves the card In Progress, or to Waiting while a task it depends on hasn't landed or the project has no free agent slot. A planning task that commits or edits files while nothing it depends on is open moves In Progress. |
| Waiting | Tasks that wait for what they depend on, for a free slot, or because you paused them. A planned task resumes on its own, in queue order, once everything it depends on is Done and a slot is free. A paused one (**held**) waits until you move it In Progress. Dragging a card here pauses its agent; reordering cards here changes the queue. |
| In Progress | Agents implementing. At most the project's **Concurrent tasks** agents work here; planning, waiting, review and pull-request agents hold no slot. Dragging a card here resumes its agent (a card that still waits asks before resuming it anyway), and a task whose start failed starts again. |
| Review | Work committed in the worktree, its agent idle on its own session, nothing open as a pull request. A task stacked on another one offers **Merge into &lt;base&gt;**; every task offers **Create pull request**. |
| Pull Request | The branch has an open or draft pull request, shown with its number and marks for failing or pending checks, the review decision and conflicts. A merged pull request moves the card to Done; a closed one sends it back In Progress. |
| Done | The work landed: merged into its parent branch, or its pull request merged. Dragging a card here only records it as done. **Remove worktree** stops its agent, closes its terminal and deletes the worktree and the branch. |

People drag cards only to Waiting, In Progress and Done; the other columns are reached on their own. Cards are numbered per project (`#1`, `#2`…) and people and agents use these numbers everywhere: the page, commands, tools, briefs, messages, errors and `Task <n>: <title>` commit subjects. Underneath, new cards have `MC-<n>` ids.

## Projects

One server serves every session, and each page shows one project: one repository, all its base branches together. `/mission` (or the launcher) registers the repository it runs in and opens the page on it (`?project=<id>`; the id is the main checkout's folder name, with a short hash when two registered repositories share it). The header shows the project and its default branch; its menu holds **Concurrent tasks**, **Tag rules** and the **Setup** and **Teardown** scripts. Cards branched from another branch than the default one show a **from &lt;base&gt;** chip.

## Commands

| Command | |
|---|---|
| `/mission` | opens the page on this repository's project, on this worktree's card when it has one |
| `/task <prompt>` | creates a task in a new worktree branched from this checkout's branch; its omp plans the prompt |
| `/next <prompt>` | creates a task that builds on this worktree's card: it branches from this branch, depends on this card and waits for it once its plan is approved. This worktree becomes a card first when it isn't one. In the main checkout, use `/task` |
| `/link #n …` | makes this worktree's card depend on those cards; `/link` lists what it depends on and waits for, `/link none` clears it |
| `/tag a b -c` | adds tags to this worktree's card and removes `c`; `/tag` lists them |
| `/land [pr\|merge]` | lands this worktree's card: merges it into its parent branch when it was stacked on another task (committing pending changes, removing the worktree and ending the session), else opens its pull request; `pr` or `merge` forces one |

`/link` completes card numbers and `/tag` the project's tags. Using any of these commands, or any tool below, makes the session follow the project: it streams the server, gets notified about the cards it created (start failed, plan ready, needs input, resumed, ready to merge or for a pull request, checks failing, merged), and brings the server back when it resumes.

Tools: `mission_control_tasks` (the project's cards with their columns, tags, links and pull requests, then its other worktrees), `mission_control_task` (a new task; `after` stacks it on a card), `mission_control_adopt` (makes a worktree a card), `mission_control_edit` (title, tags, dependencies, parent), `mission_control_link`, `mission_control_children`, `mission_control_move` (Waiting, In Progress or Done, as dragging does), `mission_control_stop`, `mission_control_message` (a message to a task's agent), `mission_control_screen` (the agent's terminal), `mission_control_diff`, `mission_control_context`, `mission_control_publish`, `mission_control_land`, `mission_control_cleanup` and `mission_control_delete`. Your request to land is the approval; landing another card asks whether to keep its worktree, and deleting a card or removing a worktree asks you to confirm. A card's prompt and Control loop are fixed once it exists: tell its agent what changed with `mission_control_message`.

## Linked tasks

A task created **after** another one (`/next`, the composer's **After**, `mission_control_task`'s `after`) branches from that task's branch, depends on it, and plans right away. Once you approve its plan, its omp holds: the card waits in Waiting until every task it depends on is Done and the project has a free slot, then its agent is told what it waited for has landed, to rebase on its base if that moved, and to implement the approved plan. When a task lands, every unfinished task branched from its branch is moved onto its base, where its work went, so a stacked task follows its parent down to the default branch.

**Depends on** in the task panel lists what a task waits for: **+** adds one and **×** removes one; on the Graph, dragging a port onto another task adds one. A cycle, or a task from another repository, is refused. **Parent** groups a task under another one of the same repository, and children also wait for what their parent tree depends on; it never creates nested worktrees.

## Landing

A task branched from another task's branch merges back into it: **Merge into &lt;base&gt;** (with a clean, committed worktree) or `/land` (which first commits pending changes as `Task n: <title>`) run `git merge --no-ff` in the checkout of that branch, optionally removing the worktree and ending its agent. A task branched from the default branch lands through a pull request; a merge is refused.

**Create pull request** works for every task: while its agent is connected and free it is asked to commit everything, push the branch and open the pull request; otherwise the server pushes the committed branch and runs `gh pr create --fill` into its base. It refuses uncommitted changes, a branch with nothing to open, and a base that isn't on `origin`.

## Pull requests

`gh pr list` runs for each project once a minute (and on **Refresh**): open pull requests with their review decision, checks and mergeability, then the latest pull request of every other branch. A card shows its pull request's number with marks for checks (passing, failing or pending), the review (approved or changes requested) and conflicts, and its title says them in words.

## Tags

A task has up to eight tags: short lowercase words (letters, digits, `.`, `_`, `-`). The composer, the task panel and `/tag` set them, and agents add the product areas their work touches with `mission_control_edit`. The tag bar under the toolbar lists the project's tags: selecting some shows only the cards with any of them; none selected shows everything.

**Tag rules** in the project menu tag tasks by name: one rule per line, a pattern then its tags, such as `feature/nutrition-* nutrition`; a pattern matches a task's branch name or its worktree's folder name, with `*` for anything and `?` for one character, ignoring case. A task that is created or tracked gets the tags of every rule it matches, after its own and up to eight. Saving the rules also tags the project's open tasks, and untracked worktrees show the tags they match, so the tag bar filters them too.

## Worktrees

Every linked worktree of a project's repository that no task owns shows on the page as a dashed card in In Progress, Pull Request or Done (by its pull request), with its branch, its base (its `branch.<name>.nestUnder` setting, else the branch its creation record names, else the default branch), its changes and its pull request. Clicking it offers **Track as task**, **Add tags…**, **Start agent**, **Create pull request**, **Open worktree**, **Hide from the board** and **Remove worktree…**; each but hiding first makes it a card. An omp already running in that worktree attaches to the card on its own; without one, **Start agent** (or moving the card In Progress) starts `omp --continue` there. Worktrees on a detached HEAD aren't listed. They don't show in Graph or Live until they are cards.

**Hide from the board** (also in the task panel's ⋯ menu) leaves a branch's card or worktree out of Board, Graph and Live: for long-standing worktrees you keep, such as a feature branch other tasks merge into. The project remembers hidden branches by name, so a worktree made again on that branch stays hidden. **N hidden** at the end of the tag bar shows them, dimmed, with **Show on the board**. A hidden branch stays in the composer's **Branches from**, and tasks stacked on it still merge back into it.

## Graph and Live views

The three icons at the top left switch between **Board** (columns), **Graph** (a dependency canvas) and **Live** (what agents are doing and what waits for you); the choice is remembered in this browser. Search, tags, the task panel and the scheduler apply to every view. Double-click empty space in any view to start a task, as **New task** (`N`) does.

- **Graph:** connections run from prerequisite to dependent task. Drag an output port onto another task to add a dependency, or an input port to choose its prerequisite; click a connection to select it, then reconnect or remove it. Double-click empty canvas to create a task centred where you clicked. Let an output port go on empty canvas to create a task that builds on it: a dashed outline shows where it lands, the composer opens with **After** set to that task (it branches from that task's branch and waits for it; for a Done task, from the branch its work landed in, without waiting), and the new node appears where you let go. Drag more lines onto it to add dependencies. A prerequisite that is planning or waiting gives a dashed line, one In Progress, in Review or with a pull request a line solid for its first half, and a done one a solid line. **Auto-layout**, **Fit all**, **Focus task** and **Hide done** arrange the canvas.
- **Live:** started work and handoffs as tiles with a read-only preview of the agent's terminal (at most four refresh every 3 seconds while Live is visible). Plans ready for review, questions, disconnected sessions, failed starts, missing worktrees, Review and Pull Request cards are handoffs with their action; waiting tasks and the latest done ones are listed below.
- Selecting a task highlights its upstream dependency path in all three views: done prerequisites green, unfinished ones red.

If a worktree was deleted outside the page, its task shows **Worktree missing**, and **Remove card** removes it; it refuses while its agent still runs.

## Pausing and stopping

- **Waiting pauses an agent.** Its turn is interrupted; the worktree, branch, omp session and tmux session stay, and the card frees its slot and stays held until you move it back.
- **In Progress resumes it** when the project has a slot: its agent is told to continue where it stopped. A task paused while it planned plans on.
- **Stop agent…** (⋯ menu, or `mission_control_stop`) also ends its omp and tmux sessions and closes its terminal; a planning or In Progress card is held in Waiting. Resuming starts a new tmux session on the same omp session and presents it again.

Pauses, messages and stops reach the agent through its omp session, never by typing into its terminal. A task whose omp isn't connected can't take them, and the page says so; a pause still moves the card.

## Task sessions

A task's omp knows its card, branch, base and how it lands, what it waits for and which tasks build on it, including after restarting omp in its worktree. Its brief lists the tasks it depends on, its parent and children, the other tasks on the same base and the handoffs of its dependencies. Tell it to merge, or that it's done: for a stacked task your request is the approval, so `/land` (or `mission_control_land`) commits, merges into the parent branch and closes its worktree and agent; a task from the default branch commits, pushes and opens its pull request. It never lands just because it considers the work finished.

`mission_control_publish {kind: "finding" | "outcome", text, id?}` appends a concise finding or outcome to a task's shared context, stamped with its source, time and branch@commit; `mission_control_context {id?}` reads it with its revision. A new task's brief includes the latest outcome and up to three other entries of each task it depends on.

## Control loops

With the [Control](../control/README.md) plugin installed, the composer gets a **Loop** picker listing the project omp's Control loops; a task's loop is fixed once it exists. The task session starts with that loop attached (`OMP_CONTROL_LOOP`, checking the change since the task's base branch), the card shows it as a chip (**needs you** while findings wait), and the panel's **Loop** tab shows the live loop with **Fix** and **Dismiss** for doubtful findings. A loop that finishes on its own (`finish: auto`) merges a stacked task into its parent branch once its checks pass and the agent stops; tasks that land through a pull request are left for you.

## Hooks

`~/.mission-control/config.json` replaces the worktree operations with your own commands. The server reads it at each operation, so a toolkit can register while it runs:

```json
{
  "commands": {
    "createWorktree": "my-wt new \"$MISSION_CONTROL_BRANCH\" --run \"$MISSION_CONTROL_AGENT_COMMAND\"",
    "removeWorktree": "my-wt remove"
  }
}
```

Each command runs with `/bin/sh -c`; a non-zero exit fails the operation with its last output line.

| Command | cwd | Variables | Must | Without it |
|---|---|---|---|---|
| `createWorktree` | repository | `MISSION_CONTROL_TASK`, `MISSION_CONTROL_TITLE`, `MISSION_CONTROL_REPO`, `MISSION_CONTROL_BRANCH` (already created from its base), `MISSION_CONTROL_BASE`, `MISSION_CONTROL_AGENT_COMMAND`, `MISSION_CONTROL_SETUP_SCRIPT` | check the branch out in a worktree; the server then finds it with `git worktree list`. To show the agent in your own terminal, run `$MISSION_CONTROL_AGENT_COMMAND` there: it starts the task's tmux session unless it runs, then attaches to it. The server also runs it again for the existing worktree when the agent needs a terminal and none is in its worktree (a resume after a stop, **Open**), so reuse the branch's worktree when it exists | `git worktree add` under `~/.mission-control/worktrees/<repo>/<branch>`, the setup script in a newly created worktree, then the agent's tmux session, presented in the creating session's terminal |
| `removeWorktree` | worktree | `MISSION_CONTROL_TASK`, `MISSION_CONTROL_REPO`, `MISSION_CONTROL_BRANCH`, `MISSION_CONTROL_WORKTREE`, `MISSION_CONTROL_TEARDOWN_SCRIPT` | remove the worktree and its branch; the agent is already stopped and its terminal closed | refuses with uncommitted changes, runs the teardown script in the worktree, then `git worktree remove` and `git branch -D` |

## Setup and teardown scripts

`config.json` also holds per-project scripts beside `commands`, keyed by the repository's folder name:

```json
{
  "defaults": { "setupScript": "", "teardownScript": "" },
  "projects": {
    "my-app": { "setupScript": "~/kit/setup.sh", "teardownScript": "~/kit/teardown.sh" }
  }
}
```

For each key, the project's own value applies when present, and an empty string means none; otherwise the `defaults` value applies, else none. A value is a script path, `~` allowed, run as `bash <path>` in the worktree with `MISSION_CONTROL_TASK`, `MISSION_CONTROL_REPO`, `MISSION_CONTROL_BRANCH`, `MISSION_CONTROL_BASE` and `MISSION_CONTROL_WORKTREE` set.

- **Without hooks:** the setup script runs after a new worktree is created (not when one is reused) and before the agent starts, and the teardown script in the worktree before `git worktree remove`. A failing script shows in the task's start log or removal output but doesn't stop either.
- **With `createWorktree` or `removeWorktree`:** only the hook knows when the agent starts, so neither script runs; the resolved paths are passed as `MISSION_CONTROL_SETUP_SCRIPT` and `MISSION_CONTROL_TEARDOWN_SCRIPT` instead (empty means none).

**Setup script** and **Teardown script** in the page's **Project settings** edit both. Saving rewrites `config.json` atomically and keeps every other key; a value equal to the default removes the project's own key.

## Launcher (optional)

The plugin is enough. To manage the server from a terminal:

```bash
ln -s "$PWD/plugins/mission-control/bin/mission-control" ~/.local/bin/mission-control   # once, from the repository root
mission-control                                # start it if needed, register this repository, open the page on it
mission-control stop | restart | status | logs | serve             # serve: run in the foreground
```

## Settings

| Variable | Default | |
|---|---|---|
| `MISSION_CONTROL_PORT` | `4747` | where the server listens and the plugin finds it |
| `MISSION_CONTROL_HOME` | `~/.mission-control` | `board.json`, task records, `config.json`, `server.log` and built-in worktrees |
| `MISSION_CONTROL_PYTHON` | `python3` | the interpreter the plugin and the launcher start the server with |
| `MISSION_CONTROL_BRANCH_PREFIX` | `feature/` | a new task's branch: `<prefix><ticket>-<title slug>`, with `-2`, `-3`… when taken |
| `MISSION_CONTROL_TERMINAL` | `auto` | where this session's tasks are presented: `auto`, `cmux`, `tmux` or `plain`; `OMP_TERMINAL` applies when it isn't set |
| `MISSION_CONTROL_IMPORT` | | `skip` starts a new home empty instead of importing |

## Storage

Plain JSON in `MISSION_CONTROL_HOME`:

- `board.json`: the next card number and the registered projects with their concurrent-task limit, Control loops, hidden branches and tag rules.
- `tasks/<id>/task.json`: one record per task: title, prompt, column, links, tags, shared context, repository, base, branch and loop, plus what runs for it (worktree, agent session and terminal, the operation in progress and the last one's result, its pull request and merge).
- Generated per task: `brief.md`, `omp.yml` (plan mode on startup), `launch.sh` and `resume.sh`, and the last screen of an agent that exited.

## How it works

`server.py` uses only the Python standard library. It serves `index.html` and a JSON API and pushes snapshots and agent steps over server-sent events (`/api/events`). A snapshot holds the columns, the projects, the tasks and the worktrees no task owns; the cmux sidebar reads its tasks (`id`, `title`, `worktree`, `agent`) and their `step` events. An omp session subscribes with its id, its terminal and, once it uses Mission Control, its project; a task's omp also subscribes with its task id and carries out the pause, message, Control and stop commands the server sends it, answering at `/api/control/<id>`. When you approve a plan, the task's omp reports it at `/api/tasks/<id>/planned`, and the reply says whether to hold.

Module boundaries: `runtime.py` owns process, environment and file helpers, `gitops.py` Git operations, `detach.py` the agents' tmux sessions, `lease.py` omp's session leases, `screen.py` styled screen previews, `integrations.py` the shared terminal adapters (`omp_terminals.py` from `omp-integrations`), `cmux.py` the terminal's Ghostty appearance, and `import_orchestrator.py` the one-time import. `server.py` keeps the store, scheduling, API routes and live state. The page keeps the board, panel and composer in `index.html`, the dependency canvas in `pipeline.js`, the Live mosaic in `workbench.js`, dependencies, parents and shared context in `links.js`, and Markdown rendering in `markdown.js`; `design-system.css` is a copy of `packages/web-design-system/design-system.css` that `bun run build` refreshes.

- **Agent state:** each task's omp reports planning, thinking, working, plan ready for review, needs you or idle, with the step it is on, its session and its latest prompt.
- **Git:** each worktree's changes, commits and uncommitted files refresh every 10 s; worktrees no task owns every 30 s.
- **Local merges:** `git merge --no-ff --no-edit` with the message `Merge <branch> (task n: <title>)`. A conflict aborts that merge, starts `git rebase <base>` in the clean task worktree and retries the merge when the rebase succeeds; a conflicted rebase stays paused there and the task's agent is asked to resolve it.
- **Safety:** the server listens on 127.0.0.1 only. It refuses requests with a foreign `Host` or cross-site `Origin`, and accepts writes only as JSON.
