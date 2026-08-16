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
import importRemoteAssetTool from "../../agent/tools/import_remote_asset.ts";

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
    const files = new Map<string, string | Uint8Array>();
    const sandbox = {
      id: "session-real",
      async readTextFile({ path }: { path: string }) {
        const value = files.get(path);
        return typeof value === "string" ? value : null;
      },
      async writeTextFile({ content, path }: { content: string; path: string }) {
        files.set(path, content);
      },
      async writeFile({ content, path }: { content: ReadableStream<Uint8Array>; path: string }) {
        const bytes = await readStream(content);
        writes.push({ content: bytes, path });
        files.set(path, bytes);
      },
      async removePath({ path }: { path: string }) {
        files.delete(path);
      },
      async run({ command }: { command: string }) {
        commands.push(command);
        const match = /^mv -f -- '([^']+)' '([^']+)'$/u.exec(command);
        if (match) {
          const value = files.get(match[1]!);
          if (value !== undefined) {
            files.set(match[2]!, value);
            files.delete(match[1]!);
          }
        }
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
    assert.equal(writes.length, 1);
    assert.deepEqual(files.get("/workspace/.open-agent/assets/reference.txt"), new TextEncoder().encode("abc"));
    assert.match(commands.at(-1)!, /chmod a-w/);
    assert.match(String(files.get("/workspace/.open-agent/imported-assets.json")), /"state":"ready"/u);
    assert.equal((await store.findAsset(asset.assetId, owner))?.sessionId, "session-real");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("import_asset rejects materialization that exceeds the per-session workspace quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-asset-tool-quota-"));
  const previousQuota = process.env.AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES;
  process.env.AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES = "2";
  try {
    const store = createFilesystemAssetStore({ root });
    configureAssetStore(store);
    const upload = await store.createUpload({
      filename: "large.txt",
      mediaType: "text/plain",
      owner,
      sessionId: "browser-tab-quota",
      sizeBytes: 3,
    });
    await store.writePart({ content: new TextEncoder().encode("abc"), owner, partNumber: 1, uploadId: upload.uploadId });
    const asset = await store.completeUpload({ owner, uploadId: upload.uploadId });
    const writes: string[] = [];
    await assert.rejects(
      () => (importAssetTool as unknown as { execute(input: { assetId: string; destination: string }, context: unknown): Promise<unknown> }).execute(
        { assetId: asset.assetId, destination: ".open-agent/assets/" },
        {
          getSandbox: async () => ({
            id: "session-quota",
            async readTextFile() { return null; },
            async writeTextFile() {},
            async writeFile() { writes.push("write"); },
            async removePath() {},
            async run() { return { exitCode: 0, stderr: "", stdout: "" }; },
          }),
          session: {
            auth: {
              current: {
                attributes: { tenantId: owner.tenantId },
                principalId: owner.principalId,
                principalType: "user",
              },
            },
            id: "session-quota",
          },
        },
      ),
      /workspace import quota/u,
    );
    assert.deepEqual(writes, []);
  } finally {
    if (previousQuota === undefined) delete process.env.AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES;
    else process.env.AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES = previousQuota;
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

test("import_remote_asset streams a bounded remote body into session storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-remote-asset-tool-"));
  const originalFetch = globalThis.fetch;
  try {
    const store = createFilesystemAssetStore({ root });
    configureAssetStore(store);
    globalThis.fetch = async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      headers: {
        "content-length": "4",
        "content-type": "image/png",
      },
      status: 200,
    });
    const context = {
      abortSignal: new AbortController().signal,
      session: {
        auth: {
          current: {
            attributes: { tenantId: owner.tenantId },
            principalId: owner.principalId,
            principalType: "user",
          },
        },
        id: "session-remote",
      },
    };
    const result = await (importRemoteAssetTool as unknown as {
      execute(input: { url: string }, context: unknown): Promise<{
        assetId: string;
        bytes: number;
        filename: string;
        mediaType: string;
        sessionId: string;
        sourceUrl: string;
      }>;
    }).execute({ url: "https://1.1.1.1/assets/reference.png" }, context);
    assert.equal(result.bytes, 4);
    assert.equal(result.filename, "reference.png");
    assert.equal(result.mediaType, "image/png");
    assert.equal(result.sessionId, "session-remote");
    assert.equal(result.sourceUrl, "https://1.1.1.1/assets/reference.png");
    const metadata = await store.findAsset(result.assetId, owner);
    assert.equal(metadata?.sizeBytes, 4);
    assert.equal(metadata?.sessionId, "session-remote");
    const download = await store.openReadStream(result.assetId, owner);
    assert.ok(download);
    assert.deepEqual(await readStream(download.stream), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { force: true, recursive: true });
  }
});

test("import_remote_asset rejects a response without Content-Length before reserving storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-remote-asset-tool-"));
  const originalFetch = globalThis.fetch;
  try {
    const store = createFilesystemAssetStore({ root });
    configureAssetStore(store);
    globalThis.fetch = async () => new Response("remote body", {
      headers: { "content-type": "text/plain" },
      status: 200,
    });
    await assert.rejects(
      () => (importRemoteAssetTool as unknown as { execute(input: { url: string }, context: unknown): Promise<unknown> }).execute(
        { url: "https://1.1.1.1/assets/reference.txt" },
        {
          abortSignal: new AbortController().signal,
          session: {
            auth: {
              current: {
                attributes: { tenantId: owner.tenantId },
                principalId: owner.principalId,
                principalType: "user",
              },
            },
            id: "session-remote",
          },
        },
      ),
      /Content-Length/u,
    );
    assert.deepEqual(await store.listAssets?.("session-remote", owner), []);
  } finally {
    globalThis.fetch = originalFetch;
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
