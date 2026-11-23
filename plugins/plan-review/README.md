# omp-plan-review

Review omp's plans in the browser. When omp asks you to review a plan, the plan opens as a page: comment on its lines as in a code review, then send the comments to refine it, or approve it. The terminal's plan review stays open alongside; whichever answers first wins.

## Install

Requires [Bun](https://bun.sh) and omp. Once the repository is pushed, install from the `omp-jeremy` marketplace:

```sh
omp plugin marketplace add kodlian/omp-jeremy
omp plugin install plan-review@omp-jeremy
```

Restart omp. The page opens on its own each time a plan waits for review; `/plan-review` opens it again.

### Local development

The plugin lives in `plugins/plan-review` and shares `packages/integrations` (opening pages in the right terminal place, theme and font) and `packages/web-design-system` (tokens, reset and controls) through a Bun workspace:

```sh
bun install --ignore-scripts
bun run build
omp plugin link plugins/plan-review
```

`bun run build` bundles `dist/extension.js` and `web/dist/`, and copies `web/design-system.css` and `python/omp_terminals.py`; commit them, since marketplace installs don't build.

## Usage

In cmux the page opens as a tab beside the session's terminal, in the same pane; elsewhere it opens in the default browser. The tab takes the focus only while that workspace is in front (selected in cmux's key window); otherwise it waits in its pane, so a plan coming in never switches your workspace or brings cmux forward. The tab closes once the review ends: you refine or approve from the page or the terminal, the review is dismissed, or plan mode ends. Each new review opens it again, including in Mission Control task sessions, whose plans are reviewed here.

- Hover a block (heading, paragraph, list item, code, table) and click **+** to comment on it; shift-click another block's **+** to stretch the open comment over the range. Selecting text and pressing **Comment** (or `c`) quotes just the selection.
- **Refine plan** sends every comment, each quoting its plan lines, plus the overall feedback field. The revised plan replaces the page, its added and rewritten blocks marked in the gutter, with the previous text under **Previous version**.
- **Approve and execute** answers as omp's dialog would; its menu holds omp's other answers (compact or keep context, save for later). When omp offers several models to continue with, pick one beside the buttons.
- The sidebar lists the plan's headings, marks the sections that changed or carry comments, and follows the scroll.
- ` ```mermaid ` blocks (flowchart, state, sequence, class, ER and XY charts, drawn by [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid) as omp's terminal does) and ` ```svg ` blocks show as pictures in the page's colors; an SVG can use `currentColor` and `var(--fg)`, `--muted`, `--border`, `--surface`, `--accent`, `--success`, `--warning`, `--error` and `--c1` to `--c6`. Each is drawn as an image, so nothing in it runs or loads. A diagram that doesn't draw stays code, and hovering it says why.

Between reviews the page shows what omp is doing: a placeholder while it works on a plan, then the answered plan with "revising" or "executing" while its turn runs. Comments are kept in the browser per review, so a reload keeps them until the plan is answered.

Each omp session serves the page from its start and records its port, and the page's token is kept in `~/.omp/cache/plan-review`, so restarting omp or resuming that session brings the server back where an open tab reconnects on its own.

| Key | Action |
|---|---|
| `c` | comment on the selection or the hovered block |
| `n` / `p` | next / previous change since the previous plan |
| `⌘↵` | save the open comment; elsewhere, refine with your comments and feedback |
| `⌘⇧↵` | approve with omp's first available answer (Approve and execute) |
| `Esc` | cancel the comment |

Approving while comments or feedback are unsent asks to confirm before dropping them.

The page follows omp's theme and the terminal's font like the other plugins' pages.

## Development

```sh
bun test
```
