import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  AssetDownload,
  AssetCleanupResult,
  AssetMetadata,
  AssetOwner,
  AssetPart,
  AssetReadOptions,
  AssetScanner,
  AssetStore,
  AssetUpload,
} from "@oworker/open-agent-contracts/asset";
import {
  ASSET_CHUNK_SIZE_BYTES,
  assertAssetIdentifier,
  assertAssetPrincipalIdentifier,
  AssetStoreError,
  type AssetScanMode,
  MAX_ASSET_BYTES,
  scanAsset,
} from "./asset-store-core.ts";
import { quoteIdentifier, type AgentDatabaseConfig } from "./agent-database.ts";
import { getAgentDatabasePool } from "./agent-database.ts";

export type S3AssetStoreOptions = {
  readonly bucket: string;
  readonly client: S3Client;
  readonly maxBytes?: number;
  /** Optional aggregate quota per authenticated tenant/principal pair. */
  readonly quotaBytes?: number;
  readonly prefix?: string;
  readonly database?: AgentDatabaseConfig;
  readonly pool?: Pool;
  /** Host scanner for untrusted uploads. */
  readonly scanner?: AssetScanner;
  readonly scanMode?: AssetScanMode;
  /** Test/host injection point; defaults to the AWS SigV4 presigner. */
  readonly presignUploadPart?: (command: UploadPartCommand, expiresInSeconds: number) => Promise<string>;
  readonly uploadUrlExpiresSeconds?: number;
};

type UploadRow = {
  asset_id: string;
  upload_id: string;
  provider_upload_id: string | null;
  tenant_id: string;
  principal_id: string;
  principal_type?: string | null;
  issuer?: string | null;
  session_id: string;
  filename: string;
  media_type: string;
  storage_key: string;
  declared_size_bytes: number | string;
  chunk_size_bytes: number;
  part_count: number;
  status: "uploading" | "completing" | "ready" | "failed";
  created_at: Date | string;
  expires_at: Date | string | null;
  scan_status?: string | null;
  updated_at?: Date | string;
};

const COMPLETION_LEASE_MS = 5 * 60 * 1_000;

type AssetRow = {
  asset_id: string;
  tenant_id: string;
  principal_id: string;
  principal_type?: string | null;
  issuer?: string | null;
  session_id: string;
  message_id: string | null;
  filename: string;
  media_type: string;
  size_bytes: number | string;
  checksum_sha256: string | null;
  storage_key: string;
  status: "uploading" | "ready" | "failed" | "expired";
  expires_at: Date | string | null;
  created_at: Date | string;
  scan_status?: string | null;
};

type PartRow = {
  part_number: number;
  size_bytes: number;
  etag: string | null;
};

/**
 * PostgreSQL metadata plus S3-compatible object bytes. The public upload id
 * is intentionally separate from the provider multipart id, so provider
 * identifiers never enter messages, URLs, or Host contracts.
 */
