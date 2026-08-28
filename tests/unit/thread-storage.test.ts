import assert from "node:assert/strict";
import test from "node:test";
import type { MessageStreamEvent } from "eve/client";

import {
  appendThreadEventIndexed,
  compactThreadEvents,
  dedupeThreadEvents,
  eventIdentity,
  mergeThreadCollectionsForConflict,
  parseThreadCollection,
  reconcileHydratedPendingTurn,
  reconcilePendingTurnWithEvents,
} from "@oworker/open-agent-ui/agent-workspace";

test("deduplicates exact replayed events without collapsing distinct lifecycle events", () => {
  const at = new Date().toISOString();
  const event = {
    data: { sequence: 0, stepIndex: 0, turnId: "turn-0" },
    meta: { at },
    type: "step.started" as const,
  } as unknown as MessageStreamEvent;
  const distinct = { ...event, meta: { at: new Date(Date.parse(at) + 1).toISOString() } } as unknown as MessageStreamEvent;
  assert.deepEqual(dedupeThreadEvents([event, event, distinct]).map((candidate) => candidate.meta.at), [
    at,
    distinct.meta.at,
  ]);
});

test("uses Eve's durable event id even when a replay payload is normalized", () => {
  const first = {
    data: { message: "before normalization", sequence: 0 },
    meta: { at: new Date().toISOString(), id: "durable-event-1" },
    type: "message.received" as const,
  } as unknown as MessageStreamEvent;
  const replay = {
    ...first,
    data: { message: "after normalization", sequence: 0 },
    meta: { ...first.meta, at: new Date(Date.now() + 1_000).toISOString() },
  } as unknown as MessageStreamEvent;

  assert.equal(eventIdentity(first), eventIdentity(replay));
  assert.equal(dedupeThreadEvents([first, replay]).length, 1);
});

test("legacy id-less lifecycle events remain distinct while exact replays deduplicate", () => {
  const at = new Date(0).toISOString();
  const source = [
    { data: { runtime: { agentId: "open-agent" } }, meta: { at }, type: "session.started" },
    { data: { sequence: 0, turnId: "turn-legacy" }, meta: { at }, type: "turn.started" },
    { data: { message: "Run", parts: [], sequence: 0, turnId: "turn-legacy" }, meta: { at }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId: "turn-legacy" }, meta: { at }, type: "step.started" },
  ] as unknown as MessageStreamEvent[];
  const events: MessageStreamEvent[] = [];
  const ids = new Set<string>();

  for (const event of source) assert.equal(appendThreadEventIndexed(events, ids, event), true);
  for (const event of source) assert.equal(appendThreadEventIndexed(events, ids, event), false);

  assert.deepEqual(events.map((event) => event.type), source.map((event) => event.type));
});

test("pending edit reconciliation is anchored to the latest accepted message", () => {
  const pending = {
    id: "pending-edit",
    state: "clearing" as const,
    submittedAt: 10_000,
    text: "same prompt",
  };
  const received = (message: string, id: string) => ({
    data: { clientMessageId: id, message, parts: [], sequence: 0, turnId: id },
    meta: { at: new Date(20_000).toISOString(), id: `evt-${id}` },
    type: "message.received" as const,
  });
  const oldReceived = { ...received("same prompt", "old"), meta: { at: new Date(0).toISOString(), id: "evt-old" } };
  assert.deepEqual(reconcilePendingTurnWithEvents(pending, [oldReceived]), pending);
  assert.equal(reconcilePendingTurnWithEvents(pending, [received("same prompt", "old"), received("same prompt", "pending-edit")]), undefined);
  assert.equal(reconcileHydratedPendingTurn(pending, [received("different", "other")])?.state, "delivery-failed");
});

test("does not acknowledge a same-text pending turn with another client message id", () => {
  const pending = {
    id: "pending-new",
    state: "submitting" as const,
    submittedAt: 10_000,
    text: "same prompt",
  };
  const received = {
    data: { clientMessageId: "pending-old", message: "same prompt", parts: [], sequence: 0, turnId: "turn-old" },
    meta: { at: new Date(10_100).toISOString(), id: "evt-old" },
    type: "message.received" as const,
  } as unknown as MessageStreamEvent;

  assert.deepEqual(reconcilePendingTurnWithEvents(pending, [received]), pending);
});

