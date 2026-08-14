import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { TestServerService } from "../src/testing/service.ts";
import { createLocalWebHost, type LocalWebHost } from "../src/web/index.ts";

const hosts = new Set<LocalWebHost>();
const directories = new Set<string>();

async function fixture(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-web-host-"));
	directories.add(directory);
	await mkdir(join(directory, "assets"));
	await writeFile(join(directory, "index.html"), '<main id="root"></main><script src="/assets/app.js"></script>');
	await writeFile(join(directory, "assets", "app.js"), "globalThis.piWebLoaded = true;");
	return directory;
}

afterEach(async () => {
	await Promise.all([...hosts].map((host) => host.close()));
	hosts.clear();
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

describe("local web host", () => {
	test("binds loopback, exchanges the launch token for an instance cookie, and protects assets", async () => {
		const host = await createLocalWebHost(new TestServerService(), {
			webRoot: await fixture(),
			cwd: "/workspace/pi",
			port: 0,
		});
		hosts.add(host);
		expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/);

		const unauthorized = await fetch(host.origin);
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get("cache-control")).toBe("no-store");

		const launched = await fetch(host.url, { redirect: "manual" });
		expect(launched.status).toBe(303);
		expect(launched.headers.get("location")).toBe("/");
		const cookie = launched.headers.get("set-cookie");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");

		const page = await fetch(host.origin, { headers: { cookie: cookie! } });
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("window.__PI_WEB_CONFIG__");
		expect(html).toContain('"cwd":"/workspace/pi"');
		expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");

		const asset = await fetch(`${host.origin}/assets/app.js`, { headers: { cookie: cookie! } });
		expect(asset.status).toBe(200);
		expect(await asset.text()).toContain("piWebLoaded");
		const files = await fetch(`${host.origin}/api/files`, { headers: { cookie: cookie! } });
		expect(files.status).toBe(404);
	});

	test("accepts protocol WebSockets only with the current token and Origin", async () => {
		const service = new TestServerService();
		const host = await createLocalWebHost(service, { webRoot: await fixture(), cwd: "/workspace/pi" });
		hosts.add(host);
		const socket = new WebSocket(`${host.websocketUrl}?token=${encodeURIComponent(host.token)}`, {
			origin: host.origin,
		});
		await once(socket, "open");
		socket.close();

		const rejected = new WebSocket(`${host.websocketUrl}?token=wrong`, { origin: host.origin });
		const [error] = await once(rejected, "error");
		expect(String(error)).toContain("401");
	});

	test("rejects HTTP requests with a foreign Host or Origin", async () => {
		const host = await createLocalWebHost(new TestServerService(), {
			webRoot: await fixture(),
			cwd: "/workspace/pi",
		});
		hosts.add(host);

		const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
			const target = new URL(host.url);
			const httpRequest = request(
				{
					hostname: target.hostname,
					port: target.port,
					path: `${target.pathname}${target.search}`,
					headers: { host: "evil.example" },
				},
				(response) => {
					response.resume();
					resolve(response.statusCode);
				},
			);
			httpRequest.on("error", reject);
			httpRequest.end();
		});
		expect(foreignHostStatus).toBe(403);

		const foreignOrigin = await fetch(host.url, {
			headers: { origin: "https://evil.example" },
			redirect: "manual",
		});
		expect(foreignOrigin.status).toBe(403);
	});

	test("rejects invalid ports and missing web roots", async () => {
		const service = new TestServerService();
		await expect(createLocalWebHost(service, { webRoot: "/missing/pi-web", cwd: "/workspace" })).rejects.toThrow(
			/Web root/,
		);
		await expect(
			createLocalWebHost(service, { webRoot: await fixture(), cwd: "/workspace", port: 70_000 }),
		).rejects.toThrow(/port/);
	});
});
