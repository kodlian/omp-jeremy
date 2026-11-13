// git-diff-review's bus protocol: other plugins in the same omp open its review page on a change.
export const REVIEW_EVENT = "git-diff-review:open";

export interface ReviewReply {
	ok: boolean;
	message: string;
}

/** probe: answered at once when git-diff-review is loaded; open: shows the session repo's changes since `base`, a commit, in a new tab. */
export type ReviewRequest = { type: "probe"; reply(r: ReviewReply): void } | { type: "open"; base: string; reply(r: ReviewReply): void };

export function isReviewRequest(data: unknown): data is ReviewRequest {
	if (!data || typeof data !== "object") return false;
	const r = data as Partial<Record<string, unknown>>;
	return typeof r.reply === "function" && (r.type === "probe" || (r.type === "open" && typeof r.base === "string"));
}
