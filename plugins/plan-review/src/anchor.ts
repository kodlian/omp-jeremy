// Where a line drawn in omp's plan review comes from in the plan source, so a comment on it lands in
// the right section. omp's Markdown rendering drops markup (backticks, emphasis, link targets) but keeps
// every letter and digit, so lines are matched on their letters and digits alone.

/** Shortest start of a line still used to find it once its full text no longer matches (wrapped table cells, links). */
const MIN_PROBE = 8;
const WORD = /[\p{L}\p{N}]/u;

/** omp's callout rows under a commented line start with this bar. */
export const NOTE_BAR = "▎";

/** A comment for omp's native comment event: the quoted lines and their offset in omp's native document. */
export interface CommentTarget {
	quote: string;
	at: number;
}

interface Match {
	/** Index in the plan's letters. */
	at: number;
	length: number;
}

function lettersOf(text: string): string {
	let letters = "";
	for (const char of text) if (WORD.test(char)) letters += char;
	return letters;
}

/** A plan as omp's review shows it, for placing comments on its drawn lines. */
export class PlanSource {
	readonly #letters: string;
	/** The plan offset of each UTF-16 unit of `#letters`. */
	readonly #offsets: number[] = [];
	/** The title heading line omp's native document leaves out, when the plan has one. */
	readonly #title: { start: number; length: number } | null;

	constructor(text: string) {
		let letters = "";
		let offset = 0;
		for (const char of text) {
			if (WORD.test(char)) {
				letters += char;
				for (let unit = 0; unit < char.length; unit++) this.#offsets.push(offset + unit);
			}
			offset += char.length;
		}
		this.#letters = letters;
		this.#title = titleLine(text);
	}

	/**
	 * The comment for drawn rows `first..last` of `rows`, the plan body as omp draws it top to bottom (one entry per
	 * screen row); null when none of those rows is plan text (blank rows, borders, omp's notes).
	 */
	target(rows: readonly string[], first: number, last: number): CommentTarget | null {
		const quoted: number[] = [];
		for (let row = first; row <= last; row++) {
			const text = rows[row] ?? "";
			if (!text.startsWith(NOTE_BAR) && WORD.test(text)) quoted.push(row);
		}
		if (quoted.length === 0) return null;
		const offset = this.locate(rows, quoted[0] as number);
		if (offset === null) return null;
		return { quote: quoted.map((row) => rows[row]).join("\n"), at: this.#docOffset(offset) };
	}

	/**
	 * The plan offset where drawn row `target` starts. Short or repeated lines are placed relative to the nearest
	 * row whose text occurs once in the plan: omp draws the plan in order, so each row after it comes later in the source.
	 */
	locate(rows: readonly string[], target: number): number | null {
		const keys = rows.map((row) => (row.startsWith(NOTE_BAR) ? "" : lettersOf(row)));
		if (!keys[target]) return null;
		let pivot: { row: number; match: Match } | null = null;
		for (let distance = 0; distance < rows.length && !pivot; distance++) {
			for (const row of distance === 0 ? [target] : [target - distance, target + distance]) {
				const match = this.#unique(keys[row] ?? "");
				if (match) {
					pivot = { row, match };
					break;
				}
			}
		}
		if (!pivot) {
			const match = this.#find(keys[target] as string, 0, true);
			return match ? (this.#offsets[match.at] ?? null) : null;
		}
		let { match } = pivot;
		const step = target > pivot.row ? 1 : -1;
		for (let row = pivot.row; row !== target; ) {
			row += step;
			const key = keys[row];
			if (!key) continue;
			const next = step > 0 ? this.#find(key, match.at + match.length, true) : this.#find(key, match.at - 1, false);
			if (next) match = next;
		}
		return this.#offsets[match.at] ?? null;
	}

	/** The longest start of `key` found after (or, backward, at or before) `bound` in the plan's letters. */
	#find(key: string, bound: number, forward: boolean): Match | null {
		if (bound < 0) return null;
		for (let length = key.length; length > 0 && length >= Math.min(key.length, MIN_PROBE); length--) {
			const part = key.slice(0, length);
			const at = forward ? this.#letters.indexOf(part, bound) : this.#letters.lastIndexOf(part, bound);
			if (at >= 0) return { at, length };
		}
		return null;
	}

	/** Where `key` occurs, when it occurs exactly once in the plan. */
	#unique(key: string): Match | null {
		if (!key) return null;
		const match = this.#find(key, 0, true);
		if (!match) return null;
		return this.#letters.indexOf(key.slice(0, match.length), match.at + 1) < 0 ? match : null;
	}

	/** A plan offset in omp's native document, which leaves the title line out (omp's `#docOffset`). */
	#docOffset(offset: number): number {
		const title = this.#title;
		if (!title || offset < title.start) return offset;
		return offset < title.start + title.length ? title.start : offset - title.length;
	}
}

/**
 * The plan's title line as omp's review sees it: the only heading at the shallowest level, when it is the first heading.
 * Headings inside fenced code don't count.
 */
function titleLine(text: string): { start: number; length: number } | null {
	const headings: { start: number; level: number; length: number }[] = [];
	let fence: string | null = null;
	let start = 0;
	for (const line of text.split("\n")) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null;
		} else if (marker) {
			fence = marker;
		} else {
			const level = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line)?.[1]?.length;
			if (level) headings.push({ start, level, length: Math.min(line.length + 1, text.length - start) });
		}
		start += line.length + 1;
	}
	const first = headings[0];
	if (!first) return null;
	const top = Math.min(...headings.map((heading) => heading.level));
	const shallowest = headings.filter((heading) => heading.level === top);
	return shallowest.length === 1 && shallowest[0] === first ? { start: first.start, length: first.length } : null;
}
