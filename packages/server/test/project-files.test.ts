import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { listProjectFiles } from "../src/web/project-files.ts";

const directories = new Set<string>();

afterEach(async () => {
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

describe("project file listing", () => {
	test("lists cwd-relative entries without following symlinks", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-project-files-"));
		const outside = await mkdtemp(join(tmpdir(), "pi-project-outside-"));
		directories.add(root);
		directories.add(outside);
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src", "main.ts"), "export {};");
		await symlink(outside, join(root, "escape"));
		expect(await listProjectFiles(root, "")).toEqual([{ path: "src", name: "src", type: "directory" }]);
		expect(await listProjectFiles(root, "src")).toEqual([
			{ path: "src/main.ts", name: "main.ts", type: "file", size: 10 },
		]);
	});

	test("rejects traversal and absolute paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-project-files-"));
		directories.add(root);
		await expect(listProjectFiles(root, "../outside")).rejects.toThrow(/outside/);
		await expect(listProjectFiles(root, "/tmp")).rejects.toThrow(/relative/);
	});
});