test("hydration never silently resends an unacknowledged submitting turn", () => {
  const pending = {
    id: "pending-refresh",
    state: "submitting" as const,
    submittedAt: 10_000,
    text: "品牌名称改成妙思",
  };
  const history = [{
    data: { message: "上一条消息", parts: [], sequence: 0, turnId: "turn-old" },
    meta: { at: new Date(9_000).toISOString(), id: "evt-old" },
    type: "message.received" as const,
  }] as unknown as MessageStreamEvent[];
  assert.equal(reconcileHydratedPendingTurn(pending, history)?.state, "delivery-failed");
});

test("compacts legacy cumulative deltas without changing the absolute stream cursor", () => {
  const at = new Date().toISOString();
  const events = Array.from({ length: 1_000 }, (_, index) => ({
    data: {
      messageDelta: "x",
      messageSoFar: "x".repeat(index + 1),
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    },
    meta: { at, id: `evt_${index}` },
    type: "message.appended",
  }));
  const collection = parseThreadCollection({
    activeThreadId: "thread-0",
    threads: [{
      createdAt: 1,
      events,
      id: "thread-0",
      preferences: { modelId: "model", reasoning: "medium" },
      session: { sessionId: "session-0", streamIndex: events.length },
      status: "streaming",
      title: "Thread",
      updatedAt: 1,
    }],
    version: 1,
  });

  assert.equal(collection.threads[0]?.events.length, 1);
  assert.equal(collection.threads[0]?.session.streamIndex, 1_000);
});

test("keeps the first visual anchor when cumulative deltas arrive after an interleaved event", () => {
  const at = new Date().toISOString();
  let sequence = 0;
  const appended = (messageSoFar: string) => ({
    data: { messageDelta: "x", messageSoFar, sequence: 0, stepIndex: 0, turnId: "turn_0" },
    meta: { at, id: `evt_append_${sequence++}` },
    type: "message.appended",
  }) as const;
  const barrier = {
    data: { sequence: 0, stepIndex: 1, turnId: "turn_0" },
    meta: { at, id: "evt_barrier" },
    type: "step.started",
  } as const;

  const compacted = compactThreadEvents([
    appended("one"),
    appended("one two"),
    barrier,
    appended("one two three"),
  ]);

  assert.deepEqual(compacted.map((event) => event.type), [
    "message.appended",
    "step.started",
  ]);
  assert.equal(compacted[0]?.type, "message.appended");
  if (compacted[0]?.type === "message.appended") {
    assert.equal(compacted[0].data.messageSoFar, "one two three");
  }
});

test("indexed recovery keeps reasoning anchored before tools across interleaved deltas", () => {
  const events: Parameters<typeof appendThreadEventIndexed>[0] = [];
  const ids = new Set<string>();
  const append = (id: string, type: "reasoning.appended" | "actions.requested", data: Record<string, unknown>) => {
    appendThreadEventIndexed(events, ids, {
      data,
      meta: { at: new Date(0).toISOString(), id },
      type,
    } as MessageStreamEvent);
  };
  append("reasoning-1", "reasoning.appended", {
    reasoningDelta: "Planning",
    reasoningSoFar: "Planning",
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-order",
  });
  append("tool-request", "actions.requested", {
    actions: [{ callId: "call-1", input: {}, kind: "tool-call", toolName: "bash" }],
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-order",
  });
  append("reasoning-2", "reasoning.appended", {
    reasoningDelta: " verification",
    reasoningSoFar: "Planning verification",
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-order",
  });
  assert.deepEqual(events.map((event) => event.type), ["reasoning.appended", "actions.requested"]);
  assert.equal(events[0]?.type, "reasoning.appended");
  if (events[0]?.type === "reasoning.appended") {
    assert.equal(events[0].data.reasoningSoFar, "Planning verification");
  }
});