export function createS3AssetStore(options: S3AssetStoreOptions): AssetStore {
  const database = options.database;
  const pool = options.pool ?? (database ? getAgentDatabasePool(database) : undefined);
  if (!pool) throw new Error("S3 AssetStore requires Agent database metadata configuration.");
  const table = tableNames(database?.schema ?? "open_agent");
  const maxBytes = normalizeConfiguredMaxBytes(options.maxBytes);
  const quotaBytes = normalizeConfiguredQuotaBytes(options.quotaBytes);
  const prefix = normalizePrefix(options.prefix);
  const scanMode = resolveScanMode(options.scanMode, options.scanner);
  const uploadUrlExpiresSeconds = normalizeUploadUrlExpiry(options.uploadUrlExpiresSeconds);
  const presignUploadPart = options.presignUploadPart
    ?? ((command: UploadPartCommand, expiresInSeconds: number) =>
      getSignedUrl(options.client, command, { expiresIn: expiresInSeconds }));

  return {
    async createUpload(input) {
      assertCreateUploadInput(input, maxBytes);
      const assetId = input.assetId ?? `asset_${randomUUID()}`;
      const uploadId = `upl_${randomUUID()}`;
      const storageKey = `${prefix}/assets/${input.owner.tenantId}/${assetId}/content`;
      let providerUploadId: string | undefined;
      let metadataInserted = false;
      let transactionClient: PoolClient | undefined;
      try {
        const created = await options.client.send(new CreateMultipartUploadCommand({
          Bucket: options.bucket,
          ContentType: input.mediaType,
          Key: storageKey,
          Metadata: {
            asset: metadataDigest(assetId),
            issuer: metadataDigest(input.owner.issuer ?? ""),
            principal: metadataDigest(input.owner.principalId),
            principaltype: metadataDigest(input.owner.principalType ?? ""),
            session: metadataDigest(input.sessionId),
            tenant: metadataDigest(input.owner.tenantId),
          },
        }));
        providerUploadId = created.UploadId;
        if (!providerUploadId) throw new Error("The object store did not return a multipart upload id.");
        const executor = quotaBytes !== undefined && typeof (pool as unknown as { connect?: unknown }).connect === "function"
          ? await beginQuotaTransaction(pool, input.owner, quotaBytes, input.sizeBytes, table)
          : { client: undefined, query: pool.query.bind(pool) };
        transactionClient = executor.client;
        const insertedAsset = await executor.query<{ asset_id: string }>(
          `insert into ${table.assets}
             (asset_id, tenant_id, principal_id, principal_type, issuer, session_id, message_id, filename,
              media_type, size_bytes, storage_key, status, scan_status, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'uploading', $12, $13)
           on conflict (asset_id) do nothing
           returning asset_id`,
          [
            assetId,
            input.owner.tenantId,
            input.owner.principalId,
            input.owner.principalType ?? null,
            input.owner.issuer ?? null,
            input.sessionId,
            input.messageId ?? null,
            input.filename,
            input.mediaType,
            input.sizeBytes,
            storageKey,
            scanMode === "disabled" ? "disabled" : "pending",
            input.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
          ],
        );
        if (insertedAsset.rows.length !== 1) throw new AssetStoreError("conflict", "The asset id is already in use.");
        metadataInserted = true;
        await executor.query(
          `insert into ${table.uploads}
             (upload_id, asset_id, tenant_id, principal_id, principal_type, issuer, session_id,
              chunk_size_bytes, declared_size_bytes, part_count, provider_upload_id, status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'uploading')`,
          [
            uploadId,
            assetId,
            input.owner.tenantId,
            input.owner.principalId,
            input.owner.principalType ?? null,
            input.owner.issuer ?? null,
            input.sessionId,
            ASSET_CHUNK_SIZE_BYTES,
            input.sizeBytes,
            Math.ceil(input.sizeBytes / ASSET_CHUNK_SIZE_BYTES),
            providerUploadId,
          ],
        );
        if (transactionClient) {
          await transactionClient.query("commit");
          transactionClient.release();
          transactionClient = undefined;
        }
        return {
          assetId,
          chunkSizeBytes: ASSET_CHUNK_SIZE_BYTES,
          createdAt: new Date().toISOString(),
          filename: input.filename,
          mediaType: input.mediaType,
          maxBytes,
          partCount: Math.ceil(input.sizeBytes / ASSET_CHUNK_SIZE_BYTES),
          sizeBytes: input.sizeBytes,
          scanStatus: scanMode === "disabled" ? "disabled" : "pending",
          status: "uploading",
          transferStrategy: "direct",
          uploadId,
          owner: input.owner,
        } satisfies AssetUpload;
      } catch (error) {
        if (transactionClient) await transactionClient.query("rollback").catch(() => undefined);
        transactionClient?.release();
        if (providerUploadId) {
          await options.client.send(new AbortMultipartUploadCommand({
            Bucket: options.bucket,
            Key: storageKey,
            UploadId: providerUploadId,
          })).catch(() => undefined);
        }
        if (metadataInserted) {
          await pool.query(`delete from ${table.assets} where asset_id = $1 and status = 'uploading'`, [assetId]).catch(() => undefined);
        }
        if (error instanceof AssetStoreError) throw error;
        throw storageFailure(error);
      }
    },

    async createPartUpload(input) {
      assertPartNumber(input.partNumber);
      return await withUploadWriteLock(pool, input.uploadId, async (lockedPool) => {
        const row = await readUpload(lockedPool, table, input.uploadId);
        assertOwner(ownerFromUploadRow(row), input.owner);
        assertWritablePart(row, input.partNumber, input.sizeBytes);
        const command = new UploadPartCommand({
          Body: undefined,
          Bucket: options.bucket,
          ContentLength: input.sizeBytes,
          Key: row.storage_key,
          PartNumber: input.partNumber,
          UploadId: row.provider_upload_id!,
        });
        const url = await presignUploadPart(command, uploadUrlExpiresSeconds);
        return {
          expiresAt: new Date(Date.now() + uploadUrlExpiresSeconds * 1_000).toISOString(),
          method: "PUT" as const,
          partNumber: input.partNumber,
          url,
        };
      });
    },

    async acknowledgePart(input) {
      assertPartNumber(input.partNumber);
      const etag = normalizeEtag(input.etag);
      return await withUploadWriteLock(pool, input.uploadId, async (lockedPool) => {
        const row = await readUpload(lockedPool, table, input.uploadId);
        assertOwner(ownerFromUploadRow(row), input.owner);
        assertWritablePart(row, input.partNumber, input.sizeBytes);
        await upsertPart(lockedPool, table.parts, {
          etag,
          partNumber: input.partNumber,
          sizeBytes: input.sizeBytes,
          storageKey: row.storage_key,
          uploadId: input.uploadId,
        });
        return { etag, partNumber: input.partNumber, sizeBytes: input.sizeBytes };
      });
    },

    async writePart(input) {
      assertPartNumber(input.partNumber);
      if (input.content.byteLength === 0 || input.content.byteLength > 16 * 1024 * 1024) {
        throw new AssetStoreError("quota", "Asset parts exceed the configured 16 MiB limit.");
      }
      // A multipart upload may receive different parts concurrently. The
      // object store and metadata table have no shared transaction, so hold a
      // per-upload PostgreSQL advisory lock across the re-read, provider
      // write, and metadata upsert. This prevents two requests from both
      // passing the declared-size check against the same stale total.
      return await withUploadWriteLock(pool, input.uploadId, async (lockedPool) => {
        const row = await readUpload(lockedPool, table, input.uploadId);
        assertOwner({ principalId: row.principal_id, principalType: row.principal_type ?? undefined, issuer: row.issuer ?? undefined, tenantId: row.tenant_id }, input.owner);
        if (row.status !== "uploading" || !row.provider_upload_id) {
          throw new AssetStoreError("conflict", "The asset upload is no longer writable.");
        }
        if (input.partNumber > row.part_count) {
          throw new AssetStoreError("invalid", "The asset part number exceeds the declared object size.");
        }
        // Re-read parts only after the lock is acquired. Replacing a part
        // subtracts its previous metadata size before adding the new bytes.
        const currentTotal = await sumParts(lockedPool, table.parts, input.uploadId, input.partNumber);
        if (currentTotal + input.content.byteLength > Number(row.declared_size_bytes)) {
          throw new AssetStoreError("quota", "Uploaded parts exceed the declared asset size.");
        }
        const result = await options.client.send(new UploadPartCommand({
          Body: input.content,
          Bucket: options.bucket,
          ContentLength: input.content.byteLength,
          Key: row.storage_key,
          PartNumber: input.partNumber,
          UploadId: row.provider_upload_id,
        }));
        const etag = result.ETag?.replaceAll('"', "") || undefined;
        if (!etag) throw new Error("The object store did not return a part etag.");
        await upsertPart(lockedPool, table.parts, {
          etag,
          partNumber: input.partNumber,
          sizeBytes: input.content.byteLength,
          storageKey: row.storage_key,
          uploadId: input.uploadId,
        });
        return { etag, partNumber: input.partNumber, sizeBytes: input.content.byteLength } satisfies AssetPart;
      });
    },

    async completeUpload(input) {
      // Claim the completion in durable metadata before touching the provider.
      // If the process dies after CompleteMultipartUpload succeeds, the next
      // caller can recover the `completing` row by inspecting the object.
      const claim = await withUploadWriteLock(pool, input.uploadId, async (lockedPool) => {
        const row = await readUpload(lockedPool, table, input.uploadId);
        assertOwner({ principalId: row.principal_id, principalType: row.principal_type ?? undefined, issuer: row.issuer ?? undefined, tenantId: row.tenant_id }, input.owner);
        if (row.status === "ready") {
          const existing = await readAsset(lockedPool, table, row.asset_id);
          if (existing) return { kind: "ready" as const, metadata: toMetadata(existing) };
        }
        if (row.status === "failed" || !row.provider_upload_id) {
          throw new AssetStoreError("conflict", "The asset upload cannot be completed.");
        }
        const updatedAt = row.updated_at ? Date.parse(asIso(row.updated_at)) : Number.NaN;
        if (row.status === "completing" && Number.isFinite(updatedAt) && Date.now() - updatedAt < COMPLETION_LEASE_MS) {
          throw new AssetStoreError("conflict", "The asset upload is already being completed. Retry after the active attempt settles.");
        }
        if (input.parts) {
          await reconcileCompletionParts(lockedPool, table.parts, row, input.uploadId, input.parts);
        }
        const parts = await readParts(lockedPool, table.parts, input.uploadId);
        if (parts.length !== row.part_count || parts.some((part, index) => part.part_number !== index + 1)) {
          throw new AssetStoreError("invalid", "All asset parts must be uploaded before completion.");
        }
        const totalBytes = parts.reduce((sum, part) => sum + part.size_bytes, 0);
        if (totalBytes !== Number(row.declared_size_bytes)) {
          throw new AssetStoreError("invalid", "Uploaded bytes do not match the declared asset size.");
        }
        await lockedPool.query(
          `update ${table.uploads} set status = 'completing', updated_at = now()
           where upload_id = $1 and status in ('uploading', 'completing')`,
          [input.uploadId],
        );
        return { kind: "claimed" as const, parts, row };
      });
      if (claim.kind === "ready") return claim.metadata;

      const { row, parts } = claim;
      try {
        await options.client.send(new CompleteMultipartUploadCommand({
          Bucket: options.bucket,
          Key: row.storage_key,
          MultipartUpload: { Parts: parts.map((part) => ({ ETag: part.etag ?? undefined, PartNumber: part.part_number })) },
          UploadId: row.provider_upload_id!,
        }));
      } catch (error) {
        // S3-compatible providers commonly return NoSuchUpload when the
        // multipart operation already committed before a client crash. A
        // successful HeadObject is the durable provider-side commit marker.
        if (!await objectMatches(options.client, options.bucket, row)) {
          throw storageFailure(error);
        }
      }

      if (!await objectMatches(options.client, options.bucket, row)) {
        await options.client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: row.storage_key })).catch(() => undefined);
        await withUploadWriteLock(pool, input.uploadId, async (lockedPool) => {
          await lockedPool.query(`update ${table.assets} set status = 'failed' where asset_id = $1`, [row.asset_id]);
          await lockedPool.query(`update ${table.uploads} set status = 'failed', updated_at = now() where upload_id = $1`, [input.uploadId]);
        });
        throw new AssetStoreError("invalid", "The completed object does not match its declared size or authenticated upload identity.");
      }

      const checksum = await hashObject(options.client, options.bucket, row.storage_key);
      if (input.checksumSha256 && input.checksumSha256 !== checksum) {
        await options.client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: row.storage_key })).catch(() => undefined);
        await withUploadWriteLock(pool, input.uploadId, async (lockedPool) => {
          await lockedPool.query(`update ${table.assets} set status = 'failed' where asset_id = $1`, [row.asset_id]);
          await lockedPool.query(`update ${table.uploads} set status = 'failed', updated_at = now() where upload_id = $1`, [input.uploadId]);
        });
        throw new AssetStoreError("invalid", "The completed asset checksum does not match.");
      }

      const metadata = await withUploadWriteLock(pool, input.uploadId, async (lockedPool) => {
        const current = await readUpload(lockedPool, table, input.uploadId);
        assertOwner({ principalId: current.principal_id, principalType: current.principal_type ?? undefined, issuer: current.issuer ?? undefined, tenantId: current.tenant_id }, input.owner);
        if (current.status === "ready") {
          const existing = await readAsset(lockedPool, table, current.asset_id);
          if (existing) return toMetadata(existing);
        }
        if (current.status !== "completing") throw new AssetStoreError("conflict", "The asset upload completion lease is no longer active.");
        const updated = await lockedPool.query<AssetRow>(
          `update ${table.assets}
              set status = 'ready', scan_status = $3, checksum_sha256 = $2
            where asset_id = $1
              returning asset_id, tenant_id, principal_id, principal_type, issuer, session_id, message_id,
              filename, media_type, size_bytes, checksum_sha256, storage_key,
              status, scan_status, expires_at, created_at`,
          [current.asset_id, checksum, scanMode === "disabled" ? "disabled" : "scanning"],
        );
        await lockedPool.query(`update ${table.uploads} set status = 'ready', updated_at = now() where upload_id = $1`, [input.uploadId]);
        const asset = updated.rows[0];
        if (!asset) throw new Error("The asset metadata disappeared during completion.");
        return toMetadata(asset);
      });

      const scanned = await scanAsset(
        metadata,
        scanMode,
        options.scanner,
        () => openS3AssetReadStream(options.client, options.bucket, {
          asset_id: metadata.assetId,
          tenant_id: metadata.tenantId,
          principal_id: metadata.principalId,
          session_id: metadata.sessionId,
          message_id: metadata.messageId ?? null,
          filename: metadata.filename,
          media_type: metadata.mediaType,
          size_bytes: metadata.sizeBytes,
          checksum_sha256: metadata.checksumSha256 ?? null,
          storage_key: metadata.storageKey,
          status: "ready",
          scan_status: metadata.scanStatus,
          expires_at: metadata.expiresAt ?? null,
          created_at: metadata.createdAt,
        }),
      );
      if (scanned.scanStatus !== metadata.scanStatus) {
        await withUploadWriteLock(pool, input.uploadId, async (lockedPool) => {
          await lockedPool.query(`update ${table.assets} set scan_status = $2 where asset_id = $1`, [metadata.assetId, scanned.scanStatus ?? "pending"]);
        });
      }
      return scanned;
    },

    async abortUpload(input) {
      await withUploadWriteLock(pool, input.uploadId, async (lockedPool) => {
        const row = await readUpload(lockedPool, table, input.uploadId);
        assertOwner({ principalId: row.principal_id, principalType: row.principal_type ?? undefined, issuer: row.issuer ?? undefined, tenantId: row.tenant_id }, input.owner);
        if (row.status === "ready") throw new AssetStoreError("conflict", "A completed asset cannot be aborted.");
        if (row.status === "completing") {
          throw new AssetStoreError("conflict", "An upload being completed cannot be aborted; retry after completion reconciliation.");
        }
        if (row.provider_upload_id) {
          await options.client.send(new AbortMultipartUploadCommand({
            Bucket: options.bucket,
            Key: row.storage_key,
            UploadId: row.provider_upload_id,
          })).catch((error) => { throw storageFailure(error); });
        }
        await lockedPool.query(`delete from ${table.uploads} where upload_id = $1`, [input.uploadId]);
        await lockedPool.query(`delete from ${table.assets} where asset_id = $1 and status = 'uploading'`, [row.asset_id]);
      });
    },

    async deleteAsset(input) {
      const row = await readAsset(pool, table, input.assetId);
      if (!row) return;
      assertOwner({ principalId: row.principal_id, principalType: row.principal_type ?? undefined, issuer: row.issuer ?? undefined, tenantId: row.tenant_id }, input.owner);
      await options.client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: row.storage_key }));
      await pool.query(`delete from ${table.assets} where asset_id = $1`, [input.assetId]);
    },

    async getQuota(owner) {
      assertOwnerInput(owner);
      const result = await pool.query<{ used_bytes: string; active_upload_bytes: string }>(
        `select
           coalesce(sum(case when status = 'ready' then size_bytes else 0 end), 0)::text as used_bytes,
           coalesce(sum(case when status = 'uploading' then size_bytes else 0 end), 0)::text as active_upload_bytes
         from ${table.assets}
         where tenant_id = $1 and principal_id = $2
           and coalesce(principal_type, '') = $3 and coalesce(issuer, '') = $4`,
        [owner.tenantId, owner.principalId, owner.principalType ?? "", owner.issuer ?? ""],
      );
      return {
        activeUploadBytes: Number(result.rows[0]?.active_upload_bytes ?? 0),
        limitBytes: quotaBytes ?? maxBytes,
        usedBytes: Number(result.rows[0]?.used_bytes ?? 0),
      };
    },

    async bindAssetSession(input) {
      assertIdentifier(input.assetId, "assetId");
      assertIdentifier(input.sessionId, "sessionId");
      assertOwnerInput(input.owner);
      const row = await readAsset(pool, table, input.assetId);
      if (!row) return undefined;
      assertOwner({ principalId: row.principal_id, principalType: row.principal_type ?? undefined, issuer: row.issuer ?? undefined, tenantId: row.tenant_id }, input.owner);
      if (row.session_id === input.sessionId) return toMetadata(row);
      if (!row.session_id.startsWith("browser-") || row.status !== "ready") return undefined;
      const rebound = await pool.query<AssetRow>(
        `update ${table.assets}
            set session_id = $2
          where asset_id = $1 and tenant_id = $3 and principal_id = $4
            and coalesce(principal_type, '') = $5 and coalesce(issuer, '') = $6
            and status = 'ready' and session_id like 'browser-%'
          returning asset_id, tenant_id, principal_id, principal_type, issuer, session_id, message_id,
            filename, media_type, size_bytes, checksum_sha256, storage_key,
            status, scan_status, expires_at, created_at`,
        [input.assetId, input.sessionId, input.owner.tenantId, input.owner.principalId, input.owner.principalType ?? "", input.owner.issuer ?? ""],
      );
      return rebound.rows[0] ? toMetadata(rebound.rows[0]) : undefined;
    },

    async findAsset(assetId, owner) {
      const row = await readAsset(pool, table, assetId);
      if (!row) return undefined;
      assertOwner({ principalId: row.principal_id, principalType: row.principal_type ?? undefined, issuer: row.issuer ?? undefined, tenantId: row.tenant_id }, owner);
      if (row.expires_at && Date.parse(asIso(row.expires_at)) <= Date.now()) return undefined;
      return toMetadata(row);
    },

    async findUpload(uploadId, owner) {
      const row = await readUpload(pool, table, uploadId);
      assertOwner({ principalId: row.principal_id, principalType: row.principal_type ?? undefined, issuer: row.issuer ?? undefined, tenantId: row.tenant_id }, owner);
      const parts = await readParts(pool, table.parts, uploadId);
      return toUpload(row, maxBytes, parts);
    },

    async findUploadByAsset(assetId, owner) {
      const row = await readUploadByAsset(pool, table, assetId);
      if (!row) return undefined;
      assertOwner({ principalId: row.principal_id, principalType: row.principal_type ?? undefined, issuer: row.issuer ?? undefined, tenantId: row.tenant_id }, owner);
      const parts = await readParts(pool, table.parts, row.upload_id);
      return toUpload(row, maxBytes, parts);
    },

    async listAssets(sessionId, owner) {
      assertIdentifier(sessionId, "sessionId");
      assertOwnerInput(owner);
      const result = await pool.query<AssetRow>(
        `select asset_id, tenant_id, principal_id, principal_type, issuer, session_id, message_id,
           filename, media_type, size_bytes, checksum_sha256, storage_key,
           status, scan_status, expires_at, created_at
         from ${table.assets}
         where session_id = $1 and tenant_id = $2 and principal_id = $3
           and coalesce(principal_type, '') = $4 and coalesce(issuer, '') = $5
           and status = 'ready' and scan_status in ('clean', 'disabled')
         order by created_at desc`,
        [sessionId, owner.tenantId, owner.principalId, owner.principalType ?? "", owner.issuer ?? ""],
      );
      return result.rows.map(toMetadata);
    },

    async cleanupExpired(cleanupOptions): Promise<AssetCleanupResult> {
      const now = cleanupOptions?.now ?? new Date();
      const limit = normalizeCleanupLimit(cleanupOptions?.limit);
      let deletedAssets = 0;
      let abortedUploads = 0;

      const expiredAssets = await pool.query<AssetRow>(
        `select asset_id, tenant_id, principal_id, session_id, message_id,
           filename, media_type, size_bytes, checksum_sha256, storage_key,
           status, scan_status, expires_at, created_at
         from ${table.assets}
         where expires_at is not null and expires_at <= $1
           and status in ('ready', 'failed', 'expired')
         order by expires_at asc
         limit $2`,
        [now, limit],
      );
      for (const row of expiredAssets.rows) {
        await options.client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: row.storage_key }));
        await pool.query(`delete from ${table.assets} where asset_id = $1 and status in ('ready', 'failed', 'expired')`, [row.asset_id]);
        deletedAssets += 1;
      }

      const remaining = Math.max(0, limit - deletedAssets);
      if (remaining > 0) {
        const expiredUploads = await pool.query<UploadRow>(
          `select upload.asset_id, upload.upload_id, upload.provider_upload_id,
             upload.tenant_id, upload.principal_id, upload.principal_type, upload.issuer, upload.session_id,
             asset.filename, asset.media_type, asset.storage_key,
             upload.declared_size_bytes, upload.chunk_size_bytes, upload.part_count,
             upload.status, upload.created_at, asset.scan_status, asset.expires_at
           from ${table.uploads} upload
           join ${table.assets} asset on asset.asset_id = upload.asset_id
             where (upload.status = 'uploading'
               or (upload.status = 'completing' and upload.updated_at <= $1::timestamptz - interval '5 minutes'))
             and asset.expires_at is not null and asset.expires_at <= $1::timestamptz
           order by asset.expires_at asc
           limit $2`,
          [now, remaining],
        );
        for (const row of expiredUploads.rows) {
          await withUploadWriteLock(pool, row.upload_id, async (lockedPool) => {
            // Some lightweight host adapters expose only the cleanup query;
            // PostgreSQL re-reads authoritatively under the same lock.
            const current = await readUpload(lockedPool, table, row.upload_id).catch(() => row);
            if (!current || (current.status !== "uploading" && current.status !== "completing")) return;
            const currentUpdatedAt = current.updated_at ? Date.parse(asIso(current.updated_at)) : Number.NaN;
            if (current.status === "completing" && (!Number.isFinite(currentUpdatedAt) || now.getTime() - currentUpdatedAt < COMPLETION_LEASE_MS)) return;
            if (current.provider_upload_id) {
              try {
                await options.client.send(new AbortMultipartUploadCommand({
                  Bucket: options.bucket,
                  Key: current.storage_key,
                  UploadId: current.provider_upload_id,
                }));
              } catch (error) {
                // A stale completion may already have committed the object, in
                // which case S3 returns NoSuchUpload. The idempotent object
                // deletion below is the authoritative cleanup. For a normal
                // upload, retain metadata so the abort can be retried later.
                if (current.status !== "completing") return;
              }
            }
            if (current.status === "completing") {
              try {
                await options.client.send(new DeleteObjectCommand({
                  Bucket: options.bucket,
                  Key: current.storage_key,
                }));
              } catch {
                // Do not lose the only durable pointer to a billed object.
                return;
              }
            }
            await lockedPool.query(`delete from ${table.assets} where asset_id = $1 and status = 'uploading'`, [current.asset_id]);
            abortedUploads += 1;
          });
        }
      }
      return { abortedUploads, deletedAssets };
    },

    async openReadStream(assetId, owner, optionsRead) {
      const row = await readAsset(pool, table, assetId);
      if (!row) return undefined;
      assertOwner({ principalId: row.principal_id, principalType: row.principal_type ?? undefined, issuer: row.issuer ?? undefined, tenantId: row.tenant_id }, owner);
      if (row.status !== "ready"
        || (row.expires_at && Date.parse(asIso(row.expires_at)) <= Date.now())
        || !isScanAllowed(row.scan_status)) return undefined;
      const size = Number(row.size_bytes);
      const range = normalizeRange(optionsRead, size);
      const response = await options.client.send(new GetObjectCommand({
        Bucket: options.bucket,
        Key: row.storage_key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }));
      const body = response.Body as { transformToWebStream?: () => ReadableStream<Uint8Array> } | undefined;
      if (!body?.transformToWebStream) throw new Error("The object store returned no streamable body.");
      const download: AssetDownload = {
        contentLength: Number(response.ContentLength ?? (range ? range.end - range.start + 1 : size)),
        contentType: response.ContentType || row.media_type,
        filename: row.filename,
        stream: body.transformToWebStream(),
      };
      return download;
    },
  };
}

