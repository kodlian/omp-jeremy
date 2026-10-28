import { expect, test } from "bun:test";
import { parseGhosttyConfig } from "omp-integrations/theme";
import { toAppearance } from "../src/appearance";

const gruvbox = { pageBg: "#1d2021", userMessageBg: "#1d2021", accent: "#fe8019", syntaxKeyword: "#fb4934" };
const light = { pageBg: "#f8f8f8", userMessageBg: "#e8e8e8", accent: "#5a8080", syntaxKeyword: "#0000ff" };

test("follows omp's active or previewed theme; scheme comes from its colors, not the slot", () => {
	const auto = { name: { dark: "dark-gruvbox", light: "light" }, dark: gruvbox, light };
	expect(toAppearance(auto, "light", null)).toMatchObject({ scheme: "light", vars: { "--syn-keyword": "#0000ff" } });
	expect(toAppearance(auto, "dark-gruvbox", null)).toMatchObject({ scheme: "dark", vars: { "--accent": "#fe8019" } });
	const lightInBothSlots = { name: { dark: "light", light: "light" }, dark: light, light };
	expect(toAppearance(lightInBothSlots, "light", null)?.scheme).toBe("light");
	const preview = { name: { light: "light" }, light };
	expect(toAppearance(preview, "dark-gruvbox", null)).toMatchObject({ scheme: "light", vars: { "--accent": "#5a8080" } });
});

test("terminal colors win only when they match the theme's brightness", () => {
	const palette = { name: { dark: "dark-gruvbox" }, dark: gruvbox };
	const ghostty = parseGhosttyConfig("selection-background = #e6edf3\nbackground = #101012\nforeground = #e6edf3\npalette = 0=#484f58\n");
	expect(toAppearance(palette, "dark-gruvbox", ghostty)?.vars).toMatchObject({ "--bg": "#101012", "--fg": "#e6edf3" });
	const vars = toAppearance(palette, "dark-gruvbox", { background: "#ffffff", foreground: "#000000" })?.vars;
	expect(vars?.["--bg"]).toBe("#1d2021");
	expect(vars?.["--fg"]).toBeUndefined();
});

test("the terminal font size applies even when its colors don't match the theme", () => {
	const palette = { name: { dark: "dark-gruvbox" }, dark: gruvbox };
	const vars = toAppearance(palette, "dark-gruvbox", { background: "#ffffff", foreground: "#000000", fontSize: 15 })?.vars;
	expect(vars).toMatchObject({ "--bg": "#1d2021", "--terminal-font-size": "15px" });
});
