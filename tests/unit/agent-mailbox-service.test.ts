import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentMailboxItem,
  AgentMailboxStore,
  EnqueueAgentMailboxResult,
} from "../../server/data/agent-mailbox-store.ts";
import type { AgentSessionOwner } from "../../server/data/session-ownership-store.ts";
import {
  AgentMailboxAdmissionError,
  dispatchNextAgentMailboxMessage,
  enqueueAgentMailboxMessage,
  mailboxPayloadFingerprint,
  type AgentMailboxBoundary,
  type AgentMailboxRuntime,
} from "../../server/agent-mailbox/service.ts";

const owner: AgentSessionOwner = {
  principalId: "user-1",
  principalType: "user",
  tenantId: "tenant-1",
};

test("mailbox enqueue is idempotent and rejects changed payload reuse", async () => {
  const store = new MemoryMailboxStore();
  const first = await enqueueAgentMailboxMessage({
    clientMessageId: "message-123",
    message: "Continue the task",
    owner,
    sessionId: "session-1",
    store,
  });
  const replay = await enqueueAgentMailboxMessage({
    clientMessageId: "message-123",
    message: "Continue the task",
    owner,
    sessionId: "session-1",
    store,
  });
  const conflict = await enqueueAgentMailboxMessage({
    clientMessageId: "message-123",
    message: "Do something else",
    owner,
    sessionId: "session-1",
    store,
  });

  assert.equal(first.status, "created");
  assert.equal(replay.status, "replay");
  assert.equal(conflict.status, "conflict");
  assert.equal(store.items.length, 1);
});

test("dispatcher keeps a message cancellable while a session is running", async () => {
  const store = await queuedStore();
  const runtime = new FakeMailboxRuntime({ state: "running" });
  const result = await dispatchNextAgentMailboxMessage({
    busyRetryMs: 1_000,
    now: () => Date.parse("2030-01-01T00:00:00.000Z"),
    runtime,
    store,
  });

  assert.equal(result.status, "deferred");
  assert.equal(runtime.deliveries.length, 0);
  assert.equal(store.items[0]?.status, "queued");
  assert.equal(store.items[0]?.availableAt, "2030-01-01T00:00:01.000Z");
});

test("dispatcher does not hand a message to Eve while the addressed turn is running", async () => {
  const store = await queuedStore();
  const runtime = new FakeMailboxRuntime({ state: "running", turnId: "turn-active" });
  const result = await dispatchNextAgentMailboxMessage({ runtime, store });

  assert.equal(result.status, "deferred");
  assert.equal(store.items[0]?.status, "queued");
  assert.equal(runtime.deliveries.length, 0);
});

test("dispatcher admits a steer for the exact active Eve turn", async () => {
  const store = new MemoryMailboxStore();
  await enqueueAgentMailboxMessage({
    clientMessageId: "message-steer-1",
    expectedTurnId: "turn-active",
    message: "Use the latest constraint.",
    operationId: "operation-steer-1",
    operationKind: "steer",
    owner,
    sessionId: "session-1",
    store,
  });
  const runtime = new FakeMailboxRuntime({ state: "running", turnId: "turn-active" });
  const result = await dispatchNextAgentMailboxMessage({ runtime, store });

  assert.equal(result.status, "accepted");
  assert.equal(runtime.deliveries.length, 1);
});

test("cancelling a leased message wins before admission begins", async () => {
  const store = await queuedStore();
  const runtime: AgentMailboxRuntime = {
    async inspect() {
      const cancelled = await store.cancelOwned(owner, "mail-1");
      assert.equal(cancelled?.status, "cancelled");
      return { state: "running", turnId: "turn-active" };
    },
    async deliver() {
      throw new Error("A cancelled mailbox item must not be delivered.");
    },
  };

  const result = await dispatchNextAgentMailboxMessage({ runtime, store });

  assert.equal(result.status, "cancelled");
  assert.equal(store.items[0]?.status, "cancelled");
});