function tableNames(schema: string) {
  const safe = quoteIdentifier(schema);
  return {
    assets: `${safe}."agent_assets"`,
    parts: `${safe}."agent_asset_parts"`,
    uploads: `${safe}."agent_asset_uploads"`,
  };
}

function resolveScanMode(mode: AssetScanMode | undefined, scanner: AssetScanner | undefined): AssetScanMode {
  const resolved = mode ?? (scanner ? "required" : "disabled");
  if (resolved === "required" && !scanner) {
    throw new Error("An AssetScanner is required when asset scanning is enabled.");
  }
  return resolved;
}

async function openS3AssetReadStream(
  client: S3Client,
  bucket: string,
  metadata: AssetRow,
): Promise<ReadableStream<Uint8Array>> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: metadata.storage_key }));
  const body = response.Body as { transformToWebStream?: () => ReadableStream<Uint8Array> } | undefined;
  if (!body?.transformToWebStream) throw new Error("The object store returned no streamable body for scanning.");
  return body.transformToWebStream();
}

type SqlExecutor = Pick<Pool, "query">;

async function readUpload(pool: SqlExecutor, tables: ReturnType<typeof tableNames>, uploadId: string): Promise<UploadRow> {
  assertIdentifier(uploadId, "uploadId");
  const result = await pool.query<UploadRow>(
    `select upload.asset_id, upload.upload_id, upload.provider_upload_id,
       upload.tenant_id, upload.principal_id, upload.principal_type, upload.issuer, upload.session_id,
       asset.filename, asset.media_type, asset.storage_key,
       upload.declared_size_bytes, upload.chunk_size_bytes, upload.part_count,
       upload.status, upload.created_at, upload.updated_at, asset.scan_status, asset.expires_at
     from ${tables.uploads} upload
     join ${tables.assets} asset on asset.asset_id = upload.asset_id
     where upload.upload_id = $1`,
    [uploadId],
  );
  const row = result.rows[0];
  if (!row) throw new AssetStoreError("not_found", "The asset upload was not found.");
  return row;
}

