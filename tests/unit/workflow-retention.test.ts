import test from "node:test";
import assert from "node:assert/strict";

import {
  selectWorkflowRetentionCandidates,
} from "../../lib/workflow-retention.ts";

const now = new Date("2026-08-24T00:00:00.000Z");
const old = new Date("2026-08-10T00:00:00.000Z");

test("retention selects only old terminal runs", () => {
  const result = selectWorkflowRetentionCandidates([
    { id: "old", rootRunId: "old", status: "completed", completedAt: old },
    { id: "new", rootRunId: "new", status: "completed", completedAt: new Date("2026-08-23T00:00:00.000Z") },
    { id: "active", rootRunId: "active", status: "running", completedAt: null },
  ], now, { maxRuns: 10, olderThanMs: 7 * 24 * 60 * 60 * 1_000 });
  assert.deepEqual(result.candidates.map((run) => run.id), ["old"]);
});

test("retention protects terminal children of an active root", () => {
  const result = selectWorkflowRetentionCandidates([
    { id: "turn", rootRunId: "root", status: "completed", completedAt: old },
    { id: "root", rootRunId: "root", status: "running", completedAt: null },
  ], now, { maxRuns: 10, olderThanMs: 7 * 24 * 60 * 60 * 1_000 });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.skippedActiveRoots, 1);
});

test("retention protects explicitly retained roots and caps work", () => {
  const result = selectWorkflowRetentionCandidates([
    { id: "a", rootRunId: "a", status: "failed", completedAt: old },
    { id: "b", rootRunId: "b", status: "cancelled", completedAt: old },
  ], now, {
    maxRuns: 1,
    olderThanMs: 7 * 24 * 60 * 60 * 1_000,
    protectedRunIds: new Set(["a"]),
  });
  assert.deepEqual(result.candidates.map((run) => run.id), ["b"]);
  assert.equal(result.skippedProtected, 1);
});
