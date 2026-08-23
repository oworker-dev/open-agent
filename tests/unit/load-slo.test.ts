import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateHostLoadSlo,
  evaluateLoadSlo,
  summarizeLatencies,
} from "../../lib/load-slo.ts";

test("summarizes latency with nearest-rank percentiles", () => {
  assert.deepEqual(summarizeLatencies([]), {
    samples: 0,
    minMs: null,
    maxMs: null,
    meanMs: null,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
  });
  assert.deepEqual(summarizeLatencies([100.4, 20.2, 40.1, 30.4, 10.2]), {
    samples: 5,
    minMs: 10,
    maxMs: 100,
    meanMs: 40,
    p50Ms: 30,
    p95Ms: 100,
    p99Ms: 100,
  });
});

test("reports every failed load SLO dimension", () => {
  const violations = evaluateLoadSlo(
    {
      admission: summarizeLatencies([200, 300]),
      completion: summarizeLatencies([1_000, 4_000]),
      errorRate: 0.02,
      throughputPerSecond: 1.5,
    },
    {
      maxErrorRate: 0.01,
      minThroughputPerSecond: 2,
      p95AdmissionMs: 250,
      p95CompletionMs: 3_000,
      p99CompletionMs: 3_500,
    },
  );

  assert.deepEqual(violations, [
    "Admission p95 300ms exceeded 250ms.",
    "Completion p95 4000ms exceeded 3000ms.",
    "Completion p99 4000ms exceeded 3500ms.",
    "Error rate 2.00% exceeded 1.00%.",
    "Throughput 1.50/s was below 2.00/s.",
  ]);
});

test("accepts metrics within all configured budgets", () => {
  assert.deepEqual(
    evaluateLoadSlo(
      {
        admission: summarizeLatencies([20, 30]),
        completion: summarizeLatencies([500, 700]),
        errorRate: 0,
        throughputPerSecond: 8,
      },
      {
        maxErrorRate: 0,
        minThroughputPerSecond: 5,
        p95AdmissionMs: 100,
        p95CompletionMs: 1_000,
        p99CompletionMs: 1_200,
      },
    ),
    [],
  );
});

test("host capacity gate does not classify slow Provider completion as local saturation", () => {
  assert.deepEqual(
    evaluateHostLoadSlo(
      {
        admission: summarizeLatencies([20, 30]),
        completion: summarizeLatencies([60_000, 90_000]),
        errorRate: 0,
        throughputPerSecond: 8,
      },
      {
        maxErrorRate: 0,
        minThroughputPerSecond: 5,
        p95AdmissionMs: 100,
        p95CompletionMs: 1_000,
      },
    ),
    [],
  );
});
