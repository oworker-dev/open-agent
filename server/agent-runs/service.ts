import { ClientError } from "eve/client";
import {
  AGENT_RUN_CONTRACT_VERSION,
  type AgentEvent,
  type AgentRunSnapshot,
} from "@oworker/open-agent-contracts/agent-run";
import type { AgentSessionOwner } from "../data/session-ownership-store.ts";
import type { AgentRunRecord, AgentRunStore } from "../data/agent-run-store.ts";
import type { AgentRunInputStore } from "../data/agent-run-input-store.ts";
import type { ParsedRespondAgentRun, ParsedStartAgentRun } from "./input.ts";
import { inputResponseFingerprint, requestFingerprint } from "./input.ts";
import {
  cancelEveAgentRun,
  readEveAgentEvents,
  respondEveAgentRun,
  resetEveAgentRun,
  startEveAgentRun,
} from "./eve-adapter.ts";
import { projectAgentEvents, projectAgentRunDelta } from "./projection.ts";

const AGENT_EVENT_PAGE_SIZE = 200;
// The public event API intentionally stays at 200 events per page. Runtime
// projections, however, are server-side and should catch up quickly when Eve
// emits many small action.input.partial events (for example a streamed file
// edit). Eve stream setup has a measurable cost, so use a larger bounded page
// for the production runtime while preserving the fake-runtime/unit-test page
// size and the public cursor contract.
const AGENT_EVENT_SYNC_PAGE_SIZE = 1_000;

export type AgentRunRuntime = {
  readonly cancel: typeof cancelEveAgentRun;
  readonly readEvents: typeof readEveAgentEvents;
  readonly respond: typeof respondEveAgentRun;
  readonly reset: typeof resetEveAgentRun;
  readonly start: typeof startEveAgentRun;
  /** Optional larger page used only while projecting a runtime into storage. */
  readonly synchronizationPageSize?: number;
};

export type AgentRunCancellationPolicy = {
  readonly graceMs: number;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
};

export const eveAgentRunRuntime: AgentRunRuntime = {
  cancel: cancelEveAgentRun,
  readEvents: readEveAgentEvents,
  respond: respondEveAgentRun,
  reset: resetEveAgentRun,
  start: startEveAgentRun,
  synchronizationPageSize: AGENT_EVENT_SYNC_PAGE_SIZE,
};

export type StartAgentRunOutcome = {
  readonly disposition: "ambiguous" | "rejected" | "replayed" | "started";
  readonly record: AgentRunRecord;
};

export type CancelAgentRunOutcome = {
  readonly cancellation: "accepted" | "already_requested" | "no_active_turn" | "terminal";
  readonly record: AgentRunRecord;
};

