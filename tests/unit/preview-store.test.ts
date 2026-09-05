import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPreviewStoreFromEnvironment } from "../../server/data/preview-store.ts";

test("filesystem preview cleanup removes expired trees and retains live previews", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-previews-"));
  try {
    const store = createPreviewStoreFromEnvironment({ AGENT_PREVIEW_STORAGE_PATH: root });
    const common = {
      alias: "Marketing site",
      entrypoint: "index.html",
      files: [{ content: new TextEncoder().encode("<h1>ok</h1>"), mediaType: "text/html", path: "index.html" }],
      principalId: "user-1",
      sessionId: "session-1",
      tenantId: "tenant-1",
      version: "2",
    } as const;
    const expired = await store.create({ ...common, expiresAt: new Date("2030-01-01T00:00:00.000Z") });
    const retained = await store.create({ ...common, expiresAt: new Date("2031-01-01T00:00:00.000Z") });

    assert.equal(await store.cleanupExpired?.({ now: new Date("2030-06-01T00:00:00.000Z") }), 1);
    assert.equal(await store.find(expired.previewId), undefined);
    const reloaded = await store.find(retained.previewId);
    assert.equal(reloaded?.alias, "Marketing site");
    assert.equal(reloaded?.version, "2");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem preview cleanup stops directory processing at the requested batch limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-previews-"));
  try {
    const store = createPreviewStoreFromEnvironment({ AGENT_PREVIEW_STORAGE_PATH: root });
    const common = {
      entrypoint: "index.html",
      files: [{ content: new TextEncoder().encode("<h1>expired</h1>"), mediaType: "text/html", path: "index.html" }],
      principalId: "user-1",
      sessionId: "session-batch",
      tenantId: "tenant-1",
    } as const;
    const first = await store.create({ ...common, expiresAt: new Date("2030-01-01T00:00:00.000Z") });
    const second = await store.create({ ...common, expiresAt: new Date("2030-01-01T00:00:00.000Z") });

    assert.equal(await store.cleanupExpired?.({ limit: 1, now: new Date("2030-06-01T00:00:00.000Z") }), 1);
    assert.equal((await store.find(first.previewId)) === undefined || (await store.find(second.previewId)) === undefined, true);
    assert.equal(await store.cleanupExpired?.({ limit: 1, now: new Date("2030-06-01T00:00:00.000Z") }), 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("preview persistence rejects aggregate bodies over 25 MiB before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-previews-"));
  try {
    const store = createPreviewStoreFromEnvironment({ AGENT_PREVIEW_STORAGE_PATH: root });
    await assert.rejects(
      () => store.create({
        entrypoint: "one.bin",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        files: [
          { content: new Uint8Array(10 * 1024 * 1024), mediaType: "application/octet-stream", path: "one.bin" },
          { content: new Uint8Array(10 * 1024 * 1024), mediaType: "application/octet-stream", path: "two.bin" },
          { content: new Uint8Array(6 * 1024 * 1024), mediaType: "application/octet-stream", path: "three.bin" },
        ],
        principalId: "user-1",
        sessionId: "session-1",
        tenantId: "tenant-1",
      }),
      /25 MiB/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
