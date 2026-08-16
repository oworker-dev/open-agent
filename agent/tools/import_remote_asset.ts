import { createHash } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  ASSET_CHUNK_SIZE_BYTES,
  AssetStoreError,
  MAX_ASSET_BYTES,
  createAssetStoreFromEnvironment,
} from "../../server/data/asset-store.ts";
import { publicationOwnerFromAuth } from "../lib/session-ownership-auth.ts";
import { safeRemoteFetch } from "../lib/safe-remote-fetch.ts";

const MAX_REMOTE_ASSET_BYTES = MAX_ASSET_BYTES;

const outputSchema = z.object({
  assetId: z.string(),
  bytes: z.number().int().positive(),
  checksumSha256: z.string().length(64),
  filename: z.string(),
  mediaType: z.string(),
  sessionId: z.string(),
  sourceUrl: z.string().url(),
});

/**
 * Import a remote binary without putting its bytes in the model transcript.
 * The provider must disclose a bounded Content-Length so the AssetStore can
 * reserve quota before any object bytes are admitted.
 */
export default defineTool({
  description: [
    "Import a remote HTTP(S) resource into the current session's asset store.",
    "Use this for images, media, archives, or other binary resources returned by web_fetch.",
    "The resource is SSRF-checked, streamed into multipart object storage, scanned by the host, and referenced by asset id; bytes are never returned in the model context.",
    "The remote server must provide a valid Content-Length within the asset limit.",
  ].join(" "),
  inputSchema: z.strictObject({
    filename: z.string().trim().min(1).max(255).optional(),
    mediaTypeHint: z.string().trim().min(1).max(200).optional(),
    timeout: z.number().finite().positive().max(120).optional(),
    url: z.string().url(),
  }),
  outputSchema,
  async execute(input, ctx) {
    const auth = ctx.session.auth.current;
    if (!auth) throw new Error("Remote asset import requires an authenticated Agent session.");
    const owner = publicationOwnerFromAuth(auth);
    const timeoutMs = Math.min(Math.max((input.timeout ?? 60) * 1_000, 1_000), 120_000);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = ctx.abortSignal
      ? AbortSignal.any([ctx.abortSignal, timeoutSignal])
      : timeoutSignal;
    const { response, url: sourceUrl } = await safeRemoteFetch(input.url, {
      headers: {
        Accept: input.mediaTypeHint ?? "*/*",
        "User-Agent": "open-agent/import-remote-asset",
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
    const store = createAssetStoreFromEnvironment();
    const upload = await store.createUpload({
      filename,
      mediaType,
      owner,
      sessionId: ctx.session.id,
      sizeBytes: declaredSize,
    });
    const reader = response.body.getReader();
    const digest = createHash("sha256");
    let uploadId = upload.uploadId;
    let partNumber = 1;
    let total = 0;
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    try {
      for (;;) {
        if (signal.aborted) throw new Error("Remote asset import was cancelled.");
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
          const part = pending.slice(0, ASSET_CHUNK_SIZE_BYTES);
          await store.writePart({ content: part, owner, partNumber, uploadId });
          pending = pending.slice(ASSET_CHUNK_SIZE_BYTES);
          partNumber += 1;
        }
      }
      if (pending.byteLength > 0) {
        await store.writePart({ content: pending, owner, partNumber, uploadId });
        partNumber += 1;
      }
      if (total !== declaredSize) {
        throw new AssetStoreError("invalid", "The remote response ended before its declared Content-Length.");
      }
      const metadata = await store.completeUpload({
        checksumSha256: digest.digest("hex"),
        owner,
        uploadId,
      });
      return {
        assetId: metadata.assetId,
        bytes: metadata.sizeBytes,
        checksumSha256: metadata.checksumSha256 ?? "",
        filename: metadata.filename,
        mediaType: metadata.mediaType,
        sessionId: metadata.sessionId,
        sourceUrl,
      };
    } catch (error) {
      await store.abortUpload({ owner, uploadId }).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  },
  toModelOutput(output) {
    return {
      type: "text",
      value: `Imported ${output.filename} (${output.mediaType}, ${output.bytes} bytes) as session asset ${output.assetId}.`,
    };
  },
});

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

function concat(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}
