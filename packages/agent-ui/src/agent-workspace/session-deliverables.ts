import type { AgentDeliverableEndpoint, AgentSessionDeliverable, AgentWorkspaceClientConfig } from "./contracts.js";
import type { SessionStreamEvent } from "eve/client";

export function publicationVersionLabel(version: string | undefined): string | undefined {
  const label = version?.trim();
  if (!label) return undefined;
  return /^\d/u.test(label) ? `v${label}` : label;
}

export function deliverableExpired(deliverable: AgentSessionDeliverable): boolean {
  return Boolean(deliverable.expiresAt && Date.parse(deliverable.expiresAt) <= Date.now());
}

/** Keep published history visible after its temporary files have expired. */
export function sessionPublicationsFromEvents(events: readonly SessionStreamEvent[]): readonly AgentSessionDeliverable[] {
  const kinds = new Map<string, "artifact" | "website-preview">();
  const publications = new Map<string, AgentSessionDeliverable>();
  for (const event of events) {
    if (event.type === "call.requested") {
      const name = event.data.capability.name.toLowerCase().replaceAll("-", "_");
      if (["publish_artifact", "artifact_publish"].includes(name)) kinds.set(event.data.callId, "artifact");
      if (["publish_preview", "website_preview"].includes(name)) kinds.set(event.data.callId, "website-preview");
    }
    if (event.type !== "call.settled" || event.data.outcome !== "completed" || !isRecord(event.data.output)) continue;
    const output = event.data.output;
    const kind = kinds.get(event.data.callId) ?? (output.kind === "artifact" || output.kind === "website-preview" ? output.kind : undefined);
    if (!kind) continue;
    const parsed = parseSessionDeliverables([{
      ...output,
      createdAt: output.createdAt ?? event.meta.at,
      id: kind === "artifact" ? output.artifactId : output.previewId,
      kind,
      sizeBytes: output.bytes ?? output.sizeBytes,
      title: kind === "artifact" ? output.filename : output.title ?? output.entrypoint ?? "Website preview",
    }])[0];
    if (parsed) publications.set(`${parsed.kind}:${parsed.id}`, parsed);
  }
  return [...publications.values()];
}

export async function loadSessionDeliverables({
  client,
  endpoint = "/api/deliverables",
  fetcher = fetch,
  sessionId,
  signal,
}: {
  readonly client?: AgentWorkspaceClientConfig;
  readonly endpoint?: AgentDeliverableEndpoint;
  readonly fetcher?: typeof fetch;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}): Promise<readonly AgentSessionDeliverable[]> {
  const configuredHeaders = typeof client?.headers === "function" ? await client.headers() : client?.headers;
  const headers = new Headers(configuredHeaders);
  if (client?.auth && "bearer" in client.auth) {
    const bearer = typeof client.auth.bearer === "function" ? await client.auth.bearer() : client.auth.bearer;
    headers.set("authorization", `Bearer ${bearer}`);
  }
  const base = client?.host || (typeof window !== "undefined" ? window.location.origin : "http://localhost");
  const endpointUrl = new URL(resolveSessionDeliverableEndpoint(endpoint, sessionId), base);
  if (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") {
    throw new Error("The deliverable endpoint must use HTTP(S).");
  }
  const response = await fetcher(endpointUrl, {
    credentials: "include",
    headers,
    signal,
  });
  if (!response.ok) throw new Error(`Deliverable list failed (${response.status}).`);
  return parseSessionDeliverables(await response.json() as unknown);
}

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
    const alias = boundedText(value.alias, 160);
    const kind = value.kind;
    const title = boundedText(value.title, 255);
    const createdAt = boundedText(value.createdAt, 64);
    const url = safeResourceUrl(value.url);
    const sizeBytes = nonNegativeInteger(value.sizeBytes);
    if (!id || !title || !createdAt || !url || !isDeliverableKind(kind)) continue;
    const expiresAt = boundedText(value.expiresAt, 64);
    const fileCount = typeof value.fileCount === "number" && Number.isSafeInteger(value.fileCount) && value.fileCount >= 0
      ? value.fileCount
      : undefined;
    const mediaType = boundedText(value.mediaType, 200);
    const version = boundedText(value.version, 80);
    deliverables.push({
      ...(alias ? { alias } : {}),
      createdAt,
      ...(expiresAt ? { expiresAt } : {}),
      ...(fileCount !== undefined ? { fileCount } : {}),
      id,
      kind,
      ...(mediaType ? { mediaType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      title,
      url,
      ...(version ? { version } : {}),
    });
  }
  return deliverables;
}

/**
 * Merge the host's unified deliverable registry with the legacy asset list.
 * During migration a host may expose both endpoints; an empty registry must
 * not hide assets that are still available through the legacy endpoint.
 */
export function mergeSessionDeliverables(
  deliverables: readonly AgentSessionDeliverable[] | undefined,
  assets: readonly AgentSessionAssetLike[],
): readonly AgentSessionDeliverable[] {
  const merged = new Map<string, AgentSessionDeliverable>();
  for (const deliverable of deliverables ?? []) {
    merged.set(`${deliverable.kind}:${deliverable.id}`, deliverable);
  }
  for (const asset of assets) {
    const deliverable = assetToDeliverable(asset);
    const key = `${deliverable.kind}:${deliverable.id}`;
    if (!merged.has(key)) merged.set(key, deliverable);
  }
  return [...merged.values()];
}

/** Keep uploaded session files separate from Agent-published outputs in the UI. */
export function splitSessionDeliverables(
  deliverables: readonly AgentSessionDeliverable[],
): {
  readonly assets: readonly AgentSessionDeliverable[];
  readonly publications: readonly AgentSessionDeliverable[];
} {
  return {
    assets: deliverables.filter((deliverable) => deliverable.kind === "asset"),
    publications: deliverables.filter((deliverable) => deliverable.kind !== "asset"),
  };
}

export type AgentSessionAssetLike = {
  readonly assetId: string;
  readonly createdAt?: string;
  readonly downloadUrl?: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly previewUrl?: string;
  readonly sizeBytes: number;
  readonly url?: string;
};

function assetToDeliverable(asset: AgentSessionAssetLike): AgentSessionDeliverable {
  return {
    createdAt: asset.createdAt ?? new Date(0).toISOString(),
    id: asset.assetId,
    kind: "asset",
    mediaType: asset.mediaType,
    sizeBytes: asset.sizeBytes,
    title: asset.filename,
    url: asset.previewUrl ?? asset.url ?? asset.downloadUrl ?? `/api/assets/${encodeURIComponent(asset.assetId)}`,
  };
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

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
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
