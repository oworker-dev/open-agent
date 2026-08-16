import { ClientError } from "eve/client";
import {
  AGENT_RUN_CONTRACT_VERSION,
  type AgentEvent,
  type AgentRunSnapshot,
} from "@oworker/open-agent-contracts/agent-run";
import type { AgentSessionOwner } from "../data/session-ownership-store.ts";
import type { AgentRunRecord, AgentRunStore } from "../data/agent-run-store.ts";
import type { ParsedStartAgentRun } from "./input.ts";
import { requestFingerprint } from "./input.ts";
import {
  cancelEveAgentRun,
  readEveAgentEvents,
  resetEveAgentRun,
  startEveAgentRun,
} from "./eve-adapter.ts";
import { projectAgentEvents, projectAgentRunDelta } from "./projection.ts";

const AGENT_EVENT_PAGE_SIZE = 200;

export type AgentRunRuntime = {
  readonly cancel: typeof cancelEveAgentRun;
  readonly readEvents: typeof readEveAgentEvents;
  readonly reset: typeof resetEveAgentRun;
  readonly start: typeof startEveAgentRun;
};

export type AgentRunCancellationPolicy = {
  readonly graceMs: number;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
};

export const eveAgentRunRuntime: AgentRunRuntime = {
  cancel: cancelEveAgentRun,
  readEvents: readEveAgentEvents,
  reset: resetEveAgentRun,
  start: startEveAgentRun,
};

export type StartAgentRunOutcome = {
  readonly disposition: "ambiguous" | "rejected" | "replayed" | "started";
  readonly record: AgentRunRecord;
};

export type CancelAgentRunOutcome = {
  readonly cancellation: "accepted" | "already_requested" | "no_active_turn" | "terminal";
  readonly record: AgentRunRecord;
};

export class AgentRunOperationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AgentRunOperationError";
    this.code = code;
    this.status = status;
  }
}

export function toAgentRunSnapshot(record: AgentRunRecord): AgentRunSnapshot {
  return {
    contractVersion: AGENT_RUN_CONTRACT_VERSION,
    ...(record.cancellationRequestedAt ? { cancellationRequestedAt: record.cancellationRequestedAt } : {}),
    correlationId: record.correlationId,
    createdAt: record.createdAt,
    eventCount: record.eventCount,
    ...(record.failure ? { failure: record.failure } : {}),
    harness: { kind: "eve", ...(record.sessionId ? { sessionId: record.sessionId } : {}) },
    metadata: record.metadata,
    ...(record.parent ? { parent: record.parent } : {}),
    policy: record.policy,
    profile: record.profile,
    ...(record.result ? { result: record.result } : {}),
    revision: record.revision,
    runId: record.runId,
    status: record.status,
    updatedAt: record.updatedAt,
    usage: record.usage,
  };
}

export async function startAgentRun(options: {
  readonly accessToken: string;
  readonly identity: AgentSessionOwner;
  readonly request: ParsedStartAgentRun;
  readonly runtime?: AgentRunRuntime;
  readonly store: AgentRunStore;
}): Promise<StartAgentRunOutcome> {
  const runtime = options.runtime ?? eveAgentRunRuntime;
  await validateParent(options.store, options.identity, options.request);

  const reservation = await options.store.reserve({
    correlationId: options.request.correlationId,
    idempotencyKey: options.request.idempotencyKey,
    metadata: options.request.metadata ?? {},
    ...(options.request.parent ? { parent: options.request.parent } : {}),
    policy: options.request.policy ?? {},
    principalId: options.identity.principalId,
    profile: options.request.profile,
    requestFingerprint: requestFingerprint(options.request),
    tenantId: options.identity.tenantId,
  });

  if (reservation.status === "conflict") {
    throw new AgentRunOperationError(
      409,
      "agent_run_idempotency_conflict",
      "This idempotency key was already used for a different AgentRun request.",
    );
  }
  if (reservation.status === "replay") {
    return { disposition: "replayed", record: reservation.record };
  }

  try {
    const session = await runtime.start(
      options.request,
      reservation.record.runId,
      options.accessToken,
    );
    const record = await options.store.attachSession(
      reservation.record.runId,
      session.sessionId,
    );
    return { disposition: "started", record };
  } catch (error) {
    if (error instanceof ClientError && error.status >= 400 && error.status < 500) {
      const record = await options.store.markSubmissionFailed(
        reservation.record.runId,
        "The Agent runtime rejected the request before accepting a session.",
      );
      return { disposition: "rejected", record };
    }
    const record = await options.store.markSubmissionAmbiguous(
      reservation.record.runId,
      "The Agent service could not determine whether the runtime accepted this request. The same idempotency key will not submit it again.",
    );
    return { disposition: "ambiguous", record };
  }
}