export type RespondAgentRunOutcome = {
  readonly disposition: "accepted" | "replayed";
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
  if (reservation.status === "capacity") {
    const scope = reservation.maxActiveRunsPerTenant > 0 &&
      reservation.activeTenantCount >= reservation.maxActiveRunsPerTenant
      ? "tenant"
      : "service";
    throw new AgentRunOperationError(
      429,
      "agent_run_capacity",
      `The Agent service is at its ${scope} concurrency limit. Retry after active work settles.`,
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

export async function respondAgentRun(options: {
  readonly accessToken: string;
  readonly identity: AgentSessionOwner;
  readonly inputStore: AgentRunInputStore;
  readonly request: ParsedRespondAgentRun;
  readonly runId: string;
  readonly runtime?: AgentRunRuntime;
  readonly store: AgentRunStore;
}): Promise<RespondAgentRunOutcome | undefined> {
  const current = await options.store.findOwned(
    options.identity.tenantId,
    options.identity.principalId,
    options.runId,
  );
  if (!current) return undefined;
  const responseFingerprint = inputResponseFingerprint(options.request);
  const previous = await options.inputStore.find(options.runId, options.request.idempotencyKey);
  if (previous) {
    if (previous.requestFingerprint !== responseFingerprint) {
      throw new AgentRunOperationError(
        409,
        "agent_run_input_idempotency_conflict",
        "This input idempotency key was already used for a different response.",
      );
    }
    if (previous.status === "accepted") {
      return { disposition: "replayed", record: current };
    }
    const ambiguous = previous.status === "submission-ambiguous" || previous.status === "submitting";
    throw new AgentRunOperationError(
      ambiguous ? 503 : 409,
      ambiguous ? "agent_run_input_submission_ambiguous" : "agent_run_input_failed",
      ambiguous
        ? "The Agent service cannot determine whether this input response was accepted; it will not submit it again."
      : "This input response attempt failed and cannot be replayed with the same idempotency key.",
    );
  }
  if (!current.sessionId) {
    throw new AgentRunOperationError(
      409,
      "agent_run_submission_pending",
      "The AgentRun does not have an accepted runtime session yet.",
    );
  }
  if (isTerminal(current.status)) {
    throw new AgentRunOperationError(
      409,
      "agent_run_terminal",
      "A terminal AgentRun cannot accept an input response.",
    );
  }

  const runtime = options.runtime ?? eveAgentRunRuntime;
  let synchronized = await synchronizeAgentRun(
    options.store,
    current,
    options.accessToken,
    runtime,
  );
  // A headless consumer may answer immediately after observing an event page
  // while the database projection is still several bounded pages behind.
  // Catch up deterministically before deciding whether the run is parked.
  const syncPageSize = synchronizationPageSize(runtime);
  for (let page = 1; page < 50 && synchronized.events.length === syncPageSize; page += 1) {
    if (synchronized.record.status === "waiting-input" || isTerminal(synchronized.record.status)) break;
    synchronized = await synchronizeAgentRun(
      options.store,
      synchronized.record,
      options.accessToken,
      runtime,
    );
  }
  if (synchronized.record.status !== "waiting-input") {
    throw new AgentRunOperationError(
      409,
      "agent_run_not_waiting_input",
      "The AgentRun is not currently waiting for an input response.",
    );
  }

  const tailStart = Math.max(0, synchronized.record.eventCount - AGENT_EVENT_PAGE_SIZE);
  const tail = await runtime.readEvents(
    synchronized.record.runId,
    synchronized.record.correlationId,
    synchronized.record.sessionId!,
    options.accessToken,
    tailStart,
    AGENT_EVENT_PAGE_SIZE,
  );
  const pending = latestPendingInputRequestIds(tail);
  const requested = options.request.inputResponses.map((response) => response.requestId);
  if (pending.size === 0 || requested.some((requestId) => !pending.has(requestId))) {
    throw new AgentRunOperationError(
      409,
      "agent_run_input_stale",
      "The AgentRun input response does not match its current pending request batch.",
    );
  }

  const reservation = await options.inputStore.reserve({
    idempotencyKey: options.request.idempotencyKey,
    inputResponses: options.request.inputResponses,
    requestFingerprint: responseFingerprint,
    requestIds: requested,
    runId: options.runId,
  });
  if (reservation.status === "conflict") {
    throw new AgentRunOperationError(
      409,
      "agent_run_input_idempotency_conflict",
      "This input idempotency key was already used for a different response.",
    );
  }
  if (reservation.status === "request-already-answered") {
    throw new AgentRunOperationError(
      409,
      "agent_run_input_already_answered",
      "One of these AgentRun input requests already has a reserved response.",
    );
  }
  if (reservation.status === "replay") {
    if (reservation.record.status === "accepted") {
      return { disposition: "replayed", record: synchronized.record };
    }
    const ambiguous = reservation.record.status === "submission-ambiguous" || reservation.record.status === "submitting";
    throw new AgentRunOperationError(
      ambiguous ? 503 : 409,
      ambiguous ? "agent_run_input_submission_ambiguous" : "agent_run_input_failed",
      ambiguous
        ? "The Agent service cannot determine whether this input response was accepted; it will not submit it again."
        : "This input response attempt failed and cannot be replayed with the same idempotency key.",
    );
  }

  try {
    const response = await runtime.respond(
      synchronized.record.runId,
      synchronized.record.correlationId,
      synchronized.record.sessionId!,
      options.accessToken,
      options.request.inputResponses,
    );
    if (response.sessionId !== synchronized.record.sessionId) {
      await options.inputStore.markSubmissionAmbiguous(
        reservation.record.responseId,
        "The Agent runtime accepted the response under an unexpected session id.",
      );
      throw new AgentRunOperationError(
        502,
        "agent_run_input_session_changed",
        "The Agent runtime changed session identity while accepting input.",
      );
    }
    await options.inputStore.markAccepted(reservation.record.responseId);
  } catch (error) {
    if (error instanceof AgentRunOperationError) throw error;
    if (error instanceof ClientError && error.status >= 400 && error.status < 500) {
      await options.inputStore.markFailed(
        reservation.record.responseId,
        "The Agent runtime rejected the input response.",
      );
      throw new AgentRunOperationError(
        409,
        "agent_run_input_rejected",
        "The Agent runtime rejected this input response as invalid or stale.",
      );
    }
    await options.inputStore.markSubmissionAmbiguous(
      reservation.record.responseId,
      "The Agent service could not determine whether the runtime accepted this input response.",
    );
    throw new AgentRunOperationError(
      503,
      "agent_run_input_submission_ambiguous",
      "The Agent service cannot determine whether this input response was accepted; it will not submit it again.",
    );
  }

  return { disposition: "accepted", record: synchronized.record };
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
    synchronizationPageSize(runtime),
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

function synchronizationPageSize(runtime: AgentRunRuntime): number {
  const value = runtime.synchronizationPageSize;
  if (value === undefined) return AGENT_EVENT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < AGENT_EVENT_PAGE_SIZE || value > 1_000) {
    throw new Error("Agent runtime synchronizationPageSize must be an integer from 200 to 1000.");
  }
  return value;
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
  // Give Eve enough time to reach its durable cooperative-cancellation
  // boundary before the exclusive headless session fallback resets it. The
  // deployment can still tune this through AGENT_RUN_CANCELLATION_GRACE_MS.
  if (!value) return 1_000;
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
  // A host may create a child for a run it owns. The previous service-only
  // restriction forced web hosts to bypass AgentRun persistence and resulted
  // in fake parent ids. Ownership is enforced by the tenant/principal lookup
  // below; service principals remain valid for internal orchestration.
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

function latestPendingInputRequestIds(
  events: readonly { readonly type: string; readonly data?: unknown }[],
): ReadonlySet<string> {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
      return new Set();
    }
    if (event.type !== "input.requested" || !isRecord(event.data) || !Array.isArray(event.data.requests)) {
      continue;
    }
    return new Set(
      event.data.requests.flatMap((request) =>
        isRecord(request) && typeof request.requestId === "string" ? [request.requestId] : []),
    );
  }
  return new Set();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
