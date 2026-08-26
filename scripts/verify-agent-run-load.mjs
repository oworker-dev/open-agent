import { createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { evaluateHostLoadSlo, evaluateLoadSlo, summarizeLatencies } from "../lib/load-slo.ts";

const baseUrl = (
  process.env.AGENT_LOAD_BASE_URL?.trim() || "http://127.0.0.1:3100"
).replace(/\/$/, "");
const concurrency = boundedInteger("AGENT_LOAD_CONCURRENCY", 8, 1, 100);
const totalRuns = boundedInteger("AGENT_LOAD_TOTAL_RUNS", concurrency, 1, 10_000);
const warmupRuns = boundedInteger("AGENT_LOAD_WARMUP_RUNS", 0, 0, 1_000);
const budgets = {
  maxErrorRate: boundedNumber("AGENT_LOAD_MAX_ERROR_RATE", 0, 0, 1),
  minThroughputPerSecond: optionalBoundedNumber(
    "AGENT_LOAD_MIN_THROUGHPUT_PER_SECOND",
    0.01,
    10_000,
  ),
  p95AdmissionMs: boundedInteger("AGENT_LOAD_P95_ADMISSION_MS", 2_000, 10, 300_000),
  p95CompletionMs: boundedInteger("AGENT_LOAD_P95_COMPLETION_MS", 20_000, 100, 900_000),
  p99CompletionMs: optionalBoundedInteger(
    "AGENT_LOAD_P99_COMPLETION_MS",
    100,
    900_000,
  ),
};
const deadlineMs = boundedInteger(
  "AGENT_LOAD_DEADLINE_MS",
  60_000,
  1_000,
  900_000,
);
const completionSloMode = process.env.AGENT_LOAD_COMPLETION_SLO_MODE?.trim() === "observe"
  ? "observe"
  : "enforce";
const batchId = `load-${Date.now()}-${randomUUID()}`;
const accessToken = signToken({
  actorType: "service",
  scope: ["agent:runs"],
  sub: `load-runner-${randomUUID()}`,
  tenantId: `load-tenant-${randomUUID()}`,
});
const providerDebugUrl = process.env.AGENT_LOAD_PROVIDER_DEBUG_URL?.trim();
const targetMetricsUrl = process.env.AGENT_LOAD_TARGET_METRICS_URL?.trim();
const targetMetricsToken = process.env.AGENT_LOAD_TARGET_METRICS_TOKEN?.trim();
const providerBefore = providerDebugUrl
  ? await providerRequestCount(providerDebugUrl)
  : undefined;
const targetMetricsBefore = targetMetricsUrl
  ? await readTargetMetrics(targetMetricsUrl)
  : undefined;
const generatedAt = new Date().toISOString();
const resourceSampler = createResourceSampler();
const activeRunIds = new Set();
const testSessionIds = new Set();
const execFileAsync = promisify(execFile);
let shutdownPromise;
process.once("SIGTERM", () => {
  shutdownPromise = cancelOutstandingRuns().finally(() => {
    process.exitCode = 1;
  });
});
process.once("SIGINT", () => {
  shutdownPromise = cancelOutstandingRuns().finally(() => {
    process.exitCode = 130;
  });
});

const warmup = await runPhase("warmup", warmupRuns);
const measuredStartedAt = performance.now();
const measured = await runPhase("measured", totalRuns);
const measuredDurationMs = performance.now() - measuredStartedAt;
const succeeded = measured.filter((entry) => entry.ok);
const failed = measured.filter((entry) => !entry.ok);

const replayFailures = [];
await mapWithConcurrency(succeeded, concurrency, async (entry) => {
  try {
    const payload = await api("POST", "/api/agent/runs", entry.request, 200);
    assert(payload.disposition === "replayed", `AgentRun ${entry.runId} was not replayed.`);
    assert(payload.run?.runId === entry.runId, `AgentRun ${entry.runId} replay changed identity.`);
  } catch (cause) {
    replayFailures.push({ runId: entry.runId, error: safeError(cause) });
  }
});

// AgentRun load cases create durable Eve sessions so the normal ownership and
// admission paths are exercised. Retire those synthetic sessions after the
// run, otherwise every preview restart will legitimately recover them as
// active conversation roots and inflate the Workflow queue.
const sessionCleanup = await retireSyntheticSessions();

const providerAfter = providerDebugUrl
  ? await providerRequestCount(providerDebugUrl)
  : undefined;
const targetMetricsAfter = targetMetricsUrl
  ? await readTargetMetrics(targetMetricsUrl)
  : undefined;
const providerRequests =
  providerAfter !== undefined && providerBefore !== undefined
    ? providerAfter - providerBefore
    : undefined;
const resource = resourceSampler.result();
const expectedProviderRequests = warmupRuns + totalRuns;
const metrics = {
  admission: summarizeLatencies(succeeded.map((entry) => entry.admissionMs)),
  completion: summarizeLatencies(succeeded.map((entry) => entry.completionMs)),
  errorRate: failed.length / totalRuns,
  throughputPerSecond: round(succeeded.length / Math.max(measuredDurationMs / 1_000, 0.001), 2),
};
const violations = [...(completionSloMode === "observe"
  ? evaluateHostLoadSlo(metrics, budgets)
  : evaluateLoadSlo(metrics, budgets))];
const warmupFailures = warmup.filter((entry) => !entry.ok);
if (warmupFailures.length > 0) {
  violations.push(`${warmupFailures.length} of ${warmupRuns} warmup runs failed.`);
}
if (replayFailures.length > 0) {
  violations.push(`${replayFailures.length} idempotent replays failed.`);
}
if (sessionCleanup.failures.length > 0) {
  violations.push(`${sessionCleanup.failures.length} synthetic Eve sessions could not be retired.`);
}
if (
  providerRequests !== undefined &&
  warmupFailures.length === 0 &&
  failed.length === 0 &&
  providerRequests !== expectedProviderRequests
) {
  violations.push(
    `Expected ${expectedProviderRequests} Provider requests, received ${providerRequests}.`,
  );
}
if (targetMetricsUrl && (targetMetricsBefore?.error || targetMetricsAfter?.error)) {
  violations.push("Target metrics endpoint did not return valid snapshots for the full load window.");
}

const evidence = {
  schemaVersion: "open-agent.load-evidence.v1",
  batchId,
  generatedAt,
  completedAt: new Date().toISOString(),
  targetOrigin: new URL(baseUrl).origin,
  configuration: {
    concurrency,
    deadlineMs,
    totalRuns,
    warmupRuns,
    completionSloMode,
  },
  budgets,
  metrics: {
    ...metrics,
    measuredDurationMs: Math.round(measuredDurationMs),
    successes: succeeded.length,
    failures: failed.length,
    eventCount: succeeded.reduce((total, entry) => total + entry.eventCount, 0),
    idempotencyReplays: succeeded.length - replayFailures.length,
    providerRequests,
    resource: {
      // This is the verifier process only. Target host metrics must be
      // collected from the deployment, not inferred from this client.
      loadGenerator: resource,
      target: targetMetricsUrl
        ? { url: targetMetricsUrl, before: targetMetricsBefore, after: targetMetricsAfter }
        : undefined,
    },
  },
  failures: failed.map(({ index, stage, error }) => ({ index, stage, error })),
  warmupFailures: warmupFailures.map(({ index, stage, error }) => ({ index, stage, error })),
  replayFailures,
  sessionCleanup,
  violations,
  ok: violations.length === 0,
};

await writeEvidence(evidence);
console.log(JSON.stringify(evidence));
assert(evidence.ok, `Load SLO gate failed: ${violations.join(" ")}`);

function createResourceSampler() {
  const initial = process.memoryUsage();
  let peakRss = initial.rss;
  let peakHeapUsed = initial.heapUsed;
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  const timer = setInterval(() => {
    const current = process.memoryUsage();
    peakRss = Math.max(peakRss, current.rss);
    peakHeapUsed = Math.max(peakHeapUsed, current.heapUsed);
  }, 100);
  timer.unref();
  return {
    result() {
      const final = process.memoryUsage();
      eventLoop.disable();
      clearInterval(timer);
      return {
        initialRssBytes: initial.rss,
        finalRssBytes: final.rss,
        peakRssBytes: peakRss,
        initialHeapUsedBytes: initial.heapUsed,
        finalHeapUsedBytes: final.heapUsed,
        peakHeapUsedBytes: peakHeapUsed,
        eventLoopP95Ms: round(eventLoop.percentile(95) / 1e6, 2),
        eventLoopMaxMs: round(eventLoop.max / 1e6, 2),
      };
    },
  };
}

async function runPhase(phase, count) {
  const cases = Array.from({ length: count }, (_, index) => createCase(phase, index));
  return await mapWithConcurrency(cases, concurrency, async (loadCase) => {
    let stage = "admission";
    let runId;
    try {
      const startedAt = performance.now();
      const payload = await api("POST", "/api/agent/runs", loadCase.request, 202);
      assert(payload.disposition === "started", "A load run was not newly started.");
      assert(typeof payload.run?.runId === "string", "A load run did not return a runId.");
      const admissionMs = performance.now() - startedAt;
      runId = payload.run.runId;
      if (typeof payload.run.harness?.sessionId === "string") testSessionIds.add(payload.run.harness.sessionId);
      activeRunIds.add(runId);

      stage = "completion";
      const run = await poll(runId, startedAt + deadlineMs);
      if (typeof run.harness?.sessionId === "string") testSessionIds.add(run.harness.sessionId);
      activeRunIds.delete(runId);
      const completionMs = performance.now() - startedAt;
      assert(run.status === "completed", `AgentRun ${runId} ended as ${run.status}.`);
      assert(
        run.result?.kind === "text" && run.result.value === loadCase.expected,
        `AgentRun ${runId} received another run's result.`,
      );
      assert(run.usage?.steps > 0, `AgentRun ${runId} did not project step usage.`);
      assert(run.usage?.inputTokens > 0, `AgentRun ${runId} did not project input usage.`);
      assert(run.usage?.outputTokens > 0, `AgentRun ${runId} did not project output usage.`);

      stage = "events";
      const events = await readAllEvents(runId);
      assert(events.length > 0, `AgentRun ${runId} returned no events.`);
      events.forEach((event, index) => {
        assert(event.runId === runId, `AgentRun ${runId} received a foreign event.`);
        assert(event.sequence === index + 1, `AgentRun ${runId} has a broken event sequence.`);
      });
      const exhausted = await api(
        "GET",
        `/api/agent/runs/${encodeURIComponent(runId)}/events?after=${events.length}`,
        undefined,
        200,
      );
      assert(exhausted.events.length === 0, `AgentRun ${runId} replayed exhausted events.`);
      return {
        ...loadCase,
        admissionMs,
        completionMs,
        eventCount: events.length,
        ok: true,
        runId,
      };
    } catch (cause) {
      if (typeof runId === "string") {
        await cancelAndWait(runId).catch(() => undefined);
      }
      return {
        ...loadCase,
        error: safeError(cause),
        ok: false,
        stage,
      };
    }
  });
}

async function retireSyntheticSessions() {
  const sessionIds = [...testSessionIds];
  const failures = [];
  let retired = 0;
  await mapWithConcurrency(sessionIds, Math.min(concurrency, 16), async (sessionId) => {
    try {
      const response = await fetch(
        `${baseUrl}/eve/v1/session/${encodeURIComponent(sessionId)}/reset`,
        {
          body: JSON.stringify({ reason: `agent-run-load:${batchId}` }),
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(deadlineMs, 120_000)),
        },
      );
      const payload = await response.json().catch(() => undefined);
      if (!response.ok || payload?.status !== "reset" && payload?.status !== "no_active_session") {
        throw new Error(
          `session reset returned HTTP ${response.status}: ${payload?.error || payload?.code || "unknown error"}`,
        );
      }
      retired += 1;
      testSessionIds.delete(sessionId);
    } catch (cause) {
      failures.push({ sessionId, error: safeError(cause) });
    }
  });
  return { attempted: sessionIds.length, failures, retired };
}

