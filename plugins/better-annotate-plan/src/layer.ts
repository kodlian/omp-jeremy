// A layer over omp's own plan review: it draws the review exactly as omp renders it and passes it every click, and
// every key but those that select plan lines, move or extend the selection, scroll the plan and annotate it. The
// note goes into omp's review through the event omp takes Tern's native comments with, so omp shows it under the
// line and sends it with Refine.
import { formatKeyHint, formatKeyHints } from "@oh-my-pi/pi-coding-agent";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { getKeybindings, Input, matchesKey, sliceByColumn, theme, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { type CommentTarget, isPlanText, PlanSource, quoteOf } from "./anchor";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** The layer's key hints, in omp's own key symbols as its review's help line draws them. */
function selectionHint(): string {
	return [
		`${formatKeyHints(["up", "down"])} move`,
		`${formatKeyHints(["shift+up", "shift+down"])} extend`,
		`${formatKeyHints(["alt+up", "alt+down"])} scroll`,
		`${formatKeyHint("a")} annotate`,
		`${formatKeyHint("escape")} clear`,
	].join(" · ");
}

function unplacedNotice(): string {
	return `This line isn't text from the plan, so it can't take a note · ${formatKeyHint("escape")} clear`;
}

/** First footer line of omp's own note editor and note chooser, while they have the keyboard. */
const OMP_EDITING = /^(?:Annotate|Edit annotation)\b/;
/** Wheel steps the layer scrolls omp's review for one key at most: more than any plan needs, a stop should it never settle. */
const MAX_SCROLLS = 500;

/** omp's plan review screen, as far as the layer drives it. Not a published omp API: it is found by its shape. */
export interface OmpReview {
	render(width: number): readonly string[];
	handleInput(data: string): void;
	handleNativeEvent(event: { type: "comment"; key: string; quote: string; at: number; note: string }): void;
	invalidate?(): void;
}

function isReview(component: unknown): component is OmpReview {
	return (
		typeof component === "object" &&
		component !== null &&
		"handleNativeEvent" in component &&
		typeof component.handleNativeEvent === "function" &&
		"selectOption" in component &&
		typeof component.selectOption === "function"
	);
}

/** omp's open plan review among the TUI's overlays, when this omp still has what the layer drives. */
export function findReview(tui: TUI): OmpReview | null {
	for (const { component } of [...tui.overlayStack].reverse()) if (isReview(component)) return component;
	return null;
}

/** Where omp drew the plan's text in a frame: columns [start, end) of rows first..last. */
interface Frame {
	lines: string[];
	start: number;
	end: number;
	first: number;
	last: number;
	/** omp's own note editor or note chooser has the keyboard. */
	editing: boolean;
}

function readFrame(styled: readonly string[], width: number): Frame | null {
	const lines = styled.map((line) => line.replace(ANSI, ""));
	const box = theme.boxRound;
	const dividers = lines.flatMap((line, row) => (row > 0 && line.startsWith(box.teeRight) ? [row] : []));
	const body = dividers[0];
	const footer = dividers.at(-1);
	if (body === undefined || footer === undefined || body < 2) return null;
	const top = lines[0] ?? "";
	const split = top.indexOf(box.teeDown);
	const editing = OMP_EDITING.test(sliceByColumn(lines[footer + 1] ?? "", 2, width - 4).trim());
	return { lines, start: split > 0 ? visibleWidth(top.slice(0, split)) + 2 : 2, end: width - 3, first: 1, last: body - 1, editing };
}

interface Selection {
	/** The selected rows' text, top to bottom, blank rows between plan lines included. */
	lines: string[];
	/** Screen row of the first selected row when last drawn; off screen once it scrolled away. */
	row: number;
	target: CommentTarget | null;
	/** The end Shift+↑/↓ moves; the other one stays put. */
	moving: "first" | "last";
}

/** Screen rows of the selection in a frame; they may run past the plan body's edges. */
interface Span {
	first: number;
	last: number;
}

export class ReviewLayer implements Component {
	readonly debugKind = "plan-review-layer";
	readonly #source: PlanSource;
	#width = 0;
	#frame: Frame | null = null;
	/** Each screen row's plan text; empty outside the plan body. */
	#rows: string[] = [];
	#selection: Selection | null = null;
	/** The row the mouse button went down on, while it is held. */
	#anchor: number | null = null;
	#box: { input: Input; target: CommentTarget } | null = null;
	#notice: string | null = null;

	constructor(
		private readonly tui: TUI,
		private readonly review: OmpReview,
		plan: string,
		/** Called once omp's review has left the screen, however it ended. */
		private readonly onGone: () => void,
	) {
		this.#source = new PlanSource(plan);
	}

	render(width: number): readonly string[] {
		if (!this.tui.overlayStack.some((entry) => entry.component === this.review)) queueMicrotask(this.onGone);
		const lines = [...this.review.render(width)];
		this.#read(lines, width);
		const frame = this.#frame;
		if (!frame) return lines;
		const span = this.#locate();
		if (span) {
			for (let row = Math.max(span.first, frame.first); row <= Math.min(span.last, frame.last); row++) {
				lines[row] = this.#highlight(lines[row] ?? "", frame, width);
			}
		}
		const count = lines.length;
		const box = this.#box;
		if (box) {
			const quote = box.target.quote.split("\n");
			const more = quote.length > 1 ? ` and ${quote.length - 1} more line${quote.length > 2 ? "s" : ""}` : "";
			lines[count - 3] = boxRule(theme.boxRound.teeRight, theme.boxRound.teeLeft, theme.fg("accent", `Annotate “${quote[0]}”${more}`), width);
			lines[count - 2] = boxRow(box.input.render(width - 4)[0] ?? "", width);
			lines[count - 1] = boxRule(theme.boxRound.bottomLeft, theme.boxRound.bottomRight, theme.fg("dim", `${formatKeyHint("enter")} save · ${formatKeyHint("escape")} cancel`), width);
		} else if (this.#selection) {
			lines[count - 2] = boxRow(this.#notice ? theme.fg("warning", this.#notice) : theme.fg("dim", selectionHint()), width);
		}
		return lines;
	}

	handleInput(data: string): void {
		const cancel = getKeybindings().matches(data, "tui.select.cancel");
		const box = this.#box;
		if (box) {
			if (cancel) this.#box = null;
			else if (matchesKey(data, "enter")) this.#save(box);
			else if (data.startsWith("\x1b[<")) {
				for (const [report, button] of data.matchAll(MOUSE)) if (Number(button) & 64) this.review.handleInput(report);
			} else box.input.handleInput(data);
			this.tui.requestRender();
			return;
		}
		const reports = data.startsWith("\x1b[<") ? [...data.matchAll(MOUSE)] : [];
		if (reports.length > 0) {
			for (const [report, button, col, row, kind] of reports) {
				this.#mouse(Number(button), Number(col) - 1, Number(row) - 1, kind === "m");
				this.review.handleInput(report);
			}
			this.tui.requestRender();
			return;
		}
		// omp's own note editor or note chooser has the keyboard: every key is its.
		if (this.#frame?.editing) {
			this.review.handleInput(data);
			return;
		}
		const scroll = matchesKey(data, "alt+up") ? -1 : matchesKey(data, "alt+down") ? 1 : 0;
		if (scroll !== 0 && this.#frame) {
			this.#scroll(scroll);
			this.tui.requestRender();
			return;
		}
		const selection = this.#selection;
		if (!selection) {
			if (matchesKey(data, "a") && this.#selectTop()) this.tui.requestRender();
			else this.review.handleInput(data);
			return;
		}
		if (cancel) {
			this.#clear();
			return;
		}
		if (matchesKey(data, "a")) {
			this.#openBox(selection);
			return;
		}
		// omp's page keys scroll its review; the selection stays on its line.
		if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			this.review.handleInput(data);
			return;
		}
		const extend = matchesKey(data, "shift+up") || matchesKey(data, "shift+down");
		const direction = matchesKey(data, "up") || matchesKey(data, "shift+up") ? -1 : matchesKey(data, "down") || matchesKey(data, "shift+down") ? 1 : 0;
		if (direction !== 0 && this.#reveal()) {
			this.#notice = null;
			if (extend) this.#extend(selection, direction);
			else this.#move(direction);
			this.tui.requestRender();
			return;
		}
		// Any other key belongs to omp's review, and the selection goes.
		this.#clear();
		this.review.handleInput(data);
	}

	invalidate(): void {
		this.review.invalidate?.();
	}

	#read(styled: readonly string[], width: number): void {
		const frame = readFrame(styled, width);
		this.#width = width;
		this.#frame = frame;
		this.#rows = frame
			? frame.lines.map((line, row) => (row >= frame.first && row <= frame.last ? sliceByColumn(line, frame.start, frame.end - frame.start).trim() : ""))
			: [];
	}

	/** A press or drag on the plan's text selects it; omp gets every report too, so that click also gives omp's plan the focus. */
	#mouse(button: number, col: number, row: number, release: boolean): void {
		const frame = this.#frame;
		if (!frame || frame.editing) return;
		const left = (button & 0b11) === 0 && (button & 64) === 0;
		const drag = left && (button & 32) !== 0;
		if (left && !drag && !release && row >= frame.first && row <= frame.last && col >= frame.start && col < frame.end) {
			this.#notice = null;
			this.#anchor = isPlanText(this.#rows[row] ?? "") ? row : null;
			this.#selection = this.#anchor === null ? null : this.#select(row, row);
		} else if (drag && this.#anchor !== null) {
			this.#selection = this.#select(this.#anchor, Math.max(frame.first, Math.min(frame.last, row)));
		} else if (release) {
			this.#anchor = null;
		}
	}

	/** Screen rows `from` to `to` of this frame as the selection; Shift+↑/↓ then move the `to` end. */
	#select(from: number, to: number): Selection {
		const [first, last] = from <= to ? [from, to] : [to, from];
		return { lines: this.#rows.slice(first, last + 1), row: first, target: this.#source.target(this.#rows, first, last), moving: from <= to ? "last" : "first" };
	}

	/** `a` with nothing selected: the first plan line on screen becomes the selection, and omp's plan gets the focus as a click there gives it. */
	#selectTop(): boolean {
		const frame = this.#frame;
		if (!frame) return false;
		for (let row = frame.first; row <= frame.last; row++) {
			if (isPlanText(this.#rows[row] ?? "")) {
				this.#notice = null;
				this.#selection = this.#select(row, row);
				this.review.handleInput(`\x1b[<0;${frame.start + 1};${row + 1}M`);
				return true;
			}
		}
		return false;
	}

	/** Where the selection's rows are in this frame, nearest to where they were; they may run past the body's edges. */
	#locate(): Span | null {
		const frame = this.#frame;
		const selection = this.#selection;
		if (!frame || !selection) return null;
		const count = selection.lines.length;
		let best: number | null = null;
		for (let start = frame.first - count + 1; start <= frame.last; start++) {
			let shown = 0;
			let fits = true;
			for (let i = 0; i < count && fits; i++) {
				const row = start + i;
				if (row < frame.first || row > frame.last) continue;
				const line = selection.lines[i] ?? "";
				fits = this.#rows[row] === line;
				if (fits && isPlanText(line)) shown++;
			}
			if (fits && shown > 0 && (best === null || Math.abs(start - selection.row) < Math.abs(best - selection.row))) best = start;
		}
		if (best === null) return null;
		selection.row = best;
		return { first: best, last: best + count - 1 };
	}

	/** The selection's rows, scrolling omp's review back to them when a scroll took them off screen; null when they're gone. */
	#reveal(): Span | null {
		const frame = this.#frame;
		const selection = this.#selection;
		if (!frame || !selection) return null;
		const toward = selection.row < (frame.first + frame.last) / 2 ? -1 : 1;
		for (const direction of [toward, -toward] as const) {
			for (let scrolls = 0; scrolls < MAX_SCROLLS; scrolls++) {
				const span = this.#locate();
				if (span) return span;
				if (!this.#scroll(direction)) break;
			}
		}
		return this.#locate();
	}

	/** ↑/↓: the plan line past the selection becomes the selection. */
	#move(direction: 1 | -1): void {
		const next = this.#beyond(direction > 0 ? "last" : "first", direction);
		if (next) this.#selection = this.#select(next.row, next.row);
	}

	/** Shift+↑/↓: the moving end takes in the next plan line, or gives back its last one when it heads for the other end. */
	#extend(selection: Selection, direction: 1 | -1): void {
		const single = selection.lines.filter(isPlanText).length === 1;
		const moving = single ? (direction > 0 ? "last" : "first") : selection.moving;
		if ((moving === "last") === direction > 0) this.#grow(selection, moving, direction);
		else this.#shrink(selection, moving);
	}

	#grow(selection: Selection, moving: "first" | "last", direction: 1 | -1): void {
		const next = this.#beyond(moving, direction);
		if (!next) return;
		const { span, row } = next;
		const lines = direction > 0 ? [...selection.lines, ...this.#rows.slice(span.last + 1, row + 1)] : [...this.#rows.slice(row, span.first), ...selection.lines];
		const first = direction > 0 ? span.first : row;
		this.#selection = { lines, row: first, moving, target: this.#targetFor(lines, first, selection.target) };
	}

	#shrink(selection: Selection, moving: "first" | "last"): void {
		const span = this.#locate();
		if (!span) return;
		const lines = [...selection.lines];
		let first = span.first;
		if (moving === "last") {
			lines.pop();
			while (lines.length > 0 && !isPlanText(lines.at(-1) ?? "")) lines.pop();
		} else {
			do {
				lines.shift();
				first++;
			} while (lines.length > 0 && !isPlanText(lines[0] ?? ""));
		}
		this.#selection = { lines, row: first, moving, target: this.#targetFor(lines, first, selection.target) };
	}

	/** The comment on `lines` drawn from screen row `first`: placed by its first plan line while that line shows, else where it was placed before. */
	#targetFor(lines: readonly string[], first: number, previous: CommentTarget | null): CommentTarget | null {
		const quote = quoteOf(lines);
		const row = first + lines.findIndex(isPlanText);
		const frame = this.#frame;
		const at = frame && row >= frame.first && row <= frame.last ? this.#source.at(this.#rows, row) : (previous?.at ?? null);
		return quote && at !== null ? { quote, at } : null;
	}

	/** The selection's rows and the first plan line past its `end` going `direction`, scrolling omp's review until that line shows; null at the plan's end. */
	#beyond(end: "first" | "last", direction: 1 | -1): { span: Span; row: number } | null {
		for (let scrolls = 0; scrolls <= MAX_SCROLLS; scrolls++) {
			const frame = this.#frame;
			const span = this.#locate();
			if (!frame || !span) return null;
			for (let row = span[end] + direction; row >= frame.first && row <= frame.last; row += direction) {
				if (isPlanText(this.#rows[row] ?? "")) return { span, row };
			}
			if (!this.#scroll(direction)) return null;
		}
		return null;
	}

	/** One wheel step of omp's review; false when its plan didn't move, at an end of the plan. */
	#scroll(direction: 1 | -1): boolean {
		const frame = this.#frame;
		if (!frame) return false;
		const before = this.#rows.join("\n");
		this.review.handleInput(`\x1b[<${direction > 0 ? 65 : 64};${frame.start + 1};${frame.first + 1}M`);
		this.#read(this.review.render(this.#width), this.#width);
		return this.#rows.join("\n") !== before;
	}

	#highlight(line: string, frame: Frame, width: number): string {
		const body = sliceByColumn(line.replace(ANSI, ""), frame.start, frame.end - frame.start);
		return `${sliceByColumn(line, 0, frame.start)}\x1b[0m${theme.bg("selectedBg", theme.fg("text", body))}${sliceByColumn(line, frame.end, width - frame.end)}`;
	}

	#openBox(selection: Selection): void {
		if (selection.target) {
			const input = new Input();
			input.focused = true;
			this.#box = { input, target: selection.target };
		} else {
			this.#notice = unplacedNotice();
		}
		this.tui.requestRender();
	}

	#save(box: { input: Input; target: CommentTarget }): void {
		this.#box = null;
		const note = box.input.getValue().trim();
		if (!note) return;
		this.review.handleNativeEvent({ type: "comment", key: "doc", quote: box.target.quote, at: box.target.at, note });
		this.#selection = null;
	}

	#clear(): void {
		this.#selection = null;
		this.#notice = null;
		this.#anchor = null;
		this.tui.requestRender();
	}
}

/** A row of omp's review box holding `content`. */
function boxRow(content: string, width: number): string {
	const bar = theme.fg("border", theme.boxRound.vertical);
	return `${bar} ${truncateToWidth(content, Math.max(0, width - 4), undefined, true)} ${bar}`;
}

/** A rule of omp's review box between `left` and `right` corners, carrying `label`. */
function boxRule(left: string, right: string, label: string, width: number): string {
	const text = truncateToWidth(` ${label} `, Math.max(0, width - 4));
	const fill = Math.max(0, width - 3 - visibleWidth(text));
	return `${theme.fg("border", left + theme.boxRound.horizontal)}${text}${theme.fg("border", theme.boxRound.horizontal.repeat(fill) + right)}`;
}
