import type { ProjectFile, PromptAttachment, SessionMetadata, TranscriptItem } from "@earendil-works/pi-protocol";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { shouldFollowOutput } from "./scroll.ts";
import { usePiClient } from "./use-pi-client.ts";
import type { SubmitBehavior } from "./use-pi-client.ts";

function sessionTitle(session: SessionMetadata): string {
	return session.sessionName || session.id.slice(0, 8);
}

function TranscriptEntry({ item, select }: { item: TranscriptItem; select(item: TranscriptItem): void }) {
	if (item.role === "user") {
		return (
		<article className="message user-message">
			<div className="message-label">You</div>
			{item.content.map((part, index) =>
				part.type === "text" ? (
					<Markdown key={index} remarkPlugins={[remarkGfm]}>
						{part.text}
					</Markdown>
				) : (
					<img key={index} src={`data:${part.mimeType};base64,${part.data}`} alt="attachment" />
				),
			)}
		</article>
		);
	}
	if (item.role === "tool") {
		return (
		<button className={`tool-card ${item.status}`} onClick={() => select(item)} type="button">
			<span>{item.toolName}</span>
			<small>{item.status}</small>
		</button>
		);
	}
	return (
		<article className="message assistant-message">
			<div className="message-label">Pi</div>
			{item.content.map((part, index) => {
				if (part.type === "thinking") return <details key={index}><summary>Thinking</summary>{part.thinking}</details>;
				if (part.type === "toolCall") return <button key={index} className="tool-call" onClick={() => select(item)} type="button">{part.toolName}</button>;
				return <Markdown key={index} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{part.text}</Markdown>;
			})}
		</article>
	);
}

