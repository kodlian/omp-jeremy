"""A task agent's terminal screen as the board previews it: tmux's captured lines with their SGR styles as styled runs."""
from __future__ import annotations

import re
from functools import lru_cache
from itertools import groupby
from typing import Any, Dict, List, Optional, Tuple

from runtime import PRIVATE_USE

FLAGS = {1, 2, 3, 5, 6, 7, 8, 9, 53}
FLAG_RESETS = {22: (1, 2), 23: (3,), 25: (5, 6), 27: (7,), 28: (8,), 29: (9,), 55: (53,)}
STYLE_FLAGS = {1: "bold", 2: "dim", 3: "italic", 4: "underline", 21: "underline", 7: "inverse", 9: "strike"}
STYLE_COLORS = {"38": "fg", "48": "bg"}
XTERM_16 = ("#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
            "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff")
ESCAPES = re.compile(r"\x1b\[([0-9;:?<=>]*)([ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_X][^\x1b]*(?:\x1b\\)?"
                     r"|\x1b[ -/]*[0-~]?")
CONTROLS = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")
Style = Tuple[Tuple[str, Any], ...]


class Pen:
    """The SGR state in force while reading captured lines; `attr` is its parameters as a cell attribute."""

    def __init__(self) -> None:
        self.flags: set = set()
        self.underline: Optional[str] = None
        self.fg: Optional[str] = None
        self.bg: Optional[str] = None
        self.ul: Optional[str] = None
        self.attr = ""

    def sgr(self, parts: List[str]) -> None:
        items = parts or ["0"]
        i = 0
        while i < len(items):
            item = items[i]
            if ":" in item:
                head = item.split(":")[0]
                if head in ("38", "48", "58"):
                    setattr(self, {"38": "fg", "48": "bg", "58": "ul"}[head], item)
                elif head == "4":
                    self.underline = None if item.split(":")[1] in ("", "0") else item
                i += 1
                continue
            n = int(item) if item.isdigit() else 0
            if n in (38, 48, 58):
                mode = items[i + 1] if i + 1 < len(items) else ""
                size = 3 if mode == "5" else 5 if mode == "2" else 0
                if size and i + size <= len(items):
                    setattr(self, {38: "fg", 48: "bg", 58: "ul"}[n], ";".join(items[i:i + size]))
                    i += size
                else:
                    i = len(items)
                continue
            if n == 0:
                self.flags, self.underline, self.fg, self.bg, self.ul = set(), None, None, None, None
            elif n in FLAGS:
                self.flags.add(n)
            elif n in FLAG_RESETS:
                self.flags.difference_update(FLAG_RESETS[n])
            elif n in (4, 21):
                self.underline = str(n)
            elif n == 24:
                self.underline = None
            elif 30 <= n <= 37 or 90 <= n <= 97:
                self.fg = str(n)
            elif n == 39:
                self.fg = None
            elif 40 <= n <= 47 or 100 <= n <= 107:
                self.bg = str(n)
            elif n == 49:
                self.bg = None
            elif n == 59:
                self.ul = None
            i += 1
        self.attr = ";".join([str(f) for f in sorted(self.flags)] +
                             [p for p in (self.underline, self.fg, self.bg, self.ul) if p])


def rows_from_ansi(text: str) -> List[List[List[str]]]:
    """`capture-pane -e` output as rows of [text, SGR attribute] runs; other escape sequences and controls are dropped."""
    pen = Pen()
    rows: List[List[List[str]]] = []
    for line in text.split("\n"):
        runs: List[List[str]] = []
        pos = 0
        for m in [*ESCAPES.finditer(line), None]:
            chunk = CONTROLS.sub("", line[pos:m.start() if m else len(line)])
            if chunk:
                if runs and runs[-1][1] == pen.attr:
                    runs[-1][0] += chunk
                else:
                    runs.append([chunk, pen.attr])
            if m is None:
                break
            pos = m.end()
            if m[3] == "m" and not m[2] and not (m[1] and m[1][0] in "?<=>"):
                pen.sgr(m[1].split(";") if m[1] else [])
        rows.append(runs)
    return rows


def plain_text(text: str) -> str:
    """The text of `capture-pane -e` output, as rows_from_ansi spells it."""
    return "\n".join("".join(run[0] for run in row) for row in rows_from_ansi(text))


