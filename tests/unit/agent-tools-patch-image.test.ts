import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import applyPatchTool, {
  applyUpdateText,
  countLines,
  parsePatch,
  workspacePath,
} from "../../agent/tools/apply_patch.ts";
import viewImageTool, {
  assertVisionCapability,
  detectMediaType,
  MAX_VIEW_IMAGE_BYTES,
  normalizeWorkspacePath,
  readBoundedImage,
} from "../../agent/tools/view_image.ts";
import { assertAssetSession } from "../../agent/tools/import_asset.ts";
import {
  configureAssetStore,
  createFilesystemAssetStore,
} from "../../server/data/asset-store.ts";

test("apply_patch parses and applies multiple hunks without collapsing contexts", () => {
  const patch = `*** Begin Patch
*** Update File: src/example.txt
@@ -1,2 +1,3 @@
 alpha
-beta
+beta changed
+inserted
@@ -5,2 +6,2 @@
 epsilon
-zeta
+zeta changed
*** End Patch
`;
  const [operation] = parsePatch(patch);
  assert.equal(operation?.kind, "update");
  if (!operation || operation.kind !== "update") throw new Error("expected update");
  const result = applyUpdateText("alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n", operation.hunks);
  assert.equal(result.content, "alpha\nbeta changed\ninserted\ngamma\ndelta\nepsilon\nzeta changed\n");
  assert.equal(result.addedLines, 3);
  assert.equal(result.deletedLines, 2);
});

test("apply_patch rejects stale and ambiguous contexts", () => {
  assert.throws(
    () => applyUpdateText("same\nsame\n", [{ lines: [" same", "+changed"] }]),
    /ambiguous/,
  );
  assert.throws(
    () => applyUpdateText("current\n", [{ lines: [" old", "+new"] }]),
    /context does not match/,
  );
});

test("apply_patch enforces envelope, hunk counts, and workspace-only paths", () => {
  assert.throws(() => workspacePath("../escape"), /workspace|traversal/);
  assert.throws(() => parsePatch("*** Begin Patch\n*** Update File: file\n@@ -1,2 +1,1 @@\n old\n+new\n*** End Patch"), /old-line count/);
  assert.throws(() => parsePatch("garbage\n*** Begin Patch\n*** Add File: file\n+x\n*** End Patch"), /outside/);
  assert.throws(() => normalizeWorkspacePath("/workspace/../secret"), /workspace|traversal/);
});

test("apply_patch reports physical line changes, not net file length", () => {
  const patch = parsePatch(`*** Begin Patch
*** Add File: notes.txt
+one
+two
*** End Patch`);
  assert.equal(patch[0]?.kind, "add");
  assert.equal(countLines("one\ntwo\n"), 2);
  assert.equal(countLines(""), 0);
});

test("apply_patch preflights all operations before committing", async () => {
  const files = new Map([["/workspace/existing.txt", "before\n"]]);
  const writes: string[] = [];
  const sandbox = {
    async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; },
    async writeTextFile({ path, content }: { path: string; content: string }) { writes.push(path); files.set(path, content); },
    async removePath() {},
    async run() { return { exitCode: 0, stdout: "", stderr: "" }; },
  };
  const context = { getSandbox: async () => sandbox } as never;
  await assert.rejects(
    () => (applyPatchTool as unknown as { execute(input: { patch: string }, context: unknown): Promise<unknown> }).execute({
      patch: `*** Begin Patch
*** Update File: existing.txt
@@ -1 +1 @@
-before
+after
*** Add File: existing.txt
+duplicate
*** End Patch`,
    }, context),
    /already exists/,
  );
  assert.deepEqual(writes, []);
  assert.equal(files.get("/workspace/existing.txt"), "before\n");
});

