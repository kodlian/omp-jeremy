import { expect, test } from "bun:test";
import { PlanSource } from "../src/anchor";

const PLAN = [
	"# Plan: Demo",
	"",
	"## Context",
	"",
	"The meal log loses entries offline.",
	"",
	"## Design",
	"",
	"Table `meal` mirrors the **server** document.",
	"- Context for later: see [docs](https://x.y/docs).",
	"- Changes sync in the order they were made.",
	"",
	"## Steps",
	"",
	"1. Add the store.",
	"2. Notes about what were made.",
	"",
].join("\n");

// The plan body as omp draws it: title and headings without their #, inline markup gone, a list item wrapped.
const ROWS = [
	"Plan: Demo",
	"",
	"Context",
	"",
	"The meal log loses entries offline.",
	"",
	"Design",
	"",
	"Table meal mirrors the server document.",
	"- Context for later: see docs.",
	"- Changes sync in the order they",
	"were made.",
	"",
	"Steps",
	"",
	"1. Add the store.",
	"2. Notes about what were made.",
];

const TITLE = "# Plan: Demo\n".length;

test("a line whose Markdown markup omp drops is found in the source", () => {
	const source = new PlanSource(PLAN);
	expect(source.locate(ROWS, 8)).toBe(PLAN.indexOf("Table `meal`"));
	expect(source.locate(ROWS, 9)).toBe(PLAN.indexOf("Context for later"));
});

test("a repeated word or wrapped line end is placed by the lines around it", () => {
	const source = new PlanSource(PLAN);
	expect(source.locate(ROWS, 2)).toBe(PLAN.indexOf("Context"));
	expect(source.locate(ROWS, 11)).toBe(PLAN.indexOf("were made."));
	expect(source.locate(ROWS, 16)).toBe(PLAN.indexOf("2. Notes"));
});

test("a comment quotes the selected plan lines, skips omp's notes, and is placed past the title line", () => {
	const source = new PlanSource(PLAN);
	expect(source.target(ROWS, 10, 11)).toEqual({ quote: "- Changes sync in the order they\nwere made.", at: PLAN.indexOf("Changes sync") - TITLE });
	const withNote = [...ROWS.slice(0, 9), "▎ “Table meal mirrors the server document.”", "▎ note: why?", ...ROWS.slice(9)];
	expect(source.target(withNote, 8, 11)?.quote).toBe("Table meal mirrors the server document.\n- Context for later: see docs.");
	expect(source.target(withNote, 9, 10)).toBeNull();
	expect(source.target(ROWS, 12, 12)).toBeNull();
});

test("lines that aren't plan text get no comment", () => {
	const source = new PlanSource(PLAN);
	expect(source.target(["├──────┼──────┤"], 0, 0)).toBeNull();
	expect(source.target(["Nothing like this is in the plan"], 0, 0)).toBeNull();
});

test("the title is the only shallowest heading when it comes first; fenced code doesn't count", () => {
	const twoTops = "# One\n\nFirst line here.\n\n# Two\n\nSecond line here.\n";
	expect(new PlanSource(twoTops).target(["Second line here."], 0, 0)?.at).toBe(twoTops.indexOf("Second"));
	const fenced = "```sh\n# not a heading\n```\n# Title\n\n## Part\n\nBody line here.\n";
	const at = fenced.indexOf("Body");
	expect(new PlanSource(fenced).target(["Body line here."], 0, 0)?.at).toBe(at - "# Title\n".length);
});
