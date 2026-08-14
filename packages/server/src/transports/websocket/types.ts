import type { Server } from "node:http";

export interface WebSocketListenerOptions {
	server: Server;
	path: string;
	token: string;
	origin: string;
	maxPendingBytes?: number;
	onError?: (error: Error) => void;
}
