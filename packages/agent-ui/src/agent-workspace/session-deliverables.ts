import type { AgentDeliverableEndpoint, AgentSessionDeliverable } from "./contracts.js";

export function resolveSessionDeliverableEndpoint(endpoint: AgentDeliverableEndpoint, sessionId: string): string {
  if (typeof endpoint === "function") return endpoint(sessionId);
  const encoded = encodeURIComponent(sessionId);
  if (endpoint.includes("{sessionId}")) return endpoint.replaceAll("{sessionId}", encoded);
  if (endpoint.includes(":sessionId")) return endpoint.replaceAll(":sessionId", encoded);
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}sessionId=${encoded}`;
}

export function parseSessionDeliverables(payload: unknown): readonly AgentSessionDeliverable[] {
  const values = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.deliverables)
      ? payload.deliverables
      : [];
  const deliverables: AgentSessionDeliverable[] = [];
  for (const value of values.slice(0, 400)) {
    if (!isRecord(value)) continue;
    const id = boundedText(value.id, 512);
    const kind = value.kind;
    const title = boundedText(value.title, 255);
    const createdAt = boundedText(value.createdAt, 64);
    const url = safeResourceUrl(value.url);
    const sizeBytes = typeof value.sizeBytes === "number" && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0
      ? value.sizeBytes
      : undefined;
    if (!id || !title || !createdAt || !url || sizeBytes === undefined || !isDeliverableKind(kind)) continue;
    const expiresAt = boundedText(value.expiresAt, 64);
    const fileCount = typeof value.fileCount === "number" && Number.isSafeInteger(value.fileCount) && value.fileCount >= 0
      ? value.fileCount
      : undefined;
    const mediaType = boundedText(value.mediaType, 200);
    deliverables.push({
      createdAt,
      ...(expiresAt ? { expiresAt } : {}),
      ...(fileCount !== undefined ? { fileCount } : {}),
      id,
      kind,
      ...(mediaType ? { mediaType } : {}),
      sizeBytes,
      title,
      url,
    });
  }
  return deliverables;
}

function isDeliverableKind(value: unknown): value is AgentSessionDeliverable["kind"] {
  return value === "artifact" || value === "asset" || value === "website-preview";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength ? value.trim() : undefined;
}

function safeResourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const parsed = new URL(value, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}
