import {
  fromThreadMessageLike,
  type AppendMessage,
  type CompleteAttachment,
  type DataMessagePart,
  type FileMessagePart,
  type MessageStatus,
  type ThreadAssistantMessagePart,
  type ThreadMessage,
  type ThreadMessageLike,
  type ThreadUserMessagePart,
  type ToolApprovalOption,
  type ToolCallMessagePart,
} from "@assistant-ui/react";
import type {
  EveAuthorizationOutcome,
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
  EveMessageData,
  EveMessageInputRequest,
  EveMessagePart,
} from "eve/react";
import type { ClientSession } from "eve/client";

type ConvertOptions = {
  readonly assetUrl?: (assetId: string) => string;
  readonly error?: unknown;
  readonly isRunning?: boolean;
};

const COMPLETE = { reason: "stop", type: "complete" } satisfies MessageStatus;
const RUNNING = { type: "running" } satisfies MessageStatus;
const CANCELLED = { reason: "cancelled", type: "incomplete" } satisfies MessageStatus;
const USER_COMPLETE = { reason: "unknown", type: "complete" } satisfies MessageStatus;

export function convertEveMessages(
  data: EveMessageData,
  options: ConvertOptions = {},
): ThreadMessage[] {
  return data.messages.map((message, index, messages) =>
    convertEveMessage(message, index, messages, options));
}

function convertEveMessage(
  message: EveMessage,
  index: number,
  messages: readonly EveMessage[],
  options: ConvertOptions,
): ThreadMessage {
  const metadata = {
    ...(message.metadata?.optimistic ? { isOptimistic: true } : {}),
    custom: { ...(message.metadata ?? {}) },
  };
  const like: ThreadMessageLike = message.role === "user"
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
  return fromThreadMessageLike(
    like,
    message.id,
    messageStatus(message, index, messages, options),
  );
}

function messageStatus(
  message: EveMessage,
  index: number,
  messages: readonly EveMessage[],
  options: ConvertOptions,
): MessageStatus {
  if (message.role !== "assistant") return USER_COMPLETE;
  const isLast = index === messages.length - 1;
  if (message.parts.some((part) =>
    part.type === "dynamic-tool" && part.state === "approval-requested")) {
    return { reason: "tool-calls", type: "requires-action" };
  }
  const requiresAuthorization = message.metadata?.status === "streaming" &&
    (!isLast || options.error === undefined) &&
    message.parts.some((part) => part.type === "authorization" && part.state === "required");
  if (requiresAuthorization) return { reason: "interrupt", type: "requires-action" };
  if (message.metadata?.status === "failed") return { reason: "error", type: "incomplete" };
  if (isLast && options.isRunning) return RUNNING;
  if (message.metadata?.status === "streaming") {
    if (options.isRunning === undefined) return RUNNING;
    if (isLast && options.error !== undefined) {
      return { reason: "error", type: "incomplete" };
    }
    return CANCELLED;
  }
  return COMPLETE;
}

function assistantPart(part: EveMessagePart, assetUrl?: (assetId: string) => string): ThreadAssistantMessagePart | DataMessagePart<AuthorizationData> | null {
  if (part.type === "text" || part.type === "reasoning") {
    return { text: part.text, type: part.type };
  }
  if (part.type === "dynamic-tool") return dynamicToolPart(part);
  if (part.type === "authorization") return authorizationPart(part);
  if (part.type === "file") return filePart(part, assetUrl);
  return null;
}

function dynamicToolPart(part: EveDynamicToolPart): ToolCallMessagePart {
  const approval = toolApproval(part);
  const base: ToolCallMessagePart = {
    ...(approval ? { approval } : {}),
    args: jsonObject(part.input),
    argsText: safeStringify(part.input),
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    type: "tool-call",
  };
  if (part.state === "output-available") return { ...base, result: part.output };
  if (part.state === "output-error") {
    return { ...base, isError: true, result: { error: part.errorText } };
  }
  if (part.state === "output-denied") {
    return { ...base, isError: true, result: { error: part.approval?.reason ?? "Tool approval denied" } };
  }
  return base;
}

function toolApproval(part: EveDynamicToolPart): ToolCallMessagePart["approval"] | undefined {
  if (!("approval" in part) || !part.approval) return undefined;
  const options = approvalOptions(part.toolMetadata?.eve?.inputRequest);
  return {
    ...(part.approval.approved === undefined ? {} : { approved: part.approval.approved }),
    ...(part.approval.isAutomatic === undefined ? {} : { isAutomatic: part.approval.isAutomatic }),
    ...(options ? { options } : {}),
    ...(part.approval.reason ? { reason: part.approval.reason } : {}),
    id: part.approval.id,
  };
}

