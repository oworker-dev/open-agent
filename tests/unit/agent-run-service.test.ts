import assert from "node:assert/strict";
import test from "node:test";
import { ClientError, type MessageStreamEvent } from "eve/client";

import {
  DEFAULT_AGENT_PROFILE,
  type AgentRunPolicy,
} from "@oworker/open-agent-contracts/agent-run";
import type {
  AgentRunProjection,
  AgentRunRecord,
  AgentRunStore,
  ReserveAgentRunInput,
  ReserveAgentRunResult,
} from "../../server/data/agent-run-store.ts";
import type {
  AgentRunInputRecord,
  AgentRunInputStore,
  ReserveAgentRunInputResult,
} from "../../server/data/agent-run-input-store.ts";
import type { AgentSessionOwner } from "../../server/data/session-ownership-store.ts";
import {
  parseRespondAgentRun,
  parseStartAgentRun,
  requestFingerprint,
} from "../../server/agent-runs/input.ts";
import { projectAgentEvents, projectAgentRun } from "../../server/agent-runs/projection.ts";
import {
  AgentRunOperationError,
  cancelAgentRun,
  inspectAgentRun,
  readAgentRunEvents,
  respondAgentRun,
  startAgentRun,
  type AgentRunRuntime,
} from "../../server/agent-runs/service.ts";

const user: AgentSessionOwner = {
  principalId: "issuer:user-1",
  principalType: "user",
  tenantId: "tenant-1",
};

test("request fingerprints ignore generated correlation IDs", () => {
  const first = parseRequest({ idempotencyKey: "request-123", message: "Do the work" });
  const second = parseRequest({ idempotencyKey: "request-123", message: "Do the work" });
  assert.notEqual(first.correlationId, second.correlationId);
  assert.equal(requestFingerprint(first), requestFingerprint(second));
});

test("request fingerprints include normalized AgentRun policy", () => {
  const first = parseRequest({
    idempotencyKey: "request-policy-123",
    message: "Do the work",
    policy: { hostCapabilities: ["workflow.invoke", "canvas.inspect"] },
  });
  const reordered = parseRequest({
    idempotencyKey: "request-policy-123",
    message: "Do the work",
    policy: { hostCapabilities: ["canvas.inspect", "workflow.invoke"] },
  });
  const narrower = parseRequest({
    idempotencyKey: "request-policy-123",
    message: "Do the work",
    policy: { hostCapabilities: ["canvas.inspect"] },
  });
  assert.equal(requestFingerprint(first), requestFingerprint(reordered));
  assert.notEqual(requestFingerprint(first), requestFingerprint(narrower));
});

test("replays an identical idempotency key without submitting another Eve session", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime();
  const first = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-123", message: "Do the work" }),
    runtime,
    store,
  });
  const replay = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-123", message: "Do the work" }),
    runtime,
    store,
  });

  assert.equal(first.disposition, "started");
  assert.equal(replay.disposition, "replayed");
  assert.equal(replay.record.runId, first.record.runId);
  assert.equal(runtime.calls.start, 1);
});

test("rejects reuse of an idempotency key for a different request", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime();
  await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-123", message: "First" }),
    runtime,
    store,
  });

  await assert.rejects(
    startAgentRun({
      accessToken: "token",
      identity: user,
      request: parseRequest({ idempotencyKey: "request-123", message: "Second" }),
      runtime,
      store,
    }),
    (error: unknown) => error instanceof AgentRunOperationError && error.status === 409,
  );
  assert.equal(runtime.calls.start, 1);
});

test("rejects a new AgentRun when the durable admission gate is full", async () => {
  const store = new MemoryAgentRunStore();
  store.reserve = async () => ({
    activeCount: 16,
    activeTenantCount: 16,
    maxActiveRuns: 16,
    maxActiveRunsPerTenant: 16,
    status: "capacity",
  });
  const runtime = fakeRuntime();

  await assert.rejects(
    startAgentRun({
      accessToken: "token",
      identity: user,
      request: parseRequest({ idempotencyKey: "capacity-1", message: "Do the work" }),
      runtime,
      store,
    }),
    (error: unknown) => error instanceof AgentRunOperationError &&
      error.status === 429 && error.code === "agent_run_capacity",
  );
  assert.equal(runtime.calls.start, 0);
});

