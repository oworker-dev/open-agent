import assert from "node:assert/strict";
import test from "node:test";

import { createAgentThread } from "@oworker/open-agent-ui/agent-workspace";
import {
  applyThreadCollectionPatch,
  parseThreadCollectionPatch,
  summarizeThreadCollection,
} from "../../server/http/thread-collection-contract.ts";

test("thread indexes omit inactive transcripts and retain the requested thread", () => {
  const first = { ...createAgentThread(1, "First"), events: [event("evt-first")] };
  const second = { ...createAgentThread(2, "Second"), events: [event("evt-second")] };
  const summary = summarizeThreadCollection(
    { activeThreadId: second.id, threads: [second, first], version: 2 },
    first.id,
  );

  assert.equal(summary.threads[0]?.hydration, "summary");
  assert.equal(summary.threads[0]?.events.length, 0);
  assert.equal(summary.threads[1]?.hydration, undefined);
  assert.equal(summary.threads[1]?.events.length, 1);
});

test("thread indexes hydrate a selected thread whose cursor is ahead of its transcript", () => {
  const incomplete = {
    ...createAgentThread(1, "Incomplete"),
    events: [event("evt-prefix")],
    session: { sessionId: "session-incomplete", streamIndex: 12803 },
  };
  const summary = summarizeThreadCollection(
    { activeThreadId: incomplete.id, threads: [incomplete], version: 2 },
    incomplete.id,
  );

  assert.equal(summary.threads[0]?.hydration, "summary");
  assert.equal(summary.threads[0]?.events.length, 0);
});

test("thread indexes keep a covered selected transcript inline", () => {
  const complete = {
    ...createAgentThread(1, "Complete"),
    events: [event("evt-only")],
    session: { sessionId: "session-complete", streamIndex: 12803 },
    transcriptCoverage: { authoritative: true, complete: true, endIndex: 12803, startIndex: 0, version: 1 as const },
  };
  const summary = summarizeThreadCollection(
    { activeThreadId: complete.id, threads: [complete], version: 2 },
    complete.id,
  );

  assert.equal(summary.threads[0]?.hydration, undefined);
  assert.equal(summary.threads[0]?.events.length, 1);
});

test("thread indexes hydrate a covered selected thread when the index omits its event log", () => {
  const complete = {
    ...createAgentThread(1, "Complete"),
    events: [],
    session: { sessionId: "session-complete", streamIndex: 12803 },
    transcriptCoverage: { complete: true, endIndex: 12803, startIndex: 0, version: 1 as const },
  };
  const summary = summarizeThreadCollection(
    { activeThreadId: complete.id, threads: [complete], version: 2 },
    complete.id,
  );

  assert.equal(summary.threads[0]?.hydration, "summary");
  assert.equal(summary.threads[0]?.events.length, 0);
});

test("thread patches update only touched threads while retaining server histories", () => {
  const first = { ...createAgentThread(1, "First"), events: [event("evt-first")] };
  const second = { ...createAgentThread(2, "Second"), events: [event("evt-second")] };
  const updatedSecond = { ...second, title: "Updated", updatedAt: 3 };
  const patch = parseThreadCollectionPatch({
    activeThreadId: second.id,
    deletedThreadIds: [],
    upsertThreads: [updatedSecond],
    version: 2,
  });
  assert.ok(patch);

  const result = applyThreadCollectionPatch(
    { activeThreadId: first.id, threads: [first, second], version: 2 },
    patch,
  );
  assert.equal(result.threads[0]?.events[0]?.meta.id, "evt-first");
  assert.equal(result.threads[1]?.title, "Updated");
  assert.equal(result.activeThreadId, second.id);
});

test("thread patches can append a streamed event without sending the existing transcript", () => {
  const first = { ...createAgentThread(1, "First"), events: [event("evt-first")] };
  const streamed = {
    data: { sequence: 1, turnId: "turn-1" },
    meta: { at: new Date(0).toISOString(), id: "evt-second" },
    type: "step.started" as const,
  };
  const patch = parseThreadCollectionPatch({
    activeThreadId: first.id,
    deletedThreadIds: [],
    eventAppends: [{ events: [streamed], threadId: first.id }],
    upsertThreads: [{ ...first, events: [], hydration: "summary" }],
    version: 2,
  });
  assert.ok(patch);

  const result = applyThreadCollectionPatch(
    { activeThreadId: first.id, threads: [first], version: 2 },
    patch,
  );
  assert.deepEqual(result.threads[0]?.events.map((item) => item.meta.id), ["evt-first", "evt-second"]);
});

test("summary patches clear a stale pending edit instead of resurrecting it", () => {
  const first = {
    ...createAgentThread(1, "First"),
    pendingTurn: {
      id: "pending-edit",
      state: "clearing" as const,
      submittedAt: 2,
      text: "updated prompt",
    },
  };
  const replacement = {
    ...first,
    pendingTurn: undefined,
    status: "ready" as const,
    updatedAt: 3,
  };
  const patch = parseThreadCollectionPatch({
    activeThreadId: first.id,
    deletedThreadIds: [],
    upsertThreads: [{ ...replacement, events: [], hydration: "summary" }],
    version: 2,
  });
  assert.ok(patch);

  const result = applyThreadCollectionPatch(
    { activeThreadId: first.id, threads: [first], version: 2 },
    patch,
  );
  assert.equal(result.threads[0]?.pendingTurn, undefined);
  assert.equal(result.threads[0]?.status, "ready");
});

test("summary checkpoints cannot downgrade authoritative transcript coverage", () => {
  const first = {
    ...createAgentThread(1, "First"),
    events: [event("evt-first")],
    session: { sessionId: "session-first", streamIndex: 12803 },
    transcriptCoverage: { authoritative: true, complete: true, endIndex: 12803, startIndex: 0, version: 1 as const },
  };
  const replacement = {
    ...first,
    // This is the shape emitted by a browser live checkpoint. It is not
    // allowed to replace the server's finite-transcript proof.
    transcriptCoverage: { complete: true, endIndex: 12803, startIndex: 0, version: 1 as const },
    updatedAt: 2,
  };
  const patch = parseThreadCollectionPatch({
    activeThreadId: first.id,
    deletedThreadIds: [],
    upsertThreads: [{ ...replacement, events: [], hydration: "summary" }],
    version: 2,
  });
  assert.ok(patch);
  const result = applyThreadCollectionPatch(
    { activeThreadId: first.id, threads: [first], version: 2 },
    patch,
  );
  assert.equal(result.threads[0]?.transcriptCoverage?.authoritative, true);
});

function event(id: string) {
  return {
    data: {
      runtime: {
        agentId: "open-agent",
        eveVersion: "test",
        modelId: "test/model",
      },
    },
    meta: { at: new Date(0).toISOString(), id },
    type: "session.started" as const,
  };
}
