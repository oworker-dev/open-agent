import { createHash } from "node:crypto";
import type {
  AgentMailboxItem,
  AgentMailboxPayload,
  AgentMailboxStore,
  EnqueueAgentMailboxResult,
} from "../data/agent-mailbox-store.ts";
import type { MessageStreamEvent } from "eve/client";
import type { AgentSessionOwner } from "../data/session-ownership-store.ts";

const DEFAULT_BUSY_RETRY_MS = 2_000;

export type AgentMailboxBoundary =
  | { readonly lastEventAt?: string; readonly state: "running"; readonly tailIndex?: number; readonly turnId?: string }
  | { readonly state: "waiting"; readonly tailIndex?: number }
  | { readonly state: "terminal"; readonly tailIndex?: number; readonly terminalStatus?: "completed" | "failed" };

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
  /** Reads one finite authoritative Eve transcript without opening a live stream. */
  readTranscript?(input: {
    readonly sessionId: string;
    readonly startIndex: number;
  }): AsyncIterable<MessageStreamEvent>;
  /** Server-authorized lifecycle controls use the same signed runtime bridge. */
  cancel?(input: {
    readonly owner: AgentSessionOwner;
    readonly sessionId: string;
    readonly turnId?: string;
  }): Promise<"accepted" | "no_active_turn">;
  reset?(input: {
    readonly owner: AgentSessionOwner;
    readonly reason?: string;
    readonly sessionId: string;
  }): Promise<"no_active_session" | "reset">;
}

export type DispatchAgentMailboxResult =
  | { readonly status: "idle" }
  | { readonly item: AgentMailboxItem; readonly status: "accepted" | "cancelled" | "deferred" | "failed" | "submission-ambiguous" };

export class AgentMailboxAdmissionError extends Error {
  readonly disposition: "ambiguous" | "busy" | "rejected";

  constructor(disposition: "ambiguous" | "busy" | "rejected", message: string) {
    super(message);
    this.name = "AgentMailboxAdmissionError";
    this.disposition = disposition;
  }
}

