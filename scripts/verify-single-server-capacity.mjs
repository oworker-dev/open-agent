import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import pg from "pg";

import {
  highestPassingLevel,
  parseCapacityLevels,
  parseMixedCapacityLevels,
} from "../lib/capacity-config.ts";

const { Pool } = pg;

const root = process.cwd();
const streamLevels = parseCapacityLevels(
  process.env.AGENT_CAPACITY_STREAM_LEVELS,
  [100, 250, 500, 1_000, 5_000, 10_000],
);
const runLevels = parseCapacityLevels(
  process.env.AGENT_CAPACITY_RUN_LEVELS,
  [4, 8, 12, 16, 25, 50, 100],
);
const mixedLevels = parseMixedCapacityLevels(
  process.env.AGENT_CAPACITY_MIXED_LEVELS,
  [
    { streams: 100, runs: 4 },
    { streams: 250, runs: 8 },
    { streams: 250, runs: 12 },
    { streams: 500, runs: 16 },
  ],
);
const stopOnFailure = process.env.AGENT_CAPACITY_STOP_ON_FAILURE !== "0";
const requireProductionEvidence = process.env.AGENT_CAPACITY_REQUIRE_PRODUCTION_EVIDENCE === "1";
const batchTimeoutMs = boundedInteger("AGENT_CAPACITY_BATCH_TIMEOUT_MS", 900_000, 30_000, 3_600_000);
const evidenceDirectory = resolve(process.env.AGENT_CAPACITY_EVIDENCE_DIR?.trim() || ".tmp/capacity");
const generatedAt = new Date().toISOString();
const targetMetricsUrl = process.env.AGENT_CAPACITY_TARGET_METRICS_URL?.trim();
const targetMetricsToken = process.env.AGENT_CAPACITY_TARGET_METRICS_TOKEN?.trim();
const workflowConnectionString = process.env.WORKFLOW_POSTGRES_URL?.trim();
const workflowSchema = identifier(process.env.WORKFLOW_POSTGRES_SCHEMA?.trim() || "workflow");
const configuredStreamSessions = optionalBoundedInteger("AGENT_CAPACITY_STREAM_SESSION_COUNT", 1, 10_000);
const minFreeDiskBytes = boundedBytes(
  "AGENT_CAPACITY_MIN_FREE_DISK_BYTES",
  2 * 1024 ** 3,
  256 * 1024 ** 2,
  100 * 1024 ** 3,
);
const aggregateEvidencePath = resolve(
  process.env.AGENT_CAPACITY_EVIDENCE_PATH?.trim() || `${evidenceDirectory}/summary.json`,
);

await mkdir(evidenceDirectory, { recursive: true });

const disk = await readDiskCapacity();
if (disk.availableBytes < minFreeDiskBytes) {
  const evidence = {
    schemaVersion: "open-agent.single-server-capacity-evidence.v2",
    generatedAt,
    completedAt: new Date().toISOString(),
    policy: {
      stopOnFailure,
      batchTimeoutMs,
      streamLevels,
      runLevels,
      mixedLevels,
      minFreeDiskBytes,
      requireProductionEvidence,
      note: "Capacity load was not started because the host did not have the configured free-disk safety margin.",
    },
    preflight: { disk, ok: false },
    streams: { highestPassingLevel: null, results: [] },
    agentRuns: { highestPassingLevel: null, results: [] },
    mixed: { highestPassingLevel: null, results: [] },
    ok: false,
  };
  await writeEvidence(evidence, aggregateEvidencePath);
  console.error(JSON.stringify(evidence));
  process.exitCode = 1;
  process.exit();
}