test("keeps reasoning and message anchors when completion follows tool events", () => {
  const at = new Date().toISOString();
  const reasoning = {
    data: {
      reasoningDelta: "Planning the verification",
      reasoningSoFar: "Planning the verification",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-boundary-order",
    },
    meta: { at, id: "reasoning-anchor" },
    type: "reasoning.appended" as const,
  };
  const tool = {
    data: {
      actions: [{ callId: "call-check", input: { command: "pwd" }, kind: "tool-call", toolName: "bash" }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-boundary-order",
    },
    meta: { at, id: "tool-request" },
    type: "actions.requested" as const,
  };
  const completed = {
    data: {
      reasoning: "Planning the verification",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-boundary-order",
    },
    meta: { at, id: "reasoning-completed" },
    type: "reasoning.completed" as const,
  };
  const source = [reasoning, tool, completed] as unknown as MessageStreamEvent[];
  const compacted = compactThreadEvents(source);
  assert.deepEqual(compacted.map((event) => event.type), [
    "reasoning.appended",
    "actions.requested",
    "reasoning.completed",
  ]);

  const indexed: Parameters<typeof appendThreadEventIndexed>[0] = [];
  const ids = new Set<string>();
  for (const event of source) appendThreadEventIndexed(indexed, ids, event);
  assert.deepEqual(indexed.map((event) => event.type), compacted.map((event) => event.type));
});

test("compacts cumulative tool input snapshots without losing the final argument", () => {
  const at = new Date().toISOString();
  const events = Array.from({ length: 2_000 }, (_, index) => ({
    data: {
      callId: "call-write",
      inputTextSoFar: JSON.stringify({ path: "index.html", content: "x".repeat(index + 1) }),
      sequence: 0,
      stepIndex: 0,
      toolName: "write_file",
      turnId: "turn-tool",
    },
    meta: { at, id: `tool-input-${index}` },
    type: "action.input.partial" as const,
  }));

  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events,
      id: "thread-tool",
      preferences: { modelId: "model", reasoning: "medium" },
      session: { streamIndex: events.length },
      status: "streaming",
      title: "Tool",
      updatedAt: 1,
    }],
    version: 2,
  });

  assert.equal(collection.threads[0]?.events.length, 1);
  const compactedToolEvent = collection.threads[0]?.events[0];
  assert.equal(compactedToolEvent?.type, "action.input.partial");
  if (compactedToolEvent?.type === "action.input.partial") {
    assert.equal(compactedToolEvent.data.inputTextSoFar, events.at(-1)?.data.inputTextSoFar);
  }
  assert.equal(collection.threads[0]?.session.streamIndex, events.length);
});

test("indexed recovery append deduplicates and replaces cumulative tool snapshots in linear time", () => {
  const events: Parameters<typeof appendThreadEventIndexed>[0] = [];
  const ids = new Set<string>();
  for (let index = 0; index < 1_000; index += 1) {
    appendThreadEventIndexed(events, ids, {
      data: {
        callId: "call-1",
        inputTextDelta: String(index),
        inputTextSoFar: String(index),
        sequence: 0,
        stepIndex: 0,
        toolName: "write_file",
        turnId: "turn-1",
      },
      meta: { at: new Date(0).toISOString(), id: `event-${index}` },
      type: "action.input.partial",
    } as Extract<import("eve/client").MessageStreamEvent, { type: "action.input.partial" }>);
  }
  assert.equal(events.length, 1);
  const last = events[0];
  assert.equal(last?.type, "action.input.partial");
  if (last?.type === "action.input.partial") assert.equal(last.data.inputTextSoFar, "999");
  assert.equal(appendThreadEventIndexed(events, ids, events[0]!), false);
});

test("preserves cumulative reasoning from a failed attempt when Eve retries the same step", () => {
  const event = (
    id: string,
    type: "step.started" | "reasoning.appended" | "step.failed",
    data: Record<string, unknown>,
  ) => ({
    data,
    meta: { at: new Date(0).toISOString(), id },
    type,
  }) as unknown as MessageStreamEvent;
  const compacted = compactThreadEvents([
    event("start-1", "step.started", { sequence: 0, stepIndex: 0, turnId: "turn-retry" }),
    event("reasoning-1", "reasoning.appended", {
      reasoningDelta: "Planning",
      reasoningSoFar: "Planning",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-retry",
    }),
    event("failed-1", "step.failed", {
      code: "UPSTREAM_ERROR",
      message: "temporary provider failure",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-retry",
    }),
    event("start-2", "step.started", { sequence: 0, stepIndex: 0, turnId: "turn-retry" }),
    event("reasoning-2", "reasoning.appended", {
      reasoningDelta: "Inspecting",
      reasoningSoFar: "Inspecting",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-retry",
    }),
    event("reasoning-3", "reasoning.appended", {
      reasoningDelta: " the workspace",
      reasoningSoFar: "Inspecting the workspace",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-retry",
    }),
  ]);

  assert.deepEqual(compacted.map((candidate) => candidate.meta.id), [
    "start-1",
    "reasoning-1",
    "failed-1",
    "start-2",
    "reasoning-3",
  ]);
  assert.equal(compacted[1]?.type, "reasoning.appended");
  assert.equal(compacted[4]?.type, "reasoning.appended");
  if (compacted[4]?.type === "reasoning.appended") {
    assert.equal(compacted[4].data.reasoningSoFar, "Inspecting the workspace");
  }
});

