import { fromThreadMessageLike, } from "@assistant-ui/react";
const COMPLETE = { reason: "stop", type: "complete" };
const RUNNING = { type: "running" };
const CANCELLED = { reason: "cancelled", type: "incomplete" };
const USER_COMPLETE = { reason: "unknown", type: "complete" };
export function convertEveMessages(data, options = {}) {
    return data.messages.map((message, index, messages) => convertEveMessage(message, index, messages, options));
}
function convertEveMessage(message, index, messages, options) {
    const metadata = {
        ...(message.metadata?.optimistic ? { isOptimistic: true } : {}),
        custom: { ...(message.metadata ?? {}) },
    };
    const like = message.role === "user"
        ? {
            attachments: userAttachments(message.parts),
            content: userContent(message.parts),
            createdAt: new Date(),
            id: message.id,
            metadata,
            role: "user",
        }
        : {
            content: message.parts.flatMap((part) => {
                const converted = assistantPart(part);
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
    const isLast = index === messages.length - 1;
    if (message.parts.some((part) => part.type === "dynamic-tool" && part.state === "approval-requested")) {
        return { reason: "tool-calls", type: "requires-action" };
    }
    const requiresAuthorization = message.metadata?.status === "streaming" &&
        (!isLast || options.error === undefined) &&
        message.parts.some((part) => part.type === "authorization" && part.state === "required");
    if (requiresAuthorization)
        return { reason: "interrupt", type: "requires-action" };
    if (message.metadata?.status === "failed")
        return { reason: "error", type: "incomplete" };
    if (isLast && options.isRunning)
        return RUNNING;
    if (message.metadata?.status === "streaming") {
        if (options.isRunning === undefined)
            return RUNNING;
        if (isLast && options.error !== undefined) {
            return { reason: "error", type: "incomplete" };
        }
        return CANCELLED;
    }
    return COMPLETE;
}
function assistantPart(part) {
    if (part.type === "text" || part.type === "reasoning") {
        return { text: part.text, type: part.type };
    }
    if (part.type === "dynamic-tool")
        return dynamicToolPart(part);
    if (part.type === "authorization")
        return authorizationPart(part);
    if (part.type === "file")
        return filePart(part);
    return null;
}
function dynamicToolPart(part) {
    const approval = toolApproval(part);
    const base = {
        ...(approval ? { approval } : {}),
        args: jsonObject(part.input),
        argsText: safeStringify(part.input),
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        type: "tool-call",
    };
    if (part.state === "output-available")
        return { ...base, result: part.output };
    if (part.state === "output-error") {
        return { ...base, isError: true, result: { error: part.errorText } };
    }
    if (part.state === "output-denied") {
        return { ...base, isError: true, result: { error: part.approval?.reason ?? "Tool approval denied" } };
    }
    return base;
}
function toolApproval(part) {
    if (!("approval" in part) || !part.approval)
        return undefined;
    const options = approvalOptions(part.toolMetadata?.eve?.inputRequest);
    return {
        ...(part.approval.approved === undefined ? {} : { approved: part.approval.approved }),
        ...(part.approval.isAutomatic === undefined ? {} : { isAutomatic: part.approval.isAutomatic }),
        ...(options ? { options } : {}),
        ...(part.approval.reason ? { reason: part.approval.reason } : {}),
        id: part.approval.id,
    };
}
function approvalOptions(request) {
    if (!request?.options?.length)
        return undefined;
    return request.options.map((option) => ({
        ...(option.description ? { description: option.description } : {}),
        ...(option.label ? { label: option.label } : {}),
        id: option.id,
        kind: option.id === "approve"
            ? "allow-once"
            : option.id === "deny"
                ? "reject-once"
                : `_${option.id}`,
    }));
}
function authorizationPart(part) {
    const url = part.authorization?.url;
    return {
        data: {
            ...(part.description ? { description: part.description } : {}),
            ...(part.displayName ? { displayName: part.displayName } : {}),
            ...(part.authorization?.expiresAt ? { expiresAt: part.authorization.expiresAt } : {}),
            ...(part.authorization?.instructions ? { instructions: part.authorization.instructions } : {}),
            ...(part.outcome ? { outcome: part.outcome } : {}),
            ...(part.reason ? { reason: part.reason } : {}),
            ...(url && /^https?:\/\//u.test(url) ? { url } : {}),
            ...(part.authorization?.userCode ? { userCode: part.authorization.userCode } : {}),
            name: part.name,
            state: part.state,
        },
        name: "authorization",
        type: "data",
    };
}
function filePart(part) {
    if (!part.url)
        return null;
    return {
        data: part.url,
        ...(part.filename ? { filename: part.filename } : {}),
        mimeType: part.mediaType || "application/octet-stream",
        ...(/^https?:\/\//u.test(part.url) ? { sourceType: "url" } : {}),
        type: "file",
    };
}
function userContent(parts) {
    const content = parts.flatMap((part) => part.type === "text" ? [{ text: part.text, type: "text" }] : []);
    return content.length > 0 ? content : [{ text: "", type: "text" }];
}
function userAttachments(parts) {
    return parts.flatMap((part, index) => {
        if (part.type !== "file")
            return [];
        const file = filePart(part);
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
            parts.push({ data: part.image, ...(part.filename ? { filename: part.filename } : {}), mediaType: "image/*", type: "file" });
        }
    }
    return parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts;
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