test("apply_patch uses same-directory atomic rename and returns unique file count", async () => {
  const files = new Map([["/workspace/example.txt", "before\n"]]);
  const commands: string[] = [];
  const sandbox = {
    async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; },
    async writeTextFile({ path, content }: { path: string; content: string }) { files.set(path, content); },
    async removePath({ path }: { path: string }) { files.delete(path); },
    async run({ command }: { command: string }) {
      commands.push(command);
      const match = /^mv -f -- '([^']+)' '([^']+)'$/u.exec(command);
      if (match) {
        const content = files.get(match[1]!);
        if (content !== undefined) {
          files.set(match[2]!, content);
          files.delete(match[1]!);
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const result = await (applyPatchTool as unknown as { execute(input: { patch: string }, context: unknown): Promise<{ filesChanged: number; totalAddedLines: number; totalDeletedLines: number }> }).execute({
    patch: `*** Begin Patch
*** Update File: example.txt
@@ -1 +1 @@
-before
+after
@@ -1 +1 @@
-after
+final
*** End Patch`,
  }, { getSandbox: async () => sandbox } as never);
  assert.equal(files.get("/workspace/example.txt"), "final\n");
  assert.equal(result.filesChanged, 1);
  assert.equal(result.totalAddedLines, 2);
  assert.equal(result.totalDeletedLines, 2);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.startsWith("mv -f -- '/workspace/.example.txt.open-agent-"), true);
  assert.equal(commands[0]?.endsWith(".tmp' '/workspace/example.txt'"), true);
});

test("view_image detects supported signatures and rejects traversal", () => {
  assert.equal(detectMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "x.png"), "image/png");
  assert.equal(detectMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), "x.jpg"), "image/jpeg");
  assert.equal(detectMediaType(new TextEncoder().encode("<svg viewBox=\"0 0 1 1\"></svg>"), "x.svg"), "image/svg+xml");
  assert.throws(() => normalizeWorkspacePath("../../etc/passwd"), /workspace|traversal/);
});

test("import_asset enforces the durable session boundary", () => {
  assert.doesNotThrow(() => assertAssetSession("session-a", "session-a"));
  assert.throws(() => assertAssetSession("session-a", "session-b"), /different Agent session/);
});

test("view_image honors an explicit host model capability denial", () => {
  assert.throws(
    () => assertVisionCapability({ session: { auth: { current: { attributes: { agentVisionEnabled: false } } } } }),
    /does not support image input/,
  );
});

test("view_image resizes oversized images and emits a typed file output", async () => {
  const source = new Uint8Array(MAX_VIEW_IMAGE_BYTES + 17);
  source.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const resized = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]);
  const sandbox = {
    async readFile() {
      return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(source); controller.close(); } });
    },
    async run({ command }: { command: string }) {
      if (command.startsWith("stat -c %s")) return { exitCode: 0, stdout: String(source.byteLength), stderr: "" };
      assert.match(command, /set -eu; if command -v magick/);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async readBinaryFile() { return resized; },
    async removePath() {},
  };
  const bounded = await readBoundedImage(sandbox as never, "/workspace/large.png");
  assert.equal(bounded?.oversized, true);
  assert.equal(bounded?.bytes.byteLength, MAX_VIEW_IMAGE_BYTES);
  const context = { getSandbox: async () => sandbox, abortSignal: new AbortController().signal, session: { auth: { current: null } } } as never;
  const output = await (viewImageTool as unknown as { execute(input: { path: string }, context: unknown): Promise<{ resized: boolean; mediaType: string; bytes: number }> }).execute({ path: "large.png" }, context);
  assert.equal(output.resized, true);
  assert.equal(output.mediaType, "image/jpeg");
  assert.equal(output.bytes, resized.byteLength);
  assert.equal("dataBase64" in output, false);
  assert.equal(JSON.stringify(output).includes(Buffer.from(resized).toString("base64")), false);
  const projected = (viewImageTool as unknown as { toModelOutput(value: typeof output): { type: string; value?: readonly { type: string; [key: string]: unknown }[] } }).toModelOutput(output);
  assert.equal(projected.type, "content");
  assert.equal(projected.value?.some((part) => part.type === "file"), true);
  assert.throws(
    () => (viewImageTool as unknown as { toModelOutput(value: typeof output): unknown }).toModelOutput(output),
    /no longer available/,
  );
});

test("view_image persists an authenticated UI preview while keeping bytes private", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-agent-view-image-"));
  try {
    const store = createFilesystemAssetStore({ root });
    configureAssetStore(store);
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const sandbox = {
      async readFile() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      },
    };
    const owner = {
      principalId: "view-image-user",
      principalType: "user",
      tenantId: "view-image-tenant",
    };
    const context = {
      getSandbox: async () => sandbox,
      session: {
        auth: {
          current: {
            attributes: { tenantId: owner.tenantId },
            principalId: owner.principalId,
            principalType: owner.principalType,
          },
        },
        id: "view-image-session",
      },
    };
    const output = await (viewImageTool as unknown as {
      execute(input: { path: string }, context: unknown): Promise<{ assetId?: string; bytes: number }>;
    }).execute({ path: "reference.png" }, context);
    assert.ok(output.assetId);
    assert.equal("dataBase64" in output, false);
    const asset = await store.findAsset(output.assetId, owner);
    assert.equal(asset?.sessionId, "view-image-session");
    assert.equal(asset?.mediaType, "image/png");
    assert.equal(asset?.sizeBytes, bytes.byteLength);
    (viewImageTool as unknown as { toModelOutput(value: typeof output): unknown }).toModelOutput(output);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
