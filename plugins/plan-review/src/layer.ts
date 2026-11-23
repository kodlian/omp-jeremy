// A layer over omp's own plan review: it draws the review exactly as omp renders it and passes keys and clicks
// through, except that a click or drag on the plan selects lines, and c or Enter comments on them. The comment goes
// into omp's review through the event omp takes Tern's native comments with, so omp shows it under the line and
// sends it with Refine.
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { getKeybindings, Input, matchesKey, sliceByColumn, theme, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { type CommentTarget, NOTE_BAR, PlanSource } from "./anchor";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const SELECTION_HINT = "c or enter comment on the selection · drag select more lines · esc clear the selection";
const UNPLACED = "This line isn't text from the plan, so it can't take a comment · esc clear the selection";
/** First footer line of omp's own note editor and note chooser, while they have the keyboard. */
const OMP_EDITING = /^(?:Annotate|Edit annotation)\b/;

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
	/** The selected rows' text, top to bottom. */
	lines: string[];
	/** Screen row of the first selected row when last drawn. */
	row: number;
	target: CommentTarget | null;
}

export class ReviewLayer implements Component {
	readonly debugKind = "plan-review-layer";
	readonly #source: PlanSource;
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
		const frame = readFrame(lines, width);
		this.#frame = frame;
		this.#rows = frame
			? frame.lines.map((line, row) => (row >= frame.first && row <= frame.last ? sliceByColumn(line, frame.start, frame.end - frame.start).trim() : ""))
			: [];
		if (!frame) return lines;
		for (const row of this.#selectedRows(frame)) lines[row] = this.#highlight(lines[row] ?? "", frame, width);
		const count = lines.length;
		const box = this.#box;
		if (box) {
			const quote = box.target.quote.split("\n");
			const more = quote.length > 1 ? ` and ${quote.length - 1} more line${quote.length > 2 ? "s" : ""}` : "";
			lines[count - 3] = boxRule(theme.boxRound.teeRight, theme.boxRound.teeLeft, theme.fg("accent", `Comment on “${quote[0]}”${more}`), width);
			lines[count - 2] = boxRow(box.input.render(width - 4)[0] ?? "", width);
			lines[count - 1] = boxRule(theme.boxRound.bottomLeft, theme.boxRound.bottomRight, theme.fg("dim", "enter save · esc cancel"), width);
		} else if (this.#selection) {
			lines[count - 2] = boxRow(this.#notice ? theme.fg("warning", this.#notice) : theme.fg("dim", SELECTION_HINT), width);
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
				if (!this.#mouse(Number(button), Number(col) - 1, Number(row) - 1, kind === "m")) this.review.handleInput(report);
			}
			this.tui.requestRender();
			return;
		}
		if (this.#selection) {
			if (cancel) {
				this.#clear();
				return;
			}
			if (matchesKey(data, "c") || matchesKey(data, "enter")) {
				this.#openBox(this.#selection);
				return;
			}
			// Any other key belongs to omp's review, and the selection goes.
			this.#clear();
		}
		this.review.handleInput(data);
	}

	invalidate(): void {
		this.review.invalidate?.();
	}

	/** A press or drag on the plan's text selects it; false leaves the report to omp (sidebar, answers, wheel). */
	#mouse(button: number, col: number, row: number, release: boolean): boolean {
		const frame = this.#frame;
		if (!frame || frame.editing) return false;
		const left = (button & 0b11) === 0 && (button & 64) === 0;
		const drag = left && (button & 32) !== 0;
		if (left && !drag && !release && row >= frame.first && row <= frame.last && col >= frame.start && col < frame.end) {
			const text = this.#rows[row] ?? "";
			this.#notice = null;
			this.#anchor = text && !text.startsWith(NOTE_BAR) ? row : null;
			this.#selection = this.#anchor === null ? null : this.#select(row, row);
			return true;
		}
		if (drag && this.#anchor !== null) {
			this.#selection = this.#select(this.#anchor, Math.max(frame.first, Math.min(frame.last, row)));
			return true;
		}
		if (release && this.#anchor !== null) {
			this.#anchor = null;
			return true;
		}
		return false;
	}

	#select(from: number, to: number): Selection {
		const [first, last] = from <= to ? [from, to] : [to, from];
		return { lines: this.#rows.slice(first, last + 1), row: first, target: this.#source.target(this.#rows, first, last) };
	}

	/** Screen rows the selection occupies in this frame: where its text is drawn, nearest to where it was. */
	#selectedRows(frame: Frame): number[] {
		const selection = this.#selection;
		if (!selection) return [];
		let best = -1;
		for (let row = frame.first; row <= frame.last; row++) {
			const fits = selection.lines.every((line, i) => row + i > frame.last || this.#rows[row + i] === line);
			if (fits && (best < 0 || Math.abs(row - selection.row) < Math.abs(best - selection.row))) best = row;
		}
		if (best < 0) return [];
		selection.row = best;
		return selection.lines.map((_, i) => best + i).filter((row) => row <= frame.last);
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
			this.#notice = UNPLACED;
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
