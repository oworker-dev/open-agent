import { closeAgentDatabasePools, getAgentDatabasePool, readAgentDatabaseConfig } from "../server/data/agent-database.ts";
import { createPostgresSandboxDeletionStoreFromEnvironment } from "../server/data/sandbox-deletion-store.ts";
import { buildReadySandboxDeletionQuery } from "../lib/sandbox-cleanup-query.ts";
import { runBoundedJsonProcess } from "../lib/bounded-json-process.ts";

const config = readConfig(process.env);
const database = getAgentDatabasePool(config.database);
const deletionStore = createPostgresSandboxDeletionStoreFromEnvironment(process.env);
if (!deletionStore) throw new Error("AGENT_DATABASE_URL is required for the sandbox cleanup worker.");

let stopped = false;
let running = false;
let failureDelayMs = config.intervalMs;
let wake;
const stopController = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  stopped = true;
  stopController.abort();
  wake?.();
});

try {
  while (!stopped) {
    if (!running) {
      running = true;
      try {
        const result = await cleanupPass({ config, database, deletionStore, signal: stopController.signal });
        failureDelayMs = config.intervalMs;
        if (result.considered > 0 || result.removed > 0 || result.failed > 0) {
          console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
        }
      } catch (error) {
        console.error("Sandbox cleanup failed", error instanceof Error ? error.message : String(error));
        failureDelayMs = Math.min(60_000, Math.max(config.intervalMs, failureDelayMs * 2));
      } finally {
        running = false;
      }
    }
    if (stopped) break;
    await interruptibleDelay(failureDelayMs);
  }
} finally {
  await closeAgentDatabasePools();
}

async function cleanupPass({ config, database, deletionStore, signal }) {
  const sessions = await findAuthorizedDeletions(database, config);
  let completedMissing = 0;
  let removed = 0;
  let failed = 0;
  const skipped = [];

  for (const session of sessions) {
    if (stopped) break;
    try {
      const reaped = await runExactReaper(session.sessionId, config.environment, config.reaperTimeoutMs, signal);
      if (reaped.removed.length > 0) {
        removed += reaped.removed.length;
      } else if (reaped.unauthorized.length > 0) {
        skipped.push({ sessionId: session.sessionId, reason: "claimed-or-not-ready" });
      } else if (reaped.matchingSessionContainers.length === 0) {
        const completed = await deletionStore.completeMissing(session.sessionId);
        if (completed) completedMissing += 1;
        else skipped.push({ sessionId: session.sessionId, reason: "already-completed-or-claimed" });
      } else {
        failed += 1;
        skipped.push({ sessionId: session.sessionId, reason: "container-not-eligible" });
      }
    } catch (error) {
      failed += 1;
      console.error("Sandbox cleanup session failed", {
        message: error instanceof Error ? error.message : String(error),
        sessionId: session.sessionId,
      });
    }
  }

  return { completedMissing, considered: sessions.length, failed, removed, skipped };
}

async function findAuthorizedDeletions(pool, config) {
  const result = await pool.query(
    buildReadySandboxDeletionQuery(config.database.schema),
    [config.maxSessions],
  );

  return result.rows.map((row) => ({
    sessionId: String(row.sessionId),
  }));
}

function runExactReaper(sessionId, environment, timeoutMs, signal) {
  return runBoundedJsonProcess({
    args: [
      "scripts/reap-docker-sandboxes.mjs",
      "--apply",
      "--include-running",
      "--session-id", sessionId,
      "--retention-hours", "0",
      "--max-removals", "1",
    ],
    command: process.execPath,
    cwd: process.cwd(),
    environment,
    signal,
    timeoutMs,
  });
}

function readConfig(environment) {
  const database = readAgentDatabaseConfig(environment);
  if (!database) throw new Error("AGENT_DATABASE_URL is required for the sandbox cleanup worker.");
  const backend = environment.AGENT_SANDBOX_BACKEND?.trim() || "auto";
  if (backend !== "docker") {
    throw new Error("The sandbox cleanup worker only supports AGENT_SANDBOX_BACKEND=docker.");
  }
  return {
    database,
    environment,
    intervalMs: boundedInteger(environment.AGENT_SANDBOX_CLEANUP_INTERVAL_MS, 900_000, 1_000, 86_400_000),
    maxSessions: boundedInteger(environment.AGENT_SANDBOX_CLEANUP_MAX_SESSIONS, 25, 1, 10_000),
    reaperTimeoutMs: boundedInteger(environment.AGENT_SANDBOX_CLEANUP_REAPER_TIMEOUT_MS, 60_000, 1_000, 300_000),
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Sandbox cleanup configuration must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function interruptibleDelay(milliseconds) {
  if (stopped) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = undefined;
      resolve();
    }, milliseconds);
    wake = () => {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    };
  });
}
