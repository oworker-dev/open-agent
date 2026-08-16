import assert from "node:assert/strict";
import test from "node:test";

import { buildTerminalSandboxSessionQuery } from "../../lib/sandbox-cleanup-query.ts";

test("sandbox cleanup excludes parents and ancestors with active owned subagents", () => {
  const query = buildTerminalSandboxSessionQuery("open_agent");

  assert.match(query, /with recursive active_subagent_ancestors/iu);
  assert.match(query, /child\.parent_session_id/iu);
  assert.match(query, /parent\.child_session_id = active\.ancestor_session_id/iu);
  assert.match(query, /active_child\.ancestor_session_id = r\.eve_session_id/iu);
  assert.match(query, /active_child\.tenant_id = o\.tenant_id/iu);
  assert.match(query, /active_child\.principal_id = o\.principal_id/iu);
  assert.match(query, /coalesce\(active_child\.issuer, ''\) = coalesce\(o\.issuer, ''\)/iu);
  assert.match(query, /active\.depth < 32/iu);
  assert.match(query, /o\.issuer = \$3/iu);
});

test("sandbox cleanup query quotes only validated schema identifiers", () => {
  assert.throws(
    () => buildTerminalSandboxSessionQuery("open-agent; drop schema public"),
    /unsafe PostgreSQL identifier/i,
  );
});
