import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { assertValidSessionId } from "./session-id.ts";

const SESSION_LOCK_STALE_MS = 30_000;
const SESSION_LOCK_UPDATE_MS = 10_000;

export class SessionWriteLockError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Session is already open for writing: ${sessionId}`);
		this.name = "SessionWriteLockError";
		this.sessionId = sessionId;
	}
}

export interface SessionWriteLock {
	readonly sessionId: string;
	readonly sessionDir: string;
	release(): Promise<void>;
}

export class SessionWriteLockOwner {
	#lock: SessionWriteLock | undefined;

	private constructor(lock: SessionWriteLock | undefined) {
		this.#lock = lock;
	}

	static async create(sessionDir: string | undefined, sessionId: string): Promise<SessionWriteLockOwner> {
		return new SessionWriteLockOwner(
			sessionDir === undefined ? undefined : await acquireSessionWriteLock(sessionDir, sessionId),
		);
	}

	async replace(sessionDir: string | undefined, sessionId: string): Promise<void> {
		if (this.#lock?.sessionId === sessionId && this.#lock.sessionDir === sessionDir) return;
		const next = sessionDir === undefined ? undefined : await acquireSessionWriteLock(sessionDir, sessionId);
		const previous = this.#lock;
		this.#lock = next;
		await previous?.release();
	}

	async release(): Promise<void> {
		const current = this.#lock;
		this.#lock = undefined;
		await current?.release();
	}
}

export async function acquireSessionWriteLock(sessionDir: string, sessionId: string): Promise<SessionWriteLock> {
	assertValidSessionId(sessionId);
	if (!sessionDir) throw new TypeError("Persisted session directory must not be empty");
	const lockDirectory = join(sessionDir, ".locks");
	await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
	const target = join(lockDirectory, sessionId);
	await mkdir(target, { recursive: true, mode: 0o700 });
	let unlock: () => Promise<void>;
	try {
		unlock = await lockfile.lock(target, {
			realpath: true,
			retries: 0,
			stale: SESSION_LOCK_STALE_MS,
			update: SESSION_LOCK_UPDATE_MS,
		});
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
			throw new SessionWriteLockError(sessionId);
		}
		throw error;
	}
	let released = false;
	return {
		sessionId,
		sessionDir,
		async release(): Promise<void> {
			if (released) return;
			released = true;
			await unlock();
		},
	};
}