test("does not expose a run to another tenant or principal", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime();
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-123", message: "Private" }),
    runtime,
    store,
  });

  const otherPrincipal = await inspectAgentRun({
    accessToken: "token",
    identity: { ...user, principalId: "issuer:user-2" },
    runId: started.record.runId,
    runtime,
    store,
  });
  const otherTenant = await inspectAgentRun({
    accessToken: "token",
    identity: { ...user, tenantId: "tenant-2" },
    runId: started.record.runId,
    runtime,
    store,
  });
  assert.equal(otherPrincipal, undefined);
  assert.equal(otherTenant, undefined);
});

test("answers the current AgentRun input request exactly once", async () => {
  const store = new MemoryAgentRunStore();
  const inputStore = new MemoryAgentRunInputStore();
  const runtime = fakeRuntime({ events: waitingInputEvents("approval-1") });
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-input-1", message: "Modify the canvas" }),
    runtime,
    store,
  });
  const request = parseInputResponse({
    idempotencyKey: "approval-response-1",
    inputResponses: [{ optionId: "approve", requestId: "approval-1" }],
  });

  const accepted = await respondAgentRun({
    accessToken: "token",
    identity: user,
    inputStore,
    request,
    runId: started.record.runId,
    runtime,
    store,
  });
  const replayed = await respondAgentRun({
    accessToken: "token",
    identity: user,
    inputStore,
    request,
    runId: started.record.runId,
    runtime,
    store,
  });

  assert.equal(accepted?.disposition, "accepted");
  assert.equal(replayed?.disposition, "replayed");
  assert.equal(runtime.calls.respond, 1);
  assert.deepEqual(runtime.calls.inputResponses, [request.inputResponses]);
});

test("rejects stale or foreign AgentRun input request ids", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime({ events: waitingInputEvents("approval-current") });
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-input-stale", message: "Modify the canvas" }),
    runtime,
    store,
  });

  await assert.rejects(
    respondAgentRun({
      accessToken: "token",
      identity: user,
      inputStore: new MemoryAgentRunInputStore(),
      request: parseInputResponse({
        idempotencyKey: "approval-response-stale",
        inputResponses: [{ optionId: "approve", requestId: "approval-old" }],
      }),
      runId: started.record.runId,
      runtime,
      store,
    }),
    (error: unknown) => error instanceof AgentRunOperationError && error.code === "agent_run_input_stale",
  );
  const foreign = await respondAgentRun({
    accessToken: "token",
    identity: { ...user, principalId: "issuer:foreign" },
    inputStore: new MemoryAgentRunInputStore(),
    request: parseInputResponse({
      idempotencyKey: "approval-response-foreign",
      inputResponses: [{ optionId: "approve", requestId: "approval-current" }],
    }),
    runId: started.record.runId,
    runtime,
    store,
  });
  assert.equal(foreign, undefined);
  assert.equal(runtime.calls.respond, 0);
});

test("projects usage, result, status, and incremental event cursors", async () => {
  const events = completedEvents();
  const projection = projectAgentRun(events);
  assert.deepEqual(projection.usage, {
    cacheReadTokens: 7,
    cacheWriteTokens: 3,
    costUsd: 0.0125,
    inputTokens: 21,
    outputTokens: 8,
    steps: 1,
  });
  assert.deepEqual(projection.result, { kind: "text", value: "Done" });
  assert.equal(projection.status, "completed");

  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime({ events });
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-123", message: "Run" }),
    runtime,
    store,
  });
  const result = await readAgentRunEvents({
    accessToken: "token",
    after: 2,
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });
  assert.ok(result);
  assert.equal(result.events.length, events.length - 2);
  assert.equal(result.events[0]?.sequence, 3);
  assert.equal(result.nextCursor, events.length);
  assert.equal(result.record.eventCount, events.length);
  assert.deepEqual(runtime.calls.readStartIndexes, [0, 2]);
});

