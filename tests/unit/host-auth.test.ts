import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { ForbiddenError } from "eve/channels/auth";

import { hostJwtAuth, hostJwtAuthFromEnvironment } from "../../agent/lib/host-auth.ts";
import {
  authenticateHostRequest,
  HOST_AGENT_SCOPE,
  requireHostScope,
} from "../../server/http/host-request-auth.ts";

const SECRET = "01234567890123456789012345678901";

test("accepts a host JWT and projects tenant identity", async () => {
  const auth = hostJwtAuth({
    audiences: ["open-agent"],
    issuer: "https://muses.example.test",
    secret: SECRET,
  });

  const result = await auth(new Request("https://agent.example.test/eve/v1/session", {
    headers: {
      authorization: `Bearer ${signJwt({
        actorType: "user",
        aud: "open-agent",
        exp: Math.floor(Date.now() / 1000) + 300,
        iss: "https://muses.example.test",
        agentHostScope: JSON.stringify({ projectId: "project-123", canvasId: "canvas-123" }),
        sub: "user-123",
        tenantId: "workspace-123",
      })}`,
    },
  }));

  assert.ok(result);
  assert.equal(result.authenticator, "host-jwt");
  assert.equal(result.principalType, "user");
  assert.equal(result.attributes.tenantId, "workspace-123");
  assert.deepEqual(JSON.parse(String(result.attributes.agentHostScope)), { projectId: "project-123", canvasId: "canvas-123" });
  assert.equal(result.subject, "user-123");
  assert.equal(result.principalId, "https://muses.example.test:user-123");
});

test("rejects a verified host token without a tenant scope", async () => {
  const auth = hostJwtAuth({
    audiences: ["open-agent"],
    issuer: "https://muses.example.test",
    secret: SECRET,
  });

  await assert.rejects(
    async () => await auth(new Request("https://agent.example.test/eve/v1/session", {
      headers: {
        authorization: `Bearer ${signJwt({
          aud: "open-agent",
          exp: Math.floor(Date.now() / 1000) + 300,
          iss: "https://muses.example.test",
          sub: "user-123",
        })}`,
      },
    })),
    (error: unknown) => error instanceof ForbiddenError,
  );
});

test("allows local development to fall through when host JWT auth is not configured", async () => {
  const auth = hostJwtAuthFromEnvironment({});
  assert.equal(await auth(new Request("http://127.0.0.1:3100/eve/v1/session")), null);
});

test("requires the declared endpoint scope after Host JWT authentication", async () => {
  const authenticated = {
    accessToken: "token",
    identity: {
      principalId: "issuer:user-1",
      principalType: "user",
      tenantId: "tenant-1",
    },
    ok: true as const,
    runtimeConfig: (await import("../../lib/agent-runtime-config.ts")).DEFAULT_AGENT_RUNTIME_CONFIG,
    scopes: new Set<string>(),
  };
  const denied = requireHostScope(authenticated, "agent:runs");
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.response.status, 403);
  assert.equal((await denied.response.json()).code, "host_scope_required");

  const allowed = requireHostScope(
    { ...authenticated, scopes: new Set(["agent:runs"]) },
    "agent:runs",
  );
  assert.equal(allowed.ok, true);
});

test("publishes separate least-privilege scopes for session control surfaces", () => {
  assert.deepEqual(new Set(Object.values(HOST_AGENT_SCOPE)), new Set([
    "agent:approvals:read",
    "agent:mailbox:read",
    "agent:mailbox:write",
    "agent:sessions:delete",
    "agent:sessions:read",
    "agent:sessions:write",
    "agent:subagents:read",
    "agent:subagents:write",
  ]));
});

test("returns a clear forbidden response for an invalid Host Runtime Config claim", async () => {
  const previous = {
    audience: process.env.AGENT_HOST_JWT_AUDIENCE,
    issuer: process.env.AGENT_HOST_JWT_ISSUER,
    secret: process.env.AGENT_HOST_JWT_SECRET,
  };
  process.env.AGENT_HOST_JWT_AUDIENCE = "open-agent";
  process.env.AGENT_HOST_JWT_ISSUER = "https://muses.example.test";
  process.env.AGENT_HOST_JWT_SECRET = SECRET;
  try {
    const result = await authenticateHostRequest(new Request("https://agent.example.test/api/agent/runs", {
      headers: {
        authorization: `Bearer ${signJwt({
          aud: "open-agent",
          exp: Math.floor(Date.now() / 1000) + 300,
          iss: "https://muses.example.test",
          agentRuntimeConfig: "{\"profile\":{}}",
          sub: "user-123",
          tenantId: "workspace-123",
        })}`,
      },
    }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.response.status, 403);
    assert.equal((await result.response.json()).code, "host_runtime_config_invalid");
  } finally {
    restoreEnvironment("AGENT_HOST_JWT_AUDIENCE", previous.audience);
    restoreEnvironment("AGENT_HOST_JWT_ISSUER", previous.issuer);
    restoreEnvironment("AGENT_HOST_JWT_SECRET", previous.secret);
  }
});

function signJwt(payload: Record<string, unknown>): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = encodePart(header);
  const encodedPayload = encodePart(payload);
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", SECRET).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function encodePart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