async function readUploadByAsset(
  pool: SqlExecutor,
  tables: ReturnType<typeof tableNames>,
  assetId: string,
): Promise<UploadRow | undefined> {
  assertIdentifier(assetId, "assetId");
  const result = await pool.query<UploadRow>(
    `select upload.asset_id, upload.upload_id, upload.provider_upload_id,
       upload.tenant_id, upload.principal_id, upload.principal_type, upload.issuer, upload.session_id,
       asset.filename, asset.media_type, asset.storage_key,
       upload.declared_size_bytes, upload.chunk_size_bytes, upload.part_count,
       upload.status, upload.created_at, upload.updated_at, asset.scan_status, asset.expires_at
     from ${tables.uploads} upload
     join ${tables.assets} asset on asset.asset_id = upload.asset_id
     where upload.asset_id = $1`,
    [assetId],
  );
  return result.rows[0];
}

async function readAsset(pool: SqlExecutor, tables: ReturnType<typeof tableNames>, assetId: string): Promise<AssetRow | undefined> {
  assertIdentifier(assetId, "assetId");
  const result = await pool.query<AssetRow>(
    `select asset_id, tenant_id, principal_id, principal_type, issuer, session_id, message_id,
       filename, media_type, size_bytes, checksum_sha256, storage_key,
       status, scan_status, expires_at, created_at
     from ${tables.assets} where asset_id = $1`,
    [assetId],
  );
  return result.rows[0];
}

