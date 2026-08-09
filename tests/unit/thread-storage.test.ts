import assert from "node:assert/strict";
import test from "node:test";

import { compactThreadEvents, parseThreadCollection } from "@oworker/open-agent-ui/agent-workspace";

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

test("preserves non-delta ordering barriers while compacting adjacent cumulative deltas", () => {
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
    "message.appended",
  ]);
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
        { delivery: "server", id: "committed-1", intent: "active-turn", mailboxItemId: "mail-1", state: "committed", submittedAt: 4, text: "Durably admitted" },
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
    { delivery: "server", id: "committed-1", intent: "active-turn", mailboxItemId: "mail-1", state: "committed", submittedAt: 4, text: "Durably admitted" },
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
