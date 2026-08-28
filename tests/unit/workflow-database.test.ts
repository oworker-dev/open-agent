import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

import {
  getWorkflowRuntimeStats,
  readWorkflowDatabaseConfig,
} from "../../server/data/workflow-database.ts";

test("Workflow metrics config is bounded and defaults to a small pool", () => {
  const config = readWorkflowDatabaseConfig({
    WORKFLOW_POSTGRES_URL: "postgres://workflow.example/world",
  });
  assert.deepEqual(config, {
    connectionString: "postgres://workflow.example/world",
    schema: "workflow",
    maxPoolSize: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    queryTimeoutMillis: 15_000,
  });
});

test("Workflow metrics config rejects unsafe timeout values", () => {
  assert.throws(
    () => readWorkflowDatabaseConfig({
      WORKFLOW_POSTGRES_URL: "postgres://workflow.example/world",
      WORKFLOW_POSTGRES_QUERY_TIMEOUT_MS: "99",
    }),
    /WORKFLOW_POSTGRES_QUERY_TIMEOUT_MS must be an integer from 100 to 300000/u,
  );
  assert.throws(
    () => readWorkflowDatabaseConfig({
      WORKFLOW_POSTGRES_URL: "postgres://workflow.example/world",
      WORKFLOW_POSTGRES_SCHEMA: "workflow;drop table",
    }),
    /WORKFLOW_POSTGRES_SCHEMA must be a valid PostgreSQL identifier/u,
  );
});

test("Workflow runtime metrics distinguish active and terminal runs", async () => {
  let queryText = "";
  const stats = await getWorkflowRuntimeStats(
    {
      connectionString: "postgres://workflow.example/world",
      schema: "workflow",
      maxPoolSize: 1,
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: 1_000,
      queryTimeoutMillis: 1_000,
    },
    {
      async query(text: string) {
        queryText = text;
        return {
          rows: [
            { status: "running", count: "3", oldestActiveAt: new Date("2026-08-28T00:00:00.000Z") },
            { status: "completed", count: "10", oldestActiveAt: null },
            { status: "waiting", count: "2", oldestActiveAt: "2026-08-28T01:00:00.000Z" },
          ],
        };
      },
    } as unknown as Pick<Pool, "query">,
  );

  assert.equal(stats.available, true);
  assert.equal(stats.activeRuns, 5);
  assert.deepEqual(stats.byStatus, { running: 3, completed: 10, waiting: 2 });
  assert.equal(stats.oldestActiveAt, "2026-08-28T00:00:00.000Z");
  assert.match(queryText, /workflow"\."workflow_runs/u);
  assert.match(queryText, /filter/u);
});

test("Workflow runtime metrics reject malformed counts", async () => {
  await assert.rejects(
    getWorkflowRuntimeStats(
      {
        connectionString: "postgres://workflow.example/world",
        schema: "workflow",
        maxPoolSize: 1,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        queryTimeoutMillis: 1_000,
      },
      { query: async () => ({ rows: [{ status: "running", count: "NaN", oldestActiveAt: null }] }) } as unknown as Pick<Pool, "query">,
    ),
    /Invalid Workflow run count/u,
  );
});
