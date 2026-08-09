import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_CLIENT_CONTEXT_MAX_BYTES,
  isBoundedAgentClientContext,
} from "@oworker/open-agent-contracts/client-context";

test("accepts a Codex-sized recovery context and rejects aggregate overflow", () => {
  assert.equal(isBoundedAgentClientContext(["x".repeat(40_000)]), true);
  assert.equal(isBoundedAgentClientContext(["x".repeat(AGENT_CLIENT_CONTEXT_MAX_BYTES + 1)]), false);
  assert.equal(isBoundedAgentClientContext(["😀".repeat(AGENT_CLIENT_CONTEXT_MAX_BYTES / 4 + 1)]), false);
});
