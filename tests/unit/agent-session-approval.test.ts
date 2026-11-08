import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryAgentSessionApprovalStore, syncAgentSessionApprovalsFromEvents } from "../../server/agent-sessions/approval.ts";

const request = {
  createdAt: "2030-01-01T00:00:00.000Z",
  input: { command: "npm test" },
  requestId: "approval-1",
  sessionId: "session-1",
  status: "requested" as const,
  toolCallId: "call-1",
  toolName: "bash",
};

test("approval lifecycle is durable, ordered, and idempotent", async () => {
  const store = createMemoryAgentSessionApprovalStore();
  await store.put(request);
  await store.put(request);
  assert.deepEqual(await store.listPending("session-1"), [request]);

  const approved = await store.resolve("approval-1", "approve", "2030-01-01T00:00:01.000Z");
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.selection, "approve");
  assert.deepEqual(await store.listPending("session-1"), []);
  assert.equal((await store.resolve("approval-1", "reject"))?.status, "approved");
});

test("approval request identity cannot be rebound", async () => {
  const store = createMemoryAgentSessionApprovalStore();
  await store.put(request);
  await assert.rejects(
    store.put({ ...request, toolCallId: "call-other" }),
    /already bound/,
  );
});

const at = "2030-01-01T00:00:00.000Z";
const opened = [
  { type: "call.requested", data: { callId: "call-1", owner: { runId: "run" }, capability: { kind: "tool", name: "bash" }, input: request.input } },
  { type: "interaction.opened", scope: { turnId: "turn" }, meta: { at }, data: { interactionId: request.requestId, subject: { callId: "call-1" }, request: { kind: "approval", prompt: "Approve command?" } } },
];

test("native approval projection is replay-safe and keeps settled decisions", async () => {
  const store = createMemoryAgentSessionApprovalStore();
  const options = { sessionId: request.sessionId, store };
  assert.equal((await syncAgentSessionApprovalsFromEvents({ ...options, events: opened })).length, 1);
  assert.deepEqual(await syncAgentSessionApprovalsFromEvents({ ...options, events: [{ type: "interaction.settled", data: { interactionId: request.requestId, outcome: "accepted" }, meta: { at } }] }), []);
  assert.deepEqual(await syncAgentSessionApprovalsFromEvents({ ...options, events: opened }), []);
  assert.equal((await store.get(request.requestId))?.status, "approved");
});

test("settled approval survives a later tool failure", async () => {
  const store = createMemoryAgentSessionApprovalStore();
  await store.put(request);
  await syncAgentSessionApprovalsFromEvents({ sessionId: request.sessionId, store, events: [
    { type: "interaction.settled", data: { interactionId: request.requestId, outcome: "accepted" }, meta: { at } },
    { type: "call.settled", data: { callId: request.toolCallId, outcome: "failed" } },
  ] });
  assert.equal((await store.get(request.requestId))?.status, "approved");
  assert.equal((await store.get(request.requestId))?.resolvedAt, at);
});

test("only authoritative native decisions settle the matching session", async () => {
  const store = createMemoryAgentSessionApprovalStore();
  await store.put(request);
  await store.put({ ...request, requestId: "other", sessionId: "other-session", toolCallId: "other-call" });
  assert.deepEqual(await syncAgentSessionApprovalsFromEvents({ sessionId: request.sessionId, store, events: [
    { type: "response.admitted", data: { interactionId: request.requestId, deliveryId: "d" } },
    { type: "interaction.settled", data: { interactionId: request.requestId, outcome: "invalid" } },
    { type: "interaction.settled", data: { interactionId: "other", outcome: "accepted" } },
  ] }), [request]);
  assert.equal((await store.get("other"))?.status, "requested");
});

for (const [outcome, status] of [["accepted", "approved"], ["declined", "rejected"], ["interrupted", "cancelled"], ["withdrawn", "cancelled"], ["expired", "expired"]] as const) {
  test(`native ${outcome} closes an approval as ${status}`, async () => {
    const store = createMemoryAgentSessionApprovalStore();
    await store.put(request);
    assert.deepEqual(await syncAgentSessionApprovalsFromEvents({ sessionId: request.sessionId, store, events: [
      { type: "interaction.settled", data: { interactionId: request.requestId, outcome } },
    ] }), []);
    assert.equal((await store.get(request.requestId))?.status, status);
  });
}

test("relayed approval keeps the child tool identity and input", async () => {
  const store = createMemoryAgentSessionApprovalStore();
  const pending = await syncAgentSessionApprovalsFromEvents({ sessionId: request.sessionId, store, events: [{
    type: "interaction.opened", meta: { at }, data: { interactionId: "relay", subject: { callId: "delegate" }, request: { kind: "approval", prompt: "Approve?" }, origin: { sessionId: "child", interactionId: "child-approval", call: { callId: "child-call", name: "bash", input: { command: "npm test" } } } },
  }] });
  assert.equal(pending[0]?.toolCallId, "child-call");
  assert.deepEqual(pending[0]?.input, { command: "npm test" });
});

test("an approval crossing a page boundary resolves its call from authoritative earlier events", async () => {
  const store = createMemoryAgentSessionApprovalStore();
  let reads = 0;
  const pending = await syncAgentSessionApprovalsFromEvents({ sessionId: request.sessionId, store,
    events: opened.slice(1), readPriorEvents: async () => { reads++; return opened.slice(0, 1); } });
  assert.equal(reads, 1);
  assert.equal(pending[0]?.toolName, "bash");
  assert.deepEqual(pending[0]?.input, request.input);
  await syncAgentSessionApprovalsFromEvents({ sessionId: request.sessionId, store,
    events: opened, readPriorEvents: async () => { throw new Error("Unnecessary transcript read"); } });
});
