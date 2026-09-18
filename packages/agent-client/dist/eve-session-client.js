import { Client, } from "eve/client";
import { AGENT_SESSION_CONTRACT_VERSION, } from "@oworker/open-agent-contracts/agent-session";
export const EVE_AGENT_SESSION_ADAPTER_VERSION = "0.1.0-alpha.9";
/**
 * Default interactive-session adapter for Eve 0.56.x.
 *
 * The returned surface contains no Eve classes or event types. Hosts persist
 * the AgentSession cursor and can replace this adapter without changing UI
 * ownership or thread storage.
 */
export function createEveAgentSessionClient(options) {
    const client = new Client({
        auth: { bearer: options.getAccessToken },
        headers: options.headers,
        host: normalizeBaseUrl(options.baseUrl),
        redirect: options.redirect ?? "error",
    });
    return {
        session(cursor) {
            return new EveAgentSession(client, cursor);
        },
    };
}
class EveAgentSession {
    client;
    sessionHandle;
    constructor(client, cursor) {
        this.client = client;
        validateCursor(cursor);
        if (cursor?.sessionId) {
            this.sessionHandle = client.sessions.attach(cursor.sessionId, {
                streamIndex: cursor.eventCursor,
            });
        }
    }
    get cursor() {
        return this.sessionHandle
            ? fromEveCursor(this.sessionHandle.state)
            : { eventCursor: 0 };
    }
    async send(input) {
        const startCursor = this.cursor.eventCursor;
        const payload = toEveSendInput(input);
        let response;
        if (!this.sessionHandle) {
            if ("inputResponses" in payload) {
                throw new Error("An active Agent session is required to answer an input request.");
            }
            const created = await this.client.sessions.create({
                message: toEveMessage(payload.message),
                ...payload.options,
            });
            this.sessionHandle = created.session;
            response = created.response;
        }
        else if ("inputResponses" in payload) {
            response = await this.sessionHandle.respond(payload.inputResponses, payload.options);
        }
        else {
            response = await this.sessionHandle.send(toEveMessage(payload.message), payload.options);
        }
        return new EveAgentSessionTurn(response, startCursor);
    }
    async *stream(options) {
        if (!this.sessionHandle)
            return;
        let cursor = options?.after ?? this.cursor.eventCursor;
        if (!Number.isSafeInteger(cursor) || cursor < 0) {
            throw new RangeError("Agent session event cursor must be a non-negative safe integer.");
        }
        for await (const event of this.sessionHandle.stream({
            follow: options?.follow,
            signal: options?.signal,
            startIndex: cursor,
        })) {
            cursor += 1;
            yield projectSessionEvent(event, cursor);
        }
    }
    async cancel(options) {
        return this.sessionHandle?.cancel(options) ?? { status: "no_active_turn" };
    }
    async reset() {
        if (!this.sessionHandle)
            return { status: "no_active_session" };
        const result = await this.sessionHandle.reset();
        if (result.status === "reset")
            this.sessionHandle = undefined;
        return result;
    }
}
class EveAgentSessionTurn {
    response;
    startCursor;
    sessionId;
    consumed = false;
    constructor(response, startCursor) {
        this.response = response;
        this.startCursor = startCursor;
        this.sessionId = response.sessionId;
    }
    async result() {
        this.assertUnconsumed();
        this.consumed = true;
        const result = await this.response.result();
        return {
            data: result.data,
            events: result.events.map((event, index) => projectSessionEvent(event, this.startCursor + index + 1)),
            inputRequests: result.inputRequests,
            message: result.message,
            sessionId: result.sessionId,
            status: result.status,
        };
    }
    async *[Symbol.asyncIterator]() {
        this.assertUnconsumed();
        this.consumed = true;
        let cursor = this.startCursor;
        for await (const event of this.response) {
            cursor += 1;
            yield projectSessionEvent(event, cursor);
        }
    }
    assertUnconsumed() {
        if (this.consumed)
            throw new Error("AgentSessionTurn has already been consumed.");
    }
}
function validateCursor(cursor) {
    if (!cursor)
        return undefined;
    if (!Number.isSafeInteger(cursor.eventCursor) || cursor.eventCursor < 0) {
        throw new RangeError("Agent session event cursor must be a non-negative safe integer.");
    }
}
function fromEveCursor(cursor) {
    return {
        sessionId: cursor.sessionId,
        eventCursor: cursor.streamIndex,
    };
}
function toEveSendInput(input) {
    if (typeof input === "string")
        return { message: input };
    const options = {
        ...(input.clientContext === undefined ? {} : { clientContext: input.clientContext }),
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    if (input.inputResponses)
        return { inputResponses: input.inputResponses, options };
    if (input.message === undefined)
        throw new Error("Agent session input requires a message or input response.");
    return { message: input.message, options };
}
function toEveMessage(message) {
    return typeof message === "string"
        ? message
        : [...message];
}
function projectSessionEvent(event, cursor) {
    const candidate = event;
    return {
        contractVersion: AGENT_SESSION_CONTRACT_VERSION,
        cursor,
        ...(candidate.data === undefined ? {} : { data: candidate.data }),
        ...(candidate.meta === undefined ? {} : { meta: candidate.meta }),
        type: candidate.type,
    };
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
//# sourceMappingURL=eve-session-client.js.map