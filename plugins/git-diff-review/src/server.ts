import { type FSWatcher, watch } from "node:fs";
import { basename, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import type { Appearance } from "omp-integrations/appearance";
import { json, portRange, startPageServer } from "omp-integrations/server";
import { errorText } from "omp-integrations/text";
import { type Compare, fileLines, gitDir, initRepo, isRepo, listBranches, listCommits, loadReview, resolveInRoot } from "./git";
import { openIn, openTargets } from "./open-in";
import { PROTOCOL } from "./shared/protocol.js";
import { ReviewStore } from "./store";

const WEB_DIR = resolve(import.meta.dir, "..", "web");
export const DEFAULT_PORTS = portRange(9890);

export interface ReviewHooks {
	send(text: string): void;
	paste(text: string): void;
	sessionName(): string;
}

export interface ReviewServer {
	readonly port: number;
	readonly token: string;
	readonly root: string;
	url(compare: Compare): string;
	setRoot(root: string): void;
	setAppearance(appearance: Appearance | null): void;
	notifyChanged(): void;
	stop(): void;
}

export function parseCompare(params: URLSearchParams): Compare {
	const kind = params.get("kind");
	if (kind === "branch") return { kind, base: params.get("base") || null };
	if (kind === "commit") return { kind, sha: params.get("sha") || null };
	return { kind: "uncommitted" };
}

function compareQuery(compare: Compare): string {
	if (compare.kind === "branch") return compare.base ? `&kind=branch&base=${encodeURIComponent(compare.base)}` : "&kind=branch";
	if (compare.kind === "commit") return compare.sha ? `&kind=commit&sha=${encodeURIComponent(compare.sha)}` : "&kind=commit";
	return "";
}

export function startReviewServer(initialRoot: string, hooks: ReviewHooks, { store = new ReviewStore(), ports = DEFAULT_PORTS } = {}): ReviewServer {
	let root = initialRoot;
	let watcher: FSWatcher | null = null;
	let changeTimer: Timer | undefined;

	const notifyChanged = () => page.server.publish("review", JSON.stringify({ type: "changed" }));

	async function watchGit() {
		const watched = root;
		const dir = await gitDir(watched).catch(() => null);
		if (watched !== root) return;
		watcher?.close();
		watcher = null;
		if (!dir) return;
		try {
			watcher = watch(dir, { persistent: false }, () => {
				clearTimeout(changeTimer);
				changeTimer = setTimeout(notifyChanged, 250);
			});
		} catch {}
	}

	const hello = () => JSON.stringify({ type: "hello", protocol: PROTOCOL, root, name: basename(root), session: hooks.sessionName(), ...store.get(root) });

	async function api(pathname: string, params: URLSearchParams): Promise<Response> {
		switch (pathname) {
			case "/api/review":
				if (!(await isRepo(root))) return json({ files: [], branch: null, base: null, commit: null, notRepo: true });
				return json(await loadReview(root, parseCompare(params), { ignoreWhitespace: params.get("ws") === "1" }));
			case "/api/branches":
				return json(await listBranches(root));
			case "/api/commits":
				return json(await listCommits(root));
			case "/api/lines":
				return json(await fileLines(root, parseCompare(params), params.get("path") ?? ""));
			case "/api/open-targets":
				return json(await openTargets());
			case "/api/open": {
				const line = Number(params.get("line"));
				await openIn(params.get("target") ?? "default", resolveInRoot(root, params.get("path") ?? ""), line > 0 ? line : null);
				return json({ ok: true });
			}
			default:
				return json({ error: "not found" }, 404);
		}
	}

	function onMessage(ws: ServerWebSocket<undefined>, raw: string | Buffer) {
		let msg: { type?: string; pins?: unknown; viewed?: unknown; text?: unknown };
		try {
			msg = JSON.parse(String(raw));
		} catch {
			return;
		}
		if (msg.type === "pins" && Array.isArray(msg.pins)) {
			ws.publish("review", JSON.stringify({ type: "state", ...store.update(root, { pins: msg.pins }) }));
		} else if (msg.type === "viewed" && msg.viewed && typeof msg.viewed === "object") {
			ws.publish("review", JSON.stringify({ type: "state", ...store.update(root, { viewed: msg.viewed as Record<string, string> }) }));
		} else if (msg.type === "send" && typeof msg.text === "string" && msg.text.trim()) {
			hooks.send(msg.text);
		} else if (msg.type === "paste" && typeof msg.text === "string" && msg.text) {
			hooks.paste(msg.text);
		} else if (msg.type === "init") {
			isRepo(root)
				.then((repo) => repo || initRepo(root))
				.then(() => {
					notifyChanged();
					return watchGit();
				})
				.catch((error) => ws.send(JSON.stringify({ type: "error", message: errorText(error) })));
		}
	}

	const page = startPageServer({
		name: "git-diff-review",
		webDir: WEB_DIR,
		stateDir: store.dir,
		ports,
		fonts: true,
		api: (_req, url) => api(url.pathname, url.searchParams),
		websocket: {
			open(ws) {
				ws.subscribe("review");
				ws.send(hello());
			},
			message: onMessage,
		},
		onAppearance: () => page.server.publish("review", JSON.stringify({ type: "appearance" })),
	});
	void watchGit();

	return {
		port: page.port,
		token: page.token,
		get root() {
			return root;
		},
		url: (compare) => page.url() + compareQuery(compare),
		setRoot(next) {
			if (next === root) return;
			root = next;
			page.server.publish("review", hello());
			void watchGit();
		},
		setAppearance: page.setAppearance,
		notifyChanged,
		stop() {
			watcher?.close();
			clearTimeout(changeTimer);
			page.stop();
		},
	};
}
