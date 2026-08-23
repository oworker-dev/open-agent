export type LoadLatencyDistribution = {
  readonly samples: number;
  readonly minMs: number | null;
  readonly maxMs: number | null;
  readonly meanMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
};

export type LoadSloMetrics = {
  readonly admission: LoadLatencyDistribution;
  readonly completion: LoadLatencyDistribution;
  readonly errorRate: number;
  readonly throughputPerSecond: number;
};

export type LoadSloBudgets = {
  readonly maxErrorRate: number;
  readonly minThroughputPerSecond?: number;
  readonly p95AdmissionMs: number;
  readonly p95CompletionMs: number;
  readonly p99CompletionMs?: number;
};

export function summarizeLatencies(values: readonly number[]): LoadLatencyDistribution {
  if (values.length === 0) {
    return {
      samples: 0,
      minMs: null,
      maxMs: null,
      meanMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
    };
  }

  const sorted = values
    .map((value) => Math.round(value))
    .sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    samples: sorted.length,
    minMs: sorted[0] ?? null,
    maxMs: sorted.at(-1) ?? null,
    meanMs: Math.round(total / sorted.length),
    p50Ms: nearestRank(sorted, 0.5),
    p95Ms: nearestRank(sorted, 0.95),
    p99Ms: nearestRank(sorted, 0.99),
  };
}

export function evaluateLoadSlo(
  metrics: LoadSloMetrics,
  budgets: LoadSloBudgets,
): readonly string[] {
  const violations: string[] = [];
  if (metrics.admission.p95Ms === null) {
    violations.push("No successful AgentRun admissions were observed.");
  } else if (metrics.admission.p95Ms > budgets.p95AdmissionMs) {
    violations.push(
      `Admission p95 ${metrics.admission.p95Ms}ms exceeded ${budgets.p95AdmissionMs}ms.`,
    );
  }

  if (metrics.completion.p95Ms === null) {
    violations.push("No successful AgentRun completions were observed.");
  } else if (metrics.completion.p95Ms > budgets.p95CompletionMs) {
    violations.push(
      `Completion p95 ${metrics.completion.p95Ms}ms exceeded ${budgets.p95CompletionMs}ms.`,
    );
  }

  if (
    budgets.p99CompletionMs !== undefined &&
    metrics.completion.p99Ms !== null &&
    metrics.completion.p99Ms > budgets.p99CompletionMs
  ) {
    violations.push(
      `Completion p99 ${metrics.completion.p99Ms}ms exceeded ${budgets.p99CompletionMs}ms.`,
    );
  }

  if (metrics.errorRate > budgets.maxErrorRate) {
    violations.push(
      `Error rate ${formatRate(metrics.errorRate)} exceeded ${formatRate(budgets.maxErrorRate)}.`,
    );
  }

  if (
    budgets.minThroughputPerSecond !== undefined &&
    metrics.throughputPerSecond < budgets.minThroughputPerSecond
  ) {
    violations.push(
      `Throughput ${metrics.throughputPerSecond.toFixed(2)}/s was below ${budgets.minThroughputPerSecond.toFixed(2)}/s.`,
    );
  }
  return violations;
}

/**
 * Evaluate only the dimensions controlled by the local Agent service.
 * Provider completion time is intentionally excluded: it is still recorded
 * by the load runner, but a slow upstream must not be reported as local host
 * saturation. Use the full evaluateLoadSlo gate when an end-to-end Provider
 * SLO is the explicit subject of a test.
 */
export function evaluateHostLoadSlo(
  metrics: LoadSloMetrics,
  budgets: LoadSloBudgets,
): readonly string[] {
  const violations: string[] = [];
  if (metrics.admission.p95Ms === null) {
    violations.push("No successful AgentRun admissions were observed.");
  } else if (metrics.admission.p95Ms > budgets.p95AdmissionMs) {
    violations.push(
      `Admission p95 ${metrics.admission.p95Ms}ms exceeded ${budgets.p95AdmissionMs}ms.`,
    );
  }
  if (metrics.errorRate > budgets.maxErrorRate) {
    violations.push(
      `Error rate ${formatRate(metrics.errorRate)} exceeded ${formatRate(budgets.maxErrorRate)}.`,
    );
  }
  if (
    budgets.minThroughputPerSecond !== undefined &&
    metrics.throughputPerSecond < budgets.minThroughputPerSecond
  ) {
    violations.push(
      `Throughput ${metrics.throughputPerSecond.toFixed(2)}/s was below ${budgets.minThroughputPerSecond.toFixed(2)}/s.`,
    );
  }
  return violations;
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? 0;
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
