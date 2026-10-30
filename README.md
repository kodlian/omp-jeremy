# omp-jeremy

Three plugins for [omp](https://github.com/can1357/oh-my-pi): orchestrate coding tasks across worktrees, review their changes in the browser, and preview SwiftUI views in cmux.

## Orchestrator

Turn plans into tasks that run in their own Git worktrees. Track dependencies, review agent plans, send feedback, and merge completed work back into the parent branch. Tasks and context are stored in Beads.

## Git Diff Review

Open a browser-based diff viewer from omp with `/review`. Browse changed files, comment on individual lines, and send review feedback directly to your agent.

## cmux Sim Preview

The `sim-preview` skill runs an iOS app's SwiftUI `#Preview` in the cmux Simulator pane, with about one second of hot reload on save. The skill builds its bundled `SimPreview` Swift package (Xcode required) and links `sim-preview` into `~/.local/bin`.

## Install from the marketplace

Once this repository is pushed to GitHub:

```sh
omp plugin marketplace add kodlian/omp-jeremy
omp plugin install orchestrator@omp-jeremy
omp plugin install git-diff-review@omp-jeremy
omp plugin install cmux-sim-preview@omp-jeremy
```

Install each plugin independently. Restart omp after installing extensions.

The orchestrator needs Python 3, Git and [Beads](https://github.com/steveyegge/beads) (`bd`). On macOS, install Beads with `brew install beads`.

## Local development

Install [Bun](https://bun.sh), then run from the repository root:

```sh
bun install --ignore-scripts
bun run build
bun run test
```

Commit the generated plugin bundles, Python helpers and review web assets after rebuilding: marketplace installs do not run build scripts.

The marketplace can also be added from a local checkout:

```sh
omp plugin marketplace add /path/to/omp-jeremy
omp plugin install orchestrator@omp-jeremy
```

*Both plugins share terminal, theme and font integrations internally.*
