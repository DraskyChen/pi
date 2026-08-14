import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { CodingAgentService } from "../src/web/coding-agent-service.ts";

describe("CodingAgentService transcript progress", () => {
	test("emits an assistant item update while a message is streaming", async () => {
		let emit: ((event: AgentSessionEvent) => void) | undefined;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "hel" }],
			api: "openai-responses",
			provider: "test",
			model: "model-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: 10,
		};
		const initialRuntime = {
			cwd: "/workspace",
			session: {
				sessionId: "session-1",
				subscribe(listener: (event: AgentSessionEvent) => void) {
					emit = listener;
					return () => {};
				},
				// Agent keeps the active assistant response outside finalized messages.
				messages: [],
			},
			services: { modelRuntime: undefined },
			dispose: async () => {},
		} as unknown as AgentSessionRuntime;
		const service = new CodingAgentService({
			defaultCwd: "/workspace",
			agentDir: "/agent",
			createRuntime: async () => {
				throw new Error("Unexpected runtime creation");
			},
			initialRuntime,
		});
		const runtime = await service.openSession("session-1");
		const events: unknown[] = [];
		runtime.subscribe((event) => events.push(event));

		emit?.({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "l", partial: message },
		});
		const continuedMessage: AssistantMessage = {
			...message,
			content: [{ type: "text", text: "hello" }],
		};
		emit?.({
			type: "message_update",
			message: continuedMessage,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "lo",
				partial: continuedMessage,
			},
		});

		expect(events).toEqual([
			{
				type: "progress",
				progress: {
					type: "item_updated",
					item: expect.objectContaining({
						id: "assistant-10-0",
						role: "assistant",
						status: "streaming",
					}),
				},
			},
			{
				type: "progress",
				progress: {
					type: "item_updated",
					item: expect.objectContaining({
						id: "assistant-10-0",
						content: [{ type: "text", text: "hello" }],
						status: "streaming",
					}),
				},
			},
		]);
	});
});
