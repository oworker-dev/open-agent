import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkflowArchiveAccumulator,
  createWorkflowArchiveHeader,
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

test("workflow archive parser rejects unsupported line kinds", () => {
  assert.throws(
    () => decodeWorkflowArchiveLine(JSON.stringify({ kind: "unknown" })),
    /unknown line kind/u,
  );
});