const missingPrerequisites = [
  "AGENT_HOST_JWT_SECRET",
  "AGENT_HOST_JWT_ISSUER",
  "AGENT_HOST_JWT_AUDIENCE",
].filter((name) => !process.env[name]?.trim());
if (missingPrerequisites.length > 0) {
  const evidence = {
    schemaVersion: "open-agent.single-server-capacity-evidence.v2",
    generatedAt,
    completedAt: new Date().toISOString(),
    policy: {
      stopOnFailure,
      batchTimeoutMs,
      streamLevels,
      runLevels,
      mixedLevels,
      minFreeDiskBytes,
      requireProductionEvidence,
      note: "Capacity load was not started because the authenticated Host JWT signing configuration was incomplete.",
    },
    preflight: {
      disk,
      prerequisites: { ok: false, missing: missingPrerequisites },
      ok: false,
    },
    streams: { highestPassingLevel: null, results: [] },
    agentRuns: { highestPassingLevel: null, results: [] },
    mixed: { highestPassingLevel: null, results: [] },
    evidenceCompleteness: {
      productionEvidenceComplete: false,
      targetMetricsConfigured: Boolean(targetMetricsUrl),
      workflowStorageConfigured: Boolean(workflowConnectionString),
    },
    protocolOk: false,
    ok: false,
  };
  await writeEvidence(evidence, aggregateEvidencePath);
  console.error(JSON.stringify(evidence));
  process.exitCode = 1;
  process.exit();
}

const workflowStorageBefore = workflowConnectionString
  ? await readWorkflowStorageSnapshot(workflowConnectionString, workflowSchema)
  : undefined;

const streamResults = await runCapacityLevels("streams", streamLevels, {
  AGENT_STREAM_LOAD_BASE_URL: process.env.AGENT_STREAM_LOAD_BASE_URL,
  AGENT_STREAM_LOAD_HOLD_MS: process.env.AGENT_STREAM_LOAD_HOLD_MS || "10000",
  AGENT_STREAM_LOAD_HANDSHAKE_DEADLINE_MS: process.env.AGENT_STREAM_LOAD_HANDSHAKE_DEADLINE_MS || "30000",
  AGENT_STREAM_LOAD_TARGET_METRICS_URL: targetMetricsUrl,
  AGENT_STREAM_LOAD_TARGET_METRICS_TOKEN: targetMetricsToken,
});
const runResults = await runCapacityLevels("agent-runs", runLevels, {
  AGENT_LOAD_BASE_URL: process.env.AGENT_LOAD_BASE_URL,
  AGENT_LOAD_DEADLINE_MS: process.env.AGENT_LOAD_DEADLINE_MS || "120000",
  // Provider completion latency is reported separately from the single-host
  // admission/error gate. A slow upstream must be visible in evidence without
  // being misclassified as local saturation.
  AGENT_LOAD_COMPLETION_SLO_MODE: "observe",
  AGENT_LOAD_TARGET_METRICS_URL: targetMetricsUrl,
  AGENT_LOAD_TARGET_METRICS_TOKEN: targetMetricsToken,
});
const mixedResults = await runMixedCapacityLevels(mixedLevels);
const workflowStorageAfter = workflowConnectionString
  ? await readWorkflowStorageSnapshot(workflowConnectionString, workflowSchema)
  : undefined;
const productionEvidenceComplete = Boolean(
  targetMetricsUrl && workflowStorageBefore && workflowStorageAfter && mixedResults.some((result) => result.ok),
);
const protocolOk = streamResults.some((result) => result.ok) &&
  runResults.some((result) => result.ok) && mixedResults.some((result) => result.ok);

const evidence = {
  schemaVersion: "open-agent.single-server-capacity-evidence.v2",
  generatedAt,
  completedAt: new Date().toISOString(),
  policy: {
    stopOnFailure,
    batchTimeoutMs,
    streamLevels,
    runLevels,
    mixedLevels,
    minFreeDiskBytes,
    requireProductionEvidence,
    note: "Levels ramp from a safe baseline and stop at the first failed SLO. Stream levels are connections, not inferred users; distinct durable-session counts are preserved in child evidence.",
  },
  preflight: { disk, ok: true },
  streams: {
    highestPassingLevel: highestPassingLevel(streamResults),
    results: streamResults,
  },
  agentRuns: {
    highestPassingLevel: highestPassingLevel(runResults),
    results: runResults,
  },
  mixed: {
    highestPassingLevel: [...mixedResults].reverse().find((result) => result.ok)?.level ?? null,
    results: mixedResults,
  },
  workflowStorage: workflowStorageBefore && workflowStorageAfter
    ? {
        before: workflowStorageBefore,
        after: workflowStorageAfter,
        delta: subtractStorage(workflowStorageAfter, workflowStorageBefore),
      }
    : undefined,
  evidenceCompleteness: {
    productionEvidenceComplete,
    targetMetricsConfigured: Boolean(targetMetricsUrl),
    workflowStorageConfigured: Boolean(workflowConnectionString),
  },
  protocolOk,
  ok: protocolOk && (!requireProductionEvidence || productionEvidenceComplete),
};

