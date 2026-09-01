import assert from "node:assert/strict";
import test from "node:test";
import { defaultDeliverResult } from "../../node_modules/eve/dist/src/channel/adapter.js";
import { createSession } from "../../node_modules/eve/dist/src/channel/session.js";

test("Eve default channel delivery preserves an edit revert precondition", () => {
  const revert = {
    beforeTurnId: "turn-latest",
    clientMessageId: "edit-session-turn-latest",
  } as const;
  const result = defaultDeliverResult({
    message: "Edited request",
    operation: "edit",
    revert,
  });

  assert.deepEqual(result, {
    message: "Edited request",
    inputResponses: undefined,
    context: undefined,
    outputSchema: undefined,
    revert,
  });
});

test("Eve default channel delivery does not invent a revert for ordinary messages", () => {
  const result = defaultDeliverResult({ message: "New request" });

  assert.deepEqual(result, {
    message: "New request",
    inputResponses: undefined,
    context: undefined,
    outputSchema: undefined,
  });
  assert.equal(result && "revert" in result, false);
});

test("Eve session.send serializes the edit revert into the durable command payload", async () => {
  const commands: unknown[] = [];
  const session = createSession("session-1", {
    dispatchSession: async (input: unknown) => {
      commands.push(input);
      return { status: "accepted", sessionId: "session-1" };
    },
  } as never);

  const revert = {
    beforeTurnId: "turn-latest",
    clientMessageId: "edit-session-turn-latest",
  } as const;
  await session.send("Edited request", { auth: null, revert });

  assert.deepEqual((commands[0] as { command: { payload: unknown } }).command.payload, {
    message: "Edited request",
    revert,
  });
});