function approvalOptions(request: EveMessageInputRequest | undefined): readonly ToolApprovalOption[] | undefined {
  if (!request?.options?.length) return undefined;
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

type AuthorizationData = {
  readonly description?: string;
  readonly displayName?: string;
  readonly expiresAt?: string;
  readonly instructions?: string;
  readonly name: string;
  readonly outcome?: EveAuthorizationOutcome;
  readonly reason?: string;
  readonly state: EveAuthorizationPart["state"];
  readonly url?: string;
  readonly userCode?: string;
};

function authorizationPart(part: EveAuthorizationPart): DataMessagePart<AuthorizationData> {
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

function filePart(part: Extract<EveMessagePart, { type: "file" }>, assetUrl?: (assetId: string) => string): FileMessagePart | null {
  if (!part.url) return null;
  const assetId = part.url.startsWith("asset://") ? part.url.slice("asset://".length) : undefined;
  const url = assetId ? assetUrl?.(assetId) ?? `/api/assets/${encodeURIComponent(assetId)}` : part.url;
  return {
    data: url,
    ...(part.filename ? { filename: part.filename } : {}),
    mimeType: part.mediaType || "application/octet-stream",
    ...(/^(?:https?:\/\/|\/api\/assets\/)/u.test(url) ? { sourceType: "url" as const } : {}),
    type: "file",
  };
}

function userContent(parts: readonly EveMessagePart[]): readonly ThreadUserMessagePart[] {
  const content = parts.flatMap((part) =>
    part.type === "text"
      ? [{ text: stripAssetReferences(part.text), type: "text" as const }]
      : []);
  return content.length > 0 ? content : [{ text: "", type: "text" }];
}

function userAttachments(parts: readonly EveMessagePart[], assetUrl?: (assetId: string) => string): CompleteAttachment[] {
  const fileAttachments = parts.flatMap((part, index) => {
    if (part.type !== "file") return [];
    const file = filePart(part, assetUrl);
    if (!file) return [];
    const image = file.mimeType.startsWith("image/");
    return [{
      content: [file],
      contentType: file.mimeType,
      id: String(index),
      name: part.filename ?? "file",
      status: { type: "complete" as const },
      type: image ? "image" as const : "file" as const,
    }];
  });
  const assetAttachments = parts.flatMap((part) => {
    if (part.type !== "text") return [];
    return parseAssetReferences(part.text).map((asset, index) => ({
      content: [{ data: assetUrl?.(asset.id) ?? `/api/assets/${encodeURIComponent(asset.id)}`, filename: asset.name, mimeType: asset.mediaType, type: "file" as const }],
      contentType: asset.mediaType,
      id: `asset-${asset.id}-${index}`,
      name: asset.name,
      status: { type: "complete" as const },
      type: asset.mediaType.startsWith("image/") ? "image" as const : "file" as const,
    }));
  });
  return [...fileAttachments, ...assetAttachments];
}

export function getEveMessageContent(message: AppendMessage): Parameters<ClientSession["send"]>[0] {
  const content = [
    ...message.content,
    ...(message.attachments?.flatMap((attachment) => attachment.content) ?? []),
  ];
  const parts: Exclude<Parameters<ClientSession["send"]>[0], string> = [];
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

type AssetReference = { readonly id: string; readonly mediaType: string; readonly name: string; readonly size?: number };

function parseAssetReferences(text: string): AssetReference[] {
  const references: AssetReference[] = [];
  for (const match of text.matchAll(/\[open-agent-asset (\{[^\n\]]+\})\]/gu)) {
    try {
      const value = JSON.parse(match[1]) as Partial<AssetReference>;
      if (typeof value.id === "string" && typeof value.name === "string" && typeof value.mediaType === "string") {
        references.push({ id: value.id, mediaType: value.mediaType, name: value.name, ...(typeof value.size === "number" ? { size: value.size } : {}) });
      }
    } catch {
      // Ignore malformed display markers; the raw text remains available to the Agent.
    }
  }
  return references;
}

function stripAssetReferences(text: string): string {
  return text.replace(/\s*\[open-agent-asset \{[^\n\]]+\}\]/gu, "").trim();
}

function jsonObject(value: unknown): ToolCallMessagePart["args"] {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ToolCallMessagePart["args"]
    : value === undefined
      ? {}
      : { value: safeStringify(value) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}
