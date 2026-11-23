import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PRELUDE = String.raw`
import json, sys
from screen import plain_text, preview, rows_from_ansi

def shown(captured, palette=None, private=True):
    rows = json.loads(json.dumps(rows_from_ansi(captured)))
    return preview(plain_text(captured), rows, palette or {}, private, 120)
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
captured = ("\x1b[31mred\x1b[0m \x1b[1;38;5;208mor\x1b[22;39mange \x1b[38;2;1;2;3;48;2;250;251;252mtc\x1b[m\n"
            "\x1b[7minv\x1b[27m x \x1b[2;3;9;4mfx\x1b[m \x1b[38:2::9:8:7mcolon\x1b[m\n")
print(json.dumps({"default": shown(captured), "themed": shown(captured, {1: "#112233"}), "text": plain_text(captured)}))
`);
	expect(out.default.text).toBe("red orange tc\ninv x fx colon");
	expect(out.text).toBe("red orange tc\ninv x fx colon\n");
	expect(out.default.rows).toEqual([
		[{ text: "red", fg: "#cd0000" }, { text: " " }, { text: "or", fg: "#ff8700", bold: true }, { text: "ange " },
			{ text: "tc", fg: "#010203", bg: "#fafbfc" }],
		[{ text: "inv", inverse: true }, { text: " x " }, { text: "fx", dim: true, italic: true, strike: true, underline: true },
			{ text: " " }, { text: "colon", fg: "#090807" }],
	]);
	expect(out.themed.rows?.[0]?.[0]).toEqual({ text: "red", fg: "#112233" });
});

test("a style carries across lines until reset, and blank lines keep their place", () => {
	const out = py<Preview>(String.raw`
captured = "\x1b[1;38;5;12mhi\x1b[0m there\n\x1b[48;2;1;2;3mx\n\n\x1b[94mline\x1b[39m end\x1b[0m\n\n\n"
print(json.dumps(shown(captured)))
`);
	expect(out.text).toBe("hi there\nx\n\nline end");
	expect(out.rows).toEqual([
		[{ text: "hi", fg: "#5c5cff", bold: true }, { text: " there" }],
		[{ text: "x", bg: "#010203" }],
		[],
		[{ text: "line", bg: "#010203", fg: "#5c5cff" }, { text: " end", bg: "#010203" }],
	]);
});

test("markup, OSC strings, other escapes, wide and private-use characters stay text aligned with their runs", () => {
	const out = py<{ kept: Preview; plain: Preview }>(String.raw`
captured = ("\x1b]0;evil title\x07\x1b[31m<img src=x onerror=alert(1)>\x1b[0m\x1b[?25l\n"
            "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ \x1b[32m漢字\ue0b0end\x1b[0m\x1b(B\n"
            "a\u2028\x1b[33mb\x1b[0m\n")
print(json.dumps({"kept": shown(captured), "plain": shown(captured, private=False)}))
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
