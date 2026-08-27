import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFilesystemAssetStore } from "../../server/data/asset-store.ts";
import {
  readPublicationObject,
  writePublicationObject,
} from "../../server/data/publication-object.ts";

const owner = { principalId: "user-1", tenantId: "tenant-1" };

test("publication objects use AssetStore bytes without appearing as duplicate session assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-publication-"));
  try {
    const assetStore = createFilesystemAssetStore({ root, scanMode: "disabled" });
    const assetId = await writePublicationObject({
      assetStore,
      content: new TextEncoder().encode("hello"),
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      filename: "result.txt",
      mediaType: "text/plain; charset=utf-8",
      owner,
      sessionId: "session-1",
    });

    assert.deepEqual(await readPublicationObject({
      assetId,
      assetStore,
      maximumBytes: 5,
      owner,
    }), new TextEncoder().encode("hello"));
    assert.deepEqual(await assetStore.listAssets?.("session-1", owner), []);
    await assert.rejects(
      () => readPublicationObject({ assetId, assetStore, maximumBytes: 4, owner }),
      /exceeds its persisted size limit/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
