import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentRunPolicy } from "../../agent/lib/run-policy.ts";
import {
  agentExtensionCatalogForConfig,
  resolveAgentRunPolicy,
} from "../../lib/agent-extension-catalog.ts";
import { DEFAULT_AGENT_RUNTIME_CONFIG } from "../../lib/agent-runtime-config.ts";
import { parseStartAgentRun } from "../../server/agent-runs/input.ts";

const profile = { profileId: "general-purpose", version: "0.1.0" } as const;
const softwareTask = { id: "software-task", version: "1.0.0" } as const;
const defaultLimits = { maxInputTokens: 40_000_000, maxOutputTokens: 10_000_000 } as const;
const softwareConfig = {
  ...DEFAULT_AGENT_RUNTIME_CONFIG,
  id: "software-host",
  version: "1.0.0",
  profile: {
    ...DEFAULT_AGENT_RUNTIME_CONFIG.profile,
    allowedSkills: [softwareTask],
    defaultSkills: [softwareTask],
  },
} as const;

test("the standalone profile has no product-specific extension grant", () => {
  assert.deepEqual(resolveAgentRunPolicy(profile, {}), {
    limits: defaultLimits,
    mcpConnections: [],
    skills: [],
  });
});

test("a run can narrow but cannot expand its profile extension grant", () => {
  assert.deepEqual(resolveAgentRunPolicy(profile, { skills: [] }, undefined, softwareConfig), {
    limits: defaultLimits,
    mcpConnections: [],
    skills: [],
  });
  assert.throws(
    () => resolveAgentRunPolicy(
      profile,
      { skills: [{ id: "unknown", version: "1.0.0" }] },
      undefined,
      softwareConfig,
    ),
    /not allowed/,
  );
  assert.throws(
    () => resolveAgentRunPolicy(profile, { mcpConnections: [{ id: "github", version: "1.0.0" }] }),
    /not allowed/,
  );
});

test("revocation fails closed before a durable session starts", () => {
  assert.throws(
    () => resolveAgentRunPolicy(
      profile,
      {},
      new Set(["software-task@1.0.0"]),
      softwareConfig,
    ),
    /revoked/,
  );
});

test("extension references are pinned, strict, deduplicated, and sorted", () => {
  assert.deepEqual(
    parseAgentRunPolicy({ skills: [softwareTask, softwareTask] }),
    { skills: [softwareTask] },
  );
  assert.throws(
    () => parseAgentRunPolicy({ skills: [{ id: "software-task", version: "latest" }] }),
    /invalid extension ref/,
  );
  assert.throws(
    () => parseAgentRunPolicy({ skills: [{ id: "software-task", version: "1.0.0", token: "secret" }] }),
    /unknown field/,
  );
});

test("the public AgentRun boundary persists the resolved grant", () => {
  const parsed = parseStartAgentRun({
    idempotencyKey: "extension-policy-test",
    message: "Inspect the workspace.",
    profile,
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value.policy, {
      limits: defaultLimits,
      mcpConnections: [],
      skills: [],
    });
  }
});

test("runtime limits cannot be expanded by an AgentRun request", () => {
  assert.deepEqual(
    resolveAgentRunPolicy(profile, {
      limits: { maxInputTokens: 4_000_000, maxToolCalls: 12 },
    }).limits,
    { maxInputTokens: 4_000_000, maxOutputTokens: 10_000_000, maxToolCalls: 12 },
  );
});

test("derives tenant lifecycle manifests from a Host runtime config", () => {
  const runtimeSkill = { id: "tenant-playbook", version: "1.0.0" } as const;
  const runtimeMcp = { id: "tenant-mcp", version: "1.0.0" } as const;
  const catalog = agentExtensionCatalogForConfig({
    ...DEFAULT_AGENT_RUNTIME_CONFIG,
    profile: {
      ...DEFAULT_AGENT_RUNTIME_CONFIG.profile,
      allowedSkills: [runtimeSkill],
      defaultSkills: [runtimeSkill],
      allowedMcpConnections: [runtimeMcp],
      defaultMcpConnections: [],
    },
    extensions: [
      {
        ...runtimeSkill,
        kind: "skill",
        label: "Tenant playbook",
        description: "Tenant procedure",
        skill: { markdown: "Follow the tenant procedure." },
      },
      {
        ...runtimeMcp,
        kind: "mcp",
        label: "Tenant MCP",
        description: "Tenant tools",
        mcp: { endpoint: "https://mcp.example.com", authProvider: "tenant-vault" },
      },
    ],
  });

  assert.deepEqual(catalog.find((item) => item.id === runtimeSkill.id), {
    credentialMode: "none",
    defaultTenantStatus: "enabled",
    description: "Tenant procedure",
    id: "tenant-playbook",
    kind: "skill",
    requiredPermissions: [],
    status: "published",
    version: "1.0.0",
  });
  assert.deepEqual(catalog.find((item) => item.id === runtimeMcp.id), {
    credentialMode: "reference-required",
    defaultTenantStatus: "disabled",
    description: "Tenant tools",
    id: "tenant-mcp",
    kind: "mcp",
    requiredPermissions: [],
    status: "published",
    version: "1.0.0",
  });
});

test("does not treat MCP metadata as an executable connection adapter", () => {
  const runtimeMcp = { id: "tenant-mcp", version: "1.0.0" } as const;
  const config = {
    ...DEFAULT_AGENT_RUNTIME_CONFIG,
    profile: {
      ...DEFAULT_AGENT_RUNTIME_CONFIG.profile,
      allowedMcpConnections: [runtimeMcp],
      defaultMcpConnections: [],
    },
    extensions: [{
      ...runtimeMcp,
      kind: "mcp" as const,
      label: "Tenant MCP",
      description: "Tenant tools",
      mcp: { endpoint: "https://mcp.example.com", authProvider: "tenant-vault" },
    }],
  };

  assert.throws(
    () => resolveAgentRunPolicy(
      profile,
      { mcpConnections: [runtimeMcp] },
      undefined,
      config,
    ),
    /no compiled MCP connection adapter/,
  );
});
