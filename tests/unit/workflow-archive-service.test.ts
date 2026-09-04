import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkflowRootArchivable,
  findWorkflowArchiveCandidates,
} from "../../server/workflow-archive/service.ts";

test("Workflow archive discovery pages complete terminal roots by a durable cursor", async () => {
  let capturedValues: readonly unknown[] = [];
  const candidates = await findWorkflowArchiveCandidates({
    async query(_sql: string, values?: readonly unknown[]) {
      capturedValues = values ?? [];
      return {
        rows: [{ completed_at: new Date("2026-08-01T00:00:00.000Z"), root_run_id: "root-a" }],
      };
    },
  } as never, "workflow", new Date("2026-08-15T00:00:00.000Z"), 100, {
    completedAt: "2026-07-01T00:00:00.000Z",
    rootRunId: "root-before",
  });
  assert.deepEqual(capturedValues, [
    new Date("2026-08-15T00:00:00.000Z"),
    "2026-07-01T00:00:00.000Z",
    "root-before",
    100,
  ]);
  assert.deepEqual(candidates, [{
    rootRunId: "root-a",
    sourceCompletedAt: "2026-08-01T00:00:00.000Z",
  }]);
});

test("Workflow archive final guard rejects a root that became active or protected", async () => {
  await assert.rejects(
    assertWorkflowRootArchivable({
      async query() { return { rows: [{ active: true, members: "2", protected: false }] }; },
    } as never, "workflow", "root-a", new Date()),
    /became active/u,
  );
  await assert.rejects(
    assertWorkflowRootArchivable({
      async query() { return { rows: [{ active: false, members: "2", protected: true }] }; },
    } as never, "workflow", "root-a", new Date()),
    /retained Hook/u,
  );
});
