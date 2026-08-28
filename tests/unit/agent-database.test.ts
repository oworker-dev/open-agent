import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

import { getAgentRunAdmissionStats } from "../../server/data/agent-database.ts";

test("AgentRun admission diagnostics return low-cardinality status counters", async () => {
  let statement = "";
  const pool = {
    async query(sql: string) {
      statement = sql;
      return {
        rows: [
          { status: "submitting", count: "1", oldestActiveAt: "2026-08-28T00:02:00.000Z" },
          { status: "running", count: "3", oldestActiveAt: "2026-08-28T00:00:00.000Z" },
          { status: "waiting-input", count: "2", oldestActiveAt: "2026-08-28T00:01:00.000Z" },
          { status: "waiting-authorization", count: "1", oldestActiveAt: "2026-08-28T00:03:00.000Z" },
        ],
      };
    },
  };
  const stats = await getAgentRunAdmissionStats({
    connectionString: "postgresql://unused",
    maxPoolSize: 1,
    schema: "open_agent",
  }, pool as unknown as Pick<Pool, "query">);
  assert.equal(stats.activeRuns, 7);
  assert.equal(stats.byStatus.running, 3);
  assert.equal(stats.byStatus["waiting-input"], 2);
  assert.equal(stats.oldestActiveAt, "2026-08-28T00:00:00.000Z");
  assert.match(statement, /count\(\*\)/u);
  assert.match(statement, /agent_runs/u);
});

test("AgentRun admission diagnostics reject malformed counts", async () => {
  const pool = {
    async query() {
      return {
        rows: [{ status: "running", count: "NaN", oldestActiveAt: null }],
      };
    },
  };
  await assert.rejects(
    () => getAgentRunAdmissionStats({ connectionString: "postgresql://unused", maxPoolSize: 1, schema: "open_agent" }, pool as unknown as Pick<Pool, "query">),
    /Invalid AgentRun admission count/u,
  );
});
