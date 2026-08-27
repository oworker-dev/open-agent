import assert from "node:assert/strict";
import test from "node:test";

import { buildReadySandboxDeletionQuery } from "../../lib/sandbox-cleanup-query.ts";

test("sandbox cleanup consumes only ready explicit deletion tombstones", () => {
  const query = buildReadySandboxDeletionQuery("open_agent");

  assert.match(query, /agent_sandbox_deletions/iu);
  assert.match(query, /not_before <= now\(\)/iu);
  assert.match(query, /status in \('authorized', 'failed'\)/iu);
  assert.match(query, /status = 'claimed'/iu);
  assert.match(query, /claim_expires_at < now\(\)/iu);
  assert.doesNotMatch(query, /agent_runs/iu);
  assert.doesNotMatch(query, /agent_subagent_sessions/iu);
  assert.doesNotMatch(query, /agent_mailbox_items/iu);
});

test("sandbox cleanup query quotes only validated schema identifiers", () => {
  assert.throws(
    () => buildReadySandboxDeletionQuery("open-agent; drop schema public"),
    /unsafe PostgreSQL identifier/i,
  );
});
