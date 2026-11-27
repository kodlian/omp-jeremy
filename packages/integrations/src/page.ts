import { type Appearance, toAppearance } from "./appearance";
import { currentTheme, hasThemeApi, terminalConfig } from "./theme";

/** The port a session's page last used, from its `entryType` session entries. */
export function recordedPort(ctx: { sessionManager: { getBranch(): Iterable<{ type: string; customType?: string; data?: { port?: unknown } }> } }, entryType: string): number | null {
	let port: number | null = null;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === entryType && typeof entry.data?.port === "number") port = entry.data.port;
	}
	return port;
}

/** Keeps a page's colors and font on omp's theme: `omp` is the agent module, whose theme exports are undocumented; without them nothing happens. */
export function appearanceSync(omp: object, page: () => { setAppearance(appearance: Appearance): void } | null) {
	const api = hasThemeApi(omp) ? omp : null;
	let version = 0;
	let unsubscribe: (() => void) | undefined;
	const sync = async () => {
		if (!api || !page()) return;
		const mine = ++version;
		const [theme, terminal] = await Promise.all([currentTheme(api), terminalConfig()]);
		if (mine === version) page()?.setAppearance(toAppearance(theme, terminal));
	};
	return {
		sync,
		/** Follows theme switches until stop. */
		start() {
			if (api && !unsubscribe) unsubscribe = api.onThemeChange(() => void sync().catch(() => {}));
		},
		stop() {
			unsubscribe?.();
			unsubscribe = undefined;
			version++;
		},
	};
}
