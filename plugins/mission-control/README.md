# Mission Control

Mission Control is a local page for omp, installed as an omp plugin. For each repository you register it shows every checkout, the main checkout and every linked worktree, with every omp running in it: what each is doing, its run clock, its to-do progress, the question it asks you. It also shows each checkout's changes, newest commit and pull request. It only watches: it never starts an agent, and never opens, attaches or closes a terminal on its own.

## Install

```bash
omp plugin marketplace add kodlian/omp-jeremy
omp plugin install mission-control@omp-jeremy
```

Restart omp. Requires `omp`, `bun`, `python3` and `git`; `gh` adds pull requests, and `cmux` lets the page bring a terminal forward. `/mission` starts the server when it isn't running (output in `~/.mission-control/server.log`), restarts it when the plugin's server code is newer than the running one, registers the repository you are in and opens the page on it.

### Local development

```bash
git clone https://github.com/kodlian/omp-jeremy.git && cd omp-jeremy
bun install --ignore-scripts
bun run build
omp plugin link plugins/mission-control
```

`bun run test` includes `tests/worktrees.test.ts`, which runs a real server in a temporary home against a temporary repository, a fake `cmux` CLI (`tests/fake_cmux.py`), a stubbed `gh` and `omp`, and `createWorktree`/`removeWorktree` hooks like the kit's.

## Checkouts

Every checkout of a registered repository is a card: the main checkout (marked **main checkout**), each linked worktree on a branch, and each worktree on a detached HEAD (**detached &lt;commit&gt;**, named by its folder). A card is named as the cmux kit's sidebar names its row: a worktree by its branch's last segment, with the other segments as a folder chip (`feature`), the main checkout by its branch. A card shows:

- **Its omp:** every omp running there (one holds the lease of one of its sessions): its state (Planning, Thinking, Working, Needs you, Plan ready, Idle) with its run clock since your prompt, its to-do progress (3/7), and what it is on: the question it asks, the to-do in progress, the latest sentence it thought or wrote, the step it takes, your latest prompt. Without a running omp, **Asleep** with when its latest session was last active and that session's title, else **No omp session**. Sessions come from omp's files under `~/.omp/agent/sessions`.
- **Its work:** lines added and removed since the branch it was made from (its `branch.<name>.nestUnder` setting, else the branch its creation record names, else the default branch), uncommitted files, and its newest commit.
- **Its pull request:** number, state, failing or pending checks, the review decision, conflicts and unresolved review comments.

Columns follow from that, first match wins:

| Column | A checkout is here when |
|---|---|
| Done | its pull request merged, or its branch moved since it was created and its tip is in the default branch, with nothing uncommitted and no omp running |
| Pull Request | its pull request is open or a draft |
| Waiting | its omp holds an approved plan until what it depends on lands, or it depends on a checkout that isn't Done and no omp there is planning, working or asking you something |
| Planning | an omp there is in plan mode, or its plan waits for your review |
| In Progress | an omp there is working, thinking or asking you something |
| Review | it has commits of its own and nothing is at work there: ready for a pull request |
| Idle | anything else: a fresh, stale or abandoned worktree, and the main checkout when nothing works there |

The board shows them in the order Planning, Waiting, In Progress, Review, Pull Request, Idle, Done.

Every card, in every view, has the same buttons, in this order:

- **Open worktree** brings forward a terminal already there: the one an omp there reported, else any terminal in the checkout. It never opens, attaches or closes one; with none, it shows the `cd` to run.
- **Open PR #n** when the branch has a pull request, else **Create PR** when it has commits of its own: `git push -u origin <branch>`, then `gh pr create --base <base> --head <branch> --fill`.
- **Resume** when an asleep session is there: a new terminal in the checkout runs `omp --resume` on exactly that session, never continuing an interrupted turn on its own. Nothing resumes by itself.
- **⋯**: **Hide from the board** (or **Show on the board**), and **Remove worktree…**, offered except on the main checkout and while an omp runs there. A worktree with uncommitted files asks again before they are lost.

**New worktree** (`N`, or double-click empty space) takes a prompt, a branch and **After**, each optional but a prompt or a branch is needed:

