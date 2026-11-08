import { Client, } from "eve/client";
import { AGENT_SESSION_CONTRACT_VERSION, } from "@oworker/open-agent-contracts/agent-session";
export const EVE_AGENT_SESSION_ADAPTER_VERSION = "0.1.0-alpha.9";
/** Host-neutral adapter over Eve's ID-addressed v27 session and delivery API. */
export function createEveAgentSessionClient(options) {
    const client = new Client({
        auth: { bearer: options.getAccessToken },
        headers: options.headers,
        baseUrl: normalizeBaseUrl(options.baseUrl),
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
                ...(cursor.inbox ? { inbox: cursor.inbox } : {}),
                streamIndex: cursor.streamIndex,
            });
        }
    }
    get cursor() {
        return this.sessionHandle ? fromEveCursor(this.sessionHandle.state) : { streamIndex: 0 };
    }
    async send(input) {
        const payload = toEveSendInput(input);
        let delivery;
        if (!this.sessionHandle) {
            if ("answers" in payload) {
                throw new Error("An active Agent session is required to answer an interaction.");
            }
            const created = await this.client.sessions.create({
                message: payload.message,
                ...payload.options,
            });
            this.sessionHandle = created.session;
            delivery = created.delivery;
        }
        else if ("answers" in payload) {
            delivery = await this.sessionHandle.respond(payload.answers, payload.options);
        }
        else {
            delivery = await this.sessionHandle.send(payload.message, payload.options);
        }
        return new EveAgentSessionTurn(delivery);
    }
    async *stream(options) {
        if (!this.sessionHandle)
            return;
        const startIndex = options?.after ?? this.cursor.streamIndex;
        validateLineCursor(startIndex);
        for await (const event of this.sessionHandle.stream({
            follow: options?.follow,
            signal: options?.signal,
            startIndex,
        })) {
            yield projectSessionEvent(event);
        }
    }
    async cancel(options) {
        if (!this.sessionHandle)
            return { status: "no_active_turn" };
        const delivery = await this.sessionHandle.cancel(options);
        return { sessionId: delivery.sessionId, status: "accepted" };
    }
    async reset() {
        if (!this.sessionHandle)
            return { status: "no_active_session" };
        const sessionId = this.sessionHandle.id;
        const delivery = await this.sessionHandle.reset();
        const result = await delivery.result();
        this.sessionHandle = undefined;
        return result.outcome === "applied"
            ? { previousSessionId: sessionId, status: "reset" }
            : { status: "no_active_session" };
    }
}
class EveAgentSessionTurn {
    delivery;
    sessionId;
    constructor(delivery) {
        this.delivery = delivery;
        this.sessionId = delivery.sessionId;
    }
    async result() {
        const events = [];
        for await (const event of this.delivery.stream())
            events.push(projectSessionEvent(event));
        const result = await this.delivery.result();
        return {
            data: result.data,
            events,
            inputRequests: result.interactions,
            message: result.reply,
            sessionId: result.sessionId,
            status: result.status === "cancelled" ? "cancelled" :
                result.status === "failed" ? "failed" :
                    result.status === "awaiting-input" ? "waiting" : "completed",
        };
    }
    async *[Symbol.asyncIterator]() {
        for await (const event of this.delivery.stream())
            yield projectSessionEvent(event);
    }
}
function validateCursor(cursor) {
    if (!cursor)
        return;
    validateLineCursor(cursor.streamIndex);
}
function validateLineCursor(cursor) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new RangeError("Agent session stream cursor must be a non-negative safe integer.");
    }
}
function fromEveCursor(cursor) {
    return {
        ...(cursor.inbox ? { inbox: cursor.inbox } : {}),
        sessionId: cursor.sessionId,
        streamIndex: cursor.streamIndex,
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
    if (input.inputResponses) {
        return {
            answers: input.inputResponses.map((response) => ({
                interactionId: response.interactionId,
                ...(response.optionId === undefined ? {} : { optionId: response.optionId }),
                ...(response.text === undefined ? {} : { text: response.text }),
            })),
            options,
        };
    }
    if (input.message === undefined)
        throw new Error("Agent session input requires a message or input response.");
    return {
        message: toEveMessage(input.message),
        options,
    };
}
function toEveMessage(message) {
    return typeof message === "string" ? message : message.map((part) => ({ ...part }));
}
function projectSessionEvent(event) {
    const { position } = event.meta;
    const cursor = event.meta.next ?? (event.meta.endOfLine === false ? position.line : position.line + 1);
    return {
        contractVersion: AGENT_SESSION_CONTRACT_VERSION,
        cursor,
        data: event.data,
        meta: event.meta,
        position,
        ...(event.scope ? { scope: event.scope } : {}),
        type: event.type,
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