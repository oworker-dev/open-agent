import type { LanguageModelMiddleware } from "ai";
import { parseAssetPrompt } from "@oworker/open-agent-contracts/asset";
import { MAX_IMAGES_PER_REQUEST, readAssetImage, type ImageContext, type ImagePreview } from "./image-input.ts";

type ModelParams = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"];
type ImageReader = (assetId: string, ctx: ImageContext, signal?: AbortSignal) => Promise<ImagePreview>;

/** Like Eve's sandbox attachment hydration, this changes only the model call.
 * Durable history and Eve's native token estimator continue to see small refs.
 */
export function assetModelInputMiddleware(ctx: ImageContext, readImage: ImageReader = readAssetImage): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    async transformParams({ params }) {
      const ids: string[] = [];
      const positions = new Map<string, number>();
      const latestUser = params.prompt.findLastIndex((message) => message.role === "user");
      const required = new Set<string>();
      for (const [index, message] of params.prompt.entries()) {
        if (message.role === "user") {
          const attached = message.content.flatMap((part) => part.type === "text"
            ? parseAssetPrompt(part.text).assets.filter((asset) => asset.mediaType.startsWith("image/")).map((asset) => asset.id) : []);
          if (attached.length > MAX_IMAGES_PER_REQUEST) throw new Error(`A message supports up to ${MAX_IMAGES_PER_REQUEST} images. Send fewer images.`);
          ids.push(...attached);
          for (const id of attached) {
            positions.set(id, index);
            if (index === latestUser) required.add(id);
          }
        } else if (message.role === "tool") {
          for (const part of message.content) {
            const id = toolImageAssetId(part);
            if (id) {
              ids.push(id);
              positions.set(id, index);
              if (index === params.prompt.length - 1) required.add(id);
            }
          }
        }
      }
      // Bound historical visual context. References remain available to the
      // model so it can explicitly re-open an older image with view_image.
      const selected = new Set([...new Set(ids.toReversed())].slice(0, MAX_IMAGES_PER_REQUEST));
      const images = new Map<string, ImagePreview>();
      for (const id of selected) {
        try {
          images.set(id, await readImage(id, ctx, params.abortSignal));
        } catch (error) {
          params.abortSignal?.throwIfAborted();
          if (required.has(id)) throw error;
          // An expired historical attachment must not break unrelated future
          // turns. Its explicit unavailable reference remains in the prompt.
        }
      }
      const prompt: ModelParams["prompt"] = [];
      const emitted = new Set<string>();
      const imageAt = (id: string, index: number) => {
        if (positions.get(id) !== index || emitted.has(id)) return undefined;
        const image = images.get(id);
        if (image) emitted.add(id);
        return image;
      };
      for (const [index, message] of params.prompt.entries()) {
        if (message.role === "user") {
          const content: Extract<ModelParams["prompt"][number], { role: "user" }>["content"] = [];
          for (const part of message.content) {
            if (part.type !== "text") { content.push(part); continue; }
            const parsed = parseAssetPrompt(part.text);
            if (!parsed.assets.length && !parsed.clientMessageId) { content.push(part); continue; }
            if (parsed.text) content.push({ ...part, text: parsed.text });
            for (const asset of parsed.assets) {
              const image = imageAt(asset.id, index);
              const note = image ? " Image included below." : asset.mediaType.startsWith("image/")
                ? " Image content is not attached at this position; use view_image with assetId to inspect it, or import_asset for file processing."
                : " Use import_asset for file processing.";
              content.push({ type: "text", text: `Attached asset ${asset.id}: ${asset.name} (${asset.mediaType}).${note}` });
              if (image) content.push({ type: "file", data: { type: "data", data: Buffer.from(image.bytes).toString("base64") }, mediaType: image.mediaType, filename: asset.name });
            }
          }
          prompt.push({ ...message, content: content.length ? content : [{ type: "text", text: "Inspect the attached files." }] });
        } else if (message.role === "tool") {
          prompt.push({ ...message, content: message.content.map((part) => {
            const id = toolImageAssetId(part);
            const image = id ? imageAt(id, index) : undefined;
            if (!image || part.type !== "tool-result") return part;
            return { ...part, output: { type: "content" as const, value: [
              { type: "text" as const, text: `Image asset ${id} (${image.width}x${image.height}).` },
              { type: "file" as const, data: { type: "data" as const, data: Buffer.from(image.bytes).toString("base64") }, mediaType: image.mediaType },
            ] } };
          }) });
        } else prompt.push(message);
      }
      return { ...params, prompt };
    },
  };
}

function toolImageAssetId(part: Extract<ModelParams["prompt"][number], { role: "tool" }>["content"][number]): string | undefined {
  if (part.type !== "tool-result" || part.toolName !== "view_image" || part.output.type !== "json") return undefined;
  const value = part.output.value;
  return value && typeof value === "object" && !Array.isArray(value) && typeof value.assetId === "string"
    ? value.assetId : undefined;
}
