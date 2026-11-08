import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conversationOf } from "eve/client";
import { conversation } from "eve/events";
import { createEveAgentMailboxRuntime } from "../../server/agent-mailbox/eve-runtime.ts";
import { enqueueAgentMailboxMessage } from "../../server/agent-mailbox/service.ts";
import { createPostgresAgentMailboxStore } from "../../server/data/agent-mailbox-store.ts";
import { closeAgentDatabasePools, readAgentDatabaseConfig } from "../../server/data/agent-database.ts";
import { createPostgresSessionOwnershipStore } from "../../server/data/session-ownership-store.ts";

// Opt-in: only mutate the verifier's explicitly owned disposable conversation.
const sessionId = process.env.AGENT_TEST_EVE_SESSION_ID;
assert.ok(sessionId, "Create a disposable conversation as edit-admission-probe first.");
const config = readAgentDatabaseConfig(process.env);
assert.ok(config);
const issuer = process.env.AGENT_HOST_JWT_ISSUER;
assert.ok(issuer);
const owner = { tenantId: "edit-admission-probe", principalType: "user", issuer,
  principalId: `${issuer}:edit-admission-probe` };
const store = createPostgresAgentMailboxStore(config);
const runtime = createEveAgentMailboxRuntime();
const transcript = () => Array.fromAsync(runtime.readTranscript!({ sessionId, startIndex: 0 }));

async function waitUntil<T>(read: () => Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const value = await read();
    if (value) return value;
    assert.ok(Date.now() < deadline, "The v27 edit/cancel probe did not settle within three minutes.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

try {
  assert.equal(await createPostgresSessionOwnershipStore(config).verify(sessionId, owner), "owned");
  assert.equal((await runtime.inspect({ owner, sessionId })).state, "waiting");
  const initial = await transcript();
  let target = conversation(conversationOf(initial).view).at(-1)?.turnId;
  assert.ok(target, "The probe needs an existing user turn to edit.");
  const results: { itemId: string; turnId: string; cancelled: boolean }[] = [];
  for (let index = 0; index < 3; index++) {
    const clientMessageId = `edit-probe-${randomUUID()}`;
    const message = `Reply exactly EDIT_PROBE_${index}. Do not call tools.`;
    const result = await enqueueAgentMailboxMessage({ beforeTurnId: target,
      clientMessageId, operationId: clientMessageId, operationKind: "edit", message, owner, sessionId, store });
    assert.equal(result.status, "created");
    assert.ok("item" in result);
    const item = result.item;
    const received = await waitUntil(async () => (await transcript()).find((event) =>
      event.type === "delivery.consumed" && event.data.parts.some((part) => part.kind === "text" && part.text === message)));
    assert.equal(received.type, "delivery.consumed");
    const turnId = received.data.turnId;
    if (index < 2) assert.equal(await runtime.cancel!({ owner, sessionId, turnId }), "accepted");
    await waitUntil(async () => (await runtime.inspect({ owner, sessionId })).state === "waiting");
    const committed = await store.findOwned(owner, item.itemId);
    assert.equal(committed?.status, "committed");
    assert.equal(committed.editPlan?.phase, "cleared");
    const events = await transcript();
    assert.equal(events.filter((event) => event.type === "delivery.consumed" &&
      event.data.parts.some((part) => part.kind === "text" && part.text === message)).length, 1);
    const selected = conversation(conversationOf(events).view);
    assert.equal(selected.at(-1)?.turnId, turnId);
    assert.equal(selected.some((turn) => turn.turnId === target), false);
    results.push({ itemId: item.itemId, turnId, cancelled: index < 2 });
    target = turnId;
  }
  const final = await transcript();
  const clears = final.slice(initial.length).filter((event) => event.type === "context.settled" && event.data.kind === "clear");
  assert.equal(clears.length, 3);
  assert.ok(clears.every((event) => event.type === "context.settled" && event.data.outcome === "completed"));
  console.log(JSON.stringify({ ok: true, sessionId, edits: results, clears: clears.length,
    initialFacts: initial.length, finalFacts: final.length }));
} finally {
  await closeAgentDatabasePools();
}
