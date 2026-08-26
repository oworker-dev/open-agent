import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

/**
 * Run the existing stream and AgentRun gates at the same time.  The separate
 * verifiers remain the source of truth for their protocol checks; this script
 * only provides a reproducible mixed-workload envelope and combines their
 * redacted evidence.  It intentionally does not infer a user count.
 */
const root = process.cwd();
const batchId = `mixed-capacity-${Date.now()}-${randomUUID()}`;
const streamTotal = positiveInteger("AGENT_MIXED_STREAM_TOTAL", 100);
const streamConcurrency = positiveInteger("AGENT_MIXED_STREAM_CONCURRENCY", Math.min(streamTotal, 100));
const streamHoldMs = positiveInteger("AGENT_MIXED_STREAM_HOLD_MS", 10_000);
const runTotal = positiveInteger("AGENT_MIXED_RUN_TOTAL", 2);
const runConcurrency = positiveInteger("AGENT_MIXED_RUN_CONCURRENCY", Math.min(runTotal, 2));
const runDeadlineMs = positiveInteger("AGENT_MIXED_RUN_DEADLINE_MS", 120_000);
const childTimeoutMs = positiveInteger("AGENT_MIXED_CHILD_TIMEOUT_MS", 900_000);
const evidenceDirectory = resolve(process.env.AGENT_MIXED_EVIDENCE_DIR?.trim() || ".tmp/capacity");
const evidencePath = resolve(
  process.env.AGENT_MIXED_EVIDENCE_PATH?.trim() || `${evidenceDirectory}/${batchId}.json`,
);
const minFreeDiskBytes = parseBytes(
  process.env.AGENT_CAPACITY_MIN_FREE_DISK_BYTES?.trim() || "2GiB",
);
const targetMetricsUrl = process.env.AGENT_MIXED_TARGET_METRICS_URL?.trim();
const targetMetricsToken = process.env.AGENT_MIXED_TARGET_METRICS_TOKEN?.trim();
const baseUrl = (
  process.env.AGENT_MIXED_BASE_URL?.trim()
    || process.env.AGENT_STREAM_LOAD_BASE_URL?.trim()
    || process.env.AGENT_LOAD_BASE_URL?.trim()
    || "http://127.0.0.1:3100"
).replace(/\/$/u, "");

const childProcesses = new Set();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    for (const child of childProcesses) void terminateProcessTree(child);
  });
}

