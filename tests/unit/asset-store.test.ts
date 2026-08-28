import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ASSET_CHUNK_SIZE_BYTES,
  AssetStoreError,
  createFilesystemAssetStore,
} from "../../server/data/asset-store.ts";

const owner = { principalId: "user-1", tenantId: "tenant-1" };
const issuerQualifiedOwner = {
  principalId: "https://open-agent.local:asset-load-runner",
  tenantId: "tenant-issuer-qualified",
};

test("filesystem asset store accepts issuer-qualified authenticated principals", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-assets-"));
  try {
    const store = createFilesystemAssetStore({ root });
    const upload = await store.createUpload({
      filename: "issuer-qualified.txt",
      mediaType: "text/plain",
      owner: issuerQualifiedOwner,
      sessionId: "session-issuer-qualified",
      sizeBytes: 1,
    });
    assert.equal(upload.owner.principalId, issuerQualifiedOwner.principalId);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem asset store rejects unsafe principal identities without treating them as paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-assets-"));
  try {
    const store = createFilesystemAssetStore({ root });
    for (const principalId of [" leading-space", "trailing-space ", "contains\u0000nul", "contains\nnewline", "x".repeat(513)]) {
      await assert.rejects(
        () => store.createUpload({
          filename: "invalid-principal.txt",
          mediaType: "text/plain",
          owner: { principalId, tenantId: owner.tenantId },
          sessionId: "session-invalid-principal",
          sizeBytes: 1,
        }),
        (error: unknown) => error instanceof AssetStoreError && error.code === "invalid",
      );
    }
    await assert.rejects(
      () => store.createUpload({
        filename: "invalid-tenant.txt",
        mediaType: "text/plain",
        owner: { principalId: issuerQualifiedOwner.principalId, tenantId: "tenant/with-path" },
        sessionId: "session-invalid-tenant",
        sizeBytes: 1,
      }),
      (error: unknown) => error instanceof AssetStoreError && error.code === "invalid",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem asset store accepts 100 MiB declarations without inline message bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-assets-"));
  try {
    const store = createFilesystemAssetStore({ root });
    const upload = await store.createUpload({
      filename: "large.bin",
      mediaType: "application/octet-stream",
      owner,
      sessionId: "session-1",
      sizeBytes: 100 * 1024 * 1024,
    });
    assert.equal(upload.status, "uploading");
    assert.equal(upload.sizeBytes, 100 * 1024 * 1024);
    assert.equal(upload.partCount, 13);
    assert.equal(upload.chunkSizeBytes, ASSET_CHUNK_SIZE_BYTES);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem asset store reserves aggregate quota before admitting a multipart upload", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-assets-"));
  try {
    const store = createFilesystemAssetStore({ root, quotaBytes: 2 });
    await store.createUpload({
      filename: "first.bin",
      mediaType: "application/octet-stream",
      owner,
      sessionId: "session-1",
      sizeBytes: 2,
    });
    await assert.rejects(
      () => store.createUpload({
        filename: "second.bin",
        mediaType: "application/octet-stream",
        owner,
        sessionId: "session-1",
        sizeBytes: 1,
      }),
      (error: unknown) => error instanceof AssetStoreError && error.code === "quota",
    );
    assert.deepEqual(await store.getQuota(owner), { activeUploadBytes: 2, limitBytes: 2, usedBytes: 0 });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem aggregate quota reservation is atomic for concurrent uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-assets-"));
  try {
    // Each request resolves the environment independently, so use two store
    // instances to exercise the module-level reservation boundary.
    const firstStore = createFilesystemAssetStore({ root, quotaBytes: 2 });
    const secondStore = createFilesystemAssetStore({ root, quotaBytes: 2 });
    const results = await Promise.allSettled([
      firstStore.createUpload({
        filename: "first.bin",
        mediaType: "application/octet-stream",
        owner,
        sessionId: "session-1",
        sizeBytes: 2,
      }),
      secondStore.createUpload({
        filename: "second.bin",
        mediaType: "application/octet-stream",
        owner,
        sessionId: "session-1",
        sizeBytes: 2,
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof AssetStoreError && rejected.reason.code === "quota");
    assert.deepEqual(await firstStore.getQuota(owner), { activeUploadBytes: 2, limitBytes: 2, usedBytes: 0 });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem asset store rejects path-like caller supplied asset ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-assets-"));
  try {
    const store = createFilesystemAssetStore({ root });
    await assert.rejects(
      () => store.createUpload({
        assetId: "../escape",
        filename: "file.txt",
        mediaType: "text/plain",
        owner,
        sessionId: "session-1",
        sizeBytes: 1,
      }),
      (error: unknown) => error instanceof AssetStoreError && error.code === "invalid",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem asset store completes parts, verifies checksum, and serves ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-assets-"));
  try {
    const store = createFilesystemAssetStore({ root });
    const first = new Uint8Array(ASSET_CHUNK_SIZE_BYTES).fill(0x41);
    const second = new Uint8Array(1024).fill(0x42);
    const upload = await store.createUpload({
      filename: "sample.bin",
      mediaType: "application/octet-stream",
      owner,
      sessionId: "session-1",
      sizeBytes: first.byteLength + second.byteLength,
    });
    await store.writePart({ content: first, owner, partNumber: 1, uploadId: upload.uploadId });
    await store.writePart({ content: second, owner, partNumber: 2, uploadId: upload.uploadId });
    const asset = await store.completeUpload({ owner, uploadId: upload.uploadId });
    assert.equal(asset.status, "ready");
    assert.equal(asset.sizeBytes, first.byteLength + second.byteLength);
    const range = await store.openReadStream(asset.assetId, owner, { end: 4, start: 2 });
    assert.ok(range);
    assert.equal(range.contentLength, 3);
    assert.deepEqual(new Uint8Array(await new Response(range.stream).arrayBuffer()), new Uint8Array([0x41, 0x41, 0x41]));
    await assert.rejects(
      () => store.findAsset(asset.assetId, { principalId: "other", tenantId: "tenant-1" }),
      (error: unknown) => error instanceof AssetStoreError && error.code === "forbidden",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem asset store rejects missing or non-contiguous parts", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-assets-"));
  try {
    const store = createFilesystemAssetStore({ root });
    const upload = await store.createUpload({
      filename: "sample.bin",
      mediaType: "application/octet-stream",
      owner,
      sessionId: "session-1",
      sizeBytes: ASSET_CHUNK_SIZE_BYTES + 1,
    });
    await store.writePart({ content: new Uint8Array(1), owner, partNumber: 2, uploadId: upload.uploadId });
    await assert.rejects(
      () => store.completeUpload({ owner, uploadId: upload.uploadId }),
      (error: unknown) => error instanceof AssetStoreError && error.code === "invalid",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem asset store binds a provisional browser upload once", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-assets-"));
  try {
    const store = createFilesystemAssetStore({ root });
    const upload = await store.createUpload({
      filename: "provisional.txt",
      mediaType: "text/plain",
      owner,
      sessionId: "browser-tab-1",
      sizeBytes: 1,
    });
    await store.writePart({ content: new Uint8Array([0x41]), owner, partNumber: 1, uploadId: upload.uploadId });
    const asset = await store.completeUpload({ owner, uploadId: upload.uploadId });
    const bound = await store.bindAssetSession?.({ assetId: asset.assetId, owner, sessionId: "session-1" });
    assert.equal(bound?.sessionId, "session-1");
    const second = await store.bindAssetSession?.({ assetId: asset.assetId, owner, sessionId: "session-2" });
    assert.equal(second, undefined);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem asset completion serializes concurrent callers", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-assets-"));
  try {
    let releaseScan!: () => void;
    let signalScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => { signalScanStarted = resolve; });
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    let scanCalls = 0;
    const store = createFilesystemAssetStore({
      root,
      scanMode: "required",
      scanner: {
        async scan() {
          scanCalls += 1;
          signalScanStarted();
          await scanGate;
          return { status: "clean" as const };
        },
      },
    });
    const upload = await store.createUpload({
      filename: "concurrent.txt",
      mediaType: "text/plain",
      owner,
      sessionId: "session-1",
      sizeBytes: 1,
    });
    await store.writePart({ content: new Uint8Array([0x41]), owner, partNumber: 1, uploadId: upload.uploadId });

    const first = store.completeUpload({ owner, uploadId: upload.uploadId });
    await scanStarted;
    const second = store.completeUpload({ owner, uploadId: upload.uploadId });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(scanCalls, 1, "a second completion must wait for the first lifecycle mutation");
    releaseScan();
    const [firstAsset, secondAsset] = await Promise.all([first, second]);
    assert.equal(scanCalls, 1);
    assert.equal(firstAsset.assetId, secondAsset.assetId);
    assert.equal(secondAsset.status, "ready");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem asset binding allows only one concurrent session claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-assets-"));
  try {
    const store = createFilesystemAssetStore({ root });
    const upload = await store.createUpload({
      filename: "claim.txt",
      mediaType: "text/plain",
      owner,
      sessionId: "browser-tab-claim",
      sizeBytes: 1,
    });
    await store.writePart({ content: new Uint8Array([0x41]), owner, partNumber: 1, uploadId: upload.uploadId });
    const asset = await store.completeUpload({ owner, uploadId: upload.uploadId });

    const [first, second] = await Promise.all([
      store.bindAssetSession?.({ assetId: asset.assetId, owner, sessionId: "session-a" }),
      store.bindAssetSession?.({ assetId: asset.assetId, owner, sessionId: "session-b" }),
    ]);
    assert.equal([first, second].filter(Boolean).length, 1);
    const bound = await store.findAsset(asset.assetId, owner);
    assert.ok(bound?.sessionId === "session-a" || bound?.sessionId === "session-b");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem asset store removes expired objects and abandoned uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-assets-"));
  try {
    const store = createFilesystemAssetStore({ root });
    const expiredAt = new Date("2020-01-01T00:00:00.000Z");
    const readyUpload = await store.createUpload({
      expiresAt: expiredAt,
      filename: "expired.txt",
      mediaType: "text/plain",
      owner,
      sessionId: "session-1",
      sizeBytes: 1,
    });
    await store.writePart({ content: new Uint8Array([0x41]), owner, partNumber: 1, uploadId: readyUpload.uploadId });
    const ready = await store.completeUpload({ owner, uploadId: readyUpload.uploadId });
    const abandoned = await store.createUpload({
      expiresAt: expiredAt,
      filename: "abandoned.txt",
      mediaType: "text/plain",
      owner,
      sessionId: "session-1",
      sizeBytes: 1,
    });
    const result = await store.cleanupExpired?.({ now: new Date("2021-01-01T00:00:00.000Z") });
    assert.deepEqual(result, { abortedUploads: 1, deletedAssets: 1 });
    assert.equal(await store.findAsset(ready.assetId, owner), undefined);
    assert.equal(await store.findUpload(abandoned.uploadId, owner), undefined);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
