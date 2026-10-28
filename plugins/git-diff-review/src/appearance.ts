import type { LocalFont } from "omp-integrations/fonts";
import type { TerminalConfig, ThemePalette } from "omp-integrations/theme";
import { isLightColor, resolveTheme } from "omp-integrations/theme";

export interface Appearance {
	scheme: "dark" | "light";
	vars: Record<string, string>;
	font?: LocalFont;
}

const TOKEN_VARS: Record<string, string> = {
	"--muted": "muted",
	"--accent": "accent",
	"--badge": "mdLink",
	"--add": "toolDiffAdded",
	"--remove": "toolDiffRemoved",
	"--hunk": "borderAccent",
	"--warning": "warning",
	"--syn-comment": "syntaxComment",
	"--syn-keyword": "syntaxKeyword",
	"--syn-function": "syntaxFunction",
	"--syn-variable": "syntaxVariable",
	"--syn-string": "syntaxString",
	"--syn-number": "syntaxNumber",
	"--syn-type": "syntaxType",
	"--syn-operator": "syntaxOperator",
	"--syn-punctuation": "syntaxPunctuation",
};

export function toAppearance(palette: ThemePalette, current: string, terminal: TerminalConfig | null): Appearance | null {
	const theme = resolveTheme(palette, current, terminal);
	if (!theme) return null;
	const { scheme, colors } = theme;
	const vars: Record<string, string> = {};
	if (theme.background) vars["--bg"] = theme.background;
	if (theme.foreground) vars["--fg"] = theme.foreground;
	for (const [name, token] of Object.entries(TOKEN_VARS)) {
		const value = colors[token];
		if (value) vars[name] = value;
	}
	const accent = colors.accent;
	if (accent) {
		vars["--accent-fg"] = isLightColor(accent) ? "#000000" : "#ffffff";
		vars["--accent-soft"] = `color-mix(in srgb, ${accent} ${scheme === "light" ? 12 : 18}%, transparent)`;
	}
	if (terminal?.fontSize) vars["--terminal-font-size"] = `${terminal.fontSize}px`;
	return { scheme, vars, font: terminal?.font };
}

export function appearanceCss({ scheme, vars, font }: Appearance, fontUrl?: string): string {
	const decls = Object.entries(vars).map(([name, value]) => `  ${name}: ${value};\n`);
	let face = "";
	if (font && fontUrl) {
		const family = `"Review Terminal ${font.id}"`;
		face = `@font-face {\n  font-family: ${family};\n  src: url(${JSON.stringify(`${fontUrl}#${encodeURIComponent(font.postscriptName)}`)});\n  font-display: swap;\n}\n`;
		decls.push(`  --terminal-font: ${family}, "Fira Code";\n`);
	}
	return `${face}:root {\n  color-scheme: ${scheme};\n${decls.join("")}}\n`;
}
