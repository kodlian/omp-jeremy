import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTab } from "../src/terminal";

const WINDOW = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const PANE = "00000000-0000-4000-8000-000000000003";
const TERMINAL = "00000000-0000-4000-8000-000000000004";
const PAGE = "00000000-0000-4000-8000-000000000005";
const URL = "http://127.0.0.1:4100/";

// A stand-in cmux CLI: logs each call's arguments, prints $FAKE_CMUX_TREE for tree, and reports the tab new-surface creates.
const FAKE_CMUX = `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[3:]
with open(os.environ["FAKE_CMUX_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
if "list-panels" in args:
    print(json.dumps({"surfaces": [{"id": "${TERMINAL}"}]}))
elif "tree" in args:
    print(os.environ["FAKE_CMUX_TREE"])
elif "new-surface" in args:
    print(json.dumps({"surface_id": "${PAGE}"}))
`;

type CmuxState = { key: boolean; selected: boolean; pageOpen?: boolean };
const IN_FRONT: CmuxState = { key: true, selected: true };
// Another workspace selected in cmux; another app in front of cmux.
const BEHIND: CmuxState[] = [{ key: true, selected: false }, { key: false, selected: true }];

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const focusing = (args: string[]) => args.includes("focus-panel") || args.includes("select-workspace");

/** Opens the page beside the terminal with cmux in `state`; returns the cmux calls it made. */
async function open({ key, selected, pageOpen = false }: CmuxState): Promise<string[][]> {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "terminal-tab-")));
	dirs.push(dir);
	const cli = join(dir, "cmux");
	writeFileSync(cli, FAKE_CMUX);
	chmodSync(cli, 0o755);
	const surfaces = [{ id: TERMINAL, type: "terminal" }, ...(pageOpen ? [{ id: PAGE, type: "browser", url: `${URL}?review=1` }] : [])];
	const pane = { id: PANE, surface_ids: surfaces.map((s) => s.id), surfaces };
	const tree = { windows: [{ id: WINDOW, key, workspaces: [{ id: WORKSPACE, selected, panes: [pane] }] }] };
	const log = join(dir, "calls.jsonl");
	const socket = join(dir, "cmux.sock");
	const env = { PATH: `${dir}:${process.env.PATH}`, FAKE_CMUX_LOG: log, FAKE_CMUX_TREE: JSON.stringify(tree), PYTHONDONTWRITEBYTECODE: "1" };
	const context = { kind: "cmux" as const, cmux: { cli, socket, workspace: WORKSPACE, surface: TERMINAL } };
	expect(await openTab(URL, { context, env })).toEqual({ cli, socket, workspace: WORKSPACE, surface: PAGE });
	return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
}

test("a new page tab takes the focus only while its workspace is in front", async () => {
	const focusOf = async (state: CmuxState) => {
		const calls = await open(state);
		expect(calls.filter(focusing)).toEqual([]);
		const created = calls.find((args) => args.includes("new-surface")) ?? [];
		return created[created.indexOf("--focus") + 1];
	};
	expect(await focusOf(IN_FRONT)).toBe("true");
	for (const state of BEHIND) expect(await focusOf(state)).toBe("false");
});

test("a page tab already open comes forward only while its workspace is in front", async () => {
	expect((await open({ ...IN_FRONT, pageOpen: true })).filter(focusing)).toHaveLength(1);
	for (const state of BEHIND) {
		const calls = await open({ ...state, pageOpen: true });
		expect(calls.some((args) => args.includes("navigate"))).toBe(true);
		expect(calls.filter(focusing)).toEqual([]);
	}
});