test("dispatcher admits exactly one message at a waiting boundary", async () => {
  const store = await queuedStore();
  const runtime = new FakeMailboxRuntime({ state: "waiting" });
  const result = await dispatchNextAgentMailboxMessage({ runtime, store });

  assert.equal(result.status, "accepted");
  assert.equal(store.items[0]?.status, "accepted");
  assert.deepEqual(runtime.deliveries, [{
    clientMessageId: "message-123",
    itemId: "mail-1",
    message: "Continue the task",
    sessionId: "session-1",
  }]);
});

test("ambiguous admission is not automatically retried", async () => {
  const store = await queuedStore();
  const runtime = new FakeMailboxRuntime({ state: "waiting" });
  runtime.deliveryError = new AgentMailboxAdmissionError(
    "ambiguous",
    "The request may have reached Eve before the connection closed.",
  );
  const first = await dispatchNextAgentMailboxMessage({ runtime, store });
  const second = await dispatchNextAgentMailboxMessage({ runtime, store });

  assert.equal(first.status, "submission-ambiguous");
  assert.equal(second.status, "idle");
  assert.equal(runtime.deliveries.length, 1);
  assert.equal(store.items[0]?.status, "submission-ambiguous");
});

test("a delivery race that finds the session running returns to the cancellable queue", async () => {
  const store = await queuedStore();
  const runtime = new FakeMailboxRuntime({ state: "waiting" });
  runtime.deliveryError = new AgentMailboxAdmissionError(
    "busy",
    "The session started another turn before mailbox admission.",
  );

  const result = await dispatchNextAgentMailboxMessage({ runtime, store });

  assert.equal(result.status, "deferred");
  assert.equal(store.items[0]?.status, "queued");
  assert.equal(store.items[0]?.admissionStartedAt, undefined);
});

test("a message cannot be cancelled after admission has begun", async () => {
  const store = await queuedStore();
  const claimed = await store.claimNext();
  assert.ok(claimed?.claimToken);
  await store.beginAdmission(claimed.itemId, claimed.claimToken);

  const cancelled = await store.cancelOwned(owner, claimed.itemId);

  assert.equal(cancelled, undefined);
  assert.equal(store.items[0]?.status, "delivering");
  assert.ok(store.items[0]?.admissionStartedAt);
});

test("an authoritative message receipt resolves an earlier ambiguous admission", async () => {
  const store = await queuedStore();
  const claimed = await store.claimNext();
  assert.ok(claimed?.claimToken);
  await store.beginAdmission(claimed.itemId, claimed.claimToken);
  await store.markSubmissionAmbiguous(
    claimed.itemId,
    claimed.claimToken,
    "The admission response timed out.",
  );

  const committed = await store.commit(claimed.itemId, claimed.sessionId);

  assert.equal(committed.status, "committed");
  assert.equal(committed.acceptedSessionId, "session-1");
});

test("a durable message.received commit wins over a lost admission response", async () => {
  const store = await queuedStore();
  const runtime: AgentMailboxRuntime = {
    async inspect() {
      return { state: "waiting" };
    },
    async deliver(input) {
      await store.commit(input.itemId, input.sessionId);
      throw new AgentMailboxAdmissionError("ambiguous", "The response connection closed.");
    },
  };

  const result = await dispatchNextAgentMailboxMessage({ runtime, store });

  assert.equal(result.status, "accepted");
  assert.equal(store.items[0]?.status, "committed");
  assert.equal(store.items[0]?.acceptedSessionId, "session-1");
});

test("a rejected admission fails without claiming it was accepted", async () => {
  const store = await queuedStore();
  const runtime = new FakeMailboxRuntime({ state: "waiting" });
  runtime.deliveryError = new AgentMailboxAdmissionError("rejected", "The session is terminal.");
  const result = await dispatchNextAgentMailboxMessage({ runtime, store });

  assert.equal(result.status, "failed");
  assert.equal(store.items[0]?.status, "failed");
});

