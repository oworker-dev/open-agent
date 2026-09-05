import { createHash } from "node:crypto";
import type { AssetMetadata, AssetOwner, AssetStore } from "@oworker/open-agent-contracts/asset";
import type { SandboxSession } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import {
  ASSET_CHUNK_SIZE_BYTES,
  AssetStoreError,
  MAX_ASSET_BYTES,
  createAssetStoreFromEnvironment,
} from "../../server/data/asset-store.ts";
import { writeSandboxImport } from "./import-asset-quota.ts";
import { safeRemoteFetch } from "./safe-remote-fetch.ts";
import { publicationOwnerFromAuth } from "./session-ownership-auth.ts";

const MAX_REMOTE_ASSET_BYTES = MAX_ASSET_BYTES;

export type PersistRemoteAssetInput = {
  readonly filename?: string;
  readonly mediaTypeHint?: string;
  readonly timeout?: number;
  readonly url: string;
};

export type PersistedAsset = {
  readonly assetId: string;
  readonly bytes: number;
  readonly checksumSha256?: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sessionId: string;
  readonly sourceUrl?: string;
};

export type MaterializedAsset = PersistedAsset & {
  readonly path: string;
};

type AssetImportContext = Pick<ToolContext, "abortSignal" | "callId" | "getSandbox" | "session">;

