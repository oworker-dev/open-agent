import assert from "node:assert/strict";
import test from "node:test";
import type { AssetMetadata } from "@oworker/open-agent-contracts/asset";
import { ASSET_DOWNLOAD_TTL_MS, createAssetDownloadToken, verifyAssetDownloadToken } from "../../lib/asset-download-token.ts";
import { issueAssetDownload } from "../../server/http/asset-download.ts";
import type { AssetRequestAuthentication } from "../../server/http/asset-request-auth.ts";

const owner = { issuer: "https://host.test", tenantId: "tenant-a", principalId: "person-a", principalType: "user" };
const secret = "test-download-secret-that-is-at-least-32-characters";
const now = Date.parse("2026-10-31T12:00:00Z");
const asset: AssetMetadata = { ...owner, assetId: "asset-1", createdAt: new Date(now).toISOString(), filename: "创作说明.txt", mediaType: "text/plain", sessionId: "session-1", sizeBytes: 10, status: "ready", scanStatus: "clean", storageKey: "private/asset-1" };
const authenticated: AssetRequestAuthentication = { ok: true, identity: owner, accessToken: "synthetic-host-token", runtimeConfig: {} as never, scopes: new Set(["asset:read"]) };

test("download grants conceal the complete owner and expire after five minutes", () => {
  const { token, expiresAt } = createAssetDownloadToken(asset.assetId, owner, secret, now);
  assert.equal(Date.parse(expiresAt), now + ASSET_DOWNLOAD_TTL_MS);
  assert.deepEqual(verifyAssetDownloadToken(token, asset.assetId, secret, now), { assetId: asset.assetId, owner, expiresAt: now + ASSET_DOWNLOAD_TTL_MS });
  assert.equal(verifyAssetDownloadToken(token, asset.assetId, secret, now + ASSET_DOWNLOAD_TTL_MS), undefined);
  assert.equal(verifyAssetDownloadToken(token, asset.assetId, secret, now - 1), undefined);
  assert.equal(token.includes("tenant-a"), false);
  assert.equal(token.includes("person-a"), false);
  assert.notEqual(createAssetDownloadToken(asset.assetId, owner, secret, now).token, token);
});

test("a grant cannot change asset, secret, nonce, ciphertext or authentication tag", () => {
  const { token } = createAssetDownloadToken(asset.assetId, owner, secret, now);
  assert.equal(verifyAssetDownloadToken(token, "asset-2", secret, now), undefined);
  assert.equal(verifyAssetDownloadToken(token, asset.assetId, "other-secret-that-is-at-least-32-characters", now), undefined);
  for (const index of [1, 2, 3]) {
    const parts = token.split(".");
    parts[index] = (parts[index]![0] === "a" ? "b" : "a") + parts[index]!.slice(1);
    assert.equal(verifyAssetDownloadToken(parts.join("."), asset.assetId, secret, now), undefined);
  }
  for (const invalid of ["", token + ".extra", "x".repeat(8193), "ad1.a.b.c"]) assert.equal(verifyAssetDownloadToken(invalid, asset.assetId, secret, now), undefined);
  assert.throws(() => createAssetDownloadToken(asset.assetId, owner, "short", now));
});

test("grant issuance checks the verified owner and returns only a no-store single-asset URL", async () => {
  let reads = 0;
  const response = await issueAssetDownload({ assetId: asset.assetId, authenticated, secret, now,
    store: { async findAsset(id, identity) { reads++; assert.equal(id, asset.assetId); assert.deepEqual(identity, owner); return asset; } } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  const url = new URL(result.url, "https://agent.test");
  assert.equal(url.pathname, "/api/assets/asset-1");
  assert.deepEqual(verifyAssetDownloadToken(url.searchParams.get("downloadGrant")!, asset.assetId, secret, now)?.owner, owner);
  assert.equal(JSON.stringify(result).includes("synthetic-host-token"), false);
  assert.equal(reads, 1);
});

test("grant issuance fails before storage access for missing scope or rejected auth", async () => {
  const denied = { ...authenticated, scopes: new Set<string>() } as AssetRequestAuthentication;
  for (const auth of [denied, { ok: false, response: new Response(null, { status: 401 }) } as const]) {
    const response = await issueAssetDownload({ assetId: asset.assetId, authenticated: auth, secret, now,
      store: { async findAsset() { throw new Error("unauthorized storage access"); } } });
    assert.equal(response.status, auth.ok ? 403 : 401);
  }
});

test("other-owner, expired, unready and unscanned files cannot get a download grant", async () => {
  const missing = await issueAssetDownload({ assetId: asset.assetId, authenticated, secret, now, store: { async findAsset() { return undefined; } } });
  assert.equal(missing.status, 404);
  for (const state of [{ status: "expired" }, { status: "uploading" }, { scanStatus: undefined }, { scanStatus: "pending" }, { scanStatus: "rejected" }, { scanStatus: "error" }]) {
    const response = await issueAssetDownload({ assetId: asset.assetId, authenticated, secret, now, store: { async findAsset() { return { ...asset, ...state } as AssetMetadata; } } });
    assert.equal(response.status, 409);
  }
});
