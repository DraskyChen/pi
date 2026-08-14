import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { PiServer } from "../server.ts";
import { createWebSocketListener } from "../transports/websocket/listener.ts";
import type { PiServerService } from "../types.ts";
import { listProjectFiles } from "./project-files.ts";
import type { LocalWebHost, LocalWebHostOptions } from "./types.ts";

const HOST = "127.0.0.1";
const WEBSOCKET_PATH = "/api/ws";
const COOKIE_NAME = "pi_web_instance";
const CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webp": "image/webp",
};

export async function createLocalWebHost(
	service: PiServerService,
	options: LocalWebHostOptions,
): Promise<LocalWebHost> {
	const webRoot = resolve(options.webRoot);
	if (!existsSync(webRoot) || !statSync(webRoot).isDirectory()) throw new Error(`Web root does not exist: ${webRoot}`);
	const port = options.port ?? 0;
	if (!Number.isInteger(port) || port < 0 || port > 65_535)
		throw new TypeError("Web port must be between 0 and 65535");
	const token = options.token ?? randomBytes(32).toString("base64url");
	if (!token) throw new TypeError("Web token must not be empty");
	const cookieValue = randomBytes(32).toString("base64url");
	let origin = "http://127.0.0.1";
	const httpServer = createServer((request, response) => {
		void handleHttpRequest(request, response, { webRoot, cwd: options.cwd, token, cookieValue, origin }).catch(
			(error: unknown) => {
				const reportedError = error instanceof Error ? error : new Error(String(error));
				options.onError?.(reportedError);
				if (!response.headersSent) respond(response, 500, "Internal Server Error");
				else response.destroy(reportedError);
			},
		);
	});
	httpServer.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
	httpServer.listen(port, HOST);
	await once(httpServer, "listening");
	const address = httpServer.address();
	if (!address || typeof address === "string") throw new Error("Pi Web failed to bind a TCP port");
	origin = `http://${HOST}:${address.port}`;
	const listener = createWebSocketListener({
		server: httpServer,
		path: WEBSOCKET_PATH,
		token,
		origin,
		onError: options.onError,
	});
	const piServer = new PiServer(service, { listeners: [listener], onError: options.onError });
	try {
		await piServer.start();
	} catch (error) {
		httpServer.close();
		throw error;
	}
	let closePromise: Promise<void> | undefined;
	return {
		origin,
		url: `${origin}/?token=${encodeURIComponent(token)}`,
		websocketUrl: `ws://${HOST}:${address.port}${WEBSOCKET_PATH}`,
		token,
		close: () => {
			closePromise ??= closeHost(piServer, httpServer);
			return closePromise;
		},
	};
}

interface HttpContext {
	webRoot: string;
	cwd: string;
	token: string;
	cookieValue: string;
	origin: string;
}

async function handleHttpRequest(
	request: IncomingMessage,
	response: ServerResponse,
	context: HttpContext,
): Promise<void> {
	setSecurityHeaders(response);
	const expectedHost = new URL(context.origin).host;
	if (request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== context.origin)) {
		respond(response, 403, "Forbidden");
		return;
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		respond(response, 405, "Method Not Allowed");
		return;
	}
	const url = new URL(request.url ?? "/", context.origin);
	if (tokensEqual(url.searchParams.get("token"), context.token)) {
		response.writeHead(303, {
			Location: url.pathname,
			"Set-Cookie": `${COOKIE_NAME}=${context.cookieValue}; Path=/; HttpOnly; SameSite=Strict`,
		});
		response.end();
		return;
	}
	if (!tokensEqual(readCookie(request, COOKIE_NAME), context.cookieValue)) {
		respond(response, 401, "Unauthorized");
		return;
	}
	if (url.pathname === "/api/files") {
		try {
			const files = await listProjectFiles(context.cwd, url.searchParams.get("path") ?? "");
			response.writeHead(200, { "Content-Type": CONTENT_TYPES[".json"] });
			response.end(JSON.stringify({ files }));
		} catch (error) {
			respond(
				response,
				error instanceof TypeError ? 400 : 404,
				error instanceof Error ? error.message : "Not Found",
			);
		}
		return;
	}
	const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
	const resolved = resolve(context.webRoot, normalize(relative));
	if (resolved !== context.webRoot && !resolved.startsWith(`${context.webRoot}${sep}`)) {
		respond(response, 404, "Not Found");
		return;
	}
	if (!existsSync(resolved) || !statSync(resolved).isFile()) {
		respond(response, 404, "Not Found");
		return;
	}
	if (resolved === join(context.webRoot, "index.html")) {
		const configuration = JSON.stringify({ token: context.token, websocketPath: WEBSOCKET_PATH, cwd: context.cwd });
		const html = await readFile(resolved, "utf8");
		const bootstrap = `<script>window.__PI_WEB_CONFIG__=${configuration}</script>`;
		const configuredHtml = html.includes("</head>")
			? html.replace("</head>", `${bootstrap}</head>`)
			: `${bootstrap}${html}`;
		response.writeHead(200, { "Content-Type": CONTENT_TYPES[".html"] });
		response.end(configuredHtml);
		return;
	}
	response.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(resolved)] ?? "application/octet-stream" });
	if (request.method === "HEAD") response.end();
	else createReadStream(resolved).pipe(response);
}

function setSecurityHeaders(response: ServerResponse): void {
	response.setHeader("Cache-Control", "no-store");
	response.setHeader(
		"Content-Security-Policy",
		"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
	);
	response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
}

function readCookie(request: IncomingMessage, name: string): string | null {
	for (const part of (request.headers.cookie ?? "").split(";")) {
		const separator = part.indexOf("=");
		if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
	}
	return null;
}

function tokensEqual(candidate: string | null, expected: string): boolean {
	if (candidate === null) return false;
	const candidateBytes = Buffer.from(candidate);
	const expectedBytes = Buffer.from(expected);
	return candidateBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(candidateBytes, expectedBytes);
}

function respond(response: ServerResponse, status: number, body: string): void {
	response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
	response.end(body);
}

async function closeHost(piServer: PiServer, httpServer: ReturnType<typeof createServer>): Promise<void> {
	await piServer.close();
	if (!httpServer.listening) return;
	httpServer.closeAllConnections();
	await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
}