await writeEvidence(evidence, aggregateEvidencePath);
console.log(JSON.stringify(evidence));
if (!evidence.ok) process.exitCode = 1;

async function runCapacityLevels(kind, levels, extraEnvironment) {
  const results = [];
  for (const level of levels) {
    const evidencePath = resolve(evidenceDirectory, `${kind}-${level}.json`);
    const environment = omitUndefined({
      ...process.env,
      ...extraEnvironment,
      ...(kind === "streams"
        ? {
            AGENT_STREAM_LOAD_TOTAL: String(level),
            AGENT_STREAM_LOAD_CONCURRENCY: String(Math.min(level, boundedInteger("AGENT_CAPACITY_STREAM_WORKERS", 100, 1, 1_000))),
            ...(configuredStreamSessions
              ? { AGENT_STREAM_LOAD_SESSION_COUNT: String(Math.min(level, configuredStreamSessions)) }
              : {}),
            AGENT_STREAM_LOAD_EVIDENCE_PATH: evidencePath,
          }
        : {
            AGENT_LOAD_TOTAL_RUNS: String(level),
            AGENT_LOAD_CONCURRENCY: String(level),
            AGENT_LOAD_EVIDENCE_PATH: evidencePath,
          }),
    });
    const startedAt = performance.now();
    try {
      await runVerifier(kind === "streams" ? "scripts/verify-idle-stream-load.mjs" : "scripts/verify-agent-run-load.mjs", environment);
      const report = await readEvidenceFile(evidencePath);
      results.push({
        level,
        ok: report?.ok === true,
        evidencePath,
        metrics: report?.metrics,
        durationMs: Math.round(performance.now() - startedAt),
      });
      if (report?.ok !== true && stopOnFailure) break;
    } catch (error) {
      const report = await readEvidenceFile(evidencePath);
      results.push({
        level,
        ok: false,
        evidencePath,
        error: safeError(error),
        metrics: report?.metrics,
        durationMs: Math.round(performance.now() - startedAt),
      });
      if (stopOnFailure) break;
    }
  }
  return results;
}

async function runMixedCapacityLevels(levels) {
  const results = [];
  for (const level of levels) {
    const label = `${level.streams}-streams-${level.runs}-runs`;
    const evidencePath = resolve(evidenceDirectory, `mixed-${label}.json`);
    const environment = omitUndefined({
      ...process.env,
      AGENT_MIXED_STREAM_TOTAL: String(level.streams),
      AGENT_MIXED_STREAM_CONCURRENCY: String(Math.min(level.streams, boundedInteger("AGENT_CAPACITY_STREAM_WORKERS", 100, 1, 1_000))),
      ...(configuredStreamSessions
        ? { AGENT_MIXED_STREAM_SESSION_COUNT: String(Math.min(level.streams, configuredStreamSessions)) }
        : {}),
      AGENT_MIXED_RUN_TOTAL: String(level.runs),
      AGENT_MIXED_RUN_CONCURRENCY: String(level.runs),
      AGENT_MIXED_EVIDENCE_PATH: evidencePath,
      AGENT_MIXED_RUN_COMPLETION_SLO_MODE: "observe",
      AGENT_MIXED_TARGET_METRICS_URL: targetMetricsUrl,
      AGENT_MIXED_TARGET_METRICS_TOKEN: targetMetricsToken,
    });
    const startedAt = performance.now();
    try {
      await runVerifier("scripts/verify-mixed-capacity.mjs", environment);
      const report = await readEvidenceFile(evidencePath);
      results.push({ level, ok: report?.ok === true, evidencePath, metrics: mixedMetrics(report), durationMs: Math.round(performance.now() - startedAt) });
      if (report?.ok !== true && stopOnFailure) break;
    } catch (error) {
      const report = await readEvidenceFile(evidencePath);
      results.push({ level, ok: false, evidencePath, error: safeError(error), metrics: mixedMetrics(report), durationMs: Math.round(performance.now() - startedAt) });
      if (stopOnFailure) break;
    }
  }
  return results;
}

