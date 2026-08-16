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

test("approval projection is replay-safe and keeps resolved requests resolved", async () => {
  const store = createMemoryAgentSessionApprovalStore();
  const events = [
    {
      type: "input.requested",
      data: {
        requests: [{
          action: { callId: "call-2", input: { command: "rm -rf /tmp/demo" }, kind: "tool-call", toolName: "bash" },
          kind: "tool-approval",
          prompt: "Approve command?",
          requestId: "approval-2",
        }],
        turnId: "turn-2",
      },
      meta: { at: "2030-01-01T00:00:00.000Z" },
    },
    {
      type: "action.result",
      data: {
        result: { callId: "call-2", kind: "tool-result", isError: false, output: "ok", toolName: "bash" },
        status: "completed",
      },
      meta: { at: "2030-01-01T00:00:01.000Z" },
    },
  ] as const;
  const first = await syncAgentSessionApprovalsFromEvents({ events, sessionId: "session-1", store });
  const second = await syncAgentSessionApprovalsFromEvents({ events: [events[0]], sessionId: "session-1", store });
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.equal((await store.get("approval-2"))?.status, "approved");
});
