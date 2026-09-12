import assert from "node:assert/strict";
import test from "node:test";
import { eveChannel } from "eve/channels/eve";
import type { ChannelAdapter, ChannelAdapterContext } from "../../node_modules/eve/dist/src/channel/adapter.js";
import { withMailboxEditAdmission } from "../../agent/lib/mailbox-edit-admission.ts";
import { createRuntimeAdapterRegistry, deserializeRuntimeAdapter } from "../../node_modules/eve/dist/src/runtime/channels/registry.js";
import type { ResolvedChannelDefinition } from "../../node_modules/eve/dist/src/runtime/types.js";

const payload = { message: "Edited request", revert: { beforeTurnId: "turn_0", clientMessageId: "edit-message-1" } };
const context = {
  session: {
    id: "session-1",
    auth: { current: {
      authenticator: "agent-mailbox-dispatch",
      attributes: { tenantId: "tenant-1", agentMailboxItemId: "mail-1" },
      principalId: "user-1", principalType: "user",
    } },
  },
} as unknown as ChannelAdapterContext;

function registeredChannel(adapter: ChannelAdapter, name = "eve"): ResolvedChannelDefinition {
  return { adapter, name, sourceId: "root", logicalPath: `channels/${name}.ts` } as ResolvedChannelDefinition;
}

test("a restored HTTP session uses the canonical delivery guard", async () => {
  let consumed = false;
  const channel = withMailboxEditAdmission(eveChannel({ auth: [] }), {
    consumeEdit: async () => { consumed = true; return false; },
  }) as unknown as { adapter: ChannelAdapter };
  const registry = createRuntimeAdapterRegistry({ channels: [registeredChannel(channel.adapter), registeredChannel(channel.adapter)] });
  // Existing sessions serialize only kind/state, not functions. Verify the
  // real registry reattaches the guard without changing that durable identity.
  const restored = deserializeRuntimeAdapter(registry, { kind: "http", state: {} });
  assert.equal(await restored.deliver!(payload, context), undefined);
  assert.equal(consumed, true);
});

test("HTTP guard registration still rejects other channel behavior and conflicting guards", () => {
  const adapter = { kind: "http", deliver: () => undefined };
  assert.throws(() => createRuntimeAdapterRegistry({ channels: [registeredChannel(adapter, "other")] }), /reserved/);
  assert.throws(() => createRuntimeAdapterRegistry({ channels: [registeredChannel({ ...adapter, "turn.started": () => {} })] }), /reserved/);
  assert.throws(() => createRuntimeAdapterRegistry({ channels: [registeredChannel(adapter), registeredChannel({ ...adapter, deliver: () => undefined })] }), /Conflicting/);
  assert.equal(deserializeRuntimeAdapter(createRuntimeAdapterRegistry({ channels: [] }), { kind: "http", state: {} }).deliver, undefined);
});

test("a guarded edit is admitted before any revert reaches the harness", async () => {
  const calls: unknown[] = [];
  const channel = withMailboxEditAdmission(eveChannel({ auth: [] }), {
    consumeEdit: async (input) => { calls.push(input); return true; },
  }) as unknown as { adapter: ChannelAdapter };
  assert.equal(channel.adapter.kind, "http");
  const result = await channel.adapter.deliver!(payload, context);
  assert.deepEqual(result?.revert, payload.revert);
  assert.deepEqual(calls, [{
    beforeTurnId: "turn_0", clientMessageId: "edit-message-1", itemId: "mail-1",
    owner: { tenantId: "tenant-1", principalId: "user-1", principalType: "user" }, sessionId: "session-1",
  }]);
});

test("an expired edit is dropped before it can clear context or create a model turn", async () => {
  const channel = withMailboxEditAdmission(eveChannel({ auth: [] }), {
    consumeEdit: async () => false,
  }) as unknown as { adapter: ChannelAdapter };
  assert.equal(await channel.adapter.deliver!(payload, context), undefined);
});

test("ordinary messages and input responses preserve Eve's default projection", async () => {
  const channel = withMailboxEditAdmission(eveChannel({ auth: [] }), {
    consumeEdit: async () => { throw new Error("An ordinary delivery must not use the edit guard"); },
  }) as unknown as { adapter: ChannelAdapter };
  assert.equal((await channel.adapter.deliver!({ message: "New request" }, context))?.message, "New request");
  const responses = [{ requestId: "permission-1", optionId: "approve" }];
  assert.deepEqual((await channel.adapter.deliver!({ inputResponses: responses }, context))?.inputResponses, responses);
});

test("a database outage never lets an unverified edit reach the harness", async () => {
  const channel = withMailboxEditAdmission(eveChannel({ auth: [] }), {
    consumeEdit: async () => { throw new Error("Database unavailable"); },
  }) as unknown as { adapter: ChannelAdapter };
  await assert.rejects(() => Promise.resolve(channel.adapter.deliver!(payload, context)), /Database unavailable/);
});