function mixedMetrics(report) {
  if (!report) return undefined;
  return {
    durationMs: report.durationMs,
    streams: report.streams?.evidence?.metrics,
    agentRuns: report.agentRuns?.evidence?.metrics,
    targetMetrics: report.targetMetrics,
  };
}

function omitUndefined(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
}

function runVerifier(script, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let settled = false;
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-16_000); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateProcessTree(child).finally(() => {
        reject(new Error(`${script} exceeded ${batchTimeoutMs}ms.`));
      });
    }, batchTimeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolvePromise();
      reject(new Error(`${script} exited with ${code ?? `signal ${signal}`}: ${safeError(stderr)}`));
    });
  });
}

async function terminateProcessTree(child) {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group may already have exited after graceful cleanup.
  }
}

async function readEvidenceFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeEvidence(value, path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/[\r\n\t]+/gu, " ").slice(0, 500);
}

async function readDiskCapacity() {
  const stats = await statfs(root);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  if (!Number.isSafeInteger(availableBytes) || !Number.isSafeInteger(totalBytes) || availableBytes < 0 || totalBytes <= 0) {
    throw new Error("Unable to read a safe filesystem capacity snapshot.");
  }
  return { availableBytes, totalBytes, usedBytes: totalBytes - availableBytes };
}

async function readWorkflowStorageSnapshot(connectionString, schema) {
  const pool = new Pool({
    application_name: "open-agent-capacity-storage-snapshot",
    connectionString,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    max: 1,
  });
  try {
    const [relations, streams, runs] = await Promise.all([
      pool.query(
        `select coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint as relation_bytes
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and c.relkind = 'r'`,
        [schema],
      ),
      pool.query(
        `select count(*)::bigint as chunks,
                coalesce(sum(octet_length(data)), 0)::bigint as stream_payload_bytes
           from "${schema}".workflow_stream_chunks`,
      ),
      pool.query(`select count(*)::bigint as runs from "${schema}".workflow_runs`),
    ]);
    return {
      capturedAt: new Date().toISOString(),
      relationBytes: Number(relations.rows[0]?.relation_bytes ?? 0),
      streamPayloadBytes: Number(streams.rows[0]?.stream_payload_bytes ?? 0),
      streamChunks: Number(streams.rows[0]?.chunks ?? 0),
      runs: Number(runs.rows[0]?.runs ?? 0),
    };
  } finally {
    await pool.end();
  }
}

function subtractStorage(after, before) {
  return {
    relationBytes: after.relationBytes - before.relationBytes,
    streamPayloadBytes: after.streamPayloadBytes - before.streamPayloadBytes,
    streamChunks: after.streamChunks - before.streamChunks,
    runs: after.runs - before.runs,
  };
}

function boundedBytes(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const match = /^(\d+)(?:\s*(KiB|MiB|GiB|TiB))?$/iu.exec(raw);
  if (!match) throw new Error(`${name} must be a byte count with an optional KiB, MiB, GiB, or TiB suffix.`);
  const multiplier = match[2]?.toLowerCase() === "kib"
    ? 1024
    : match[2]?.toLowerCase() === "mib"
      ? 1024 ** 2
      : match[2]?.toLowerCase() === "gib"
        ? 1024 ** 3
        : match[2]?.toLowerCase() === "tib"
          ? 1024 ** 4
          : 1;
  const value = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum} bytes.`);
  }
  return value;
}

function optionalBoundedInteger(name, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(value)) throw new Error("WORKFLOW_POSTGRES_SCHEMA is invalid.");
  return value;
}