async function cancelOutstandingRuns() {
  if (activeRunIds.size === 0) return;
  await Promise.allSettled([...activeRunIds].map((runId) => cancelAndWait(runId)));
}

async function cancelAndWait(runId) {
  await api("DELETE", `/api/agent/runs/${encodeURIComponent(runId)}`, undefined, 202).catch(() => undefined);
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    try {
      const payload = await api(
        "GET",
        `/api/agent/runs/${encodeURIComponent(runId)}`,
        undefined,
        200,
      );
      if (["completed", "failed", "cancelled", "submission-ambiguous"].includes(payload.run.status)) {
        if (typeof payload.run.harness?.sessionId === "string") testSessionIds.add(payload.run.harness.sessionId);
        activeRunIds.delete(runId);
        await removeOwnedTestSandboxes();
        return;
      }
    } catch {
      // Keep polling until the bounded cleanup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  activeRunIds.delete(runId);
  await removeOwnedTestSandboxes();
}

async function removeOwnedTestSandboxes() {
  const docker = process.env.EVE_DOCKER_PATH?.trim() || "docker";
  for (const sessionId of testSessionIds) {
    if (!/^wrun_[A-Za-z0-9_-]+$/u.test(sessionId)) continue;
    try {
      const { stdout } = await execFileAsync(docker, [
        "ps", "-aq", "--filter", "label=eve.sandbox=1",
        "--filter", `label=eve.sandbox.tag.sessionId=${sessionId}`,
      ], { maxBuffer: 64 * 1024 });
      const ids = stdout.split(/\s+/u).filter(Boolean);
      if (ids.length > 0) await execFileAsync(docker, ["rm", "-f", ...ids], { maxBuffer: 64 * 1024 });
    } catch {
      // Best effort for synthetic runs; production sandboxes are reaped only
      // through the ownership-authorized cleanup worker.
    }
    testSessionIds.delete(sessionId);
  }
}

// AgentRun events are paged by the API. Consume every page and require a
// strictly advancing cursor; this avoids truncating long runs or spinning on
// malformed responses without imposing an arbitrary event-count cap.
async function readAllEvents(runId) {
  const events = [];
  let cursor = 0;
  while (true) {
    const page = await api(
      "GET",
      `/api/agent/runs/${encodeURIComponent(runId)}/events?after=${cursor}`,
      undefined,
      200,
    );
    assert(Array.isArray(page.events), `AgentRun ${runId} returned invalid events.`);
    if (page.events.length === 0) {
      assert(page.nextCursor === cursor, `AgentRun ${runId} returned an invalid terminal event cursor.`);
      return events;
    }
    const nextCursor = Number(page.nextCursor);
    assert(
      Number.isSafeInteger(nextCursor) && nextCursor > cursor,
      `AgentRun ${runId} returned a non-advancing event cursor.`,
    );
    assert(
      nextCursor - cursor === page.events.length,
      `AgentRun ${runId} returned a discontinuous event page.`,
    );
    events.push(...page.events);
    cursor = nextCursor;
  }
}

function createCase(phase, index) {
  const expected = `LOAD_READY_${batchId}_${phase}_${index}`;
  return {
    expected,
    index,
    request: {
      idempotencyKey: `${batchId}:${phase}:${index}`,
      message: `Do not use tools. Reply exactly: ${expected}`,
      metadata: { loadBatch: batchId, loadIndex: index, loadPhase: phase },
      policy: {
        limits: {
          maxDurationMs: deadlineMs,
          maxInputTokens: 100_000,
          maxModelCalls: 2,
          maxOutputTokens: 1_000,
          maxToolCalls: 2,
          maxTurns: 1,
        },
      },
      profile: { profileId: "general-purpose", version: "0.1.0" },
    },
  };
}

async function mapWithConcurrency(items, limit, worker) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function poll(runId, deadline) {
  while (performance.now() < deadline) {
    const payload = await api(
      "GET",
      `/api/agent/runs/${encodeURIComponent(runId)}`,
      undefined,
      200,
    );
    if (["completed", "failed", "cancelled", "submission-ambiguous"].includes(payload.run.status)) {
      return payload.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`AgentRun ${runId} did not settle within ${deadlineMs}ms.`);
}

async function api(method, path, body, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(Math.min(deadlineMs, 120_000)),
  });
  const payload = await response.json().catch(() => undefined);
  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${path} returned ${response.status}, expected ${expectedStatus}: ${
        payload?.error || payload?.message || "unknown error"
      }`,
    );
  }
  return payload;
}

async function providerRequestCount(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Provider debug endpoint returned ${response.status}.`);
  const payload = await response.json();
  assert(Number.isSafeInteger(payload.requestCount), "Provider debug requestCount is invalid.");
  return payload.requestCount;
}

