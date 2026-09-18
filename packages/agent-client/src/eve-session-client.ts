import {
  Client,
  type ClientSession,
  type MessageStreamEvent,
  type MessageResponse,
  type SendTurnOptions,
} from "eve/client";
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
import type { JsonValue } from "@oworker/open-agent-contracts/agent-run";
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

/**
 * Default interactive-session adapter for Eve 0.56.x.
 *
 * The returned surface contains no Eve classes or event types. Hosts persist
 * the AgentSession cursor and can replace this adapter without changing UI
 * ownership or thread storage.
 */
export function createEveAgentSessionClient(options: AgentSessionClientOptions): AgentSessionClient {
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

class EveAgentSession implements AgentSession {
  private sessionHandle: ClientSession | undefined;

  constructor(
    private readonly client: Client,
    cursor?: AgentSessionCursor,
  ) {
    validateCursor(cursor);
    if (cursor?.sessionId) {
      this.sessionHandle = client.sessions.attach(cursor.sessionId, {
        streamIndex: cursor.eventCursor,
      });
    }
  }

  get cursor(): AgentSessionCursor {
    return this.sessionHandle
      ? fromEveCursor(this.sessionHandle.state)
      : { eventCursor: 0 };
  }

  async send<TOutput = unknown>(input: AgentSessionSendInput): Promise<AgentSessionTurn<TOutput>> {
    const startCursor = this.cursor.eventCursor;
    const payload = toEveSendInput<TOutput>(input);
    let response: MessageResponse<TOutput>;
    if (!this.sessionHandle) {
      if ("inputResponses" in payload) {
        throw new Error("An active Agent session is required to answer an input request.");
      }
      const created = await this.client.sessions.create<TOutput>({
        message: toEveMessage(payload.message),
        ...payload.options,
      });
      this.sessionHandle = created.session;
      response = created.response;
    } else if ("inputResponses" in payload) {
      response = await this.sessionHandle.respond<TOutput>(payload.inputResponses, payload.options);
    } else {
      response = await this.sessionHandle.send<TOutput>(toEveMessage(payload.message), payload.options);
    }
    return new EveAgentSessionTurn<TOutput>(response, startCursor);
  }

  async *stream(options?: AgentSessionStreamOptions): AsyncIterable<AgentSessionEvent> {
    if (!this.sessionHandle) return;
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

  async cancel(options?: { readonly turnId?: string }): Promise<AgentSessionCancellation> {
    return this.sessionHandle?.cancel(options) ?? { status: "no_active_turn" };
  }

  async reset(): Promise<AgentSessionReset> {
    if (!this.sessionHandle) return { status: "no_active_session" };
    const result = await this.sessionHandle.reset();
    if (result.status === "reset") this.sessionHandle = undefined;
    return result;
  }
}

class EveAgentSessionTurn<TOutput> implements AgentSessionTurn<TOutput> {
  readonly sessionId: string;
  private consumed = false;

  constructor(
    private readonly response: MessageResponse<TOutput>,
    private readonly startCursor: number,
  ) {
    this.sessionId = response.sessionId;
  }

  async result(): Promise<AgentSessionTurnResult<TOutput>> {
    this.assertUnconsumed();
    this.consumed = true;
    const result = await this.response.result();
    return {
      data: result.data,
      events: result.events.map((event, index) => projectSessionEvent(event, this.startCursor + index + 1)),
      inputRequests: result.inputRequests as readonly AgentSessionInputRequest[],
      message: result.message,
      sessionId: result.sessionId,
      status: result.status,
    };
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentSessionEvent> {
    this.assertUnconsumed();
    this.consumed = true;
    let cursor = this.startCursor;
    for await (const event of this.response) {
      cursor += 1;
      yield projectSessionEvent(event, cursor);
    }
  }

  private assertUnconsumed() {
    if (this.consumed) throw new Error("AgentSessionTurn has already been consumed.");
  }
}

function validateCursor(cursor: AgentSessionCursor | undefined) {
  if (!cursor) return undefined;
  if (!Number.isSafeInteger(cursor.eventCursor) || cursor.eventCursor < 0) {
    throw new RangeError("Agent session event cursor must be a non-negative safe integer.");
  }
}

function fromEveCursor(cursor: ClientSession["state"]): AgentSessionCursor {
  return {
    sessionId: cursor.sessionId,
    eventCursor: cursor.streamIndex,
  };
}

type EveSendInput<TOutput> =
  | { readonly inputResponses: NonNullable<AgentSessionSendPayload["inputResponses"]>; readonly options?: SendTurnOptions<TOutput> }
  | { readonly message: string | NonNullable<AgentSessionSendPayload["message"]>; readonly options?: SendTurnOptions<TOutput> };

function toEveSendInput<TOutput>(input: AgentSessionSendInput): EveSendInput<TOutput> {
  if (typeof input === "string") return { message: input };
  const options = {
    ...(input.clientContext === undefined ? {} : { clientContext: input.clientContext }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  } as SendTurnOptions<TOutput>;
  if (input.inputResponses) return { inputResponses: input.inputResponses, options };
  if (input.message === undefined) throw new Error("Agent session input requires a message or input response.");
  return { message: input.message, options };
}

function toEveMessage(
  message: NonNullable<AgentSessionSendPayload["message"]>,
): Parameters<ClientSession["send"]>[0] {
  return typeof message === "string"
    ? message
    : [...message] as Parameters<ClientSession["send"]>[0];
}

function projectSessionEvent(event: MessageStreamEvent, cursor: number): AgentSessionEvent {
  const candidate = event as unknown as { readonly data?: JsonValue; readonly meta?: JsonValue; readonly type: string };
  return {
    contractVersion: AGENT_SESSION_CONTRACT_VERSION,
    cursor,
    ...(candidate.data === undefined ? {} : { data: candidate.data }),
    ...(candidate.meta === undefined ? {} : { meta: candidate.meta }),
    type: candidate.type,
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
