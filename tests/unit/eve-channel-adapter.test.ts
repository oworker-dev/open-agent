import assert from "node:assert/strict";
import test from "node:test";
import { createSession } from "../../node_modules/eve/dist/src/channel/session.js";
import { defaultDeliverResult } from "../../node_modules/eve/dist/src/channel/adapter.js";

// Exercise the current channel contract instead of patching retired revert fields.
test("native default delivery keeps ordinary message and answer contracts", () => {
  assert.deepEqual(defaultDeliverResult({ message: "New request" }), {
    message: "New request", answers: undefined, context: undefined, outputSchema: undefined,
  });
  assert.deepEqual(defaultDeliverResult({ answers: [{ interactionId: "approval", optionId: "approve" }] }), {
    answers: [{ interactionId: "approval", optionId: "approve" }], context: undefined, outputSchema: undefined,
  });
});

test("native session send imports the immutable edit prefix with one idempotency key", async () => {
  const commands: unknown[] = [];
  const session = createSession("session-1", { dispatchSession: async (input: unknown) => {
    commands.push(input); return { status: "accepted", sessionId: "session-1" };
  } } as never);
  const history = [{ id: "first:user", role: "user" as const, text: "First request" }, { id: "first:assistant", role: "assistant" as const, text: "First response" }];
  await session.send("Edited request", { auth: null, history, idempotencyKey: "edit-operation-123", turnPolicy: "queue" });
  const command = (commands[0] as { command: { payload: unknown; idempotencyKey: string; turnPolicy: string } }).command;
  assert.deepEqual(command.payload, { message: "Edited request", history });
  assert.equal(command.idempotencyKey, "edit-operation-123");
  assert.equal(command.turnPolicy, "queue");
});

test("native channel cancellation preserves the observed turn target", async () => {
  let command: unknown;
  const session = createSession("session-1", { dispatchSession: async (input: { command: unknown }) => {
    command = input.command; return { status: "accepted", sessionId: "session-1" };
  } } as never);
  const receipt = await session.cancel({ turnId: "observed-turn" });
  assert.equal(receipt.sessionId, "session-1");
  assert.deepEqual((command as { turnId: string }).turnId, "observed-turn");
});
