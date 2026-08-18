export async function loadSessionDeliverables({ client, endpoint = "/api/deliverables", fetcher = fetch, sessionId, signal, }) {
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
    if (!response.ok)
        throw new Error(`Deliverable list failed (${response.status}).`);
    return parseSessionDeliverables(await response.json());
}
export function resolveSessionDeliverableEndpoint(endpoint, sessionId) {
    if (typeof endpoint === "function")
        return endpoint(sessionId);
    const encoded = encodeURIComponent(sessionId);
    if (endpoint.includes("{sessionId}"))
        return endpoint.replaceAll("{sessionId}", encoded);
    if (endpoint.includes(":sessionId"))
        return endpoint.replaceAll(":sessionId", encoded);
    return `${endpoint}${endpoint.includes("?") ? "&" : "?"}sessionId=${encoded}`;
}
export function parseSessionDeliverables(payload) {
    const values = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.deliverables)
            ? payload.deliverables
            : [];
    const deliverables = [];
    for (const value of values.slice(0, 400)) {
        if (!isRecord(value))
            continue;
        const id = boundedText(value.id, 512);
        const kind = value.kind;
        const title = boundedText(value.title, 255);
        const createdAt = boundedText(value.createdAt, 64);
        const url = safeResourceUrl(value.url);
        const sizeBytes = typeof value.sizeBytes === "number" && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0
            ? value.sizeBytes
            : undefined;
        if (!id || !title || !createdAt || !url || sizeBytes === undefined || !isDeliverableKind(kind))
            continue;
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
export function mergeSessionDeliverables(deliverables, assets) {
    const merged = new Map();
    for (const deliverable of deliverables ?? []) {
        merged.set(`${deliverable.kind}:${deliverable.id}`, deliverable);
    }
    for (const asset of assets) {
        const deliverable = assetToDeliverable(asset);
        const key = `${deliverable.kind}:${deliverable.id}`;
        if (!merged.has(key))
            merged.set(key, deliverable);
    }
    return [...merged.values()];
}
function assetToDeliverable(asset) {
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
function isDeliverableKind(value) {
    return value === "artifact" || value === "asset" || value === "website-preview";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedText(value, maxLength) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength ? value.trim() : undefined;
}
function safeResourceUrl(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096)
        return undefined;
    if (value.startsWith("/") && !value.startsWith("//"))
        return value;
    try {
        const parsed = new URL(value, typeof window !== "undefined" ? window.location.origin : "http://localhost");
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=session-deliverables.js.map