export async function enqueueAgentMailboxMessage(options: {
  readonly beforeTurnId?: string;
  readonly clientMessageId: string;
  readonly clientContext?: AgentMailboxPayload["clientContext"];
  readonly expectedTurnId?: string;
  readonly inputResponses?: Extract<AgentMailboxPayload, { readonly inputResponses: unknown }>["inputResponses"];
  readonly operationId?: string;
  readonly operationKind?: "send" | "steer" | "edit" | "respond";
  readonly message?: string;
  readonly owner: AgentSessionOwner;
  readonly preferences?: AgentMailboxPayload["preferences"];
  readonly sessionId: string;
  readonly store: AgentMailboxStore;
}): Promise<EnqueueAgentMailboxResult> {
  const clientMessageId = parseClientMessageId(options.clientMessageId);
  const sessionId = parseSessionId(options.sessionId);
  const content = parseMailboxContent(options);
  const operation = parseOperation({
    beforeTurnId: options.beforeTurnId,
    expectedTurnId: options.expectedTurnId,
    operationId: options.operationId,
    operationKind: options.operationKind,
  });
  const payload = {
    ...(options.clientContext ? { clientContext: options.clientContext } : {}),
    ...content,
    ...(operation ? { operation } : {}),
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

  if (boundary.state === "running" && !canSteerBoundary(item, boundary)) {
    return await deferClaimedMessage({
      availableAt: nextAttemptAt(options.now, options.busyRetryMs),
      claimToken,
      item,
      owner,
      store: options.store,
    });
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
    // Normal messages are committed by the message.received hook. Structured
    // HITL responses resume the parked turn without that event, so the durable
    // 202 admission itself is their commit boundary.
    const committed = item.payload.operation?.kind === "respond"
      ? await options.store.commit(item.itemId, delivered.sessionId)
      : accepted;
    return { item: committed, status: "accepted" };
  } catch (error) {
    const current = await options.store.findOwned(owner, item.itemId);
    if (current?.status === "committed") {
      return { item: current, status: "accepted" };
    }
    if (error instanceof AgentMailboxAdmissionError && error.disposition === "rejected") {
      const failed = await options.store.fail(item.itemId, claimToken, error.message);
      return { item: failed, status: "failed" };
    }
    if (error instanceof AgentMailboxAdmissionError && error.disposition === "busy") {
      return await deferClaimedMessage({
        admissionWasRejected: true,
        availableAt: nextAttemptAt(options.now, options.busyRetryMs),
        claimToken,
        item,
        owner,
        reason: error.message,
        store: options.store,
      });
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

function canSteerBoundary(
  item: AgentMailboxItem,
  boundary: Extract<AgentMailboxBoundary, { readonly state: "running" }>,
): boolean {
  const operation = item.payload.operation;
  return operation?.kind === "steer" &&
    typeof operation.expectedTurnId === "string" &&
    operation.expectedTurnId === boundary.turnId;
}

async function deferClaimedMessage(options: {
  readonly admissionWasRejected?: boolean;
  readonly availableAt: string;
  readonly claimToken: string;
  readonly item: AgentMailboxItem;
  readonly owner: AgentSessionOwner;
  readonly reason?: string;
  readonly store: AgentMailboxStore;
}): Promise<DispatchAgentMailboxResult> {
  try {
    const deferred = options.admissionWasRejected
      ? await options.store.deferRejectedAdmission(
          options.item.itemId,
          options.claimToken,
          options.availableAt,
          options.reason,
        )
      : await options.store.defer(
          options.item.itemId,
          options.claimToken,
          options.availableAt,
          options.reason,
        );
    return { item: deferred, status: "deferred" };
  } catch (error) {
    const current = await options.store.findOwned(options.owner, options.item.itemId);
    if (current?.status === "cancelled") return { item: current, status: "cancelled" };
    throw error;
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

function parseMailboxContent(options: {
  readonly inputResponses?: readonly import("eve/client").InputResponse[];
  readonly message?: string;
  readonly operationKind?: "send" | "steer" | "edit" | "respond";
}): Pick<Extract<AgentMailboxPayload, { readonly message: string }>, "message"> |
  Pick<Extract<AgentMailboxPayload, { readonly inputResponses: unknown }>, "inputResponses"> {
  if (options.operationKind === "respond") {
    if (options.message !== undefined) throw new Error("A respond operation cannot contain a message.");
    const inputResponses = options.inputResponses;
    if (!inputResponses || inputResponses.length < 1 || inputResponses.length > 16) {
      throw new Error("A respond operation requires between 1 and 16 input responses.");
    }
    return { inputResponses };
  }
  if (options.inputResponses !== undefined) {
    throw new Error("inputResponses requires operationKind respond.");
  }
  return { message: parseMessage(options.message ?? "") };
}

function parseOperation(input: {
  readonly beforeTurnId?: string;
  readonly expectedTurnId?: string;
  readonly operationId?: string;
  readonly operationKind?: "send" | "steer" | "edit" | "respond";
}): NonNullable<AgentMailboxPayload["operation"]> | undefined {
  if (input.operationId === undefined && input.operationKind === undefined && input.expectedTurnId === undefined && input.beforeTurnId === undefined) {
    return undefined;
  }
  if (input.operationId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(input.operationId)) {
    throw new Error("operationId must contain 8 to 200 URL-safe identifier characters.");
  }
  if (input.operationKind === undefined) {
    throw new Error("operationKind is required when operationId is provided.");
  }
  if (input.operationKind === "steer" && input.expectedTurnId === undefined) {
    throw new Error("expectedTurnId is required for a steering operation.");
  }
  if (input.operationKind === "edit" && input.beforeTurnId === undefined) {
    throw new Error("beforeTurnId is required for an edit operation.");
  }
  if (input.operationKind === "respond" &&
      (input.expectedTurnId !== undefined || input.beforeTurnId !== undefined)) {
    throw new Error("A respond operation cannot target an edit or steering boundary.");
  }
  if (input.expectedTurnId !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(input.expectedTurnId)) {
    throw new Error("expectedTurnId must contain up to 512 URL-safe identifier characters.");
  }
  if (input.beforeTurnId !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(input.beforeTurnId)) {
    throw new Error("beforeTurnId must contain up to 512 URL-safe identifier characters.");
  }
  return {
    ...(input.beforeTurnId ? { beforeTurnId: input.beforeTurnId } : {}),
    ...(input.expectedTurnId ? { expectedTurnId: input.expectedTurnId } : {}),
    kind: input.operationKind,
    operationId: input.operationId,
  };
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
