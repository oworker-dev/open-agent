import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import http from "node:http";
import https from "node:https";

import {
  ASSET_LOAD_MAX_PART_BYTES,
  deterministicPart,
  evaluateAssetLoad,
  parseAssetLoadConfig,
} from "../lib/asset-load-gate.ts";

const config = parseAssetLoadConfig();
const tenantId = `asset-load-tenant-${randomUUID()}`;
const accessToken = signToken({
  actorType: "service",
  scope: ["asset:read", "asset:write"],
  sub: `asset-load-runner-${randomUUID()}`,
  tenantId,
});
const sameTenantOtherPrincipalToken = signToken({
  actorType: "service",
  scope: ["asset:read"],
  sub: `asset-load-other-principal-${randomUUID()}`,
  tenantId,
});
const otherAccessToken = signToken({
  actorType: "service",
  scope: ["asset:read"],
  sub: `asset-load-other-${randomUUID()}`,
  tenantId: `asset-load-other-tenant-${randomUUID()}`,
});
const batchId = `asset-load-${Date.now()}-${randomUUID()}`;
const measuredStartedAt = performance.now();
const results = await mapWithConcurrency(
  Array.from({ length: config.totalUploads }, (_, index) => index),
  config.concurrency,
  (index) => uploadOne(index),
);
const measuredDurationMs = performance.now() - measuredStartedAt;
const loadGate = evaluateAssetLoad(results, measuredDurationMs, config);

const firstAsset = results.find((result) => result.ok && result.assetId);
const isolation = firstAsset?.assetId
  ? await verifyIsolation(firstAsset.assetId, otherAccessToken)
  : { ok: false, status: null };
const sameTenantIsolation = firstAsset?.assetId
  ? await verifyIsolation(firstAsset.assetId, sameTenantOtherPrincipalToken)
  : { ok: false, status: null };
const violations = [...loadGate.violations];
if (!isolation.ok) violations.push(`Cross-tenant asset read was not denied (status ${String(isolation.status)}).`);
if (!sameTenantIsolation.ok) violations.push(`Cross-principal asset read within the tenant was not denied (status ${String(sameTenantIsolation.status)}).`);
const cleanup = await cleanupFixtures(results);
if (cleanup.failures.length > 0) {
  violations.push(`${cleanup.failures.length} asset load fixture cleanup operations failed.`);
}

const evidence = {
  schemaVersion: "open-agent.asset-load-evidence.v1",
  batchId,
  generatedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  targetOrigin: new URL(config.baseUrl).origin,
  configuration: {
    concurrency: config.concurrency,
    totalUploads: config.totalUploads,
    sizeBytes: config.sizeBytes,
    deadlineMs: config.deadlineMs,
    maxPartBytes: ASSET_LOAD_MAX_PART_BYTES,
    theoreticalMaxInFlightPartBytes: config.concurrency * ASSET_LOAD_MAX_PART_BYTES,
  },
  budgets: {
    maxErrorRate: config.maxErrorRate,
    minThroughputMiBPerSecond: config.minThroughputMiBPerSecond,
    p95UploadMs: config.p95UploadMs,
  },
  metrics: {
    ...loadGate.metrics,
    measuredDurationMs: Math.round(measuredDurationMs),
    isolationStatus: isolation.status,
    sameTenantIsolationStatus: sameTenantIsolation.status,
    cleanedFixtures: cleanup.removed,
  },
  failures: results
    .filter((result) => !result.ok)
    .map((result) => ({ error: result.error, durationMs: result.durationMs })),
  violations,
  ok: violations.length === 0,
};
await writeEvidence(evidence);
console.log(JSON.stringify(evidence));
assert(evidence.ok, `Asset upload capacity gate failed: ${violations.join(" ")}`);

