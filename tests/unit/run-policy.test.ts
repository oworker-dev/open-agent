import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceAgentRunPolicy,
  parseAgentRunPolicy,
  type RunPolicyState,
} from "../../agent/lib/run-policy.ts";

const emptyState: RunPolicyState = {
  inputTokens: 0,
  modelCalls: 0,
  outputTokens: 0,
  startedAtMs: 1_000,
  toolCalls: 0,
  turns: 0,
};

test("normalizes and deduplicates host capability policy", () => {
  assert.deepEqual(
    parseAgentRunPolicy({
      hostCapabilities: ["workflow.invoke", "canvas.inspect", "workflow.invoke"],
      executionMode: "cautious",
      limits: { maxTurns: 4, maxToolCalls: 8 },
    }),
    {
      executionMode: "cautious",
      hostCapabilities: ["canvas.inspect", "workflow.invoke"],
      limits: { maxToolCalls: 8, maxTurns: 4 },
    },
  );
});

test("normalizes an explicit tool allowlist and preserves an explicit empty list", () => {
  assert.deepEqual(
    parseAgentRunPolicy({ tools: ["web_fetch", "bash", "web_fetch"] }),
    { tools: ["bash", "web_fetch"] },
  );
  assert.deepEqual(parseAgentRunPolicy({ tools: [] }), { tools: [] });
  assert.throws(() => parseAgentRunPolicy({ tools: [" bad"] }), /invalid tool name/);
});

test("rejects unknown fields and invalid direct-channel budgets", () => {
  assert.throws(() => parseAgentRunPolicy({ approvalMode: "always" }), /unknown field/);
  assert.throws(() => parseAgentRunPolicy({ executionMode: "full-access" }), /executionMode/);
  assert.throws(
    () => parseAgentRunPolicy({ limits: { maxTurns: -1 } }),
    /positive safe integer/,
  );
  assert.throws(
    () => parseAgentRunPolicy({ limits: { maxTurns: 10_001 } }),
    /no greater than 10000/,
  );
  assert.throws(
    () => parseAgentRunPolicy({ hostCapabilities: [" canvas.inspect"] }),
    /invalid capability name/,
  );
});

test("enforces token, call, turn, tool, and duration limits", () => {
  const limits = {
    maxDurationMs: 500,
    maxInputTokens: 10,
    maxModelCalls: 2,
    maxOutputTokens: 10,
    maxToolCalls: 2,
    maxTurns: 2,
  };
  assert.doesNotThrow(() =>
    enforceAgentRunPolicy(
      limits,
      { ...emptyState, inputTokens: 10, modelCalls: 2, outputTokens: 10, toolCalls: 2, turns: 2 },
      1_500,
    ),
  );
  for (const [field, state] of [
    ["maxInputTokens", { ...emptyState, inputTokens: 11 }],
    ["maxModelCalls", { ...emptyState, modelCalls: 3 }],
    ["maxOutputTokens", { ...emptyState, outputTokens: 11 }],
    ["maxToolCalls", { ...emptyState, toolCalls: 3 }],
    ["maxTurns", { ...emptyState, turns: 3 }],
  ] as const) {
    assert.throws(() => enforceAgentRunPolicy(limits, state, 1_000), new RegExp(field));
  }
  assert.throws(
    () => enforceAgentRunPolicy(limits, emptyState, 1_501),
    /maxDurationMs/,
  );
});
