import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureAssetStore,
  createFilesystemAssetStore,
} from "../../server/data/asset-store.ts";
import importAssetTool from "../../agent/tools/import_asset.ts";

const owner = { principalId: "user-1", tenantId: "tenant-1" };

test("import_asset streams a persisted upload into the current Eve workspace and binds browser uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-asset-tool-"));
  try {
    const store = createFilesystemAssetStore({ root });
    configureAssetStore(store);
    const upload = await store.createUpload({
      filename: "reference.txt",
      mediaType: "text/plain",
      owner,
      sessionId: "browser-tab-1",
      sizeBytes: 3,
    });
    await store.writePart({ content: new TextEncoder().encode("abc"), owner, partNumber: 1, uploadId: upload.uploadId });
    const asset = await store.completeUpload({ owner, uploadId: upload.uploadId });
    const writes: Array<{ content: Uint8Array; path: string }> = [];
    const commands: string[] = [];
    const sandbox = {
      async writeFile({ content, path }: { content: ReadableStream<Uint8Array>; path: string }) {
        writes.push({ content: await readStream(content), path });
      },
      async run({ command }: { command: string }) {
        commands.push(command);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    const context = {
      getSandbox: async () => sandbox,
      session: {
        auth: {
          current: {
            attributes: { tenantId: owner.tenantId },
            principalId: owner.principalId,
            principalType: "user",
          },
        },
        id: "session-real",
      },
    };
    const result = await (importAssetTool as unknown as {
      execute(input: { assetId: string; destination: string }, context: unknown): Promise<{ path: string; sessionId: string; bytes: number }>;
    }).execute({ assetId: asset.assetId, destination: ".open-agent/assets/" }, context);
    assert.equal(result.path, "/workspace/.open-agent/assets/reference.txt");
    assert.equal(result.sessionId, "session-real");
    assert.equal(result.bytes, 3);
    assert.deepEqual(writes, [{ path: "/workspace/.open-agent/assets/reference.txt", content: new TextEncoder().encode("abc") }]);
    assert.equal(commands.length, 1);
    assert.match(commands[0]!, /chmod a-w/);
    assert.equal((await store.findAsset(asset.assetId, owner))?.sessionId, "session-real");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("import_asset rejects a ready asset already bound to another Agent session", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-asset-tool-"));
  try {
    const store = createFilesystemAssetStore({ root });
    configureAssetStore(store);
    const upload = await store.createUpload({
      filename: "private.txt",
      mediaType: "text/plain",
      owner,
      sessionId: "session-a",
      sizeBytes: 1,
    });
    await store.writePart({ content: new Uint8Array([0x41]), owner, partNumber: 1, uploadId: upload.uploadId });
    const asset = await store.completeUpload({ owner, uploadId: upload.uploadId });
    await assert.rejects(
      () => (importAssetTool as unknown as { execute(input: { assetId: string }, context: unknown): Promise<unknown> }).execute(
        { assetId: asset.assetId },
        {
          getSandbox: async () => ({ writeFile: async () => undefined }),
          session: {
            auth: {
              current: {
                attributes: { tenantId: owner.tenantId },
                principalId: owner.principalId,
                principalType: "user",
              },
            },
            id: "session-b",
          },
        },
      ),
      /different Agent session/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("import_asset rejects an asset whose content scan is not clean", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-asset-tool-"));
  try {
    const store = createFilesystemAssetStore({
      root,
      scanner: {
        async scan() {
          return { status: "rejected" as const };
        },
      },
      scanMode: "required",
    });
    configureAssetStore(store);
    const upload = await store.createUpload({
      filename: "unsafe.txt",
      mediaType: "text/plain",
      owner,
      sessionId: "session-a",
      sizeBytes: 1,
    });
    await store.writePart({ content: new Uint8Array([0x41]), owner, partNumber: 1, uploadId: upload.uploadId });
    const asset = await store.completeUpload({ owner, uploadId: upload.uploadId });
    assert.equal(asset.scanStatus, "rejected");
    assert.equal(await store.openReadStream(asset.assetId, owner), undefined);
    await assert.rejects(
      () => (importAssetTool as unknown as { execute(input: { assetId: string }, context: unknown): Promise<unknown> }).execute(
        { assetId: asset.assetId },
        {
          getSandbox: async () => ({ writeFile: async () => undefined }),
          session: {
            auth: {
              current: {
                attributes: { tenantId: owner.tenantId },
                principalId: owner.principalId,
                principalType: "user",
              },
            },
            id: "session-a",
          },
        },
      ),
      /content scan completes/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
