import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import {
  highestPassingLevel,
  parseCapacityLevels,
} from "../lib/capacity-config.ts";

const root = process.cwd();
const streamLevels = parseCapacityLevels(process.env.AGENT_CAPACITY_STREAM_LEVELS, [100, 250, 500, 1_000]);
const runLevels = parseCapacityLevels(process.env.AGENT_CAPACITY_RUN_LEVELS, [2, 4, 8, 16]);
const stopOnFailure = process.env.AGENT_CAPACITY_STOP_ON_FAILURE !== "0";
const batchTimeoutMs = boundedInteger("AGENT_CAPACITY_BATCH_TIMEOUT_MS", 900_000, 30_000, 3_600_000);
const evidenceDirectory = resolve(process.env.AGENT_CAPACITY_EVIDENCE_DIR?.trim() || ".tmp/capacity");
const generatedAt = new Date().toISOString();

await mkdir(evidenceDirectory, { recursive: true });
const streamResults = await runCapacityLevels("streams", streamLevels, {
  AGENT_STREAM_LOAD_BASE_URL: process.env.AGENT_STREAM_LOAD_BASE_URL,
  AGENT_STREAM_LOAD_HOLD_MS: process.env.AGENT_STREAM_LOAD_HOLD_MS || "10000",
  AGENT_STREAM_LOAD_HANDSHAKE_DEADLINE_MS: process.env.AGENT_STREAM_LOAD_HANDSHAKE_DEADLINE_MS || "30000",
});
const runResults = await runCapacityLevels("agent-runs", runLevels, {
  AGENT_LOAD_BASE_URL: process.env.AGENT_LOAD_BASE_URL,
  AGENT_LOAD_DEADLINE_MS: process.env.AGENT_LOAD_DEADLINE_MS || "120000",
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
    note: "Levels are sequential and each batch must pass its configured SLO. This is not evidence of ten-thousand or one-hundred-thousand user capacity.",
  },
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

await writeEvidence(evidence);
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

async function writeEvidence(value) {
  const configured = process.env.AGENT_CAPACITY_EVIDENCE_PATH?.trim();
  if (!configured) return;
  const path = resolve(configured);
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
