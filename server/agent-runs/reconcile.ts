import type { AgentRunRecord, AgentRunStore } from "../data/agent-run-store.ts";

export type StaleSubmissionReconcileResult = {
  readonly inspected: number;
  readonly markedAmbiguous: number;
  readonly alreadySettled: number;
  readonly failures: number;
};

/**
 * Reconcile only reservations that never obtained an Eve session id. This is
 * intentionally narrower than a generic stale-run sweeper: a long-running
 * Eve session must never be reset merely because it has not emitted an event
 * recently. Marking the reservation ambiguous prevents an unsafe blind retry
 * while releasing its admission slot for a new idempotent request.
 */
export async function reconcileStaleSubmissions(options: {
  readonly limit: number;
  readonly olderThanMs: number;
  readonly store: AgentRunStore;
}): Promise<StaleSubmissionReconcileResult> {
  if (!options.store.listStaleSubmissions) {
    return { inspected: 0, markedAmbiguous: 0, alreadySettled: 0, failures: 0 };
  }
  const candidates = (await options.store.listStaleSubmissions(options.olderThanMs, options.limit))
    .filter((record) => record.status === "submitting");
  let markedAmbiguous = 0;
  let alreadySettled = 0;
  let failures = 0;
  for (const record of candidates) {
    try {
      const next = await options.store.markSubmissionAmbiguous(
        record.runId,
        "The Agent process did not receive an Eve session handle before the submission timeout. The request was not retried automatically.",
      );
      if (next.status === "submission-ambiguous") markedAmbiguous += 1;
      else alreadySettled += 1;
    } catch {
      failures += 1;
    }
  }
  return {
    inspected: candidates.length,
    markedAmbiguous,
    alreadySettled,
    failures,
  };
}

export function isStaleSubmission(record: AgentRunRecord, now: number, olderThanMs: number): boolean {
  const updatedAt = Date.parse(record.updatedAt);
  return record.status === "submitting" && Number.isFinite(updatedAt) && now - updatedAt >= olderThanMs;
}
