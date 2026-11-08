import sharp from "sharp";
import { defineState, type SessionAuthContext } from "eve/context";
import type { AssetMetadata, AssetStore } from "@oworker/open-agent-contracts/asset";
import { createAssetStoreFromEnvironment } from "../../server/data/asset-store.ts";
import { publicationOwnerFromAuth } from "./session-ownership-auth.ts";

export const MAX_IMAGE_SOURCE_BYTES = 32 * 1024 * 1024;
/** Codex's high-detail image budget: a 32px patch grid capped at 2,500 patches. */
export const MAX_IMAGE_DIMENSION = 2048;
export const IMAGE_PATCH_SIZE = 32;
export const MAX_IMAGE_PATCHES = 2_500;
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

/** Bind a pre-session browser upload to this authenticated root session. */
export async function bindBrowserAssetSession(
  assetId: string,
  ctx: ImageContext,
  store: AssetStore = createAssetStoreFromEnvironment(),
): Promise<AssetMetadata> {
  const auth = ctx.session.auth.current;
  if (!auth) throw new Error("Reading a session asset requires an authenticated Agent session.");
  const owner = publicationOwnerFromAuth(auth);
  let asset = await store.findAsset(assetId, owner);
  const rootSessionId = ctx.session.parent?.rootSessionId ?? ctx.session.id;
  if (asset?.sessionId.startsWith("browser-") && store.bindAssetSession) {
    asset = await store.bindAssetSession({ assetId, owner, sessionId: rootSessionId });
  }
  if (!asset || asset.status !== "ready") throw new Error("The requested session asset is not available.");
  if (![ctx.session.id, rootSessionId].includes(asset.sessionId)) throw new Error("The requested asset belongs to a different Agent session.");
  return asset;
}

/** Bind provisional uploads without waking a sandbox; children share root assets. */
export async function authorizedImageAsset(assetId: string, ctx: ImageContext, store: AssetStore): Promise<AssetMetadata> {
  const asset = await bindBrowserAssetSession(assetId, ctx, store);
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
  const sourceWidth = metadata.width;
  const sourceHeight = metadata.height;
  const [width, height] = imageDimensionsForBudget(sourceWidth, sourceHeight);
  const format = metadata.format ?? "";
  const preserveFormat = ["png", "jpeg", "webp"].includes(format);
  const preserveOrientation = metadata.orientation;
  // Keep only the color profiles that are safe after decoding to RGB. Sharp's
  // keepIccProfile() preserves the input profile byte-for-byte, so gate it on
  // the ICC color-space signature instead of copying CMYK/YCCK profiles.
  const preserveRgbIcc = hasRgbIccProfile(metadata.icc);

  // Codex keeps valid PNG/JPEG/WebP bytes untouched when the image already fits
  // the dimension and patch budgets. This also avoids needless quality loss for
  // small uploaded images; the original asset is never modified either way.
  if (width === sourceWidth && height === sourceHeight && preserveFormat) {
    return {
      bytes,
      mediaType: `image/${format as "png" | "jpeg" | "webp"}`,
      width: sourceWidth,
      height: sourceHeight,
      originalBytes: bytes.byteLength,
      resized: false,
    };
  }

  signal?.throwIfAborted();
  const pipeline = sharp(input, options)
    .resize({ width, height, fit: "fill", withoutEnlargement: false })
    .timeout({ seconds: 5 });
  if (preserveRgbIcc) pipeline.keepIccProfile();
  if (preserveOrientation !== undefined) {
    pipeline.withExif({ IFD0: { Orientation: String(preserveOrientation) } });
  }
  const abort = () => pipeline.destroy(new Error("Image preparation was cancelled."));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const encoded = encodePreparedImage(pipeline, preserveFormat ? format : "png");
    const result = await encoded.toBuffer({ resolveWithObject: true });
    signal?.throwIfAborted();
    const mediaType: ImagePreview["mediaType"] = preserveFormat
      ? format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png"
      : "image/png";
    return {
      bytes: result.data,
      mediaType,
      width: result.info.width,
      height: result.info.height,
      originalBytes: bytes.byteLength,
      resized: result.info.width !== sourceWidth || result.info.height !== sourceHeight,
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    pipeline.destroy();
  }
}

function hasRgbIccProfile(profile: Buffer | undefined): boolean {
  return profile?.subarray(16, 20).toString("ascii") === "RGB ";
}

/** Match Codex's 32px patch-budget calculation used for high-detail images. */
export function imageDimensionsForBudget(width: number, height: number): readonly [number, number] {
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  if (imageFitsBudget(width, height)) return [width, height];

  const maxDimensionScale = Math.min(MAX_IMAGE_DIMENSION / Math.max(width, height), 1);
  width = Math.max(1, Math.round(width * maxDimensionScale));
  height = Math.max(1, Math.round(height * maxDimensionScale));
  if (imageFitsBudget(width, height)) return [width, height];

  const patch = IMAGE_PATCH_SIZE;
  let scale = Math.sqrt((patch * patch * MAX_IMAGE_PATCHES) / width / height);
  const patchesWide = (width * scale) / patch;
  const patchesHigh = (height * scale) / patch;
  scale *= Math.min(Math.floor(patchesWide) / patchesWide, Math.floor(patchesHigh) / patchesHigh);
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
}

function imageFitsBudget(width: number, height: number): boolean {
  const patchesWide = Math.ceil(width / IMAGE_PATCH_SIZE);
  const patchesHigh = Math.ceil(height / IMAGE_PATCH_SIZE);
  return width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION &&
    patchesWide * patchesHigh <= MAX_IMAGE_PATCHES;
}

function encodePreparedImage(
  pipeline: ReturnType<typeof sharp>,
  format: string,
): ReturnType<typeof sharp> {
  // Preserve the source format when Codex can preserve it. Unsupported formats
  // are decoded and sent as PNG instead of being needlessly flattened to JPEG.
  switch (format) {
    case "jpeg":
      return pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 85 });
    case "webp":
      return pipeline.webp({ lossless: true });
    case "png":
    default:
      return pipeline.png();
  }
}