test("projects durable provider argument snapshots as typed AgentRun events", () => {
  const [event] = projectAgentEvents("arun-stream", [{
    data: {
      callId: "call-patch",
      input: { patch: "*** Begin Patch" },
      inputTextDelta: "Patch",
      inputTextSoFar: '{"patch":"*** Begin Patch',
      sequence: 0,
      stepIndex: 0,
      toolName: "apply_patch",
      turnId: "turn-stream",
    },
    meta: { at: "2026-08-17T00:00:00.000Z", id: "event-stream" },
    type: "action.input.partial",
  }]);
  assert.equal(event?.type, "tool.input.delta");
  assert.equal(event?.data.callId, "call-patch");
  assert.equal(event?.data.inputTextSoFar, '{"patch":"*** Begin Patch');
});

test("synchronizes long AgentRuns in bounded cursor pages", async () => {
  const events = longCompletedEvents(405);
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime({ events });
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-long", message: "Run for a while" }),
    runtime,
    store,
  });

  const first = await inspectAgentRun({
    accessToken: "token",
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });
  assert.equal(first?.eventCount, 200);
  assert.equal(first?.status, "running");

  const second = await inspectAgentRun({
    accessToken: "token",
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });
  const completed = await inspectAgentRun({
    accessToken: "token",
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });
  assert.equal(second?.eventCount, 400);
  assert.equal(completed?.eventCount, events.length);
  assert.equal(completed?.status, "completed");
  assert.deepEqual(runtime.calls.readStartIndexes, [0, 200, 400]);

  const firstPage = await readAgentRunEvents({
    accessToken: "token",
    after: 0,
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });
  const secondPage = await readAgentRunEvents({
    accessToken: "token",
    after: firstPage!.nextCursor,
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });
  assert.equal(firstPage?.events.length, 200);
  assert.equal(firstPage?.nextCursor, 200);
  assert.equal(secondPage?.events[0]?.sequence, 201);
  assert.equal(secondPage?.nextCursor, 400);
});

test("allows the Eve runtime to use a larger projection page without changing public cursors", async () => {
  const events = longCompletedEvents(405);
  const store = new MemoryAgentRunStore();
  const runtime = {
    ...fakeRuntime({ events }),
    synchronizationPageSize: 1_000,
  };
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-runtime-page", message: "Run quickly" }),
    runtime,
    store,
  });

  const projected = await inspectAgentRun({
    accessToken: "token",
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });
  assert.equal(projected?.eventCount, events.length);
  assert.equal(projected?.status, "completed");

  const firstPage = await readAgentRunEvents({
    accessToken: "token",
    after: 0,
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });
  assert.equal(firstPage?.events.length, 200);
  assert.equal(firstPage?.nextCursor, 200);
});

test("does not let an older AgentRun projection overwrite a newer cursor", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime({ events: longCompletedEvents(205) });
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-stale-projection", message: "Run" }),
    runtime,
    store,
  });
  const first = await inspectAgentRun({
    accessToken: "token",
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });
  assert.equal(first?.eventCount, 200);

  const stale = await store.updateProjection(started.record.runId, {
    eventCount: 10,
    status: "running",
    usage: emptyUsage(),
  });
  assert.equal(stale.eventCount, 200);
  assert.deepEqual(stale.usage, first?.usage);
});

test("cancellation is idempotent and reaches Eve only once", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime({ events: runningEvents() });
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-123", message: "Keep working" }),
    runtime,
    store,
  });
  const first = await cancelAgentRun({
    accessToken: "token",
    identity: user,
    runId: started.record.runId,
    cancellationPolicy: immediateCancellation,
    runtime,
    store,
  });
  const second = await cancelAgentRun({
    accessToken: "token",
    identity: user,
    runId: started.record.runId,
    cancellationPolicy: immediateCancellation,
    runtime,
    store,
  });

  assert.equal(first?.cancellation, "accepted");
  assert.equal(first?.record.status, "cancelled");
  assert.equal(second?.cancellation, "terminal");
  assert.equal(runtime.calls.cancel, 1);
  assert.equal(runtime.calls.reset, 1);
});

