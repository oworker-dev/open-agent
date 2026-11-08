import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { SessionContext } from "eve/context";
import { verifyAgentHostCapabilityRequest } from "@oworker/open-agent-host";
import { hostJwtAuth } from "../../agent/lib/host-auth.ts";
import { invokeHostCapability } from "../../agent/lib/host-capabilities.ts";
import { sessionOwnerFromAuth } from "../../agent/lib/session-ownership-auth.ts";
import { verifyMailboxDispatchRequest } from "../../agent/lib/mailbox-dispatch-auth.ts";
import {
  mailboxSessionAuth,
  parseMailboxSessionAuth,
  snapshotMailboxSessionAuth,
} from "../../agent/lib/mailbox-session-auth.ts";
import { DEFAULT_AGENT_RUNTIME_CONFIG } from "../../lib/agent-runtime-config.ts";
import { createEveAgentMailboxRuntime } from "../../server/agent-mailbox/eve-runtime.ts";
import { enqueueAgentMailboxHttpRequest } from "../../server/agent-mailbox/http.ts";
import type { AgentMailboxPayload, AgentMailboxStore } from "../../server/data/agent-mailbox-store.ts";
import { sameResponder } from "../../node_modules/eve/dist/src/harness/hitl/responders.js";

const secret = "mailbox-identity-test-secret-at-least-32-bytes";
const issuer = "https://host.example.test";
const owner = { issuer, principalId: `${issuer}:user-1`, principalType: "user", tenantId: "workspace-1" };
const caller = {
  attributes: {
    actorType: "user",
    tenantId: "workspace-1",
    hostId: "host-1",
    agentHostScope: JSON.stringify({ projectId: "project-1", canvasId: "canvas-1" }),
    agentRuntimeConfig: JSON.stringify(DEFAULT_AGENT_RUNTIME_CONFIG),
    agentRunPolicy: JSON.stringify({ hostCapabilities: ["canvas.item.put"], limits: { maxToolCalls: 5 } }),
    privateCredential: "must-not-be-persisted",
  },
  authenticator: "host-jwt",
  issuer,
  principalId: owner.principalId,
  principalType: "user",
  subject: "user-1",
};

