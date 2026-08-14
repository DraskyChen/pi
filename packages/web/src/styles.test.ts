import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("chat scrolling layout", () => {
	test("allows the transcript grid row to shrink and scroll inside the viewport", async () => {
		const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
		expect(css).toMatch(/\.chat\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
		expect(css).toMatch(/\.transcript\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
	});
});
