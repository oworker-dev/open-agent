import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { randomUUID } from "node:crypto";

/** Maximum inline image payload sent through the durable model transcript. */
export const MAX_VIEW_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_PROBE_BYTES = 64 * 1024;
const SUPPORTED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"] as const;
export type ViewImageMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];

const outputSchema = z.object({
  bytes: z.number().int().nonnegative(),
  dataBase64: z.string(),
  mediaType: z.enum(SUPPORTED_MEDIA_TYPES),
  originalBytes: z.number().int().positive(),
  path: z.string(),
  resized: z.boolean(),
});

export type ViewImageOutput = z.infer<typeof outputSchema>;

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
    if (preview.oversized) {
      const converted = await resizeImageInSandbox(sandbox, path, ctx.abortSignal);
      bytes = converted.bytes;
      outputMediaType = converted.mediaType;
      resized = true;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_VIEW_IMAGE_BYTES) {
      throw new Error(`The image preview exceeds the ${MAX_VIEW_IMAGE_BYTES}-byte inline limit after resizing.`);
    }
    return {
      bytes: bytes.byteLength,
      dataBase64: Buffer.from(bytes).toString("base64"),
      mediaType: outputMediaType,
      originalBytes: preview.totalBytes,
      path,
      resized,
    };
  },
  toModelOutput(output) {
    return toolOutput.content([
      toolOutputPart.text(`${output.resized ? "Resized image" : "Image"} ${output.path} (${output.bytes} bytes${output.resized ? `, original ${output.originalBytes} bytes` : ""}).`),
      toolOutputPart.file(output.dataBase64, { mediaType: output.mediaType, filename: basename(output.path) }),
    ]);
  },
});

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
