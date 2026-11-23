# omp-control

Controls for omp. A **control** is a shell check (a command that must exit 0) or a reviewer (instructions a read-only subagent follows to audit the change); a **set** groups a few of them. `/control` picks a set, or controls one by one, and runs them on the session's change as a feedback loop: the agent runs the checks, spawns one subagent per reviewer, fixes what they find, then runs another pass to confirm the fixes. Run them once, or turn on auto mode to run them after each request that changes code.

## Install

```sh
omp plugin marketplace add kodlian/omp-jeremy
omp plugin install control@omp-jeremy
```

Restart omp. Controls need a git repository. They check everything since the branch left its default branch (`origin`'s default, else `main` or `master`), committed or not; on the default branch itself they check what isn't pushed yet. A task session started by the Orchestrator checks the change since its base branch.

## Use

`/control` lists:

- **The sets** (`Review (review)`, `Quality (quality)` and your own), then **Run once** or **Auto: after each request that changes code**.
- **Pick controls…**: tick the controls, choose what happens to findings (**Apply right away** or **Ask me before applying**) and when they run.
- **Turn auto off**, while auto is on.

A run sends the agent one message. It runs the shell checks from the repository root, with `$CONTROL_BASE` set to the commit the change is measured from, and fixes what fails. Then it spawns the reviewers, all at once: each reads its control file and the change, and never edits files. What happens to their findings depends on the approval:

- **Apply**: the agent fixes every certain finding and the judgment calls it agrees with.
- **Ask**: the agent shows you each finding in omp's ask dialog, its own recommendation preselected, and fixes only what you approve.

If it changed anything, it runs another pass to confirm, at most three in all. It ends the run with `control_report`, passed or not, and sums up what each control found, what it fixed and what is left.

Reviewers run as omp's default subagent, never as a named agent from your configuration (`reviewer`, `code-reviewer`, `scout`…): the control file alone decides what a reviewer does.

In auto mode, when the agent finishes a request that changed the code, Control sends it back into a run instead of letting it stop. A request that changes no file starts no run, and neither does a change that already went through one. If the agent stops in the middle of a run without reporting, Control sends it back twice, then lets it stop and tells you.

The line under the editor reads `Control · running Review` during a run, and `Control · auto · Review · ✓ passed` (or `✗ not passed`) while auto is on.

## Library

Controls and sets come from three levels; a project item overrides a global one with the same id, which overrides a built-in one:

- **Project:** `.omp/control/nodes/*.md` and `.omp/control/sets/*.json`, committed and shared with everyone on the project
- **Global:** `~/.omp/control/…` (or `$OMP_CONTROL_HOME`), yours in every project
- **Built-in**, shipped with the plugin: the reviewers **Quality** (bugs, edge cases and regressions), **Conventions** (consistency with the existing code, as simple as the goal allows) and **Project rules** (AGENTS.md and CLAUDE.md, root and nested, the docs they link, the project's rule files and the skills that apply), and the sets **Review** (all three) and **Quality**.

A control is a Markdown file with a header; a reviewer's body is its instructions:

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
resources:
  - docs/STYLE.md
---

Check that every changed flag and endpoint is documented…
```

Header keys: `name`, `kind` (`check` or `review`), `description`, `command` and `timeout` (checks: seconds before the command is stopped, default 900) and `resources` (reviewers: paths, `skill://` or web URLs to read first; missing ones are skipped). Other keys are ignored. A check runs with `sh`, so it can check only what changed (`git diff --name-only "$CONTROL_BASE"`).

A set is a JSON file: `{ "name": "Docs", "description": "Docs and quality", "controls": ["docs-reviewer", "quality-reviewer"], "approval": "ask" }`. `controls` lists 1 to 12 control ids; `approval` is `apply` (the default) or `ask`. A set that names a missing control is skipped, and `/control` lists the files that don't load.

## With the Orchestrator

When both plugins are installed, the board's composer and card panel get a **Controls** picker listing the sets (fixed once the card starts). The card's task session starts with that set in auto mode, checking the change since the card's base branch. When the last run passed and the set's approval is `apply`, a task that merges locally auto-merges once the agent stops.

## Local development

From the repository root: `bun install --ignore-scripts && bun run build && bun run test`, then `omp plugin link plugins/control`. The build bundles `dist/extension.js`; commit it, since marketplace installs don't build.