await mkdir(evidenceDirectory, { recursive: true });
const preflight = await readDiskCapacity();
if (preflight.availableBytes < minFreeDiskBytes) {
  const evidence = {
    schemaVersion: "open-agent.mixed-capacity-evidence.v1",
    batchId,
    generatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    targetOrigin: new URL(baseUrl).origin,
    configuration: {
      streamTotal,
      streamConcurrency,
      streamHoldMs,
      runTotal,
      runConcurrency,
      runDeadlineMs,
      childTimeoutMs,
    },
    preflight: {
      disk: preflight,
      minFreeDiskBytes,
      ok: false,
      reason: "The mixed load was not started because the host did not have the configured free-disk safety margin.",
    },
    streams: null,
    agentRuns: null,
    ok: false,
  };
  await writeEvidence(evidence, evidencePath);
  console.error(JSON.stringify(evidence));
  process.exitCode = 1;
} else {
  const startedAt = performance.now();
  const streamEvidencePath = resolve(evidenceDirectory, `${batchId}-streams.json`);
  const runEvidencePath = resolve(evidenceDirectory, `${batchId}-agent-runs.json`);
  const targetBefore = targetMetricsUrl ? await readTargetMetrics(targetMetricsUrl, targetMetricsToken) : undefined;

  const [streams, agentRuns] = await Promise.all([
    runVerifier("scripts/verify-idle-stream-load.mjs", {
      AGENT_STREAM_LOAD_BASE_URL: baseUrl,
      AGENT_STREAM_LOAD_TOTAL: String(streamTotal),
      AGENT_STREAM_LOAD_CONCURRENCY: String(streamConcurrency),
      AGENT_STREAM_LOAD_HOLD_MS: String(streamHoldMs),
      AGENT_STREAM_LOAD_EVIDENCE_PATH: streamEvidencePath,
      ...(targetMetricsUrl ? { AGENT_STREAM_LOAD_TARGET_METRICS_URL: targetMetricsUrl } : {}),
      ...(targetMetricsToken ? { AGENT_STREAM_LOAD_TARGET_METRICS_TOKEN: targetMetricsToken } : {}),
    }),
    runVerifier("scripts/verify-agent-run-load.mjs", {
      AGENT_LOAD_BASE_URL: baseUrl,
      AGENT_LOAD_TOTAL_RUNS: String(runTotal),
      AGENT_LOAD_CONCURRENCY: String(runConcurrency),
      AGENT_LOAD_DEADLINE_MS: String(runDeadlineMs),
      AGENT_LOAD_EVIDENCE_PATH: runEvidencePath,
      AGENT_LOAD_COMPLETION_SLO_MODE: process.env.AGENT_MIXED_RUN_COMPLETION_SLO_MODE?.trim() || "observe",
      ...(targetMetricsUrl ? { AGENT_LOAD_TARGET_METRICS_URL: targetMetricsUrl } : {}),
      ...(targetMetricsToken ? { AGENT_LOAD_TARGET_METRICS_TOKEN: targetMetricsToken } : {}),
    }),
  ]);

  const targetAfter = targetMetricsUrl ? await readTargetMetrics(targetMetricsUrl, targetMetricsToken) : undefined;
  const streamEvidence = await readEvidence(streamEvidencePath);
  const runEvidence = await readEvidence(runEvidencePath);
  const violations = [];
  if (!streams.ok) violations.push(`Idle stream gate failed: ${streams.error || "unknown error"}`);
  if (!agentRuns.ok) violations.push(`AgentRun gate failed: ${agentRuns.error || "unknown error"}`);
  if (!streamEvidence) violations.push("Idle stream gate did not write evidence.");
  if (!runEvidence) violations.push("AgentRun gate did not write evidence.");
  if (targetMetricsUrl && (targetBefore?.error || targetAfter?.error)) {
    violations.push("Target metrics endpoint did not return valid snapshots for the full mixed-load window.");
  }
  if (interrupted) violations.push("Mixed capacity run was interrupted.");

  const evidence = {
    schemaVersion: "open-agent.mixed-capacity-evidence.v1",
    batchId,
    generatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    targetOrigin: new URL(baseUrl).origin,
    configuration: {
      streamTotal,
      streamConcurrency,
      streamHoldMs,
      runTotal,
      runConcurrency,
      runDeadlineMs,
      childTimeoutMs,
      workload: "idle-streams+agent-runs",
    },
    preflight: { disk: preflight, minFreeDiskBytes, ok: true },
    streams: {
      process: streams,
      evidencePath: streamEvidencePath,
      evidence: streamEvidence,
    },
    agentRuns: {
      process: agentRuns,
      evidencePath: runEvidencePath,
      evidence: runEvidence,
    },
    targetMetrics: targetMetricsUrl
      ? { url: targetMetricsUrl, before: targetBefore, after: targetAfter }
      : undefined,
    durationMs: Math.round(performance.now() - startedAt),
    violations,
    ok: violations.length === 0,
  };
  await writeEvidence(evidence, evidencePath);
  console.log(JSON.stringify(evidence));
  if (!evidence.ok) process.exitCode = 1;
}

async function runVerifier(script, overrides) {
  const environment = {
    ...process.env,
    ...overrides,
  };
  return await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: omitUndefined(environment),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    childProcesses.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const capture = (target, chunk) => {
      const value = `${target}${String(chunk)}`;
      return value.slice(-8_000);
    };
    child.stdout.on("data", (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = capture(stderr, chunk); });
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await terminateProcessTree(child);
      childProcesses.delete(child);
      resolvePromise({ ok: false, timedOut: true, error: `${script} exceeded ${childTimeoutMs}ms.`, stdout, stderr });
    }, childTimeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      childProcesses.delete(child);
      resolvePromise({ ok: false, error: safeError(error), stdout, stderr });
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      childProcesses.delete(child);
      resolvePromise({
        ok: code === 0,
        exitCode: code,
        signal: signal || undefined,
        ...(code === 0 ? {} : { error: `${script} exited with ${code ?? `signal ${signal}`}: ${safeError(stderr)}` }),
        stdout,
        stderr,
      });
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
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000));
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group may have exited after graceful cleanup.
  }
}

async function readEvidence(path) {
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

async function readDiskCapacity() {
  const stats = await statfs(root);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  return { availableBytes, totalBytes, usedBytes: Math.max(0, totalBytes - availableBytes) };
}

function positiveInteger(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function parseBytes(raw) {
  const match = /^(\d+)(?:\s*(KiB|MiB|GiB|TiB))?$/iu.exec(raw);
  if (!match) throw new Error("AGENT_CAPACITY_MIN_FREE_DISK_BYTES must be a byte count with an optional KiB, MiB, GiB, or TiB suffix.");
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
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Capacity disk threshold is outside the safe integer range.");
  return value;
}

function omitUndefined(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/[\r\n\t]+/gu, " ").slice(0, 500);
}
