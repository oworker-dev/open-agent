import { createHash } from "node:crypto";
import type {
  AgentMailboxItem,
  AgentMailboxPayload,
  AgentMailboxStore,
  EnqueueAgentMailboxResult,
} from "../data/agent-mailbox-store.ts";
import type { AgentSessionOwner } from "../data/session-ownership-store.ts";

const DEFAULT_BUSY_RETRY_MS = 2_000;

export type AgentMailboxBoundary =
  | { readonly state: "running"; readonly turnId?: string }
  | { readonly state: "waiting" }
  | { readonly state: "terminal" };

export interface AgentMailboxRuntime {
  deliver(input: {
    readonly clientMessageId: string;
    readonly itemId: string;
    readonly owner: AgentSessionOwner;
    readonly payload: AgentMailboxPayload;
    readonly sessionId: string;
  }): Promise<{ readonly sessionId: string }>;
  inspect(input: {
    readonly owner: AgentSessionOwner;
    readonly sessionId: string;
  }): Promise<AgentMailboxBoundary>;
}

export type DispatchAgentMailboxResult =
  | { readonly status: "idle" }
  | { readonly item: AgentMailboxItem; readonly status: "accepted" | "deferred" | "failed" | "submission-ambiguous" };

export class AgentMailboxAdmissionError extends Error {
  readonly disposition: "ambiguous" | "rejected";

  constructor(disposition: "ambiguous" | "rejected", message: string) {
    super(message);
    this.name = "AgentMailboxAdmissionError";
    this.disposition = disposition;
  }
}

export async function enqueueAgentMailboxMessage(options: {
  readonly clientMessageId: string;
  readonly clientContext?: AgentMailboxPayload["clientContext"];
  readonly message: string;
  readonly owner: AgentSessionOwner;
  readonly preferences?: AgentMailboxPayload["preferences"];
  readonly sessionId: string;
  readonly store: AgentMailboxStore;
}): Promise<EnqueueAgentMailboxResult> {
  const clientMessageId = parseClientMessageId(options.clientMessageId);
  const sessionId = parseSessionId(options.sessionId);
  const message = parseMessage(options.message);
  const payload = {
    ...(options.clientContext ? { clientContext: options.clientContext } : {}),
    message,
    ...(options.preferences ? { preferences: options.preferences } : {}),
  } as const;
  return await options.store.enqueue({
    clientMessageId,
    owner: options.owner,
    payload,
    payloadFingerprint: mailboxPayloadFingerprint(sessionId, payload),
    sessionId,
  });
}

export async function dispatchNextAgentMailboxMessage(options: {
  readonly busyRetryMs?: number;
  readonly leaseMs?: number;
  readonly now?: () => number;
  readonly runtime: AgentMailboxRuntime;
  readonly store: AgentMailboxStore;
}): Promise<DispatchAgentMailboxResult> {
  const item = await options.store.claimNext({ leaseMs: options.leaseMs });
  if (!item) return { status: "idle" };
  const claimToken = item.claimToken;
  if (!claimToken) {
    throw new Error("The Agent mailbox store returned a delivery lease without a claim token.");
  }
  const owner = ownerFromItem(item);

  let boundary: AgentMailboxBoundary;
  try {
    boundary = await options.runtime.inspect({ owner, sessionId: item.sessionId });
  } catch (error) {
    const deferred = await options.store.defer(
      item.itemId,
      claimToken,
      nextAttemptAt(options.now, options.busyRetryMs),
      safeErrorMessage(error, "The Agent session boundary could not be inspected."),
    );
    return { item: deferred, status: "deferred" };
  }

  if (boundary.state === "running" && !boundary.turnId) {
    const deferred = await options.store.defer(
      item.itemId,
      claimToken,
      nextAttemptAt(options.now, options.busyRetryMs),
    );
    return { item: deferred, status: "deferred" };
  }
  if (boundary.state === "terminal") {
    const failed = await options.store.fail(
      item.itemId,
      claimToken,
      "The Agent session became terminal before this queued message could be delivered.",
    );
    return { item: failed, status: "failed" };
  }

  try {
    await options.store.beginAdmission(item.itemId, claimToken);
    const delivered = await options.runtime.deliver({
      clientMessageId: item.clientMessageId,
      itemId: item.itemId,
      owner,
      payload: item.payload,
      sessionId: item.sessionId,
    });
    const accepted = await options.store.accept(item.itemId, claimToken, delivered.sessionId);
    return { item: accepted, status: "accepted" };
  } catch (error) {
    const current = await options.store.findOwned(owner, item.itemId);
    if (current?.status === "committed") {
      return { item: current, status: "accepted" };
    }
    if (error instanceof AgentMailboxAdmissionError && error.disposition === "rejected") {
      const failed = await options.store.fail(item.itemId, claimToken, error.message);
      return { item: failed, status: "failed" };
    }
    const ambiguous = await options.store.markSubmissionAmbiguous(
      item.itemId,
      claimToken,
      safeErrorMessage(
        error,
        "The Agent runtime may have accepted this message, so it will not be retried automatically.",
      ),
    );
    return { item: ambiguous, status: "submission-ambiguous" };
  }
}

export function mailboxPayloadFingerprint(
  sessionId: string,
  payload: AgentMailboxPayload,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ payload, sessionId }))
    .digest("base64url");
}

function ownerFromItem(item: AgentMailboxItem): AgentSessionOwner {
  return {
    ...(item.issuer ? { issuer: item.issuer } : {}),
    principalId: item.principalId,
    principalType: item.principalType,
    tenantId: item.tenantId,
  };
}

function parseClientMessageId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(normalized)) {
    throw new Error("clientMessageId must contain 8 to 200 URL-safe identifier characters.");
  }
  return normalized;
}

function parseSessionId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) {
    throw new Error("sessionId must contain between 1 and 512 characters.");
  }
  return normalized;
}

function parseMessage(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 65_536) {
    throw new Error("message must contain between 1 and 65536 characters.");
  }
  return normalized;
}

function nextAttemptAt(now: (() => number) | undefined, delay: number | undefined): string {
  const retryMs = delay ?? DEFAULT_BUSY_RETRY_MS;
  if (!Number.isInteger(retryMs) || retryMs < 250 || retryMs > 60_000) {
    throw new Error("busyRetryMs must be an integer from 250 to 60000.");
  }
  return new Date((now ?? Date.now)() + retryMs).toISOString();
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim().slice(0, 2_000)
    : fallback;
}
