import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRunPolicy } from "@oworker/open-agent-contracts/agent-run";
import type {
  AgentExtensionStore,
  AgentExtensionView,
} from "../../server/data/agent-extension-store.ts";
import { DEFAULT_AGENT_RUNTIME_CONFIG } from "../../lib/agent-runtime-config.ts";
import {
  enableAgentExtension,
  listAgentExtensions,
  revokeAgentExtension,
} from "../../server/http/agent-extension-routes.ts";

const SECRET = "01234567890123456789012345678901";
const ISSUER = "https://muses.extension-routes.test";
const AUDIENCE = "open-agent";
const MANAGE_SCOPE = "agent.extensions.manage";
const params = { extensionId: "software-task", version: "1.0.0" } as const;

test("requires a valid Host JWT with the extension management scope", async () => {
  await withHostAuthEnvironment(async () => {
    const store = memoryStore();
    const unauthenticated = await listAgentExtensions(
      new Request("https://agent.test/api/agent/extensions"),
      { store },
    );
    const forbidden = await listAgentExtensions(
      authorizedRequest("GET", "tenant-1", "user-1", "agent.runs.write"),
      { store },
    );

    assert.equal(unauthenticated.status, 401);
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).code, "agent_extension_admin_required");
    assert.deepEqual(store.calls, []);
  });
});

test("derives tenant and actor exclusively from the verified Host JWT", async () => {
  await withHostAuthEnvironment(async () => {
    const store = memoryStore();
    const enabled = await enableAgentExtension(
      authorizedRequest("PUT", "tenant-a", "admin-a", MANAGE_SCOPE, {}),
      params,
      { store },
    );
    const revoked = await revokeAgentExtension(
      authorizedRequest("DELETE", "tenant-b", "admin-b", MANAGE_SCOPE),
      params,
      { store },
    );

    assert.equal(enabled.status, 200);
    assert.equal(revoked.status, 200);
    assert.deepEqual(store.calls, [
      "enable:tenant-a:https://muses.extension-routes.test:admin-a",
      "revoke:tenant-b:https://muses.extension-routes.test:admin-b",
    ]);
  });
});

