import assert from "node:assert/strict";
import test from "node:test";
import { AbortMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { AssetStoreError } from "../../server/data/asset-store-core.ts";
import { createS3AssetStore } from "../../server/data/s3-asset-store.ts";

const owner = { principalId: "user-1", tenantId: "tenant-1" };
const issuerQualifiedOwner = {
  principalId: "https://open-agent.local:asset-load-runner",
  tenantId: "tenant-issuer-qualified",
};

test("S3 AssetStore keeps provider multipart ids private and persists public metadata", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("insert into \"open_agent\".\"agent_assets\"")) return { rows: [{ asset_id: "asset-1" }] };
      if (sql.includes("insert into \"open_agent\".\"agent_asset_uploads\"")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const commands: unknown[] = [];
  const client = {
    async send(command: unknown) {
      commands.push(command);
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "provider-secret-id" };
      throw new Error("unexpected command");
    },
  };
  const store = createS3AssetStore({
    bucket: "assets",
    client: client as never,
    database: { connectionString: "", maxPoolSize: 1, schema: "open_agent" },
    pool: pool as never,
    prefix: "muses",
  });
  const upload = await store.createUpload({
    filename: "picture.png",
    mediaType: "image/png",
    owner,
    sessionId: "session-1",
    sizeBytes: 1,
  });
  assert.match(upload.uploadId, /^upl_/u);
  assert.match(upload.assetId, /^asset_/u);
  assert.equal(commands.length, 1);
  assert.equal(((commands[0] as CreateMultipartUploadCommand).input as unknown as Record<string, unknown>).UploadId, undefined);
  assert.ok(queries.every((query) => !query.includes("provider-secret-id")));
});

test("S3 AssetStore accepts issuer-qualified authenticated principals", async () => {
  const pool = {
    async query(sql: string) {
      if (sql.includes("insert into \"open_agent\".\"agent_assets\"")) return { rows: [{ asset_id: "asset-issuer-qualified" }] };
      if (sql.includes("insert into \"open_agent\".\"agent_asset_uploads\"")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const client = {
    async send(command: unknown) {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "provider-secret-id" };
      throw new Error("unexpected command");
    },
  };
  const store = createS3AssetStore({
    bucket: "assets",
    client: client as never,
    database: { connectionString: "", maxPoolSize: 1, schema: "open_agent" },
    pool: pool as never,
  });
  const upload = await store.createUpload({
    filename: "issuer-qualified.txt",
    mediaType: "text/plain",
    owner: issuerQualifiedOwner,
    sessionId: "session-issuer-qualified",
    sizeBytes: 1,
  });
  assert.equal(upload.owner.principalId, issuerQualifiedOwner.principalId);
});

test("S3 AssetStore rejects unsafe principal identities while keeping tenant ids path-safe", async () => {
  const pool = {
    async query() {
      throw new Error("invalid owner input must fail before metadata queries");
    },
  };
  const client = {
    async send() {
      throw new Error("invalid owner input must fail before object storage calls");
    },
  };
  const store = createS3AssetStore({
    bucket: "assets",
    client: client as never,
    database: { connectionString: "", maxPoolSize: 1, schema: "open_agent" },
    pool: pool as never,
  });
  for (const principalId of [" leading-space", "trailing-space ", "contains\u0000nul", "contains\nnewline", "x".repeat(513)]) {
    await assert.rejects(
      () => store.createUpload({
        filename: "invalid-principal.txt",
        mediaType: "text/plain",
        owner: { principalId, tenantId: owner.tenantId },
        sessionId: "session-invalid-principal",
        sizeBytes: 1,
      }),
      (error: unknown) => error instanceof AssetStoreError && error.code === "invalid",
    );
  }
  await assert.rejects(
    () => store.createUpload({
      filename: "invalid-tenant.txt",
      mediaType: "text/plain",
      owner: { principalId: issuerQualifiedOwner.principalId, tenantId: "tenant/with-path" },
      sessionId: "session-invalid-tenant",
      sizeBytes: 1,
    }),
    (error: unknown) => error instanceof AssetStoreError && error.code === "invalid",
  );
});

test("S3 AssetStore fails closed when required scanning has no host scanner", () => {
  const pool = { async query() { return { rows: [] }; } };
  const client = { async send() { return {}; } };
  assert.throws(
    () => createS3AssetStore({
      bucket: "assets",
      client: client as never,
      database: { connectionString: "", maxPoolSize: 1, schema: "open_agent" },
      pool: pool as never,
      scanMode: "required",
    }),
    /AssetScanner is required/u,
  );
});

test("S3 AssetStore checks aggregate quota while holding a per-principal reservation lock", async () => {
  const queries: string[] = [];
  let released = false;
  const transaction = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("used_bytes")) return { rows: [{ used_bytes: "1", active_upload_bytes: "0" }] };
      if (sql.includes("insert into \"open_agent\".\"agent_assets\"")) return { rows: [{ asset_id: "asset-1" }] };
      return { rows: [] };
    },
    release() { released = true; },
  };
  const pool = {
    async connect() { return transaction; },
    async query() { throw new Error("quota transaction should use the connected client"); },
  };
  const client = {
    async send(command: unknown) {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "provider-secret-id" };
      return {};
    },
  };
  const store = createS3AssetStore({
    bucket: "assets",
    client: client as never,
    database: { connectionString: "", maxPoolSize: 1, schema: "open_agent" },
    pool: pool as never,
    quotaBytes: 2,
  });
  const upload = await store.createUpload({
    filename: "picture.png",
    mediaType: "image/png",
    owner,
    sessionId: "session-1",
    sizeBytes: 1,
  });
  assert.equal(upload.status, "uploading");
  assert.equal(released, true);
  assert.ok(queries.some((query) => query.includes("pg_advisory_xact_lock")));
  assert.ok(queries.some((query) => query.toLowerCase() === "commit"));
});

