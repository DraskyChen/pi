import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { ByteConnection, ByteConnectionAcceptor } from "../../connection.ts";
import type { PiServerListener } from "../../listener.ts";
import type { WebSocketListenerOptions } from "./types.ts";

const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 * 1024;

export function createWebSocketListener(options: WebSocketListenerOptions): PiServerListener {
	return new WebSocketListener(options);
}

class WebSocketListener implements PiServerListener {
	readonly #options: WebSocketListenerOptions;
	readonly #webSocketServer = new WebSocketServer({ noServer: true });
	readonly #connections = new Set<WebSocketByteConnection>();
	#accept?: ByteConnectionAcceptor;
	#started = false;
	#closing = false;

	constructor(options: WebSocketListenerOptions) {
		if (!options.path.startsWith("/") || options.path.includes("?") || options.path.includes("#")) {
			throw new TypeError("WebSocket listener path must be an absolute URL path");
		}
		if (!options.token) throw new TypeError("WebSocket listener token must not be empty");
		const origin = new URL(options.origin);
		if (origin.origin !== options.origin) throw new TypeError("WebSocket listener Origin must be an origin URL");
		this.#options = options;
	}

	async start(accept: ByteConnectionAcceptor): Promise<void> {
		if (this.#started) throw new Error("WebSocket listener is already started");
		if (this.#closing) throw new Error("WebSocket listener is closing or closed");
		this.#started = true;
		this.#accept = accept;
		this.#options.server.on("upgrade", this.#handleUpgrade);
		this.#webSocketServer.on("connection", this.#acceptSocket);
	}

	async close(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		this.#options.server.off("upgrade", this.#handleUpgrade);
		this.#webSocketServer.off("connection", this.#acceptSocket);
		await Promise.all([...this.#connections].map((connection) => connection.close()));
		this.#connections.clear();
		await new Promise<void>((resolve) => this.#webSocketServer.close(() => resolve()));
	}

	readonly #handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
		if (this.#closing) {
			rejectUpgrade(socket, 503, "Service Unavailable");
			return;
		}
		const requestUrl = new URL(request.url ?? "/", this.#options.origin);
		if (requestUrl.pathname !== this.#options.path) {
			rejectUpgrade(socket, 404, "Not Found");
			return;
		}
		if (request.headers.origin !== this.#options.origin) {
			rejectUpgrade(socket, 403, "Forbidden");
			return;
		}
		if (!tokensEqual(requestUrl.searchParams.get("token"), this.#options.token)) {
			rejectUpgrade(socket, 401, "Unauthorized");
			return;
		}
		this.#webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
			this.#webSocketServer.emit("connection", webSocket, request);
		});
	};

	readonly #acceptSocket = (socket: WebSocket): void => {
		const accept = this.#accept;
		if (!accept || this.#closing) {
			socket.close();
			return;
		}
		const connection = new WebSocketByteConnection(
			socket,
			this.#options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
		);
		this.#connections.add(connection);
		const handler = accept(connection);
		socket.on("message", (data, isBinary) => {
			if (!isBinary) {
				handler.onError(new Error("WebSocket connection received a non-binary message"));
				void connection.close();
				return;
			}
			const bytes =
				data instanceof ArrayBuffer
					? new Uint8Array(data)
					: Array.isArray(data)
						? Buffer.concat(data)
						: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
			handler.onData(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
		});
		socket.once("error", (error) => handler.onError(error));
		socket.once("close", () => {
			const locallyClosed = connection.locallyClosed;
			connection.markClosed();
			this.#connections.delete(connection);
			if (!locallyClosed) handler.onClose();
		});
	};
}

function tokensEqual(candidate: string | null, expected: string): boolean {
	if (candidate === null) return false;
	const candidateBytes = Buffer.from(candidate);
	const expectedBytes = Buffer.from(expected);
	return candidateBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(candidateBytes, expectedBytes);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
	socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

class WebSocketByteConnection implements ByteConnection {
	readonly #socket: WebSocket;
	readonly #maxPendingBytes: number;
	#closed = false;
	#localClose = false;
	#pendingBytes = 0;
	#sendTail: Promise<void> = Promise.resolve();

	constructor(socket: WebSocket, maxPendingBytes: number) {
		this.#socket = socket;
		this.#maxPendingBytes = maxPendingBytes;
	}

	get closed(): boolean {
		return this.#closed;
	}

	get locallyClosed(): boolean {
		return this.#localClose;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) return Promise.reject(new TypeError("WebSocket chunks must be Uint8Array"));
		if (this.#closed || this.#localClose) return Promise.reject(new Error("WebSocket connection is closed"));
		if (this.#pendingBytes + chunk.byteLength > this.#maxPendingBytes) {
			return Promise.reject(new Error("WebSocket connection exceeded its pending byte limit"));
		}
		const bytes = chunk.slice();
		this.#pendingBytes += bytes.byteLength;
		const pending = this.#sendTail.then(
			() =>
				new Promise<void>((resolve, reject) => {
					if (this.#socket.readyState !== WebSocket.OPEN) {
						reject(new Error("WebSocket connection is closed"));
						return;
					}
					this.#socket.send(bytes, { binary: true }, (error) => (error ? reject(error) : resolve()));
				}),
		);
		const tracked = pending.finally(() => {
			this.#pendingBytes -= bytes.byteLength;
		});
		this.#sendTail = tracked.catch(() => {});
		return tracked;
	}

	async close(finalChunk?: Uint8Array): Promise<void> {
		if (this.#closed || this.#localClose) return;
		this.#localClose = true;
		if (finalChunk) {
			const bytes = finalChunk.slice();
			await this.#sendTail;
			if (this.#socket.readyState === WebSocket.OPEN) {
				await new Promise<void>((resolve) => this.#socket.send(bytes, { binary: true }, () => resolve()));
			}
		}
		if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
			this.#socket.close();
		}
	}

	markClosed(): void {
		this.#closed = true;
	}
}