test("does not cancel or mark a run that completed during cancellation admission", async () => {
  const store = new TerminalDuringCancellationStore();
  const runtime = fakeRuntime({ events: runningEvents() });
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-cancel-race", message: "Keep working" }),
    runtime,
    store,
  });

  const outcome = await cancelAgentRun({
    accessToken: "token",
    identity: user,
    runId: started.record.runId,
    cancellationPolicy: immediateCancellation,
    runtime,
    store,
  });

  assert.equal(outcome?.cancellation, "terminal");
  assert.equal(outcome?.record.status, "completed");
  assert.equal(outcome?.record.cancellationRequestedAt, undefined);
  assert.equal(runtime.calls.cancel, 0);
  assert.equal(runtime.calls.reset, 0);
});

test("uses Eve's cooperative cancellation boundary without resetting the session", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime({ events: cancelledEvents() });
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-cooperative", message: "Keep working" }),
    runtime,
    store,
  });
  const cancelled = await cancelAgentRun({
    accessToken: "token",
    cancellationPolicy: immediateCancellation,
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });

  assert.equal(cancelled?.record.status, "cancelled");
  assert.equal(runtime.calls.reset, 0);
});

test("resets an exclusive session when accepted cancellation never settles", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime({ events: runningEvents() });
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-hard-cancel", message: "Keep working" }),
    runtime,
    store,
  });
  const cancelled = await cancelAgentRun({
    accessToken: "token",
    cancellationPolicy: immediateCancellation,
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });

  assert.equal(cancelled?.record.status, "cancelled");
  assert.equal(runtime.calls.reset, 1);
});

test("cancellation wins when the provider completes during the grace window", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime({ events: completedEvents() });
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-race", message: "Keep working" }),
    runtime,
    store,
  });
  const cancelled = await cancelAgentRun({
    accessToken: "token",
    cancellationPolicy: immediateCancellation,
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });

  assert.equal(cancelled?.record.status, "cancelled");
  assert.equal(cancelled?.record.result, undefined);
  assert.equal(cancelled?.record.usage.inputTokens, 21);
  assert.equal(runtime.calls.reset, 1);
});

test("persists cancellation before an Eve transport failure and reconciles later", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime({
    cancelError: new Error("Eve cancellation transport failed"),
    events: runningEvents(),
  });
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({
      idempotencyKey: "request-cancel-transport-failure",
      message: "Keep working",
    }),
    runtime,
    store,
  });

  await assert.rejects(
    cancelAgentRun({
      accessToken: "token",
      identity: user,
      runId: started.record.runId,
      cancellationPolicy: immediateCancellation,
      runtime,
      store,
    }),
    /transport failed/,
  );
  const pending = await store.findOwned(
    user.tenantId,
    user.principalId,
    started.record.runId,
  );
  assert.ok(pending?.cancellationRequestedAt);
  assert.equal(pending.status, "running");

  const reconciled = await inspectAgentRun({
    accessToken: "token",
    cancellationPolicy: immediateCancellation,
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });
  assert.equal(reconciled?.status, "cancelled");
  assert.equal(runtime.calls.reset, 1);
});

test("inspection reconciles an interrupted cancellation and reset is idempotent", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime({ events: runningEvents() });
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-reconcile", message: "Keep working" }),
    runtime,
    store,
  });
  const requested = await store.markCancellationRequested(started.record.runId);
  const requestedAt = Date.parse(requested.cancellationRequestedAt!);

  const duringGrace = await inspectAgentRun({
    accessToken: "token",
    cancellationPolicy: { ...immediateCancellation, graceMs: 1_000, now: () => requestedAt },
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });
  assert.equal(duringGrace?.status, "running");
  assert.equal(runtime.calls.reset, 0);

  const afterGrace = await inspectAgentRun({
    accessToken: "token",
    cancellationPolicy: { ...immediateCancellation, graceMs: 1_000, now: () => requestedAt + 1_001 },
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });
  const replay = await inspectAgentRun({
    accessToken: "token",
    cancellationPolicy: immediateCancellation,
    identity: user,
    runId: started.record.runId,
    runtime,
    store,
  });
  assert.equal(afterGrace?.status, "cancelled");
  assert.equal(replay?.status, "cancelled");
  assert.equal(runtime.calls.reset, 1);
});

