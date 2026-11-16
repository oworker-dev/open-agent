import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { closeAgentDatabasePools, getAgentDatabasePool, quoteIdentifier } from "../../server/data/agent-database.ts";
import { createPostgresAgentSubagentStore } from "../../server/data/agent-subagent-store.ts";
import { createPostgresSessionOwnershipStore } from "../../server/data/session-ownership-store.ts";

test("PostgreSQL subagent replay preserves nickname and cannot reopen a closed child", {
  skip: !process.env.AGENT_TEST_DATABASE_URL,
}, async (t) => {
  const config = {
    connectionString: process.env.AGENT_TEST_DATABASE_URL!,
    maxPoolSize: 1,
    schema: `test_subagents_${randomUUID().replaceAll("-", "")}`,
  };
  const pool = getAgentDatabasePool(config);
  const schema = quoteIdentifier(config.schema);
  await pool.query(`create schema ${schema}`);
  t.after(async () => {
    try {
      await pool.query(`drop schema ${schema} cascade`);
    } finally {
      await closeAgentDatabasePools();
    }
  });
  for (const name of ["0001_agent_service.sql", "0003_agent_subagents.sql"]) {
    const migration = await readFile(new URL(`../../server/data/migrations/${name}`, import.meta.url), "utf8");
    await pool.query(migration.replaceAll('"__AGENT_SCHEMA__"', schema));
  }
  const owner = { tenantId: "tenant", principalId: "user", principalType: "user" };
  await createPostgresSessionOwnershipStore(config).claim("parent", owner);
  const store = createPostgresAgentSubagentStore(config);
  const input = { owner, parentSessionId: "parent", childSessionId: "child", callId: "call", name: "agent" };
  await store.create({ ...input, nickname: "Atlas", status: "waiting" });
  const replayed = await store.create({ ...input, nickname: "Overwritten", status: "running" });
  assert.equal(replayed.status, "waiting");
  assert.equal(replayed.nickname, "Atlas");

  await store.updateOwned(owner, "child", { status: "closed" });
  assert.equal((await store.updateOwned(owner, "child", { status: "waiting" }))?.status, "closed");
  assert.equal((await store.create({ ...input, status: "running" })).status, "closed");
  const children = await store.listOwned(owner, "parent");
  assert.equal(children.length, 1);
  assert.equal(children[0]?.nickname, "Atlas");
  assert.equal(children[0]?.status, "closed");
  assert.ok(children[0]?.finishedAt);
  const foreign = { ...owner, principalId: "other-user" };
  assert.equal(await store.updateOwned(foreign, "child", { status: "running" }), undefined);
  assert.equal(await store.findOwned(foreign, "child"), undefined);
});