def sgr_color(args: List[str]) -> Any:
    """An SGR 38/48 color's arguments (after 38 or 48) as a palette index or #rrggbb; None when malformed."""
    if len(args) >= 2 and args[0] == "5":
        values = args[1:2]
    elif args and args[0] == "2":
        values = args[2:5] if len(args) >= 5 else args[1:4]
    else:
        return None
    if len(values) != (1 if args[0] == "5" else 3) or not all(v.isascii() and v.isdigit() and int(v) <= 255
                                                               for v in values):
        return None
    return int(values[0]) if args[0] == "5" else "#%02x%02x%02x" % tuple(int(v) for v in values)


@lru_cache(maxsize=4096)
def attr_style(attr: str) -> Style:
    """What a cell's SGR attribute shows in a preview: fg and bg as a palette index or #rrggbb, and its flags."""
    style: Dict[str, Any] = {}
    items = attr.split(";") if attr else []
    i = 0
    while i < len(items):
        item = items[i]
        if ":" in item:
            head, *args = item.split(":")
            if head in STYLE_COLORS:
                color = sgr_color(args)
                if color is not None:
                    style[STYLE_COLORS[head]] = color
            elif head == "4":
                style["underline"] = True
            i += 1
            continue
        n = int(item) if item.isascii() and item.isdigit() else -1
        if n in (38, 48, 58):
            size = 3 if items[i + 1:i + 2] == ["5"] else 5
            color = sgr_color(items[i + 1:i + size])
            if color is not None and n != 58:
                style[STYLE_COLORS[str(n)]] = color
            i += size
            continue
        if n in STYLE_FLAGS:
            style[STYLE_FLAGS[n]] = True
        elif 30 <= n <= 37 or 90 <= n <= 97:
            style["fg"] = n - 30 if n < 90 else n - 82
        elif 40 <= n <= 47 or 100 <= n <= 107:
            style["bg"] = n - 40 if n < 100 else n - 92
        i += 1
    return tuple(sorted(style.items()))


def palette_color(index: int, palette: Dict[int, str]) -> str:
    """The #rrggbb of a 256-color index: the terminal's palette, else xterm's."""
    if index in palette:
        return palette[index]
    if index < 16:
        return XTERM_16[index]
    if index < 232:
        r, g, b = ((index - 16) // 36, (index - 16) // 6 % 6, (index - 16) % 6)
        return "#%02x%02x%02x" % tuple(0 if c == 0 else 55 + 40 * c for c in (r, g, b))
    return "#%02x%02x%02x" % ((8 + 10 * (index - 232),) * 3)


def css_style(attr: str, palette: Dict[int, str]) -> Style:
    return tuple((k, palette_color(v, palette) if isinstance(v, int) and k in ("fg", "bg") else v)
                 for k, v in attr_style(attr))


def cell_styles(text: str, rows: Any, palette: Dict[int, str]) -> Optional[List[Style]]:
    """Each character's style of `text` from rows of [text, attr] runs; None unless they spell `text`."""
    if not isinstance(rows, list):
        return None
    chars: List[str] = []
    styles: List[Style] = []
    known: Dict[str, Style] = {}
    for i, row in enumerate(rows):
        if not isinstance(row, list):
            return None
        if i:
            chars.append("\n")
            styles.append(())
        for run in row:
            if not (isinstance(run, list) and len(run) == 2 and isinstance(run[0], str) and isinstance(run[1], str)):
                return None
            if run[1] not in known:
                known[run[1]] = css_style(run[1], palette)
            chars.append(run[0])
            styles.extend([known[run[1]]] * len(run[0]))
    return styles if "".join(chars) == text else None


def preview(text: str, rows: Any, palette: Dict[int, str], private: bool, lines: int) -> Dict[str, Any]:
    """The screen as the board previews it: its last `lines` right-trimmed lines without trailing blank ones, without
    private-use glyphs unless `private`, and, when the rows spell the text, "rows" of each line's styled runs."""
    styles = cell_styles(text, rows, palette)
    if not private:
        if styles is not None:
            styles = [s for ch, s in zip(text, styles) if not PRIVATE_USE.match(ch)]
        text = PRIVATE_USE.sub("", text)
    shown: List[str] = []
    styled: List[List[Style]] = []
    pos = 0
    for segment in text.splitlines(True):
        line = segment.splitlines()[0].rstrip()
        shown.append(line)
        if styles is not None:
            styled.append(styles[pos:pos + len(line)])
        pos += len(segment)
    while shown and not shown[-1]:
        shown.pop()
    shown, styled = shown[-lines:], styled[:len(shown)][-lines:]
    result: Dict[str, Any] = {"text": "\n".join(shown)}
    if styles is not None:
        result["rows"] = [[{"text": "".join(ch for ch, _ in group), **dict(style)}
                           for style, group in groupby(zip(line, line_styles), key=lambda pair: pair[1])]
                          for line, line_styles in zip(shown, styled)]
    return result
