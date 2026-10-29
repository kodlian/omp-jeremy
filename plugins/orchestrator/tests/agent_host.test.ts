import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PRELUDE = String.raw`
import json, sys
from agent_host import Screen, preview

def shown(screen, palette=None, private=True):
    lines = screen.recent(120)
    rows = json.loads(json.dumps([runs for _, runs in lines]))
    return preview("\n".join(text for text, _ in lines), rows, palette or {}, private, 120)
`;

type Run = { text: string; fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; inverse?: boolean };
type Preview = { text: string; rows?: Run[][] };

function py<T>(code: string): T {
	const run = Bun.spawnSync(["python3", "-c", PRELUDE + code], { cwd: ROOT, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
	if (run.exitCode !== 0) throw new Error(run.stderr.toString());
	const value: T = JSON.parse(run.stdout.toString());
	return value;
}

test("16, 256 and truecolor SGR colors, flags and resets become styled runs beside unchanged text", () => {
	const out = py<{ default: Preview; themed: Preview; text: string }>(String.raw`
s = Screen(10, 40)
s.feed(b"\x1b[31mred\x1b[0m \x1b[1;38;5;208mor\x1b[22;39mange \x1b[38;2;1;2;3;48;2;250;251;252mtc\x1b[m\r\n")
s.feed(b"\x1b[7minv\x1b[27m x \x1b[2;3;9;4mfx\x1b[m \x1b[38:2::9:8:7mcolon\x1b[m")
print(json.dumps({"default": shown(s), "themed": shown(s, {1: "#112233"}), "text": s.text(120)}))
`);
	expect(out.default.text).toBe("red orange tc\ninv x fx colon");
	expect(out.default.text).toBe(out.text);
	expect(out.default.rows).toEqual([
		[{ text: "red", fg: "#cd0000" }, { text: " " }, { text: "or", fg: "#ff8700", bold: true }, { text: "ange " },
			{ text: "tc", fg: "#010203", bg: "#fafbfc" }],
		[{ text: "inv", inverse: true }, { text: " x " }, { text: "fx", dim: true, italic: true, strike: true, underline: true },
			{ text: " " }, { text: "colon", fg: "#090807" }],
	]);
	expect(out.themed.rows?.[0]?.[0]).toEqual({ text: "red", fg: "#112233" });
});

test("cursor edits, erases and scrollback keep each cell's own style", () => {
	const out = py<Preview>(String.raw`
s = Screen(3, 20)
s.feed(b"\x1b[32mabcdef\x1b[0m\r\x1b[2C\x1b[4mXY\x1b[0m\r\n")
s.feed(b"\x1b[44mhello\x1b[0m\x1b[3D\x1b[K\r\n")
for i in range(3):
    s.feed(b"\r\n\x1b[9%dmline%d\x1b[0m" % (i, i))
print(json.dumps(shown(s)))
`);
	expect(out.text).toBe("abXYef\nhe\n\nline0\nline1\nline2");
	expect(out.rows).toEqual([
		[{ text: "ab", fg: "#00cd00" }, { text: "XY", underline: true }, { text: "ef", fg: "#00cd00" }],
		[{ text: "he", bg: "#0000ee" }],
		[],
		[{ text: "line0", fg: "#7f7f7f" }],
		[{ text: "line1", fg: "#ff0000" }],
		[{ text: "line2", fg: "#00ff00" }],
	]);
});

test("markup, OSC strings, wide and private-use characters stay screen text aligned with their runs", () => {
	const out = py<{ kept: Preview; plain: Preview }>(String.raw`
s = Screen(5, 60)
s.feed("\x1b]0;evil title\x07\x1b[31m<img src=x onerror=alert(1)>\x1b[0m\r\n".encode())
s.feed("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ \x1b[32m漢字\ue0b0end\x1b[0m\r\n".encode())
s.feed("a\u2028\x1b[33mb\x1b[0m".encode())
print(json.dumps({"kept": shown(s), "plain": shown(s, private=False)}))
`);
	expect(out.kept.text).toBe("<img src=x onerror=alert(1)>\nlink 漢字\ue0b0end\na\nb");
	expect(out.kept.rows).toEqual([
		[{ text: "<img src=x onerror=alert(1)>", fg: "#cd0000" }],
		[{ text: "link " }, { text: "漢字\ue0b0end", fg: "#00cd00" }],
		[{ text: "a" }],
		[{ text: "b", fg: "#cdcd00" }],
	]);
	expect(out.plain.text).toBe("<img src=x onerror=alert(1)>\nlink 漢字end\na\nb");
	expect(out.plain.rows?.[1]).toEqual([{ text: "link " }, { text: "漢字end", fg: "#00cd00" }]);
	expect(JSON.stringify(out)).not.toContain("evil");
	expect(JSON.stringify(out)).not.toContain("example.com");
	expect(JSON.stringify(out)).not.toMatch(/\\u001b|\x1b/);
});

test("a text-only reply, or rows that don't spell the text, previews uncolored", () => {
	const out = py<Preview[]>(String.raw`
text = "one  \n\ntwo\ue0b0\n\n"
print(json.dumps([preview(text, None, {}, False, 120), preview(text, [[["one", "31"]]], {}, False, 120),
                  preview(text, "rows", {}, False, 120), preview(text, [[["x", 1]]], {}, False, 120)]))
`);
	for (const result of out) expect(result).toEqual({ text: "one\n\ntwo" });
});

test("a detached PTY host reports its colored output as rows", () => {
	const out = py<{ preview: Preview; plain: string }>(String.raw`
import shutil, tempfile, time
from pathlib import Path
import agent_host
root = Path(tempfile.mkdtemp(dir="/tmp"))
directory = root / "host"
agent_host.prepare(directory, {"argv": ["/bin/sh", "-c", "printf '\\033[31mred\\033[0m \\033[1;38;5;45mplain\\033[0m\\n'; exec sleep 30"],
                               "cwd": str(root)})
try:
    agent_host.ensure(directory)
    deadline = time.monotonic() + 10
    while True:
        reply = agent_host.screen(directory, 120, styled=True)
        if "red plain" in reply["text"] or time.monotonic() > deadline:
            break
        time.sleep(0.1)
    print(json.dumps({"preview": preview(reply["text"], reply.get("rows"), {}, True, 120),
                      "plain": agent_host.output(directory, 120)}))
finally:
    agent_host.terminate(directory)
    shutil.rmtree(root, ignore_errors=True)
`);
	expect(out.preview.text).toBe("red plain");
	expect(out.plain).toBe("red plain");
	expect(out.preview.rows).toEqual([[{ text: "red", fg: "#cd0000" }, { text: " " }, { text: "plain", fg: "#00d7ff", bold: true }]]);
}, 30000);