async function queuedStore(): Promise<MemoryMailboxStore> {
  const store = new MemoryMailboxStore();
  await enqueueAgentMailboxMessage({
    clientMessageId: "message-123",
    message: "Continue the task",
    owner,
    sessionId: "session-1",
    store,
  });
  return store;
}

class FakeMailboxRuntime implements AgentMailboxRuntime {
  boundary: AgentMailboxBoundary;
  deliveries: Array<{
    clientMessageId: string;
    itemId: string;
    message: string;
    sessionId: string;
  }> = [];
  deliveryError?: Error;

  constructor(boundary: AgentMailboxBoundary) {
    this.boundary = boundary;
  }

  async inspect() {
    return this.boundary;
  }

  async deliver(input: Parameters<AgentMailboxRuntime["deliver"]>[0]) {
    this.deliveries.push({
      clientMessageId: input.clientMessageId,
      itemId: input.itemId,
      message: input.payload.message,
      sessionId: input.sessionId,
    });
    if (this.deliveryError) throw this.deliveryError;
    return { sessionId: input.sessionId };
  }
}

class MemoryMailboxStore implements AgentMailboxStore {
  items: AgentMailboxItem[] = [];
  private sequence = 0;

  async enqueue(input: Parameters<AgentMailboxStore["enqueue"]>[0]): Promise<EnqueueAgentMailboxResult> {
    const existing = this.items.find((item) =>
      item.tenantId === input.owner.tenantId &&
      item.principalId === input.owner.principalId &&
      item.clientMessageId === input.clientMessageId
    );
    if (existing) {
      return {
        item: existing,
        status: existing.payloadFingerprint === input.payloadFingerprint &&
            existing.sessionId === input.sessionId
          ? "replay"
          : "conflict",
      };
    }
    const timestamp = new Date(1_900_000_000_000 + this.sequence).toISOString();
    const item: AgentMailboxItem = {
      attemptCount: 0,
      availableAt: timestamp,
      clientMessageId: input.clientMessageId,
      createdAt: timestamp,
      itemId: `mail-${++this.sequence}`,
      payload: input.payload,
      payloadFingerprint: input.payloadFingerprint,
      principalId: input.owner.principalId,
      principalType: input.owner.principalType,
      ...(input.owner.issuer ? { issuer: input.owner.issuer } : {}),
      sessionId: input.sessionId,
      status: "queued",
      tenantId: input.owner.tenantId,
      updatedAt: timestamp,
    };
    this.items.push(item);
    return { item, status: "created" };
  }

  async claimNext(): Promise<AgentMailboxItem | undefined> {
    const item = this.items.find((candidate) => candidate.status === "queued");
    if (!item) return undefined;
    const claimed = {
      ...item,
      attemptCount: item.attemptCount + 1,
      claimExpiresAt: "2030-01-01T00:01:00.000Z",
      claimToken: `claim-${item.itemId}`,
      status: "delivering" as const,
    };
    this.replace(claimed);
    return claimed;
  }

  async defer(itemId: string, claimToken: string, availableAt: string, reason?: string) {
    return this.transitionClaimed(itemId, claimToken, {
      availableAt,
      ...(reason ? { lastError: reason } : {}),
      status: "queued",
    });
  }

  async deferRejectedAdmission(itemId: string, claimToken: string, availableAt: string, reason?: string) {
    return this.transitionClaimed(itemId, claimToken, {
      admissionStartedAt: undefined,
      availableAt,
      ...(reason ? { lastError: reason } : {}),
      status: "queued",
    });
  }

  async beginAdmission(itemId: string, claimToken: string) {
    return this.transitionClaimed(itemId, claimToken, {
      admissionStartedAt: new Date().toISOString(),
      status: "delivering",
    }, true);
  }

