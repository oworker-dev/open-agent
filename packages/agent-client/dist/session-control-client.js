/**
 * Host-neutral HTTP control client.  Eve's stream client remains responsible
 * for the live runtime; this adapter owns durable history and mailbox control
 * routes exposed by the Open Agent host service.
 */
export function createAgentSessionControlClient(options, fetchImplementation = fetch) {
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    return {
        async history(sessionId, input) {
            const after = input?.after ?? 0;
            const limit = input?.limit ?? 200;
            assertCursor(after);
            assertLimit(limit);
            const url = new URL(`api/agent/sessions/${encodeURIComponent(assertSessionId(sessionId))}`, `${baseUrl}/`);
            url.searchParams.set("after", String(after));
            url.searchParams.set("limit", String(limit));
            const response = await request(fetchImplementation, options, url, {
                method: "GET",
                signal: input?.signal,
            });
            return await readJson(response);
        },
        async steer(sessionId, input) {
            const url = sessionUrl(baseUrl, sessionId);
            const response = await request(fetchImplementation, options, url, {
                body: JSON.stringify({ action: "steer", sessionId, ...input }),
                method: "POST",
            });
            return await readJson(response);
        },
        async cancel(sessionId) {
            const url = sessionUrl(baseUrl, sessionId);
            const response = await request(fetchImplementation, options, url, {
                body: JSON.stringify({ action: "cancel", sessionId }),
                method: "POST",
            });
            return await readJson(response);
        },
    };
}
async function request(fetchImplementation, options, url, init) {
    const token = await options.getAccessToken();
    const configuredHeaders = typeof options.headers === "function"
        ? await options.headers()
        : options.headers;
    const headers = new Headers(configuredHeaders);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined)
        headers.set("content-type", "application/json");
    const response = await fetchImplementation(url, {
        ...init,
        headers,
        redirect: options.redirect ?? "error",
    });
    return response;
}
async function readJson(response) {
    let value;
    try {
        value = await response.json();
    }
    catch {
        throw new Error(`Agent session control returned invalid JSON (HTTP ${response.status}).`);
    }
    if (!response.ok) {
        const message = isRecord(value) && typeof value.error === "string" ? value.error : `HTTP ${response.status}`;
        throw new Error(`Agent session control failed: ${message}`);
    }
    return value;
}
function sessionUrl(baseUrl, sessionId) {
    return new URL(`api/agent/sessions/${encodeURIComponent(assertSessionId(sessionId))}`, `${baseUrl}/`);
}
function assertSessionId(value) {
    const normalized = value.trim();
    if (!normalized || normalized.length > 512 || /\s/.test(normalized)) {
        throw new Error("sessionId must contain between 1 and 512 non-whitespace characters.");
    }
    return normalized;
}
function assertCursor(value) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError("after must be a non-negative safe integer.");
}
function assertLimit(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000)
        throw new RangeError("limit must be between 1 and 1000.");
}
function normalizeBaseUrl(value) {
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw new Error("Agent session control base URL must be an absolute HTTP(S) URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Agent session control base URL must use HTTP or HTTPS.");
    }
    return url.toString().replace(/\/$/, "");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=session-control-client.js.map