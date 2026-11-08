import { defineHook } from "eve/hooks";

import {
  initializeRunPolicy,
  readAgentRunPolicy,
  recordRunPolicyActivity,
  recordRunPolicyBoundary,
  recordRunPolicyUsage,
} from "../lib/run-policy.ts";

export default defineHook({
  events: {
    "session.started"(_event, ctx) {
      initializeRunPolicy(ctx.now.getTime());
      readAgentRunPolicy(ctx);
    },
    "turn.started"(_event, ctx) {
      recordRunPolicyBoundary(readAgentRunPolicy(ctx), "turn", 1, ctx.now.getTime());
    },
    "delivery.consumed"(_event, ctx) {
      recordRunPolicyActivity(true, ctx.now.getTime());
    },
    "turn.paused"(_event, ctx) {
      recordRunPolicyActivity(false, ctx.now.getTime());
    },
    "turn.settled"(_event, ctx) {
      recordRunPolicyActivity(false, ctx.now.getTime());
    },
    "model.requested"(_event, ctx) {
      recordRunPolicyBoundary(readAgentRunPolicy(ctx), "model", 1, ctx.now.getTime());
    },
    "call.requested"(_event, ctx) {
      recordRunPolicyBoundary(readAgentRunPolicy(ctx), "tool", 1, ctx.now.getTime());
    },
    "usage.recorded"(event, ctx) {
      const usage = toUsage(event.data.usage);
      recordRunPolicyUsage(readAgentRunPolicy(ctx), usage, ctx.now.getTime());
    },
  },
});

function toUsage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const usage = value as Record<string, unknown>;
  return {
    inputTokens: nonNegative(usage.inputTokens),
    outputTokens: nonNegative(usage.outputTokens),
  };
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