export async function inspectAgentRun(options: {
  readonly accessToken: string;
  readonly identity: AgentSessionOwner;
  readonly runId: string;
  readonly cancellationPolicy?: Partial<AgentRunCancellationPolicy>;
  readonly runtime?: AgentRunRuntime;
  readonly store: AgentRunStore;
}): Promise<AgentRunRecord | undefined> {
  const record = await options.store.findOwned(
    options.identity.tenantId,
    options.identity.principalId,
    options.runId,
  );
  if (!record || !record.sessionId || record.status === "submission-ambiguous") return record;
  return (await synchronizeAgentRun(
    options.store,
    record,
    options.accessToken,
    options.runtime,
    options.cancellationPolicy,
  )).record;
}

export async function readAgentRunEvents(options: {
  readonly accessToken: string;
  readonly after: number;
  readonly identity: AgentSessionOwner;
  readonly runId: string;
  readonly cancellationPolicy?: Partial<AgentRunCancellationPolicy>;
  readonly runtime?: AgentRunRuntime;
  readonly store: AgentRunStore;
}): Promise<{
  readonly events: readonly AgentEvent[];
  readonly nextCursor: number;
  readonly record: AgentRunRecord;
} | undefined> {
  const record = await options.store.findOwned(
    options.identity.tenantId,
    options.identity.principalId,
    options.runId,
  );
  if (!record) return undefined;
  const synchronized = await synchronizeAgentRun(
    options.store,
    record,
    options.accessToken,
    options.runtime,
    options.cancellationPolicy,
  );
  if (options.after > synchronized.record.eventCount) {
    throw new AgentRunOperationError(
      416,
      "agent_run_cursor_out_of_range",
      "The event cursor is ahead of the AgentRun event stream.",
    );
  }
  if (!synchronized.record.sessionId) {
    return {
      events: [],
      nextCursor: options.after,
      record: synchronized.record,
    };
  }
  const events = await (options.runtime ?? eveAgentRunRuntime).readEvents(
    synchronized.record.runId,
    synchronized.record.correlationId,
    synchronized.record.sessionId,
    options.accessToken,
    options.after,
    AGENT_EVENT_PAGE_SIZE,
  );
  return {
    events: projectAgentEvents(record.runId, events, options.after),
    nextCursor: options.after + events.length,
    record: synchronized.record,
  };
}

export async function cancelAgentRun(options: {
  readonly accessToken: string;
  readonly identity: AgentSessionOwner;
  readonly runId: string;
  readonly cancellationPolicy?: Partial<AgentRunCancellationPolicy>;
  readonly runtime?: AgentRunRuntime;
  readonly store: AgentRunStore;
}): Promise<CancelAgentRunOutcome | undefined> {
  const record = await options.store.findOwned(
    options.identity.tenantId,
    options.identity.principalId,
    options.runId,
  );
  if (!record) return undefined;
  if (isTerminal(record.status)) return { cancellation: "terminal", record };
  if (!record.sessionId) {
    throw new AgentRunOperationError(
      409,
      "agent_run_submission_pending",
      "The AgentRun does not have an accepted runtime session yet.",
    );
  }

  const runtime = options.runtime ?? eveAgentRunRuntime;
  const cancellationPolicy = resolveCancellationPolicy(options.cancellationPolicy);
  if (record.cancellationRequestedAt) {
    await cancellationPolicy.sleep(
      cancellationGraceRemaining(record.cancellationRequestedAt, cancellationPolicy),
    );
    const synchronized = await synchronizeAgentRun(
      options.store,
      record,
      options.accessToken,
      runtime,
      cancellationPolicy,
    );
    return { cancellation: "already_requested", record: synchronized.record };
  }

  // Persist the caller's intent before crossing the Eve transport boundary.
  // A hung request or process restart can then be reconciled by inspection.
  const requested = await options.store.markCancellationRequested(record.runId);
  // The run may have crossed a terminal boundary after the initial lookup but
  // before the cancellation CAS. Stores return the authoritative row when
  // that race loses; never stamp a completed/failed run with a cancellation
  // request or send a late cancel to Eve.
  if (isTerminal(requested.status)) {
    return { cancellation: "terminal", record: requested };
  }
  const cancellation = await runtime.cancel(
    record.runId,
    record.correlationId,
    record.sessionId,
    options.accessToken,
  );
  await cancellationPolicy.sleep(cancellationPolicy.graceMs);
  const synchronized = await synchronizeAgentRun(
    options.store,
    requested,
    options.accessToken,
    runtime,
    cancellationPolicy,
  );
  return { cancellation, record: synchronized.record };
}

