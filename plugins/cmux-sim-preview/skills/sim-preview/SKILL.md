---
name: sim-preview
description: "Show a SwiftUI #Preview of an iOS app natively in a cmux Simulator pane, opening the pane if the workspace has none: list previews, screenshot one, tap through it, or keep it live with ~1 s hot reload while editing. Use to see or check how a SwiftUI view looks, animates or responds, with the user watching."
---

# sim-preview

`sim-preview` runs an app's `#Preview` inside the app's own Debug build on a regular simulator, shown in the cmux Simulator
pane of your workspace. The user watches the same pane, so everything you do there is visible to them.

## No Simulator pane yet? Open one

You don't need the user to open it. Every `sim-preview` command opens a Simulator pane to the right of your terminal when
the workspace has none, without taking focus. To open one yourself first, for example to get its ref for a live session:

```sh
cmux new-pane --type simulator --direction right --focus false     # prints the new surface ref
cmux ios list --workspace "$CMUX_WORKSPACE_ID"                     # existing panes, their refs and devices
```

A new pane shows no device until something selects one; sim-preview does that, preferring the device it used last.

## The binary: local release build only

`sim-preview` on PATH is `~/.local/bin/sim-preview`, a symlink to the release build of the `SimPreview` Swift package
shipped with this plugin, at `../../SimPreview` relative to this skill file (call it `$PKG`). Use only that build: never
install another copy, never use a debug build (its parser is many times slower). If `command -v sim-preview` fails, or
the plugin was updated:

```sh
swift build -c release --package-path "$PKG"
ln -sf "$(swift build -c release --package-path "$PKG" --show-bin-path)/sim-preview" ~/.local/bin/sim-preview
```

## One shot: list, screenshot

Run from your cmux terminal or shell tool. It uses the workspace's Simulator pane, creating one to the right if there is
none, and leaves the preview showing there.

```sh
sim-preview <path to .xcodeproj or .xcworkspace> --scheme <app scheme> --list
sim-preview <project> --scheme <app scheme> --preview "<name>" --screenshot /tmp/<name>.png
```

- Results go to stdout (one preview name per line, or the PNG path); progress goes to stderr. Exit status 1 means it
  failed, with the reason on stderr, such as an unknown preview name.
- Names are the `#Preview("…")` titles. Unnamed previews are `File.swift#0`, `#1`… in source order; a title used in two
  files becomes `Title (File.swift)`.
- Read the PNG to see the view.

## Interact through the cmux Simulator pane

```sh
cmux ios list --workspace "$CMUX_WORKSPACE_ID"          # the pane's surface ref and device
cmux simulator tap 0.5 0.5 --surface <ref>              # x, y normalized 0…1 across the screen
cmux simulator swipe 0.5 0.8 0.5 0.2 --surface <ref>
cmux simulator type "hello" --surface <ref>
cmux simulator accessibility --surface <ref>            # element types, labels, values
cmux ios screenshot --surface <ref> --out /tmp/after.png
```

These are the commands of the `cmux-simulator` skill. They drive the simulator only; never synthesize host mouse or keyboard
input.

## Live session: edit and watch

For iterating on a view, run it live in a terminal under the Simulator pane, where the user can see and type too. Open
the pane first if `cmux ios list` shows none (see above), then:

```sh
cmux new-split down --surface <simulator ref> --command "sim-preview <project> --scheme <app scheme> --preview '<name>'"
```

- Saving a Swift file shows the change in about a second. Edits beyond function or computed-property bodies (stored
  properties, initializers, new members, changed signatures) rebuild and relaunch instead.
- Drive it by typing into that terminal: `cmux send --surface <terminal ref> "preview <name>\n"`; also `list`, `rebuild`,
  `quit`. Read its log with `cmux read-screen --surface <terminal ref> --lines 20`.
- When the user picks another device in the pane, it relaunches the preview there.
- One sim-preview per pane: don't run one-shot commands while a live session drives the same pane, and `quit` it when
  you're done.

## Costs

- The first run for a project path builds the whole app into `~/Library/Caches/sim-preview/<project>-<hash>`: a large app
  takes about 3 minutes and several GB. Each worktree is a separate path with its own build. Later runs take seconds when
  nothing changed, or an incremental build when something did.
- It picks the pane's device, else the device it used last time, else an iPhone 17 Pro. Never point it at a simulator
  that's running tests, and don't boot extra simulators.

## Limits

- iOS app projects with SwiftUI `#Preview` only: not `PreviewProvider`, not `#Preview(arguments:)`; preview traits
  (orientation, layout) are ignored.
- The app's own startup code doesn't run, as in Xcode previews; a preview must set up what it needs itself.
