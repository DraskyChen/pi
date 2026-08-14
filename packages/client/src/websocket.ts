import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";

export interface WebSocketLike {
	binaryType: string;
	readonly readyState: number;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: (() => void) | null;
	onerror: (() => void) | null;
	send(data: ArrayBuffer): void;
	close(): void;
}

export interface WebSocketTransportOptions {
	url: string;
	createSocket?: (url: string) => WebSocketLike;
}

interface WebSocketConstructor {
	new (url: string): WebSocketLike;
}

function createBrowserSocket(url: string): WebSocketLike {
	const webSocketConstructor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
	if (!webSocketConstructor) throw new Error("WebSocket is not available in this runtime");
	return new webSocketConstructor(url);
}

/** Creates browser-compatible WebSocket transports for PiClient connection attempts. */
export function createWebSocketTransportFactory(options: WebSocketTransportOptions): ByteTransportFactory {
	if (!URL.canParse(options.url)) throw new TypeError("WebSocket transport URL is invalid");
	const protocol = new URL(options.url).protocol;
	if (protocol !== "ws:" && protocol !== "wss:") throw new TypeError("WebSocket transport URL must use ws or wss");
	return (handlers) => connectWebSocket(options.url, options.createSocket ?? createBrowserSocket, handlers);
}

function connectWebSocket(
	url: string,
	createSocket: (url: string) => WebSocketLike,
	handlers: ByteTransportHandlers,
): Promise<ByteTransport> {
	return new Promise<ByteTransport>((resolve, reject) => {
		let socket: WebSocketLike;
		try {
			socket = createSocket(url);
		} catch (error) {
			reject(error);
			return;
		}
		let connected = false;
		let terminal = false;
		socket.binaryType = "arraybuffer";
		socket.onopen = () => {
			if (terminal) return;
			connected = true;
			resolve(
				new WebSocketByteTransport(socket, () => {
					terminal = true;
				}),
			);
		};
		socket.onmessage = (event) => {
			if (terminal) return;
			if (!(event.data instanceof ArrayBuffer)) {
				terminal = true;
				socket.close();
				handlers.onError(new Error("WebSocket transport received a non-binary message"));
				return;
			}
			handlers.onData(new Uint8Array(event.data));
		};
		socket.onclose = () => {
			if (terminal) return;
			terminal = true;
			if (connected) handlers.onClose();
			else reject(new Error("WebSocket transport closed before connecting"));
		};
		socket.onerror = () => {
			if (terminal) return;
			terminal = true;
			socket.close();
			const error = new Error(connected ? "WebSocket transport failed" : "WebSocket transport failed to connect");
			if (connected) handlers.onError(error);
			else reject(error);
		};
	});
}

class WebSocketByteTransport implements ByteTransport {
	readonly #socket: WebSocketLike;
	readonly #markLocalClose: () => void;
	#closed = false;
	#sendTail: Promise<void> = Promise.resolve();

	constructor(socket: WebSocketLike, markLocalClose: () => void) {
		this.#socket = socket;
		this.#markLocalClose = markLocalClose;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) return Promise.reject(new TypeError("WebSocket chunks must be Uint8Array"));
		if (this.#closed || this.#socket.readyState !== 1)
			return Promise.reject(new Error("WebSocket transport is closed"));
		const bytes = chunk.slice();
		const pending = this.#sendTail.then(() => {
			if (this.#closed || this.#socket.readyState !== 1) throw new Error("WebSocket transport is closed");
			this.#socket.send(bytes.buffer);
		});
		this.#sendTail = pending.catch(() => {});
		return pending;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#markLocalClose();
		this.#socket.close();
	}
}
