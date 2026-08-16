import { defineTool } from "eve/tools";
import { z } from "zod";
import { publicationOwnerFromAuth } from "../lib/session-ownership-auth.ts";
import { AssetStoreError, createAssetStoreFromEnvironment } from "../../server/data/asset-store.ts";

const outputSchema = z.object({
  assetId: z.string(),
  bytes: z.number(),
  filename: z.string(),
  mediaType: z.string(),
  path: z.string(),
  sessionId: z.string(),
});

/** Materialize a persisted host asset into the current isolated workspace. */
export default defineTool({
  description: [
    "Import a user or host asset into the current sandbox workspace.",
    "The asset stays in object storage until this tool is used; do not ask users to paste large files into chat.",
    "The imported file is read-only from the asset store and copied to the requested path under /workspace.",
  ].join(" "),
  inputSchema: z.strictObject({
    assetId: z.string().trim().min(1).max(512),
    destination: z.string().trim().min(1).max(512).default(".open-agent/assets/"),
  }),
  outputSchema,
  async execute(input, ctx) {
    const auth = ctx.session.auth.current;
    if (!auth) throw new Error("Asset import requires an authenticated Agent session.");
    const owner = publicationOwnerFromAuth(auth);
    const store = createAssetStoreFromEnvironment();
    let asset = await store.findAsset(input.assetId, owner);
    if (!asset || asset.status !== "ready") throw new Error("The requested asset is not available.");
    if (asset.scanStatus !== "clean" && asset.scanStatus !== "disabled") {
      throw new Error("The requested asset is not available until its content scan completes.");
    }
    if (asset.sessionId !== ctx.session.id) {
      if (!asset.sessionId.startsWith("browser-") || !store.bindAssetSession) {
        throw new Error("The requested asset belongs to a different Agent session.");
      }
      asset = await store.bindAssetSession({ assetId: asset.assetId, owner, sessionId: ctx.session.id });
      if (!asset || asset.status !== "ready") {
        throw new Error("The requested asset belongs to a different Agent session.");
      }
      if (asset.scanStatus !== "clean" && asset.scanStatus !== "disabled") {
        throw new Error("The requested asset is not available until its content scan completes.");
      }
    }
    const download = await store.openReadStream(input.assetId, owner);
    if (!download) throw new Error("The requested asset could not be read.");
    const destination = normalizeWorkspacePath(input.destination, asset.filename);
    const sandbox = await ctx.getSandbox();
    await sandbox.writeFile({ content: download.stream, path: destination });
    // Imported bytes are a source snapshot. Keep the source immutable inside
    // the workspace while allowing the Agent to copy it elsewhere for edits.
    try {
      await sandbox.run({
        command: `chmod a-w -- ${shellQuote(destination)}`,
      });
    } catch {
      // Some development backends do not implement chmod. The object-store
      // copy remains source-scoped; production Docker/microVM images support
      // the immutable mode.
    }
    return {
      assetId: asset.assetId,
      bytes: asset.sizeBytes,
      filename: asset.filename,
      mediaType: asset.mediaType,
      path: destination,
      sessionId: ctx.session.id,
    };
  },
});

function normalizeWorkspacePath(value: string, filename: string): string {
  const normalized = value.startsWith("/") ? value : `/workspace/${value}`;
  const path = normalized.endsWith("/") ? `${normalized}${filename}` : normalized;
  if (!path.startsWith("/workspace/") || path.split("/").includes("..") || path.includes("\\")) {
    throw new AssetStoreError("invalid", "Asset destinations must stay inside /workspace.");
  }
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function assertAssetSession(assetSessionId: string, currentSessionId: string): void {
  if (assetSessionId !== currentSessionId) {
    throw new Error("The requested asset belongs to a different Agent session.");
  }
}
