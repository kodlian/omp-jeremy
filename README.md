# omp-jeremy

Four plugins for [omp](https://github.com/can1357/oh-my-pi): see every worktree of a project and every omp running in it with Mission Control, comment on plans right in omp's plan review, review changes in the browser, and audit changes with reviewer subagents and shell checks.

## Mission Control

See every checkout of a repository, its main checkout and each worktree, with every omp running in it (what it is doing, its run clock, its to-do progress, the question it asks), its changes and its pull request. It only watches: open a worktree's terminal, resume an asleep session, create the pull request, or remove a merged worktree, from the same buttons on every card. See [plugins/mission-control](plugins/mission-control/README.md).

## Git Diff Review

Open a browser-based diff viewer from omp with `/review`. Browse changed files, comment on individual lines, and send review feedback directly to your agent.

## Control

Pick checks and reviewers with `/control` and run them on the session's change, once or after every change: the agent runs the shell checks, spawns read-only reviewer subagents, fixes what they find (or asks you first), then runs a second pass to confirm. Controls and the sets that group them live in `.omp/control` (project) and `~/.omp/control` (user). See [plugins/control](plugins/control/README.md).

## Plan Review

When omp shows a plan for review, select any of its lines with a click, a drag, or `a` and the arrow keys, then press `c` or Enter to comment. The comment becomes one of omp's own plan comments: omp shows it under the line and sends it when you pick Refine. See [plugins/plan-review](plugins/plan-review/README.md).

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

Mission Control needs Python 3 and Git; `gh` adds pull requests, and cmux lets it bring a terminal forward. It replaces the Orchestrator plugin: uninstall that one (`omp plugin uninstall orchestrator@omp-jeremy`) before installing it.

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