- **Branch:** given, else `feature/<the prompt's first words>` (`-2`, `-3`… when taken). It is created from the default branch, or from **After**'s branch, after fetching `origin`.
- **After** another checkout: the new branch is made from that checkout's branch (recorded as `branch.<name>.nestUnder`, so the cmux kit nests it there), and the new worktree depends on it.
- **Prompt:** its omp starts in plan mode on it, told which branch it works on and what it builds on. Approve the plan in that omp; if what it depends on hasn't landed yet, the omp holds the plan (the card shows **Waiting**), and once it has landed the omp tells its agent to rebase and implement the approved plan. Without a prompt, your usual agent starts.
- It is checked out through the `createWorktree` hook when you have one (the cmux kit's `wt` opens its own workspace running the agent), else in `~/.mission-control/worktrees/<repo>/<branch>` with the project's setup script, and, with a prompt, a new terminal there.

When a branch lands, the worktrees made from it move onto its base, where its work went.

**Hide from the board** leaves a branch's checkout out of Board, Graph and Live: for long-standing worktrees you keep. The project remembers hidden branches by name. **N hidden** at the end of the tag bar shows them, dimmed, with **Show on the board**.

**Dependencies:** a worktree depends on the worktree whose branch it was made from (the branch the cmux kit nests it under); that link comes from git, so it can't be removed by hand. It can depend on others too, for work that builds on another branch: draw them on the Graph, use **Depends on…** in a card's ⋯ menu or its panel, or `/link` in omp. A card lists the prerequisites that haven't landed as **Waits for &lt;name&gt;**, and once all are Done shows **Builds on &lt;name&gt; ✓**. A cycle is refused, and removing a worktree drops its dependencies.

**Tags:** a worktree has its own tags (the panel, `/tag`, `mission_control_edit`) and those its project's tag rules give it, up to eight. The tag bar filters every view by them.

**The panel:** clicking a card opens everything about its worktree on the right: its omps with what each is on, its work and newest commit, its pull request, what it depends on and what depends on it, and its tags. Selecting a card highlights its dependency path in every view: Done prerequisites green, open ones red.

## Views

The three icons at the top left switch between **Board** (the columns), **Graph** and **Live**; the choice is remembered in this browser. Search and tags apply to every view.

- **Graph:** an infinite canvas of the project's checkouts. Drag a node anywhere; its place is kept for the project. A new canvas, or **Auto-layout** (which forgets every place), lists the checkouts that depend on nothing top to bottom in the sidebar's order, grouped by folder, and puts each dependent to the right of what it depends on, one column per level. Drag a node's output port onto another node to make that one depend on it, or its input port onto the node it depends on. Let an output port go on empty canvas to create a worktree there that depends on it. A line is dashed while its prerequisite is In Progress, solid for its first half while it has an open pull request, and solid once it is Done. Click a drawn line to select it, then remove it. Drag the background to pan and scroll to zoom; **Fit all**, **Auto-layout** and **Hide done** arrange the canvas.
- **Live:** the checkouts where an omp runs, main checkout first, each with one block per omp and an **Open terminal** button that brings that omp's own terminal forward. The other checkouts are listed below, the most recently active first. The summary counts the omps that need you, that work, the asleep sessions and the done checkouts.

## Projects

One server serves every project, and each page shows one (`?project=<id>`; the id is the main checkout's folder name, with a short hash when two registered repositories share it). `/mission` or the launcher registers the repository it runs in. The project menu holds **Tag rules** and the **Setup** and **Teardown** scripts.

## Tags

**Tag rules** in the project menu tag checkouts by name: one rule per line, a pattern then its tags, such as `feature/nutrition-* nutrition`. A pattern matches a checkout's branch name or its folder name, with `*` for anything and `?` for one character, ignoring case; up to eight tags apply. The tag bar under the toolbar lists the project's tags: selecting some shows only the checkouts with any of them.

## Agents

Every omp session in a git checkout reports to the board at `POST /api/agent`: its state, the step it is on, its run clock, to-do progress, latest sentence, the question it asks, your latest prompt and its terminal. A state change goes out at once, a new step at most every two seconds, and the current state again every 20 seconds, so a restarted board catches up. A report from outside a registered project is refused, and that omp tries again a minute later. An omp's report is dropped once its session lease is released.

## Commands and tools

| Command | |
|---|---|
| `/mission` | opens the page on this repository's project, starting the server when needed |
| `/task <prompt>` | a new worktree branched from this checkout's branch; its omp plans the prompt |
| `/next <prompt>` | a new worktree after this one: branched from it, depending on it, holding its approved plan until this one lands |
| `/link <name> …` | makes this checkout depend on those (`/link -<name>` removes one); `/link` lists what it depends on, what depends on it and what it waits for |
| `/tag a b -c` | adds tags to this checkout and removes `c`; `/tag` lists them |

`/link` completes checkout names and `/tag` the project's tags. A session that created worktrees with `/task`, `/next` or `mission_control_task` follows them and is told when a plan is ready for review, an omp needs your input, one waits, is ready for a pull request, its checks fail or changes are requested, and when it lands.

Tools: `mission_control_checkouts` (read-only: the checkouts of this project, or of all, with their column, dependencies, work, pull request, tags and omps), `mission_control_task` (a new worktree with a prompt; `after` stacks it on this checkout), `mission_control_link` and `mission_control_edit` (tags).

## Hooks

`~/.mission-control/config.json` replaces creating and removing worktrees with your own commands. The server reads it at each operation:

```json
{
  "commands": {
    "createWorktree": "my-wt new \"$MISSION_CONTROL_BRANCH\"",
    "removeWorktree": "my-wt remove"
  }
}
```

Each command runs with `/bin/sh -c`; a non-zero exit fails the operation with its last output line.

| Command | cwd | Variables | Must | Without it |
|---|---|---|---|---|
| `createWorktree` | repository | `MISSION_CONTROL_REPO`, `MISSION_CONTROL_BRANCH`, `MISSION_CONTROL_BASE` (the default branch), `MISSION_CONTROL_SETUP_SCRIPT` | check the branch out in a worktree; the server then finds it with `git worktree list` | `git worktree add` under `~/.mission-control/worktrees/<repo>/<branch>` (the local branch, else `origin/<branch>`, else a new branch from the default branch), then the setup script |
| `removeWorktree` | worktree | `MISSION_CONTROL_REPO`, `MISSION_CONTROL_BRANCH` (empty when detached), `MISSION_CONTROL_WORKTREE`, `MISSION_CONTROL_TEARDOWN_SCRIPT` | remove the worktree and its branch; when you confirmed losing uncommitted files, `y` is on its standard input | the teardown script in the worktree, then `git worktree remove --force` and `git branch -D` |

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

For each key, the project's own value applies when present, and an empty string means none; otherwise the `defaults` value applies, else none. A value is a script path, `~` allowed, run as `bash <path>` in the worktree with `MISSION_CONTROL_REPO`, `MISSION_CONTROL_BRANCH` and `MISSION_CONTROL_WORKTREE` set. With a hook, neither script runs: the resolved paths are passed to it instead (empty means none). **Setup script** and **Teardown script** in the page's project menu edit both; saving rewrites `config.json` atomically and keeps every other key.

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
| `MISSION_CONTROL_HOME` | `~/.mission-control` | `board.json`, `config.json`, `server.log` and built-in worktrees |
| `MISSION_CONTROL_PYTHON` | `python3` | the interpreter the plugin and the launcher start the server with |
| `MISSION_CONTROL_TERMINAL` | `auto` | the terminal this session reports and `/mission` opens the page in: `auto`, `cmux`, `tmux` or `plain`; `OMP_TERMINAL` applies when it isn't set |

## Storage

`board.json` in `MISSION_CONTROL_HOME` holds the registered projects with their hidden branches, tag rules, dependencies and Graph places, each by branch. Everything else is read live: checkouts from git, sessions from omp's files and leases, pull requests from `gh`.

## How it works

`server.py` uses only the Python standard library. It serves `index.html` and a JSON API and pushes a snapshot of the projects and their checkouts over server-sent events (`/api/events`) after each change. A full scan of every checkout (its work, base and whether it landed) runs every 15 seconds and after each change made from the page; which omp runs where is checked every 3 seconds, pull requests every minute.

Module boundaries: `runtime.py` owns process, environment and file helpers, `gitops.py` Git queries, `sessions.py` omp's session files, `lease.py` omp's session leases, `integrations.py` the shared terminal adapters (`omp_terminals.py` from `omp-integrations`), and `cmux.py` the terminal's Ghostty appearance. `server.py` keeps the projects, the checkouts, the agent reports and the API. The page keeps the board in `index.html`, the branch tree in `pipeline.js` and Live in `workbench.js`; `design-system.css` is a copy of `packages/web-design-system/design-system.css` that `bun run build` refreshes.

The server listens on 127.0.0.1 only. It refuses requests with a foreign `Host` or a cross-site `Origin`, and accepts writes only as JSON.
