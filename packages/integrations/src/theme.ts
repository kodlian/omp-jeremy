import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { LocalFont } from "./fonts";
import { terminalFont } from "./fonts";

export type Scheme = "dark" | "light";

// Shape of omp's `getNativeThemePalette()`: resolved hex colors per auto-theme slot.
export interface ThemePalette {
	name: Partial<Record<Scheme, string>>;
	dark?: Record<string, string>;
	light?: Record<string, string>;
}

export interface TerminalConfig {
	background?: string;
	foreground?: string;
	fontSize?: number;
	fontFamilies?: string[];
	font?: LocalFont;
}

export interface ResolvedTheme {
	scheme: Scheme;
	// Only the palette tokens whose values are valid hex colors.
	colors: Record<string, string>;
	background?: string;
	foreground?: string;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// Same luminance test omp uses to classify theme backgrounds.
export function isLightColor(hex: string): boolean {
	const full = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
	const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}

export function resolveTheme(palette: ThemePalette, current: string, terminal: TerminalConfig | null): ResolvedTheme | null {
	const slot: Scheme = palette.name.dark === current ? "dark" : palette.name.light === current ? "light" : palette.dark ? "dark" : "light";
	const tokens = palette[slot];
	if (!tokens) return null;
	const colors = Object.fromEntries(Object.entries(tokens).filter(([, value]) => HEX.test(value)));
	const base = colors.pageBg ?? colors.userMessageBg;
	const scheme: Scheme = base ? (isLightColor(base) ? "light" : "dark") : slot;
	const term = terminal?.background && isLightColor(terminal.background) === (scheme === "light") ? terminal : null;
	return { scheme, colors, background: term?.background ?? colors.pageBg, foreground: term?.foreground ?? colors.text };
}

// Later lines win, as when Ghostty loads config files in order.
export function parseGhosttyConfig(config: string): TerminalConfig {
	const parsed: TerminalConfig = {};
	for (const line of config.split("\n")) {
		const [, key, value = ""] = /^\s*([\w-]+)\s*=\s*(.*?)\s*$/.exec(line) ?? [];
		if ((key === "background" || key === "foreground") && HEX.test(value)) parsed[key] = value;
		else if (key === "font-size" && Number(value) > 0) parsed.fontSize = Number(value);
		else if (key === "font-family") {
			if (value) (parsed.fontFamilies ??= []).push(value);
			else parsed.fontFamilies = [];
		}
	}
	return parsed;
}

// Ghostty's default `font-size`, used when no config file sets one.
const GHOSTTY_FONT_SIZE = process.platform === "darwin" ? 13 : 12;

// Ghostty, and cmux which bundles it, print the user's resolved config; cmux then loads its own file (Settings > Terminal).
export async function terminalConfig(resources = process.env.GHOSTTY_RESOURCES_DIR): Promise<TerminalConfig | null> {
	if (!resources) return null;
	const cli = ["../bin/ghostty", "../../MacOS/ghostty", "../../bin/ghostty"].map((p) => resolve(resources, p)).find((p) => existsSync(p));
	if (!cli) return null;
	try {
		const proc = Bun.spawn([cli, "+show-config"], { stdout: "pipe", stderr: "ignore", timeout: 2000 });
		const out = await new Response(proc.stdout).text();
		if ((await proc.exited) !== 0) return null;
		const bundle = process.env.CMUX_BUNDLE_ID;
		const cmux = bundle ? await Bun.file(join(homedir(), "Library/Application Support", bundle, "config.ghostty")).text().catch(() => "") : "";
		const config = parseGhosttyConfig(`${out}\n${cmux}`);
		return { ...config, fontSize: config.fontSize ?? GHOSTTY_FONT_SIZE, font: (await terminalFont(config.fontFamilies ?? [])) ?? undefined };
	} catch {
		return null;
	}
}
