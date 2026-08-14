import type { PiServerService } from "../types.ts";

export interface LocalWebHostOptions {
	webRoot: string;
	cwd: string;
	port?: number;
	token?: string;
	onError?: (error: Error) => void;
}

export interface LocalWebHost {
	readonly origin: string;
	readonly url: string;
	readonly websocketUrl: string;
	readonly token: string;
	close(): Promise<void>;
}

export type CreateLocalWebHost = (service: PiServerService, options: LocalWebHostOptions) => Promise<LocalWebHost>;