test("cancels a queued session when Eve has not started its first turn", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime({ cancelStatus: "no_active_turn" });
  const started = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-queued", message: "Queued" }),
    runtime,
    store,
  });
  const cancelled = await cancelAgentRun({
    accessToken: "token",
    identity: user,
    runId: started.record.runId,
    cancellationPolicy: immediateCancellation,
    runtime,
    store,
  });
  assert.equal(cancelled?.cancellation, "no_active_turn");
  assert.equal(cancelled?.record.status, "cancelled");
  assert.equal(runtime.calls.reset, 1);
});

test("submission ambiguity is persisted and never automatically resubmitted", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime({ startError: new Error("socket closed") });
  const request = parseRequest({ idempotencyKey: "request-123", message: "Side effect" });
  const first = await startAgentRun({ accessToken: "token", identity: user, request, runtime, store });
  const replay = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-123", message: "Side effect" }),
    runtime,
    store,
  });

  assert.equal(first.disposition, "ambiguous");
  assert.equal(first.record.status, "submission-ambiguous");
  assert.equal(replay.disposition, "replayed");
  assert.equal(runtime.calls.start, 1);
});

test("retries durable Eve session attachment before cleaning up", async () => {
  const store = new AttachFailureStore(2);
  const runtime = fakeRuntime();
  const outcome = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-attach-retry", message: "Retry attach" }),
    runtime,
    store,
    submissionPolicy: { attachAttempts: 3, cleanupAttempts: 1, sleep: async () => undefined },
  });

  assert.equal(outcome.disposition, "started");
  assert.equal(outcome.record.status, "running");
  assert.equal(store.attachAttempts, 3);
  assert.equal(runtime.calls.reset, 0);
});

test("resets an accepted Eve session before releasing a failed attachment", async () => {
  const store = new AttachFailureStore(3);
  const runtime = fakeRuntime();
  const outcome = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-attach-cleanup", message: "Clean up" }),
    runtime,
    store,
    submissionPolicy: { attachAttempts: 2, cleanupAttempts: 2, sleep: async () => undefined },
  });

  assert.equal(outcome.disposition, "ambiguous");
  assert.equal(outcome.record.status, "submission-ambiguous");
  assert.equal(runtime.calls.reset, 1);
});

test("keeps the admission reservation active when accepted-session cleanup fails", async () => {
  const store = new AttachFailureStore(3);
  const runtime = fakeRuntime({ resetError: new Error("runtime unavailable") });
  const outcome = await startAgentRun({
      accessToken: "token",
      identity: user,
      request: parseRequest({ idempotencyKey: "request-attach-stuck", message: "Keep admitted" }),
      runtime,
      store,
      submissionPolicy: { attachAttempts: 1, cleanupAttempts: 2, sleep: async () => undefined },
    });
  assert.equal(outcome.disposition, "ambiguous");
  const pending = [...store.records.values()][0];
  assert.equal(pending?.status, "submitting");
  assert.equal(runtime.calls.reset, 2);
});

test("a definitive Eve 4xx rejection becomes a failed run", async () => {
  const store = new MemoryAgentRunStore();
  const runtime = fakeRuntime({ startError: new ClientError(403, "forbidden") });
  const outcome = await startAgentRun({
    accessToken: "token",
    identity: user,
    request: parseRequest({ idempotencyKey: "request-123", message: "Rejected" }),
    runtime,
    store,
  });
  assert.equal(outcome.disposition, "rejected");
  assert.equal(outcome.record.status, "failed");
  assert.equal(outcome.record.failure?.code, "runtime-rejected");
});

function parseRequest(input: {
  readonly idempotencyKey: string;
  readonly message: string;
  readonly policy?: AgentRunPolicy;
}) {
  const parsed = parseStartAgentRun({ ...input, profile: DEFAULT_AGENT_PROFILE });
  assert.equal(parsed.ok, true);
  return parsed.value;
}