async function readTargetMetrics(url) {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: targetMetricsToken ? { authorization: `Bearer ${targetMetricsToken}` } : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Target metrics endpoint returned ${response.status}.`);
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Target metrics endpoint returned a non-object payload.");
    }
    return { capturedAt: new Date().toISOString(), value: payload };
  } catch (error) {
    return { capturedAt: new Date().toISOString(), error: safeError(error) };
  }
}

async function writeEvidence(value) {
  const configured = process.env.AGENT_LOAD_EVIDENCE_PATH?.trim();
  if (!configured) return;
  const path = resolve(configured);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function signToken(claims) {
  const secret = required("AGENT_HOST_JWT_SECRET");
  const issuer = required("AGENT_HOST_JWT_ISSUER");
  const audience = required("AGENT_HOST_JWT_AUDIENCE");
  const now = Math.floor(Date.now() / 1_000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    ...claims,
    aud: audience,
    exp: now + Math.max(300, Math.ceil(deadlineMs / 1_000) + 60),
    iat: now,
    iss: issuer,
    jti: randomUUID(),
  });
  const input = `${header}.${payload}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function optionalBoundedInteger(name, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  return boundedInteger(name, minimum, minimum, maximum);
}

function boundedNumber(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function optionalBoundedNumber(name, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  return boundedNumber(name, minimum, minimum, maximum);
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function safeError(cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replaceAll(/[\r\n\t]+/gu, " ").slice(0, 500);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
