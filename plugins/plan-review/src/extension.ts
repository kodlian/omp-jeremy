import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isNativeRendering } from "@oh-my-pi/pi-tui";
import { errorText } from "omp-integrations/text";
import { findReview, ReviewLayer } from "./layer";

/** The layer covers the screen exactly as omp's plan review does. */
const FULLSCREEN = { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true } as const;

export default function planReview(pi: ExtensionAPI) {
	let open: { reviewId: string; close: () => void } | null = null;

	const close = () => {
		const current = open;
		open = null;
		current?.close();
	};

	pi.on("plan_review_requested", (event, ctx) => {
		// Under Tern, omp's own review already takes comments on any selection.
		if (ctx.agent?.kind === "sub" || isNativeRendering()) return;
		close();
		// The review's handlers must return quickly; the layer opens right after.
		void ctx.ui
			.custom<void>(
				(tui, _theme, _keybindings, done) => {
					const review = findReview(tui);
					// An omp without the review internals the layer drives keeps its review as it is.
					if (!review) {
						done();
						return { render: () => [] };
					}
					const layer = { reviewId: event.reviewId, close: () => done() };
					open = layer;
					return new ReviewLayer(tui, review, event.planContent, () => {
						if (open === layer) open = null;
						done();
					});
				},
				{ overlay: true, overlayOptions: FULLSCREEN },
			)
			.catch((error) => ctx.ui.notify(`Plan review: ${errorText(error)}`, "warning"));
	});

	// However the review ends (answered, dismissed, replaced, plan mode left), the layer goes with it.
	pi.on("plan_review_resolved", (event, ctx) => {
		if (ctx.agent?.kind !== "sub" && open?.reviewId === event.reviewId) close();
	});

	pi.on("session_switch", (_event, ctx) => {
		if (ctx.agent?.kind !== "sub") close();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent?.kind !== "sub") close();
	});
}
