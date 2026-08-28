import { createHash, randomUUID } from "node:crypto";
import type { MessageStreamEvent } from "eve/client";
import {
  AGENT_SESSION_CONTRACT_VERSION,
  type AgentSessionEvent,
  type AgentSessionHistory,
  type AgentSessionSnapshot,
} from "@oworker/open-agent-contracts/agent-session";
import type { EveResetStatus } from "../agent-runs/eve-adapter.ts";
import { readEveAgentEvents } from "../agent-runs/eve-adapter.ts";
import type { AgentSessionOwner, AgentSessionOwnershipStore } from "../data/session-ownership-store.ts";
import type { SandboxDeletionRecord, SandboxDeletionStore } from "../data/sandbox-deletion-store.ts";
import { createEveAgentMailboxRuntime } from "../agent-mailbox/eve-runtime.ts";

export type AgentSessionDeletionRuntime = {
  readonly reset: (
    sessionId: string,
    accessToken: string,
    correlationId: string,
  ) => Promise<EveResetStatus>;
};

export const eveAgentSessionDeletionRuntime: AgentSessionDeletionRuntime = {
  async reset(sessionId, _accessToken, correlationId) {
    const runtime = createEveAgentMailboxRuntime();
    if (!runtime.reset) throw new Error("The Agent runtime does not expose session retirement.");
    return await runtime.reset({
      owner: INTERNAL_CONTROL_OWNER,
      reason: correlationId,
      sessionId,
    });
  },
};

const INTERNAL_CONTROL_OWNER: AgentSessionOwner = {
  principalId: "open-agent-control-plane",
  principalType: "service",
  tenantId: "open-agent-runtime",
};

export type AgentSessionRuntime = {
  readonly readEvents: (input: {
    readonly accessToken: string;
    readonly after: number;
    readonly limit: number;
    readonly sessionId: string;
  }) => Promise<readonly MessageStreamEvent[]>;
  readonly cancel: (input: {
    readonly accessToken: string;
    readonly sessionId: string;
  }) => Promise<"accepted" | "no_active_turn">;
  /** Read the current Eve lifecycle boundary when a bounded event page has no terminal marker. */
  readonly inspect?: (input: {
    readonly owner: AgentSessionOwner;
    readonly sessionId: string;
  }) => Promise<{
    readonly state: "running" | "waiting" | "terminal";
    readonly turnId?: string;
    readonly terminalStatus?: "completed" | "failed";
  }>;
};

export const eveAgentSessionRuntime: AgentSessionRuntime = {
  async readEvents(input) {
    // Session ids are also used as stable correlation namespaces for the
    // interactive session API.  Hosts may replace this runtime with one that
    // resolves a richer run/thread mapping.
    return await readEveAgentEvents(
      sessionRuntimeRunId(input.sessionId),
      `session-${input.sessionId}`,
      input.sessionId,
      input.accessToken,
      input.after,
      input.limit,
    );
  },
  async cancel(input) {
    const runtime = createEveAgentMailboxRuntime();
    if (!runtime.cancel) throw new Error("The Agent runtime does not expose session cancellation.");
    return await runtime.cancel({
      owner: INTERNAL_CONTROL_OWNER,
      sessionId: input.sessionId,
    });
  },
  async inspect(input) {
    return await createEveAgentMailboxRuntime().inspect(input);
  },
};

export type ReadAgentSessionOutcome = AgentSessionHistory & {
  readonly owner: AgentSessionOwner;
};

