import { PiClient, type PiSessionHandle } from "@earendil-works/pi-client";
import { createWebSocketTransportFactory } from "@earendil-works/pi-client/websocket";
import type {
	JsonValue,
	PromptAttachment,
	ServerSnapshot,
	SessionAction,
	SessionSnapshot,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { applySessionProgress } from "./session-progress.ts";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type SubmitBehavior = "steer" | "followUp";

export interface PiWorkspaceState {
	readonly connection: ConnectionStatus;
	readonly server?: ServerSnapshot;
	readonly session?: SessionSnapshot;
	readonly error?: string;
}

function getConfig() {
	const config = window.__PI_WEB_CONFIG__;
	if (!config) throw new Error("Pi Web bootstrap configuration is missing");
	return config;
}

export function usePiClient() {
	const [state, setState] = useState<PiWorkspaceState>({ connection: "connecting" });
	const clientRef = useRef<PiClient | undefined>(undefined);
	const sessionRef = useRef<PiSessionHandle | undefined>(undefined);
	const sessionSubscriptionRef = useRef<(() => void) | undefined>(undefined);
	const sessionEventSubscriptionRef = useRef<(() => void) | undefined>(undefined);
	const sessionSnapshotRef = useRef<SessionSnapshot | undefined>(undefined);
	const reportError = useCallback((error: unknown) => {
		setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
	}, []);

	const bindSession = useCallback((session: PiSessionHandle) => {
		sessionSubscriptionRef.current?.();
		sessionEventSubscriptionRef.current?.();
		sessionRef.current = session;
		sessionSnapshotRef.current = session.snapshot;
		setState((current) => ({ ...current, session: session.snapshot }));
		sessionSubscriptionRef.current = session.subscribe((snapshot) => {
			sessionSnapshotRef.current = snapshot;
			setState((current) => ({ ...current, session: snapshot }));
		});
		sessionEventSubscriptionRef.current = session.onEvent((event) => {
			const snapshot = sessionSnapshotRef.current;
			if (event.type !== "session_progress" || !snapshot) return;
			const next = applySessionProgress(snapshot, event.progress);
			sessionSnapshotRef.current = next;
			setState((current) => ({ ...current, session: next }));
		});
	}, []);

	useEffect(() => {
		const config = getConfig();
		const protocol = location.protocol === "https:" ? "wss:" : "ws:";
		const url = `${protocol}//${location.host}${config.websocketPath}?token=${encodeURIComponent(config.token)}`;
		const client = new PiClient({ transportFactory: createWebSocketTransportFactory({ url }) });
		clientRef.current = client;
		let unsubscribeServer = () => {};
		let unsubscribeConnection = () => {};
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		let disposed = false;
		const reconnect = () => {
			if (disposed || reconnectTimer) return;
			reconnectTimer = setTimeout(() => {
				reconnectTimer = undefined;
				if (disposed) return;
				setState((current) => ({ ...current, connection: "connecting" }));
				const sessionId = sessionRef.current?.id;
				void client
					.reconnect()
					.then(async () => {
						if (!sessionId || disposed) return;
						const session = await client.acquireSession(sessionId, { mode: "exclusive" });
						if (disposed) {
							await session.dispose();
							return;
						}
						bindSession(session);
					})
					.catch(() => reconnect());
			}, 1_000);
		};
		unsubscribeConnection = client.onConnectionStateChange((change) => {
			setState((current) => ({ ...current, connection: change.state, error: change.error?.message }));
			if (change.state === "disconnected") reconnect();
		});
		void client
			.connect()
			.then((server) => {
				setState({ connection: "connected", server });
				unsubscribeServer = client.subscribe((snapshot) =>
					setState((current) => ({ ...current, connection: "connected", server: snapshot })),
				);
			})
			.catch((error: unknown) => {
				if (!disposed) {
					setState({ connection: "disconnected", error: error instanceof Error ? error.message : String(error) });
				}
			});
		return () => {
			disposed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			unsubscribeConnection();
			sessionSubscriptionRef.current?.();
			sessionEventSubscriptionRef.current?.();
			unsubscribeServer();
			void sessionRef.current?.dispose();
			void client.dispose();
		};
	}, [bindSession]);

	const openSession = useCallback(
		async (sessionId: string) => {
			try {
				const client = clientRef.current;
				if (!client) return;
				await sessionRef.current?.dispose();
				const session = await client.acquireSession(sessionId, { mode: "exclusive" });
				bindSession(session);
				setState((current) => ({ ...current, error: undefined }));
			} catch (error) {
				reportError(error);
			}
		},
		[bindSession, reportError],
	);

	const newSession = useCallback(async () => {
		try {
			const client = clientRef.current;
			if (!client) return;
			await sessionRef.current?.dispose();
			const session = await client.createSession({ cwd: getConfig().cwd });
			bindSession(session);
			setState((current) => ({ ...current, error: undefined }));
		} catch (error) {
			reportError(error);
		}
	}, [bindSession, reportError]);

	const submit = useCallback(
		async (text: string, attachments?: readonly PromptAttachment[], behavior: SubmitBehavior = "steer") => {
			try {
				const session = sessionRef.current;
				if (!session || (!text.trim() && !attachments?.length)) return;
				if (session.snapshot?.phase === "idle") await session.prompt(text.trim(), attachments);
				else if (behavior === "followUp") await session.followUp(text.trim(), attachments);
				else await session.steer(text.trim(), attachments);
				setState((current) => ({ ...current, error: undefined }));
			} catch (error) {
				reportError(error);
			}
		},
		[reportError],
	);

	const abort = useCallback(async () => {
		try {
			await sessionRef.current?.abort();
		} catch (error) {
			reportError(error);
		}
	}, [reportError]);
	const setModel = useCallback(
		async (provider: string, id: string) => {
			try {
				await sessionRef.current?.setModel({ provider, id });
			} catch (error) {
				reportError(error);
			}
		},
		[reportError],
	);
	const setThinking = useCallback(
		async (thinkingLevel: SessionSnapshot["thinkingLevel"]) => {
			try {
				await sessionRef.current?.setThinking(thinkingLevel);
			} catch (error) {
				reportError(error);
			}
		},
		[reportError],
	);
	const runAction = useCallback(
		async (action: SessionAction, argument?: string): Promise<JsonValue | undefined> => {
			try {
				const result = await sessionRef.current?.runAction(action, argument);
				setState((current) => ({ ...current, error: undefined }));
				return result?.output;
			} catch (error) {
				reportError(error);
				return undefined;
			}
		},
		[reportError],
	);

	return { state, openSession, newSession, submit, abort, setModel, setThinking, runAction };
}
