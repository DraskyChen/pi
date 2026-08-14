import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { applySessionProgress } from "./session-progress.ts";

const snapshot: SessionSnapshot = {
	id: "session-1",
	cwd: "/workspace",
	createdAt: 1,
	updatedAt: 1,
	phase: "turn",
	model: { provider: "test", id: "model-1" },
	thinkingLevel: "off",
	attached: true,
	locked: true,
	revision: 1,
	transcript: [],
	queuedSteer: [],
	queuedSteerCount: 0,
};

describe("Web session progress projection", () => {
	test("renders an updated assistant item before the next snapshot", () => {
		const next = applySessionProgress(snapshot, {
			type: "item_updated",
			item: {
				id: "assistant-1",
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				status: "streaming",
				model: { provider: "test", id: "model-1" },
				timestamp: 2,
			},
		});

		expect(next.transcript).toMatchObject([
			{ id: "assistant-1", status: "streaming", content: [{ type: "text", text: "partial" }] },
		]);
		expect(snapshot.transcript).toEqual([]);
	});
});
