# omp-plan-review

Comment on any line of omp's own plan review. When omp shows a plan for review, select lines with a click or a drag, or press `a` and move with the arrow keys; then press `a`, `c` or Enter and type a note. The note becomes one of omp's own plan comments: omp shows it under the line, marks its section in the sidebar, and sends it when you pick **Refine plan**.

## Install

Requires [Bun](https://bun.sh) and omp. Once the repository is pushed, install from the `omp-jeremy` marketplace:

```sh
omp plugin marketplace add kodlian/omp-jeremy
omp plugin install plan-review@omp-jeremy
```

Restart omp. Nothing else to set up: it works in each plan review omp shows.

### Local development

The plugin lives in `plugins/plan-review` and shares `packages/integrations` through a Bun workspace:

```sh
bun install --ignore-scripts
bun run build
omp plugin link plugins/plan-review
```

`bun run build` bundles `dist/extension.js`; commit it, since marketplace installs don't build.

## Usage

The review looks and works as omp draws it: its keys, its sidebar and its answers are all still there. The plugin adds:

| Action | Result |
|---|---|
| Click a line of the plan | selects it |
| Drag over lines | selects all of them |
| `a` with nothing selected | selects the first line at the top of the plan |
| `↑` / `↓` | move the selection to the previous / next line; the review scrolls when that line is off screen |
| `Shift+↑` / `Shift+↓` | grow the selection by a line, or shrink it back |
| `Alt+↑` / `Alt+↓` | scroll the plan; the selection stays on its line |
| `a`, `c` or `Enter` | opens a comment box on the selection |
| `Enter` in the box | saves the comment |
| `Esc` | closes the box, then clears the selection, then (with nothing selected) closes the review as omp does |

While a selection is shown, any other key goes to omp's review and clears the selection; the mouse wheel and `PgUp` / `PgDn` scroll and keep it, and `↑` / `↓` first scroll back to a selection that went off screen. With nothing selected, keys work as in omp's review except `a`: omp's own `a` comments on the top line at once, while here it selects that line so you can move it first.

omp keeps these comments with its own: Refine sends them all, each quoting its lines, and after Tab moves into the plan, `u` undoes the last one. omp shows a comment under the first line of the selection.

## How it works

The plugin opens a full-screen layer over omp's review that draws the review exactly as omp renders it and passes keys and clicks through. A comment goes into omp's review through the event omp uses for Tern's native comments, quoting the selected lines and naming where they sit in the plan, so omp files it under the right section.

This relies on omp internals rather than a published plugin API. When an omp version doesn't have them, the plugin leaves omp's review as it is. Under [Tern](https://stencil.so/tern), omp's own review already takes comments on any selection, so the plugin stays out of the way.

## Development

```sh
bun test
```
