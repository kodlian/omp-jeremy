# omp-control

Control flows for omp. A flow is one or two control loops. The **implement loop** measures each change the agent makes with **checks**: command checks (shell commands that must exit 0) and AI checks (separate read-only omp runs that see only their instructions, resources and the change). Certain findings go straight back to the agent; doubtful ones go to you. It repeats until the change is clean, or until the pass limit hands what's left to you, and then ends with **your review** of the final change, unless the flow finishes on its own. A flow can add a **plan loop** in front: each request starts in omp plan mode, and either you approve the plan in omp's plan review, or one AI reviewer reads it, sends it back to be revised until it's clean, and approves it (after the pass limit, the plan comes to you); the approved plan then feeds the implement loop.

## Install

```sh
omp plugin marketplace add kodlian/omp-jeremy
omp plugin install control@omp-jeremy
```

Restart omp. Loops need a git repository. They check everything since the branch left its default branch (`origin`'s default, else `main` or `master`), committed or not, so attaching a flow to finished work reviews it right away; on the default branch itself they check what isn't pushed yet. A task session started by the Orchestrator checks the change since its base branch. `/control since <branch or commit>` (or **Check changes since…** on the page) measures from somewhere else.

## Use

| Command | What it does |
|---|---|
| `/control` or `/control open` | Opens the Control page (a cmux split, else the browser) |
| `/control use <loop>` | Attaches a library loop to the session; without an id, picks one |
| `/control off` | Detaches the loop |
| `/control pause` / `resume` | Lets the agent finish without checks, then turns them back on |
| `/control status` | Shows the loop, the pass and the latest findings |
| `/control check` | Runs the loop on the code as it is now, even if it already passed |
| `/control since <branch or commit>` | Checks everything since a branch (where this branch left it) or a commit, and starts the loop |
| `/control draft <what it should check>` | Asks the agent to research the project and save a new check or reviewer |

Once a flow is attached, the agent calls `control_check` before its final answer. If it tries to stop with unchecked changes, the flow sends it back; after three such stops it lets the agent stop and warns you. A pass runs the stages in order (a stage's checks run together) and stops at the first stage with findings the agent must fix, so AI checks never read code that doesn't build.

In a flow with planning, Control enters plan mode whenever the session goes idle, so each new request plans first. Leave plan mode yourself to send a quick request straight to the implement loop.

Findings a check is sure of go straight back to the agent, and only those stop the later stages. Findings it isn't sure of don't interrupt: the loop keeps going, and they wait until nothing certain is left, then come to you all at once: pick one of the fixes the reviewer proposes or **Leave it as is**, add a comment for the agent to any choice (or send only a comment and let the agent decide), or press Esc to pause the flow. The Control page and the Orchestrator card panel offer the same decisions. Every answer is remembered for the session, even when a reviewer words the finding differently later: a dismissed finding stays dismissed, a finding you said to fix goes back to the agent with your note instead of asking you again, and reviewers are told all your answers and the notes you sent back from your reviews, so they don't flag them again. A finding the agent fixed on its own that comes back goes to you, marked **again**.

The implementing agent doesn't stop to ask either: when it makes a choice it isn't sure of, it sends it with `control_check` (the question, the options it considered, the one it chose). Its questions come to you with the reviewers' doubts: keep its choice, or pick another option and it goes back to the agent as a fix. Answers are remembered like the others.

A flow ends in one of two ways (`finish` in its file, the toggle under the diagram in the editor):

- **Review** (the default): once everything is settled (nothing left to fix, every doubt answered), you review the final change: a summary (the request, the files grouped by folder with line counts, what the loop fixed) in omp, and on the Control page the change's size and the images the checks wrote; with git-diff-review installed, **Open in Review** reads the change there, in its own tab. **Approve** ends the loop; **Send back** gives the agent your note. The page opens on its own when your review is due and it isn't open already. If you send a new request before answering, the review stays open and covers both requests; finished reviews are listed under **Past reviews**.
- **Auto**: the change is done once the checks pass, without your review. In an Orchestrator task that merges locally, the task then merges on its own; a pull-request task leaves the PR to you.

The agent can also manage the library with `control_library` (list, read, save), attach a loop with `control_attach`, and show the run with `control_status`.

## Library

Flows and checks come from three levels; a project item overrides a global one with the same id, which overrides a preset:

- **Project:** `.omp/control/loops/*.json` and `.omp/control/nodes/*.md`, committed and shared with everyone on the project
- **Global:** `~/.omp/control/…` (or `$OMP_CONTROL_HOME`), yours in every project
- **Presets**, shipped with the extension: **Plan, you approve, you review** (no checks), **Plan, review, sign off** (you approve the plan, then reviewers and your review), **Auto plan, review, sign off** (the same, with an AI reviewer approving the plan), **Plan first**, **Review**, **Quality** and **Autopilot** (reviewers, then done without your review). Their reviewers are **Quality** (bugs and regressions), **Conventions** (consistency with the existing code) and **Project rules**, which checks the change against AGENTS.md and CLAUDE.md (root and nested), the docs they link, the project's rule files and the skills that apply.

A command check runs with `sh` from the repository root, with `$CONTROL_BASE` set to the commit the change is measured from, so it can check only what changed (`git diff --name-only "$CONTROL_BASE"`). Images it writes to `$CONTROL_ARTIFACTS` (PNG, JPEG, GIF or WebP; the folder is emptied before each run, at most 24 are kept) are shown with your review on the Control page: a check that renders the screens the change touches lets you see them before you approve.

A node is a Markdown file with a header; a reviewer's body is its instructions:

```markdown
---
name: Tests
kind: check
command: bun run test
timeout: 900
---
```

```markdown
---
name: Docs reviewer
kind: review
description: The docs match the code's behavior
ask: doubts
tools:
  - read
  - grep
resources:
  - docs/STYLE.md
---

Check that every changed flag and endpoint is documented…
```

Header keys: `name`, `kind` (`check` or `review`), `description`, `command` (checks), `timeout` (seconds), `ask` (`doubts`: uncertain findings go to you; `all`; `never`), `model`, `thinking`, `tools` (reviewers only: `read`, `grep`, `glob`, `find`, `ast_grep`, `web_search`) and `resources` (paths, `skill://` or web URLs the reviewer reads first). A flow is `{ "name", "description", "maxPasses", "plan", "planReviewer", "stages": [{ "nodes": ["tests"] }, { "nodes": ["quality-reviewer", "docs-reviewer"] }], "finish": "review" }`; `plan` is `none` (default), `you` (you approve the plan) or `ai` (`planReviewer`, a node id such as `plan-reviewer`, approves it), `stages` may be empty (only your review), and `finish` is `review` (default) or `auto`. Files with errors are listed on the page and skipped.

## Page

With no flow attached, the Control page lists the library's flows: pick one to see its diagram and, in plain words, what happens from now on, then **Use from now on**. With a flow attached, it shows the flow as control-loop block diagrams with live states (click a check to filter its findings), the decisions waiting for you and your review; the flow's name opens Switch, Edit, Library and Detach. **Edit** opens the same diagram with **+** slots: add a command or AI check, run checks together, plan first with your approval or an AI reviewer's (or not at all), choose how the flow finishes, then **Use in this session** or **Save to ▾** Project or Global. The Library lists flows and checks by level with Edit, Copy to, Move to and Delete; **Draft with omp** asks the agent to research the project and save a check. Back and Esc go up one level.

## With the Orchestrator

When both plugins are installed, the board's composer and card panel get a **Loop** picker (fixed once the card starts), the card's session runs that loop, and the card's **Loop** tab shows the live graph and takes decisions.

## Local development

From the repository root: `bun install --ignore-scripts && bun run build && bun run test`, then `omp plugin link plugins/control`. The build bundles `dist/extension.js` and `web/dist/`, and copies `web/design-system.css`, `web/control-view.css` and `python/omp_terminals.py`; commit them, since marketplace installs don't build.