test("S3 AssetStore writes bounded parts with the server-side multipart id", async () => {
  const pool = {
    async query(sql: string) {
      if (sql.includes("from \"open_agent\".\"agent_asset_uploads\" upload")) {
        return {
          rows: [{
            asset_id: "asset-1",
            upload_id: "upl-1",
            provider_upload_id: "provider-secret-id",
            tenant_id: owner.tenantId,
            principal_id: owner.principalId,
            session_id: "session-1",
            filename: "sample.bin",
            media_type: "application/octet-stream",
            storage_key: "muses/assets/tenant-1/asset-1/content",
            declared_size_bytes: 3,
            chunk_size_bytes: 8 * 1024 * 1024,
            part_count: 1,
            status: "uploading",
            created_at: new Date().toISOString(),
          }],
        };
      }
      if (sql.includes("sum(size_bytes)")) return { rows: [{ total: "0" }] };
      if (sql.includes("insert into \"open_agent\".\"agent_asset_parts\"")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  let sent: UploadPartCommand | undefined;
  const client = {
    async send(command: unknown) {
      if (command instanceof UploadPartCommand) {
        sent = command;
        return { ETag: '"etag-1"' };
      }
      throw new Error("unexpected command");
    },
  };
  const store = createS3AssetStore({
    bucket: "assets",
    client: client as never,
    database: { connectionString: "", maxPoolSize: 1, schema: "open_agent" },
    pool: pool as never,
  });
  const part = await store.writePart({ content: new Uint8Array([1, 2, 3]), owner, partNumber: 1, uploadId: "upl-1" });
  assert.deepEqual(part, { etag: "etag-1", partNumber: 1, sizeBytes: 3 });
  assert.equal(sent?.input.UploadId, "provider-secret-id");
  assert.equal(sent?.input.Key, "muses/assets/tenant-1/asset-1/content");
});

test("S3 AssetStore abort removes metadata so cancelled uploads release quota", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("from \"open_agent\".\"agent_asset_uploads\" upload")) {
        return {
          rows: [{
            asset_id: "asset-1",
            upload_id: "upl-1",
            provider_upload_id: "provider-secret-id",
            tenant_id: owner.tenantId,
            principal_id: owner.principalId,
            session_id: "session-1",
            filename: "sample.bin",
            media_type: "application/octet-stream",
            storage_key: "muses/assets/tenant-1/asset-1/content",
            declared_size_bytes: 3,
            chunk_size_bytes: 8 * 1024 * 1024,
            part_count: 1,
            status: "uploading",
            created_at: new Date().toISOString(),
          }],
        };
      }
      return { rows: [] };
    },
  };
  const commands: unknown[] = [];
  const client = {
    async send(command: unknown) {
      commands.push(command);
      return {};
    },
  };
  const store = createS3AssetStore({
    bucket: "assets",
    client: client as never,
    database: { connectionString: "", maxPoolSize: 1, schema: "open_agent" },
    pool: pool as never,
  });

  await store.abortUpload({ owner, uploadId: "upl-1" });
  assert.ok(commands.some((command) => command instanceof AbortMultipartUploadCommand));
  assert.ok(queries.some((query) => query.includes("delete from \"open_agent\".\"agent_asset_uploads\"")));
  assert.ok(queries.some((query) => query.includes("delete from \"open_agent\".\"agent_assets\"") && query.includes("status = 'uploading'")));
});

