import {
  Client,
  type ClientSession,
  type MessageContent,
  type SessionStreamEvent,
  type SendTurnOptions,
} from "eve/client";
import type { Answer } from "eve/events";
import type { Delivery } from "eve/sessions";
import {
  AGENT_SESSION_CONTRACT_VERSION,
  type AgentSessionCancellation,
  type AgentSessionCursor,
  type AgentSessionEvent,
  type AgentSessionInputRequest,
  type AgentSessionReset,
  type AgentSessionSendPayload,
  type AgentSessionTurnResult,
} from "@oworker/open-agent-contracts/agent-session";
import type { AgentClientHeaders } from "./agent-run-client.js";

export const EVE_AGENT_SESSION_ADAPTER_VERSION = "0.1.0-alpha.9" as const;

export type AgentSessionClientOptions = {
  readonly baseUrl: string;
  readonly getAccessToken: () => string | Promise<string>;
  readonly headers?: AgentClientHeaders;
  readonly redirect?: RequestRedirect;
};

export type AgentSessionSendInput =
  | string
  | (AgentSessionSendPayload & {
      readonly headers?: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
    });

export type AgentSessionStreamOptions = {
  readonly after?: number;
  readonly follow?: boolean;
  readonly signal?: AbortSignal;
};

export interface AgentSessionTurn<TOutput = unknown> extends AsyncIterable<AgentSessionEvent> {
  readonly sessionId: string;
  result(): Promise<AgentSessionTurnResult<TOutput>>;
}

export interface AgentSession {
  readonly cursor: AgentSessionCursor;
  send<TOutput = unknown>(input: AgentSessionSendInput): Promise<AgentSessionTurn<TOutput>>;
  stream(options?: AgentSessionStreamOptions): AsyncIterable<AgentSessionEvent>;
  cancel(options?: { readonly turnId?: string }): Promise<AgentSessionCancellation>;
  reset(): Promise<AgentSessionReset>;
}

export interface AgentSessionClient {
  session(cursor?: AgentSessionCursor): AgentSession;
}

/** Host-neutral adapter over Eve's ID-addressed v27 session and delivery API. */
export function createEveAgentSessionClient(options: AgentSessionClientOptions): AgentSessionClient {
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

class EveAgentSession implements AgentSession {
  private sessionHandle: ClientSession | undefined;

  constructor(private readonly client: Client, cursor?: AgentSessionCursor) {
    validateCursor(cursor);
    if (cursor?.sessionId) {
      this.sessionHandle = client.sessions.attach(cursor.sessionId, {
        ...(cursor.inbox ? { inbox: cursor.inbox } : {}),
        streamIndex: cursor.streamIndex,
      });
    }
  }

  get cursor(): AgentSessionCursor {
    return this.sessionHandle ? fromEveCursor(this.sessionHandle.state) : { streamIndex: 0 };
  }

  async send<TOutput = unknown>(input: AgentSessionSendInput): Promise<AgentSessionTurn<TOutput>> {
    const payload = toEveSendInput<TOutput>(input);
    let delivery: Delivery<TOutput>;
    if (!this.sessionHandle) {
      if ("answers" in payload) {
        throw new Error("An active Agent session is required to answer an interaction.");
      }
      const created = await this.client.sessions.create<TOutput>({
        message: payload.message,
        ...payload.options,
      });
      this.sessionHandle = created.session;
      delivery = created.delivery;
    } else if ("answers" in payload) {
      delivery = await this.sessionHandle.respond<TOutput>(payload.answers, payload.options);
    } else {
      delivery = await this.sessionHandle.send<TOutput>(payload.message, payload.options);
    }
    return new EveAgentSessionTurn(delivery);
  }

  async *stream(options?: AgentSessionStreamOptions): AsyncIterable<AgentSessionEvent> {
    if (!this.sessionHandle) return;
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

  async cancel(options?: { readonly turnId?: string }): Promise<AgentSessionCancellation> {
    if (!this.sessionHandle) return { status: "no_active_turn" };
    const delivery = await this.sessionHandle.cancel(options);
    return { sessionId: delivery.sessionId, status: "accepted" };
  }

  async reset(): Promise<AgentSessionReset> {
    if (!this.sessionHandle) return { status: "no_active_session" };
    const sessionId = this.sessionHandle.id;
    const delivery = await this.sessionHandle.reset();
    const result = await delivery.result();
    this.sessionHandle = undefined;
    return result.outcome === "applied"
      ? { previousSessionId: sessionId, status: "reset" }
      : { status: "no_active_session" };
  }
}

class EveAgentSessionTurn<TOutput> implements AgentSessionTurn<TOutput> {
  readonly sessionId: string;

  constructor(private readonly delivery: Delivery<TOutput>) {
    this.sessionId = delivery.sessionId;
  }

  async result(): Promise<AgentSessionTurnResult<TOutput>> {
    const events: AgentSessionEvent[] = [];
    for await (const event of this.delivery.stream()) events.push(projectSessionEvent(event));
    const result = await this.delivery.result();
    return {
      data: result.data,
      events,
      inputRequests: result.interactions as readonly AgentSessionInputRequest[],
      message: result.reply,
      sessionId: result.sessionId,
      status: result.status === "cancelled" ? "cancelled" :
        result.status === "failed" ? "failed" :
          result.status === "awaiting-input" ? "waiting" : "completed",
    };
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentSessionEvent> {
    for await (const event of this.delivery.stream()) yield projectSessionEvent(event);
  }
}

function validateCursor(cursor: AgentSessionCursor | undefined) {
  if (!cursor) return;
  validateLineCursor(cursor.streamIndex);
}

function validateLineCursor(cursor: number) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new RangeError("Agent session stream cursor must be a non-negative safe integer.");
  }
}

function fromEveCursor(cursor: ClientSession["state"]): AgentSessionCursor {
  return {
    ...(cursor.inbox ? { inbox: cursor.inbox } : {}),
    sessionId: cursor.sessionId,
    streamIndex: cursor.streamIndex,
  };
}

type EveSendInput<TOutput> =
  | { readonly answers: readonly Answer[]; readonly options?: SendTurnOptions<TOutput> }
  | { readonly message: MessageContent; readonly options?: SendTurnOptions<TOutput> };

function toEveSendInput<TOutput>(input: AgentSessionSendInput): EveSendInput<TOutput> {
  if (typeof input === "string") return { message: input };
  const options = {
    ...(input.clientContext === undefined ? {} : { clientContext: input.clientContext }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  } as SendTurnOptions<TOutput>;
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
  if (input.message === undefined) throw new Error("Agent session input requires a message or input response.");
  return {
    message: toEveMessage(input.message),
    options,
  };
}

function toEveMessage(message: NonNullable<AgentSessionSendPayload["message"]>): MessageContent {
  return typeof message === "string" ? message : message.map((part) => ({ ...part }));
}

function projectSessionEvent(event: SessionStreamEvent): AgentSessionEvent {
  const { position } = event.meta;
  const cursor = event.meta.next ?? (event.meta.endOfLine === false ? position.line : position.line + 1);
  return {
    contractVersion: AGENT_SESSION_CONTRACT_VERSION,
    cursor,
    data: event.data as AgentSessionEvent["data"],
    meta: event.meta as unknown as AgentSessionEvent["meta"],
    position,
    ...(event.scope ? { scope: event.scope } : {}),
    type: event.type,
  };
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("Agent service base URL is required.");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Agent service base URL must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Agent service base URL must use HTTP or HTTPS.");
  }
  return normalized;
}
