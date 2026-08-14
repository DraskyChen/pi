import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectFile } from "@earendil-works/pi-protocol";

export async function listProjectFiles(cwd: string, requestedPath: string): Promise<ProjectFile[]> {
	if (isAbsolute(requestedPath)) throw new TypeError("Project file path must be relative");
	const root = await realpath(cwd);
	const target = resolve(root, requestedPath);
	if (target !== root && !target.startsWith(`${root}${sep}`)) throw new TypeError("Project file path is outside cwd");
	const targetRealPath = await realpath(target);
	if (targetRealPath !== root && !targetRealPath.startsWith(`${root}${sep}`)) {
		throw new TypeError("Project file path resolves outside cwd");
	}
	const entries = await readdir(targetRealPath, { withFileTypes: true });
	const files: ProjectFile[] = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
		const path = relative(root, resolve(targetRealPath, entry.name)).split(sep).join("/");
		if (entry.isDirectory()) files.push({ path, name: entry.name, type: "directory" });
		else
			files.push({
				path,
				name: entry.name,
				type: "file",
				size: (await stat(resolve(targetRealPath, entry.name))).size,
			});
	}
	return files.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
}
