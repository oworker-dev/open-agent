import { fromThreadMessageLike, } from "@assistant-ui/react";
import { parseAssetPrompt } from "@oworker/open-agent-contracts/asset";
import { isLocallyInterruptedMessage } from "./turn-presentation.js";
const COMPLETE = { reason: "stop", type: "complete" };
const RUNNING = { type: "running" };
const CANCELLED = { reason: "cancelled", type: "incomplete" };
const USER_COMPLETE = { reason: "unknown", type: "complete" };
export function convertEveMessages(messages, options = {}) {
    return messages.map((message, index) => convertEveMessage(message, index, messages, options));
}
function convertEveMessage(message, index, messages, options) {
    const metadata = {
        ...(message.metadata?.optimistic ? { isOptimistic: true } : {}),
        custom: { ...(message.metadata ?? {}) },
    };
    const like = message.role === "user"
        ? {
            attachments: userAttachments(message.parts, options.assetUrl),
            content: userContent(message.parts),
            createdAt: new Date(),
            id: message.id,
            metadata,
            role: "user",
        }
        : {
            content: message.parts.flatMap((part) => {
                const converted = assistantPart(part, options.assetUrl);
                return converted ? [converted] : [];
            }),
            createdAt: new Date(),
            id: message.id,
            metadata,
            role: "assistant",
        };
    return fromThreadMessageLike(like, message.id, messageStatus(message, index, messages, options));
}
function messageStatus(message, index, messages, options) {
    if (message.role !== "assistant")
        return USER_COMPLETE;
    if (isLocallyInterruptedMessage(message))
        return CANCELLED;
    const isLast = index === messages.length - 1;
    if (message.parts.some((part) => part.type === "tool" && part.interaction?.status === "open")) {
        return { reason: "tool-calls", type: "requires-action" };
    }
    if (message.parts.some((part) => part.type === "interaction" && part.status === "open")) {
        return { reason: "interrupt", type: "requires-action" };
    }
    if (message.metadata?.status === "failed")
        return { reason: "error", type: "incomplete" };
    if (isLast && options.isRunning)
        return RUNNING;
    if (message.metadata?.status === "streaming") {
        if (options.isRunning === undefined)
            return RUNNING;
        if (isLast && options.error !== undefined)
            return { reason: "error", type: "incomplete" };
        return CANCELLED;
    }
    return COMPLETE;
}
function assistantPart(part, assetUrl) {
    if (part.type === "text" || part.type === "reasoning") {
        return { text: part.text, type: part.type };
    }
    if (part.type === "tool")
        return toolPart(part);
    if (part.type === "file")
        return filePart(part, assetUrl);
    if (part.type === "interaction") {
        return {
            data: {
                interactionId: part.interactionId,
                kind: part.request.kind,
                outcome: part.outcome,
                prompt: part.request.prompt,
                status: part.status,
            },
            name: "interaction",
            type: "data",
        };
    }
    return null;
}
function toolPart(part) {
    const base = {
        args: jsonObject(part.input),
        argsText: part.state === "streaming"
            ? part.inputText
            : safeStringify(part.input),
        toolCallId: part.callId,
        toolName: part.name,
        type: "tool-call",
    };
    if (part.state === "streaming")
        return base;
    if (part.state === "completed")
        return { ...base, result: part.output };
    if (part.state === "failed" || part.state === "rejected" || part.state === "cancelled") {
        return {
            ...base,
            isError: true,
            result: { error: part.error?.message ?? part.state },
        };
    }
    if (part.interaction?.status === "open") {
        return { ...base, approval: { id: part.interaction.interactionId } };
    }
    return base;
}
function filePart(part, assetUrl) {
    if (!part.url)
        return null;
    const assetId = part.url.startsWith("asset://") ? part.url.slice("asset://".length) : undefined;
    const url = assetId ? assetUrl?.(assetId) ?? `/api/assets/${encodeURIComponent(assetId)}` : part.url;
    return {
        data: url,
        ...(part.filename ? { filename: part.filename } : {}),
        mimeType: part.mediaType || "application/octet-stream",
        ...(/^(?:https?:\/\/|\/api\/assets\/)/u.test(url) ? { sourceType: "url" } : {}),
        type: "file",
    };
}
function userContent(parts) {
    const content = parts.flatMap((part) => part.type === "text"
        ? [{ text: stripAssetReferences(part.text), type: "text" }]
        : []);
    return content.length > 0 ? content : [{ text: "", type: "text" }];
}
function userAttachments(parts, assetUrl) {
    const fileAttachments = parts.flatMap((part, index) => {
        if (part.type !== "file")
            return [];
        const file = filePart(part, assetUrl);
        if (!file)
            return [];
        const image = file.mimeType.startsWith("image/");
        return [{
                content: [file],
                contentType: file.mimeType,
                id: String(index),
                name: part.filename ?? "file",
                status: { type: "complete" },
                type: image ? "image" : "file",
            }];
    });
    const assetAttachments = parts.flatMap((part) => {
        if (part.type !== "text")
            return [];
        return parseAssetReferences(part.text).map((asset, index) => ({
            content: [{ data: assetUrl?.(asset.id) ?? `/api/assets/${encodeURIComponent(asset.id)}`, filename: asset.name, mimeType: asset.mediaType, type: "file" }],
            contentType: asset.mediaType,
            id: `asset-${asset.id}-${index}`,
            name: asset.name,
            status: { type: "complete" },
            type: asset.mediaType.startsWith("image/") ? "image" : "file",
        }));
    });
    return [...fileAttachments, ...assetAttachments];
}
export function getEveMessageContent(message) {
    const content = [
        ...message.content,
        ...(message.attachments?.flatMap((attachment) => attachment.content) ?? []),
    ];
    const parts = [];
    for (const part of content) {
        if (part.type === "text") {
            parts.push({ text: part.text, type: "text" });
            continue;
        }
        if (part.type === "file") {
            parts.push({ data: part.data, ...(part.filename ? { filename: part.filename } : {}), mediaType: part.mimeType, type: "file" });
            continue;
        }
        if (part.type === "image") {
            const image = typeof part.image === "string" ? part.image : String(part.image);
            parts.push({ data: image, ...(part.filename ? { filename: part.filename } : {}), mediaType: "image/*", type: "file" });
        }
    }
    return parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts;
}
function parseAssetReferences(text) {
    return parseAssetPrompt(text).assets;
}
function stripAssetReferences(text) {
    return parseAssetPrompt(text).text;
}
function jsonObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : value === undefined
            ? {}
            : { value: safeStringify(value) };
}
function safeStringify(value) {
    try {
        return JSON.stringify(value ?? {});
    }
    catch {
        return "";
    }
}
//# sourceMappingURL=eve-message-adapter.js.map