import assert from "node:assert/strict";
import test from "node:test";
import type { PendingAttachment } from "@assistant-ui/react";
import { createBrowserAttachmentAdapter } from "../../packages/agent-ui/src/agent-workspace/browser-asset-upload.ts";

test("browser attachment uploads expose progress and send only an asset reference", async () => {
  const adapter = createBrowserAttachmentAdapter({
    async upload({ file, onProgress, signal }) {
      assert.equal(signal.aborted, false);
      onProgress({ totalBytes: file.size, uploadedBytes: Math.floor(file.size / 2) });
      onProgress({ totalBytes: file.size, uploadedBytes: file.size });
      return {
        assetId: "asset-1",
        filename: file.name,
        mediaType: file.type,
        sizeBytes: file.size,
      };
    },
  }, () => "session-1");
  const file = new File([new Uint8Array([1, 2, 3, 4])], "sample.png", { type: "image/png" });
  const added = adapter.add({ file });
  assert.ok(Symbol.asyncIterator in added);
  const snapshots: PendingAttachment[] = [];
  for await (const snapshot of added as AsyncGenerator<PendingAttachment, void>) snapshots.push(snapshot);
  assert.equal(snapshots[0]?.status.type, "running");
  assert.ok(snapshots.some((snapshot) => snapshot.status.type === "running" && snapshot.status.progress === 100));
  const ready = snapshots.at(-1);
  assert.equal(ready?.status.type, "requires-action");
  assert.ok(ready);
  const sent = await adapter.send(ready);
  assert.deepEqual(sent.content, [{
    data: "asset://asset-1",
    filename: "sample.png",
    mimeType: "image/png",
    type: "file",
  }]);
  assert.equal(JSON.stringify(sent).includes("data:image"), false);
});

test("removing a completed Composer attachment delegates asset cleanup", async () => {
  let removedAssetId: string | undefined;
  const adapter = createBrowserAttachmentAdapter({
    async upload({ file }) {
      return { assetId: "asset-remove", filename: file.name, mediaType: file.type, sizeBytes: file.size };
    },
    async remove(asset) {
      removedAssetId = asset.assetId;
    },
  }, () => undefined);
  const added = adapter.add({ file: new File(["x"], "sample.txt", { type: "text/plain" }) });
  let ready: PendingAttachment | undefined;
  for await (const snapshot of added as AsyncGenerator<PendingAttachment, void>) ready = snapshot;
  assert.ok(ready);
  await adapter.remove(ready);
  assert.equal(removedAssetId, "asset-remove");
});
