import assert from "node:assert/strict";
import test from "node:test";
import { createEveAgentMailboxRuntime } from "../../server/agent-mailbox/eve-runtime.ts";
import { AgentMailboxAdmissionError } from "../../server/agent-mailbox/service.ts";

const environment = {
  AGENT_MAILBOX_DISPATCH_SECRET: "mailbox-dispatch-test-secret-at-least-32-bytes",
  AGENT_RUNTIME_URL: "https://runtime.test",
};

test("Eve mailbox runtime reads waiting boundaries and admits messages", async () => {
  const requests: unknown[] = [];
  const runtime = createEveAgentMailboxRuntime(environment, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return body.action === "inspect"
      ? Response.json({ ok: true, state: "waiting" })
      : Response.json({ ok: true, sessionId: "session-1" }, { status: 202 });
  });

  assert.deepEqual(await runtime.inspect({ owner: owner(), sessionId: "session-1" }), {
    state: "waiting",
  });
  assert.deepEqual(await runtime.deliver({
    clientMessageId: "message-1",
    itemId: "mail-1",
    owner: owner(),
    payload: {
      message: "Continue",
      operation: {
        expectedTurnId: "turn-1",
        kind: "steer",
        operationId: "operation-1",
      },
    },
    sessionId: "session-1",
  }), { sessionId: "session-1" });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], {
    action: "deliver",
    clientMessageId: "message-1",
    expectedTurnId: "turn-1",
    itemId: "mail-1",
    message: "Continue",
    operationId: "operation-1",
    operationKind: "steer",
    principalId: "user-1",
    principalType: "user",
    sessionId: "session-1",
    tenantId: "tenant-1",
  });
});


test("Eve mailbox runtime retains the active turn identity", async () => {
  const runtime = createEveAgentMailboxRuntime(environment, async () =>
    Response.json({ ok: true, state: "running", turnId: "turn-active" })
  );

  assert.deepEqual(await runtime.inspect({ owner: owner(), sessionId: "session-1" }), {
    state: "running",
    turnId: "turn-active",
  });
});

test("Eve mailbox runtime preserves a failed terminal boundary", async () => {
  const runtime = createEveAgentMailboxRuntime(environment, async () =>
    Response.json({ ok: true, state: "terminal", terminalStatus: "failed" }),
  );

  assert.deepEqual(await runtime.inspect({ owner: owner(), sessionId: "session-1" }), {
    state: "terminal",
    terminalStatus: "failed",
  });
});

test("Eve mailbox runtime distinguishes rejection from ambiguous admission", async () => {
  const busy = createEveAgentMailboxRuntime(environment, async () =>
    Response.json({ code: "mailbox_turn_active", error: "Still running", ok: false }, { status: 409 })
  );
  await assert.rejects(
    busy.deliver({
      clientMessageId: "message-1",
      itemId: "mail-1",
      owner: owner(),
      payload: { message: "Continue" },
      sessionId: "session-1",
    }),
    (error: unknown) => error instanceof AgentMailboxAdmissionError && error.disposition === "busy",
  );

  const rejected = createEveAgentMailboxRuntime(environment, async () =>
    Response.json({ code: "mailbox_session_running", error: "Still running", ok: false }, { status: 409 })
  );
  await assert.rejects(
    rejected.deliver({
      clientMessageId: "message-1",
      itemId: "mail-1",
      owner: owner(),
      payload: { message: "Continue" },
      sessionId: "session-1",
    }),
    (error: unknown) => error instanceof AgentMailboxAdmissionError && error.disposition === "rejected",
  );

  const ambiguous = createEveAgentMailboxRuntime(environment, async () => {
    throw new TypeError("socket closed");
  });
  await assert.rejects(
    ambiguous.deliver({
      clientMessageId: "message-1",
      itemId: "mail-1",
      owner: owner(),
      payload: { message: "Continue" },
      sessionId: "session-1",
    }),
    (error: unknown) => error instanceof AgentMailboxAdmissionError && error.disposition === "ambiguous",
  );
});

function owner() {
  return {
    principalId: "user-1",
    principalType: "user",
    tenantId: "tenant-1",
  } as const;
}
