import assert from "node:assert/strict";
import test from "node:test";
import { serializeAssetPrompt } from "@oworker/open-agent-contracts/asset";
import type { DeliveryConsumedData, Principal } from "eve/events";
import type { AgentMailboxItem } from "../../server/data/agent-mailbox-store.ts";
import { commitConsumedMailboxMessage } from "../../agent/lib/mailbox-consumption.ts";

const principal: Principal = { id: "user", type: "user", issuer: "host" };
const item = {
  itemId: "mail-1", clientMessageId: "client-message-1", sessionId: "session-1",
  principalId: "user", principalType: "user", issuer: "host",
  admissionStartedAt: "2026-11-13T00:00:00Z", status: "accepted",
  payload: { message: "Change the task" },
} as AgentMailboxItem;
const consumed: DeliveryConsumedData = {
  deliveryId: "delivery-1", turnId: "same-turn",
  parts: [{ kind: "text", text: serializeAssetPrompt(item.payload.message!, [], item.clientMessageId) }],
};

test("same-turn question and steering messages commit their own receipt independently of turn auth", async () => {
  const committed: string[] = [];
  const items = [item, { ...item, itemId: "mail-2", clientMessageId: "client-message-2", payload: { message: "Another instruction" } }];
  const store = {
    async findByClientMessageId(sessionId: string, clientMessageId: string) {
      assert.equal(sessionId, "session-1");
      return items.find((candidate) => candidate.clientMessageId === clientMessageId);
    },
    async commit(itemId: string, sessionId: string) {
      assert.equal(sessionId, "session-1");
      committed.push(itemId);
      return { ...items.find((candidate) => candidate.itemId === itemId)!, status: "committed" as const };
    },
  };
  for (const candidate of items) {
    const result = await commitConsumedMailboxMessage({
      consumed: { ...consumed, parts: [{ kind: "text", text: serializeAssetPrompt(candidate.payload.message!, [], candidate.clientMessageId) }] },
      principal, sessionId: "session-1", store,
    });
    assert.equal(result?.itemId, candidate.itemId);
  }
  assert.deepEqual(committed, ["mail-1", "mail-2"]);
});

test("message markers cannot commit an unadmitted, foreign or different mailbox payload", async () => {
  const cases: { item?: AgentMailboxItem; principal?: Principal; consumed?: DeliveryConsumedData }[] = [
    {},
    { item },
    { item, principal: { ...principal, id: "other" } },
    { item, principal: { ...principal, type: "service" } },
    { item, principal: { ...principal, issuer: "other" } },
    { item: { ...item, admissionStartedAt: undefined }, principal },
    { item: { ...item, payload: { message: "Different text" } }, principal },
    { item: { ...item, payload: { inputResponses: [] } }, principal },
    { item, principal, consumed: { ...consumed, parts: [{ kind: "text", text: "No marker" }] } },
  ];
  for (const candidate of cases) {
    const result = await commitConsumedMailboxMessage({
      consumed: candidate.consumed ?? consumed, principal: candidate.principal,
      sessionId: "session-1", store: {
        async findByClientMessageId() { return candidate.item; },
        async commit() { assert.fail("Unrelated input must never commit a mailbox receipt"); },
      },
    });
    assert.equal(result, undefined);
  }
});
