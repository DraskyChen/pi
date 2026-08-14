import type { ImageContent, ToolCall } from "@earendil-works/pi-ai";
import type {
	JsonValue,
	ModelMetadata,
	ModelRef,
	SessionAction,
	SessionMetadata,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptItem,
	TranscriptProgress,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import {
	PiServerError,
	type PiServerService,
	type PiSessionRuntime,
	type PiSessionRuntimeEvent,
	type PromptInput,
	SessionLockedError,
	SessionNotFoundError,
	toProtocolAssistantMessage,
	toProtocolModelMetadata,
	toProtocolToolResultMessage,
	toProtocolUserMessage,
} from "@earendil-works/pi-server";
import type { AgentSession, AgentSessionEvent } from "../core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../core/agent-session-runtime.ts";
import { type SessionInfo, SessionManager } from "../core/session-manager.ts";
import { SessionWriteLockError } from "../core/session-write-lock.ts";

export interface CodingAgentServiceOptions {
	defaultCwd: string;
	agentDir: string;
	sessionDir?: string;
	createRuntime: CreateAgentSessionRuntimeFactory;
	initialRuntime?: AgentSessionRuntime;
}

export class CodingAgentService implements PiServerService {
	readonly #options: CodingAgentServiceOptions;
	readonly #modelRuntime: AgentSessionRuntime["services"]["modelRuntime"] | undefined;
	#initialRuntime: AgentSessionRuntime | undefined;

	constructor(options: CodingAgentServiceOptions) {
		this.#options = options;
		this.#initialRuntime = options.initialRuntime;
		this.#modelRuntime = options.initialRuntime?.services.modelRuntime;
	}

	async listSessions(): Promise<SessionMetadata[]> {
		const sessions = await this.#listStoredSessions();
		const metadata = sessions.map(toSessionMetadata);
		const initial = this.#initialRuntime;
		if (initial && !metadata.some((session) => session.id === initial.session.sessionId)) {
			const header = initial.session.sessionManager.getHeader();
			metadata.unshift({
				id: initial.session.sessionId,
				createdAt: Date.parse(header?.timestamp ?? new Date().toISOString()),
				sessionName: initial.session.sessionName,
				cwd: initial.cwd,
			});
		}
		return metadata;
	}

	async dispose(): Promise<void> {
		const initial = this.#initialRuntime;
		this.#initialRuntime = undefined;
		if (initial) await initial.dispose();
	}

	async listModels(): Promise<ModelMetadata[]> {
		const modelRuntime = this.#modelRuntime;
		if (!modelRuntime) return [];
		const available = new Set(modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`));
		return modelRuntime
			.getModels()
			.map((model) => toProtocolModelMetadata(model, available.has(`${model.provider}\0${model.id}`)));
	}

	async createSession(options: {
		id: string;
		cwd?: string;
		name?: string;
		model?: ModelRef;
		thinkingLevel?: ThinkingLevel;
	}): Promise<PiSessionRuntime> {
		const cwd = options.cwd ?? this.#options.defaultCwd;
		const sessionManager = SessionManager.create(cwd, this.#options.sessionDir, { id: options.id });
		if (options.name !== undefined) sessionManager.appendSessionInfo(options.name);
		return this.#createRuntime(sessionManager, options.model, options.thinkingLevel);
	}

	async openSession(sessionId: string): Promise<PiSessionRuntime> {
		const initialRuntime = this.#initialRuntime;
		if (initialRuntime?.session.sessionId === sessionId) {
			this.#initialRuntime = undefined;
			return new CodingAgentSessionRuntime(initialRuntime);
		}
		const info = (await this.#listStoredSessions()).find((session) => session.id === sessionId);
		if (!info) throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
		return this.#createRuntime(SessionManager.open(info.path, this.#options.sessionDir));
	}

	async #createRuntime(
		sessionManager: SessionManager,
		modelRef?: ModelRef,
		thinkingLevel?: ThinkingLevel,
	): Promise<PiSessionRuntime> {
		try {
			const runtime = await createAgentSessionRuntime(this.#options.createRuntime, {
				cwd: sessionManager.getCwd(),
				agentDir: this.#options.agentDir,
				sessionManager,
			});
			if (modelRef) {
				const model = runtime.services.modelRuntime.getModel(modelRef.provider, modelRef.id);
				if (!model) {
					await runtime.dispose();
					throw new PiServerError("invalid_request", `Unknown model: ${modelRef.provider}/${modelRef.id}`);
				}
				await runtime.session.setModel(model);
			}
			if (thinkingLevel) runtime.session.setThinkingLevel(thinkingLevel);
			return new CodingAgentSessionRuntime(runtime);
		} catch (error) {
			if (error instanceof SessionWriteLockError) throw new SessionLockedError(error.message);
			throw error;
		}
	}

	#listStoredSessions(): Promise<SessionInfo[]> {
		return this.#options.sessionDir ? SessionManager.listAll(this.#options.sessionDir) : SessionManager.listAll();
	}
}

function toSessionMetadata(session: SessionInfo): SessionMetadata {
	return {
		id: session.id,
		createdAt: session.created.getTime(),
		updatedAt: session.modified.getTime(),
		sessionName: session.name,
		cwd: session.cwd || undefined,
	};
}

class CodingAgentSessionRuntime implements PiSessionRuntime {
	readonly #runtime: AgentSessionRuntime;
	readonly #listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	readonly #unsubscribe: () => void;
	#revision = 0;
	#disposed = false;

	constructor(runtime: AgentSessionRuntime) {
		this.#runtime = runtime;
		this.#unsubscribe = runtime.session.subscribe((event) => {
			this.#revision += 1;
			const progress = toTranscriptProgress(runtime.session, event);
			for (const listener of this.#listeners)
				listener(progress ? { type: "progress", progress } : { type: "snapshot" });
		});
	}

	snapshot(): SessionSnapshot {
		const session = this.#runtime.session;
		const transcript = toTranscript(session);
		const timestamps = transcript.map((item) => item.timestamp);
		const headerTimestamp = Date.parse(session.sessionManager.getHeader()?.timestamp ?? "");
		const createdAt = Number.isSafeInteger(headerTimestamp) && headerTimestamp >= 0 ? headerTimestamp : Date.now();
		const queuedSteer = session.getSteeringMessages().map((text, index) => ({
			id: `queued-${this.#revision}-${index}`,
			role: "user" as const,
			content: [{ type: "text" as const, text }],
			timestamp: Date.now(),
		}));
		return {
			id: session.sessionId,
			name: session.sessionName,
			cwd: this.#runtime.cwd,
			createdAt,
			updatedAt: timestamps.length > 0 ? Math.max(createdAt, ...timestamps) : createdAt,
			phase: this.getPhase(),
			model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
			thinkingLevel: session.thinkingLevel,
			attached: true,
			locked: true,
			revision: this.#revision,
			transcript,
			queuedSteer,
			queuedSteerCount: queuedSteer.length,
		};
	}

	getPhase(): SessionPhase {
		const session = this.#runtime.session;
		if (session.isCompacting) return "compaction";
		if (session.retryAttempt > 0) return "retry";
		return session.isStreaming ? "turn" : "idle";
	}

	async prompt(input: PromptInput): Promise<void> {
		const { text, images } = normalizePromptInput(input);
		await this.#runtime.session.prompt(text, { images, source: "rpc" });
	}

	async steer(input: PromptInput): Promise<void> {
		if (!this.#runtime.session.isStreaming) throw new PiServerError("busy", "There is no active prompt to steer");
		const { text, images } = normalizePromptInput(input);
		await this.#runtime.session.steer(text, images);
	}

	async followUp(input: PromptInput): Promise<void> {
		if (!this.#runtime.session.isStreaming)
			throw new PiServerError("busy", "There is no active prompt for follow-up");
		const { text, images } = normalizePromptInput(input);
		await this.#runtime.session.followUp(text, images);
	}

	async abort(): Promise<void> {
		if (!this.#runtime.session.isStreaming && !this.#runtime.session.isCompacting) {
			throw new PiServerError("busy", "There is no active operation to abort");
		}
		await this.#runtime.session.abort();
	}

	async setModel(modelRef: ModelRef): Promise<void> {
		if (!this.#runtime.session.isIdle) throw new PiServerError("busy", "Session is busy");
		const model = this.#runtime.services.modelRuntime.getModel(modelRef.provider, modelRef.id);
		if (!model) throw new PiServerError("invalid_request", `Unknown model: ${modelRef.provider}/${modelRef.id}`);
		await this.#runtime.session.setModel(model);
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		if (!this.#runtime.session.isIdle) throw new PiServerError("busy", "Session is busy");
		this.#runtime.session.setThinkingLevel(thinkingLevel);
	}

	async runAction(action: SessionAction, argument?: string): Promise<JsonValue> {
		const session = this.#runtime.session;
		switch (action) {
			case "rename":
				session.setSessionName(argument ?? "");
				return { name: session.sessionName ?? "" };
			case "bash": {
				if (!argument?.trim()) throw new PiServerError("invalid_request", "Bash command must not be empty");
				const result = await session.executeBash(argument);
				return {
					output: result.output,
					exitCode: result.exitCode ?? null,
					cancelled: result.cancelled,
					truncated: result.truncated,
				};
			}
			case "stats": {
				const stats = session.getSessionStats();
				const contextUsage = stats.contextUsage
					? {
							tokens: stats.contextUsage.tokens,
							contextWindow: stats.contextUsage.contextWindow,
							percent: stats.contextUsage.percent,
						}
					: null;
				return {
					sessionId: stats.sessionId,
					userMessages: stats.userMessages,
					assistantMessages: stats.assistantMessages,
					toolCalls: stats.toolCalls,
					toolResults: stats.toolResults,
					totalMessages: stats.totalMessages,
					tokens: stats.tokens,
					cost: stats.cost,
					contextUsage,
				};
			}
			case "compact": {
				const result = await session.compact(argument);
				return { summary: result.summary };
			}
			case "export_html":
				return { path: await session.exportToHtml(argument || undefined) };
			case "export_jsonl":
				return { path: session.exportToJsonl(argument || undefined) };
			case "reload":
				await session.reload();
				return { reloaded: true };
		}
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		this.#listeners.clear();
		await this.#runtime.dispose();
	}
}

function toTranscriptProgress(session: AgentSession, event: AgentSessionEvent): TranscriptProgress | undefined {
	if (event.type !== "message_update" || event.message.role !== "assistant") return undefined;
	const finalizedIndex = session.messages.indexOf(event.message);
	const index = finalizedIndex < 0 ? session.messages.length : finalizedIndex;
	return {
		type: "item_updated",
		item: toProtocolAssistantMessage(event.message, {
			id: transcriptItemId(event.message.role, event.message.timestamp, index),
		}),
	};
}

function transcriptItemId(role: string, timestamp: number, index: number): string {
	return `${role}-${timestamp}-${index}`;
}

function normalizePromptInput(input: PromptInput): { text: string; images?: ImageContent[] } {
	const images: ImageContent[] = [];
	const files: string[] = [];
	let decodedBytes = 0;
	for (const attachment of input.attachments ?? []) {
		const decoded = decodeBase64(attachment.data);
		decodedBytes += decoded.byteLength;
		if (decodedBytes > 10 * 1024 * 1024) {
			throw new PiServerError("invalid_request", "Attachments exceed the 10 MiB decoded payload limit");
		}
		if (attachment.type === "image") {
			images.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
		} else if (attachment.mimeType.startsWith("text/") || attachment.mimeType === "application/json") {
			files.push(
				`<attachment name="${escapeXml(attachment.name)}" type="${escapeXml(attachment.mimeType)}">\n${decoded.toString("utf8")}\n</attachment>`,
			);
		} else {
			throw new PiServerError("invalid_request", `Unsupported file attachment type: ${attachment.mimeType}`);
		}
	}
	return {
		text: files.length > 0 ? `${files.join("\n\n")}\n\n${input.text}` : input.text,
		images: images.length > 0 ? images : undefined,
	};
}

function decodeBase64(data: string): Buffer {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
		throw new PiServerError("invalid_request", "Attachment data is not valid base64");
	}
	return Buffer.from(data, "base64");
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function toTranscript(session: AgentSession): TranscriptItem[] {
	const result: TranscriptItem[] = [];
	const calls = new Map<string, ToolCall>();
	for (const [index, message] of session.messages.entries()) {
		const id = transcriptItemId(message.role, message.timestamp, index);
		switch (message.role) {
			case "user":
				result.push(toProtocolUserMessage(message, { id }));
				break;
			case "assistant":
				for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part);
				result.push(toProtocolAssistantMessage(message, { id }));
				break;
			case "toolResult": {
				const call = calls.get(message.toolCallId);
				if (call) result.push(toProtocolToolResultMessage(message, { id, call }));
				break;
			}
			case "custom":
				if (message.display) {
					const content =
						typeof message.content === "string"
							? message.content
							: message.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n");
					result.push({
						id,
						role: "user",
						content: [{ type: "text", text: content }],
						timestamp: message.timestamp,
					} satisfies UserTranscriptItem);
				}
				break;
		}
	}
	return result;
}
