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
	let epoch: number | null = null;
	let timer: Timer | undefined;
	const sync = async (force = false) => {
		if (!api || !page()) return;
		const now = api.getThemeEpoch();
		if (now === epoch && !force) return;
		epoch = now;
		const [theme, terminal] = await Promise.all([currentTheme(api), terminalConfig()]);
		if (epoch === now) page()?.setAppearance(toAppearance(theme, terminal));
	};
	return {
		sync,
		/** Follows theme switches until stop. */
		start() {
			if (api && !timer) timer = setInterval(() => void sync().catch(() => {}), 1000);
		},
		stop() {
			clearInterval(timer);
			timer = undefined;
			epoch = null;
		},
	};
}
