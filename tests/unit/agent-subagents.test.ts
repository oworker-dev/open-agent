import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryAgentSubagentStore } from "../../server/data/agent-subagent-store.ts";
import {
  closeAgentSubagent,
  inspectAgentSubagent,
  interruptAgentSubagent,
  listAgentSubagents,
  sendAgentSubagentMessage,
  spawnAgentSubagent,
  syncAgentSubagentsFromEvents,
  waitForAgentSubagent,
} from "../../server/agent-sessions/subagents.ts";
import type { AgentSessionOwner, AgentSessionOwnershipStore } from "../../server/data/session-ownership-store.ts";
import type { AgentMailboxStore } from "../../server/data/agent-mailbox-store.ts";

const owner: AgentSessionOwner = { tenantId: "tenant-1", principalId: "user-1", principalType: "user" };
const ownershipStore: AgentSessionOwnershipStore = {
  async claim() {},
  async verify() { return "owned"; },
  async waitForOwnership() { return "owned"; },
};

test("sync derives idempotent child metadata and stable nickname from Eve events", async () => {
  const store = createMemoryAgentSubagentStore();
  const events = [
    { type: "subagent.called", data: { childSessionId: "ses_child_1", callId: "call_1", name: "researcher", input: { message: "Investigate" } } },
    { type: "subagent.completed", data: { childSessionId: "ses_child_1", callId: "call_1", result: { output: "done" } } },
  ] as const;
  const options = { accessToken: "token", events, identity: owner, ownershipStore, parentSessionId: "ses_parent", store };
  const first = await syncAgentSubagentsFromEvents(options);
  const second = await syncAgentSubagentsFromEvents(options);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0]?.status, "completed");
  assert.equal(second[0]?.nickname, "researcher-child_1");
  const snapshot = await listAgentSubagents({ ...options });
  assert.equal(snapshot?.activeCount, 0);
});

test("persistent subagent completion parks at a waiting boundary and remains resumable", async () => {
  const store = createMemoryAgentSubagentStore();
  const events = [
    {
      type: "actions.requested",
      data: {
        actions: [{ callId: "call_persistent", input: { agentId: "agent-child-1", message: "Investigate" }, kind: "subagent-call" }],
      },
    },
    { type: "subagent.called", data: { childSessionId: "ses_child_persistent", callId: "call_persistent", name: "agent" } },
    { type: "subagent.completed", data: { childSessionId: "ses_child_persistent", callId: "call_persistent", output: "parked" } },
  ] as const;
  const runtime = {
    async inspect() { return { status: "waiting" as const }; },
    async cancel() { return "no_active_turn" as const; },
  };
  const first = await syncAgentSubagentsFromEvents({
    accessToken: "token",
    events,
    identity: owner,
    ownershipStore,
    parentSessionId: "ses_parent",
    runtime,
    store,
  });
  assert.equal(first[0]?.agentId, "agent-child-1");
  assert.equal(first[0]?.status, "waiting");

  let payload: unknown;
  const mailbox = {
    async enqueue(input: unknown) {
      payload = input;
      return { status: "created" as const, item: { status: "queued" } } as never;
    },
  } as unknown as AgentMailboxStore;
  const resumed = await sendAgentSubagentMessage({
    accessToken: "token",
    childSessionId: "ses_child_persistent",
    identity: owner,
    mailboxStore: mailbox,
    ownershipStore,
    runtime,
    store,
    message: "Continue the parked task.",
    resume: true,
  });
  assert.equal(resumed?.status, "running");
  assert.equal((payload as { readonly payload: { readonly operation: { readonly kind: string } } }).payload.operation.kind, "send");
});

test("wait projects the runtime boundary and interrupt is terminal-safe", async () => {
  const store = createMemoryAgentSubagentStore();
  await store.create({ owner, parentSessionId: "parent", childSessionId: "child", status: "running", task: "task" });
  let inspections = 0;
  const runtime = {
    async inspect() {
      inspections += 1;
      return inspections === 1 ? { status: "running" as const } : { status: "waiting" as const };
    },
    async cancel() { return "accepted" as const; },
    async reset() { return "reset" as const; },
  };
  const options = { accessToken: "token", identity: owner, ownershipStore, runtime, store };
  const waiting = await waitForAgentSubagent({ ...options, childSessionId: "child", timeoutMs: 1000 });
  assert.equal(waiting?.status, "waiting");
  const interrupted = await interruptAgentSubagent({ ...options, childSessionId: "child" });
  assert.equal(interrupted?.status, "interrupted");
});

test("interrupt reconciles a parked child when Eve reports no active turn", async () => {
  const store = createMemoryAgentSubagentStore();
  await store.create({ owner, parentSessionId: "parent", childSessionId: "child", status: "running" });
  const result = await interruptAgentSubagent({
    accessToken: "token",
    childSessionId: "child",
    identity: owner,
    ownershipStore,
    runtime: {
      async inspect() { return { status: "waiting" as const }; },
      async cancel() { return "no_active_turn" as const; },
      async reset() { return "reset" as const; },
    },
    store,
  });
  assert.equal(result?.status, "waiting");
  assert.ok(result?.finishedAt);
});

test("closing a child retires its exact Eve session before closing the durable projection", async () => {
  const store = createMemoryAgentSubagentStore();
  await store.create({ owner, parentSessionId: "parent", childSessionId: "child", status: "waiting" });
  const retired: string[] = [];
  const result = await closeAgentSubagent({
    accessToken: "token",
    childSessionId: "child",
    identity: owner,
    ownershipStore,
    runtime: {
      async inspect() { return { status: "waiting" as const }; },
      async cancel() { return "no_active_turn" as const; },
      async reset(input) { retired.push(input.sessionId); return "reset" as const; },
    },
    store,
  });
  assert.deepEqual(retired, ["child"]);
  assert.equal(result?.status, "closed");
});