/** Persist and scan a remote resource without putting binary bytes in model context. */
export async function persistRemoteAsset(
  input: PersistRemoteAssetInput,
  ctx: AssetImportContext,
): Promise<PersistedAsset> {
  const { owner, store } = assetAccess(ctx);
  const assetId = remoteAssetId(ctx.session.id, ctx.callId, input);
  const recovered = await recoverRemoteAsset(store, assetId, owner, ctx.session.id);
  if (recovered) return persistedOutput(recovered, input.url);

  const timeoutMs = Math.min(Math.max((input.timeout ?? 60) * 1_000, 1_000), 120_000);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([ctx.abortSignal, timeoutSignal]);
  const { response, url: sourceUrl } = await safeRemoteFetch(input.url, {
    headers: {
      Accept: input.mediaTypeHint ?? "*/*",
      "User-Agent": "open-agent/import-asset",
    },
    signal,
  });
  if (!response.ok) throw new Error(`Remote asset request failed with status code: ${response.status}`);

  const declaredSize = parseContentLength(response.headers.get("content-length"));
  if (declaredSize === undefined) {
    throw new AssetStoreError("invalid", "Remote assets must provide a valid Content-Length before import.");
  }
  if (declaredSize > MAX_REMOTE_ASSET_BYTES) {
    throw new AssetStoreError("quota", "The remote asset exceeds the 10 GiB asset limit.");
  }
  if (!response.body) throw new Error("The remote asset response has no readable body.");

  const mediaType = normalizeMediaType(input.mediaTypeHint ?? response.headers.get("content-type"));
  const filename = safeFilename(input.filename ?? filenameFromUrl(sourceUrl, mediaType));
  const upload = await store.createUpload({
    assetId,
    filename,
    mediaType,
    owner,
    sessionId: ctx.session.id,
    sizeBytes: declaredSize,
  });
  const reader = response.body.getReader();
  const digest = createHash("sha256");
  let partNumber = 1;
  let total = 0;
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  try {
    for (;;) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength === 0) continue;
      total += next.value.byteLength;
      if (total > declaredSize || total > MAX_REMOTE_ASSET_BYTES) {
        throw new AssetStoreError("quota", "The remote response exceeded its declared asset size.");
      }
      digest.update(next.value);
      pending = concat(pending, next.value);
      while (pending.byteLength >= ASSET_CHUNK_SIZE_BYTES) {
        throwIfAborted(signal);
        const part = pending.slice(0, ASSET_CHUNK_SIZE_BYTES);
        await store.writePart({ content: part, owner, partNumber, uploadId: upload.uploadId });
        pending = pending.slice(ASSET_CHUNK_SIZE_BYTES);
        partNumber += 1;
      }
    }
    if (pending.byteLength > 0) {
      throwIfAborted(signal);
      await store.writePart({ content: pending, owner, partNumber, uploadId: upload.uploadId });
    }
    if (total !== declaredSize) {
      throw new AssetStoreError("invalid", "The remote response ended before its declared Content-Length.");
    }
    throwIfAborted(signal);
    const checksumSha256 = digest.digest("hex");
    const metadata = await store.completeUpload({ checksumSha256, owner, uploadId: upload.uploadId });
    assertAvailableAsset(metadata, ctx.session.id);
    return {
      ...persistedOutput(metadata, sourceUrl),
      checksumSha256: metadata.checksumSha256 ?? checksumSha256,
    };
  } catch (error) {
    await store.abortUpload({ owner, uploadId: upload.uploadId }).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Copy a clean, persisted asset into the current session workspace. */
export async function materializeAssetToSandbox(
  input: { readonly assetId: string; readonly destination: string },
  ctx: AssetImportContext,
): Promise<MaterializedAsset> {
  const { owner, store } = assetAccess(ctx);
  let asset = await store.findAsset(input.assetId, owner);
  if (!asset || asset.status !== "ready") throw new Error("The requested asset is not available.");
  assertAvailableAsset(asset);
  if (asset.sessionId !== ctx.session.id) {
    if (!asset.sessionId.startsWith("browser-") || !store.bindAssetSession) {
      throw new Error("The requested asset belongs to a different Agent session.");
    }
    asset = await store.bindAssetSession({ assetId: asset.assetId, owner, sessionId: ctx.session.id });
    if (!asset || asset.status !== "ready") {
      throw new Error("The requested asset belongs to a different Agent session.");
    }
    assertAvailableAsset(asset, ctx.session.id);
  }
  throwIfAborted(ctx.abortSignal);
  const download = await store.openReadStream(asset.assetId, owner);
  if (!download) throw new Error("The requested asset could not be read.");
  const destination = normalizeWorkspacePath(input.destination, asset.filename);
  const sandbox = await ctx.getSandbox();
  throwIfAborted(ctx.abortSignal);
  await writeSandboxImport(sandbox, {
    assetId: asset.assetId,
    bytes: asset.sizeBytes,
    content: download.stream,
    destination,
  });
  await makeReadOnly(sandbox, destination);
  return { ...persistedOutput(asset), path: destination };
}

async function recoverRemoteAsset(
  store: AssetStore,
  assetId: string,
  owner: AssetOwner,
  sessionId: string,
): Promise<AssetMetadata | undefined> {
  const existing = await store.findAsset(assetId, owner);
  if (existing?.status === "ready") {
    assertAvailableAsset(existing, sessionId);
    return existing;
  }

  const upload = await store.findUploadByAsset?.(assetId, owner);
  if (upload?.status === "ready") {
    const ready = await store.findAsset(assetId, owner);
    if (ready) {
      assertAvailableAsset(ready, sessionId);
      return ready;
    }
  }
  if (upload) {
    await store.abortUpload({ owner, uploadId: upload.uploadId });
    return undefined;
  }
  if (existing) {
    if (existing.status === "uploading") {
      throw new AssetStoreError("conflict", "The previous remote asset import is still being reconciled.");
    }
    await store.deleteAsset({ assetId, owner });
  }
  return undefined;
}

function assetAccess(ctx: AssetImportContext): { readonly owner: AssetOwner; readonly store: AssetStore } {
  const auth = ctx.session.auth.current;
  if (!auth) throw new Error("Asset import requires an authenticated Agent session.");
  return {
    owner: publicationOwnerFromAuth(auth),
    store: createAssetStoreFromEnvironment(),
  };
}

function assertAvailableAsset(asset: AssetMetadata, sessionId?: string): void {
  if (asset.status !== "ready") throw new Error("The requested asset is not available.");
  if (asset.scanStatus !== "clean" && asset.scanStatus !== "disabled") {
    throw new Error("The requested asset is not available until its content scan completes.");
  }
  if (sessionId !== undefined && asset.sessionId !== sessionId) {
    throw new Error("The requested asset belongs to a different Agent session.");
  }
}

function persistedOutput(asset: AssetMetadata, sourceUrl?: string): PersistedAsset {
  return {
    assetId: asset.assetId,
    bytes: asset.sizeBytes,
    ...(asset.checksumSha256 ? { checksumSha256: asset.checksumSha256 } : {}),
    filename: asset.filename,
    mediaType: asset.mediaType,
    sessionId: asset.sessionId,
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

async function makeReadOnly(sandbox: SandboxSession, destination: string): Promise<void> {
  try {
    await sandbox.run({ command: `chmod a-w -- ${shellQuote(destination)}` });
  } catch {
    // Development backends may not implement chmod. The object-store source
    // remains immutable; production Docker/microVM backends support the mode.
  }
}

function remoteAssetId(sessionId: string, callId: string, input: PersistRemoteAssetInput): string {
  const fingerprint = JSON.stringify({
    callId,
    filename: input.filename ?? null,
    mediaTypeHint: input.mediaTypeHint ?? null,
    sessionId,
    url: input.url,
  });
  return `asset_${createHash("sha256").update(fingerprint).digest("hex")}`;
}

function parseContentLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/u.test(value.trim())) return undefined;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

function normalizeMediaType(value: string | null | undefined): string {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType && mediaType.length <= 200 ? mediaType : "application/octet-stream";
}

function filenameFromUrl(value: string, mediaType: string): string {
  const pathname = new URL(value).pathname;
  const candidate = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (candidate && /^[^\\/\0-\x1f\x7f]+$/u.test(candidate)) return candidate.slice(0, 255);
  const extension = mediaType.split("/")[1]?.replace(/[^a-z0-9]/giu, "") || "bin";
  return `remote-asset.${extension}`;
}

function safeFilename(value: string): string {
  const filename = value.trim();
  if (!filename || filename === "." || filename === ".." || filename.includes("/") || filename.includes("\\") || /[\0-\x1f\x7f]/u.test(filename)) {
    throw new AssetStoreError("invalid", "The remote asset filename is invalid.");
  }
  return filename.slice(0, 255);
}

function normalizeWorkspacePath(value: string, filename: string): string {
  const normalized = value.startsWith("/") ? value : `/workspace/${value}`;
  const path = normalized.endsWith("/") ? `${normalized}${filename}` : normalized;
  if (!path.startsWith("/workspace/") || path.split("/").includes("..") || path.includes("\\")) {
    throw new AssetStoreError("invalid", "Asset destinations must stay inside /workspace.");
  }
  return path;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Asset import was cancelled.");
}

function concat(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function assertAssetSession(assetSessionId: string, currentSessionId: string): void {
  if (assetSessionId !== currentSessionId) {
    throw new Error("The requested asset belongs to a different Agent session.");
  }
}
