import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { closeAgentDatabasePools, getAgentDatabasePool, quoteIdentifier } from "../../server/data/agent-database.ts";
import { createPostgresThreadCollectionStore } from "../../server/data/thread-collection-store.ts";
import { line } from "../helpers/session-events.ts";

test("PostgreSQL orders late recovery facts by source position with contiguous pagination", {
  skip: !process.env.AGENT_TEST_DATABASE_URL,
}, async (t) => {
  const config = { connectionString: process.env.AGENT_TEST_DATABASE_URL!, maxPoolSize: 2,
    schema: `test_event_order_${randomUUID().replaceAll("-", "")}` };
  const pool = getAgentDatabasePool(config);
  const schema = quoteIdentifier(config.schema);
  await pool.query(`create schema ${schema}`);
  t.after(async () => {
    try { await pool.query(`drop schema ${schema} cascade`); }
    finally { await closeAgentDatabasePools(); }
  });
  for (const file of ["0001_agent_service.sql", "0010_thread_event_log.sql"]) {
    const sql = await readFile(new URL(`../../server/data/migrations/${file}`, import.meta.url), "utf8");
    await pool.query(sql.replaceAll('"__AGENT_SCHEMA__"', schema));
  }
  const store = createPostgresThreadCollectionStore(config);
  const event = (position: number) => line(position, { type: "delivery.admitted", data: {
    deliveryId: `delivery-${position}`, source: { channel: "eve" },
  } });
  const first = event(0), last = event(3);
  const saved = await store.save("tenant", "user", "workspace", 0, {
    version: 2, threads: [{ id: "thread", events: [...first, ...last], status: "ready" }],
  });
  assert.equal(saved.status, "saved");
  if (saved.status !== "saved") throw new Error("Fixture save failed");
  const middle = line(1,
    { type: "delivery.admitted", data: { deliveryId: "middle", source: { channel: "eve" } } },
    { type: "delivery.settled", data: { deliveryId: "middle", outcome: "ignored" } });
  const arrivals = [...event(2), ...last, ...middle, ...middle];
  let revision = saved.record.revision;
  for (let replay = 0; replay < 2; replay++) {
    const result = await store.patch!("tenant", "user", "workspace", revision, {
      deletedThreadIds: [], upsertThreads: [], eventAppends: [{ threadId: "thread", events: arrivals }],
    });
    assert.equal(result.status, "saved");
    if (result.status !== "saved") throw new Error("Fixture patch failed");
    revision = result.record.revision;
    const rows = await pool.query(`select event_index::int, event from ${schema}.agent_thread_events order by event_index`);
    assert.deepEqual(rows.rows.map((row) => row.event_index), [0, 1, 2, 3, 4]);
    assert.deepEqual(rows.rows.map((row) => row.event.meta.position), [
      { line: 0, index: 0 }, { line: 1, index: 0 }, { line: 1, index: 1 },
      { line: 2, index: 0 }, { line: 3, index: 0 },
    ]);
    const tail = await store.loadThreadWindow!("tenant", "user", "workspace", "thread", { limit: 2 });
    const prefix = await store.loadThreadWindow!("tenant", "user", "workspace", "thread", { before: 3, limit: 3 });
    assert.deepEqual(tail?.window, { startIndex: 3, endIndex: 5, total: 5, hasMoreBefore: true });
    assert.deepEqual(prefix?.window, { startIndex: 0, endIndex: 3, total: 5, hasMoreBefore: false });
  }
});
