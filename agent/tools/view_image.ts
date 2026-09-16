import { defineTool, toolOutput } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { publicationOwnerFromAuth } from "../lib/session-ownership-auth.ts";
import { createAssetStoreFromEnvironment } from "../../server/data/asset-store.ts";
import { persistRemoteAsset } from "../lib/asset-import.ts";
import { assertVisionCapability, readAssetImage, prepareImagePreview, MAX_IMAGE_SOURCE_BYTES } from "../lib/image-input.ts";
export { assertVisionCapability } from "../lib/image-input.ts";

/** Maximum workspace read before falling back to sandbox-side resizing. */
export const MAX_VIEW_IMAGE_BYTES = 3 * 1024 * 1024;
const SUPPORTED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"] as const;
export type ViewImageMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];

const outputSchema = z.object({
  assetId: z.string().optional(),
  assetRef: z.string(),
  bytes: z.number().int().nonnegative(),
  dimensions: z.object({ height: z.number().int().positive(), width: z.number().int().positive() }).optional(),
  mediaType: z.enum(SUPPORTED_MEDIA_TYPES),
  originalBytes: z.number().int().positive(),
  path: z.string(),
  resized: z.boolean(),
});

export type ViewImageOutput = z.infer<typeof outputSchema>;

export default defineTool({
  description: [
    "View an image from the current sandbox or an authorized asset so a vision-capable model can inspect it.",
    "Supports PNG, JPEG, GIF, WebP, and SVG. Provide exactly one source: assetId for uploaded images, path for workspace images, or url for remote images.",
    "Uploaded assets and remote URLs do not require a sandbox. Previews are bounded and the original is never modified.",
    "Use only when the active model accepts image input.",
  ].join(" "),
  inputSchema: z.strictObject({
    path: z.string().trim().min(1).max(512).optional(),
    assetId: z.string().trim().min(1).max(512).optional(),
    url: z.string().url().optional(),
    mediaTypeHint: z.string().trim().min(1).max(200).optional(),
  }).refine((input) => [input.path, input.assetId, input.url].filter(Boolean).length === 1 &&
    (!input.mediaTypeHint || Boolean(input.url)), "Provide exactly one image source; mediaTypeHint applies only to URLs."),
  outputSchema,
  async execute(input, ctx) {
    assertVisionCapability(ctx);
    if (input.assetId || input.url) {
      const persisted = input.url
        ? await persistRemoteAsset({ url: input.url, ...(input.mediaTypeHint ? { mediaTypeHint: input.mediaTypeHint } : {}), maxBytes: MAX_IMAGE_SOURCE_BYTES }, ctx)
        : { assetId: input.assetId! };
      const preview = await readAssetImage(persisted.assetId, ctx, ctx.abortSignal);
      const output: ViewImageOutput = {
        assetId: persisted.assetId,
        assetRef: `asset:${persisted.assetId}`,
        bytes: preview.bytes.byteLength,
        ...(preview.width && preview.height ? { dimensions: { width: preview.width, height: preview.height } } : {}),
        mediaType: preview.mediaType,
        originalBytes: preview.originalBytes,
        path: `asset://${persisted.assetId}`,
        resized: preview.resized,
      };
      return output;
    }
    const path = normalizeWorkspacePath(input.path!);
    const sandbox = await ctx.getSandbox();
    const preview = await readBoundedImage(sandbox, path, ctx.abortSignal);
    if (!preview || preview.bytes.byteLength === 0) throw new Error("The image does not exist or is empty.");

    const mediaType = detectMediaType(preview.bytes, path);
    if (!mediaType) throw new Error("The file is not a supported image format (PNG, JPEG, GIF, WebP, or SVG).");
    let bytes = preview.bytes;
    let outputMediaType = mediaType;
    let resized = false;
    let originalBytes = preview.totalBytes;
    if (preview.oversized) {
      originalBytes = await readImageFileSize(sandbox, path, ctx.abortSignal) ?? originalBytes;
      const converted = await resizeImageInSandbox(sandbox, path, ctx.abortSignal);
      bytes = converted.bytes;
      outputMediaType = converted.mediaType;
      resized = true;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_VIEW_IMAGE_BYTES) {
      throw new Error(`The image preview exceeds the ${MAX_VIEW_IMAGE_BYTES}-byte inline limit after resizing.`);
    }
    const prepared = await prepareImagePreview(bytes, ctx.abortSignal);
    bytes = prepared.bytes;
    outputMediaType = prepared.mediaType;
    resized ||= prepared.resized;
    const dimensions = { width: prepared.width, height: prepared.height };
    const output: ViewImageOutput = {
      assetRef: `workspace:${path}`,
      bytes: bytes.byteLength,
      ...(dimensions ? { dimensions } : {}),
      mediaType: outputMediaType,
      originalBytes,
      path,
      resized,
    };
    // A durable reference survives tool replay and keeps binary bytes out of
    // compaction. Failure to store the observation must remain a tool error.
    output.assetId = await persistPreviewAsset({ bytes, ctx, filename: basename(path), mediaType: outputMediaType });
    return output;
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});

async function persistPreviewAsset(input: {
  readonly bytes: Uint8Array;
  readonly ctx: ViewImageContext;
  readonly filename: string;
  readonly mediaType: ViewImageMediaType;
}): Promise<string> {
  const auth = input.ctx.session.auth.current;
  if (!auth) throw new Error("Image inspection requires an authenticated Agent session.");
  const owner = publicationOwnerFromAuth(auth);
  const store = createAssetStoreFromEnvironment();
  const upload = await store.createUpload({
    filename: input.filename,
    mediaType: input.mediaType,
    owner,
    sessionId: input.ctx.session.id,
    sizeBytes: input.bytes.byteLength,
  });
  try {
    await store.writePart({ content: input.bytes, owner, partNumber: 1, uploadId: upload.uploadId });
    const asset = await store.completeUpload({ owner, uploadId: upload.uploadId });
    return asset.assetId;
  } catch (error) {
    await store.abortUpload({ owner, uploadId: upload.uploadId }).catch(() => undefined);
    throw error;
  }
}

type ViewImageContext = {
  readonly session: {
    readonly auth: {
      readonly current?: SessionAuthContext | null;
    };
    readonly id: string;
  };
};

export function normalizeWorkspacePath(value: string): string {
  const path = value.startsWith("/") ? value : `/workspace/${value}`;
  const relative = path.slice("/workspace/".length);
  if (!relative || !path.startsWith("/workspace/") || path.includes("\\") || path.includes("\0") || relative.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("Image paths must stay inside /workspace and cannot contain traversal or empty segments.");
  }
  return path;
}

export function detectMediaType(bytes: Uint8Array, path: string): ViewImageMediaType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF89a" || ascii(bytes, 0, 6) === "GIF87a")) return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  const head = new TextDecoder().decode(bytes.slice(0, 4_096));
  if (/^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(head) && /\.svgz?$/iu.test(path)) return "image/svg+xml";
  if (/^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(head)) return "image/svg+xml";
  return undefined;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

async function readImageFileSize(
  sandbox: SandboxSession,
  path: string,
  abortSignal?: AbortSignal,
): Promise<number | undefined> {
  try {
    const result = await sandbox.run({ command: `stat -c %s -- ${shellQuote(path)}`, ...(abortSignal ? { abortSignal } : {}) });
    const value = Number(result.stdout.trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || "image";
}

export async function readBoundedImage(
  sandbox: SandboxSession,
  path: string,
  abortSignal?: AbortSignal,
): Promise<{ bytes: Uint8Array; oversized: boolean; totalBytes: number } | undefined> {
  const stream = await sandbox.readFile({ path, ...(abortSignal ? { abortSignal } : {}) });
  if (!stream) return undefined;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let oversized = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (!oversized) {
        const remaining = MAX_VIEW_IMAGE_BYTES + 1 - chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        if (remaining > 0) chunks.push(next.value.byteLength > remaining ? next.value.slice(0, remaining) : next.value);
        if (totalBytes > MAX_VIEW_IMAGE_BYTES) {
          oversized = true;
          // Stop pulling a potentially multi-gigabyte object. The resizer
          // reads the original in the sandbox without crossing the model wire.
          await reader.cancel("image preview bound reached");
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = concatChunks(chunks, Math.min(MAX_VIEW_IMAGE_BYTES, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)));
  return { bytes, oversized, totalBytes: oversized ? MAX_VIEW_IMAGE_BYTES + 1 : totalBytes };
}

function concatChunks(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const copy = chunk.subarray(0, Math.max(0, output.length - offset));
    output.set(copy, offset);
    offset += copy.byteLength;
  }
  return output;
}

export async function resizeImageInSandbox(
  sandbox: SandboxSession,
  path: string,
  abortSignal?: AbortSignal,
): Promise<{ bytes: Uint8Array; mediaType: "image/jpeg" }> {
  const destination = `/tmp/open-agent-view-${randomUUID()}.jpg`;
  try {
    const command = [
      "set -eu;",
      `if command -v magick >/dev/null 2>&1; then magick ${shellQuote(path)} -auto-orient -thumbnail '2048x2048>' -strip -quality 82 ${shellQuote(destination)};`,
      `elif command -v convert >/dev/null 2>&1; then convert ${shellQuote(path)} -auto-orient -thumbnail '2048x2048>' -strip -quality 82 ${shellQuote(destination)};`,
      "else echo 'No ImageMagick resizer is installed' >&2; exit 127; fi",
    ].join(" ");
    const result = await sandbox.run({ command, ...(abortSignal ? { abortSignal } : {}) });
    if (result.exitCode !== 0) throw new Error("The image exceeds the inline preview limit and this sandbox has no usable image resizer.");
    const bytes = await sandbox.readBinaryFile({ path: destination, ...(abortSignal ? { abortSignal } : {}) });
    if (!bytes || bytes.byteLength === 0) throw new Error("The image resizer produced an empty preview.");
    if (bytes.byteLength > MAX_VIEW_IMAGE_BYTES) throw new Error("The resized image still exceeds the inline preview limit.");
    if (detectMediaType(bytes, destination) !== "image/jpeg") throw new Error("The image resizer produced an invalid JPEG preview.");
    return { bytes, mediaType: "image/jpeg" };
  } finally {
    await sandbox.removePath({ force: true, path: destination }).catch(() => undefined);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
