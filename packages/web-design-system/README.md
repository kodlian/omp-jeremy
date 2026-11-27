# omp-web-design-system

Shared look for the plugin web pages: `design-system.css` with the tokens, reset and utilities the Mission Control page and the Review page have in common, `primer-theme.css` with [Primer](https://primer.style)'s themes and omp's fonts on its tokens, `omp-colors.css` putting omp's terminal colors on Primer's tokens, and `toasts.jsx`.

## Delivery

`bun run build` from the repository root copies `design-system.css` to `plugins/mission-control/design-system.css` and `plugins/git-diff-review/web/design-system.css`; the copies are committed, so each plugin serves `/design-system.css` from its own directory and installs without building. Pages link `design-system.css`, then their bundled CSS, then their own CSS, then the runtime `/appearance.css`, so plugin styles and the terminal theme override them. Edit only these files; never the copies.

Both pages are React apps on Primer React. Each imports `primer-theme.css` into its bundle, wraps itself in Primer's `ThemeProvider` and keeps its `colorMode` in step with the `color-scheme` of `/appearance.css`. The Review page also imports `omp-colors.css`, so it takes the terminal theme's colors; Mission Control keeps Primer's own palette and points the tokens below at it. React, Primer React and the octicons are pinned to the same exact versions in every plugin, so the workspace installs one copy of each.

## Tokens

| Group | Variables |
|---|---|
| Color | `--bg` `--fg` `--muted` `--faint` `--accent` `--accent-fg` `--accent-soft` `--add` `--remove` `--warning` `--merged` `--cyan` |
| Surfaces | `--surface` `--surface-2` `--raised` (`--surface-solid` alias) `--line` `--line-strong` `--hover` `--shadow` |
| Shape | `--radius-sm` 4px, `--radius` 6px, `--radius-lg` 10px |
| Type | `--font-size` (from `--terminal-font-size`, else 12px), `--ui-font-size`, `--font-size-sm`, `--font-size-xs`, `--font-size-lg`, `--code-font-size-sm`, `--line-height` (from `--terminal-line-height`), `--mono` and `--ui` (from `--terminal-font`) |
| Density | `--control-h`, derived from `--ui-font-size` |

A page that sets `--font-size` or `--ui-font-size` resizes text and controls together.

## Components

- Reset: box sizing, `[hidden]`, page font and colors, form element inheritance, focus rings, links, selection, placeholders and scrollbars.
- Utilities: `.icon`, `.spacer`, `.mono`, `.muted`, `.add`, `.remove`, `.spin`, `kbd`.
- Controls are Primer React components, themed by `primer-theme.css`.
- `ToastProvider` and `useToast()` from `omp-web-design-system/toasts`: `toast(content, error)` shows a Primer `Banner` in a stack at the bottom of the page; errors stay longer.

Domain components such as menus, cards and diff rows stay in each plugin.
