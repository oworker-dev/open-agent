import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUN_CONTRACT_VERSION,
  DEFAULT_AGENT_PROFILE,
} from "@oworker/open-agent-contracts";
import { AGENT_EMBED_CONTRACT_VERSION } from "@oworker/open-agent-contracts/embed";
import { AGENT_SESSION_CONTRACT_VERSION } from "@oworker/open-agent-contracts/agent-session";
import { AGENT_HOST_CONTRACT_VERSION } from "@oworker/open-agent-contracts/host";
import { AGENT_HOST_CAPABILITY_CONTRACT_VERSION } from "@oworker/open-agent-contracts/host-capability";
import * as agentClient from "@oworker/open-agent-client";
import { AGENT_CLIENT_VERSION, createAgentRunClient } from "@oworker/open-agent-client";
import { AGENT_UI_VERSION, createHttpAgentThreadStorage } from "@oworker/open-agent-ui";

test("SDK package exports expose the independently versioned public surfaces", () => {
  assert.equal(AGENT_RUN_CONTRACT_VERSION, "0.1.0-draft");
  assert.equal(AGENT_EMBED_CONTRACT_VERSION, "0.1.0");
  assert.equal(AGENT_SESSION_CONTRACT_VERSION, "0.1.0-draft");
  assert.equal(AGENT_HOST_CONTRACT_VERSION, "0.1.0-draft");
  assert.equal(AGENT_HOST_CAPABILITY_CONTRACT_VERSION, "0.1.0-draft");
  assert.equal(AGENT_CLIENT_VERSION, "0.1.0-alpha.9");
  assert.equal(AGENT_UI_VERSION, "0.1.0-alpha.9");
  assert.equal(DEFAULT_AGENT_PROFILE.profileId, "general-purpose");
  assert.equal(typeof createAgentRunClient, "function");
  assert.equal("createEveAgentSessionClient" in agentClient, false);
  assert.equal(typeof createHttpAgentThreadStorage, "function");
});
