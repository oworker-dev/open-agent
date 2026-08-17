import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { configureAssetScanner, createAssetStoreFromEnvironment, AssetStoreError } from "../server/data/asset-store.ts";
import { createClamAvAssetScannerFromEnvironment } from "../server/data/clamav-asset-scanner.ts";
import { closeAgentDatabasePools } from "../server/data/agent-database.ts";

const scanner = createClamAvAssetScannerFromEnvironment();
if (!scanner) throw new Error("AGENT_ASSET_CLAMAV_HOST is required for the production asset gate.");
configureAssetScanner(scanner);
const store = createAssetStoreFromEnvironment();
if (!store.createPartUpload || !store.acknowledgePart || !store.cleanupExpired) {
  throw new Error("The production asset gate requires direct multipart upload and retention support.");
}

const runId = randomUUID();
const owner = {
  issuer: "https://open-agent.asset-production-gate",
  principalId: `asset-gate-principal-${runId}`,
  principalType: "service",
  tenantId: `asset-gate-tenant-${runId}`,
};
const cleanup = [];
const evidence = {
  schemaVersion: "open-agent.asset-production-evidence.v1",
  generatedAt: new Date().toISOString(),
  cleanup: false,
  directTransfer: false,
  malwareRejected: false,
  quotaReservation: false,
  readyAssetExpired: false,
  staleMultipartAborted: false,
};

try {
  await verifyQuotaReservation();
  const clean = await uploadBytes({
    bytes: Buffer.from("Open Agent production asset scanner probe.\n", "utf8"),
    expiresAt: new Date(Date.now() + 60_000),
    filename: "clean-probe.txt",
  });
  cleanup.push({ assetId: clean.assetId });
  assert.equal(clean.scanStatus, "clean", "ClamAV did not mark the benign fixture clean.");
  const readable = await store.openReadStream(clean.assetId, owner);
  assert(readable, "The clean asset was not readable.");
  assert.equal(Buffer.from(await new Response(readable.stream).arrayBuffer()).toString("utf8"), "Open Agent production asset scanner probe.\n");

  const eicar = await uploadBytes({
    bytes: Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*", "ascii"),
    expiresAt: new Date(Date.now() + 60_000),
    filename: "scanner-probe.txt",
  });
  cleanup.push({ assetId: eicar.assetId });
  assert.equal(eicar.scanStatus, "rejected", "ClamAV did not reject the EICAR test fixture.");
  assert.equal(await store.openReadStream(eicar.assetId, owner), undefined, "A rejected asset remained readable.");
  evidence.malwareRejected = true;

  const expiredReady = await uploadBytes({
    bytes: Buffer.from("expired-ready-fixture", "utf8"),
    expiresAt: new Date(Date.now() - 60_000),
    filename: "expired-ready.txt",
  });
  cleanup.push({ assetId: expiredReady.assetId });
  assert.equal(expiredReady.scanStatus, "clean");

  const expiredUpload = await store.createUpload({
    expiresAt: new Date(Date.now() - 60_000),
    filename: "expired-multipart.bin",
    mediaType: "application/octet-stream",
    owner,
    sessionId: `asset-gate-session-${runId}`,
    sizeBytes: 1,
  });
  cleanup.push({ uploadId: expiredUpload.uploadId });
  assert.equal(expiredUpload.transferStrategy, "direct");

  const retention = await store.cleanupExpired({ limit: 10, now: new Date() });
  assert(retention.deletedAssets >= 1, "The expired completed object was not deleted.");
  assert(retention.abortedUploads >= 1, "The expired multipart upload was not aborted.");
  assert.equal(await store.findAsset(expiredReady.assetId, owner), undefined);
  await assert.rejects(
    store.findUpload(expiredUpload.uploadId, owner),
    (error) => error instanceof AssetStoreError && error.code === "not_found",
  );
  evidence.readyAssetExpired = true;
  evidence.staleMultipartAborted = true;
  evidence.cleanup = true;
} finally {
  for (const item of cleanup.reverse()) {
    if (item.assetId) await store.deleteAsset({ assetId: item.assetId, owner }).catch(() => undefined);
    if (item.uploadId) await store.abortUpload({ owner, uploadId: item.uploadId }).catch(() => undefined);
  }
  await closeAgentDatabasePools();
}

await writeEvidence(evidence);
console.log(JSON.stringify(evidence));

async function verifyQuotaReservation() {
  const quota = await store.getQuota(owner);
  const available = quota.limitBytes - quota.usedBytes - quota.activeUploadBytes;
  assert(available >= 2, "The production gate owner has no quota available.");
  const firstSize = Math.floor(available / 2);
  const secondSize = available - firstSize;
  const reservations = [];
  try {
    for (const [index, sizeBytes] of [firstSize, secondSize].entries()) {
      const upload = await store.createUpload({
        filename: `quota-${index}.bin`,
        mediaType: "application/octet-stream",
        owner,
        sessionId: `asset-gate-session-${runId}`,
        sizeBytes,
      });
      reservations.push(upload.uploadId);
    }
    await assert.rejects(
      store.createUpload({
        filename: "quota-overflow.bin",
        mediaType: "application/octet-stream",
        owner,
        sessionId: `asset-gate-session-${runId}`,
        sizeBytes: 1,
      }),
      (error) => error instanceof AssetStoreError && error.code === "quota" && /aggregate/u.test(error.message),
    );
    evidence.quotaReservation = true;
  } finally {
    for (const uploadId of reservations) await store.abortUpload({ owner, uploadId }).catch(() => undefined);
  }
}

async function uploadBytes({ bytes, expiresAt, filename }) {
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const upload = await store.createUpload({
    expiresAt,
    filename,
    mediaType: "application/octet-stream",
    owner,
    sessionId: `asset-gate-session-${runId}`,
    sizeBytes: bytes.byteLength,
  });
  assert.equal(upload.transferStrategy, "direct");
  evidence.directTransfer = true;
  const target = await store.createPartUpload({
    owner,
    partNumber: 1,
    sizeBytes: bytes.byteLength,
    uploadId: upload.uploadId,
  });
  const response = await fetch(target.url, { body: bytes, headers: target.headers, method: target.method });
  assert.equal(response.ok, true, `Direct MinIO upload returned ${response.status}.`);
  const etag = response.headers.get("etag");
  assert(etag, "MinIO did not return an ETag.");
  await store.acknowledgePart({ etag, owner, partNumber: 1, sizeBytes: bytes.byteLength, uploadId: upload.uploadId });
  return store.completeUpload({ checksumSha256, owner, uploadId: upload.uploadId });
}

async function writeEvidence(value) {
  const configured = process.env.AGENT_ASSET_PRODUCTION_EVIDENCE_PATH?.trim();
  if (!configured) return;
  const path = resolve(configured);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
