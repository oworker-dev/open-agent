import type { AssetMetadata, AssetOwner, AssetStore } from "@oworker/open-agent-contracts/asset";
import { createArtifactToken, createPreviewToken, readPreviewSigningSecret } from "../../lib/preview-token.ts";
import { createArtifactStoreFromEnvironment, type ArtifactRecord, type ArtifactStore } from "./artifact-store.ts";
import { createAssetStoreFromEnvironment } from "./asset-store.ts";
import { createPreviewStoreFromEnvironment, type PreviewRecord, type PreviewStore } from "./preview-store.ts";

export type SessionDeliverable = {
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly fileCount?: number;
  readonly id: string;
  readonly kind: "artifact" | "asset" | "website-preview";
  readonly mediaType?: string;
  readonly sizeBytes: number;
  readonly title: string;
  readonly url: string;
};

export interface SessionDeliverableRegistry {
  list(sessionId: string, owner: AssetOwner): Promise<readonly SessionDeliverable[]>;
}

export function createSessionDeliverableRegistryFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SessionDeliverableRegistry {
  return createSessionDeliverableRegistry({
    artifactStore: createArtifactStoreFromEnvironment(environment),
    assetStore: createAssetStoreFromEnvironment(environment),
    previewStore: createPreviewStoreFromEnvironment(environment),
    signingSecret: readPreviewSigningSecret(environment),
  });
}

export function createSessionDeliverableRegistry({
  artifactStore,
  assetStore,
  previewStore,
  signingSecret = readPreviewSigningSecret(),
}: {
  readonly artifactStore: ArtifactStore;
  readonly assetStore: AssetStore;
  readonly previewStore: PreviewStore;
  readonly signingSecret?: string;
}): SessionDeliverableRegistry {
  return {
    async list(sessionId, owner) {
      assertListInput(sessionId, owner);
      const [assets, artifacts, previews] = await Promise.all([
        assetStore.listAssets?.(sessionId, owner) ?? Promise.resolve([]),
        artifactStore.list(sessionId, owner),
        previewStore.list(sessionId, owner),
      ]);
      return [
        ...assets.map(assetDeliverable),
        ...artifacts.map((artifact) => artifactDeliverable(artifact, signingSecret)),
        ...previews.map((preview) => previewDeliverable(preview, signingSecret)),
      ]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 400);
    },
  };
}

function assetDeliverable(asset: AssetMetadata): SessionDeliverable {
  return {
    createdAt: asset.createdAt,
    ...(asset.expiresAt ? { expiresAt: asset.expiresAt } : {}),
    id: asset.assetId,
    kind: "asset",
    mediaType: asset.mediaType,
    sizeBytes: asset.sizeBytes,
    title: asset.filename,
    url: `/api/assets/${encodeURIComponent(asset.assetId)}`,
  };
}

function artifactDeliverable(artifact: ArtifactRecord, signingSecret: string): SessionDeliverable {
  const token = createArtifactToken(artifact.artifactId, new Date(artifact.expiresAt), signingSecret);
  return {
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
    id: artifact.artifactId,
    kind: "artifact",
    mediaType: artifact.mediaType,
    sizeBytes: artifact.totalBytes,
    title: artifact.filename,
    url: `/api/artifacts/${encodeURIComponent(artifact.artifactId)}?token=${encodeURIComponent(token)}`,
  };
}

function previewDeliverable(preview: PreviewRecord, signingSecret: string): SessionDeliverable {
  const token = createPreviewToken(preview.previewId, new Date(preview.expiresAt), signingSecret);
  return {
    createdAt: preview.createdAt,
    expiresAt: preview.expiresAt,
    fileCount: preview.fileCount,
    id: preview.previewId,
    kind: "website-preview",
    mediaType: "text/html; charset=utf-8",
    sizeBytes: preview.totalBytes,
    title: preview.entrypoint,
    url: `/api/previews/${encodeURIComponent(preview.previewId)}/${encodePath(preview.entrypoint)}?token=${encodeURIComponent(token)}`,
  };
}

function assertListInput(sessionId: string, owner: AssetOwner): void {
  if (!sessionId.trim() || sessionId.length > 512 || !owner.tenantId || !owner.principalId) {
    throw new Error("A deliverable list requires a valid session and authenticated owner.");
  }
}

function encodePath(value: string): string {
  return value.split("/").map((part) => encodeURIComponent(part)).join("/");
}
