import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RUNTIME_CONFIG_CONTRACT_VERSION,
  parseAgentRuntimeConfigSnapshot,
} from "@oworker/open-agent-contracts/runtime-config";
import {
  DEFAULT_AGENT_RUNTIME_CONFIG,
  readDeploymentAgentRuntimeConfig,
  runtimeDefinitionLimits,
} from "../../lib/agent-runtime-config.ts";
import { createAgentUiConfig } from "../../lib/agent-ui-config.ts";

test("standalone defaults match the Codex GPT-5.6 context policy", () => {
  assert.equal(DEFAULT_AGENT_RUNTIME_CONFIG.models[0]?.contextWindowTokens, 272_000);
  assert.equal(DEFAULT_AGENT_RUNTIME_CONFIG.models[1]?.contextWindowTokens, 272_000);
  assert.equal(DEFAULT_AGENT_RUNTIME_CONFIG.compaction.thresholdPercent, 0.9);
});

test("standalone session budgets are independent from the model context window", () => {
  assert.deepEqual(runtimeDefinitionLimits(DEFAULT_AGENT_RUNTIME_CONFIG), {
    maxInputTokensPerSession: 40_000_000,
    maxOutputTokensPerSession: 10_000_000,
  });
});

test("accepts a credential-free host runtime snapshot and projects its UI catalog", () => {
  const config = parseAgentRuntimeConfigSnapshot({
    ...DEFAULT_AGENT_RUNTIME_CONFIG,
    contractVersion: AGENT_RUNTIME_CONFIG_CONTRACT_VERSION,
    id: "third-party-host",
    version: "2.1.0",
    defaultModelId: "fast",
    models: [{
      id: "fast",
      providerModelId: "provider/private-model",
      label: "Fast",
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_192,
      reasoningLevels: ["low", "medium"],
      defaultReasoning: "medium",
    }],
  });
  const ui = createAgentUiConfig(config);
  assert.deepEqual(ui.models, [{ id: "fast", label: "Fast", contextWindowTokens: 64_000 }]);
  assert.deepEqual(ui.defaultPreferences, { modelId: "fast", reasoning: "medium" });
  assert.deepEqual(ui.reasoningLevels, ["low", "medium"]);
});

test("rejects credentials, duplicate models, and unsupported defaults", () => {
  assert.throws(
    () => parseAgentRuntimeConfigSnapshot({
      ...DEFAULT_AGENT_RUNTIME_CONFIG,
      apiKey: "secret",
    }),
    /unknown field apiKey/,
  );
  assert.throws(
    () => parseAgentRuntimeConfigSnapshot({
      ...DEFAULT_AGENT_RUNTIME_CONFIG,
      models: [DEFAULT_AGENT_RUNTIME_CONFIG.models[0], DEFAULT_AGENT_RUNTIME_CONFIG.models[0]],
    }),
    /duplicated/,
  );
  assert.throws(
    () => parseAgentRuntimeConfigSnapshot({
      ...DEFAULT_AGENT_RUNTIME_CONFIG,
      defaultModelId: "missing",
    }),
    /defaultModelId/,
  );
});

test("loads a deployment snapshot without exposing provider credentials", () => {
  const config = readDeploymentAgentRuntimeConfig({
    AGENT_RUNTIME_CONFIG_JSON: JSON.stringify(DEFAULT_AGENT_RUNTIME_CONFIG),
    OPENAI_API_KEY: "must-not-appear",
  });
  assert.equal(JSON.stringify(config).includes("must-not-appear"), false);
});

test("accepts host-published Skill content but rejects credentials and insecure MCP endpoints", () => {
  const skill = { id: "research", version: "1.0.0" };
  const config = parseAgentRuntimeConfigSnapshot({
    ...DEFAULT_AGENT_RUNTIME_CONFIG,
    profile: {
      ...DEFAULT_AGENT_RUNTIME_CONFIG.profile,
      allowedSkills: [skill],
      defaultSkills: [skill],
    },
    extensions: [{
      ...skill,
      kind: "skill",
      label: "Research",
      description: "Research procedure",
      skill: { markdown: "Use sources before answering." },
    }],
  });
  assert.equal(config.extensions?.[0]?.skill?.markdown, "Use sources before answering.");
  assert.throws(
    () => parseAgentRuntimeConfigSnapshot({
      ...DEFAULT_AGENT_RUNTIME_CONFIG,
      extensions: [{
        id: "remote",
        version: "1.0.0",
        kind: "mcp",
        label: "Remote",
        description: "Remote MCP",
        mcp: { endpoint: "http://remote.example/mcp" },
      }],
    }),
    /HTTPS/,
  );
  assert.throws(
    () => parseAgentRuntimeConfigSnapshot({
      ...DEFAULT_AGENT_RUNTIME_CONFIG,
      extensions: [{
        id: "leak",
        version: "1.0.0",
        kind: "skill",
        label: "Leak",
        description: "Contains a secret",
        skill: { markdown: "token=secret" },
        apiKey: "secret",
      }],
    }),
    /unknown field apiKey/,
  );
});
