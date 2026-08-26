import assert from "node:assert/strict";
import test from "node:test";

import { reconcileStaleSubmissions } from "../../server/agent-runs/reconcile.ts";
import type { AgentRunRecord, AgentRunStore } from "../../server/data/agent-run-store.ts";

test("reconciler marks only stale pre-Eve reservations ambiguous", async () => {
  const marked: string[] = [];
  const candidate = record("arun-stale", "submitting");
  const settled = record("arun-raced", "completed");
  const store = {
    listStaleSubmissions: async () => [candidate, settled],
    markSubmissionAmbiguous: async (runId: string) => {
      marked.push(runId);
      return { ...candidate, runId, status: "submission-ambiguous" as const };
    },
  } as unknown as AgentRunStore;

  const result = await reconcileStaleSubmissions({ limit: 10, olderThanMs: 120_000, store });

  assert.deepEqual(marked, [candidate.runId]);
  assert.equal(result.inspected, 1);
  assert.equal(result.markedAmbiguous, 1);
  assert.equal(result.failures, 0);
});

test("reconciler is a no-op for stores without the optional query", async () => {
  const result = await reconcileStaleSubmissions({
    limit: 10,
    olderThanMs: 120_000,
    store: {} as AgentRunStore,
  });
  assert.deepEqual(result, { inspected: 0, markedAmbiguous: 0, alreadySettled: 0, failures: 0 });
});

function record(runId: string, status: AgentRunRecord["status"]): AgentRunRecord {
  return {
    correlationId: `corr-${runId}`,
    createdAt: new Date(0).toISOString(),
    eventCount: 0,
    idempotencyKey: runId,
    metadata: {},
    policy: {},
    principalId: "principal-1",
    profile: { profileId: "general-purpose", version: "0.1.0" },
    requestFingerprint: `fingerprint-${runId}`,
    revision: 1,
    runId,
    status,
    tenantId: "tenant-1",
    updatedAt: new Date(0).toISOString(),
    usage: { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, steps: 0 },
  };
}
