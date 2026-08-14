import type { SessionSnapshot, TranscriptItem, TranscriptProgress } from "@earendil-works/pi-protocol";

export function applySessionProgress(snapshot: SessionSnapshot, progress: TranscriptProgress): SessionSnapshot {
	if (progress.type === "item_started" || progress.type === "item_updated" || progress.type === "item_finished") {
		return replaceTranscriptItem(snapshot, progress.item);
	}
	const index = snapshot.transcript.findIndex((item) => item.id === progress.messageId);
	const item = snapshot.transcript[index];
	if (index < 0 || !item || item.role !== "assistant") return snapshot;
	const content = item.content.map((part, contentIndex) => {
		if (contentIndex !== progress.contentIndex) return part;
		if (progress.kind === "text" && part.type === "text") return { ...part, text: part.text + progress.delta };
		if (progress.kind === "thinking" && part.type === "thinking") {
			return { ...part, thinking: part.thinking + progress.delta };
		}
		return part;
	});
	const transcript = [...snapshot.transcript];
	transcript[index] = { ...item, content };
	return { ...snapshot, transcript };
}

function replaceTranscriptItem(snapshot: SessionSnapshot, item: TranscriptItem): SessionSnapshot {
	const index = snapshot.transcript.findIndex((candidate) => candidate.id === item.id);
	const transcript = [...snapshot.transcript];
	if (index < 0) transcript.push(structuredClone(item));
	else transcript[index] = structuredClone(item);
	return { ...snapshot, transcript };
}
