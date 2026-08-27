import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentSessionDeletionError,
  deleteAgentSession,
  type AgentSessionDeletionRuntime,
} from "../../server/agent-sessions/service.ts";
import type { AgentSessionOwner, AgentSessionOwnershipStore } from "../../server/data/session-ownership-store.ts";
import type {
  SandboxDeletionRecord,
  SandboxDeletionStore,
} from "../../server/data/sandbox-deletion-store.ts";

const identity: AgentSessionOwner = {
  principalId: "principal-1",
  principalType: "user",
  tenantId: "tenant-1",
};

test("retires the durable session before authorizing sandbox deletion", async () => {
  const order: string[] = [];
  const outcome = await deleteAgentSession({
    accessToken: "host-token",
    deletionStore: deletionStore(order, "created"),
    identity,
    ownershipStore: ownershipStore("owned"),
    runtime: runtime(order, "reset"),
    sessionId: "session-1",
  });

  assert.deepEqual(order, ["reset", "authorize"]);
  assert.equal(outcome?.disposition, "authorized");
  assert.equal(outcome?.deletion.status, "authorized");
  assert.equal(outcome?.reset, "reset");
});

test("replays an existing tombstone without resetting the retired session again", async () => {
  const order: string[] = [];
  const outcome = await deleteAgentSession({
    accessToken: "host-token",
    deletionStore: deletionStore(order, "existing", true),
    identity,
    ownershipStore: ownershipStore("owned"),
    runtime: runtime(order, "no_active_session"),
    sessionId: "session-1",
  });

  assert.equal(outcome?.disposition, "already_authorized");
  assert.equal(outcome?.reset, "no_active_session");
  assert.deepEqual(order, []);
});

test("does not reveal or delete a session owned by another principal", async () => {
  const order: string[] = [];
  const outcome = await deleteAgentSession({
    accessToken: "host-token",
    deletionStore: deletionStore(order, "created"),
    identity,
    ownershipStore: ownershipStore("forbidden"),
    runtime: runtime(order, "reset"),
    sessionId: "session-1",
  });

  assert.equal(outcome, undefined);
  assert.deepEqual(order, []);
});

test("retires a session by stable ID", async () => {
  const order: string[] = [];
  const outcome = await deleteAgentSession({
    accessToken: "host-token",
    deletionStore: deletionStore(order, "created"),
    identity,
    ownershipStore: ownershipStore("owned"),
    runtime: runtime(order, "reset"),
    sessionId: "session-1",
  });
  assert.equal(outcome?.reset, "reset");
  assert.deepEqual(order, ["reset", "authorize"]);
});

test("rejects invalid stable session IDs", async () => {
  const order: string[] = [];
  await assert.rejects(
    deleteAgentSession({
      accessToken: "host-token",
      deletionStore: deletionStore(order, "created"),
      identity,
      ownershipStore: ownershipStore("owned"),
      runtime: runtime(order, "reset"),
      sessionId: "session with whitespace",
    }),
    (error: unknown) => error instanceof AgentSessionDeletionError
      && error.code === "agent_session_id_invalid",
  );
  assert.deepEqual(order, []);
});

test("keeps the sandbox when Eve cannot retire the durable session", async () => {
  const order: string[] = [];
  const failingRuntime: AgentSessionDeletionRuntime = {
    async reset() {
      order.push("reset");
      throw new Error("runtime unavailable");
    },
  };
  await assert.rejects(
    deleteAgentSession({
      accessToken: "host-token",
      deletionStore: deletionStore(order, "created"),
      identity,
      ownershipStore: ownershipStore("owned"),
      runtime: failingRuntime,
      sessionId: "session-1",
    }),
    (error: unknown) => error instanceof AgentSessionDeletionError
      && error.code === "agent_session_retirement_failed",
  );
  assert.deepEqual(order, ["reset"]);
});

function ownershipStore(
  verification: "forbidden" | "missing" | "owned",
): AgentSessionOwnershipStore {
  return {
    async claim() {},
    async verify() {
      return verification;
    },
    async waitForOwnership() {
      return verification;
    },
  };
}

function runtime(
  order: string[],
  result: "no_active_session" | "reset",
): AgentSessionDeletionRuntime {
  return {
    async reset() {
      order.push("reset");
      return result;
    },
  };
}

function deletionStore(
  order: string[],
  result: "created" | "existing",
  existing = false,
): SandboxDeletionStore {
  return {
    async claim() {
      return undefined;
    },
    async complete() {
      return deletionRecord("completed");
    },
    async completeMissing() {
      return deletionRecord("completed");
    },
    async fail() {
      return deletionRecord("failed");
    },
    async findOwned() {
      return existing ? deletionRecord("authorized") : undefined;
    },
    async request() {
      order.push("authorize");
      return { record: deletionRecord("authorized"), status: result };
    },
  };
}

function deletionRecord(status: SandboxDeletionRecord["status"]): SandboxDeletionRecord {
  return {
    attemptCount: 0,
    notBefore: "2026-08-02T00:00:00.000Z",
    principalId: identity.principalId,
    reason: "user-requested-session-deletion",
    requestedAt: "2026-08-02T00:00:00.000Z",
    requestedBy: "host:user",
    sessionId: "session-1",
    status,
    tenantId: identity.tenantId,
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}
