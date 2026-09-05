import assert from "node:assert/strict";
import test from "node:test";

import type { SessionContext } from "eve/context";
import { verifyAgentHostCapabilityRequest } from "@oworker/open-agent-host";

import {
  approvalForHostCapability,
  invokeHostCapability,
  listHostCapabilities,
  readHostCapabilityTimeoutMs,
  resolveHostGateway,
  shouldExposeHostCapabilities,
} from "../../agent/lib/host-capabilities.ts";

const SECRET = "01234567890123456789012345678901";

test("auto-approves service grants and discovered read-only Host capabilities", () => {
  assert.equal(
    approvalForHostCapability({ actorType: "service", sideEffect: "external" }),
    "not-applicable",
  );
  assert.equal(
    approvalForHostCapability({ actorType: "user", sideEffect: "none" }),
    "not-applicable",
  );
  assert.equal(
    approvalForHostCapability({ actorType: "user", sideEffect: "project-write" }),
    "user-approval",
  );
  assert.equal(
    approvalForHostCapability({ actorType: "user", sideEffect: undefined }),
    "user-approval",
  );
});

test("bounds the Host capability timeout and covers synchronous media by default", () => {
  assert.equal(readHostCapabilityTimeoutMs({}), 120_000);
  assert.equal(
    readHostCapabilityTimeoutMs({ AGENT_HOST_TOOLS_TIMEOUT_MS: "45000" }),
    45_000,
  );
  assert.throws(
    () => readHostCapabilityTimeoutMs({ AGENT_HOST_TOOLS_TIMEOUT_MS: "120001" }),
    /1000 to 120000/,
  );
});

test("does not expose inherited Host tools without an authenticated explicit grant", () => {
  const environment = {
    AGENT_HOST_TOOLS_URL: "https://host.example/agent-tools",
    AGENT_HOST_TOOLS_SECRET: SECRET,
  };
  assert.equal(shouldExposeHostCapabilities({
    session: { auth: { current: null, initiator: null } },
  }, environment), false);
  assert.equal(shouldExposeHostCapabilities({
    session: {
      auth: {
        initiator: { attributes: {} },
      },
    },
  }, environment), false);
  assert.equal(shouldExposeHostCapabilities({
    session: {
      auth: {
        initiator: {
          attributes: {
            agentRunPolicy: JSON.stringify({ hostCapabilities: ["documents.read"] }),
          },
        },
      },
    },
  }, environment), true);
});

test("routes a signed host identity through the server-side gateway registry", () => {
  const session = sessionContext(JSON.stringify({ hostCapabilities: ["documents.read"] }));
  (session.session.auth.current!.attributes as Record<string, unknown>).hostId = "muses";
  const gateway = resolveHostGateway(session, {
    AGENT_HOST_GATEWAYS_JSON: JSON.stringify({
      muses: {
        url: "https://muses.example/agent-tools",
        secret: SECRET,
        timeoutMs: 15_000,
      },
    }),
    AGENT_HOST_TOOLS_URL: "https://attacker.example/should-not-win",
    AGENT_HOST_TOOLS_SECRET: SECRET,
  });
  assert.deepEqual(gateway, {
    baseUrl: "https://muses.example/agent-tools",
    secret: SECRET,
    timeoutMs: 15_000,
  });
  assert.equal(resolveHostGateway(sessionContext(), {
    AGENT_HOST_GATEWAYS_JSON: JSON.stringify({
      muses: { url: "https://muses.example", secret: SECRET },
    }),
  }), undefined);
});

test("signs Host capability requests with raw host identity and opaque scope", async () => {
  const previousUrl = process.env.AGENT_HOST_TOOLS_URL;
  const previousSecret = process.env.AGENT_HOST_TOOLS_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.AGENT_HOST_TOOLS_URL =
    "https://host.test/agent-tools";
  process.env.AGENT_HOST_TOOLS_SECRET = SECRET;
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({ contractVersion: "0.1.0-draft", capabilities: [] });
  };

  try {
    await listHostCapabilities(sessionContext());
    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert.equal(
      request.url,
      "https://host.test/agent-tools/capabilities",
    );
    assert.equal(request.headers.get("x-agent-host-principal"), "user-1");
    assert.equal(request.headers.get("x-agent-host-tenant"), "workspace-1");
    assert.ok(request.headers.get("x-agent-host-scope"));
    assertValidSignature(request, "");
  } finally {
    restoreEnvironment(previousUrl, previousSecret, previousFetch);
  }
});