async function uploadOne(uploadIndex) {
  const startedAt = performance.now();
  let upload;
  let assetId;
  let retries = 0;
  let interruptedParts = 0;
  try {
    const sessionId = `${batchId}-session-${uploadIndex}`;
    upload = await jsonRequest(
      "POST",
      "/api/assets/uploads",
      accessToken,
      {
        filename: `${batchId}-${uploadIndex}.bin`,
        mediaType: "application/octet-stream",
        sessionId,
        sizeBytes: config.sizeBytes,
      },
      201,
    );
    assert(upload.upload?.status === "uploading", "The upload was not admitted.");
    const uploadRecord = upload.upload;
    assert(uploadRecord.transferStrategy === "direct", "The production asset gate requires browser-to-object-store direct multipart upload.");
    const chunkSize = uploadRecord.chunkSizeBytes;
    assert(Number.isSafeInteger(chunkSize) && chunkSize > 0 && chunkSize <= ASSET_LOAD_MAX_PART_BYTES, "The server returned an unsafe multipart chunk size.");
    const partCount = uploadRecord.partCount;
    assert(partCount === Math.ceil(config.sizeBytes / chunkSize), "The server returned an invalid multipart part count.");
    const checksum = createHash("sha256");

    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const partSize = Math.min(chunkSize, config.sizeBytes - (partNumber - 1) * chunkSize);
      const bytes = deterministicPart(uploadIndex, partNumber, partSize);
      checksum.update(bytes);
      if (partNumber === 1) {
        // Exercise the resumable path with a deliberately truncated first
        // request. Hosts may reject it or persist it; the full retry below
        // must work in either case.
        const partial = bytes.subarray(0, Math.max(1, Math.floor(bytes.byteLength / 2)));
        const partialTarget = await signPart(uploadRecord.uploadId, partNumber, bytes.byteLength);
        const partialResult = await partialDirectPart(partialTarget, partial, bytes.byteLength);
        assert(partialResult.status !== 401 && partialResult.status !== 403, "The partial part request was rejected by authentication.");
        interruptedParts += 1;
        retries += 1;
      }
      const target = await signPart(uploadRecord.uploadId, partNumber, bytes.byteLength);
      const etag = await directPart(target, bytes);
      const part = await jsonRequest(
        "POST",
        `/api/assets/uploads/${encodeURIComponent(uploadRecord.uploadId)}/parts/${partNumber}`,
        accessToken,
        { action: "acknowledge", etag, sizeBytes: bytes.byteLength },
        200,
      );
      assert(part.part?.partNumber === partNumber, `Part ${partNumber} was not acknowledged.`);
    }

    const asset = await jsonRequest(
      "POST",
      `/api/assets/uploads/${encodeURIComponent(uploadRecord.uploadId)}/complete`,
      accessToken,
      { checksumSha256: checksum.digest("hex") },
      201,
    );
    assert(asset.asset?.status === "ready", "The completed asset was not ready.");
    assert(asset.asset?.sizeBytes === config.sizeBytes, "The completed asset size changed.");
    assetId = asset.asset.assetId;

    await verifyRange(assetId, uploadIndex, chunkSize, 0, Math.min(31, config.sizeBytes - 1));
    const tailStart = Math.max(0, config.sizeBytes - Math.min(32, config.sizeBytes));
    await verifyRange(assetId, uploadIndex, chunkSize, tailStart, config.sizeBytes - 1);
    return {
      assetId,
      bytes: config.sizeBytes,
      durationMs: Math.round(performance.now() - startedAt),
      interruptedParts,
      ok: true,
      retries,
      uploadId: uploadRecord.uploadId,
    };
  } catch (cause) {
    return {
      bytes: 0,
      durationMs: Math.round(performance.now() - startedAt),
      error: safeError(cause),
      interruptedParts,
      ok: false,
      retries,
      ...(assetId ? { assetId } : {}),
      ...(upload?.uploadId ? { uploadId: upload.uploadId } : {}),
    };
  }
}

