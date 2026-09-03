import type {
  AgentMailboxReceipt,
  AgentWorkspaceMailbox,
} from "./contracts.js";

export type HttpAgentMailboxOptions = {
  readonly endpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly getAccessToken?: () => string | Promise<string>;
  readonly sessionEndpoint?: string;
};

export class AgentMailboxHttpError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "AgentMailboxHttpError";
    this.status = status;
    this.code = code;
  }
}

export function createHttpAgentMailbox(options: HttpAgentMailboxOptions): AgentWorkspaceMailbox {
  const endpoint = (options.endpoint ?? "/api/agent/mailbox").replace(/\/$/, "");
  const sessionEndpoint = (
    options.sessionEndpoint ?? endpoint.replace(/\/mailbox$/, "/sessions")
  ).replace(/\/$/, "");
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    async enqueue(input) {
      return await mutate(fetchImplementation, options, endpoint, {
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    },
    async inspect(itemId) {
      return await mutate(fetchImplementation, options, itemUrl(endpoint, itemId));
    },
    async cancel(itemId) {
      return await mutate(fetchImplementation, options, itemUrl(endpoint, itemId), {
        method: "DELETE",
      });
    },
    async cancelSession(input) {
      const result = await mutateSession(fetchImplementation, options, sessionEndpoint, input.sessionId, {
        body: JSON.stringify({
          action: "cancel",
          ...(input.turnId ? { turnId: input.turnId } : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (result.status !== "accepted" && result.status !== "no_active_turn") {
        throw new Error("Agent session cancellation returned an invalid status.");
      }
      return result.status;
    },
    async retry(itemId) {
      return await mutate(fetchImplementation, options, itemUrl(endpoint, itemId), {
        method: "PATCH",
      });
    },
  };
}

async function mutateSession(
  fetchImplementation: typeof globalThis.fetch,
  options: HttpAgentMailboxOptions,
  endpoint: string,
  sessionId: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const accessToken = await options.getAccessToken?.();
  if (accessToken !== undefined && !accessToken.trim()) {
    throw new Error("Agent mailbox access token is empty.");
  }
  const response = await fetchImplementation(`${endpoint}/${encodeURIComponent(sessionId)}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...init.headers,
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    redirect: "error",
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new AgentMailboxHttpError(
      response.status,
      typeof body.error === "string"
        ? body.error
        : `Agent session request failed with status ${response.status}.`,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  return body;
}

async function mutate(
  fetchImplementation: typeof globalThis.fetch,
  options: HttpAgentMailboxOptions,
  url: string,
  init?: RequestInit,
): Promise<AgentMailboxReceipt> {
  const accessToken = await options.getAccessToken?.();
  if (accessToken !== undefined && !accessToken.trim()) {
    throw new Error("Agent mailbox access token is empty.");
  }
  const response = await fetchImplementation(url, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...init?.headers,
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    redirect: "error",
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new AgentMailboxHttpError(
      response.status,
      typeof body.error === "string"
        ? body.error
        : `Agent mailbox request failed with status ${response.status}.`,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  const item = body.item;
  if (
    !isRecord(item) ||
    typeof item.clientMessageId !== "string" ||
    typeof item.itemId !== "string" ||
    !isMailboxStatus(item.status)
  ) throw new Error("Agent mailbox returned an invalid item.");
  return {
    clientMessageId: item.clientMessageId,
    itemId: item.itemId,
    ...(typeof item.lastError === "string" ? { lastError: item.lastError } : {}),
    status: item.status,
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function itemUrl(endpoint: string, itemId: string): string {
  return `${endpoint}/${encodeURIComponent(itemId)}`;
}

function isMailboxStatus(value: unknown): value is AgentMailboxReceipt["status"] {
  return value === "accepted" || value === "cancelled" || value === "committed" ||
    value === "delivering" || value === "failed" || value === "queued" ||
    value === "submission-ambiguous";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
