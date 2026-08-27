import assert from "node:assert/strict";
import test from "node:test";
import type { AssetMetadata } from "@oworker/open-agent-contracts/asset";
import { scanAsset } from "../../server/data/asset-store-core.ts";
import {
  closeAssetStoreResources,
  configureAssetScanner,
  createAssetStoreFromEnvironment,
} from "../../server/data/asset-store.ts";

const metadata: AssetMetadata = {
  assetId: "asset-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  filename: "sample.txt",
  mediaType: "text/plain",
  principalId: "user-1",
  sessionId: "session-1",
  sizeBytes: 3,
  status: "ready",
  storageKey: "assets/asset-1/content",
  tenantId: "tenant-1",
};

test("scanAsset exposes a bounded stream and persists a clean decision", async () => {
  let called = false;
  const result = await scanAsset(
    metadata,
    "required",
    {
      async scan(input) {
        called = true;
        assert.equal(input.asset.scanStatus, "scanning");
        const reader = (await input.openReadStream()).getReader();
        const first = await reader.read();
        reader.releaseLock();
        assert.deepEqual(first.value, new Uint8Array([0x41]));
        return { status: "clean" };
      },
    },
    async () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0x41])); controller.close(); } }),
  );
  assert.equal(called, true);
  assert.equal(result.scanStatus, "clean");
});

test("scanAsset fails closed on scanner errors and bypasses only explicit disabled mode", async () => {
  const errored = await scanAsset(
    metadata,
    "required",
    { async scan() { throw new Error("scanner unavailable"); } },
    async () => new ReadableStream(),
  );
  assert.equal(errored.scanStatus, "error");

  let called = false;
  const disabled = await scanAsset(
    metadata,
    "disabled",
    { async scan() { called = true; return { status: "clean" as const }; } },
    async () => new ReadableStream(),
  );
  assert.equal(disabled.scanStatus, "disabled");
  assert.equal(called, false);
});

test("every process resolves the environment ClamAV scanner through the AssetStore factory", () => {
  configureAssetScanner(undefined);
  assert.doesNotThrow(() => createAssetStoreFromEnvironment({
    AGENT_ASSET_CLAMAV_HOST: "127.0.0.1",
    AGENT_ASSET_SCAN_MODE: "required",
    AGENT_ASSET_S3_ACCESS_KEY_ID: "fixture-access",
    AGENT_ASSET_S3_BUCKET: "fixture-bucket",
    AGENT_ASSET_S3_SECRET_ACCESS_KEY: "fixture-secret",
    AGENT_ASSET_STORAGE_BACKEND: "s3",
    AGENT_DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:5432/fixture",
  }));
  closeAssetStoreResources();
});

test("S3 asset requests reuse one transport pool until production configuration changes", () => {
  configureAssetScanner(undefined);
  const environment = {
    AGENT_ASSET_CLAMAV_HOST: "127.0.0.1",
    AGENT_ASSET_SCAN_MODE: "required",
    AGENT_ASSET_S3_ACCESS_KEY_ID: "fixture-access",
    AGENT_ASSET_S3_BUCKET: "fixture-bucket",
    AGENT_ASSET_S3_SECRET_ACCESS_KEY: "fixture-secret",
    AGENT_ASSET_STORAGE_BACKEND: "s3",
    AGENT_DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:5432/fixture",
  } as const;
  try {
    const first = createAssetStoreFromEnvironment(environment);
    const second = createAssetStoreFromEnvironment({ ...environment });
    assert.equal(second, first);

    const rotated = createAssetStoreFromEnvironment({
      ...environment,
      AGENT_ASSET_S3_SECRET_ACCESS_KEY: "rotated-secret",
    });
    assert.notEqual(rotated, first);
  } finally {
    closeAssetStoreResources();
  }
});
