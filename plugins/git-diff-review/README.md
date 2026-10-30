# omp-git-diff-review

`/review` for omp: opens a browser diff review with a file tree, a continuous diff, and inline line comments that are sent back to the agent.

The comparison header uses three icon segments for Working tree, Branch and Single commit, with tooltips and a highlighted active mode. The relevant base or commit picker stays alongside.

Turn off **Use omp syntax colors** in View options to use Review's default light/dark syntax palette instead of omp's theme colors. Highlighting and addition/deletion shading stay enabled. The choice is saved with the other browser preferences and survives reloads.

## Install

Requires [Bun](https://bun.sh) and omp. Once the repository is pushed, install from the `omp-jeremy` marketplace:

```sh
omp plugin marketplace add kodlian/omp-jeremy
omp plugin install git-diff-review@omp-jeremy
```

Restart omp, then run `/review` in a session. Update with `omp plugin marketplace update omp-jeremy`, then `omp plugin upgrade git-diff-review@omp-jeremy`.

### Local development

The plugin lives in the `plugins/git-diff-review` directory of the marketplace repository and shares `packages/integrations` (terminal, theme and font detection) and `packages/web-design-system` (tokens, reset and controls) through a Bun workspace:

```sh
git clone https://github.com/kodlian/omp-jeremy.git && cd omp-jeremy
bun install --ignore-scripts
bun run build
omp plugin link plugins/git-diff-review
```

`omp plugin link` symlinks the plugin directory into `~/.omp/plugins/node_modules`, so edits apply in place.

`bun run build` copies the shared stylesheet to `web/design-system.css`. The copy is committed, so marketplace installs serve it from the plugin itself without building or reaching into the rest of the repository.

Check it's loaded with `omp plugin list`; remove it with `omp plugin uninstall omp-git-diff-review`.

## Updating

| Changed | Needed |
|---|---|
| `web/*` | `bun run build`, then ⌘R in the review tab |
| `packages/web-design-system/design-system.css` | `bun run build` from the repository root, then ⌘R in the review tab |
| `src/*` | restart omp and run `/review` again |

When the browser needs newer server functionality, the review tab shows a restart warning. ⌘R reloads the browser code, not the running omp extension.

## Usage

`/review` defaults to the current branch against its base (falls back to uncommitted changes vs HEAD). Select lines and press `c` to comment; `⌘↩` sends the whole review to the agent.

Choose the comparison once in the single-line header; long branch names truncate instead of wrapping, and the full worktree path is available on hover. The changed-file list lives on the right; drag its divider to resize it or use the sidebar icon to collapse it. Its width and visibility are remembered. The settings icon groups wrapping, whitespace, text size, and file navigation.

Pending comments, including a non-empty inline draft, expose **Send review (count)** in the main toolbar even when the file list is collapsed. Its adjacent menu offers copying, adding to the prompt, and clearing saved comments.

| Key | Action |
|---|---|
| `j` / `k` | next / previous file |
| `]` / `[` | next / previous change |
| `n` / `N` | next / previous comment |
| `u` | next unviewed file |
| `v` | toggle viewed |
| `c` | comment on selection |
| `r` | refresh |
| `/` | filter files |
| `⌘F` | find in diff (`↩` / `⇧↩` to step) |
| `b`, `⌘\` | toggle right-hand file list |
| `Esc` | clear selection |

## Appearance

The page follows the active omp theme, including live theme switches. Under Ghostty or cmux it also uses the terminal's background and text colors when their brightness matches the theme.

Code follows the configured terminal font and base size under Ghostty or cmux, including cmux Settings > Terminal; both are read again on each `/review`. Controls and ordinary UI text are smaller, secondary metadata smaller again, while file titles keep the code's base size for emphasis. Installed fonts are resolved through CoreText on macOS or Fontconfig on Linux and served by the token-protected local server; fonts are never uploaded or bundled into the plugin.

In cmux, line spacing also follows the calling terminal's live cell height rather than adding extra diff-row padding. Choosing another text size scales that spacing proportionally; selecting Terminal restores the configured size.

If no installed font can be resolved, code uses the bundled [Fira Code](https://github.com/tonsky/FiraCode) ([SIL OFL 1.1](web/fonts/OFL.txt)). Other terminals get a 12px base. **Settings → Text size** changes the shared base size; secondary labels and badges stay proportionally smaller, and text controls scale to fit.

Text uses the browser's native font smoothing. The font file and base size are shared with the terminal, but renderer-specific settings such as Ghostty's `font-thicken` can still produce visual differences.

Syntax colors follow omp's syntax tokens by default, with an option to use Review's own light/dark palette. Diff rows use a faint addition/deletion tint, stronger gutter cues, and restrained changed-word highlights; hunk headers stay neutral so they do not compete with the code.

File groups use spacing and subtle surfaces instead of outlined cards. Sticky file headings, semantic gutters and visible keyboard focus retain the hierarchy without extra separators. Colors, buttons, icon buttons, the comparison switch and text fields come from the shared design system also used by the Orchestrator; diff rows, syntax colors, pickers and menus stay specific to Review.

## Development

```sh
bun test
```