async function verifyRange(assetId, uploadIndex, chunkSize, start, end) {
  const response = await fetch(`${config.baseUrl}/api/assets/${encodeURIComponent(assetId)}`, {
    headers: { authorization: `Bearer ${accessToken}`, range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(config.deadlineMs),
  });
  assert(response.status === 206, `Asset range returned ${response.status}, expected 206.`);
  const actual = new Uint8Array(await response.arrayBuffer());
  const expectedLength = end - start + 1;
  assert(actual.byteLength === expectedLength, "Asset range returned the wrong byte count.");
  const partNumber = Math.floor(start / chunkSize) + 1;
  const partOffset = start - (partNumber - 1) * chunkSize;
  const expected = deterministicPart(uploadIndex, partNumber, partOffset + expectedLength).subarray(partOffset);
  assert(Buffer.from(actual).equals(Buffer.from(expected)), "Asset range content did not match the deterministic fixture.");
}

/** Remove only this run's generated assets/uploads so a load gate cannot leak bytes. */
async function cleanupFixtures(results) {
  const failures = [];
  let removed = 0;
  await mapWithConcurrency(results, config.concurrency, async (result) => {
    const target = result.assetId
      ? `/api/assets/${encodeURIComponent(result.assetId)}`
      : result.uploadId
        ? `/api/assets/uploads/${encodeURIComponent(result.uploadId)}`
        : undefined;
    if (!target) return;
    try {
      const response = await fetch(`${config.baseUrl}${target}`, {
        headers: { authorization: `Bearer ${accessToken}` },
        method: "DELETE",
        signal: AbortSignal.timeout(config.deadlineMs),
      });
      if (response.status !== 204 && response.status !== 404) {
        const payload = await response.json().catch(() => undefined);
        throw new Error(`DELETE ${target} returned ${response.status}: ${payload?.error || "unknown error"}`);
      }
      removed += 1;
    } catch (cause) {
      failures.push({ target, error: safeError(cause) });
    }
  });
  return { failures, removed };
}

async function verifyIsolation(assetId, token) {
  const response = await fetch(`${config.baseUrl}/api/assets/${encodeURIComponent(assetId)}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(config.deadlineMs),
  });
  return { ok: response.status === 403, status: response.status };
}

async function signPart(uploadId, partNumber, sizeBytes) {
  const response = await jsonRequest(
    "POST",
    `/api/assets/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`,
    accessToken,
    { action: "sign", sizeBytes },
    200,
  );
  assert(response.target?.method === "PUT" && typeof response.target?.url === "string", "The server returned an invalid direct upload target.");
  return response.target;
}

async function partialDirectPart(target, bytes, declaredSizeBytes) {
  return new Promise((resolve) => {
    const url = new URL(target.url);
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      resolve({ status });
    };
    const request = transport.request(url, {
      headers: { ...(target.headers ?? {}), "content-length": String(declaredSizeBytes) },
      method: target.method,
    }, (response) => {
      response.resume();
      response.once("end", () => finish(response.statusCode ?? 500));
    });
    request.setTimeout(Math.min(config.deadlineMs, 30_000), () => {
      request.destroy();
      finish(499);
    });
    request.once("error", () => finish(499));
    request.write(bytes, () => {
      // Preserve the declared full part length and sever the transport after
      // only half the body, matching an XHR/browser disconnect.
      request.destroy();
      finish(499);
    });
  });
}

async function directPart(target, bytes) {
  const response = await fetch(target.url, {
    body: bytes,
    headers: target.headers,
    method: target.method,
    signal: AbortSignal.timeout(config.deadlineMs),
  });
  assert(response.ok, `Direct object-store part returned ${response.status}.`);
  const etag = response.headers.get("etag");
  assert(etag, "The object store did not expose the ETag response header.");
  return etag;
}

async function jsonRequest(method, path, token, body, expectedStatus) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method,
    signal: AbortSignal.timeout(config.deadlineMs),
  });
  const payload = await response.json().catch(() => undefined);
  if (response.status !== expectedStatus) throw new Error(`${method} ${path} returned ${response.status}, expected ${expectedStatus}: ${payload?.error || "unknown error"}`);
  return payload;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function writeEvidence(value) {
  const configured = process.env.AGENT_ASSET_LOAD_EVIDENCE_PATH?.trim();
  if (!configured) return;
  const path = resolve(configured);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function signToken(claims) {
  const secret = required("AGENT_HOST_JWT_SECRET");
  const issuer = required("AGENT_HOST_JWT_ISSUER");
  const audience = required("AGENT_HOST_JWT_AUDIENCE");
  const now = Math.floor(Date.now() / 1_000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ ...claims, aud: audience, exp: now + Math.ceil(config.deadlineMs / 1_000) + 300, iat: now, iss: issuer, jti: randomUUID() });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function safeError(cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replaceAll(/[\r\n\t]+/gu, " ").slice(0, 500);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
