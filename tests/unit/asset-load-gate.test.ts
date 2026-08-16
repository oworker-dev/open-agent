import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSET_LOAD_DEFAULT_SIZE_BYTES,
  deterministicPart,
  evaluateAssetLoad,
  parseAssetLoadConfig,
} from "../../lib/asset-load-gate.ts";

test("asset load config defaults to a bounded 100 MiB multipart gate", () => {
  const config = parseAssetLoadConfig({});
  assert.equal(config.sizeBytes, ASSET_LOAD_DEFAULT_SIZE_BYTES);
  assert.equal(config.concurrency, 2);
  assert.equal(config.totalUploads, 2);
  assert.equal(config.maxErrorRate, 0);
});

test("asset load config accepts explicit byte-size suffixes and rejects unsafe limits", () => {
  const config = parseAssetLoadConfig({
    AGENT_ASSET_LOAD_CONCURRENCY: "4",
    AGENT_ASSET_LOAD_SIZE_BYTES: "128MiB",
    AGENT_ASSET_LOAD_TOTAL_UPLOADS: "8",
  });
  assert.equal(config.sizeBytes, 128 * 1024 * 1024);
  assert.equal(config.totalUploads, 8);
  assert.throws(
    () => parseAssetLoadConfig({ AGENT_ASSET_LOAD_SIZE_BYTES: "11GiB" }),
    /AGENT_ASSET_LOAD_SIZE_BYTES/u,
  );
  assert.throws(
    () => parseAssetLoadConfig({ AGENT_ASSET_LOAD_CONCURRENCY: "9" }),
    /AGENT_ASSET_LOAD_CONCURRENCY/u,
  );
});

test("asset load gate reports latency, error, and throughput violations together", () => {
  const result = evaluateAssetLoad(
    [
      { bytes: 1024 * 1024, durationMs: 600, ok: true, retries: 1, interruptedParts: 1 },
      { bytes: 0, durationMs: 1_000, error: "timeout", ok: false },
    ],
    1_000,
    { maxErrorRate: 0, minThroughputMiBPerSecond: 2, p95UploadMs: 500 },
  );
  assert.deepEqual(result.violations, [
    "Upload p95 600ms exceeded 500ms.",
    "Error rate 50.00% exceeded 0.00%.",
    "Throughput 1.00 MiB/s was below 2.00 MiB/s.",
  ]);
  assert.equal(result.metrics.retries, 1);
  assert.equal(result.metrics.interruptedParts, 1);
});

test("deterministic multipart fixtures are stable and part-specific", () => {
  const first = deterministicPart(2, 1, 16);
  const same = deterministicPart(2, 1, 16);
  const nextPart = deterministicPart(2, 2, 16);
  assert.deepEqual(first, same);
  assert.notDeepEqual(first, nextPart);
  assert.equal(first[1], (first[0] + 1) & 0xff);
});
