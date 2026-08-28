export const TERMINAL_WORKFLOW_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;

export type WorkflowRetentionStatus = (typeof TERMINAL_WORKFLOW_STATUSES)[number];

export type WorkflowRetentionRun = {
  readonly id: string;
  readonly rootRunId: string;
  readonly status: string;
  readonly completedAt: Date | null;
};

export type WorkflowRetentionPolicy = {
  readonly maxRuns: number;
  readonly olderThanMs: number;
  readonly protectedRunIds?: ReadonlySet<string>;
};

export type WorkflowRetentionSelection = {
  readonly cutoff: Date;
  readonly candidates: readonly WorkflowRetentionRun[];
  readonly candidateRootIds: readonly string[];
  /** Root trees skipped because at least one member is still active. */
  readonly activeRootIds: readonly string[];
  /** Root trees skipped because an operator or live hook protects them. */
  readonly protectedRootIds: readonly string[];
  readonly skippedActiveRoots: number;
  readonly skippedProtected: number;
};

/**
 * Selects complete terminal root trees. A retention/archive batch must never
 * split one Eve session tree: child runs are replay dependencies of the root,
 * even when each row is terminal by itself. This is a pure decision boundary
 * so SQL, audit output, and tests share one policy.
 */
export function selectWorkflowRetentionCandidates(
  runs: readonly WorkflowRetentionRun[],
  now: Date,
  policy: WorkflowRetentionPolicy,
): WorkflowRetentionSelection {
  assertDate(now, "now");
  if (!Number.isSafeInteger(policy.maxRuns) || policy.maxRuns < 1 || policy.maxRuns > 10_000) {
    throw new RangeError("maxRuns must be an integer from 1 to 10000.");
  }
  if (!Number.isSafeInteger(policy.olderThanMs) || policy.olderThanMs < 60_000) {
    throw new RangeError("olderThanMs must be at least one minute.");
  }

  const cutoff = new Date(now.getTime() - policy.olderThanMs);
  const protectedRunIds = policy.protectedRunIds ?? new Set<string>();
  const byRoot = new Map<string, WorkflowRetentionRun[]>();
  for (const run of runs) {
    const rootId = run.rootRunId || run.id;
    const rootRuns = byRoot.get(rootId) ?? [];
    rootRuns.push(run);
    byRoot.set(rootId, rootRuns);
  }
  const terminal = new Set<string>(TERMINAL_WORKFLOW_STATUSES);
  const activeRoots = new Set<string>();
  const protectedRoots = new Set<string>();
  const eligibleRoots: { completedAt: number; rootId: string; runs: WorkflowRetentionRun[] }[] = [];
  for (const [rootId, rootRuns] of byRoot) {
    if (rootRuns.some((run) => !terminal.has(run.status))) {
      activeRoots.add(rootId);
      continue;
    }
    if (protectedRunIds.has(rootId) || rootRuns.some((run) => protectedRunIds.has(run.id))) {
      protectedRoots.add(rootId);
      continue;
    }
    const completedTimes = rootRuns.map((run) => run.completedAt?.getTime() ?? Number.POSITIVE_INFINITY);
    const newestCompletion = Math.max(...completedTimes);
    if (newestCompletion > cutoff.getTime()) continue;
    eligibleRoots.push({ completedAt: newestCompletion, rootId, runs: rootRuns });
  }
  eligibleRoots.sort((left, right) => left.completedAt - right.completedAt || left.rootId.localeCompare(right.rootId));
  const selectedRoots = eligibleRoots.slice(0, policy.maxRuns);
  const candidates = selectedRoots.flatMap((root) => root.runs);
  return {
    cutoff,
    candidates,
    candidateRootIds: selectedRoots.map((root) => root.rootId),
    activeRootIds: [...activeRoots].sort((left, right) => left.localeCompare(right)),
    protectedRootIds: [...protectedRoots].sort((left, right) => left.localeCompare(right)),
    skippedActiveRoots: activeRoots.size,
    skippedProtected: protectedRoots.size,
  };
}

export function isTerminalStatus(value: string): value is WorkflowRetentionStatus {
  return (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(value);
}

function assertDate(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date.`);
  }
}
