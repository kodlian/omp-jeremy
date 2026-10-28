export interface OpenTarget {
	id: string;
	label: string;
}

interface Editor extends OpenTarget {
	app: string;
	url?: (abs: string, line: number | null) => string;
}

const fileUrl = (scheme: string) => (abs: string, line: number | null) => `${scheme}://file${encodeURI(abs)}${line ? `:${line}` : ""}`;

const EDITORS: Editor[] = [
	{ id: "vscode", label: "Visual Studio Code", app: "Visual Studio Code", url: fileUrl("vscode") },
	{ id: "cursor", label: "Cursor", app: "Cursor", url: fileUrl("cursor") },
	{ id: "zed", label: "Zed", app: "Zed", url: fileUrl("zed") },
	{ id: "xcode", label: "Xcode", app: "Xcode" },
	{ id: "sublime", label: "Sublime Text", app: "Sublime Text", url: (abs, line) => `subl://open?url=${encodeURIComponent(`file://${abs}`)}${line ? `&line=${line}` : ""}` },
	{ id: "nova", label: "Nova", app: "Nova" },
];

const DEFAULT: OpenTarget = { id: "default", label: "Default App" };
const FINDER: OpenTarget = { id: "finder", label: "Reveal in Finder" };

async function run(argv: string[]): Promise<number> {
	return Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }).exited;
}

let installed: Promise<Editor[]> | null = null;

export async function openTargets(): Promise<OpenTarget[]> {
	if (process.platform !== "darwin") return [DEFAULT];
	installed ??= Promise.all(EDITORS.map((e) => run(["open", "-Ra", e.app]))).then((codes) => EDITORS.filter((_, i) => codes[i] === 0));
	const editors = await installed;
	return [...editors.map(({ id, label }) => ({ id, label })), DEFAULT, FINDER];
}

export async function openIn(id: string, abs: string, line: number | null): Promise<void> {
	const editor = EDITORS.find((e) => e.id === id);
	const argv =
		process.platform !== "darwin"
			? ["xdg-open", abs]
			: id === FINDER.id
				? ["open", "-R", abs]
				: !editor
					? ["open", abs]
					: editor.url
						? ["open", editor.url(abs, line)]
						: ["open", "-a", editor.app, abs];
	const code = await run(argv);
	if (code !== 0) throw new Error(`${argv[0]} exited with ${code}`);
}
