import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import {
  highestPassingLevel,
  parseCapacityLevels,
} from "../lib/capacity-config.ts";

const root = process.cwd();
const streamLevels = parseCapacityLevels(process.env.AGENT_CAPACITY_STREAM_LEVELS, [100, 250, 500, 1_000]);
const runLevels = parseCapacityLevels(process.env.AGENT_CAPACITY_RUN_LEVELS, [1, 2, 4, 8]);
const stopOnFailure = process.env.AGENT_CAPACITY_STOP_ON_FAILURE !== "0";
const batchTimeoutMs = boundedInteger("AGENT_CAPACITY_BATCH_TIMEOUT_MS", 900_000, 30_000, 3_600_000);
const evidenceDirectory = resolve(process.env.AGENT_CAPACITY_EVIDENCE_DIR?.trim() || ".tmp/capacity");
const generatedAt = new Date().toISOString();
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
    schemaVersion: "open-agent.single-server-capacity-evidence.v1",
    generatedAt,
    completedAt: new Date().toISOString(),
    policy: {
      stopOnFailure,
      batchTimeoutMs,
      streamLevels,
      runLevels,
      minFreeDiskBytes,
      note: "Capacity load was not started because the host did not have the configured free-disk safety margin.",
    },
    preflight: { disk, ok: false },
    streams: { highestPassingLevel: null, results: [] },
    agentRuns: { highestPassingLevel: null, results: [] },
    ok: false,
  };
  await writeEvidence(evidence, aggregateEvidencePath);
  console.error(JSON.stringify(evidence));
  process.exitCode = 1;
  process.exit();
}

const streamResults = await runCapacityLevels("streams", streamLevels, {
  AGENT_STREAM_LOAD_BASE_URL: process.env.AGENT_STREAM_LOAD_BASE_URL,
  AGENT_STREAM_LOAD_HOLD_MS: process.env.AGENT_STREAM_LOAD_HOLD_MS || "10000",
  AGENT_STREAM_LOAD_HANDSHAKE_DEADLINE_MS: process.env.AGENT_STREAM_LOAD_HANDSHAKE_DEADLINE_MS || "30000",
});
const runResults = await runCapacityLevels("agent-runs", runLevels, {
  AGENT_LOAD_BASE_URL: process.env.AGENT_LOAD_BASE_URL,
  AGENT_LOAD_DEADLINE_MS: process.env.AGENT_LOAD_DEADLINE_MS || "120000",
  // Provider completion latency is reported separately from the single-host
  // admission/error gate. A slow upstream must be visible in evidence without
  // being misclassified as local saturation.
  AGENT_LOAD_COMPLETION_SLO_MODE: "observe",
});

const evidence = {
  schemaVersion: "open-agent.single-server-capacity-evidence.v1",
  generatedAt,
  completedAt: new Date().toISOString(),
  policy: {
    stopOnFailure,
    batchTimeoutMs,
    streamLevels,
    runLevels,
    minFreeDiskBytes,
    note: "Levels are sequential and each batch must pass its configured SLO. This is not evidence of ten-thousand or one-hundred-thousand user capacity.",
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
  ok: streamResults.length > 0 && runResults.length > 0 &&
    streamResults.some((result) => result.ok) && runResults.some((result) => result.ok),
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
            AGENT_STREAM_LOAD_EVIDENCE_PATH: evidencePath,
          }
        : {
            AGENT_LOAD_TOTAL_RUNS: String(Math.max(level * 2, level)),
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
      results.push({
        level,
        ok: false,
        evidencePath,
        error: safeError(error),
        durationMs: Math.round(performance.now() - startedAt),
      });
      if (stopOnFailure) break;
    }
  }
  return results;
}

function omitUndefined(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
}

function runVerifier(script, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${script} exceeded ${batchTimeoutMs}ms.`));
    }, batchTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolvePromise();
      reject(new Error(`${script} exited with ${code ?? `signal ${signal}`}: ${safeError(stderr)}`));
    });
  });
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
