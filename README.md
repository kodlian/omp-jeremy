# omp-jeremy

Four plugins for [omp](https://github.com/can1357/oh-my-pi): orchestrate coding tasks across worktrees, review their plans and changes in the browser, and check every change with control loops before the agent finishes.

## Orchestrator

Turn plans into tasks that run in their own Git worktrees. Track dependencies, review agent plans, send feedback, and merge completed work back into the parent branch. Tasks and context are stored in Beads.

## Git Diff Review

Open a browser-based diff viewer from omp with `/review`. Browse changed files, comment on individual lines, and send review feedback directly to your agent.

## Control

Attach a control loop to a session with `/control use <loop>`: when the agent says it's done, checks (shell commands that must exit 0) and focused reviewer agents measure its change. Certain findings go back to the agent to fix, doubtful ones to you, until the change is clean or the pass limit hands it to you. Loops and nodes live in `.omp/control` (project) and `~/.omp/control` (user); `/control` opens a page with the live loop, a visual loop editor and the library. With the Orchestrator also installed, cards pick a loop and their panel shows it live. See [plugins/control](plugins/control/README.md).

## Plan Review

When omp asks you to review a plan, the plan opens in the browser (a cmux split when in cmux): comment on its lines as in a code review, then refine or approve it from the page. A revised plan highlights what changed since the previous one, and a sidebar jumps between its sections. See [plugins/plan-review](plugins/plan-review/README.md).

## Install from the marketplace

Once this repository is pushed to GitHub:

```sh
omp plugin marketplace add kodlian/omp-jeremy
omp plugin install orchestrator@omp-jeremy
omp plugin install git-diff-review@omp-jeremy
omp plugin install control@omp-jeremy
omp plugin install plan-review@omp-jeremy
```

Install each plugin independently. Restart omp after installing extensions.

omp only picks up a new release when its version in `.omp-plugin/marketplace.json` goes up. To have omp install new releases when it starts, run `omp config set marketplace.autoUpdate auto`; the default, `notify`, only writes to omp's debug log. To update by hand, run `omp plugin marketplace update omp-jeremy`, then `omp plugin upgrade`, and restart omp.

The orchestrator needs Python 3, Git and [Beads](https://github.com/steveyegge/beads) (`bd`). On macOS, install Beads with `brew install beads`.

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
omp plugin install orchestrator@omp-jeremy
```

*The plugins share terminal, theme and font integrations, plus a [web design system](packages/web-design-system/README.md) for consistent typography and controls. Build from the repository root to update the standalone assets shipped with each plugin.*