test("preserves a reset tool-input snapshot even when the retry boundary is missing", () => {
  const event = (id: string, inputTextSoFar: string) => ({
    data: {
      callId: "call-patch",
      inputTextDelta: inputTextSoFar,
      inputTextSoFar,
      sequence: 0,
      stepIndex: 0,
      toolName: "apply_patch",
      turnId: "turn-tool-retry",
    },
    meta: { at: new Date(0).toISOString(), id },
    type: "action.input.partial" as const,
  }) as unknown as MessageStreamEvent;
  const source = [
    event("input-1", "{\"patch\":\"*** Begin Patch"),
    event("input-2", "{\"patch\":\"rewrite\"}"),
  ];
  const compacted = compactThreadEvents(source);

  assert.equal(compacted.length, 2);
  assert.deepEqual(compacted.map((candidate) => candidate.meta.id), ["input-1", "input-2"]);

  const indexed: MessageStreamEvent[] = [];
  const ids = new Set<string>();
  for (const item of source) appendThreadEventIndexed(indexed, ids, item);
  assert.equal(indexed.length, 2);
});

test("conflict merge never replaces a complete remote transcript with a compact local prefix", () => {
  const event = (id: string, type: "step.started" | "reasoning.appended", stepIndex: number) => ({
    data: type === "step.started"
      ? { sequence: stepIndex, stepIndex, turnId: "turn-merge" }
      : {
          reasoningDelta: "x",
          reasoningSoFar: "x",
          sequence: stepIndex,
          stepIndex,
          turnId: "turn-merge",
        },
    meta: { at: new Date(0).toISOString(), id },
    type,
  }) as unknown as MessageStreamEvent;
  const remoteEvents = [event("step-0", "step.started", 0), event("reasoning-0", "reasoning.appended", 0), event("step-1", "step.started", 1)];
  const localEvents = [event("step-0", "step.started", 0)];
  const base = {
    closedInputRequestIds: [],
    createdAt: 1,
    id: "thread-merge",
    preferences: { executionMode: "standard" as const, modelId: "model", reasoning: "medium" },
    queuedTurns: [],
    revision: 1,
    session: { sessionId: "session", streamIndex: 3 },
    status: "ready" as const,
    title: "Merge",
    updatedAt: 2,
  };
  const merged = mergeThreadCollectionsForConflict(
    { threads: [{ ...base, events: localEvents }], version: 2 },
    { threads: [{ ...base, events: remoteEvents, updatedAt: 3 }], version: 2 },
  );
  assert.deepEqual(merged.threads[0]?.events.map((candidate) => candidate.meta.id), [
    "step-0",
    "reasoning-0",
    "step-1",
  ]);
  assert.equal(merged.threads[0]?.session.streamIndex, 3);
});

test("hydrates queued follow-ups from the v2 collection without accepting malformed entries", () => {
  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events: [],
      id: "thread-queued",
      preferences: { modelId: "model", reasoning: "medium" },
      queuedTurns: [
        { id: "queued-1", state: "queued", submittedAt: 2, text: "Continue" },
        { id: "invalid", state: "delivering", submittedAt: 3, text: "Do not send" },
        { delivery: "server", expectedTurnId: "turn-1", id: "committed-1", intent: "active-turn", mailboxItemId: "mail-1", state: "committed", submittedAt: 4, text: "Durably admitted" },
        { delivery: "browser", id: "post-cancel-1", intent: "post-cancellation", state: "queued", submittedAt: 5, text: "Continue after stop" },
      ],
      session: { streamIndex: 0 },
      status: "ready",
      title: "Queued",
      updatedAt: 1,
    }],
    version: 2,
  });

  assert.deepEqual(collection.threads[0]?.queuedTurns, [
    { id: "queued-1", state: "queued", submittedAt: 2, text: "Continue" },
    { delivery: "server", expectedTurnId: "turn-1", id: "committed-1", intent: "active-turn", mailboxItemId: "mail-1", state: "committed", submittedAt: 4, text: "Durably admitted" },
    { delivery: "browser", id: "post-cancel-1", intent: "post-cancellation", state: "queued", submittedAt: 5, text: "Continue after stop" },
  ]);
});

