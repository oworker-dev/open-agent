import assert from "node:assert/strict";
import test from "node:test";

import {
  readAgentSandboxNetworkAllowlist,
  readAgentSandboxNetworkMode,
  resolveAgentDockerNetworkPolicy,
  resolveAgentSandboxNetworkPolicy,
} from "../../lib/sandbox-network-policy.ts";

test("defaults sandbox egress to isolated mode", () => {
  assert.equal(readAgentSandboxNetworkMode({}), "isolated");
  assert.equal(resolveAgentSandboxNetworkPolicy("isolated", "microsandbox"), "deny-all");
  assert.equal(resolveAgentDockerNetworkPolicy("isolated"), "deny-all");
});

test("standard mode allows reviewed dependency and source domains", () => {
  const policy = resolveAgentSandboxNetworkPolicy("standard", "microsandbox", ["example.com"]);
  assert.equal(typeof policy, "object");
  if (typeof policy !== "object") return;
  assert.ok(Array.isArray(policy.allow));
  assert.ok(policy.allow.includes("registry.npmjs.org"));
  assert.ok(policy.allow.includes("example.com"));
  assert.ok(policy.subnets?.deny?.includes("169.254.0.0/16"));
});

test("Docker rejects fine-grained standard mode", () => {
  assert.throws(
    () => resolveAgentDockerNetworkPolicy("standard"),
    /requires microsandbox or vercel/u,
  );
});

test("validates and normalizes deployment network configuration", () => {
  assert.equal(readAgentSandboxNetworkMode({ AGENT_SANDBOX_NETWORK_MODE: "TRUSTED" }), "trusted");
  assert.deepEqual(
    readAgentSandboxNetworkAllowlist({ AGENT_SANDBOX_NETWORK_ALLOWLIST: "Example.com, github.com, example.com" }),
    ["example.com", "github.com"],
  );
  assert.throws(
    () => readAgentSandboxNetworkMode({ AGENT_SANDBOX_NETWORK_MODE: "open" }),
    /isolated, standard, or trusted/u,
  );
  assert.throws(
    () => readAgentSandboxNetworkAllowlist({ AGENT_SANDBOX_NETWORK_ALLOWLIST: "http://example.com" }),
    /invalid domain/u,
  );
  assert.throws(
    () => readAgentSandboxNetworkAllowlist({ AGENT_SANDBOX_NETWORK_ALLOWLIST: "127.0.0.1" }),
    /invalid domain/u,
  );
});
