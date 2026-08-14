import { describe, expect, test } from "vitest";
import { shouldFollowOutput } from "./scroll.ts";

describe("transcript output following", () => {
	test("follows near the bottom but preserves deliberate history scrolling", () => {
		expect(shouldFollowOutput({ scrollHeight: 1000, scrollTop: 590, clientHeight: 360 })).toBe(true);
		expect(shouldFollowOutput({ scrollHeight: 1000, scrollTop: 300, clientHeight: 360 })).toBe(false);
	});
});
