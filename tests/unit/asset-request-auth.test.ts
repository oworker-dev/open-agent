import assert from "node:assert/strict";
import test from "node:test";
import { authenticateAssetRequest, requireAssetScope, type AssetRequestAuthentication } from "../../server/http/asset-request-auth.ts";

const identity = { tenantId: "tenant-1", principalId: "user-1", principalType: "user" };

test("Host asset requests require the declared least-privilege scope", async () => {
  const authenticated = {
    ok: true,
    accessToken: "token",
    identity,
    runtimeConfig: {} as never,
    scopes: new Set<string>(["asset:read"]),
  } satisfies AssetRequestAuthentication;
  const denied = requireAssetScope(authenticated, "asset:write");
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.response.status, 403);
    assert.equal((await denied.response.json()).code, "host_scope_required");
  }
  assert.equal(requireAssetScope(authenticated, "asset:read").ok, true);
});

test("standalone asset credentials do not require Host JWT scopes", () => {
  const standalone = { ok: true, identity, setCookie: undefined } satisfies AssetRequestAuthentication;
  assert.equal(requireAssetScope(standalone, "asset:write"), standalone);
});

test("production Host configuration does not disable standalone asset cookies", async () => {
  const previous = process.env.AGENT_HOST_JWT_SECRET;
  process.env.AGENT_HOST_JWT_SECRET = "a".repeat(32);
  try {
    const authenticated = await authenticateAssetRequest(new Request("https://agent.example/api/assets"));
    assert.equal(authenticated.ok, true);
    assert.ok(authenticated.ok && "setCookie" in authenticated && authenticated.setCookie?.startsWith("open_agent_anonymous="));
  } finally {
    if (previous === undefined) delete process.env.AGENT_HOST_JWT_SECRET;
    else process.env.AGENT_HOST_JWT_SECRET = previous;
  }
});