async function readParts(pool: SqlExecutor, table: string, uploadId: string): Promise<PartRow[]> {
  const result = await pool.query<PartRow>(
    `select part_number, size_bytes, etag from ${table} where upload_id = $1 order by part_number asc`,
    [uploadId],
  );
  return result.rows;
}

async function upsertPart(
  pool: SqlExecutor,
  table: string,
  input: {
    readonly etag: string;
    readonly partNumber: number;
    readonly sizeBytes: number;
    readonly storageKey: string;
    readonly uploadId: string;
  },
): Promise<void> {
  await pool.query(
    `insert into ${table} (upload_id, part_number, size_bytes, etag, storage_key)
     values ($1, $2, $3, $4, $5)
     on conflict (upload_id, part_number)
     do update set size_bytes = excluded.size_bytes, etag = excluded.etag,
                   storage_key = excluded.storage_key, created_at = now()`,
    [input.uploadId, input.partNumber, input.sizeBytes, input.etag, input.storageKey],
  );
}

async function reconcileCompletionParts(
  pool: SqlExecutor,
  table: string,
  row: UploadRow,
  uploadId: string,
  parts: readonly AssetPart[],
): Promise<void> {
  if (parts.length !== row.part_count) {
    throw new AssetStoreError("invalid", "The completion payload must acknowledge every asset part.");
  }
  const seen = new Set<number>();
  for (const part of parts) {
    if (seen.has(part.partNumber)) throw new AssetStoreError("invalid", "The completion payload contains duplicate asset parts.");
    seen.add(part.partNumber);
    assertExpectedPart(row, part.partNumber, part.sizeBytes);
    const etag = normalizeEtag(part.etag ?? "");
    await upsertPart(pool, table, {
      etag,
      partNumber: part.partNumber,
      sizeBytes: part.sizeBytes,
      storageKey: row.storage_key,
      uploadId,
    });
  }
}

