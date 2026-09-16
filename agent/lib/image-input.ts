import sharp from "sharp";
import { defineState, type SessionAuthContext } from "eve/context";
import type { AssetMetadata, AssetStore } from "@oworker/open-agent-contracts/asset";
import { createAssetStoreFromEnvironment } from "../../server/data/asset-store.ts";
import { publicationOwnerFromAuth } from "./session-ownership-auth.ts";

export const MAX_IMAGE_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PREVIEW_BYTES = 512 * 1024;
export const MAX_IMAGES_PER_REQUEST = 8;
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
export const imageRootSession = defineState<string | null>("open-agent.image-root-session", () => null);

export type ImageContext = {
  readonly session: {
    readonly id: string;
    readonly auth: { readonly current?: SessionAuthContext | null };
    readonly parent?: { readonly rootSessionId?: string };
  };
};
export type ImagePreview = {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly originalBytes: number;
  readonly resized: boolean;
};

/** Honor the host's explicit model capability; absent means unknown. */
export function assertVisionCapability(ctx: { readonly session: { readonly auth: {
  readonly current?: { readonly attributes?: Readonly<Record<string, unknown>> } | null;
} } }): void {
  const attributes = ctx.session.auth.current?.attributes;
  const capabilities: unknown = attributes?.agentModelCapabilities;
  if ((attributes?.agentVisionEnabled ?? attributes?.visionEnabled) === false ||
      capabilities && typeof capabilities === "object" && !Array.isArray(capabilities) && (capabilities as { vision?: unknown }).vision === false) {
    throw new Error("The selected Agent model does not support image input.");
  }
  const modelId = typeof attributes?.agentModelId === "string" ? attributes.agentModelId : process.env.AGENT_MODEL_ID?.trim();
  const models = process.env.AGENT_VISION_MODEL_IDS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (models.length && (!modelId || !models.includes(modelId))) {
    throw new Error("The selected Agent model is not declared vision-capable by the runtime.");
  }
}

/** Bind provisional uploads without waking a sandbox; children share root assets. */
export async function authorizedImageAsset(assetId: string, ctx: ImageContext, store: AssetStore): Promise<AssetMetadata> {
  const auth = ctx.session.auth.current;
  if (!auth) throw new Error("Reading an image requires an authenticated Agent session.");
  const owner = publicationOwnerFromAuth(auth);
  let asset = await store.findAsset(assetId, owner);
  const rootSessionId = ctx.session.parent?.rootSessionId ?? ctx.session.id;
  if (asset?.sessionId.startsWith("browser-") && store.bindAssetSession) {
    asset = await store.bindAssetSession({ assetId, owner, sessionId: rootSessionId });
  }
  if (!asset || asset.status !== "ready") throw new Error("The requested image asset is not available.");
  if (![ctx.session.id, rootSessionId].includes(asset.sessionId)) throw new Error("The requested image belongs to a different Agent session.");
  if (asset.scanStatus !== "clean" && asset.scanStatus !== "disabled") throw new Error("The image content scan has not completed.");
  if (!asset.mediaType.startsWith("image/")) throw new Error("The requested asset is not an image.");
  if (asset.sizeBytes > MAX_IMAGE_SOURCE_BYTES) throw new Error("The image exceeds the 32 MiB decoding limit. Supply a smaller image.");
  return asset;
}

export async function readAssetImage(assetId: string, ctx: ImageContext, signal?: AbortSignal): Promise<ImagePreview & { asset: AssetMetadata }> {
  signal?.throwIfAborted();
  assertVisionCapability(ctx);
  const store = createAssetStoreFromEnvironment();
  const asset = await authorizedImageAsset(assetId, ctx, store);
  const download = await store.openReadStream(assetId, publicationOwnerFromAuth(ctx.session.auth.current!));
  if (!download) throw new Error("The image asset could not be read.");
  const bytes = await readImageBytes(download.stream, signal);
  return { ...await prepareImagePreview(bytes, signal), asset };
}

export async function readImageBytes(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal?.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_IMAGE_SOURCE_BYTES) throw new Error("The image exceeds the 32 MiB decoding limit.");
      chunks.push(next.value);
    }
    if (!size) throw new Error("The image is empty.");
    return Buffer.concat(chunks, size);
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Decode on the application side with bounded pixels, bytes, and execution time. */
export async function prepareImagePreview(bytes: Uint8Array, signal?: AbortSignal): Promise<ImagePreview> {
  signal?.throwIfAborted();
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_SOURCE_BYTES) throw new Error("The image must be between 1 byte and 32 MiB.");
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const options = { animated: false, failOn: "warning" as const, limitInputPixels: MAX_IMAGE_PIXELS };
  const metadata = await sharp(input, options).metadata();
  if (!metadata.width || !metadata.height || !["png", "jpeg", "webp", "gif", "svg", "avif", "heif", "tiff"].includes(metadata.format ?? "")) {
    throw new Error("The file is not a supported decodable image.");
  }
  // Validate the full payload even when no resize is needed. Keep small static
  // images lossless; normalize orientation and unsupported formats otherwise.
  const preserve = ["png", "jpeg", "webp"].includes(metadata.format ?? "") &&
    (metadata.pages ?? 1) === 1 && (metadata.orientation ?? 1) === 1 &&
    Math.max(metadata.width, metadata.height) <= 2048 && bytes.byteLength <= MAX_IMAGE_PREVIEW_BYTES;
  const sourceEdge = Math.max(metadata.width, metadata.height);
  const edges = new Set([2048, 1536, 1024, 768].map((edge) => Math.min(edge, sourceEdge)));
  for (const edge of edges) {
    signal?.throwIfAborted();
    const pipeline = sharp(input, options).rotate().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).timeout({ seconds: 5 });
    const abort = () => pipeline.destroy(new Error("Image preparation was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await (preserve ? pipeline : pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 82 })).toBuffer({ resolveWithObject: true });
      signal?.throwIfAborted();
      if (preserve || result.data.byteLength <= MAX_IMAGE_PREVIEW_BYTES) {
        return {
          bytes: preserve ? bytes : result.data,
          mediaType: preserve ? `image/${metadata.format as "png" | "jpeg" | "webp"}` : "image/jpeg",
          width: result.info.width, height: result.info.height,
          originalBytes: bytes.byteLength, resized: !preserve,
        };
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      pipeline.destroy();
    }
  }
  throw new Error("The image could not be reduced to a readable preview within the model input limit.");
}
