import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { publicationOwnerFromAuth } from "../lib/session-ownership-auth.ts";
import { createAssetStoreFromEnvironment } from "../../server/data/asset-store.ts";

/** Maximum inline image payload sent through the durable model transcript. */
export const MAX_VIEW_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_PENDING_MODEL_OBSERVATIONS = 16;
const MAX_PENDING_MODEL_OBSERVATION_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_PROBE_BYTES = 64 * 1024;
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

type ModelImageObservation = {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mediaType: ViewImageMediaType;
};

const pendingModelObservations = new WeakMap<object, ModelImageObservation>();
let pendingModelObservationBytes = 0;
let pendingModelObservationCount = 0;
const observationFinalizer = new FinalizationRegistry<number>((bytes) => {
  pendingModelObservationBytes = Math.max(0, pendingModelObservationBytes - bytes);
  pendingModelObservationCount = Math.max(0, pendingModelObservationCount - 1);
});

export default defineTool({
  description: [
    "View an image from the current sandbox so a vision-capable model can inspect it.",
    "Supports PNG, JPEG, GIF, WebP, and SVG. The path must stay inside /workspace.",
    `Images over ${MAX_VIEW_IMAGE_BYTES} bytes are resized in the sandbox before being sent to the model; the original file is never modified.`,
    "Use only when the active model accepts image input.",
  ].join(" "),
  inputSchema: z.strictObject({
    path: z.string().trim().min(1).max(512),
  }),
  outputSchema,
  async execute(input, ctx) {
    assertVisionCapability(ctx);
    const path = normalizeWorkspacePath(input.path);
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
    const dimensions = readImageDimensions(bytes, outputMediaType);
    const output: ViewImageOutput = {
      assetRef: `workspace:${path}`,
      bytes: bytes.byteLength,
      ...(dimensions ? { dimensions } : {}),
      mediaType: outputMediaType,
      originalBytes,
      path,
      resized,
    };
    rememberModelObservation(output, {
      bytes,
      filename: basename(path),
      mediaType: outputMediaType,
    });
    // The model observation is the capability of this tool; the persisted
    // asset is only a UI convenience for a host's artifact panel. A temporary
    // object-store outage, quota rejection, or an unconfigured standalone
    // store must not turn a readable image into a failed vision turn. The
    // private observation remains available for toModelOutput below.
    try {
      const assetId = await persistPreviewAsset({
        bytes,
        ctx,
        filename: basename(path),
        mediaType: outputMediaType,
      });
      if (assetId) output.assetId = assetId;
    } catch {
      // Best effort only. The image bytes never leave the model output path
      // unless Eve asks toModelOutput, and that path is independent of UI
      // asset persistence.
    }
    return output;
  },
  toModelOutput(output) {
    const observation = consumeModelObservation(output);
    return toolOutput.content([
      toolOutputPart.text(`${output.resized ? "Resized image" : "Image"} ${output.path} (${output.bytes} bytes${output.resized ? `, original ${output.originalBytes} bytes` : ""}${output.dimensions ? `, ${output.dimensions.width}x${output.dimensions.height}` : ""}).`),
      toolOutputPart.file(Buffer.from(observation.bytes).toString("base64"), {
        filename: observation.filename,
        mediaType: observation.mediaType,
      }),
    ]);
  },
});

function rememberModelObservation(output: ViewImageOutput, observation: ModelImageObservation): void {
  if (
    pendingModelObservationCount >= MAX_PENDING_MODEL_OBSERVATIONS ||
    pendingModelObservationBytes + observation.bytes.byteLength > MAX_PENDING_MODEL_OBSERVATION_BYTES
  ) {
    throw new Error("The image observation buffer is busy. Retry after the active vision calls settle.");
  }
  pendingModelObservations.set(output, observation);
  pendingModelObservationBytes += observation.bytes.byteLength;
  pendingModelObservationCount += 1;
  observationFinalizer.register(output, observation.bytes.byteLength, output);
}

function consumeModelObservation(output: ViewImageOutput): ModelImageObservation {
  const observation = pendingModelObservations.get(output);
  if (!observation) {
    throw new Error("The private image observation is no longer available. Run view_image again.");
  }
  pendingModelObservations.delete(output);
  observationFinalizer.unregister(output);
  pendingModelObservationBytes = Math.max(0, pendingModelObservationBytes - observation.bytes.byteLength);
  pendingModelObservationCount = Math.max(0, pendingModelObservationCount - 1);
  return observation;
}

async function persistPreviewAsset(input: {
  readonly bytes: Uint8Array;
  readonly ctx: ViewImageContext;
  readonly filename: string;
  readonly mediaType: ViewImageMediaType;
}): Promise<string | undefined> {
  const auth = input.ctx.session.auth.current;
  if (!auth) return undefined;
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

type VisionCapabilityContext = {
  readonly session: {
    readonly auth: {
      readonly current?: {
        readonly attributes?: Readonly<Record<string, unknown>>;
      } | null;
    };
  };
};

/**
 * Eve does not expose a provider capability object on ToolContext. Hosts may
 * nevertheless fail closed by publishing one of these neutral attributes on
 * the authenticated session; absence means "unknown" and preserves the
 * standalone Agent's normal behavior.
 */
export function assertVisionCapability(ctx: VisionCapabilityContext): void {
  const attributes = ctx.session.auth.current?.attributes;
  const enabled = attributes?.agentVisionEnabled ?? attributes?.visionEnabled;
  if (enabled === false) throw new Error("The selected Agent model does not support image input.");
  const capabilities = attributes?.agentModelCapabilities;
  if (capabilities && typeof capabilities === "object" && !Array.isArray(capabilities) && "vision" in capabilities && capabilities.vision === false) {
    throw new Error("The selected Agent model does not support image input.");
  }
  const modelId = typeof attributes?.agentModelId === "string" ? attributes.agentModelId : process.env.AGENT_MODEL_ID?.trim();
  const configuredModels = process.env.AGENT_VISION_MODEL_IDS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (configuredModels.length > 0 && (!modelId || !configuredModels.includes(modelId))) {
    throw new Error("The selected Agent model is not declared vision-capable by the runtime.");
  }
}

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

function readImageDimensions(bytes: Uint8Array, mediaType: ViewImageMediaType): { width: number; height: number } | undefined {
  if (mediaType === "image/png" && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mediaType === "image/gif" && bytes.length >= 10) {
    return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) };
  }
  if (mediaType === "image/webp" && bytes.length >= 30 && ascii(bytes, 12, 16) === "VP8X") {
    const width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
    const height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    return { width, height };
  }
  if (mediaType === "image/svg+xml") {
    const head = new TextDecoder().decode(bytes.slice(0, 16_384));
    const viewBox = /viewBox\s*=\s*["']\s*[-+\d.e]+\s+[-+\d.e]+\s+([-+\d.e]+)\s+([-+\d.e]+)\s*["']/iu.exec(head);
    if (viewBox) return { width: Math.max(1, Math.round(Number(viewBox[1]))), height: Math.max(1, Math.round(Number(viewBox[2]))) };
  }
  return undefined;
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