test("propagates the Eve tool call id as Host idempotency correlation", async () => {
  const previousUrl = process.env.AGENT_HOST_TOOLS_URL;
  const previousSecret = process.env.AGENT_HOST_TOOLS_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.AGENT_HOST_TOOLS_URL =
    "https://muses.test/api/studio/agent-host-tools";
  process.env.AGENT_HOST_TOOLS_SECRET = SECRET;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      contractVersion: "0.1.0-draft",
      capability: "canvas.inspect",
      output: { ok: true },
    });
  };

  try {
    await invokeHostCapability(sessionContext(), {
      capability: "canvas.inspect",
      input: {},
      correlationId: "tool-call-1",
    });
    assert.ok(request);
    const body = await request.clone().text();
    assert.match(body, /"correlationId":"tool-call-1"/);
    assert.match(body, /"runId":"arun_external-1"/);
    assertValidSignature(request, body);
  } finally {
    restoreEnvironment(previousUrl, previousSecret, previousFetch);
  }
});

test("filters discovery and denies invocation outside the AgentRun allowlist", async () => {
  const previousUrl = process.env.AGENT_HOST_TOOLS_URL;
  const previousSecret = process.env.AGENT_HOST_TOOLS_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.AGENT_HOST_TOOLS_URL = "https://muses.test/api/studio/agent-host-tools";
  process.env.AGENT_HOST_TOOLS_SECRET = SECRET;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({
      contractVersion: "0.1.0-draft",
      capabilities: [
        { name: "canvas.inspect", version: "1", description: "read", inputSchema: {}, requiredPermissions: [], sideEffect: "none" },
        { name: "canvas.item.put", version: "1", description: "write", inputSchema: {}, requiredPermissions: [], sideEffect: "project-write" },
      ],
    });
  };

  try {
    const session = sessionContext(JSON.stringify({ hostCapabilities: ["canvas.inspect"] }));
    assert.deepEqual((await listHostCapabilities(session)).map(({ name }) => name), ["canvas.inspect"]);
    await assert.rejects(
      invokeHostCapability(session, { capability: "canvas.item.put", input: {} }),
      /not allowed/,
    );
    assert.equal(requests, 1, "denied invocation must not reach the Host");
  } finally {
    restoreEnvironment(previousUrl, previousSecret, previousFetch);
  }
});

function sessionContext(agentRunPolicy?: string): SessionContext {
  return {
    session: {
      id: "session-1",
      auth: {
        current: {
          attributes: {
            actorType: "user",
            agentHostScope: JSON.stringify({ projectId: "project-1", canvasId: "canvas-1" }),
            tenantId: "workspace-1",
            agentRunId: "arun_external-1",
            ...(agentRunPolicy ? { agentRunPolicy } : {}),
          },
          authenticator: "host-jwt",
          issuer: "muses.test",
          principalId: "muses.test:user-1",
          principalType: "user",
          subject: "user-1",
        },
        initiator: null,
      },
      turn: { id: "turn-1", sequence: 1 },
    },
    getSandbox: async () => {
      throw new Error("not used");
    },
    getSkill: () => {
      throw new Error("not used");
    },
  };
}

function assertValidSignature(request: Request, body: string) {
  const timestamp = request.headers.get("x-agent-host-timestamp")!;
  const identity = verifyAgentHostCapabilityRequest({
    body,
    headers: request.headers,
    method: request.method,
    now: Number(timestamp),
    secret: SECRET,
    url: request.url,
  });
  assert.deepEqual(identity, {
    actorType: "user",
    principalId: "user-1",
    scope: { canvasId: "canvas-1", projectId: "project-1" },
    tenantId: "workspace-1",
  });
}

function restoreEnvironment(
  previousUrl: string | undefined,
  previousSecret: string | undefined,
  previousFetch: typeof globalThis.fetch,
) {
  if (previousUrl === undefined) delete process.env.AGENT_HOST_TOOLS_URL;
  else process.env.AGENT_HOST_TOOLS_URL = previousUrl;
  if (previousSecret === undefined) delete process.env.AGENT_HOST_TOOLS_SECRET;
  else process.env.AGENT_HOST_TOOLS_SECRET = previousSecret;
  globalThis.fetch = previousFetch;
}