test("hydrates only a valid one-shot composer draft restoration", () => {
  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      draftRestore: { id: "draft-restore-1", text: "Continue with the blue variant" },
      events: [],
      id: "thread-draft-restore",
      preferences: { modelId: "model", reasoning: "medium" },
      queuedTurns: [],
      session: { streamIndex: 0 },
      status: "ready",
      title: "Thread",
      updatedAt: 2,
    }],
    version: 2,
  });

  assert.deepEqual(collection.threads[0]?.draftRestore, {
    id: "draft-restore-1",
    text: "Continue with the blue variant",
  });
});

test("hydrates only bounded valid interrupted-turn markers", () => {
  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events: [],
      id: "thread-interrupted-turns",
      interruptedTurns: [
        { eventCount: 12, streamIndex: 120, turnId: "turn-valid" },
        { eventCount: -1, streamIndex: 121, turnId: "turn-negative" },
        { eventCount: 14.5, streamIndex: 122, turnId: "turn-fractional" },
        { eventCount: 15, streamIndex: 123, turnId: "" },
        { eventCount: 16, streamIndex: -1, turnId: "turn-stream-negative" },
        { eventCount: 18, streamIndex: 128, turnId: "turn-valid" },
      ],
      preferences: { modelId: "model", reasoning: "medium" },
      queuedTurns: [],
      session: { streamIndex: 0 },
      status: "cancelling",
      title: "Interrupted",
      updatedAt: 2,
    }],
    version: 2,
  });

  assert.deepEqual(collection.threads[0]?.interruptedTurns, [
    { eventCount: 18, streamIndex: 128, turnId: "turn-valid" },
  ]);
});

test("hydrates bounded retained context used after an edited turn", () => {
  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events: [],
      id: "thread-context",
      preferences: { modelId: "model", reasoning: "medium" },
      retainedContext: ["User: Keep the original architecture", "Assistant: The architecture is retained."],
      session: { streamIndex: 0 },
      status: "ready",
      title: "Context",
      updatedAt: 1,
    }],
    version: 2,
  });

  assert.deepEqual(collection.threads[0]?.retainedContext, [
    "User: Keep the original architecture",
    "Assistant: The architecture is retained.",
  ]);
});

test("hydrates transcript coverage only when its absolute cursor is valid", () => {
  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events: [],
      id: "thread-coverage",
      preferences: { modelId: "model", reasoning: "medium" },
      session: { sessionId: "session-coverage", streamIndex: 12803 },
      status: "ready",
      title: "Coverage",
      transcriptCoverage: { complete: true, endIndex: 12803, startIndex: 0, version: 1 },
      updatedAt: 1,
    }],
    version: 2,
  });

  assert.deepEqual(collection.threads[0]?.transcriptCoverage, {
    complete: true,
    endIndex: 12803,
    startIndex: 0,
    version: 1,
  });

  const invalid = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events: [],
      id: "thread-invalid-coverage",
      preferences: { modelId: "model", reasoning: "medium" },
      session: { streamIndex: 10 },
      status: "ready",
      title: "Invalid coverage",
      transcriptCoverage: { complete: true, endIndex: 9, startIndex: 10, version: 1 },
      updatedAt: 1,
    }],
    version: 2,
  });
  assert.equal(invalid.threads[0]?.transcriptCoverage, undefined);
});

test("preserves validated attachments for a durable edited-turn retry", () => {
  const collection = parseThreadCollection({
    threads: [{
      createdAt: 1,
      events: [],
      id: "thread-edit-attachment",
      pendingTurn: {
        files: [
          { filename: "reference.png", mediaType: "image/png", url: "data:image/png;base64,AA==" },
          { filename: "invalid.png", mediaType: "image/png" },
        ],
        id: "pending-edit",
        state: "resubmitting",
        submittedAt: 2,
        text: "",
      },
      preferences: { modelId: "model", reasoning: "medium" },
      session: { sessionId: "session-edit", streamIndex: 0 },
      status: "submitted",
      title: "Attachment edit",
      updatedAt: 1,
    }],
    version: 2,
  });

  assert.deepEqual(collection.threads[0]?.pendingTurn, {
    files: [{ filename: "reference.png", mediaType: "image/png", url: "data:image/png;base64,AA==" }],
    id: "pending-edit",
    state: "resubmitting",
    submittedAt: 2,
    text: "",
  });
});