export function App() {
	const { state, openSession, newSession, submit, abort, setModel, setThinking, runAction } = usePiClient();
	const [draft, setDraft] = useState("");
	const [selected, setSelected] = useState<TranscriptItem>();
	const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
	const [submitBehavior, setSubmitBehavior] = useState<SubmitBehavior>("steer");
	const [projectPath, setProjectPath] = useState("");
	const [projectFiles, setProjectFiles] = useState<readonly ProjectFile[]>();
	const [filesError, setFilesError] = useState<string>();
	const [actionOutput, setActionOutput] = useState<string>();
	const fileInput = useRef<HTMLInputElement | null>(null);
	const transcript = useRef<HTMLElement | null>(null);
	const followOutput = useRef(true);
	const lastSessionId = useRef<string | undefined>(undefined);
	const sessions = state.server?.sessions ?? [];
	const models = state.server?.models ?? [];
	const modelKey = state.session?.model ? `${state.session.model.provider}/${state.session.model.id}` : "";
	const busy = state.session !== undefined && state.session.phase !== "idle";
	const hasAuthenticatedModel = models.some((model) => model.authenticated);
	const detail = useMemo(() => (selected ? JSON.stringify(selected, null, 2) : undefined), [selected]);
	useLayoutEffect(() => {
		const sessionId = state.session?.id;
		if (sessionId !== lastSessionId.current) {
			lastSessionId.current = sessionId;
			followOutput.current = true;
		}
		if (transcript.current && followOutput.current) transcript.current.scrollTop = transcript.current.scrollHeight;
	}, [state.session?.id, state.session?.transcript]);
	const browseProject = async (path: string) => {
		try {
			const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, { credentials: "same-origin" });
			if (!response.ok) throw new Error(await response.text());
			const payload = (await response.json()) as { files: ProjectFile[] };
			setProjectPath(path);
			setProjectFiles(payload.files);
			setFilesError(undefined);
		} catch (error) {
			setFilesError(error instanceof Error ? error.message : String(error));
		}
	};
	const invokeAction = async (action: "stats" | "compact" | "export_html" | "export_jsonl" | "reload") => {
		const output = await runAction(action);
		if (output !== undefined) setActionOutput(JSON.stringify(output, null, 2));
	};

	return (
		<div className="workspace">
			<aside className="sidebar">
				<header><div><span className="brand-mark">π</span><b>Pi</b></div><button type="button" onClick={() => void newSession()}>New</button></header>
				<div className="connection"><i className={state.connection} />{state.connection}</div>
				<nav>
					{sessions.map((session) => <button type="button" className={state.session?.id === session.id ? "active" : ""} key={session.id} onClick={() => void openSession(session.id)}><b>{sessionTitle(session)}</b><small>{session.cwd}</small></button>)}
				</nav>
			</aside>
			<main className="chat">
				<header className="topbar">
					<div><b>{state.session?.name || "Local workspace"}</b><small>{state.session?.cwd || window.__PI_WEB_CONFIG__?.cwd}</small></div>
					<select value={modelKey} disabled={!state.session} onChange={(event) => { const [provider, ...id] = event.target.value.split("/"); void setModel(provider, id.join("/")); }}>
						{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}
					</select>
					<select value={state.session?.thinkingLevel ?? "off"} disabled={!state.session} onChange={(event) => void setThinking(event.target.value as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")}>
						{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option key={level}>{level}</option>)}
					</select>
				</header>
				<section
					className="transcript"
					ref={transcript}
					onScroll={(event) => {
						followOutput.current = shouldFollowOutput(event.currentTarget);
					}}
				>
					{state.error && <div className="error-banner">{state.error}</div>}
					{state.server && !hasAuthenticatedModel && <div className="credential-banner">No provider credentials found. Start <code>pi</code> in a terminal and run <code>/login</code>.</div>}
					{!state.session && !state.error && <div className="empty"><span>π</span><h1>What are we building?</h1><p>Open a session or start a new local workspace.</p><button type="button" onClick={() => void newSession()}>Start a session</button></div>}
					{state.session?.transcript.map((item) => <TranscriptEntry item={item} key={item.id} select={setSelected} />)}
				</section>
				<form className="composer" onSubmit={(event) => { event.preventDefault(); const text = draft; const files = attachments; setDraft(""); setAttachments([]); void submit(text, files, submitBehavior); }}>
					{attachments.length > 0 && <div className="attachment-list">{attachments.map((attachment, index) => <button type="button" key={`${attachment.name ?? "image"}-${index}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}>{attachment.name ?? "image"} ×</button>)}</div>}
					<textarea aria-label="Prompt" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={state.session ? "Ask Pi anything…" : "Start a session first"} disabled={!state.session} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
					<div><span><button className="attach" type="button" disabled={!state.session} onClick={() => fileInput.current?.click()}>Attach</button><button className="attach" type="button" disabled={!state.session} onClick={() => void browseProject(projectPath)}>Files</button>{busy && <select className="queue-mode" value={submitBehavior} onChange={(event) => setSubmitBehavior(event.target.value as SubmitBehavior)}><option value="steer">Steer</option><option value="followUp">Follow-up</option></select>} · Enter to send</span><span className="composer-actions">{busy && <button className="stop" type="button" onClick={() => void abort()}>Stop</button>}<button type="submit" disabled={!state.session || (!draft.trim() && attachments.length === 0)}>{busy ? "Queue" : "Send"}</button></span></div>
					<input ref={fileInput} hidden type="file" multiple accept="image/*,text/*,application/json" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; void Promise.all(files.map(readAttachment)).then((next) => setAttachments((current) => [...current, ...next])).catch((error: unknown) => alert(error instanceof Error ? error.message : String(error))); }} />
				</form>
			</main>
			<aside className="inspector">
				<header><b>Inspector</b></header>
				{state.session && <div className="command-bar"><button type="button" onClick={() => { const name = prompt("Session name", state.session?.name ?? ""); if (name !== null) void runAction("rename", name); }}>Rename</button><button type="button" onClick={() => { const command = prompt("Bash command"); if (command) void runAction("bash", command).then((output) => output !== undefined && setActionOutput(JSON.stringify(output, null, 2))); }}>Bash</button><button type="button" onClick={() => void invokeAction("stats")}>Stats</button><button type="button" onClick={() => void invokeAction("compact")}>Compact</button><button type="button" onClick={() => void invokeAction("export_html")}>Export HTML</button><button type="button" onClick={() => void invokeAction("export_jsonl")}>Export JSONL</button><button type="button" onClick={() => void invokeAction("reload")}>Reload</button></div>}
				{projectFiles ? <div className="file-browser"><div><button type="button" onClick={() => { setProjectFiles(undefined); setFilesError(undefined); }}>Close</button><code>/{projectPath}</code></div>{projectPath && <button type="button" onClick={() => void browseProject(projectPath.split("/").slice(0, -1).join("/"))}>../</button>}{projectFiles.map((file) => <button type="button" key={file.path} onClick={() => file.type === "directory" ? void browseProject(file.path) : (setDraft((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${file.path} `), setProjectFiles(undefined))}><span>{file.type === "directory" ? "▸" : "·"} {file.name}</span>{file.size !== undefined && <small>{formatBytes(file.size)}</small>}</button>)}{filesError && <p>{filesError}</p>}</div> : detail ? <pre>{detail}</pre> : <div className="inspector-empty"><p>Select a tool card to inspect input and output.</p>{filesError && <p className="error-banner">{filesError}</p>}{state.session && <dl><dt>Session</dt><dd>{state.session.id}</dd><dt>Phase</dt><dd>{state.session.phase}</dd><dt>Revision</dt><dd>{state.session.revision}</dd></dl>}</div>}
				{actionOutput && <pre className="action-output">{actionOutput}</pre>}
			</aside>
		</div>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

async function readAttachment(file: File): Promise<PromptAttachment> {
	if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} exceeds the 10 MiB attachment limit`);
	const buffer = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (let offset = 0; offset < buffer.length; offset += 0x8000) {
		binary += String.fromCharCode(...buffer.subarray(offset, offset + 0x8000));
	}
	const data = btoa(binary);
	const mimeType = file.type || "application/octet-stream";
	return mimeType.startsWith("image/")
		? { type: "image", data, mimeType, name: file.name }
		: { type: "file", data, mimeType, name: file.name };
}