/** Read one bounded, server-authoritative page after an absolute Eve cursor. */
export async function readAgentSession(options: {
  readonly accessToken: string;
  readonly after?: number;
  readonly identity: AgentSessionOwner;
  readonly limit?: number;
  readonly ownershipStore: AgentSessionOwnershipStore;
  readonly runtime?: AgentSessionRuntime;
  readonly sessionId: string;
}): Promise<ReadAgentSessionOutcome | undefined> {
  assertSessionId(options.sessionId);
  const ownership = await options.ownershipStore.verify(options.sessionId, options.identity);
  if (ownership !== "owned") return undefined;
  const after = parseSessionCursor(options.after ?? 0);
  const limit = parseSessionPageLimit(options.limit ?? 200);
  const events = await (options.runtime ?? eveAgentSessionRuntime).readEvents({
    accessToken: options.accessToken,
    after,
    limit,
    sessionId: options.sessionId,
  });
  const projected = events.map((event, index) => projectSessionEvent(event, after + index + 1));
  let session = projectSessionSnapshot(options.sessionId, after + events.length, events);
  const runtime = options.runtime ?? eveAgentSessionRuntime;
  // A page read from the middle of a long stream can contain only tool and
  // message events. The browser must not infer "unknown" or keep showing a
  // stale running child in that case. Eve's mailbox boundary is the source of
  // truth for the current turn and is intentionally best-effort here so a
  // transient runtime outage does not hide the durable event history.
  // A page that is full is a middle page until proven otherwise. Avoid an Eve
  // control-plane inspection for every page of a long transcript; the final
  // short/empty page is sufficient to reconcile the authoritative boundary.
  // This keeps approval/history hydration bounded even when a session has
  // hundreds of thousands of durable events.
  if (runtime.inspect && !hasLifecycleBoundary(events) && (events.length < limit || events.length === 0)) {
    try {
      session = applyRuntimeBoundary(session, await runtime.inspect({
        owner: options.identity,
        sessionId: options.sessionId,
      }));
    } catch {
      // Keep the event projection when the runtime is temporarily unavailable.
    }
  }
  return {
    events: projected,
    hasMore: events.length >= limit,
    nextCursor: after + events.length,
    owner: options.identity,
    session,
  };
}

function hasLifecycleBoundary(events: readonly MessageStreamEvent[]): boolean {
  return events.some((event) => [
    "turn.started",
    "turn.completed",
    "turn.cancelled",
    "turn.failed",
    "session.waiting",
    "session.completed",
    "session.failed",
  ].includes(event.type));
}

function applyRuntimeBoundary(
  session: AgentSessionSnapshot,
  boundary: {
    readonly state: "running" | "waiting" | "terminal";
    readonly turnId?: string;
    readonly terminalStatus?: "completed" | "failed";
  },
): AgentSessionSnapshot {
  if (boundary.state === "running") {
    return {
      ...session,
      activeTurnId: boundary.turnId,
      status: "running",
    };
  }
  if (boundary.state === "waiting") {
    const { activeTurnId: _activeTurnId, ...withoutTurn } = session;
    return { ...withoutTurn, status: "waiting" };
  }
  const { activeTurnId: _activeTurnId, ...withoutTurn } = session;
  return {
    ...withoutTurn,
    status: boundary.terminalStatus === "failed" ? "failed" : "completed",
  };
}

export async function cancelAgentSession(options: {
  readonly accessToken: string;
  readonly identity: AgentSessionOwner;
  readonly ownershipStore: AgentSessionOwnershipStore;
  readonly runtime?: AgentSessionRuntime;
  readonly sessionId: string;
}): Promise<{ readonly sessionId: string; readonly status: "accepted" | "no_active_turn" } | undefined> {
  assertSessionId(options.sessionId);
  const ownership = await options.ownershipStore.verify(options.sessionId, options.identity);
  if (ownership !== "owned") return undefined;
  const status = await (options.runtime ?? eveAgentSessionRuntime).cancel({
    accessToken: options.accessToken,
    sessionId: options.sessionId,
  });
  return { sessionId: options.sessionId, status };
}

export type DeleteAgentSessionOutcome = {
  readonly deletion: SandboxDeletionRecord;
  readonly disposition: "authorized" | "already_authorized";
  readonly reset: EveResetStatus;
};

export class AgentSessionDeletionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "AgentSessionDeletionError";
    this.status = status;
  }
}

