# omp-jeremy

Four plugins for [omp](https://github.com/can1357/oh-my-pi): run coding tasks in their own worktrees from Mission Control, review their plans and changes in the browser, and audit changes with reviewer subagents and shell checks.

## Mission Control

See every worktree of a repository with its agent, what it waits for, its tags and its pull request. A task is a worktree whose omp plans your prompt first; tasks build on each other's branches, wait for each other, and land by merging into their parent branch or through a pull request. Tasks are plain JSON in `~/.mission-control`, and open Orchestrator cards are imported once. See [plugins/mission-control](plugins/mission-control/README.md).

## Git Diff Review

Open a browser-based diff viewer from omp with `/review`. Browse changed files, comment on individual lines, and send review feedback directly to your agent.

## Control

Pick checks and reviewers with `/control` and run them on the session's change, once or after every change: the agent runs the shell checks, spawns read-only reviewer subagents, fixes what they find (or asks you first), then runs a second pass to confirm. Controls and the sets that group them live in `.omp/control` (project) and `~/.omp/control` (user). With Mission Control also installed, a task picks a set that its session runs after every change. See [plugins/control](plugins/control/README.md).

## Plan Review

When omp asks you to review a plan, the plan opens in the browser (a cmux split when in cmux): comment on its lines as in a code review, then refine or approve it from the page. A revised plan highlights what changed since the previous one, and a sidebar jumps between its sections. See [plugins/plan-review](plugins/plan-review/README.md).

## Install from the marketplace

Once this repository is pushed to GitHub:

```sh
omp plugin marketplace add kodlian/omp-jeremy
omp plugin install mission-control@omp-jeremy
omp plugin install git-diff-review@omp-jeremy
omp plugin install control@omp-jeremy
omp plugin install plan-review@omp-jeremy
```

Install each plugin independently. Restart omp after installing extensions.

omp only picks up a new release when its version in `.omp-plugin/marketplace.json` goes up. To have omp install new releases when it starts, run `omp config set marketplace.autoUpdate auto`; the default, `notify`, only writes to omp's debug log. To update by hand, run `omp plugin marketplace update omp-jeremy`, then `omp plugin upgrade`, and restart omp.

Mission Control needs Python 3, Git and tmux (`brew install tmux`); `gh` adds pull requests. It replaces the Orchestrator plugin: uninstall that one (`omp plugin uninstall orchestrator@omp-jeremy`) before installing it.

## Local development

Install [Bun](https://bun.sh), then run from the repository root:

```sh
bun install --ignore-scripts
bun run build
bun run test
```

Commit the generated plugin bundles, Python helpers and review web assets after rebuilding: marketplace installs do not run build scripts. To release, raise the plugin's version in both its `package.json` and `.omp-plugin/marketplace.json`; without that, marketplace installs never see the change.

The marketplace can also be added from a local checkout:

```sh
omp plugin marketplace add /path/to/omp-jeremy
omp plugin install mission-control@omp-jeremy
```

*The plugins share terminal, theme and font integrations, plus a [web design system](packages/web-design-system/README.md) for consistent typography and controls. Build from the repository root to update the standalone assets shipped with each plugin.*