test("approval survives mailbox serialization and signs the same Host identity as the initial JWT", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    ...caller.attributes, iss: issuer, sub: caller.subject, aud: "open-agent",
    exp: Math.floor(Date.now() / 1000) + 300,
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  const verified = await hostJwtAuth({ audiences: ["open-agent"], issuer, secret })(new Request("https://agent.test", {
    headers: { authorization: `Bearer ${header}.${payload}.${signature}` },
  }));
  assert.ok(verified);
  const verifiedOwner = sessionOwnerFromAuth(verified);
  let stored: AgentMailboxPayload | undefined;
  const enqueueStore: Pick<AgentMailboxStore, "enqueue"> = {
    async enqueue(input) {
      stored = JSON.parse(JSON.stringify(input.payload));
      return { status: "created", item: { ...input, ...input.owner, itemId: "mail-1", payload: input.payload, status: "queued", attemptCount: 0, availableAt: "2026-10-14T00:00:00Z", createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z" } };
    },
  };
  const store = enqueueStore as AgentMailboxStore;
  const response = await enqueueAgentMailboxHttpRequest({
    callerAuth: verified,
    owner: verifiedOwner,
    request: new Request("https://agent.test/api/agent/mailbox", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientMessageId: "response-1", sessionId: "session-1", operationKind: "respond", operationId: "response-1",
        inputResponses: [{ interactionId: "approval-1", optionId: "approve" }],
        preferences: { modelId: DEFAULT_AGENT_RUNTIME_CONFIG.defaultModelId, reasoning: "low", executionMode: "standard" },
        callerAuth: { ...caller, subject: "attacker", attributes: { tenantId: "other-workspace" } },
      }),
    }),
    runtimeConfig: DEFAULT_AGENT_RUNTIME_CONFIG,
    store,
  });
  assert.equal(response.status, 202);
  assert.ok(stored?.callerAuth);
  assert.equal(stored.callerAuth.subject, "user-1", "browser-supplied auth must be ignored");
  assert.equal(stored.callerAuth.attributes.privateCredential, undefined);
  assert.equal((await response.text()).includes("callerAuth"), false);
  let resumed: ReturnType<typeof mailboxSessionAuth> | undefined;
  const runtime = createEveAgentMailboxRuntime({
    AGENT_MAILBOX_DISPATCH_SECRET: secret, AGENT_RUNTIME_URL: "https://runtime.test",
  }, async (url, init) => {
    const request = new Request(url, init);
    const body = await request.text();
    assert.equal(verifyMailboxDispatchRequest(request, body, { secret }), true);
    const delivered = JSON.parse(body);
    const callerAuth = parseMailboxSessionAuth(delivered.callerAuth, delivered);
    assert.ok(callerAuth);
    assert.deepEqual(delivered.inputResponses, [{ interactionId: "approval-1", optionId: "approve" }]);
    resumed = mailboxSessionAuth({ ...delivered, callerAuth });
    return Response.json({ sessionId: "session-1" }, { status: 202 });
  });
  await runtime.deliver({ clientMessageId: "response-1", itemId: "mail-1", owner: verifiedOwner, payload: stored, sessionId: "session-1" });
  assert.ok(resumed);
  assert.equal(resumed.authenticator, verified.authenticator);
  assert.equal(resumed.attributes.agentMailboxDispatch, "1");
  assert.equal(sameResponder(verified, resumed), true, "Eve must admit the original requester's approval");
  for (const mismatch of [
    { authenticator: "other-authenticator" },
    { issuer: "https://other-host.test" },
    { principalId: "other-user" },
    { principalType: "service" },
  ]) {
    assert.equal(sameResponder(verified, { ...resumed, ...mismatch }), false);
  }
  assert.deepEqual(JSON.parse(String(resumed.attributes.agentRunPolicy)), {
    executionMode: "standard", hostCapabilities: ["canvas.item.put"], limits: { maxToolCalls: 5 },
  });
  const previousFetch = globalThis.fetch;
  const previousRegistry = process.env.AGENT_HOST_GATEWAYS_JSON;
  process.env.AGENT_HOST_GATEWAYS_JSON = JSON.stringify({ "host-1": { url: "https://host.test/tools", secret } });
  const identities: unknown[] = [];
  globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    identities.push(verifyAgentHostCapabilityRequest({
      body: await request.text(), headers: request.headers, method: request.method,
      secret, url: request.url,
    }));
    return Response.json({ contractVersion: "0.1.0-draft", capability: "canvas.item.put", output: { ok: true } });
  };
  try {
    for (const current of [verified, resumed]) {
      const context = { session: { id: "session-1", auth: { current, initiator: verified }, turn: { id: "turn-1", sequence: 1 } } } as SessionContext;
      await invokeHostCapability(context, { capability: "canvas.item.put", input: { refId: "item-1" } });
    }
    const expected = { actorType: "user", principalId: "user-1", tenantId: "workspace-1", scope: { projectId: "project-1", canvasId: "canvas-1" } };
    assert.deepEqual(identities, [expected, expected]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRegistry === undefined) delete process.env.AGENT_HOST_GATEWAYS_JSON;
    else process.env.AGENT_HOST_GATEWAYS_JSON = previousRegistry;
  }
});

test("mailbox caller metadata cannot cross principal, tenant, type or issuer ownership", () => {
  for (const mismatch of [{ principalId: "other-user" }, { tenantId: "other-workspace" }, { principalType: "service" }, { issuer: "other-host" }]) {
    const other = { ...owner, ...mismatch };
    assert.throws(() => snapshotMailboxSessionAuth(caller, other), /does not match/);
    assert.equal(parseMailboxSessionAuth(caller, other), undefined);
  }
  assert.equal(parseMailboxSessionAuth({ ...caller, subject: [] }, owner), undefined);
  assert.equal(parseMailboxSessionAuth({ ...caller, authenticator: "" }, owner), undefined);
  assert.equal(parseMailboxSessionAuth({ ...caller, attributes: null }, owner), undefined);
});

test("legacy standalone mailbox messages retain their owner without inheriting Host grants", () => {
  const resumed = mailboxSessionAuth({ principalId: "anonymous:1", principalType: "user", tenantId: "standalone", itemId: "mail-1" });
  assert.equal(resumed.subject, undefined);
  assert.equal(resumed.attributes.agentHostScope, undefined);
  assert.equal(resumed.attributes.hostId, undefined);
  assert.equal(resumed.principalId, "anonymous:1");
});
