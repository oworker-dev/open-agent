import { AGENT_RUN_CONTRACT_VERSION, } from "@oworker/open-agent-contracts/agent-run";
export const AGENT_CLIENT_VERSION = "0.1.0-alpha.9";
export const AGENT_HOST_SDK_VERSION = "0.1.0-draft";
export function createAgentRunClient(options) {
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") {
        throw new Error("A Fetch API implementation is required.");
    }
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    async function request(path, init) {
        const accessToken = await options.getAccessToken();
        if (!accessToken.trim())
            throw new Error("Agent access token is empty.");
        const configuredHeaders = await resolveHeaders(options.headers);
        const response = await fetchImplementation(`${baseUrl}${path}`, {
            ...init,
            headers: {
                accept: "application/json",
                ...configuredHeaders,
                ...init?.headers,
                authorization: `Bearer ${accessToken}`,
                ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
            },
            redirect: options.redirect ?? "error",
        });
        const body = await response.json().catch(() => undefined);
        if (!response.ok) {
            throw new AgentClientHttpError(response.status, errorMessage(body) ?? `Agent service request failed with status ${response.status}.`, body);
        }
        return body;
    }
    return {
        async start(input, requestOptions) {
            const body = await request("/api/agent/runs", {
                body: JSON.stringify(input),
                method: "POST",
                signal: requestOptions?.signal,
            });
            if (!isRecord(body) || (body.disposition !== "started" && body.disposition !== "replayed")) {
                throw contractError("start", body);
            }
            return { disposition: body.disposition, run: parseRunSnapshot(body.run, "start") };
        },
        async inspect(runId, requestOptions) {
            const body = await request(`/api/agent/runs/${encodeURIComponent(validRunId(runId))}`, {
                signal: requestOptions?.signal,
            });
            if (!isRecord(body))
                throw contractError("inspect", body);
            return parseRunSnapshot(body.run, "inspect");
        },
        async events(runId, after = 0, requestOptions) {
            if (!Number.isSafeInteger(after) || after < 0) {
                throw new RangeError("Agent event cursor must be a non-negative safe integer.");
            }
            const body = await request(`/api/agent/runs/${encodeURIComponent(validRunId(runId))}/events?after=${encodeURIComponent(String(after))}`, { signal: requestOptions?.signal });
            if (!isRecord(body) || !Array.isArray(body.events) || !Number.isSafeInteger(body.nextCursor)) {
                throw contractError("events", body);
            }
            const run = parseRunSnapshot(body.run, "events");
            const events = body.events.map((event) => parseAgentEvent(event, run.runId));
            return { events, nextCursor: body.nextCursor, run };
        },
        async respond(runId, input, requestOptions) {
            const body = await request(`/api/agent/runs/${encodeURIComponent(validRunId(runId))}/input`, {
                body: JSON.stringify(input),
                method: "POST",
                signal: requestOptions?.signal,
            });
            if (!isRecord(body) || body.disposition !== "accepted" && body.disposition !== "replayed") {
                throw contractError("respond", body);
            }
            return { disposition: body.disposition, run: parseRunSnapshot(body.run, "respond") };
        },
        async cancel(runId, requestOptions) {
            const body = await request(`/api/agent/runs/${encodeURIComponent(validRunId(runId))}`, {
                method: "DELETE",
                signal: requestOptions?.signal,
            });
            if (!isRecord(body) ||
                body.cancellation !== "accepted" &&
                    body.cancellation !== "already_requested" &&
                    body.cancellation !== "no_active_turn" &&
                    body.cancellation !== "terminal") {
                throw contractError("cancel", body);
            }
            return { cancellation: body.cancellation, run: parseRunSnapshot(body.run, "cancel") };
        },
    };
}
export class AgentClientHttpError extends Error {
    status;
    body;
    constructor(status, message, body) {
        super(message);
        this.name = "AgentClientHttpError";
        this.status = status;
        this.body = body;
    }
}
function normalizeBaseUrl(value) {
    const normalized = value.trim().replace(/\/+$/, "");
    if (!normalized)
        throw new Error("Agent service base URL is required.");
    let url;
    try {
        url = new URL(normalized);
    }
    catch {
        throw new Error("Agent service base URL must be an absolute HTTP(S) URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Agent service base URL must use HTTP or HTTPS.");
    }
    return normalized;
}
async function resolveHeaders(headers) {
    return typeof headers === "function" ? await headers() : headers ?? {};
}
function validRunId(runId) {
    const normalized = runId.trim();
    if (!normalized || normalized.length > 200)
        throw new Error("Agent run ID is invalid.");
    return normalized;
}
function parseRunSnapshot(value, operation) {
    if (!isRecord(value) ||
        value.contractVersion !== AGENT_RUN_CONTRACT_VERSION ||
        typeof value.runId !== "string" ||
        typeof value.status !== "string" ||
        typeof value.correlationId !== "string" ||
        !Number.isSafeInteger(value.eventCount) ||
        !Number.isSafeInteger(value.revision) ||
        !isRecord(value.usage)) {
        throw contractError(operation, value);
    }
    return value;
}
function parseAgentEvent(value, runId) {
    if (!isRecord(value) ||
        value.contractVersion !== AGENT_RUN_CONTRACT_VERSION ||
        value.runId !== runId ||
        !Number.isSafeInteger(value.sequence) ||
        typeof value.type !== "string" ||
        !isRecord(value.data)) {
        throw contractError("events", value);
    }
    return value;
}
function contractError(operation, body) {
    return new AgentClientContractError(`Agent service ${operation} response does not match contract ${AGENT_RUN_CONTRACT_VERSION}.`, body);
}
export class AgentClientContractError extends Error {
    body;
    constructor(message, body) {
        super(message);
        this.name = "AgentClientContractError";
        this.body = body;
    }
}
function errorMessage(body) {
    if (!isRecord(body))
        return undefined;
    if (typeof body.message === "string" && body.message.trim())
        return body.message;
    if (typeof body.error === "string" && body.error.trim())
        return body.error;
    return undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=agent-run-client.js.map