import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_AGENT_RUNTIME_CONFIG } from "../../lib/agent-runtime-config.ts";
import { enqueueAgentMailboxHttpRequest } from "../../server/agent-mailbox/http.ts";
import type {
  AgentMailboxItem,
  AgentMailboxStore,
  EnqueueAgentMailboxResult,
} from "../../server/data/agent-mailbox-store.ts";
import type {
  AgentSessionOwner,
  AgentSessionOwnershipResult,
  AgentSessionOwnershipStore,
} from "../../server/data/session-ownership-store.ts";

const owner: AgentSessionOwner = {
  principalId: "user-1",
  principalType: "user",
  tenantId: "tenant-1",
};

test("mailbox enqueue waits for a newly started session owner and retries once", async () => {
  const item = mailboxItem();
  const store = enqueueOnlyStore([
    { status: "missing-session" },
    { item, status: "created" },
  ]);
  const ownershipStore = ownershipOnlyStore("owned");

  const response = await enqueueAgentMailboxHttpRequest({
    owner,
    ownershipStore,
    request: mailboxRequest(),
    runtimeConfig: DEFAULT_AGENT_RUNTIME_CONFIG,
    store,
  });

  assert.equal(response.status, 202);
  assert.equal(store.enqueueCalls, 2);
  assert.deepEqual(ownershipStore.waitCalls, [{ owner, sessionId: "session-1" }]);
  assert.deepEqual(await response.json(), {
    disposition: "created",
    item: {
      clientMessageId: "message-1",
      itemId: "mail-1",
      status: "queued",
    },
    ok: true,
  });
});

test("mailbox enqueue preserves a forbidden ownership result", async () => {
  const store = enqueueOnlyStore([{ status: "missing-session" }]);
  const ownershipStore = ownershipOnlyStore("forbidden");

  const response = await enqueueAgentMailboxHttpRequest({
    owner,
    ownershipStore,
    request: mailboxRequest(),
    runtimeConfig: DEFAULT_AGENT_RUNTIME_CONFIG,
    store,
  });

  assert.equal(response.status, 403);
  assert.equal(store.enqueueCalls, 1);
  assert.deepEqual(await response.json(), {
    code: "mailbox_session_forbidden",
    error: "This principal does not own the Agent session.",
    ok: false,
  });
});

function mailboxRequest(): Request {
  return new Request("https://agent.test/api/standalone/mailbox", {
    body: JSON.stringify({
      clientMessageId: "message-1",
      message: "Continue after the current Agent boundary.",
      preferences: {
        executionMode: "standard",
        modelId: DEFAULT_AGENT_RUNTIME_CONFIG.defaultModelId,
        reasoning: "high",
      },
      sessionId: "session-1",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function mailboxItem(): AgentMailboxItem {
  return {
    attemptCount: 0,
    availableAt: "2030-01-01T00:00:00.000Z",
    clientMessageId: "message-1",
    createdAt: "2030-01-01T00:00:00.000Z",
    itemId: "mail-1",
    payload: { message: "Continue after the current Agent boundary." },
    payloadFingerprint: "fingerprint",
    principalId: owner.principalId,
    principalType: owner.principalType,
    sessionId: "session-1",
    status: "queued",
    tenantId: owner.tenantId,
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

function enqueueOnlyStore(results: EnqueueAgentMailboxResult[]): AgentMailboxStore & {
  enqueueCalls: number;
} {
  let enqueueCalls = 0;
  const unsupported = async (): Promise<never> => {
    throw new Error("Unexpected mailbox store operation.");
  };
  return {
    accept: unsupported,
    beginAdmission: unsupported,
    cancelOwned: unsupported,
    claimNext: unsupported,
    commit: unsupported,
    defer: unsupported,
    deferRejectedAdmission: unsupported,
    async enqueue() {
      const result = results[enqueueCalls];
      enqueueCalls += 1;
      if (!result) throw new Error("Unexpected mailbox enqueue attempt.");
      return result;
    },
    get enqueueCalls() {
      return enqueueCalls;
    },
    fail: unsupported,
    findOwned: unsupported,
    markSubmissionAmbiguous: unsupported,
    retryOwned: unsupported,
  };
}

function ownershipOnlyStore(result: AgentSessionOwnershipResult): AgentSessionOwnershipStore & {
  readonly waitCalls: Array<{ readonly owner: AgentSessionOwner; readonly sessionId: string }>;
} {
  const waitCalls: Array<{ readonly owner: AgentSessionOwner; readonly sessionId: string }> = [];
  return {
    async claim() {
      throw new Error("Unexpected ownership claim.");
    },
    async verify() {
      throw new Error("Unexpected ownership verification.");
    },
    async waitForOwnership(sessionId, currentOwner) {
      waitCalls.push({ owner: currentOwner, sessionId });
      return result;
    },
    waitCalls,
  };
}