export async function synchronizeAgentRun(
  store: AgentRunStore,
  record: AgentRunRecord,
  accessToken: string,
  runtime: AgentRunRuntime = eveAgentRunRuntime,
  cancellationPolicyInput?: Partial<AgentRunCancellationPolicy>,
) {
  if (!record.sessionId) return { events: [], record } as const;
  if (isTerminal(record.status)) return { events: [], record } as const;
  const events = await runtime.readEvents(
    record.runId,
    record.correlationId,
    record.sessionId,
    accessToken,
    record.eventCount,
    AGENT_EVENT_PAGE_SIZE,
  );
  let projectedRecord = events.length === 0
    ? record
    : await store.updateProjection(record.runId, projectAgentRunDelta(record, events));
  const cancellationPolicy = resolveCancellationPolicy(cancellationPolicyInput);
  if (
    projectedRecord.status !== "cancelled"
    && projectedRecord.cancellationRequestedAt
    && projectedRecord.sessionId
    && cancellationGraceElapsed(projectedRecord.cancellationRequestedAt, cancellationPolicy)
  ) {
    const reset = await runtime.reset(
      projectedRecord.runId,
      projectedRecord.correlationId,
      projectedRecord.sessionId,
      accessToken,
    );
    projectedRecord = await store.markCancelled(projectedRecord.runId);
  }
  return {
    events: projectAgentEvents(record.runId, events, record.eventCount),
    record: projectedRecord,
  } as const;
}

function resolveCancellationPolicy(
  input: Partial<AgentRunCancellationPolicy> | undefined,
): AgentRunCancellationPolicy {
  return {
    graceMs: input?.graceMs ?? cancellationGraceMs(),
    now: input?.now ?? Date.now,
    sleep: input?.sleep ?? sleep,
  };
}

function cancellationGraceElapsed(
  requestedAt: string,
  policy: AgentRunCancellationPolicy,
): boolean {
  const timestamp = Date.parse(requestedAt);
  return !Number.isFinite(timestamp) || policy.now() - timestamp >= policy.graceMs;
}

function cancellationGraceRemaining(
  requestedAt: string,
  policy: AgentRunCancellationPolicy,
): number {
  const timestamp = Date.parse(requestedAt);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, policy.graceMs - (policy.now() - timestamp));
}

function cancellationGraceMs(): number {
  const value = process.env.AGENT_RUN_CANCELLATION_GRACE_MS?.trim();
  if (!value) return 100;
  const milliseconds = Number(value);
  if (!Number.isInteger(milliseconds) || milliseconds < 100 || milliseconds > 10_000) {
    throw new Error("AGENT_RUN_CANCELLATION_GRACE_MS must be an integer from 100 to 10000.");
  }
  return milliseconds;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function validateParent(
  store: AgentRunStore,
  identity: AgentSessionOwner,
  request: ParsedStartAgentRun,
): Promise<void> {
  if (!request.parent) return;
  if (identity.principalType !== "service") {
    throw new AgentRunOperationError(
      403,
      "agent_run_parent_forbidden",
      "Only an authenticated service principal can submit a child AgentRun.",
    );
  }
  const parent = await store.findOwned(
    identity.tenantId,
    identity.principalId,
    request.parent.parentRunId,
  );
  if (!parent) {
    throw new AgentRunOperationError(
      404,
      "agent_run_parent_not_found",
      "The parent AgentRun was not found for this principal.",
    );
  }
  const expectedDepth = (parent.parent?.depth ?? 0) + 1;
  const expectedRootRunId = parent.parent?.rootRunId ?? parent.runId;
  if (request.parent.depth !== expectedDepth || request.parent.rootRunId !== expectedRootRunId) {
    throw new AgentRunOperationError(
      400,
      "agent_run_parent_invalid",
      "The AgentRun parent depth or root lineage is invalid.",
    );
  }
}

function isTerminal(status: AgentRunRecord["status"]): boolean {
  return status === "cancelled"
    || status === "completed"
    || status === "failed"
    || status === "submission-ambiguous";
}