test("spawn persistence failure terminally retires the unowned child", async () => {
  let resetAttempts = 0;
  const store = {
    ...createMemoryAgentSubagentStore(),
    async create() { throw new Error("database unavailable"); },
  };
  await assert.rejects(
    spawnAgentSubagent({
      accessToken: "token",
      identity: owner,
      ownershipStore,
      parentSessionId: "parent",
      runtime: {
        async spawn() { return { childSessionId: "orphan-child" }; },
        async inspect() { return { status: "running" as const }; },
        async cancel() { return "accepted" as const; },
        async reset(input) {
          resetAttempts += 1;
          assert.equal(input.sessionId, "orphan-child");
          return "reset" as const;
        },
      },
      store,
      task: "Investigate",
    }),
    /database unavailable/,
  );
  assert.equal(resetAttempts, 1);
});

test("messages are durable mailbox entries and resume does not fabricate a child turn", async () => {
  const store = createMemoryAgentSubagentStore();
  await store.create({ owner, parentSessionId: "parent", childSessionId: "child", status: "waiting" });
  let payload: unknown;
  const mailbox = {
    async enqueue(input: unknown) {
      payload = input;
      return { status: "created" as const, item: { status: "queued" } } as never;
    },
  } as unknown as AgentMailboxStore;
  const result = await sendAgentSubagentMessage({ accessToken: "token", identity: owner, ownershipStore, store, mailboxStore: mailbox, childSessionId: "child", message: "Continue", resume: true });
  assert.equal(result?.status, "running");
  assert.equal((payload as { readonly payload: { readonly operation?: { readonly kind: string } } }).payload.operation?.kind, "send");
});

test("a waiting child receives a normal follow-up instead of an invalid steer", async () => {
  const store = createMemoryAgentSubagentStore();
  await store.create({ owner, parentSessionId: "parent", childSessionId: "child", status: "waiting" });
  let payload: unknown;
  const mailbox = {
    async enqueue(input: unknown) {
      payload = input;
      return { status: "created" as const, item: { status: "queued" } } as never;
    },
  } as unknown as AgentMailboxStore;
  await sendAgentSubagentMessage({
    accessToken: "token",
    childSessionId: "child",
    identity: owner,
    mailboxStore: mailbox,
    ownershipStore,
    store,
    message: "Continue from the checkpoint.",
  });
  assert.equal((payload as { readonly payload: { readonly operation: { readonly kind: string } } }).payload.operation.kind, "send");
});

test("a child view refresh reconciles a stale persisted running status", async () => {
  const store = createMemoryAgentSubagentStore();
  await store.create({ owner, parentSessionId: "parent", childSessionId: "child", status: "running" });
  const refreshed = await inspectAgentSubagent({
    accessToken: "token",
    childSessionId: "child",
    identity: owner,
    ownershipStore,
    runtime: {
      async inspect() { return { status: "waiting" as const }; },
      async cancel() { return "no_active_turn" as const; },
    },
    store,
  });
  assert.equal(refreshed?.status, "waiting");
});

test("a running child message is delivered as a turn-scoped steer", async () => {
  const store = createMemoryAgentSubagentStore();
  await store.create({ owner, parentSessionId: "parent", childSessionId: "child", status: "running" });
  let payload: unknown;
  const mailbox = {
    async enqueue(input: unknown) {
      payload = input;
      return { status: "created" as const, item: { status: "queued" } } as never;
    },
  } as unknown as AgentMailboxStore;
  const result = await sendAgentSubagentMessage({
    accessToken: "token",
    childSessionId: "child",
    identity: owner,
    mailboxStore: mailbox,
    ownershipStore,
    runtime: {
      async inspect() { return { status: "running" as const, activeTurnId: "turn-1" }; },
      async cancel() { return "no_active_turn" as const; },
    },
    store,
    message: "Use the new constraint.",
  });
  assert.equal(result?.status, "running");
  const operation = (payload as {
    readonly payload: {
      readonly operation: { readonly expectedTurnId?: string; readonly kind: string; readonly operationId: string };
    };
  }).payload.operation;
  assert.equal(operation.expectedTurnId, "turn-1");
  assert.equal(operation.kind, "steer");
  assert.match(operation.operationId, /^subagent-/);
});

test("parent cancellation closes active child projections instead of leaving them running", async () => {
  const store = createMemoryAgentSubagentStore();
  await store.create({ owner, parentSessionId: "parent", childSessionId: "child", status: "running" });
  const result = await syncAgentSubagentsFromEvents({
    accessToken: "token",
    events: [{ type: "turn.cancelled", data: {} }],
    identity: owner,
    ownershipStore,
    parentSessionId: "parent",
    store,
  });
  assert.equal(result[0]?.status, "interrupted");
});

test("normal parent completion does not terminate a detached no-wait child", async () => {
  const store = createMemoryAgentSubagentStore();
  await store.create({
    owner,
    parentSessionId: "parent",
    childSessionId: "detached-child",
    status: "running",
    waitPolicy: "no-wait",
  });
  const result = await syncAgentSubagentsFromEvents({
    accessToken: "token",
    events: [{ type: "session.completed", data: {} }],
    identity: owner,
    ownershipStore,
    parentSessionId: "parent",
    store,
  });
  assert.equal(result[0]?.status, "running");
});
