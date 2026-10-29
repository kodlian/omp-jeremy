"""The terminal's Ghostty config (through the ghostty CLI bundled with cmux or Ghostty) as board appearance."""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


def ghostty_cli() -> Optional[str]:
    """The ghostty CLI bundled with cmux (or Ghostty), which prints the terminal's resolved config."""
    resources = os.environ.get("GHOSTTY_RESOURCES_DIR")
    candidates = [Path(resources, rel) for rel in ("../bin/ghostty", "../../MacOS/ghostty", "../../bin/ghostty")] if resources else []
    candidates += [Path("/Applications/cmux.app/Contents/Resources/bin/ghostty"), Path("/Applications/Ghostty.app/Contents/MacOS/ghostty")]
    return next((str(c.resolve()) for c in candidates if c.is_file() and os.access(c, os.X_OK)), None)


def is_light(color: str) -> bool:
    r, g, b = (int(color[i:i + 2], 16) for i in (1, 3, 5))
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5


def terminal_appearance(config: str) -> Tuple[str, bool, Optional[str], Dict[int, str]]:
    """CSS variables matching the terminal's colors and font (from `ghostty +show-config`), whether it's a Nerd Font, its scheme and its 256-color palette."""
    colors: Dict[str, str] = {}
    palette: Dict[int, str] = {}
    fonts: List[str] = []
    for line in config.splitlines():
        key, sep, value = line.partition(" = ")
        key, value = key.strip(), value.strip()
        if not sep:
            continue
        if key in ("background", "foreground") and HEX_COLOR.fullmatch(value):
            colors[key] = value
        elif key == "palette":
            index, _, color = value.partition("=")
            if index.isdigit() and int(index) <= 255 and HEX_COLOR.fullmatch(color):
                palette[int(index)] = color.lower()
        elif key == "font-family" and value:
            fonts.append(value)
    decls = []
    if "background" in colors and "foreground" in colors:
        decls += [f"color-scheme: {'light' if is_light(colors['background']) else 'dark'}",
                  f"--bg: {colors['background']}", f"--fg: {colors['foreground']}"]
        for name, index in (("--remove", 1), ("--add", 2), ("--warning", 3), ("--accent", 4), ("--merged", 5), ("--cyan", 6)):
            if index in palette:
                decls.append(f"{name}: {palette[index]}")
        if 4 in palette:
            decls.append(f"--accent-fg: {'#000000' if is_light(palette[4]) else '#ffffff'}")
    if fonts:
        quoted = ", ".join('"' + f.replace("\\", "\\\\").replace('"', '\\"') + '"' for f in fonts)
        decls.append(f'--mono: {quoted}, ui-monospace, "SF Mono", Menlo, monospace')
    css = ":root {\n" + "".join(f"  {d};\n" for d in decls) + "}\n" if decls else ""
    scheme = ("light" if is_light(colors["background"]) else "dark") if "background" in colors and "foreground" in colors else None
    return css, any("Nerd Font" in f for f in fonts), scheme, palette