async function sumParts(pool: SqlExecutor, table: string, uploadId: string, replacingPart: number): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `select coalesce(sum(size_bytes), 0)::text as total
       from ${table} where upload_id = $1 and part_number <> $2`,
    [uploadId, replacingPart],
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function withUploadWriteLock<T>(
  pool: Pool,
  uploadId: string,
  operation: (pool: Pool | PoolClient) => Promise<T>,
): Promise<T> {
  // The in-memory/fake stores used by hosts and unit tests may expose only
  // query(). They retain their host-neutral behavior; the built-in PostgreSQL
  // adapter enables the stronger transactional lock when connect() exists.
  if (typeof (pool as unknown as { connect?: unknown }).connect !== "function") {
    return await operation(pool);
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`open-agent:asset-upload:${uploadId}`],
    );
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function hashObject(client: S3Client, bucket: string, key: string): Promise<string> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = response.Body as AsyncIterable<Uint8Array> | undefined;
  if (!body) throw new Error("The object store returned no body while verifying the asset.");
  const hash = createHash("sha256");
  for await (const chunk of body) hash.update(chunk);
  return hash.digest("hex");
}

async function objectMatches(client: S3Client, bucket: string, row: UploadRow): Promise<boolean> {
  try {
    const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: row.storage_key }));
    const metadata = response.Metadata ?? {};
    return Number(response.ContentLength) === Number(row.declared_size_bytes)
      && metadata.asset === metadataDigest(row.asset_id)
      && metadata.tenant === metadataDigest(row.tenant_id)
      && metadata.principal === metadataDigest(row.principal_id)
      && metadata.principaltype === metadataDigest(row.principal_type ?? "")
      && metadata.issuer === metadataDigest(row.issuer ?? "")
      && metadata.session === metadataDigest(row.session_id);
  } catch {
    return false;
  }
}

