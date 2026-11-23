// Control's bus protocol: other plugins in the same omp read its sets and whether the session's change passed its controls.
export const CONTROL_ASK_EVENT = "control:ask";
export const CONTROL_SETS_EVENT = "control:sets"; // payload: ControlSetSummary[]

export type ControlApproval = "apply" | "ask";

export interface ControlSetSummary {
	id: string;
	name: string;
	description: string;
	/** The names of the set's controls. */
	controls: string[];
	approval: ControlApproval;
}

export interface ControlReply {
	ok: boolean;
	message: string;
	sets?: ControlSetSummary[];
	/** status: the working tree is exactly what the last control run reported as passed. */
	passed?: boolean;
	/** status: auto mode is on with approval "apply". */
	autonomous?: boolean;
}

export type ControlRequest = ({ type: "sets" } | { type: "status" }) & { reply(r: ControlReply): void };

export function isControlRequest(data: unknown): data is ControlRequest {
	if (!data || typeof data !== "object") return false;
	const r = data as Partial<Record<string, unknown>>;
	return typeof r.reply === "function" && (r.type === "sets" || r.type === "status");
}
