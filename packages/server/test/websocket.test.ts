import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import type { ByteConnectionAcceptor } from "../src/connection.ts";
import { createWebSocketListener } from "../src/transports/websocket/index.ts";

const servers = new Set<Server>();

async function listen(server: Server): Promise<number> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP address");
	return address.port;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return;
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function connect(url: string, origin: string): Promise<WebSocket> {
	return new Promise<WebSocket>((resolve, reject) => {
		const socket = new WebSocket(url, { origin });
		socket.once("open", () => resolve(socket));
		socket.once("error", reject);
	});
}

afterEach(async () => {
	await Promise.all([...servers].map(closeServer));
	servers.clear();
});

describe("authenticated WebSocket listener", () => {
	test("accepts only the configured token, path, and Origin", async () => {
		const server = createServer();
		servers.add(server);
		const listener = createWebSocketListener({
			server,
			path: "/api/ws",
			token: "secret-token",
			origin: "http://127.0.0.1:4173",
		});
		let accepted = 0;
		const accept: ByteConnectionAcceptor = () => {
			accepted += 1;
			return { onData: () => {}, onClose: () => {}, onError: () => {} };
		};
		await listener.start(accept);
		const port = await listen(server);

		const valid = await connect(`ws://127.0.0.1:${port}/api/ws?token=secret-token`, "http://127.0.0.1:4173");
		expect(accepted).toBe(1);
		valid.close();

		await expect(connect(`ws://127.0.0.1:${port}/api/ws?token=wrong`, "http://127.0.0.1:4173")).rejects.toThrow(
			/401/,
		);
		await expect(connect(`ws://127.0.0.1:${port}/wrong?token=secret-token`, "http://127.0.0.1:4173")).rejects.toThrow(
			/404/,
		);
		await expect(connect(`ws://127.0.0.1:${port}/api/ws?token=secret-token`, "http://evil.invalid")).rejects.toThrow(
			/403/,
		);
		expect(accepted).toBe(1);
		await listener.close();
	});

	test("exchanges ordered binary chunks and suppresses local-close callbacks", async () => {
		const server = createServer();
		servers.add(server);
		const listener = createWebSocketListener({
			server,
			path: "/ws",
			token: "token",
			origin: "http://127.0.0.1:3000",
		});
		let inbound: number[] = [];
		let closeCount = 0;
		await listener.start((connection) => ({
			onData: (chunk) => {
				inbound = [...inbound, ...chunk];
				void connection.send(Uint8Array.of(9, 8));
			},
			onClose: () => {
				closeCount += 1;
			},
			onError: () => {},
		}));
		const port = await listen(server);
		const socket = await connect(`ws://127.0.0.1:${port}/ws?token=token`, "http://127.0.0.1:3000");
		const response = once(socket, "message");
		socket.send(Uint8Array.of(1, 2, 3));
		const [data] = await response;
		expect(inbound).toEqual([1, 2, 3]);
		expect([...new Uint8Array(data as ArrayBuffer)]).toEqual([9, 8]);

		const closed = once(socket, "close");
		await listener.close();
		await closed;
		expect(closeCount).toBe(0);
	});
});