test("isolates tenant catalogs and never projects credential references", async () => {
  await withHostAuthEnvironment(async () => {
    const store = memoryStore();
    await enableAgentExtension(
      authorizedRequest("PUT", "tenant-a", "admin-a", MANAGE_SCOPE, {
        credentialRef: "vault://tenant-a/extensions/software-task",
      }),
      params,
      { store },
    );
    const tenantA = await listAgentExtensions(
      authorizedRequest("GET", "tenant-a", "admin-a", MANAGE_SCOPE),
      { store },
    );
    const tenantB = await listAgentExtensions(
      authorizedRequest("GET", "tenant-b", "admin-b", MANAGE_SCOPE),
      { store },
    );

    const tenantAText = await tenantA.text();
    const tenantBText = await tenantB.text();
    assert.ok(tenantAText.includes('"effectiveStatus":"enabled"'));
    assert.ok(tenantBText.includes('"effectiveStatus":"disabled"'));
    assert.doesNotMatch(tenantAText, /credentialRef|vault:\/\//u);
    assert.doesNotMatch(tenantBText, /credentialRef|vault:\/\//u);
  });
});

test("rejects unbounded, malformed, expanded, and secret-shaped requests", async () => {
  await withHostAuthEnvironment(async () => {
    const store = memoryStore();
    const requests = [
      authorizedRequest("PUT", "tenant-1", "admin", MANAGE_SCOPE, undefined, "{"),
      authorizedRequest("PUT", "tenant-1", "admin", MANAGE_SCOPE, { extra: true }),
      authorizedRequest("PUT", "tenant-1", "admin", MANAGE_SCOPE, { credentialRef: "sk-secret" }),
      authorizedRequest(
        "PUT",
        "tenant-1",
        "admin",
        MANAGE_SCOPE,
        undefined,
        JSON.stringify({ padding: "x".repeat(9 * 1024) }),
      ),
    ];
    const responses = await Promise.all(
      requests.map((request) => enableAgentExtension(request, params, { store })),
    );

    assert.deepEqual(responses.map((response) => response.status), [400, 400, 400, 413]);
    assert.deepEqual(store.calls, []);
  });
});

test("does not expose unexpected store errors", async () => {
  await withHostAuthEnvironment(async () => {
    const store = memoryStore();
    store.enable = async () => {
      throw new Error("database vault://tenant/private/reference failed");
    };
    const response = await enableAgentExtension(
      authorizedRequest("PUT", "tenant-1", "admin", MANAGE_SCOPE, {}),
      params,
      { store },
    );
    const text = await response.text();

    assert.equal(response.status, 400);
    assert.doesNotMatch(text, /vault:\/\/|database/u);
  });
});

test("uses the authenticated Host runtime catalog for extension administration", async () => {
  const store = memoryStore();
  const runtimeSkill = { id: "tenant-playbook", version: "1.0.0" } as const;
  const runtimeConfig = {
    ...DEFAULT_AGENT_RUNTIME_CONFIG,
    profile: {
      ...DEFAULT_AGENT_RUNTIME_CONFIG.profile,
      allowedSkills: [runtimeSkill],
      defaultSkills: [],
    },
    extensions: [{
      ...runtimeSkill,
      kind: "skill" as const,
      label: "Tenant playbook",
      description: "Tenant procedure",
      skill: { markdown: "Follow the tenant procedure." },
    }],
  };
  let receivedCatalog: readonly AgentExtensionView[] = [];
  store.list = async (_tenantId, catalog = []) => {
    receivedCatalog = catalog.map((manifest) => ({
      ...manifest,
      credentialConfigured: false,
      effectiveStatus: manifest.defaultTenantStatus,
      explicitlyConfigured: false,
    }));
    return receivedCatalog;
  };

  const response = await listAgentExtensions(
    new Request("https://agent.test/api/agent/extensions"),
    {
      authenticate: async () => ({
        accessToken: "test-host-token",
        identity: {
          issuer: ISSUER,
          principalId: "admin-a",
          principalType: "user",
          tenantId: "tenant-a",
        },
        ok: true,
        runtimeConfig,
        scopes: new Set([MANAGE_SCOPE]),
        sessionAuth: {
          attributes: { tenantId: "tenant-a" },
          authenticator: "host-jwt",
          issuer: ISSUER,
          principalId: "admin-a",
          principalType: "user",
        },
      }),
      store,
    },
  );

  assert.equal(response.status, 200);
  assert.ok(receivedCatalog.some((item) => item.id === runtimeSkill.id));
  assert.match(await response.text(), /tenant-playbook/u);
});

function memoryStore(): AgentExtensionStore & { calls: string[] } {
  const calls: string[] = [];
  const state = new Map<string, AgentExtensionView>();
  return {
    async assertPolicyAllowed(_tenantId: string, _policy: AgentRunPolicy) {},
    calls,
    async enable(input) {
      calls.push(`enable:${input.tenantId}:${input.actorId}`);
      const extension = extensionView("enabled", true) as AgentExtensionView & {
        credentialRef?: string;
      };
      if (input.credentialRef) extension.credentialRef = input.credentialRef;
      state.set(input.tenantId, extension);
      return extension;
    },
    async list(tenantId) {
      calls.push(`list:${tenantId}`);
      return [state.get(tenantId) ?? extensionView("disabled", false)];
    },
    async revoke(input) {
      calls.push(`revoke:${input.tenantId}:${input.actorId}`);
      const extension = extensionView("revoked", true);
      state.set(input.tenantId, extension);
      return extension;
    },
  };
}

function extensionView(
  effectiveStatus: AgentExtensionView["effectiveStatus"],
  explicitlyConfigured: boolean,
): AgentExtensionView {
  return {
    credentialConfigured: effectiveStatus === "enabled" && explicitlyConfigured,
    credentialMode: "none",
    defaultTenantStatus: "disabled",
    description: "Test Skill",
    effectiveStatus,
    explicitlyConfigured,
    id: "software-task",
    kind: "skill",
    requiredPermissions: [],
    status: "published",
    version: "1.0.0",
  };
}

function authorizedRequest(
  method: string,
  tenantId: string,
  subject: string,
  scope: string,
  body?: unknown,
  rawBody?: string,
): Request {
  const serialized = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Request("https://agent.test/api/agent/extensions", {
    body: serialized,
    headers: {
      authorization: `Bearer ${signJwt({
        actorType: "user",
        aud: AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 300,
        iss: ISSUER,
        scope,
        sub: subject,
        tenantId,
      })}`,
      ...(serialized === undefined ? {} : { "content-type": "application/json" }),
    },
    method,
  });
}

async function withHostAuthEnvironment(operation: () => Promise<void>): Promise<void> {
  const previous = {
    audience: process.env.AGENT_HOST_JWT_AUDIENCE,
    issuer: process.env.AGENT_HOST_JWT_ISSUER,
    secret: process.env.AGENT_HOST_JWT_SECRET,
  };
  process.env.AGENT_HOST_JWT_AUDIENCE = AUDIENCE;
  process.env.AGENT_HOST_JWT_ISSUER = ISSUER;
  process.env.AGENT_HOST_JWT_SECRET = SECRET;
  try {
    await operation();
  } finally {
    restoreEnvironment("AGENT_HOST_JWT_AUDIENCE", previous.audience);
    restoreEnvironment("AGENT_HOST_JWT_ISSUER", previous.issuer);
    restoreEnvironment("AGENT_HOST_JWT_SECRET", previous.secret);
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function signJwt(payload: Record<string, string | number>): string {
  const encodedHeader = encodePart({ alg: "HS256", typ: "JWT" });
  const encodedPayload = encodePart(payload);
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", SECRET).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function encodePart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
