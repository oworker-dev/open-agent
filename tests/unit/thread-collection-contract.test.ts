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
