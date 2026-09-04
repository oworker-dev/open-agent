import pg from "pg";

import { closeAgentDatabasePools, readAgentDatabaseConfig } from "../server/data/agent-database.ts";
import { createPostgresWorkflowArchiveStore } from "../server/data/workflow-archive-store.ts";
import { createWorkflowArchiveObjectStore } from "../server/data/workflow-archive-object-store.ts";
import { readWorkflowArchiveRuntimeConfig } from "../server/workflow-archive/config.ts";
import { runWorkflowArchivePass } from "../server/workflow-archive/service.ts";

const config = readWorkflowArchiveRuntimeConfig(process.env);
const agentDatabase = readAgentDatabaseConfig(process.env);
if (!agentDatabase) throw new Error("AGENT_DATABASE_URL is required.");
const archiveStore = createPostgresWorkflowArchiveStore({ ...agentDatabase, maxPoolSize: 2 });
const objectStore = createWorkflowArchiveObjectStore(config.objectStore);
const workflowPool = new pg.Pool({
  application_name: "open-agent-workflow-archive-worker",
  connectionString: config.workflowDatabaseUrl,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
  max: 2,
  query_timeout: config.queryTimeoutMs,
  statement_timeout: config.queryTimeoutMs,
});

let stopped = false;
let wake;
let failureDelayMs = config.intervalMs;
const stopController = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  stopped = true;
  stopController.abort(new Error("Workflow archive worker is stopping."));
  wake?.();
});

try {
  while (!stopped) {
    try {
      const result = await runWorkflowArchivePass({
        archiveStore,
        config: {
          discoveryLimit: config.discoveryLimit,
          leaseMs: config.leaseMs,
          maxRoots: config.maxRoots,
          objectPrefix: config.objectStore.prefix,
          olderThanMs: config.olderThanMs,
          retryBaseMs: config.retryBaseMs,
          schema: config.schema,
          spoolDirectory: config.spoolDirectory,
        },
        now: new Date(),
        objectStore,
        signal: stopController.signal,
        workflowPool,
      });
      failureDelayMs = config.intervalMs;
      if (result.candidates > 0 || result.archived > 0 || result.failed > 0) {
        console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
      }
    } catch (error) {
      if (!stopped) {
        console.error("Workflow archive pass failed", error instanceof Error ? error.message : String(error));
        failureDelayMs = Math.min(60 * 60_000, Math.max(config.intervalMs, failureDelayMs * 2));
      }
    }
    if (!stopped) await interruptibleDelay(failureDelayMs);
  }
} finally {
  objectStore.close();
  await Promise.allSettled([workflowPool.end(), closeAgentDatabasePools()]);
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
