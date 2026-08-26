import { closeAgentDatabasePools, readAgentDatabaseConfig } from "../server/data/agent-database.ts";
import { createPostgresAgentRunStoreFromEnvironment } from "../server/data/agent-run-store.ts";
import { reconcileStaleSubmissions } from "../server/agent-runs/reconcile.ts";

const database = readAgentDatabaseConfig(process.env);
if (!database) throw new Error("AGENT_DATABASE_URL is required for the AgentRun reconciler.");
const store = createPostgresAgentRunStoreFromEnvironment(process.env);
if (!store) throw new Error("AGENT_DATABASE_URL is required for the AgentRun reconciler.");

const intervalMs = boundedInteger("AGENT_RUN_RECONCILE_INTERVAL_MS", 60_000, 1_000, 86_400_000);
const staleMs = boundedInteger("AGENT_RUN_SUBMISSION_STALE_MS", 120_000, 10_000, 86_400_000);
const limit = boundedInteger("AGENT_RUN_RECONCILE_LIMIT", 100, 1, 10_000);
let stopped = false;
let wake;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopped = true;
    wake?.();
  });
}

try {
  while (!stopped) {
    try {
      const result = await reconcileStaleSubmissions({ limit, olderThanMs: staleMs, store });
      if (result.inspected > 0 || result.failures > 0) {
        console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
      }
    } catch (error) {
      console.error("AgentRun reconciliation failed", error instanceof Error ? error.message : String(error));
    }
    await interruptibleDelay(intervalMs);
  }
} finally {
  await closeAgentDatabasePools();
}

function boundedInteger(name, fallback, minimum, maximum) {
  const value = process.env[name]?.trim() ? Number(process.env[name]) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
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
