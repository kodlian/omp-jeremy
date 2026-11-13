import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PlanReviewHooks, type PlanReviewRequest, type PlanReviewServer, type PlanReviewView, startPlanReviewServer } from "../src/server";

let server: PlanReviewServer;
let base: string;
let accept = true;
const answers: [string, string, { feedback?: string; role?: string }][] = [];

const hooks: PlanReviewHooks = {
	resolve: (reviewId, choice, options) => {
		answers.push([reviewId, choice, options]);
		return accept;
	},
	sessionName: () => "omp",
};

const request = (reviewId: string, planContent = "# Plan\n\n- step"): PlanReviewRequest => ({
	reviewId,
	title: "Plan",
	planFilePath: "/repo/PLAN.md",
	planContent,
	options: [
		{ id: "execute", label: "Approve and execute", disabled: false },
		{ id: "refine", label: "Refine plan", disabled: false },
	],
});

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "plan-review-"));
	server = startPlanReviewServer(hooks, { ports: [], stateDir: dir });
	base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
	server.stop();
	await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
	accept = true;
	answers.length = 0;
});

const answer = (body: unknown, token = server.token) =>
	fetch(`${base}/api/resolve?token=${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** The next review the server publishes to the page after `action`. */
async function nextReview(action: () => void): Promise<PlanReviewView | null> {
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${server.token}`);
	const { promise, resolve } = Promise.withResolvers<PlanReviewView | null>();
	ws.onmessage = (e) => {
		const msg = JSON.parse(String(e.data));
		if (msg.type === "hello") action();
		else if (msg.type === "review") resolve(msg.review);
	};
	try {
		return await promise;
	} finally {
		ws.close();
	}
}

test("the page and its API need the token", async () => {
	expect((await answer({ reviewId: "r", choice: "execute" }, "nope")).status).toBe(403);
	expect((await fetch(`${base}/appearance.css`)).status).toBe(403);
	const page = await (await fetch(`${base}/?token=${server.token}`)).text();
	expect(page).toContain(`/appearance.css?token=${server.token}`);
});

test("an answer from the page reaches omp and marks the review answered here", async () => {
	server.present(request("r1"));
	const review = await nextReview(() => void answer({ reviewId: "r1", choice: "refine", feedback: "Split step 2" }));
	expect(answers).toEqual([["r1", "refine", { feedback: "Split step 2", role: undefined }]]);
	expect(review?.resolution).toEqual({ choice: "refine", by: "page" });
	// omp's own resolved event for the same answer doesn't relabel it.
	server.resolved("r1", "refine", "extension");
	expect((await answer({ reviewId: "r1", choice: "execute" })).status).toBe(409);
});

test("a revised plan after a refine carries the previous one; an answered review takes no more answers", async () => {
	server.present(request("r2", "# Plan\n\n- first"));
	server.resolved("r2", "refine", "local");
	const review = await nextReview(() => server.present(request("r3", "# Plan\n\n- second")));
	expect(review?.previous).toBe("# Plan\n\n- first");
	expect(review?.resolution).toBeNull();
	server.resolved("r3", "execute", "local");
	expect((await answer({ reviewId: "r3", choice: "execute" })).status).toBe(409);
	expect(answers).toEqual([]);
});

test("a plan approved before isn't a previous revision", async () => {
	server.present(request("r4", "# Old"));
	server.resolved("r4", "execute", "local");
	const review = await nextReview(() => server.present(request("r5", "# New")));
	expect(review?.previous).toBeNull();
});

test("answers omp refuses or that don't match the pending review are rejected", async () => {
	server.present(request("r6"));
	accept = false;
	expect((await answer({ reviewId: "r6", choice: "execute" })).status).toBe(422);
	expect((await answer({ reviewId: "other", choice: "execute" })).status).toBe(409);
	expect((await answer({ reviewId: "r6" })).status).toBe(400);
	expect(answers).toEqual([["r6", "execute", { feedback: undefined, role: undefined }]]);
});

test("the agent's working state reaches the page, on connect and on change", async () => {
	server.setWorking(true);
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${server.token}`);
	const messages: { type: string; working?: boolean }[] = [];
	const { promise, resolve } = Promise.withResolvers<void>();
	ws.onmessage = (e) => {
		const msg = JSON.parse(String(e.data));
		messages.push(msg);
		if (msg.type === "hello") server.setWorking(false);
		else if (msg.type === "working") resolve();
	};
	await promise;
	ws.close();
	expect(messages.map((m) => [m.type, m.working])).toEqual([
		["hello", true],
		["working", false],
	]);
});

test("a restarted server keeps the token, so an open tab reconnects", () => {
	const again = startPlanReviewServer(hooks, { ports: [], stateDir: dir });
	again.stop();
	expect(again.token).toBe(server.token);
});
