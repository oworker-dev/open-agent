import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssetStore } from "@oworker/open-agent-contracts/asset";
import { verifyArtifactToken, verifyPreviewToken } from "../../lib/preview-token.ts";
import { createArtifactStoreFromEnvironment } from "../../server/data/artifact-store.ts";
import { createPreviewStoreFromEnvironment } from "../../server/data/preview-store.ts";
import { createSessionDeliverableRegistry } from "../../server/data/session-deliverable-registry.ts";

const owner = { principalId: "user-1", principalType: "user", tenantId: "tenant-1" } as const;
const secret = "deliverable-registry-signing-secret-over-32-characters";
const expiresAt = new Date("2030-01-01T00:00:00.000Z");

test("session deliverable registry unifies uploads, artifacts, and website previews", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-deliverables-"));
  try {
    const artifactStore = createArtifactStoreFromEnvironment({ AGENT_ARTIFACT_STORAGE_PATH: join(root, "artifacts") });
    const previewStore = createPreviewStoreFromEnvironment({ AGENT_PREVIEW_STORAGE_PATH: join(root, "previews") });
    await artifactStore.create({
      artifactId: "art_123e4567-e89b-12d3-a456-426614174000",
      content: new TextEncoder().encode("# Delivered report"),
      expiresAt,
      filename: "report.md",
      mediaType: "text/markdown; charset=utf-8",
      principalId: owner.principalId,
      sessionId: "session-1",
      tenantId: owner.tenantId,
    });
    await artifactStore.create({
      artifactId: "art_123e4567-e89b-12d3-a456-426614174001",
      content: new TextEncoder().encode("private"),
      expiresAt,
      filename: "other.txt",
      mediaType: "text/plain; charset=utf-8",
      principalId: "user-2",
      sessionId: "session-1",
      tenantId: owner.tenantId,
    });
    await previewStore.create({
      entrypoint: "index.html",
      expiresAt,
      files: [{ content: new TextEncoder().encode("<!doctype html><title>Site</title>"), mediaType: "text/html; charset=utf-8", path: "index.html" }],
      previewId: "prv_123e4567-e89b-12d3-a456-426614174000",
      principalId: owner.principalId,
      sessionId: "session-1",
      tenantId: owner.tenantId,
    });
    const assetStore = {
      async listAssets(sessionId: string) {
        return sessionId === "session-1" ? [{
          assetId: "asset_123e4567-e89b-12d3-a456-426614174000",
          createdAt: "2029-01-01T00:00:00.000Z",
          filename: "reference.png",
          mediaType: "image/png",
          principalId: owner.principalId,
          sessionId,
          sizeBytes: 512,
          status: "ready" as const,
          storageKey: "assets/reference.png",
          tenantId: owner.tenantId,
        }] : [];
      },
    } as unknown as AssetStore;
    const registry = createSessionDeliverableRegistry({ artifactStore, assetStore, previewStore, signingSecret: secret });

    const deliverables = await registry.list("session-1", owner);
    assert.deepEqual(deliverables.map((item) => item.kind).sort(), ["artifact", "asset", "website-preview"]);
    assert.equal(deliverables.some((item) => item.title === "other.txt"), false);

    const artifact = deliverables.find((item) => item.kind === "artifact");
    assert.ok(artifact);
    const artifactUrl = new URL(artifact.url, "https://agent.test");
    assert.deepEqual(
      verifyArtifactToken(artifactUrl.searchParams.get("token") ?? "", artifact.id, new Date("2029-01-01T00:00:00.000Z"), secret),
      { artifactId: artifact.id, expiresAt: expiresAt.toISOString() },
    );

    const preview = deliverables.find((item) => item.kind === "website-preview");
    assert.ok(preview);
    const previewUrl = new URL(preview.url, "https://agent.test");
    assert.deepEqual(
      verifyPreviewToken(previewUrl.searchParams.get("token") ?? "", preview.id, new Date("2029-01-01T00:00:00.000Z"), secret),
      { previewId: preview.id, expiresAt: expiresAt.toISOString() },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication stores isolate lists by session and owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-publications-"));
  try {
    const artifactStore = createArtifactStoreFromEnvironment({ AGENT_ARTIFACT_STORAGE_PATH: join(root, "artifacts") });
    const previewStore = createPreviewStoreFromEnvironment({ AGENT_PREVIEW_STORAGE_PATH: join(root, "previews") });
    await artifactStore.create({
      content: new TextEncoder().encode("one"),
      expiresAt,
      filename: "one.txt",
      mediaType: "text/plain",
      principalId: owner.principalId,
      sessionId: "session-1",
      tenantId: owner.tenantId,
    });
    await previewStore.create({
      entrypoint: "index.html",
      expiresAt,
      files: [{ content: new TextEncoder().encode("site"), mediaType: "text/html", path: "index.html" }],
      principalId: owner.principalId,
      sessionId: "session-1",
      tenantId: owner.tenantId,
    });

    assert.equal((await artifactStore.list("session-1", owner)).length, 1);
    assert.equal((await artifactStore.list("session-2", owner)).length, 0);
    assert.equal((await artifactStore.list("session-1", { ...owner, principalId: "user-2" })).length, 0);
    assert.equal((await previewStore.list("session-1", owner)).length, 1);
    assert.equal((await previewStore.list("session-2", owner)).length, 0);
    assert.equal((await previewStore.list("session-1", { ...owner, tenantId: "tenant-2" })).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
