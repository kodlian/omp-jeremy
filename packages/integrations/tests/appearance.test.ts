import { expect, test } from "bun:test";
import { parseGhosttyConfig } from "omp-integrations/theme";
import { toAppearance } from "../src/appearance";

const gruvbox = { pageBg: "#1d2021", userMessageBg: "#1d2021", accent: "#fe8019", syntaxKeyword: "#fb4934" };
const light = { pageBg: "#f8f8f8", userMessageBg: "#e8e8e8", accent: "#5a8080", syntaxKeyword: "#0000ff" };

test("scheme comes from the theme's page colors, else omp's light verdict; only hex colors apply", () => {
	expect(toAppearance({ colors: light, light: false }, null)).toMatchObject({ scheme: "light", vars: { "--syn-keyword": "#0000ff" } });
	expect(toAppearance({ colors: gruvbox, light: true }, null)).toMatchObject({ scheme: "dark", vars: { "--accent": "#fe8019" } });
	expect(toAppearance({ colors: { accent: "#5a8080" }, light: true }, null).scheme).toBe("light");
	expect(toAppearance({ colors: { ...gruvbox, syntaxString: "ansi(3)" }, light: false }, null).vars["--syn-string"]).toBeUndefined();
});

test("terminal colors win only when they match the theme's brightness", () => {
	const theme = { colors: gruvbox, light: false };
	const ghostty = parseGhosttyConfig("selection-background = #e6edf3\nbackground = #101012\nforeground = #e6edf3\npalette = 0=#484f58\n");
	expect(toAppearance(theme, ghostty).vars).toMatchObject({ "--bg": "#101012", "--fg": "#e6edf3" });
	const vars = toAppearance(theme, { background: "#ffffff", foreground: "#000000" }).vars;
	expect(vars["--bg"]).toBe("#1d2021");
	expect(vars["--fg"]).toBeUndefined();
});

test("the terminal font size applies even when its colors don't match the theme", () => {
	const vars = toAppearance({ colors: gruvbox, light: false }, { background: "#ffffff", foreground: "#000000", fontSize: 15 }).vars;
	expect(vars).toMatchObject({ "--bg": "#1d2021", "--terminal-font-size": "15px" });
});