function parseInputResponse(input: unknown) {
  const parsed = parseRespondAgentRun(input);
  assert.equal(parsed.ok, true);
  return parsed.value;
}

function runningEvents(): readonly MessageStreamEvent[] {
  return [
    { type: "session.started", data: {}, meta: eventMeta(1) },
    { type: "turn.started", data: { sequence: 1, turnId: "turn-1" }, meta: eventMeta(2) },
  ];
}

function completedEvents(): readonly MessageStreamEvent[] {
  return [
    { type: "session.started", data: {}, meta: eventMeta(1) },
    { type: "turn.started", data: { sequence: 1, turnId: "turn-1" }, meta: eventMeta(2) },
    {
      type: "message.completed",
      data: { finishReason: "stop", message: "Done", sequence: 2, stepIndex: 0, turnId: "turn-1" },
      meta: eventMeta(3),
    },
    {
      type: "step.completed",
      data: {
        finishReason: "stop",
        sequence: 3,
        stepIndex: 0,
        turnId: "turn-1",
        usage: {
          cacheReadTokens: 7,
          cacheWriteTokens: 3,
          costUsd: 0.0125,
          inputTokens: 21,
          outputTokens: 8,
        },
      },
      meta: eventMeta(4),
    },
    { type: "turn.completed", data: { sequence: 4, turnId: "turn-1" }, meta: eventMeta(5) },
    waitingEvent(6),
  ];
}

function cancelledEvents(): readonly MessageStreamEvent[] {
  return [
    ...runningEvents(),
    { type: "turn.cancelled", data: { sequence: 2, turnId: "turn-1" }, meta: eventMeta(3) },
    waitingEvent(4),
  ];
}

function waitingInputEvents(requestId: string): readonly MessageStreamEvent[] {
  return [
    ...runningEvents(),
    {
      type: "input.requested",
      data: {
        requests: [{
          action: {
            callId: "call-canvas",
            input: { title: "Canvas item" },
            kind: "tool-call",
            toolName: "canvas.item.put",
          },
          display: "confirmation",
          kind: "tool-approval",
          options: [{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }],
          prompt: "Approve tool call: canvas.item.put",
          requestId,
        }],
        sequence: 2,
        stepIndex: 0,
        turnId: "turn-1",
      },
      meta: eventMeta(3),
    },
    waitingEvent(4),
  ] as unknown as readonly MessageStreamEvent[];
}

function longCompletedEvents(count: number): readonly MessageStreamEvent[] {
  const events: MessageStreamEvent[] = [
    { type: "session.started", data: {}, meta: eventMeta(1) },
    { type: "turn.started", data: { sequence: 0, turnId: "turn-long" }, meta: eventMeta(2) },
  ];
  while (events.length < count - 2) {
    const sequence = events.length + 1;
    events.push({
      type: "message.appended",
      data: {
        messageDelta: "x",
        messageSoFar: "x".repeat(sequence),
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-long",
      },
      meta: eventMeta(sequence),
    });
  }
  events.push({
    type: "message.completed",
    data: {
      finishReason: "stop",
      message: "Done",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-long",
    },
    meta: eventMeta(count - 1),
  });
  events.push(waitingEvent(count));
  return events;
}

const immediateCancellation = {
  graceMs: 0,
  now: Date.now,
  sleep: async () => undefined,
} as const;

function fakeRuntime(options: {
  readonly cancelError?: Error;
  readonly cancelStatus?: "accepted" | "no_active_turn";
  readonly events?: readonly MessageStreamEvent[];
  readonly resetError?: Error;
  readonly startError?: Error;
} = {}): AgentRunRuntime & {
  readonly calls: {
    cancel: number;
    read: number;
    readStartIndexes: number[];
    respond: number;
    inputResponses: unknown[];
    reset: number;
    start: number;
  };
} {
  const calls = {
    cancel: 0,
    inputResponses: [] as unknown[],
    read: 0,
    readStartIndexes: [] as number[],
    reset: 0,
    respond: 0,
    start: 0,
  };
  return {
    async cancel() {
      calls.cancel += 1;
      if (options.cancelError) throw options.cancelError;
      return options.cancelStatus ?? "accepted";
    },
    calls,
    async readEvents(_runId, _correlationId, _sessionId, _accessToken, startIndex = 0, limit = 200) {
      calls.read += 1;
      calls.readStartIndexes.push(startIndex);
      return (options.events ?? runningEvents()).slice(startIndex, startIndex + limit);
    },
    async respond(_runId, _correlationId, sessionId, _accessToken, inputResponses) {
      calls.respond += 1;
      calls.inputResponses.push(inputResponses);
      return { sessionId };
    },
    async reset() {
      calls.reset += 1;
      if (options.resetError) throw options.resetError;
      return "reset";
    },
    async start() {
      calls.start += 1;
      if (options.startError) throw options.startError;
      return { sessionId: `session-${calls.start}` };
    },
  };
}

