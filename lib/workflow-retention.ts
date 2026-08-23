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
  readonly skippedActiveRoots: number;
  readonly skippedProtected: number;
};

/**
 * Selects only terminal runs whose whole root session is inactive. This is a
 * pure decision boundary so SQL, dry-run output, and tests share one policy.
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
  const activeRoots = new Set(
    runs
      .filter((run) => !isTerminalStatus(run.status))
      .map((run) => run.rootRunId || run.id),
  );
  const terminal = new Set<string>(TERMINAL_WORKFLOW_STATUSES);
  const eligible = runs
    .filter((run) => terminal.has(run.status))
    .filter((run) => run.completedAt !== null && run.completedAt.getTime() <= cutoff.getTime())
    .filter((run) => !activeRoots.has(run.rootRunId || run.id))
    .filter((run) => !protectedRunIds.has(run.id) && !protectedRunIds.has(run.rootRunId || run.id))
    .sort((left, right) => {
      const byDate = (left.completedAt?.getTime() ?? 0) - (right.completedAt?.getTime() ?? 0);
      return byDate || left.id.localeCompare(right.id);
    });

  const candidates = eligible.slice(0, policy.maxRuns);
  return {
    cutoff,
    candidates,
    skippedActiveRoots: runs.filter((run) => terminal.has(run.status) && activeRoots.has(run.rootRunId || run.id)).length,
    skippedProtected: runs.filter((run) => terminal.has(run.status) && (protectedRunIds.has(run.id) || protectedRunIds.has(run.rootRunId || run.id))).length,
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
