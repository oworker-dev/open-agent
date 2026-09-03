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

test("Eve mailbox runtime reads a finite authoritative transcript", async () => {
  let requestBody: unknown;
  const events = [
    { type: "session.started", data: {}, meta: { at: "2026-01-01T00:00:00.000Z", id: "evt-1" } },
    { type: "session.waiting", data: {}, meta: { at: "2026-01-01T00:00:01.000Z", id: "evt-2" } },
  ];
  const runtime = createEveAgentMailboxRuntime(environment, async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(""), {
      headers: { "content-type": "application/x-ndjson" },
    });
  });

  const received = [];
  for await (const event of runtime.readTranscript!({ sessionId: "session-1", startIndex: 0 })) {
    received.push(event);
  }
  assert.deepEqual(requestBody, { action: "transcript", sessionId: "session-1", startIndex: 0 });
  assert.equal(received.length, 2);
  assert.equal(received[1]?.type, "session.waiting");
});

test("Eve mailbox runtime forwards the exact edit target and operation identity", async () => {
  let requestBody: unknown;
  const runtime = createEveAgentMailboxRuntime(environment, async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ ok: true, sessionId: "session-1" }, { status: 202 });
  });

  await runtime.deliver({
    clientMessageId: "message-edit-1",
    itemId: "mail-edit-1",
    owner: owner(),
    payload: {
      message: "Edited latest request",
      operation: {
        beforeTurnId: "turn-latest",
        kind: "edit",
        operationId: "operation-edit-1",
      },
    },
    sessionId: "session-1",
  });

  assert.deepEqual(requestBody, {
    action: "deliver",
    beforeTurnId: "turn-latest",
    clientMessageId: "message-edit-1",
    itemId: "mail-edit-1",
    message: "Edited latest request",
    operationId: "operation-edit-1",
    operationKind: "edit",
    principalId: "user-1",
    principalType: "user",
    sessionId: "session-1",
    tenantId: "tenant-1",
  });
});

test("Eve mailbox runtime forwards structured input responses without synthesizing text", async () => {
  let requestBody: unknown;
  const runtime = createEveAgentMailboxRuntime(environment, async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ ok: true, sessionId: "session-1" }, { status: 202 });
  });

  await runtime.deliver({
    clientMessageId: "response-request-1",
    itemId: "mail-response-1",
    owner: owner(),
    payload: {
      inputResponses: [{ optionId: "approve", requestId: "request-approval-1" }],
      operation: { kind: "respond", operationId: "response-request-1" },
    },
    sessionId: "session-1",
  });

  assert.deepEqual(requestBody, {
    action: "deliver",
    clientMessageId: "response-request-1",
    inputResponses: [{ optionId: "approve", requestId: "request-approval-1" }],
    itemId: "mail-response-1",
    operationId: "response-request-1",
    operationKind: "respond",
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

test("Eve mailbox runtime sends signed cancellation and terminal reset controls", async () => {
  const requests: unknown[] = [];
  const runtime = createEveAgentMailboxRuntime(environment, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return body.action === "cancel"
      ? Response.json({ ok: true, sessionId: "session-1", status: "accepted" }, { status: 202 })
      : Response.json({ ok: true, previousSessionId: "session-1", status: "reset" });
  });

  assert.equal(await runtime.cancel!({ owner: owner(), sessionId: "session-1", turnId: "turn-1" }), "accepted");
  assert.equal(await runtime.reset!({ owner: owner(), reason: "closed", sessionId: "session-1" }), "reset");
  assert.deepEqual(requests, [
    { action: "cancel", sessionId: "session-1", turnId: "turn-1" },
    { action: "reset", reason: "closed", sessionId: "session-1" },
  ]);
});

test("Eve mailbox runtime rejects malformed lifecycle responses", async () => {
  const runtime = createEveAgentMailboxRuntime(environment, async () =>
    Response.json({ ok: true, status: "maybe" }),
  );
  await assert.rejects(
    runtime.cancel!({ owner: owner(), sessionId: "session-1" }),
    /cancellation failed/i,
  );
  await assert.rejects(
    runtime.reset!({ owner: owner(), sessionId: "session-1" }),
    /reset failed/i,
  );
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
