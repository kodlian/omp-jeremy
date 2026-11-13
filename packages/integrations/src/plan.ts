/** omp's plan review choices that approve the plan. */
export const PLAN_APPROVALS: Record<string, true> = { execute: true, compact: true, keep: true };
/** The first approving choice omp offers, as Enter would pick. */
export function approvalChoice<O extends { id: string; disabled?: boolean }>(options: O[]): O | undefined {
	return options.find((o) => !o.disabled && PLAN_APPROVALS[o.id]);
}