test("S3 AssetStore cleans metadata when multipart initialization fails", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("insert into \"open_agent\".\"agent_assets\"")) return { rows: [{ asset_id: "asset-1" }] };
      if (sql.includes("insert into \"open_agent\".\"agent_asset_uploads\"")) throw new Error("metadata unavailable");
      return { rows: [] };
    },
  };
  const commands: unknown[] = [];
  const client = {
    async send(command: unknown) {
      commands.push(command);
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "provider-secret-id" };
      return {};
    },
  };
  const store = createS3AssetStore({
    bucket: "assets",
    client: client as never,
    database: { connectionString: "", maxPoolSize: 1, schema: "open_agent" },
    pool: pool as never,
  });

  await assert.rejects(() => store.createUpload({
    filename: "picture.png",
    mediaType: "image/png",
    owner,
    sessionId: "session-1",
    sizeBytes: 1,
  }));
  assert.ok(commands.some((command) => command instanceof AbortMultipartUploadCommand));
  assert.ok(queries.some((query) => query.includes("delete from \"open_agent\".\"agent_assets\"") && query.includes("status = 'uploading'")));
});

test("S3 AssetStore retention removes expired objects and aborts expired multipart uploads", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("where expires_at is not null") && sql.includes("status in ('ready', 'failed', 'expired')")) {
        return {
          rows: [{
            asset_id: "asset-expired",
            tenant_id: owner.tenantId,
            principal_id: owner.principalId,
            session_id: "session-1",
            message_id: null,
            filename: "expired.png",
            media_type: "image/png",
            size_bytes: 3,
            checksum_sha256: "checksum",
            storage_key: "open-agent/assets/tenant-1/asset-expired/content",
            status: "ready",
            expires_at: new Date("2020-01-01T00:00:00.000Z"),
            created_at: new Date("2019-01-01T00:00:00.000Z"),
          }],
        };
      }
      if (sql.includes("upload.status = 'uploading'")) {
        return {
          rows: [{
            asset_id: "asset-uploading",
            upload_id: "upl-expired",
            provider_upload_id: "provider-expired",
            tenant_id: owner.tenantId,
            principal_id: owner.principalId,
            session_id: "session-1",
            filename: "partial.bin",
            media_type: "application/octet-stream",
            storage_key: "open-agent/assets/tenant-1/asset-uploading/content",
            declared_size_bytes: 3,
            chunk_size_bytes: 8 * 1024 * 1024,
            part_count: 1,
            status: "uploading",
            created_at: new Date("2019-01-01T00:00:00.000Z"),
            expires_at: new Date("2020-01-01T00:00:00.000Z"),
          }],
        };
      }
      return { rows: [] };
    },
  };
  const commands: unknown[] = [];
  const client = {
    async send(command: unknown) {
      commands.push(command);
      return {};
    },
  };
  const store = createS3AssetStore({
    bucket: "assets",
    client: client as never,
    database: { connectionString: "", maxPoolSize: 1, schema: "open_agent" },
    pool: pool as never,
  });

  const result = await store.cleanupExpired?.({ now: new Date("2021-01-01T00:00:00.000Z"), limit: 10 });
  assert.deepEqual(result, { abortedUploads: 1, deletedAssets: 1 });
  assert.ok(commands.some((command) => command instanceof DeleteObjectCommand));
  assert.ok(commands.some((command) => command instanceof AbortMultipartUploadCommand));
  assert.ok(queries.some((query) => query.includes("delete from \"open_agent\".\"agent_assets\"") && query.includes("status in ('ready', 'failed', 'expired')")));
  assert.ok(queries.some((query) => query.includes("delete from \"open_agent\".\"agent_assets\"") && query.includes("status = 'uploading'")));
});
