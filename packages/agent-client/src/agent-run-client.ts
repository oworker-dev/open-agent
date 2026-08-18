import {
  AGENT_RUN_CONTRACT_VERSION,
  type AgentEvent,
  type RespondAgentRunRequest,
  type AgentRunSnapshot,
  type StartAgentRunRequest,
} from "@oworker/open-agent-contracts/agent-run";

export const AGENT_CLIENT_VERSION = "0.1.0-alpha.9" as const;
export const AGENT_HOST_SDK_VERSION = "0.1.0-draft" as const;

export type AgentClientHeaders =
  | Readonly<Record<string, string>>
  | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>);

export type AgentRunClientOptions = {
  readonly baseUrl: string;
  readonly getAccessToken: () => string | Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: AgentClientHeaders;
  readonly redirect?: RequestRedirect;
};

export type AgentRunRequestOptions = {
  readonly signal?: AbortSignal;
};

export type AgentRunStartInput = Omit<StartAgentRunRequest, "idempotencyKey"> & {
  readonly idempotencyKey: string;
};

export type AgentRunStartResponse = {
  readonly disposition: "started" | "replayed";
  readonly run: AgentRunSnapshot;
};

export type AgentRunEventsResponse = {
  readonly events: readonly AgentEvent[];
  readonly nextCursor: number;
  readonly run: AgentRunSnapshot;
};

export type AgentRunCancelResponse = {
  readonly cancellation: "accepted" | "already_requested" | "no_active_turn" | "terminal";
  readonly run: AgentRunSnapshot;
};

export type AgentRunRespondResponse = {
  readonly disposition: "accepted" | "replayed";
  readonly run: AgentRunSnapshot;
};

export interface AgentRunClient {
  start(input: AgentRunStartInput, options?: AgentRunRequestOptions): Promise<AgentRunStartResponse>;
  inspect(runId: string, options?: AgentRunRequestOptions): Promise<AgentRunSnapshot>;
  events(runId: string, after?: number, options?: AgentRunRequestOptions): Promise<AgentRunEventsResponse>;
  respond(
    runId: string,
    input: RespondAgentRunRequest,
    options?: AgentRunRequestOptions,
  ): Promise<AgentRunRespondResponse>;
  cancel(runId: string, options?: AgentRunRequestOptions): Promise<AgentRunCancelResponse>;
}

export function createAgentRunClient(options: AgentRunClientOptions): AgentRunClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new Error("A Fetch API implementation is required.");
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl);

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const accessToken = await options.getAccessToken();
    if (!accessToken.trim()) throw new Error("Agent access token is empty.");
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
      throw new AgentClientHttpError(
        response.status,
        errorMessage(body) ?? `Agent service request failed with status ${response.status}.`,
        body,
      );
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
      if (!isRecord(body)) throw contractError("inspect", body);
      return parseRunSnapshot(body.run, "inspect");
    },
    async events(runId, after = 0, requestOptions) {
      if (!Number.isSafeInteger(after) || after < 0) {
        throw new RangeError("Agent event cursor must be a non-negative safe integer.");
      }
      const body = await request(
        `/api/agent/runs/${encodeURIComponent(validRunId(runId))}/events?after=${encodeURIComponent(String(after))}`,
        { signal: requestOptions?.signal },
      );
      if (!isRecord(body) || !Array.isArray(body.events) || !Number.isSafeInteger(body.nextCursor)) {
        throw contractError("events", body);
      }
      const run = parseRunSnapshot(body.run, "events");
      const events = body.events.map((event) => parseAgentEvent(event, run.runId));
      return { events, nextCursor: body.nextCursor as number, run };
    },
    async respond(runId, input, requestOptions) {
      const body = await request(
        `/api/agent/runs/${encodeURIComponent(validRunId(runId))}/input`,
        {
          body: JSON.stringify(input),
          method: "POST",
          signal: requestOptions?.signal,
        },
      );
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
      if (
        !isRecord(body) ||
        body.cancellation !== "accepted" &&
        body.cancellation !== "already_requested" &&
        body.cancellation !== "no_active_turn" &&
        body.cancellation !== "terminal"
      ) {
        throw contractError("cancel", body);
      }
      return { cancellation: body.cancellation, run: parseRunSnapshot(body.run, "cancel") };
    },
  };
}

export class AgentClientHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "AgentClientHttpError";
    this.status = status;
    this.body = body;
  }
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

async function resolveHeaders(headers: AgentClientHeaders | undefined) {
  return typeof headers === "function" ? await headers() : headers ?? {};
}

function validRunId(runId: string): string {
  const normalized = runId.trim();
  if (!normalized || normalized.length > 200) throw new Error("Agent run ID is invalid.");
  return normalized;
}

function parseRunSnapshot(value: unknown, operation: string): AgentRunSnapshot {
  if (
    !isRecord(value) ||
    value.contractVersion !== AGENT_RUN_CONTRACT_VERSION ||
    typeof value.runId !== "string" ||
    typeof value.status !== "string" ||
    typeof value.correlationId !== "string" ||
    !Number.isSafeInteger(value.eventCount) ||
    !Number.isSafeInteger(value.revision) ||
    !isRecord(value.usage)
  ) {
    throw contractError(operation, value);
  }
  return value as AgentRunSnapshot;
}

function parseAgentEvent(value: unknown, runId: string): AgentEvent {
  if (
    !isRecord(value) ||
    value.contractVersion !== AGENT_RUN_CONTRACT_VERSION ||
    value.runId !== runId ||
    !Number.isSafeInteger(value.sequence) ||
    typeof value.type !== "string" ||
    !isRecord(value.data)
  ) {
    throw contractError("events", value);
  }
  return value as AgentEvent;
}

function contractError(operation: string, body: unknown): AgentClientContractError {
  return new AgentClientContractError(
    `Agent service ${operation} response does not match contract ${AGENT_RUN_CONTRACT_VERSION}.`,
    body,
  );
}

export class AgentClientContractError extends Error {
  readonly body: unknown;

  constructor(message: string, body: unknown) {
    super(message);
    this.name = "AgentClientContractError";
    this.body = body;
  }
}

function errorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.message === "string" && body.message.trim()) return body.message;
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
