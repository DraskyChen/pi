import { describe, expect, test } from "vitest";
import type { ByteTransportHandlers } from "../src/index.ts";
import { createWebSocketTransportFactory, type WebSocketLike } from "../src/websocket.ts";

class MemoryWebSocket implements WebSocketLike {
	readonly sent: ArrayBuffer[] = [];
	binaryType = "blob";
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	send(data: ArrayBuffer): void {
		if (this.readyState !== 1) throw new Error("not open");
		this.sent.push(data.slice(0));
	}

	close(): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.onclose?.();
	}

	receive(data: ArrayBuffer): void {
		this.onmessage?.({ data });
	}

	fail(): void {
		this.onerror?.();
	}
}

function handlers() {
	const received: number[][] = [];
	const errors: string[] = [];
	let closes = 0;
	const value: ByteTransportHandlers = {
		onData: (chunk) => received.push([...chunk]),
		onClose: () => {
			closes += 1;
		},
		onError: (error) => errors.push(error.message),
	};
	return {
		value,
		received,
		errors,
		get closes() {
			return closes;
		},
	};
}

describe("browser WebSocket transport", () => {
	test("delivers binary messages and copies outbound chunks", async () => {
		const socket = new MemoryWebSocket();
		const events = handlers();
		const connected = createWebSocketTransportFactory({
			url: "ws://127.0.0.1:3000/ws?token=secret",
			createSocket: () => socket,
		})(events.value);
		socket.open();
		const transport = await connected;

		const outbound = Uint8Array.of(1, 2, 3);
		await transport.send(outbound);
		outbound.fill(9);
		socket.receive(Uint8Array.of(4, 5).buffer);

		expect(socket.binaryType).toBe("arraybuffer");
		expect([...new Uint8Array(socket.sent[0]!)]).toEqual([1, 2, 3]);
		expect(events.received).toEqual([[4, 5]]);
		transport.close();
		expect(events.closes).toBe(0);
	});

	test("reports a remote close once and rejects later sends", async () => {
		const socket = new MemoryWebSocket();
		const events = handlers();
		const connected = createWebSocketTransportFactory({ url: "ws://localhost/ws", createSocket: () => socket })(
			events.value,
		);
		socket.open();
		const transport = await connected;

		socket.close();
		socket.close();

		expect(events.closes).toBe(1);
		await expect(transport.send(Uint8Array.of(1))).rejects.toThrow(/closed/);
	});

	test("rejects when the socket fails before opening", async () => {
		const socket = new MemoryWebSocket();
		const events = handlers();
		const connected = createWebSocketTransportFactory({ url: "ws://localhost/ws", createSocket: () => socket })(
			events.value,
		);
		socket.fail();
		await expect(connected).rejects.toThrow(/connect/);
		expect(events.errors).toEqual([]);
	});
});
