import assert from "node:assert/strict";
import test from "node:test";
import type { MessageStreamEvent } from "eve/client";
import {
  cancelAgentSession,
  parseSessionCursor,
  readAgentSession,
  type AgentSessionRuntime,
} from "../../server/agent-sessions/service.ts";
import { canTransitionAgentSessionOperation, transitionAgentSessionOperation } from "../../server/agent-mailbox/operation.ts";
import type { AgentSessionOwner, AgentSessionOwnershipStore } from "../../server/data/session-ownership-store.ts";
import type { AgentSessionOperation } from "@oworker/open-agent-contracts/agent-session";

const owner: AgentSessionOwner = {
  principalId: "user-1",
  principalType: "user",
  tenantId: "tenant-1",
};

test("session hydration projects a bounded absolute cursor and latest runtime status", async () => {
  const runtime: AgentSessionRuntime = {
    async readEvents(input) {
      assert.deepEqual(input, {
        accessToken: "token",
        after: 4,
        limit: 2,
        sessionId: "session-1",
      });
      return [
        event("turn.started", { sequence: 5, turnId: "turn-2" }),
        event("session.waiting", { wait: "next-user-message" }),
      ];
    },
    async cancel() {
      return "no_active_turn";
    },
  };
  const result = await readAgentSession({
    accessToken: "token",
    after: 4,
    identity: owner,
    limit: 2,
    ownershipStore: ownershipStore("owned"),
    runtime,
    sessionId: "session-1",
  });
  assert.equal(result?.nextCursor, 6);
  assert.equal(result?.session.status, "waiting");
  assert.deepEqual(result?.events.map((entry) => entry.cursor), [5, 6]);
  assert.equal(result?.hasMore, true);
});

test("session cancellation is ownership checked and delegated to the runtime", async () => {
  let calls = 0;
  const result = await cancelAgentSession({
    accessToken: "token",
    identity: owner,
    ownershipStore: ownershipStore("owned"),
    runtime: {
      async readEvents() { return []; },
      async cancel(input) {
        calls += 1;
        assert.deepEqual(input, { accessToken: "token", sessionId: "session-1" });
        return "accepted";
      },
    },
    sessionId: "session-1",
  });
  assert.deepEqual(result, { sessionId: "session-1", status: "accepted" });
  assert.equal(calls, 1);
});

test("operation state transitions reject late events after a terminal state", () => {
  assert.equal(canTransitionAgentSessionOperation("queued", "delivering"), true);
  assert.equal(canTransitionAgentSessionOperation("committed", "failed"), false);
  const operation: AgentSessionOperation = {
    attemptCount: 1,
    clientMessageId: "client-1",
    createdAt: "2030-01-01T00:00:00.000Z",
    expectedTurnId: "turn-1",
    kind: "steer",
    operationId: "operation-1",
    sessionId: "session-1",
    state: "accepted",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
  const committed = transitionAgentSessionOperation(operation, "committed", {
    updatedAt: "2030-01-01T00:00:01.000Z",
  });
  assert.equal(committed.state, "committed");
  assert.throws(() => transitionAgentSessionOperation(committed, "failed"), /cannot transition/);
});

test("session cursor rejects negative and fractional values", () => {
  assert.equal(parseSessionCursor(0), 0);
  assert.throws(() => parseSessionCursor(-1), /cursor is invalid/);
  assert.throws(() => parseSessionCursor(1.5), /cursor is invalid/);
});

function event(type: string, data: Record<string, unknown>): MessageStreamEvent {
  return { data, meta: { at: "2030-01-01T00:00:00.000Z", id: `${type}-1` }, type } as MessageStreamEvent;
}

function ownershipStore(result: "owned" | "missing" | "forbidden"): AgentSessionOwnershipStore {
  return {
    async claim() {},
    async verify() { return result; },
    async waitForOwnership() { return result; },
  };
}
