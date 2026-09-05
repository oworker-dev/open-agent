import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  materializeAssetToSandbox,
  persistRemoteAsset,
} from "../lib/asset-import.ts";

export { assertAssetSession } from "../lib/asset-import.ts";

const destinationSchema = z.string().trim().min(1).max(512);

const inputSchema = z.union([
  z.strictObject({
    assetId: z.string().trim().min(1).max(512),
    destination: destinationSchema.default(".open-agent/assets/"),
  }),
  z.strictObject({
    destination: z.union([destinationSchema, z.literal(false)]).default(".open-agent/assets/"),
    filename: z.string().trim().min(1).max(255).optional(),
    mediaTypeHint: z.string().trim().min(1).max(200).optional(),
    timeout: z.number().finite().positive().max(120).optional(),
    url: z.string().url(),
  }),
]);

const outputSchema = z.object({
  assetId: z.string(),
  bytes: z.number().int().positive(),
  checksumSha256: z.string().length(64).optional(),
  filename: z.string(),
  mediaType: z.string(),
  path: z.string().optional(),
  sessionId: z.string(),
  sourceUrl: z.string().url().optional(),
});

export default defineTool({
  description: [
    "Import an existing session asset into the current sandbox workspace.",
    "For user or host attachments, pass their assetId; the clean object-store asset is copied to the requested path under /workspace.",
    "When no assetId exists yet, a remote HTTP(S) URL may be used as the source: it is SSRF-checked, persisted, scanned, and then copied to /workspace in the same call.",
    "For a remote URL only, set destination to false to persist the asset without creating or waking the sandbox.",
    "Imported workspace files are read-only source snapshots; copy them elsewhere before editing.",
  ].join(" "),
  inputSchema,
  outputSchema,
  async execute(input, ctx) {
    if ("assetId" in input) {
      return materializeAssetToSandbox({
        assetId: input.assetId,
        destination: input.destination ?? ".open-agent/assets/",
      }, ctx);
    }
    const persisted = await persistRemoteAsset({
      ...(input.filename ? { filename: input.filename } : {}),
      ...(input.mediaTypeHint ? { mediaTypeHint: input.mediaTypeHint } : {}),
      ...(input.timeout ? { timeout: input.timeout } : {}),
      url: input.url,
    }, ctx);
    const destination = input.destination ?? ".open-agent/assets/";
    if (destination === false) return persisted;
    return materializeAssetToSandbox({
      assetId: persisted.assetId,
      destination,
    }, ctx).then((materialized) => ({
      ...materialized,
      sourceUrl: persisted.sourceUrl,
      ...(persisted.checksumSha256 ? { checksumSha256: persisted.checksumSha256 } : {}),
    }));
  },
  toModelOutput(output) {
    return {
      type: "text",
      value: output.path
        ? `Imported ${output.filename} (${output.mediaType}, ${output.bytes} bytes) as session asset ${output.assetId} at ${output.path}.`
        : `Imported ${output.filename} (${output.mediaType}, ${output.bytes} bytes) as session asset ${output.assetId}.`,
    };
  },
});
