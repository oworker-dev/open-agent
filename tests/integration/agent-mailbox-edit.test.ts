import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { closeAgentDatabasePools, getAgentDatabasePool, quoteIdentifier } from "../../server/data/agent-database.ts";
import { createPostgresAgentMailboxStore, type AgentMailboxPayload } from "../../server/data/agent-mailbox-store.ts";
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
  const transactionMigration = await readFile(new URL("../../server/data/migrations/0028_mailbox_edit_transactions.sql", import.meta.url), "utf8");
  await pool.query(transactionMigration.replaceAll('"__AGENT_SCHEMA__"', schema));
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

  const admittedEdit = async () => {
    const sessionId = `session-edit-${randomUUID()}`;
    await owners.claim(sessionId, owner);
    await pool.query(`update ${schema}.agent_mailbox_items set available_at = now() + interval '1 day'`);
    const result = await enqueue(sessionId, "edit");
    if (!("item" in result)) throw new Error("Missing edit fixture");
    const claimed = await store.claimNext();
    assert.equal(claimed?.itemId, result.item.itemId);
    return store.beginAdmission(claimed!.itemId, claimed!.claimToken!);
  };
  const plan = { phase: "prepared" as const, history: [{ id: "original", role: "user" as const, text: "prefix" }], startIndex: 7 };

  await t.test("concurrent attempts claim one clear and preserve the immutable prefix", async () => {
    const item = await admittedEdit();
    await store.prepareEdit(item.itemId, plan);
    const claims = await Promise.all([store.claimEditClear(item.itemId), store.claimEditClear(item.itemId)]);
    assert.equal(claims.filter(Boolean).length, 1);
    await store.prepareEdit(item.itemId, { ...plan, history: [] });
    assert.deepEqual((await store.findOwned(owner, item.itemId))?.editPlan?.history, plan.history);
    await store.recordEditClear(item.itemId, "native-clear-delivery");
    await assert.rejects(store.recordEditClear(item.itemId, "different-delivery"));
    await store.completeEditClear(item.itemId);
    await store.completeEditClear(item.itemId);
    assert.equal((await store.findOwned(owner, item.itemId))?.editPlan?.phase, "cleared");
  });

  await t.test("stopping an admitted edit persists intent without unblocking its successor", async () => {
    const item = await admittedEdit();
    await store.prepareEdit(item.itemId, plan);
    await store.claimEditClear(item.itemId);
    const cancelled = await store.cancelOwned(owner, item.itemId);
    assert.ok(cancelled?.cancellationRequestedAt);
    assert.equal(cancelled.status, "delivering");
    const next = await enqueue(item.sessionId, "send");
    assert.equal(next.status, "created");
    assert.equal(await store.claimNext(), undefined);
    const committed = await store.commit(item.itemId, item.sessionId);
    assert.ok(committed.cancellationRequestedAt);
    assert.notEqual(await store.claimNext(), undefined);
    assert.equal(await store.cancelOwned({ ...owner, principalId: "other" }, item.itemId), undefined);
  });

  await t.test("an expired edit lease resumes its plan without reclaiming clear", async () => {
    const item = await admittedEdit();
    await store.prepareEdit(item.itemId, plan);
    assert.equal(await store.claimEditClear(item.itemId), true);
    await pool.query(`update ${schema}.agent_mailbox_items set claim_expires_at = now() - interval '1 second' where item_id = $1`, [item.itemId]);
    const recovered = await store.claimNext();
    assert.equal(recovered?.itemId, item.itemId);
    assert.notEqual(recovered?.claimToken, item.claimToken);
    assert.equal(recovered?.editPlan?.phase, "clearing");
    assert.equal(await store.claimEditClear(item.itemId), false);
  });
});
