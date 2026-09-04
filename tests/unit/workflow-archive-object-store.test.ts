import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import {
  createWorkflowArchiveObjectStoreWithClient,
  readWorkflowArchiveObjectStoreConfig,
  workflowArchiveObjectKey,
} from "../../server/data/workflow-archive-object-store.ts";

test("workflow archive object keys hide provider run ids and remain stable", () => {
  const first = workflowArchiveObjectKey("workflow-archives/v2/", "wrun_secret_root");
  const second = workflowArchiveObjectKey("/workflow-archives/v2", "wrun_secret_root");
  assert.equal(first, second);
  assert.match(first, /^workflow-archives\/v2\/[a-f0-9]{2}\/[a-f0-9]{64}\.ndjson$/u);
  assert.equal(first.includes("secret"), false);
});

test("workflow archive S3 config uses dedicated values before asset fallbacks", () => {
  const fallback = readWorkflowArchiveObjectStoreConfig({
    AGENT_ASSET_S3_ACCESS_KEY_ID: "asset-key",
    AGENT_ASSET_S3_BUCKET: "assets",
    AGENT_ASSET_S3_SECRET_ACCESS_KEY: "asset-secret",
  });
  assert.equal(fallback.bucket, "assets");
  const dedicated = readWorkflowArchiveObjectStoreConfig({
    AGENT_ASSET_S3_ACCESS_KEY_ID: "asset-key",
    AGENT_ASSET_S3_BUCKET: "assets",
    AGENT_ASSET_S3_SECRET_ACCESS_KEY: "asset-secret",
    WORKFLOW_ARCHIVE_S3_ACCESS_KEY_ID: "archive-key",
    WORKFLOW_ARCHIVE_S3_BUCKET: "archives",
    WORKFLOW_ARCHIVE_S3_SECRET_ACCESS_KEY: "archive-secret",
  });
  assert.equal(dedicated.accessKeyId, "archive-key");
  assert.equal(dedicated.bucket, "archives");
});

test("workflow archive upload is idempotent and verifies the remote body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-archive-object-test-"));
  const path = join(directory, "archive.ndjson");
  const content = Buffer.from("archive body\n");
  await writeFile(path, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const manifestSha256 = "a".repeat(64);
  let stored: Buffer | undefined;
  let metadata: Record<string, string> | undefined;
  let puts = 0;
  const client = {
    destroy() {},
    async send(command: unknown) {
      if (command instanceof HeadObjectCommand) {
        if (!stored) throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
        return { ContentLength: stored.byteLength, Metadata: metadata };
      }
      if (command instanceof PutObjectCommand) {
        const body = command.input.Body as AsyncIterable<Uint8Array>;
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        stored = Buffer.concat(chunks);
        metadata = command.input.Metadata;
        puts += 1;
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const body = stored;
        if (!body) throw new Error("missing");
        return {
          Body: (async function* () { yield body; })(),
          ContentLength: body.byteLength,
        };
      }
      throw new Error("unexpected command");
    },
  } as unknown as Pick<S3Client, "destroy" | "send">;
  const store = createWorkflowArchiveObjectStoreWithClient("archives", client);
  try {
    const input = {
      key: "workflow-archives/v2/aa/archive.ndjson",
      manifestSha256,
      path,
      sha256,
      sizeBytes: content.byteLength,
    };
    assert.deepEqual(await store.putVerified(input), {
      key: input.key,
      sha256,
      sizeBytes: content.byteLength,
    });
    await store.putVerified(input);
    assert.equal(puts, 1);
    const downloaded = join(directory, "downloaded.ndjson");
    await store.downloadVerified({
      key: input.key,
      path: downloaded,
      sha256,
      sizeBytes: content.byteLength,
    });
    assert.deepEqual(await readFile(downloaded), content);
  } finally {
    store.close();
    await rm(directory, { force: true, recursive: true });
  }
});
