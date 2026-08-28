import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkflowArchiveAccumulator,
  createWorkflowArchiveHeader,
  createWorkflowArchiveValidator,
  decodeWorkflowArchiveLine,
  encodeWorkflowArchiveLine,
} from "../../lib/workflow-archive.ts";

test("workflow archive lines preserve binary fields and deterministic manifest", () => {
  const header = createWorkflowArchiveHeader({
    createdAt: "2026-08-28T00:00:00.000Z",
    sourceSchema: "workflow",
    rootRunIds: ["root-b", "root-a", "root-a"],
  });
  assert.deepEqual(header.rootRunIds, ["root-a", "root-b"]);
  const accumulator = createWorkflowArchiveAccumulator();
  const first = { kind: "row" as const, table: "workflow_events", row: { id: "evt-1", payload_cbor: Buffer.from([0, 1, 255]) } };
  const second = { kind: "row" as const, table: "workflow_runs", row: { id: "root-a", output: { ok: true } } };
  const firstLine = accumulator.add(first);
  const secondLine = accumulator.add(second);
  assert.deepEqual(decodeWorkflowArchiveLine(firstLine), first);
  assert.deepEqual(decodeWorkflowArchiveLine(secondLine), second);
  const manifest = accumulator.finish();
  assert.equal(manifest.recordCount, 2);
  assert.deepEqual(manifest.tableCounts, { workflow_events: 1, workflow_runs: 1 });
  assert.equal(manifest.sha256.length, 64);
  const decodedManifest = decodeWorkflowArchiveLine(encodeWorkflowArchiveLine(manifest));
  assert.equal(decodedManifest.kind, "manifest");
  if (decodedManifest.kind === "manifest") assert.equal(decodedManifest.sha256, manifest.sha256);
});

test("workflow archive lines preserve PostgreSQL timestamp values", () => {
  const createdAt = new Date("2026-08-28T12:34:56.789Z");
  const row = {
    kind: "row" as const,
    table: "workflow_runs",
    row: { id: "root-a", created_at: createdAt, nested: { updated_at: createdAt } },
  };
  const decoded = decodeWorkflowArchiveLine(encodeWorkflowArchiveLine(row));
  assert.equal(decoded.kind, "row");
  if (decoded.kind === "row") {
    assert(decoded.row.created_at instanceof Date);
    assert.equal((decoded.row.created_at as Date).toISOString(), createdAt.toISOString());
    assert(decoded.row.nested && typeof decoded.row.nested === "object");
    assert.equal((decoded.row.nested as { updated_at: Date }).updated_at.toISOString(), createdAt.toISOString());
  }
  assert.throws(
    () => decodeWorkflowArchiveLine(JSON.stringify({ kind: "row", table: "workflow_runs", row: { id: "root-a", created_at: { $date: "not-a-date" } } })),
    /invalid date/u,
  );
});

test("workflow archive parser rejects unsupported line kinds", () => {
  assert.throws(
    () => decodeWorkflowArchiveLine(JSON.stringify({ kind: "unknown" })),
    /unknown line kind/u,
  );
});

test("workflow archive validator checks root closure without retaining payloads", () => {
  const header = createWorkflowArchiveHeader({
    createdAt: "2026-08-28T00:00:00.000Z",
    sourceSchema: "workflow",
    rootRunIds: ["root-a"],
  });
  const validator = createWorkflowArchiveValidator(header);
  validator.add({
    kind: "row",
    table: "workflow_steps",
    row: { run_id: "child-a", step_id: "step-a" },
  });
  validator.add({
    kind: "row",
    table: "workflow_runs",
    row: { id: "root-a", attributes: {} },
  });
  const manifest = createWorkflowArchiveAccumulator().finish();
  assert.throws(
    () => validator.finish(manifest),
    /record count mismatch/u,
  );

  const valid = createWorkflowArchiveValidator(header);
  valid.add({ kind: "row", table: "workflow_runs", row: { id: "root-a", attributes: {} } });
  valid.add({ kind: "row", table: "workflow_steps", row: { run_id: "root-a", step_id: "step-a" } });
  const accumulator = createWorkflowArchiveAccumulator();
  accumulator.add({ kind: "row", table: "workflow_runs", row: { id: "root-a", attributes: {} } });
  accumulator.add({ kind: "row", table: "workflow_steps", row: { run_id: "root-a", step_id: "step-a" } });
  assert.deepEqual(valid.finish(accumulator.finish()), {
    recordCount: 2,
    tableCounts: { workflow_runs: 1, workflow_steps: 1 },
    runCount: 1,
    rootRunIds: ["root-a"],
  });
});

test("workflow archive validator rejects duplicate rows and missing runs", () => {
  const header = createWorkflowArchiveHeader({
    createdAt: "2026-08-28T00:00:00.000Z",
    sourceSchema: "workflow",
    rootRunIds: ["root-a"],
  });
  const validator = createWorkflowArchiveValidator(header);
  const row = { kind: "row" as const, table: "workflow_runs", row: { id: "root-a", attributes: {} } };
  validator.add(row);
  assert.throws(() => validator.add(row), /duplicate workflow_runs row/u);

  const dependent = createWorkflowArchiveValidator(header);
  dependent.add({ kind: "row", table: "workflow_steps", row: { run_id: "missing", step_id: "step-a" } });
  const accumulator = createWorkflowArchiveAccumulator();
  accumulator.add({ kind: "row", table: "workflow_steps", row: { run_id: "missing", step_id: "step-a" } });
  assert.throws(() => dependent.finish(accumulator.finish()), /missing Workflow run/u);
});

test("workflow archive validator keeps child runs inside their declared root", () => {
  const header = createWorkflowArchiveHeader({
    createdAt: "2026-08-28T00:00:00.000Z",
    sourceSchema: "workflow",
    rootRunIds: ["root-a"],
  });
  const validator = createWorkflowArchiveValidator(header);
  validator.add({ kind: "row", table: "workflow_runs", row: { id: "root-a", attributes: {} } });
  validator.add({ kind: "row", table: "workflow_runs", row: { id: "child-a", attributes: { "$rootRunId": "root-a" } } });
  const accumulator = createWorkflowArchiveAccumulator();
  accumulator.add({ kind: "row", table: "workflow_runs", row: { id: "root-a", attributes: {} } });
  accumulator.add({ kind: "row", table: "workflow_runs", row: { id: "child-a", attributes: { "$rootRunId": "root-a" } } });
  const summary = validator.finish(accumulator.finish());
  assert.equal(summary.runCount, 2);
  assert.deepEqual(summary.rootRunIds, ["root-a"]);
});