class MemoryAgentRunInputStore implements AgentRunInputStore {
  readonly records = new Map<string, AgentRunInputRecord>();
  readonly byRequest = new Map<string, string>();
  nextResponse = 1;

  async find(runId: string, idempotencyKey: string) {
    return this.records.get(`${runId}:${idempotencyKey}`);
  }

  async reserve(input: Parameters<AgentRunInputStore["reserve"]>[0]): Promise<ReserveAgentRunInputResult> {
    const key = `${input.runId}:${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing) {
      return {
        record: existing,
        status: existing.requestFingerprint === input.requestFingerprint ? "replay" : "conflict",
      };
    }
    const overlapping = input.requestIds
      .map((requestId) => this.byRequest.get(`${input.runId}:${requestId}`))
      .find(Boolean);
    if (overlapping) {
      return { record: this.require(overlapping), status: "request-already-answered" };
    }
    const now = new Date().toISOString();
    const record: AgentRunInputRecord = {
      createdAt: now,
      idempotencyKey: input.idempotencyKey,
      inputResponses: input.inputResponses,
      requestFingerprint: input.requestFingerprint,
      requestIds: input.requestIds,
      responseId: `arsp-${this.nextResponse++}`,
      runId: input.runId,
      status: "submitting",
      updatedAt: now,
    };
    this.records.set(key, record);
    this.records.set(record.responseId, record);
    for (const requestId of input.requestIds) this.byRequest.set(`${input.runId}:${requestId}`, record.responseId);
    return { record, status: "reserved" };
  }

  async markAccepted(responseId: string) {
    return this.transition(responseId, "accepted");
  }

  async markFailed(responseId: string, message: string) {
    return this.transition(responseId, "failed", message);
  }

  async markSubmissionAmbiguous(responseId: string, message: string) {
    return this.transition(responseId, "submission-ambiguous", message);
  }

  private transition(responseId: string, status: AgentRunInputRecord["status"], lastError?: string) {
    const current = this.require(responseId);
    const updated = { ...current, ...(lastError ? { lastError } : {}), status, updatedAt: new Date().toISOString() };
    this.records.set(responseId, updated);
    this.records.set(`${current.runId}:${current.idempotencyKey}`, updated);
    return updated;
  }

  private require(key: string): AgentRunInputRecord {
    const record = this.records.get(key);
    if (!record) throw new Error(`Missing input response ${key}`);
    return record;
  }
}

function eventMeta(sequence: number) {
  return { at: new Date(sequence * 1_000).toISOString(), id: `evt_test_${sequence}` };
}

function waitingEvent(sequence: number): MessageStreamEvent {
  return {
    type: "session.waiting",
    data: { wait: "next-user-message" },
    meta: eventMeta(sequence),
  } as unknown as MessageStreamEvent;
}

class MemoryAgentRunStore implements AgentRunStore {
  readonly records = new Map<string, AgentRunRecord>();
  readonly idempotency = new Map<string, string>();
  nextRun = 1;

  async reserve(input: ReserveAgentRunInput): Promise<ReserveAgentRunResult> {
    const key = `${input.tenantId}:${input.principalId}:${input.idempotencyKey}`;
    const runId = this.idempotency.get(key);
    if (runId) {
      const record = this.require(runId);
      return {
        record,
        status: record.requestFingerprint === input.requestFingerprint ? "replay" : "conflict",
      };
    }
    const createdAt = new Date().toISOString();
    const record: AgentRunRecord = {
      correlationId: input.correlationId,
      createdAt,
      eventCount: 0,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
      ...(input.parent ? { parent: input.parent } : {}),
      policy: input.policy,
      principalId: input.principalId,
      profile: input.profile,
      requestFingerprint: input.requestFingerprint,
      revision: 1,
      runId: `arun_00000000-0000-4000-8000-${String(this.nextRun++).padStart(12, "0")}`,
      status: "submitting",
      tenantId: input.tenantId,
      updatedAt: createdAt,
      usage: emptyUsage(),
    };
    this.records.set(record.runId, record);
    this.idempotency.set(key, record.runId);
    return { record, status: "reserved" };
  }

  async attachSession(runId: string, sessionId: string) {
    return this.update(runId, {
      sessionId,
      status: "running",
    });
  }

  async findOwned(tenantId: string, principalId: string, runId: string) {
    const record = this.records.get(runId);
    return record?.tenantId === tenantId && record.principalId === principalId ? record : undefined;
  }

  async markCancellationRequested(runId: string) {
    const record = this.require(runId);
    return record.cancellationRequestedAt
      ? record
      : this.update(runId, { cancellationRequestedAt: new Date().toISOString() });
  }

  async markCancelled(runId: string) {
    const current = this.require(runId);
    return current.status === "cancelled"
      ? current
      : this.update(runId, { failure: undefined, result: undefined, status: "cancelled" });
  }

  async markSubmissionFailed(runId: string, message: string) {
    return this.update(runId, {
      failure: { code: "runtime-rejected", message, retryable: false },
      status: "failed",
    });
  }

  async markSubmissionAmbiguous(runId: string, message: string) {
    return this.update(runId, {
      failure: { code: "submission-ambiguous", message, retryable: false },
      status: "submission-ambiguous",
    });
  }

  async updateProjection(runId: string, projection: AgentRunProjection) {
    const current = this.require(runId);
    if (current.eventCount > projection.eventCount) return current;
    const cancellationPending = Boolean(current.cancellationRequestedAt);
    const status = isTerminal(current.status)
      ? current.status
      : cancellationPending && projection.status !== "cancelled"
        ? current.status
        : projection.status;
    return this.update(runId, {
      eventCount: Math.max(current.eventCount, projection.eventCount),
      failure: cancellationPending || status === "cancelled" ? undefined : projection.failure,
      result: cancellationPending || status === "cancelled" ? undefined : projection.result,
      status,
      usage: projection.usage,
    });
  }

  private require(runId: string): AgentRunRecord {
    const record = this.records.get(runId);
    if (!record) throw new Error("missing test AgentRun");
    return record;
  }

  private update(runId: string, patch: Partial<AgentRunRecord>): AgentRunRecord {
    const current = this.require(runId);
    const record: AgentRunRecord = {
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(runId, record);
    return record;
  }
}

class AttachFailureStore extends MemoryAgentRunStore {
  readonly failures: number;
  attachAttempts = 0;

  constructor(failures: number) {
    super();
    this.failures = failures;
  }

  override async attachSession(runId: string, sessionId: string) {
    this.attachAttempts += 1;
    if (this.attachAttempts <= this.failures) throw new Error("database unavailable");
    return super.attachSession(runId, sessionId);
  }
}

/** Simulates the row lock losing a cancellation race to a terminal update. */
class TerminalDuringCancellationStore extends MemoryAgentRunStore {
  override async markCancellationRequested(runId: string): Promise<AgentRunRecord> {
    const current = this.records.get(runId);
    if (!current) throw new Error("missing test AgentRun");
    return {
      ...current,
      failure: undefined,
      result: { kind: "text", value: "Already complete" },
      status: "completed",
      updatedAt: new Date().toISOString(),
    };
  }
}

function emptyUsage() {
  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    steps: 0,
  };
}

function isTerminal(status: AgentRunRecord["status"]): boolean {
  return status === "cancelled"
    || status === "completed"
    || status === "failed"
    || status === "submission-ambiguous";
}
