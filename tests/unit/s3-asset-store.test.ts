import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";
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
  assert.equal(upload.transferStrategy, "direct");
  assert.equal(commands.length, 1);
  const createInput = (commands[0] as CreateMultipartUploadCommand).input;
  assert.equal((createInput as unknown as Record<string, unknown>).UploadId, undefined);
  assert.equal(createInput.Metadata?.principal, digest(owner.principalId));
  assert.equal(createInput.Metadata?.asset, digest(upload.assetId));
  assert.equal(createInput.Metadata?.tenant, digest(owner.tenantId));
  assert.equal(createInput.Metadata?.session, digest("session-1"));
  assert.ok(!Object.values(createInput.Metadata ?? {}).includes(owner.principalId));
  assert.ok(queries.every((query) => !query.includes("provider-secret-id")));
});

test("S3 AssetStore signs direct parts and durably acknowledges provider ETags", async () => {
  const row = {
    asset_id: "asset-direct",
    upload_id: "upl-direct",
    provider_upload_id: "provider-direct",
    tenant_id: owner.tenantId,
    principal_id: owner.principalId,
    session_id: "session-direct",
    filename: "direct.bin",
    media_type: "application/octet-stream",
    storage_key: "open-agent/assets/tenant-1/asset-direct/content",
    declared_size_bytes: 3,
    chunk_size_bytes: 8 * 1024 * 1024,
    part_count: 1,
    status: "uploading" as const,
    created_at: new Date().toISOString(),
  };
  const queries: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  const pool = {
    async query(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      if (sql.includes("from \"open_agent\".\"agent_asset_uploads\" upload")) return { rows: [row] };
      if (sql.includes("insert into \"open_agent\".\"agent_asset_parts\"")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  let signedCommand: UploadPartCommand | undefined;
  const store = createS3AssetStore({
    bucket: "assets",
    client: { async send() { throw new Error("provider bytes must not pass through the app server"); } } as never,
    database: { connectionString: "", maxPoolSize: 1, schema: "open_agent" },
    pool: pool as never,
    presignUploadPart: async (command, expiresIn) => {
      signedCommand = command;
      assert.equal(expiresIn, 900);
      return "https://objects.example.test/signed-part";
    },
  });

  const target = await store.createPartUpload?.({ owner, partNumber: 1, sizeBytes: 3, uploadId: row.upload_id });
  assert.equal(target?.url, "https://objects.example.test/signed-part");
  assert.equal(signedCommand?.input.UploadId, row.provider_upload_id);
  assert.equal(signedCommand?.input.ContentLength, 3);
  const part = await store.acknowledgePart?.({ etag: '"abc-1"', owner, partNumber: 1, sizeBytes: 3, uploadId: row.upload_id });
  assert.deepEqual(part, { etag: "abc-1", partNumber: 1, sizeBytes: 3 });
  assert.ok(queries.some(({ sql, values }) => sql.includes("agent_asset_parts") && values[3] === "abc-1"));
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

test("S3 AssetStore serializes concurrent parts and rechecks declared size under the upload lock", async () => {
  const queries: string[] = [];
  const parts = new Map<number, number>();
  const row = {
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
    part_count: 2,
    status: "uploading" as const,
    created_at: new Date().toISOString(),
  };
  let lockHeld = false;
  const lockWaiters: Array<() => void> = [];
  const acquireLock = async () => {
    if (!lockHeld) {
      lockHeld = true;
      return;
    }
    await new Promise<void>((resolve) => lockWaiters.push(resolve));
  };
  const releaseLock = () => {
    const next = lockWaiters.shift();
    if (next) next();
    else lockHeld = false;
  };
  const pool = {
    async connect() {
      let ownsLock = false;
      return {
        async query(sql: string, values: readonly unknown[] = []) {
          queries.push(sql);
          if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
          if (sql.includes("pg_advisory_xact_lock")) {
            await acquireLock();
            ownsLock = true;
            return { rows: [] };
          }
          if (sql.includes("from \"open_agent\".\"agent_asset_uploads\" upload")) return { rows: [row] };
          if (sql.includes("sum(size_bytes)")) {
            const replacingPart = Number(values[1]);
            const total = [...parts.entries()]
              .filter(([partNumber]) => partNumber !== replacingPart)
              .reduce((sum, [, size]) => sum + size, 0);
            return { rows: [{ total: String(total) }] };
          }
          if (sql.includes("insert into \"open_agent\".\"agent_asset_parts\"")) {
            parts.set(Number(values[1]), Number(values[2]));
            return { rows: [] };
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
        release() {
          if (ownsLock) releaseLock();
        },
      };
    },
    async query() {
      throw new Error("writePart must use a transaction client when pool.connect is available");
    },
  };
  let releaseProvider: (() => void) | undefined;
  let providerStarted: (() => void) | undefined;
  const commands: unknown[] = [];
  const client = {
    async send(command: unknown) {
      if (!(command instanceof UploadPartCommand)) throw new Error("unexpected command");
      commands.push(command);
      if (commands.length === 1) {
        providerStarted?.();
        await new Promise<void>((resolve) => { releaseProvider = resolve; });
      }
      return { ETag: `\"etag-${commands.length}\"` };
    },
  };
  const store = createS3AssetStore({
    bucket: "assets",
    client: client as never,
    database: { connectionString: "", maxPoolSize: 2, schema: "open_agent" },
    pool: pool as never,
  });

  const firstStarted = new Promise<void>((resolve) => { providerStarted = resolve; });
  const first = store.writePart({ content: new Uint8Array([1, 2]), owner, partNumber: 1, uploadId: "upl-1" });
  await firstStarted;
  const second = store.writePart({ content: new Uint8Array([3, 4]), owner, partNumber: 2, uploadId: "upl-1" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(commands.length, 1, "the second provider part must wait for the upload lock");
  releaseProvider?.();

  assert.deepEqual(await first, { etag: "etag-1", partNumber: 1, sizeBytes: 2 });
  await assert.rejects(
    second,
    (error: unknown) => error instanceof AssetStoreError && error.code === "quota",
  );
  assert.equal(commands.length, 1, "the over-quota part must be rejected before provider upload");
  assert.equal(parts.get(1), 2);
  assert.equal(parts.has(2), false);
  assert.equal(queries.filter((query) => query.includes("pg_advisory_xact_lock")).length, 2);
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

test("S3 retention deletes a provider object before retiring a stale completion", async () => {
  const stale = {
    asset_id: "asset-stale-completion",
    upload_id: "upl-stale-completion",
    provider_upload_id: "provider-stale-completion",
    tenant_id: owner.tenantId,
    principal_id: owner.principalId,
    session_id: "session-stale-completion",
    filename: "committed.bin",
    media_type: "application/octet-stream",
    storage_key: "open-agent/assets/tenant-1/asset-stale-completion/content",
    declared_size_bytes: 3,
    chunk_size_bytes: 8 * 1024 * 1024,
    part_count: 1,
    status: "completing" as const,
    created_at: new Date("2019-01-01T00:00:00.000Z"),
    updated_at: new Date("2019-01-01T00:00:00.000Z"),
    expires_at: new Date("2020-01-01T00:00:00.000Z"),
  };
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("status in ('ready', 'failed', 'expired')")) return { rows: [] };
      if (sql.includes("from \"open_agent\".\"agent_asset_uploads\" upload")) return { rows: [stale] };
      return { rows: [] };
    },
  };
  const commands: unknown[] = [];
  const client = {
    async send(command: unknown) {
      commands.push(command);
      if (command instanceof AbortMultipartUploadCommand) throw new Error("NoSuchUpload");
      if (command instanceof DeleteObjectCommand) return {};
      throw new Error("unexpected command");
    },
  };
  const store = createS3AssetStore({
    bucket: "assets",
    client: client as never,
    database: { connectionString: "", maxPoolSize: 1, schema: "open_agent" },
    pool: pool as never,
  });

  const result = await store.cleanupExpired?.({ now: new Date("2021-01-01T00:00:00.000Z"), limit: 10 });

  assert.deepEqual(result, { abortedUploads: 1, deletedAssets: 0 });
  assert.ok(commands.some((command) => command instanceof AbortMultipartUploadCommand));
  assert.ok(commands.some((command) => command instanceof DeleteObjectCommand));
  assert.ok(queries.some((query) => query.includes("delete from \"open_agent\".\"agent_assets\"")));
});

test("S3 retention casts its shared cleanup timestamp for real PostgreSQL", async () => {
  const queries: string[] = [];
  const store = createS3AssetStore({
    bucket: "assets",
    client: { async send() { throw new Error("no provider call expected"); } } as never,
    pool: {
      async query(sql: string) {
        queries.push(sql);
        return { rows: [] };
      },
    } as never,
  });
  await store.cleanupExpired?.({ now: new Date("2030-01-01T00:00:00.000Z") });
  const cleanup = queries.find((sql) => sql.includes("upload.updated_at"));
  assert.match(cleanup ?? "", /\$1::timestamptz - interval '5 minutes'/u);
  assert.match(cleanup ?? "", /asset\.expires_at <= \$1::timestamptz/u);
});

test("S3 retention keeps upload metadata when provider cleanup fails", async () => {
  const uploading = {
    asset_id: "asset-retry-cleanup",
    upload_id: "upl-retry-cleanup",
    provider_upload_id: "provider-retry-cleanup",
    tenant_id: owner.tenantId,
    principal_id: owner.principalId,
    session_id: "session-retry-cleanup",
    filename: "partial.bin",
    media_type: "application/octet-stream",
    storage_key: "open-agent/assets/tenant-1/asset-retry-cleanup/content",
    declared_size_bytes: 3,
    chunk_size_bytes: 8 * 1024 * 1024,
    part_count: 1,
    status: "uploading" as const,
    created_at: new Date("2019-01-01T00:00:00.000Z"),
    updated_at: new Date("2019-01-01T00:00:00.000Z"),
    expires_at: new Date("2020-01-01T00:00:00.000Z"),
  };
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("status in ('ready', 'failed', 'expired')")) return { rows: [] };
      if (sql.includes("from \"open_agent\".\"agent_asset_uploads\" upload")) return { rows: [uploading] };
      return { rows: [] };
    },
  };
  const store = createS3AssetStore({
    bucket: "assets",
    client: { async send() { throw new Error("object store unavailable"); } } as never,
    database: { connectionString: "", maxPoolSize: 1, schema: "open_agent" },
    pool: pool as never,
  });

  const result = await store.cleanupExpired?.({ now: new Date("2021-01-01T00:00:00.000Z"), limit: 10 });

  assert.deepEqual(result, { abortedUploads: 0, deletedAssets: 0 });
  assert.equal(queries.some((query) => query.includes("delete from \"open_agent\".\"agent_assets\"")), false);
});

test("S3 completion reconciles a provider commit after the app crashes", async () => {
  const row = {
    asset_id: "asset-recover",
    upload_id: "upl-recover",
    provider_upload_id: "provider-recover",
    tenant_id: owner.tenantId,
    principal_id: owner.principalId,
    session_id: "session-recover",
    filename: "recover.bin",
    media_type: "application/octet-stream",
    storage_key: "open-agent/assets/tenant-1/asset-recover/content",
    declared_size_bytes: 3,
    chunk_size_bytes: 8 * 1024 * 1024,
    part_count: 1,
    status: "uploading" as const,
    created_at: new Date().toISOString(),
    updated_at: new Date(Date.now() - 10 * 60 * 1_000).toISOString(),
    expires_at: null,
    scan_status: "disabled",
  };
  let currentStatus: "uploading" | "completing" = "uploading";
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("from \"open_agent\".\"agent_asset_uploads\" upload")) return { rows: [{ ...row, status: currentStatus }] };
      if (sql.includes("from \"open_agent\".\"agent_asset_parts\"")) return { rows: [{ part_number: 1, size_bytes: 3, etag: "etag" }] };
      if (sql.includes("set status = 'completing'")) { currentStatus = "completing"; return { rows: [] }; }
      if (sql.includes("set status = 'ready', scan_status")) return { rows: [{
        asset_id: row.asset_id,
        tenant_id: row.tenant_id,
        principal_id: row.principal_id,
        session_id: row.session_id,
        message_id: null,
        filename: row.filename,
        media_type: row.media_type,
        size_bytes: row.declared_size_bytes,
        checksum_sha256: "265b96e7a8a7f1e3a5f3d7a1f4f5e4c0d5c0e8c1cb3c4c8e3f4d3d5d0b7f6a9f",
        storage_key: row.storage_key,
        status: "ready",
        scan_status: "disabled",
        expires_at: null,
        created_at: row.created_at,
      }] };
      return { rows: [] };
    },
  };
  const client = {
    async send(command: unknown) {
      if (command instanceof CompleteMultipartUploadCommand) throw new Error("NoSuchUpload");
      if (command instanceof HeadObjectCommand) return {
        ContentLength: 3,
        Metadata: {
          asset: digest(row.asset_id),
          issuer: digest(""),
          principal: digest(row.principal_id),
          principaltype: digest(""),
          session: digest(row.session_id),
          tenant: digest(row.tenant_id),
        },
      };
      if (command instanceof GetObjectCommand) return { Body: (async function* () { yield new Uint8Array([1, 2, 3]); })() };
      const commandName = command && typeof command === "object" && "constructor" in command
        ? (command.constructor as { readonly name?: string }).name
        : typeof command;
      throw new Error(`Unexpected command ${commandName ?? "unknown"}`);
    },
  };
  const store = createS3AssetStore({
    bucket: "assets",
    client: client as never,
    database: { connectionString: "", maxPoolSize: 1, schema: "open_agent" },
    pool: pool as never,
    scanMode: "disabled",
  });
  const result = await store.completeUpload({ owner, uploadId: row.upload_id });
  assert.equal(result.status, "ready");
  assert.ok(queries.some((query) => query.includes("set status = 'completing'")));
  assert.ok(queries.some((query) => query.includes("set status = 'ready', scan_status")));
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