  async accept(itemId: string, claimToken: string, acceptedSessionId: string) {
    return this.transitionClaimed(itemId, claimToken, {
      acceptedAt: new Date().toISOString(),
      acceptedSessionId,
      status: "accepted",
    });
  }

  async fail(itemId: string, claimToken: string, message: string) {
    return this.transitionClaimed(itemId, claimToken, { lastError: message, status: "failed" });
  }

  async markSubmissionAmbiguous(itemId: string, claimToken: string, message: string) {
    return this.transitionClaimed(itemId, claimToken, {
      lastError: message,
      status: "submission-ambiguous",
    });
  }

  async commit(itemId: string, acceptedSessionId: string) {
    const item = this.require(itemId);
    const { claimExpiresAt: _, claimToken: __, ...unclaimed } = item;
    const next = {
      ...unclaimed,
      acceptedSessionId,
      committedAt: new Date().toISOString(),
      status: "committed" as const,
    };
    this.replace(next);
    return next;
  }

  async findOwned(currentOwner: AgentSessionOwner, itemId: string) {
    return this.items.find((item) =>
      item.itemId === itemId &&
      item.tenantId === currentOwner.tenantId &&
      item.principalId === currentOwner.principalId
    );
  }

  async cancelOwned(currentOwner: AgentSessionOwner, itemId: string) {
    const item = await this.findOwned(currentOwner, itemId);
    if (
      !item ||
      item.status !== "queued" && item.status !== "failed" &&
      !(item.status === "delivering" && item.admissionStartedAt === undefined)
    ) return undefined;
    const {
      admissionStartedAt: _,
      claimExpiresAt: __,
      claimToken: ___,
      ...unclaimed
    } = item;
    const next = { ...unclaimed, status: "cancelled" as const };
    this.replace(next);
    return next;
  }

  async retryOwned(currentOwner: AgentSessionOwner, itemId: string) {
    const item = await this.findOwned(currentOwner, itemId);
    if (!item || item.status !== "failed") return undefined;
    const next = { ...item, lastError: undefined, status: "queued" as const };
    this.replace(next);
    return next;
  }

  private transitionClaimed(
    itemId: string,
    claimToken: string,
    patch: Partial<AgentMailboxItem> & Pick<AgentMailboxItem, "status">,
    preserveClaim = false,
  ): AgentMailboxItem {
    const item = this.require(itemId);
    assert.equal(item.status, "delivering");
    assert.equal(item.claimToken, claimToken);
    const next = preserveClaim
      ? { ...item, ...patch }
      : (() => {
          const { claimExpiresAt: _, claimToken: __, ...unclaimed } = item;
          return { ...unclaimed, ...patch } as AgentMailboxItem;
        })();
    this.replace(next);
    return next;
  }

  private require(itemId: string): AgentMailboxItem {
    const item = this.items.find((candidate) => candidate.itemId === itemId);
    if (!item) throw new Error("Mailbox item not found.");
    return item;
  }

  private replace(item: AgentMailboxItem): void {
    this.items = this.items.map((candidate) => candidate.itemId === item.itemId ? item : candidate);
  }
}

test("payload fingerprints include the session id", () => {
  const payload = { message: "same" };
  assert.notEqual(
    mailboxPayloadFingerprint("session-a", payload),
    mailboxPayloadFingerprint("session-b", payload),
  );
});

test("steering metadata remains part of the durable mailbox payload", async () => {
  const store = new MemoryMailboxStore();
  const result = await enqueueAgentMailboxMessage({
    clientMessageId: "message-steer-1",
    expectedTurnId: "turn-1",
    message: "Also verify the mobile layout.",
    operationId: "operation-steer-1",
    operationKind: "steer",
    owner,
    sessionId: "session-1",
    store,
  });
  assert.equal(result.status, "created");
  assert.deepEqual(result.item.payload.operation, {
    expectedTurnId: "turn-1",
    kind: "steer",
    operationId: "operation-steer-1",
  });
});
