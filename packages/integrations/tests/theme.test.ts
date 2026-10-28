import { expect, test } from "bun:test";
import { parseGhosttyConfig } from "../src/theme";

test("cmux's config file, read after Ghostty's, overrides the font size", () => {
	const ghostty = "font-family = FiraCode Nerd Font Mono\nfont-size = 14\nbackground = #101012\n";
	const cmux = "# cmux themes start\ntheme = light:Brogrammer,dark:Brogrammer\n# cmux themes end\nfont-size=15.5\n";
	expect(parseGhosttyConfig(`${ghostty}\n${cmux}`)).toEqual({ background: "#101012", fontSize: 15.5, fontFamilies: ["FiraCode Nerd Font Mono"] });
});

test("font-family preserves fallback order and an empty assignment resets it", () => {
	const ghostty = "font-family = Missing Font\nfont-family = FiraCode Nerd Font Mono\n";
	expect(parseGhosttyConfig(ghostty).fontFamilies).toEqual(["Missing Font", "FiraCode Nerd Font Mono"]);
	expect(parseGhosttyConfig(`${ghostty}font-family =\nfont-family = Menlo\n`).fontFamilies).toEqual(["Menlo"]);
});
