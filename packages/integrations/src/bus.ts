/** Asks another plugin in this omp over the shared bus; without an answer in time the reply is `unavailable`. */
export function busAsk<R extends { ok: boolean; message: string }>(events: { emit(event: string, data: unknown): void }, event: string, request: object, timeoutMs: number, unavailable: string): Promise<R> {
	const { promise, resolve } = Promise.withResolvers<R>();
	const timer = setTimeout(() => resolve({ ok: false, message: unavailable } as R), timeoutMs);
	events.emit(event, {
		...request,
		reply: (r: R) => {
			clearTimeout(timer);
			resolve(r);
		},
	});
	return promise;
}
