import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
	acquireSessionWriteLock,
	SessionWriteLockError,
	SessionWriteLockOwner,
} from "../src/core/session-write-lock.ts";

const directories = new Set<string>();

async function makeSessionDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-session-lock-"));
	directories.add(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

test("rejects a second writer for the same persisted session", async () => {
	const sessionDir = await makeSessionDir();
	const first = await acquireSessionWriteLock(sessionDir, "session-1");

	await expect(acquireSessionWriteLock(sessionDir, "session-1")).rejects.toBeInstanceOf(SessionWriteLockError);
	await first.release();
});

test("allows a released persisted session to be acquired again", async () => {
	const sessionDir = await makeSessionDir();
	const first = await acquireSessionWriteLock(sessionDir, "session-1");
	await first.release();

	const second = await acquireSessionWriteLock(sessionDir, "session-1");
	await expect(second.release()).resolves.toBeUndefined();
	await expect(second.release()).resolves.toBeUndefined();
});

test("allows different persisted sessions to have independent writers", async () => {
	const sessionDir = await makeSessionDir();
	const [first, second] = await Promise.all([
		acquireSessionWriteLock(sessionDir, "session-1"),
		acquireSessionWriteLock(sessionDir, "session-2"),
	]);

	await Promise.all([first.release(), second.release()]);
});

test("keeps the current lock when acquiring a replacement fails", async () => {
	const sessionDir = await makeSessionDir();
	const owner = await SessionWriteLockOwner.create(sessionDir, "session-1");
	const blocker = await acquireSessionWriteLock(sessionDir, "session-2");

	await expect(owner.replace(sessionDir, "session-2")).rejects.toBeInstanceOf(SessionWriteLockError);
	await expect(acquireSessionWriteLock(sessionDir, "session-1")).rejects.toBeInstanceOf(SessionWriteLockError);

	await blocker.release();
	await owner.release();
});

test("acquires the replacement before releasing the current lock", async () => {
	const sessionDir = await makeSessionDir();
	const owner = await SessionWriteLockOwner.create(sessionDir, "session-1");

	await owner.replace(sessionDir, "session-2");
	const oldSession = await acquireSessionWriteLock(sessionDir, "session-1");
	await expect(acquireSessionWriteLock(sessionDir, "session-2")).rejects.toBeInstanceOf(SessionWriteLockError);

	await oldSession.release();
	await owner.release();
});

test("does not lock in-memory sessions", async () => {
	const sessionDir = await makeSessionDir();
	const owner = await SessionWriteLockOwner.create(undefined, "session-1");
	const writer = await acquireSessionWriteLock(sessionDir, "session-1");

	await owner.replace(undefined, "session-2");
	await owner.release();
	await writer.release();
});

test("treats the same session id in different directories as different writers", async () => {
	const firstDir = await makeSessionDir();
	const secondDir = await makeSessionDir();
	const owner = await SessionWriteLockOwner.create(firstDir, "session-1");

	await owner.replace(secondDir, "session-1");
	const firstWriter = await acquireSessionWriteLock(firstDir, "session-1");
	await expect(acquireSessionWriteLock(secondDir, "session-1")).rejects.toBeInstanceOf(SessionWriteLockError);

	await firstWriter.release();
	await owner.release();
});
