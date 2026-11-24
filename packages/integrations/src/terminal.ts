// Terminal presentation for omp extensions: the calling terminal's validated context and URL opening, through python/omp_terminals.py.
import { fileURLToPath } from "node:url";

export type TerminalKind = "cmux" | "tmux" | "plain";

/** A validated terminal context: nested tmux presents terminals, a cmux part (when valid) still hosts browser panels. */
export interface TerminalContext {
	kind: TerminalKind;
	cmux?: { cli: string; socket: string; workspace: string; surface?: string; window?: string };
	tmux?: { socket: string; pane: string };
}

export interface TerminalOptions {
	/** Environment to detect from; defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Python 3 interpreter; defaults to python3. */
	python?: string;
	/** Env vars forcing auto|cmux|tmux|plain, first set wins; defaults to OMP_TERMINAL. */
	overrideEnvs?: string[];
	/** Milliseconds before the helper is killed; defaults to 30000. */
	timeoutMs?: number;
}

export interface OpenBoardOptions extends TerminalOptions {
	/** A context from detectTerminalContext instead of detecting the caller. */
	context?: TerminalContext | null;
	/** Focus the board; only for an explicit user open. Defaults to false. */
	focus?: boolean;
}

/** The shared Python helper, for callers that run it directly (servers, shell scripts). */
export const TERMINALS_SCRIPT = fileURLToPath(new URL("../python/omp_terminals.py", import.meta.url));

async function helper(args: string[], options: TerminalOptions): Promise<string> {
	const overrides = (options.overrideEnvs ?? []).flatMap((name) => ["--override-env", name]);
	const proc = Bun.spawn([options.python ?? "python3", TERMINALS_SCRIPT, ...overrides, ...args], {
		env: (options.env ?? process.env) as Record<string, string>,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 30_000);
	try {
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		if (code !== 0) throw new Error(err.trim().replace(/^terminals: /, "") || `omp_terminals.py ${args[0]} exited with ${code}`);
		return out;
	} finally {
		clearTimeout(timer);
	}
}

/** The calling terminal's validated context; rejects when an override names an unavailable terminal. */
export async function detectTerminalContext(options: TerminalOptions = {}): Promise<TerminalContext> {
	return JSON.parse(await helper(["detect"], options)) as TerminalContext;
}

export async function terminalCellHeight(options: TerminalOptions = {}): Promise<number | undefined> {
	try {
		const context = await detectTerminalContext(options);
		const cmux = context.cmux;
		const surface = cmux?.surface;
		if (!cmux || !surface) return undefined;
		const proc = Bun.spawn([cmux.cli, "--socket", cmux.socket, "list-panes", "--workspace", cmux.workspace, "--json"], {
			env: (options.env ?? process.env) as Record<string, string>, stdout: "pipe", stderr: "ignore", timeout: 2000,
		});
		const data = await new Response(proc.stdout).json();
		if (await proc.exited !== 0) return undefined;
		const pane = data.panes?.find((pane: { surface_ids?: string[] }) => pane.surface_ids?.includes(surface));
		const height = pane?.cell_height_points;
		return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
	} catch {
		return undefined;
	}
}

/** Opens `url` in the context's cmux workspace (reusing a panel already on its origin), else the default browser; rejects when nothing opens it. */
export async function openBoard(url: string, options: OpenBoardOptions = {}): Promise<void> {
	const args = ["board", url, options.focus ? "--focus" : "--no-focus"];
	if (options.context) args.push("--context", JSON.stringify(options.context));
	await helper(args, options);
}