function toMetadata(row: AssetRow): AssetMetadata {
  return {
    assetId: row.asset_id,
    checksumSha256: row.checksum_sha256 ?? undefined,
    createdAt: asIso(row.created_at),
    expiresAt: row.expires_at ? asIso(row.expires_at) : undefined,
    filename: row.filename,
    mediaType: row.media_type,
    messageId: row.message_id ?? undefined,
    principalId: row.principal_id,
    ...(row.principal_type ? { principalType: row.principal_type } : {}),
    ...(row.issuer ? { issuer: row.issuer } : {}),
    sessionId: row.session_id,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    storageKey: row.storage_key,
    tenantId: row.tenant_id,
    scanStatus: normalizeScanStatus(row.scan_status),
  };
}

function toUpload(row: UploadRow, maxBytes: number, parts: readonly PartRow[] = []): AssetUpload {
  return {
    assetId: row.asset_id,
    chunkSizeBytes: row.chunk_size_bytes,
    createdAt: asIso(row.created_at),
    filename: row.filename,
    mediaType: row.media_type,
    maxBytes,
    partCount: row.part_count,
    parts: parts.map((part) => ({
      ...(part.etag ? { etag: part.etag } : {}),
      partNumber: part.part_number,
      sizeBytes: part.size_bytes,
    })),
    sizeBytes: Number(row.declared_size_bytes),
    ...(row.scan_status ? { scanStatus: row.scan_status as AssetUpload["scanStatus"] } : {}),
    status: row.status === "completing" ? "uploading" : row.status,
    transferStrategy: "direct",
    uploadId: row.upload_id,
    owner: {
      ...(row.issuer ? { issuer: row.issuer } : {}),
      principalId: row.principal_id,
      ...(row.principal_type ? { principalType: row.principal_type } : {}),
      tenantId: row.tenant_id,
    },
  };
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizePrefix(value: string | undefined): string {
  const normalized = (value?.trim() || "open-agent").replace(/^\/+|\/+$/gu, "");
  if (!normalized || normalized.includes("..") || normalized.includes("\\") || /[^A-Za-z0-9/_-]/u.test(normalized)) {
    throw new Error("The Agent asset S3 prefix is invalid.");
  }
  return normalized;
}

function normalizeScanStatus(value: string | null | undefined): AssetMetadata["scanStatus"] {
  return value === "disabled" || value === "pending" || value === "scanning" || value === "clean" || value === "rejected" || value === "error"
    ? value
    : "pending";
}

function isScanAllowed(value: string | null | undefined): boolean {
  return value === "clean" || value === "disabled";
}

function normalizeRange(options: AssetReadOptions | undefined, size: number): { start: number; end: number } | undefined {
  if (options?.start === undefined && options?.end === undefined) return undefined;
  const start = Math.max(0, Math.floor(options?.start ?? 0));
  const end = Math.min(size - 1, Math.floor(options?.end ?? size - 1));
  if (start > end || start >= size) throw new AssetStoreError("invalid", "The requested asset byte range is invalid.");
  return { end, start };
}

function assertCreateUploadInput(input: {
  readonly assetId?: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly owner: AssetOwner;
  readonly sizeBytes: number;
  readonly sessionId: string;
}, maxBytes: number) {
  if (input.assetId !== undefined) assertIdentifier(input.assetId, "assetId");
  assertFilename(input.filename);
  if (!input.mediaType || input.mediaType.length > 200) throw new AssetStoreError("invalid", "The asset media type is invalid.");
  assertOwnerInput(input.owner);
  assertIdentifier(input.sessionId, "sessionId");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) throw new AssetStoreError("invalid", "The asset size must be a positive integer.");
  if (input.sizeBytes > maxBytes) throw new AssetStoreError("quota", `The asset exceeds the ${maxBytes} byte quota.`);
}