export async function deleteAgentSession(options: {
  readonly accessToken: string;
  readonly deletionStore: SandboxDeletionStore;
  readonly identity: AgentSessionOwner;
  readonly ownershipStore: AgentSessionOwnershipStore;
  readonly runtime?: AgentSessionDeletionRuntime;
  readonly sessionId: string;
}): Promise<DeleteAgentSessionOutcome | undefined> {
  assertSessionId(options.sessionId);
  const ownership = await options.ownershipStore.verify(options.sessionId, options.identity);
  if (ownership === "missing" || ownership === "forbidden") return undefined;
  const existing = await options.deletionStore.findOwned(options.sessionId, options.identity);
  if (existing) {
    return {
      deletion: existing,
      disposition: "already_authorized",
      reset: "no_active_session",
    };
  }
  const runtime = options.runtime ?? eveAgentSessionDeletionRuntime;
  let reset: EveResetStatus;
  try {
    reset = await runtime.reset(
      options.sessionId,
      options.accessToken,
      `delete-${randomUUID()}`,
    );
  } catch {
    throw new AgentSessionDeletionError(
      502,
      "agent_session_retirement_failed",
      "The Agent runtime could not retire this session. Its sandbox was left intact.",
    );
  }
  const authorization = await options.deletionStore.request({
    owner: options.identity,
    reason: "user-requested-session-deletion",
    requestedBy: `host:${options.identity.principalType}`,
    sessionId: options.sessionId,
  });
  if (!("record" in authorization)) {
    throw new AgentSessionDeletionError(
      409,
      "agent_session_ownership_changed",
      "The Agent session ownership changed while deletion was being authorized.",
    );
  }
  return {
    deletion: authorization.record,
    disposition: authorization.status === "created" ? "authorized" : "already_authorized",
    reset,
  };
}

function assertSessionId(sessionId: string): void {
  if (sessionId.trim().length === 0 || sessionId.length > 512 || /\s/.test(sessionId)) {
    throw new AgentSessionDeletionError(400, "agent_session_id_invalid", "The Agent session id is invalid.");
  }
}

export function parseSessionCursor(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentSessionDeletionError(400, "agent_session_cursor_invalid", "The Agent session cursor is invalid.");
  }
  return value;
}

export function parseSessionPageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new AgentSessionDeletionError(400, "agent_session_limit_invalid", "The Agent session page limit must be between 1 and 1000.");
  }
  return value;
}

function projectSessionEvent(event: MessageStreamEvent, cursor: number): AgentSessionEvent {
  const candidate = event as unknown as {
    readonly data?: AgentSessionEvent["data"];
    readonly meta?: AgentSessionEvent["meta"];
    readonly type: string;
  };
  return {
    contractVersion: AGENT_SESSION_CONTRACT_VERSION,
    cursor,
    ...(candidate.data === undefined ? {} : { data: candidate.data }),
    ...(candidate.meta === undefined ? {} : { meta: candidate.meta }),
    type: candidate.type,
  };
}

function projectSessionSnapshot(
  sessionId: string,
  eventCursor: number,
  events: readonly MessageStreamEvent[],
): AgentSessionSnapshot {
  let status: AgentSessionSnapshot["status"] = "unknown";
  let activeTurnId: string | undefined;
  for (const event of events) {
    const data = "data" in event && isRecord(event.data)
      ? event.data as Record<string, unknown>
      : undefined;
    const turnId = data && typeof data.turnId === "string" && data.turnId.trim() ? data.turnId : undefined;
    if (event.type === "turn.started") {
      status = "running";
      activeTurnId = turnId;
    } else if (
      event.type === "step.started" ||
      event.type === "message.appended" ||
      event.type === "reasoning.appended" ||
      event.type === "actions.requested"
    ) {
      status = "running";
    } else if (event.type === "turn.completed") {
      activeTurnId = undefined;
      status = "waiting";
    } else if (event.type === "turn.cancelled") {
      activeTurnId = undefined;
      status = "cancelled";
    } else if (event.type === "session.waiting") {
      activeTurnId = undefined;
      status = "waiting";
    } else if (event.type === "session.completed") {
      activeTurnId = undefined;
      status = "completed";
    } else if (event.type === "session.failed" || event.type === "turn.failed") {
      activeTurnId = undefined;
      status = "failed";
    }
  }
  return {
    cursor: { eventCursor, sessionId },
    ...(activeTurnId ? { activeTurnId } : {}),
    sessionId,
    status,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionRuntimeRunId(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
  return `arun_${uuid}`;
}
