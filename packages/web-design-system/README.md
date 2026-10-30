# omp-web-design-system

Shared look for the plugin web pages: one stylesheet, `design-system.css`, with the tokens, reset and controls the Orchestrator board and the Review page have in common.

## Delivery

`bun run build` from the repository root copies the stylesheet to `plugins/orchestrator/design-system.css` and `plugins/git-diff-review/web/design-system.css`. The copies are committed, so each plugin serves `/design-system.css` from its own directory and installs without building. Pages link it first, then their own CSS, then the runtime `/appearance.css`, so plugin styles and the terminal theme override it. Edit only this file; never the copies.

## Tokens

| Group | Variables |
|---|---|
| Color | `--bg` `--fg` `--muted` `--faint` `--accent` `--accent-fg` `--accent-soft` `--add` `--remove` `--warning` `--merged` `--cyan` |
| Surfaces | `--surface` `--surface-2` `--raised` (`--surface-solid` alias) `--line` `--line-strong` `--hover` `--shadow` |
| Shape | `--radius-sm` 4px, `--radius` 6px, `--radius-lg` 10px |
| Type | `--font-size` (from `--terminal-font-size`, else 12px), `--ui-font-size`, `--font-size-sm`, `--font-size-xs`, `--font-size-lg`, `--code-font-size-sm`, `--line-height` (from `--terminal-line-height`), `--mono` and `--ui` (from `--terminal-font`) |
| Density | `--control-h`, `--control-h-sm`, `--field-h`, `--tool-size`, all derived from `--ui-font-size` |

A page that sets `--font-size` or `--ui-font-size` resizes text and controls together.

## Components

- Reset: box sizing, `[hidden]`, page font and colors, form element inheritance, focus rings, links, selection, placeholders and scrollbars.
- Utilities: `.icon`, `.spacer`, `.mono`, `.muted`, `.add`, `.remove`, `.spin`, `kbd`.
- `.btn` with `.primary`, `.ghost`, `.danger`, `.danger-solid` and `.sm`.
- `.tool-button`: borderless icon button, `.active` when on.
- `.segmented`: a group of buttons; the current one has `.active` or `aria-pressed="true"`. Add `.icons` for icon-only segments.
- `.field`: text input or textarea.

Domain components such as chips, menus, cards and diff rows stay in each plugin.