function assertOwnerInput(owner: AssetOwner) {
  assertAssetIdentifier(owner.tenantId, "tenantId");
  assertAssetPrincipalIdentifier(owner.principalId, "principalId");
  if (owner.principalType !== undefined) assertAssetPrincipalIdentifier(owner.principalType, "principalType");
  if (owner.issuer !== undefined) assertAssetPrincipalIdentifier(owner.issuer, "issuer");
}

function assertOwner(expected: AssetOwner, actual: AssetOwner) {
  assertOwnerInput(actual);
  if (expected.tenantId !== actual.tenantId || expected.principalId !== actual.principalId
    || (expected.principalType !== undefined && expected.principalType !== actual.principalType)
    || (expected.issuer ?? "") !== (actual.issuer ?? "")) {
    throw new AssetStoreError("forbidden", "The authenticated principal cannot access this asset.");
  }
}

function assertIdentifier(value: string, name: string) {
  assertAssetIdentifier(value, name);
}

function assertPartNumber(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new AssetStoreError("invalid", "The asset part number must be a positive integer.");
}

function assertWritablePart(row: UploadRow, partNumber: number, sizeBytes: number): void {
  if (row.status !== "uploading" || !row.provider_upload_id) {
    throw new AssetStoreError("conflict", "The asset upload is no longer writable.");
  }
  assertExpectedPart(row, partNumber, sizeBytes);
}

function assertExpectedPart(row: UploadRow, partNumber: number, sizeBytes: number): void {
  assertPartNumber(partNumber);
  if (partNumber > row.part_count) {
    throw new AssetStoreError("invalid", "The asset part number exceeds the declared object size.");
  }
  const expected = partNumber === row.part_count
    ? Number(row.declared_size_bytes) - row.chunk_size_bytes * (row.part_count - 1)
    : row.chunk_size_bytes;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes !== expected) {
    throw new AssetStoreError("invalid", `Asset part ${partNumber} must contain exactly ${expected} bytes.`);
  }
}

function normalizeEtag(value: string): string {
  const normalized = value.trim().replace(/^"|"$/gu, "");
  if (!/^[A-Za-z0-9+/_=:.-]{1,256}$/u.test(normalized)) {
    throw new AssetStoreError("invalid", "The object-store part ETag is invalid.");
  }
  return normalized;
}

function ownerFromUploadRow(row: UploadRow): AssetOwner {
  return {
    ...(row.issuer ? { issuer: row.issuer } : {}),
    principalId: row.principal_id,
    ...(row.principal_type ? { principalType: row.principal_type } : {}),
    tenantId: row.tenant_id,
  };
}

function metadataDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertFilename(value: string) {
  if (value.length === 0 || value.length > 255 || value === "." || value === ".." || value.includes("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AssetStoreError("invalid", "The asset filename is invalid.");
  }
}

function storageFailure(error: unknown): AssetStoreError {
  const name = error instanceof Error ? error.name : "unknown";
  return new AssetStoreError("invalid", `The object storage operation failed (${name}).`);
}

function normalizeCleanupLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new AssetStoreError("invalid", "The asset cleanup limit must be between 1 and 10000.");
  }
  return value;
}

function normalizeConfiguredMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? MAX_ASSET_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ASSET_BYTES) {
    throw new Error("The AssetStore maxBytes must be between 1 byte and 10 GiB.");
  }
  return maxBytes;
}

function normalizeConfiguredQuotaBytes(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ASSET_BYTES * 1_000) {
    throw new Error("The S3 AssetStore quotaBytes must be between 1 byte and 10 TiB.");
  }
  return value;
}

function normalizeUploadUrlExpiry(value: number | undefined): number {
  const seconds = value ?? 15 * 60;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 60 * 60) {
    throw new Error("The S3 upload URL expiry must be between 60 and 3600 seconds.");
  }
  return seconds;
}

async function beginQuotaTransaction(
  pool: Pool,
  owner: AssetOwner,
  quotaBytes: number,
  requestedBytes: number,
  tables: ReturnType<typeof tableNames>,
): Promise<{ readonly client: PoolClient; readonly query: PoolClient["query"] }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Serialize reservations for one principal without blocking unrelated tenants.
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${owner.tenantId}:${owner.principalId}`],
    );
    const result = await client.query<{ used_bytes: string; active_upload_bytes: string }>(
      `select
         coalesce(sum(case when status = 'ready' then size_bytes else 0 end), 0)::text as used_bytes,
         coalesce(sum(case when status = 'uploading' then size_bytes else 0 end), 0)::text as active_upload_bytes
       from ${tables.assets}
       where tenant_id = $1 and principal_id = $2
         and coalesce(principal_type, '') = $3 and coalesce(issuer, '') = $4`,
      [owner.tenantId, owner.principalId, owner.principalType ?? "", owner.issuer ?? ""],
    );
    const usedBytes = Number(result.rows[0]?.used_bytes ?? 0);
    const activeUploadBytes = Number(result.rows[0]?.active_upload_bytes ?? 0);
    if (usedBytes + activeUploadBytes + requestedBytes > quotaBytes) {
      throw new AssetStoreError("quota", "The authenticated principal has exceeded its aggregate asset quota.");
    }
    return { client, query: client.query.bind(client) };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    client.release();
    throw error;
  }
}
