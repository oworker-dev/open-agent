import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createEveAgentMailboxRuntime } from "../../server/agent-mailbox/eve-runtime.ts";
import { enqueueAgentMailboxMessage } from "../../server/agent-mailbox/service.ts";
import { createPostgresAgentMailboxStore, EDIT_ADMISSION_EXPIRED, type AgentMailboxPayload } from "../../server/data/agent-mailbox-store.ts";
import { closeAgentDatabasePools, getAgentDatabasePool, quoteIdentifier, readAgentDatabaseConfig } from "../../server/data/agent-database.ts";
import { createPostgresSessionOwnershipStore } from "../../server/data/session-ownership-store.ts";

// Opt-in fault injection, restricted to the verifier's own authenticated session.
const sessionId = process.env.AGENT_TEST_EVE_SESSION_ID;
assert.ok(sessionId, "Create a conversation as edit-admission-probe first.");
const config = readAgentDatabaseConfig(process.env);
assert.ok(config);
const owner = {
  tenantId: "edit-admission-probe", principalType: "user",
  issuer: process.env.AGENT_HOST_JWT_ISSUER!,
  principalId: `${process.env.AGENT_HOST_JWT_ISSUER}:edit-admission-probe`,
};
const pool = getAgentDatabasePool(config);
const store = createPostgresAgentMailboxStore(config);
const runtime = createEveAgentMailboxRuntime();
const table = `${quoteIdentifier(config.schema)}.agent_mailbox_items`;

try {
  assert.equal(await createPostgresSessionOwnershipStore(config).verify(sessionId, owner), "owned");
  const initial = await runtime.inspect({ owner, sessionId });
  assert.equal(initial.state, "waiting");
  assert.equal(initial.editAdmissionGuard, true);
  const history = await transcript();
  const latest = history.findLast((event) => event.type === "message.received");
  assert.equal(latest?.type, "message.received");
  const expired = await fixture("edit", latest!.data.turnId!, "EXPIRED_EDIT_MUST_NOT_RUN", true);
  await deliver(expired);

  // A following FIFO message settling proves the expired delivery was drained,
  // not merely still waiting in a queue when we inspect the transcript.
  const followup = await fixture("send", undefined, "Reply exactly EDIT_GUARD_FOLLOWUP. Do not call tools.");
  await deliver(followup);
  await waitUntil(async () => {
    const events = await transcript();
    return events.slice(history.length).some((event) => event.type === "message.received" && event.data.message === followup.payload.message)
      && (await runtime.inspect({ owner, sessionId })).state === "waiting";
  });
  const afterExpired = await transcript();
  assert.equal(afterExpired.slice(history.length).some((event) => event.type === "context.cleared"), false);
  assert.equal(afterExpired.some((event) => event.type === "message.received" && event.data.clientMessageId === expired.clientMessageId), false);
  assert.equal((await store.findOwned(owner, expired.itemId))?.status, "cancelled");
  const target = afterExpired.findLast((event) => event.type === "message.received");
  assert.equal(target?.type, "message.received");

  const clientMessageId = `edit-probe-${randomUUID()}`;
  const enqueued = await enqueueAgentMailboxMessage({
    beforeTurnId: target!.data.turnId!, clientMessageId, operationId: clientMessageId,
    message: "Reply exactly EDIT_GUARD_REPLACEMENT. Do not call tools.",
    operationKind: "edit", owner, sessionId, store,
  });
  assert.equal(enqueued.status, "created");
  assert.ok("item" in enqueued);
  const edited = enqueued.item;
  await waitUntil(async () => (await store.findOwned(owner, edited.itemId))?.status === "committed");
  const committed = await store.findOwned(owner, edited.itemId);
  assert.equal(committed?.payload.operation?.consumptionGuard, "edit-v1");
  await waitUntil(async () => {
    const events = await transcript();
    return events.some((event) => event.type === "message.received" && event.data.clientMessageId === edited.clientMessageId)
      && (await runtime.inspect({ owner, sessionId })).state === "waiting";
  });
  const final = await transcript();
  const clears = final.slice(history.length).filter((event) => event.type === "context.cleared");
  assert.equal(clears.length, 1);
  assert.equal(clears[0]?.data.turnId, target!.data.turnId);
  assert.ok(Date.parse(committed!.committedAt!) <= Date.parse(clears[0]!.meta.at));
  assert.equal(final.filter((event) => event.type === "message.received" && event.data.clientMessageId === edited.clientMessageId).length, 1);
  assert.ok(final.some((event) => event.type === "message.completed" && event.data.message?.includes("EDIT_GUARD_REPLACEMENT")));
  console.log(JSON.stringify({
    ok: true, sessionId, expiredEditDropped: true, fifoContinues: true,
    committedBeforeRevert: true, clearCount: clears.length,
    initialEvents: history.length, finalEvents: final.length,
  }));
} finally {
  await closeAgentDatabasePools();
}

function transcript() {
  return Array.fromAsync(runtime.readTranscript!({ sessionId: sessionId!, startIndex: 0 }));
}

async function waitUntil(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 180_000;
  while (!await condition()) {
    assert.ok(Date.now() < deadline, "Runtime probe did not settle within three minutes.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function fixture(kind: "send" | "edit", beforeTurnId: string | undefined, message: string, expired = false) {
  const itemId = `mail-probe-${randomUUID()}`;
  const clientMessageId = `edit-probe-${randomUUID()}`;
  const payload: AgentMailboxPayload = { message, operation: {
    kind, operationId: clientMessageId,
    ...(kind === "edit" ? { beforeTurnId, consumptionGuard: "edit-v1" as const } : {}),
  } };
  const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  await pool.query(`insert into ${table}
    (item_id, session_id, tenant_id, principal_id, principal_type, issuer,
     client_message_id, payload, payload_fingerprint, status, admission_started_at, last_error)
    values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,now(),$11)`, [
    itemId, sessionId, owner.tenantId, owner.principalId, owner.principalType, owner.issuer,
    clientMessageId, JSON.stringify(payload), fingerprint,
    expired ? "cancelled" : "submission-ambiguous", expired ? EDIT_ADMISSION_EXPIRED : null,
  ]);
  return { itemId, clientMessageId, payload };
}

function deliver(item: Awaited<ReturnType<typeof fixture>>) {
  return runtime.deliver({ ...item, owner, sessionId: sessionId! });
}
