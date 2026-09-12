import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { closeAgentDatabasePools, getAgentDatabasePool, quoteIdentifier } from "../../server/data/agent-database.ts";
import { createPostgresAgentMailboxStore, EDIT_ADMISSION_EXPIRED, type AgentMailboxPayload } from "../../server/data/agent-mailbox-store.ts";
import { createPostgresSessionOwnershipStore } from "../../server/data/session-ownership-store.ts";

// Each run owns a separate schema. Production mailbox workers cannot dispatch
// these fixtures, even when the test database shares a PostgreSQL instance.
test("PostgreSQL rejects unsafe steer edits before enqueue", {
  skip: !process.env.AGENT_TEST_DATABASE_URL,
}, async (t) => {
  const config = {
    connectionString: process.env.AGENT_TEST_DATABASE_URL!,
    maxPoolSize: 2,
    schema: `test_steer_edit_${randomUUID().replaceAll("-", "")}`,
  };
  const pool = getAgentDatabasePool(config);
  const schema = quoteIdentifier(config.schema);
  const migration = await readFile(new URL("../../server/data/migrations/0001_agent_service.sql", import.meta.url), "utf8");
  await pool.query(`create schema ${schema}`);
  t.after(async () => {
    try {
      await pool.query(`drop schema ${schema} cascade`);
    } finally {
      await closeAgentDatabasePools();
    }
  });
  await pool.query(migration.replaceAll('"__AGENT_SCHEMA__"', schema));
  const store = createPostgresAgentMailboxStore(config);
  const owners = createPostgresSessionOwnershipStore(config);
  const owner = { tenantId: "tenant", principalId: "user", principalType: "user" };
  const enqueue = (sessionId: string, kind: "steer" | "edit" | "send", turnId = "turn_0", clientMessageId: string = randomUUID()) => {
    const payload: AgentMailboxPayload = {
      message: "Test input",
      operation: {
        kind, operationId: clientMessageId,
        ...(kind === "steer" ? { expectedTurnId: turnId } : {}),
        ...(kind === "edit" ? { beforeTurnId: turnId } : {}),
      },
    };
    const payloadFingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return store.enqueue({ sessionId, owner, clientMessageId, payload, payloadFingerprint });
  };

  for (const status of ["queued", "accepted", "committed", "submission-ambiguous", "cancelled", "failed"] as const) {
    await t.test(`${status} steer`, async () => {
      const sessionId = `session-${status}`;
      await owners.claim(sessionId, owner);
      const steer = await enqueue(sessionId, "steer");
      assert.equal(steer.status, "created");
      if (!("item" in steer)) throw new Error("Missing fixture item");
      await pool.query(`update ${schema}.agent_mailbox_items set status = $1 where item_id = $2`, [status, steer.item.itemId]);
      const edit = await enqueue(sessionId, "edit");
      const blocked = status !== "cancelled" && status !== "failed";
      assert.equal(edit.status, blocked ? "unsupported-edit" : "created");
      const count = await pool.query(`select count(*)::int as count from ${schema}.agent_mailbox_items where session_id = $1`, [sessionId]);
      assert.equal(count.rows[0].count, blocked ? 1 : 2);
      assert.equal((await enqueue(sessionId, "edit", "turn_1")).status, "created");
      assert.equal((await enqueue(sessionId, "send")).status, "created");
    });
  }

  await t.test("rejected edit leaves the next request dispatchable", async () => {
    const sessionId = "session-dispatch";
    await owners.claim(sessionId, owner);
    const steer = await enqueue(sessionId, "steer");
    if (!("item" in steer)) throw new Error("Missing fixture item");
    await pool.query(`update ${schema}.agent_mailbox_items set status = 'accepted' where item_id = $1`, [steer.item.itemId]);
    await store.commit(steer.item.itemId, sessionId);
    assert.equal((await enqueue(sessionId, "edit")).status, "unsupported-edit");
    const next = await enqueue(sessionId, "send");
    if (!("item" in next)) throw new Error("Missing fixture item");
    // Defer unrelated fixtures so claimNext deterministically selects this row.
    await pool.query(`update ${schema}.agent_mailbox_items set available_at = now() + interval '1 day' where session_id <> $1`, [sessionId]);
    assert.equal((await store.claimNext())?.itemId, next.item.itemId);
  });

  await t.test("idempotent replay and owner isolation remain unchanged", async () => {
    const sessionId = "session-replay";
    await owners.claim(sessionId, owner);
    const edit = await enqueue(sessionId, "edit", "turn_0", "original-edit");
    if (!("item" in edit)) throw new Error("Missing fixture item");
    assert.equal((await enqueue(sessionId, "steer")).status, "created");
    const replay = await enqueue(sessionId, "edit", "turn_0", "original-edit");
    assert.equal(replay.status, "replay");
    if (!("item" in replay)) throw new Error("Missing replay item");
    assert.equal(replay.item.itemId, edit.item.itemId);
    assert.equal((await enqueue(sessionId, "edit", "turn_1", "original-edit")).status, "conflict");
    assert.equal((await store.enqueue({
      sessionId, owner: { ...owner, principalId: "other-user" },
      clientMessageId: "foreign-edit", payloadFingerprint: "foreign-edit", payload: edit.item.payload,
    })).status, "forbidden");
    await owners.claim("session-no-steer", owner);
    assert.equal((await enqueue("session-no-steer", "edit")).status, "created");
  });

  const admittedEdit = async (guardEdit = true) => {
    const sessionId = `session-guard-${randomUUID()}`;
    await owners.claim(sessionId, owner);
    await pool.query(`update ${schema}.agent_mailbox_items set available_at = now() + interval '1 day'`);
    const result = await enqueue(sessionId, "edit");
    if (!("item" in result)) throw new Error("Missing edit fixture");
    const claimed = await store.claimNext();
    assert.equal(claimed?.itemId, result.item.itemId);
    const item = await store.beginAdmission(claimed!.itemId, claimed!.claimToken!, { guardEdit });
    return { beforeTurnId: "turn_0", clientMessageId: item.clientMessageId, itemId: item.itemId, owner, sessionId };
  };
  const expire = async (itemId: string) => {
    await pool.query(`update ${schema}.agent_mailbox_items set admission_started_at = now() - interval '3 minutes' where item_id = $1`, [itemId]);
    await store.claimNext();
  };

  await t.test("unconsumed guarded edits expire and late delivery cannot rewind context", async () => {
    const input = await admittedEdit();
    await expire(input.itemId);
    const expired = await store.findOwned(owner, input.itemId);
    assert.equal(expired?.status, "cancelled");
    assert.equal(expired?.lastError, EDIT_ADMISSION_EXPIRED);
    assert.equal(await store.consumeEdit(input), false);
    const next = await enqueue(input.sessionId, "send");
    if (!("item" in next)) throw new Error("Missing next request");
    assert.equal((await store.claimNext())?.itemId, next.item.itemId);
  });

  await t.test("consumed edits survive slow model output and durable step replay", async () => {
    const input = await admittedEdit();
    assert.equal(await store.consumeEdit(input), true);
    await expire(input.itemId);
    assert.equal((await store.findOwned(owner, input.itemId))?.status, "committed");
    assert.equal(await store.consumeEdit(input), true);
    assert.equal(await store.consumeEdit({ ...input, beforeTurnId: "other-turn" }), false);
    assert.equal(await store.consumeEdit({ ...input, owner: { ...owner, principalId: "other-user" } }), false);
  });

  await t.test("expiry and consumption have exactly one winner", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const input = await admittedEdit();
      await pool.query(`update ${schema}.agent_mailbox_items set admission_started_at = now() - interval '3 minutes' where item_id = $1`, [input.itemId]);
      const [consumed] = await Promise.all([store.consumeEdit(input), store.claimNext()]);
      assert.equal((await store.findOwned(owner, input.itemId))?.status, consumed ? "committed" : "cancelled");
    }
  });

  await t.test("old runtimes do not opt into an unsupported expiry protocol", async () => {
    const input = await admittedEdit(false);
    await expire(input.itemId);
    assert.notEqual((await store.findOwned(owner, input.itemId))?.status, "cancelled");
  });
});
