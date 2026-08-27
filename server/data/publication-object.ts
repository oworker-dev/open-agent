import type { AssetOwner, AssetStore } from "@oworker/open-agent-contracts/asset";
import { createHash, randomUUID } from "node:crypto";

export async function writePublicationObject(input: {
  readonly assetStore: AssetStore;
  readonly content: Uint8Array;
  readonly expiresAt: Date;
  readonly filename: string;
  readonly mediaType: string;
  readonly owner: AssetOwner;
  readonly sessionId: string;
}): Promise<string> {
  const assetId = `asset_${randomUUID()}`;
  const upload = await input.assetStore.createUpload({
    assetId,
    expiresAt: input.expiresAt,
    filename: input.filename,
    mediaType: input.mediaType,
    owner: input.owner,
    sessionId: publicationSessionId(input.sessionId),
    sizeBytes: input.content.byteLength,
  });
  try {
    const parts = [];
    for (let offset = 0, partNumber = 1; offset < input.content.byteLength; partNumber += 1) {
      const end = Math.min(offset + upload.chunkSizeBytes, input.content.byteLength);
      parts.push(await input.assetStore.writePart({
        content: input.content.subarray(offset, end),
        owner: input.owner,
        partNumber,
        uploadId: upload.uploadId,
      }));
      offset = end;
    }
    const asset = await input.assetStore.completeUpload({
      owner: input.owner,
      parts,
      uploadId: upload.uploadId,
    });
    if (asset.scanStatus !== "clean" && asset.scanStatus !== "disabled") {
      await input.assetStore.deleteAsset({ assetId, owner: input.owner }).catch(() => undefined);
      throw new Error("The published file did not pass the configured asset scan.");
    }
    return assetId;
  } catch (error) {
    await input.assetStore.abortUpload({ owner: input.owner, uploadId: upload.uploadId }).catch(() => undefined);
    await input.assetStore.deleteAsset({ assetId, owner: input.owner }).catch(() => undefined);
    throw error;
  }
}

function publicationSessionId(sessionId: string): string {
  return `publication-${createHash("sha256").update(sessionId).digest("hex")}`;
}

export async function readPublicationObject(input: {
  readonly assetId: string;
  readonly assetStore: AssetStore;
  readonly maximumBytes: number;
  readonly owner: AssetOwner;
}): Promise<Uint8Array | undefined> {
  const download = await input.assetStore.openReadStream(input.assetId, input.owner);
  if (!download) return undefined;
  if (download.contentLength > input.maximumBytes) {
    await download.stream.cancel().catch(() => undefined);
    throw new Error("The publication object exceeds its persisted size limit.");
  }
  const reader = download.stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > input.maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("The publication object exceeded its persisted size limit while reading.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

export async function deletePublicationObjects(
  assetStore: AssetStore,
  assetIds: readonly string[],
  owner: AssetOwner,
): Promise<void> {
  await Promise.all(assetIds.map((assetId) => assetStore.deleteAsset({ assetId, owner })));
}
