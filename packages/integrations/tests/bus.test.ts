import { expect, test } from "bun:test";
import { busAsk } from "../src/bus";
import { approvalChoice } from "../src/plan";

type Reply = { ok: boolean; message: string };

function fakeEvents() {
	const handlers = new Map<string, (data: unknown) => void>();
	return {
		on: (event: string, handler: (data: unknown) => void) => handlers.set(event, handler),
		emit: (event: string, data: unknown) => handlers.get(event)?.(data),
	};
}

test("an ask resolves to the answering plugin's reply", async () => {
	const events = fakeEvents();
	events.on("ask", (data) => (data as { reply(r: Reply): void; n: number }).reply({ ok: true, message: `got ${(data as { n: number }).n}` }));
	expect(await busAsk<Reply>(events, "ask", { n: 7 }, 1000, "gone")).toEqual({ ok: true, message: "got 7" });
});

test("without an answer in time the reply says the plugin is unavailable", async () => {
	expect(await busAsk<Reply>(fakeEvents(), "ask", {}, 20, "gone")).toEqual({ ok: false, message: "gone" });
});

test("the approval picked is omp's first enabled approving choice", () => {
	expect(approvalChoice([{ id: "refine" }, { id: "execute", disabled: true }, { id: "keep" }])).toEqual({ id: "keep" });
});
