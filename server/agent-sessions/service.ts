import { createHash, randomUUID } from "node:crypto";
import type { MessageStreamEvent } from "eve/client";
import {
  AGENT_SESSION_CONTRACT_VERSION,
  type AgentSessionEvent,
  type AgentSessionHistory,
  type AgentSessionSnapshot,
} from "@oworker/open-agent-contracts/agent-session";
import type { EveResetStatus } from "../agent-runs/eve-adapter.ts";
import {
  cancelEveAgentRun,
  readEveAgentEvents,
  resetEveSession,
} from "../agent-runs/eve-adapter.ts";
import type { AgentSessionOwner, AgentSessionOwnershipStore } from "../data/session-ownership-store.ts";
import type { SandboxDeletionRecord, SandboxDeletionStore } from "../data/sandbox-deletion-store.ts";

export type AgentSessionDeletionRuntime = {
  readonly reset: typeof resetEveSession;
};

export const eveAgentSessionDeletionRuntime: AgentSessionDeletionRuntime = {
  reset: resetEveSession,
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
    return await cancelEveAgentRun(
      sessionRuntimeRunId(input.sessionId),
      `session-${input.sessionId}`,
      input.sessionId,
      input.accessToken,
    );
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
  const session = projectSessionSnapshot(options.sessionId, after + events.length, events);
  return {
    events: projected,
    hasMore: events.length >= limit,
    nextCursor: after + events.length,
    owner: options.identity,
    session,
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
