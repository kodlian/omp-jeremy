# omp-git-diff-review

`/review` for omp: opens a browser diff review with a file tree, a continuous diff, and inline line comments that are sent back to the agent.

## Install

Requires [Bun](https://bun.sh) and omp. Once the repository is pushed, install from the `omp-jeremy` marketplace:

```sh
omp plugin marketplace add kodlian/omp-jeremy
omp plugin install git-diff-review@omp-jeremy
```

Restart omp, then run `/review` in a session. Update with `omp plugin marketplace update omp-jeremy`, then `omp plugin upgrade git-diff-review@omp-jeremy`.

### Local development

The plugin lives in the `plugins/git-diff-review` directory of the marketplace repository and shares `packages/integrations` (terminal, theme and font detection) through a Bun workspace:

```sh
git clone https://github.com/kodlian/omp-jeremy.git && cd omp-jeremy
bun install --ignore-scripts
bun run build
omp plugin link plugins/git-diff-review
```

`omp plugin link` symlinks the plugin directory into `~/.omp/plugins/node_modules`, so edits apply in place.

Check it's loaded with `omp plugin list`; remove it with `omp plugin uninstall omp-git-diff-review`.

## Updating

| Changed | Needed |
|---|---|
| `web/*` | `bun run build`, then ⌘R in the review tab |
| `src/*` | restart omp and run `/review` again |

When the browser needs newer server functionality, the review tab shows a restart warning. ⌘R reloads the browser code, not the running omp extension.

## Usage

`/review` defaults to the current branch against its base (falls back to uncommitted changes vs HEAD). Select lines and press `c` to comment; `⌘↩` sends the whole review to the agent.

Choose the comparison once in the header. The changed-file list lives on the right; drag its divider to resize it or use the sidebar icon to collapse it. Its width and visibility are remembered. The settings icon groups wrapping, whitespace, text size, and file navigation.

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

The diff reuses the configured terminal font and base size under Ghostty or cmux, including settings in cmux Settings > Terminal; both are read again on each `/review`. Repository labels, file names, and file headers use a smaller proportional size. Installed font files are resolved through CoreText on macOS or Fontconfig on Linux and served through the plugin's token-protected local server, so browser restrictions on installed fonts do not prevent reuse. Fonts are not uploaded or bundled into the plugin.

In cmux, line spacing also follows the calling terminal's live cell height rather than adding extra diff-row padding. Choosing another text size scales that spacing proportionally; selecting Terminal restores the configured size.

If no installed font can be resolved, code uses the bundled [Fira Code](https://github.com/tonsky/FiraCode) ([SIL OFL 1.1](web/fonts/OFL.txt)). Other terminals get a 12px base. **Settings → Text size** changes the shared base size; secondary labels and badges stay proportionally smaller, and text controls scale to fit.

Text uses the browser's native font smoothing. The font file and base size are shared with the terminal, but renderer-specific settings such as Ghostty's `font-thicken` can still produce visual differences.

Syntax colors follow omp's syntax tokens. Diff rows use a faint addition/deletion tint, stronger gutter cues, and restrained changed-word highlights; hunk headers stay neutral so they do not compete with the code.

## Development

```sh
bun test
```
