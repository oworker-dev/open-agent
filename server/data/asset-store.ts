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
import { S3Client } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import { readAgentDatabaseConfig } from "./agent-database.ts";
import {
  ASSET_CHUNK_SIZE_BYTES,
  assertAssetIdentifier,
  assertAssetPrincipalIdentifier,
  AssetStoreError,
  type AssetScanMode,
  DEFAULT_ASSET_TTL_SECONDS,
  MAX_ASSET_BYTES,
  MAX_ASSET_PART_BYTES,
  scanAsset,
} from "./asset-store-core.ts";
import { createS3AssetStore } from "./s3-asset-store.ts";
import { createClamAvAssetScannerFromEnvironment } from "./clamav-asset-scanner.ts";

export {
  ASSET_CHUNK_SIZE_BYTES,
  AssetStoreError,
  DEFAULT_ASSET_TTL_SECONDS,
  MAX_ASSET_BYTES,
  MAX_ASSET_PART_BYTES,
} from "./asset-store-core.ts";

type UploadRecord = Omit<AssetUpload, "parts"> & {
  readonly expiresAt?: string;
  readonly messageId?: string;
  readonly sessionId: string;
  readonly parts: Record<string, AssetPart>;
};

type FilesystemAssetStoreOptions = {
  readonly maxBytes?: number;
  /** Optional aggregate quota per authenticated tenant/principal pair. */
  readonly quotaBytes?: number;
  readonly root: string;
  /** Host scanner for untrusted uploads. Omitted in explicit development mode. */
  readonly scanner?: AssetScanner;
  readonly scanMode?: AssetScanMode;
};

let configuredHostAssetStore: AssetStore | undefined;
let configuredScannerGeneration = 0;
let cachedS3AssetStore: {
  readonly client: S3Client;
  readonly fingerprint: string;
  readonly store: AssetStore;
} | undefined;
// Requests construct the filesystem adapter lazily, so this lock registry
// must live at module scope. A per-store map would not protect two concurrent
// HTTP requests that each resolve the environment into a fresh adapter.
const filesystemQuotaLocks = new Map<string, Promise<void>>();
// The filesystem adapter is a development/custom-host implementation, but it
// can still receive concurrent HTTP requests. Serialize mutations for one
// upload/asset so metadata cannot be lost between read and atomic rename.
const filesystemLifecycleLocks = new Map<string, Promise<void>>();

/**
 * Host bootstrap hook. Muses or another deployment can register an S3/R2/GCS
 * implementation before serving requests; the Open Agent kernel does not
 * import that host's SDK or credential vault.
 */
export function configureAssetStore(store: AssetStore): void {
  closeBuiltInS3AssetStore();
  configuredHostAssetStore = store;
}

/**
 * Development adapter. It mirrors the object-storage contract using files and
 * JSON metadata, and never stores asset bytes in PostgreSQL or Eve messages.
 * The same AssetStore interface is intended for an S3/R2/GCS implementation.
 */
export function createFilesystemAssetStore(options: FilesystemAssetStoreOptions): AssetStore {
  const root = resolve(options.root);
  const maxBytes = normalizeConfiguredMaxBytes(options.maxBytes);
  const quotaBytes = normalizeConfiguredQuotaBytes(options.quotaBytes);
  const scanMode = resolveScanMode(options.scanMode, options.scanner);
  // Keep the development adapter's quota reservation atomic for concurrent
  // requests in one process. Production S3 uses a PostgreSQL reservation lock.

  return {
    async createUpload(input) {
      assertCreateUploadInput(input, maxBytes);
      const create = async (): Promise<AssetUpload> => {
        const assetId = input.assetId ?? `asset_${randomUUID()}`;
        const uploadId = `upl_${randomUUID()}`;
        const createdAt = new Date().toISOString();
        const expiresAt = input.expiresAt?.toISOString() ?? new Date(Date.now() + DEFAULT_ASSET_TTL_SECONDS * 1000).toISOString();
        const record: UploadRecord = {
          assetId,
          chunkSizeBytes: ASSET_CHUNK_SIZE_BYTES,
          createdAt,
          expiresAt,
          filename: input.filename,
          mediaType: input.mediaType,
          maxBytes,
          messageId: input.messageId,
          owner: input.owner,
          partCount: Math.ceil(input.sizeBytes / ASSET_CHUNK_SIZE_BYTES),
          sizeBytes: input.sizeBytes,
          status: "uploading",
          scanStatus: scanMode === "disabled" ? "disabled" : "pending",
          transferStrategy: "proxy",
          uploadId,
          sessionId: input.sessionId,
          parts: {},
        };
        await mkdir(join(root, "uploads", uploadId, "parts"), { recursive: true });
        await writeJson(uploadPath(root, uploadId), record);
        return publicUpload(record);
      };
      if (quotaBytes === undefined) return create();
      return withOwnerMutex(filesystemQuotaLocks, root, input.owner, async () => {
        const quota = await readFilesystemQuota(root, input.owner, quotaBytes);
        if (quota.usedBytes + quota.activeUploadBytes + input.sizeBytes > quota.limitBytes) {
          throw new AssetStoreError("quota", "The authenticated principal has exceeded its aggregate asset quota.");
        }
        return create();
      });
    },

    async writePart(input) {
      assertIdentifier(input.uploadId, "uploadId");
      assertPartNumber(input.partNumber);
      if (input.content.byteLength === 0 || input.content.byteLength > MAX_ASSET_PART_BYTES) {
        throw new AssetStoreError("quota", `Asset parts must be between 1 byte and ${MAX_ASSET_PART_BYTES} bytes.`);
      }
      return withFilesystemLifecycleLock(root, `upload:${input.uploadId}`, async () => {
        const record = await readUpload(root, input.uploadId);
        assertOwner(record.owner, input.owner);
        if (record.status !== "uploading") throw new AssetStoreError("conflict", "The asset upload is no longer writable.");
        if (input.partNumber > (record.partCount ?? 1)) {
          throw new AssetStoreError("invalid", "The asset part number exceeds the declared object size.");
        }
        const previous = record.parts[String(input.partNumber)];
        const currentTotal = Object.entries(record.parts).reduce(
          (sum, [number, part]) => sum + (Number(number) === input.partNumber ? 0 : part.sizeBytes),
          0,
        ) + input.content.byteLength;
        if (currentTotal > record.sizeBytes) throw new AssetStoreError("quota", "Uploaded parts exceed the declared asset size.");
        const digest = createHash("sha256").update(input.content).digest("hex");
        const part: AssetPart = { etag: digest, partNumber: input.partNumber, sizeBytes: input.content.byteLength };
        const partPath = uploadPartPath(root, input.uploadId, input.partNumber);
        await mkdir(dirname(partPath), { recursive: true });
        await writeFile(partPath, input.content);
        const next: UploadRecord = { ...record, parts: { ...record.parts, [String(input.partNumber)]: part } };
        await writeJson(uploadPath(root, input.uploadId), next);
        return previous && previous.etag === part.etag ? previous : part;
      });
    },

    async completeUpload(input) {
      return withFilesystemLifecycleLock(root, `upload:${input.uploadId}`, async () => {
        const record = await readUpload(root, input.uploadId);
        assertOwner(record.owner, input.owner);
        return withFilesystemLifecycleLock(root, `asset:${record.assetId}`, async () => {
          if (record.status === "ready") {
            const existing = await readAssetMetadata(root, record.assetId);
            if (existing) return existing;
          }
          if (record.status !== "uploading") throw new AssetStoreError("conflict", "The asset upload cannot be completed.");
          const partNumbers = Object.keys(record.parts).map(Number).sort((a, b) => a - b);
          if (partNumbers.length !== record.partCount || partNumbers.some((part, index) => part !== index + 1)) {
            throw new AssetStoreError("invalid", "All asset parts must be uploaded before completion.");
          }
          const totalBytes = partNumbers.reduce((sum, part) => sum + record.parts[String(part)].sizeBytes, 0);
          if (totalBytes !== record.sizeBytes) throw new AssetStoreError("invalid", "Uploaded bytes do not match the declared asset size.");

          const temporaryPath = join(root, "assets", `.complete-${record.assetId}-${randomUUID()}`);
          await mkdir(dirname(temporaryPath), { recursive: true });
          const destination = createWriteStream(temporaryPath, { flags: "wx" });
          const digest = createHash("sha256");
          try {
            for (const partNumber of partNumbers) {
              const source = createReadStream(uploadPartPath(root, input.uploadId, partNumber));
              for await (const chunk of source) {
                digest.update(chunk);
                if (!destination.write(chunk)) await once(destination, "drain");
              }
            }
            destination.end();
            await once(destination, "close");
          } catch (error) {
            destination.destroy();
            await rm(temporaryPath, { force: true });
            throw error;
          }
          const checksumSha256 = digest.digest("hex");
          if (input.checksumSha256 && input.checksumSha256 !== checksumSha256) {
            await rm(temporaryPath, { force: true });
            throw new AssetStoreError("invalid", "The completed asset checksum does not match.");
          }
          const metadata: AssetMetadata = {
            assetId: record.assetId,
            checksumSha256,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            filename: record.filename,
            ...(record.messageId ? { messageId: record.messageId } : {}),
            mediaType: record.mediaType,
            ...(record.owner.principalType ? { principalType: record.owner.principalType } : {}),
            ...(record.owner.issuer ? { issuer: record.owner.issuer } : {}),
            principalId: record.owner.principalId,
            sessionId: record.sessionId,
            sizeBytes: record.sizeBytes,
            status: "ready",
            scanStatus: scanMode === "disabled" ? "disabled" : "scanning",
            storageKey: `assets/${record.assetId}/content`,
            tenantId: record.owner.tenantId,
          };
          const destinationDirectory = join(root, "assets", record.assetId);
          await mkdir(destinationDirectory, { recursive: true });
          await rename(temporaryPath, join(destinationDirectory, "content"));
          await writeJson(join(destinationDirectory, "meta.json"), metadata);
          const scanned = await scanAsset(
            metadata,
            scanMode,
            options.scanner,
            async () => {
              const download = await openFilesystemReadStream(root, metadata);
              if (!download) throw new Error("The asset could not be read for scanning.");
              return download.stream;
            },
          );
          await writeJson(join(destinationDirectory, "meta.json"), scanned);
          await writeJson(uploadPath(root, input.uploadId), {
            ...record,
            scanStatus: scanned.scanStatus,
            status: "ready",
          });
          return scanned;
        });
      });
    },

    async abortUpload(input) {
      await withFilesystemLifecycleLock(root, `upload:${input.uploadId}`, async () => {
        const record = await readUpload(root, input.uploadId);
        assertOwner(record.owner, input.owner);
        if (record.status === "ready") throw new AssetStoreError("conflict", "A completed asset cannot be aborted.");
        await rm(join(root, "uploads", input.uploadId), { force: true, recursive: true });
      });
    },

    async deleteAsset(input) {
      await withFilesystemLifecycleLock(root, `asset:${input.assetId}`, async () => {
        const metadata = await readAssetMetadata(root, input.assetId);
        if (!metadata) return;
        assertOwner({ principalId: metadata.principalId, tenantId: metadata.tenantId }, input.owner);
        await rm(join(root, "assets", input.assetId), { force: true, recursive: true });
      });
    },

    async getQuota(owner) {
      assertOwnerInput(owner);
      let usedBytes = 0;
      let activeUploadBytes = 0;
      const assetsDirectory = join(root, "assets");
      const uploadsDirectory = join(root, "uploads");
      for (const assetId of await childDirectories(assetsDirectory)) {
        const metadata = await readAssetMetadata(root, assetId);
        if (metadata && sameOwner(metadata, owner) && metadata.status === "ready") usedBytes += metadata.sizeBytes;
      }
      for (const uploadId of await childDirectories(uploadsDirectory)) {
        const upload = await readUpload(root, uploadId).catch(() => undefined);
        if (upload && sameOwner(upload.owner, owner) && upload.status === "uploading") activeUploadBytes += upload.sizeBytes;
      }
      return { activeUploadBytes, limitBytes: quotaBytes ?? maxBytes, usedBytes };
    },

    async bindAssetSession(input) {
      assertIdentifier(input.assetId, "assetId");
      assertIdentifier(input.sessionId, "sessionId");
      assertOwnerInput(input.owner);
      return withFilesystemLifecycleLock(root, `asset:${input.assetId}`, async () => {
        const metadata = await readAssetMetadata(root, input.assetId);
        if (!metadata) return undefined;
        assertOwner({ tenantId: metadata.tenantId, principalId: metadata.principalId }, input.owner);
        if (metadata.sessionId === input.sessionId) return metadata;
        if (!metadata.sessionId.startsWith("browser-") || metadata.status !== "ready") return undefined;
        const rebound = { ...metadata, sessionId: input.sessionId } satisfies AssetMetadata;
        await writeJson(join(root, "assets", input.assetId, "meta.json"), rebound);
        return rebound;
      });
    },

    async findAsset(assetId, owner) {
      const metadata = await readAssetMetadata(root, assetId);
      if (!metadata) return undefined;
      assertOwner({ tenantId: metadata.tenantId, principalId: metadata.principalId }, owner);
      if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now()) return undefined;
      return metadata;
    },

    async findUpload(uploadId, owner) {
      const record = await readUpload(root, uploadId).catch((error: unknown) => {
        if (error instanceof AssetStoreError && error.code === "not_found") return undefined;
        throw error;
      });
      if (!record) return undefined;
      assertOwner(record.owner, owner);
      return publicUpload(record);
    },

    async listAssets(sessionId, owner) {
      if (sessionId.trim().length === 0 || sessionId.length > 512) {
        throw new AssetStoreError("invalid", "The session id is invalid.");
      }
      assertOwnerInput(owner);
      const result: AssetMetadata[] = [];
      for (const assetId of await childDirectories(join(root, "assets"))) {
        const metadata = await readAssetMetadata(root, assetId);
        if (
          !metadata
          || metadata.sessionId !== sessionId
          || metadata.status !== "ready"
          // A rejected/error scan is deliberately not a session deliverable,
          // even though its bytes remain retained until expiry/cleanup.
          || (metadata.scanStatus !== "clean" && metadata.scanStatus !== "disabled")
        ) continue;
        if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now()) continue;
        if (!sameOwner(metadata, owner)) continue;
        result.push(metadata);
      }
      return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },

    async cleanupExpired(options): Promise<AssetCleanupResult> {
      const now = options?.now?.getTime() ?? Date.now();
      const limit = normalizeCleanupLimit(options?.limit);
      let deletedAssets = 0;
      let abortedUploads = 0;
      const assetIds = await childDirectories(join(root, "assets"));
      const uploadIds = await childDirectories(join(root, "uploads"));
      const uploads = await Promise.all(uploadIds.map(async (uploadId) => [
        uploadId,
        await readUpload(root, uploadId).catch(() => undefined),
      ] as const));
      for (const assetId of assetIds) {
        if (deletedAssets >= limit) break;
        await withFilesystemLifecycleLock(root, `asset:${assetId}`, async () => {
          const metadata = await readAssetMetadata(root, assetId);
          if (!metadata || !metadata.expiresAt || Date.parse(metadata.expiresAt) > now) return;
          await rm(join(root, "assets", assetId), { force: true, recursive: true });
          for (const [uploadId, upload] of uploads) {
            if (upload?.assetId === assetId) await rm(join(root, "uploads", uploadId), { force: true, recursive: true });
          }
          deletedAssets += 1;
        });
      }

      // A failed client may leave a multipart upload with no completed asset
      // metadata. Remove those records as soon as their own expiry is reached.
      for (const [uploadId] of uploads) {
        if (abortedUploads >= limit) break;
        await withFilesystemLifecycleLock(root, `upload:${uploadId}`, async () => {
          const upload = await readUpload(root, uploadId).catch(() => undefined);
          if (!upload || upload.status !== "uploading" || !upload.expiresAt || Date.parse(upload.expiresAt) > now) return;
          // An upload whose completed asset was removed above is already gone.
          if (!(await stat(join(root, "uploads", uploadId)).catch(() => undefined))) return;
          await rm(join(root, "uploads", uploadId), { force: true, recursive: true });
          abortedUploads += 1;
        });
      }
      return { abortedUploads, deletedAssets };
    },

    async openReadStream(assetId, owner, options) {
      const metadata = await this.findAsset(assetId, owner);
      if (!metadata) return undefined;
      if (metadata.scanStatus !== "clean" && metadata.scanStatus !== "disabled") return undefined;
      const path = join(root, "assets", assetId, "content");
      const file = await stat(path).catch(() => undefined);
      if (!file) return undefined;
      const range = normalizeRange(options, file.size);
      const nodeStream = createReadStream(path, range ? { start: range.start, end: range.end } : undefined);
      return {
        contentLength: range ? range.end - range.start + 1 : file.size,
        contentType: metadata.mediaType,
        filename: metadata.filename,
        stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      } satisfies AssetDownload;
    },
  };
}

async function childDirectories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function openFilesystemReadStream(root: string, metadata: AssetMetadata): Promise<AssetDownload | undefined> {
  const path = join(root, "assets", metadata.assetId, "content");
  const file = await stat(path).catch(() => undefined);
  if (!file) return undefined;
  return {
    contentLength: file.size,
    contentType: metadata.mediaType,
    filename: metadata.filename,
    stream: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
  } satisfies AssetDownload;
}

export function createAssetStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AssetStore {
  if (configuredHostAssetStore) return configuredHostAssetStore;
  const backend = environment.AGENT_ASSET_STORAGE_BACKEND?.trim().toLowerCase();
  const scanner = configuredHostAssetScanner ?? createClamAvAssetScannerFromEnvironment(environment);
  if (backend === "s3" || backend === "object-store" || backend === "object_store") {
    const database = readAgentDatabaseConfig(environment);
    if (!database) throw new Error("S3 AssetStore requires AGENT_DATABASE_URL for metadata.");
    const bucket = requiredAssetValue(environment.AGENT_ASSET_S3_BUCKET || environment.S3_BUCKET, "AGENT_ASSET_S3_BUCKET");
    const accessKeyId = requiredAssetValue(environment.AGENT_ASSET_S3_ACCESS_KEY_ID || environment.S3_ACCESS_KEY_ID, "AGENT_ASSET_S3_ACCESS_KEY_ID");
    const secretAccessKey = requiredAssetValue(environment.AGENT_ASSET_S3_SECRET_ACCESS_KEY || environment.S3_SECRET_ACCESS_KEY, "AGENT_ASSET_S3_SECRET_ACCESS_KEY");
    const endpoint = environment.AGENT_ASSET_S3_ENDPOINT?.trim() || environment.S3_ENDPOINT?.trim();
    const forcePathStyle = parseBoolean(environment.AGENT_ASSET_S3_FORCE_PATH_STYLE, true);
    const region = environment.AGENT_ASSET_S3_REGION?.trim() || environment.S3_REGION?.trim() || "us-east-1";
    const maxBytes = parseAssetMaxBytes(environment.AGENT_ASSET_MAX_BYTES, MAX_ASSET_BYTES);
    const quotaBytes = parseOptionalAssetQuota(environment.AGENT_ASSET_QUOTA_BYTES);
    const prefix = environment.AGENT_ASSET_S3_PREFIX;
    const scanMode = readAssetScanMode(environment);
    const uploadUrlExpiresSeconds = parseUploadUrlExpiry(environment.AGENT_ASSET_UPLOAD_URL_TTL_SECONDS);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      accessKeyId,
      bucket,
      database,
      endpoint,
      forcePathStyle,
      maxBytes,
      prefix,
      quotaBytes,
      region,
      scannerGeneration: configuredScannerGeneration,
      scannerHost: environment.AGENT_ASSET_CLAMAV_HOST?.trim(),
      scannerPort: environment.AGENT_ASSET_CLAMAV_PORT?.trim(),
      scannerTimeoutMs: environment.AGENT_ASSET_CLAMAV_TIMEOUT_MS?.trim(),
      scanMode,
      secretAccessKey,
      uploadUrlExpiresSeconds,
    })).digest("hex");
    if (cachedS3AssetStore?.fingerprint === fingerprint) return cachedS3AssetStore.store;

    closeBuiltInS3AssetStore();
    const client = new S3Client({
      credentials: { accessKeyId, secretAccessKey },
      endpoint,
      forcePathStyle,
      region,
      // Presigned UploadPart commands have no body at signing time. Disable
      // optional SDK checksum synthesis or it signs the empty-body CRC32 and
      // every non-empty browser upload is rejected by S3.
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
    const store = createS3AssetStore({
      bucket,
      client,
      database,
      maxBytes,
      quotaBytes,
      prefix,
      scanner,
      scanMode,
      uploadUrlExpiresSeconds,
    });
    cachedS3AssetStore = { client, fingerprint, store };
    return store;
  }
  if (environment.NODE_ENV === "production" && backend !== "host" && backend !== "external") {
    throw new Error("Production assets require AGENT_ASSET_STORAGE_BACKEND=s3 or a configured host AssetStore adapter; filesystem storage is development-only.");
  }
  if (backend === "host" || backend === "external") {
    throw new Error("AGENT_ASSET_STORAGE_BACKEND requires configureAssetStore() during host bootstrap.");
  }
  if (backend && backend !== "filesystem" && backend !== "fs") {
    throw new Error(`Asset storage backend "${backend}" is not installed. Configure a host AssetStore adapter for production.`);
  }
  const configuredRoot = environment.AGENT_ASSET_STORAGE_PATH?.trim();
  return createFilesystemAssetStore({
    root: configuredRoot ? resolve(configuredRoot) : resolve(process.cwd(), ".eve", "assets"),
    maxBytes: parseAssetMaxBytes(environment.AGENT_ASSET_MAX_BYTES, MAX_ASSET_BYTES),
    quotaBytes: parseOptionalAssetQuota(environment.AGENT_ASSET_QUOTA_BYTES),
    scanner,
    scanMode: readAssetScanMode(environment),
  });
}

let configuredHostAssetScanner: AssetScanner | undefined;

/** Register a host-owned scanner for the built-in S3/filesystem adapters. */
export function configureAssetScanner(scanner: AssetScanner | undefined): void {
  closeBuiltInS3AssetStore();
  configuredScannerGeneration += 1;
  configuredHostAssetScanner = scanner;
}

/** Close the built-in S3 transport pool during host shutdown or test cleanup. */
export function closeAssetStoreResources(): void {
  closeBuiltInS3AssetStore();
}

function closeBuiltInS3AssetStore(): void {
  const cached = cachedS3AssetStore;
  cachedS3AssetStore = undefined;
  cached?.client.destroy();
}

function readAssetScanMode(environment: Readonly<Record<string, string | undefined>>): AssetScanMode {
  const configured = environment.AGENT_ASSET_SCAN_MODE?.trim().toLowerCase();
  if (!configured) return environment.NODE_ENV === "production" ? "required" : "disabled";
  if (configured !== "required" && configured !== "disabled") {
    throw new Error("AGENT_ASSET_SCAN_MODE must be required or disabled.");
  }
  if (environment.NODE_ENV === "production" && configured === "disabled") {
    throw new Error("AGENT_ASSET_SCAN_MODE=disabled is not allowed in production.");
  }
  return configured;
}

function requiredAssetValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for the S3 AssetStore.`);
  return normalized;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback;
  if (value.trim() === "true") return true;
  if (value.trim() === "false") return false;
  throw new Error("AGENT_ASSET_S3_FORCE_PATH_STYLE must be true or false.");
}

function parseAssetMaxBytes(value: string | undefined, fallback: number, maximum = MAX_ASSET_BYTES): number {
  if (!value?.trim()) return fallback;
  const match = /^(\d+)(?:\s*(KiB|MiB|GiB))?$/iu.exec(value.trim());
  if (!match) throw new Error("AGENT_ASSET_MAX_BYTES must be a positive byte count with an optional KiB, MiB, or GiB suffix.");
  const multiplier = match[2]?.toLowerCase() === "kib" ? 1024 : match[2]?.toLowerCase() === "mib" ? 1024 ** 2 : match[2]?.toLowerCase() === "gib" ? 1024 ** 3 : 1;
  const bytes = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maximum) throw new Error(`The configured asset byte limit must be between 1 byte and ${maximum} bytes.`);
  return bytes;
}

function parseOptionalAssetQuota(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  return normalized ? parseAssetMaxBytes(normalized, MAX_ASSET_BYTES * 1_000, MAX_ASSET_BYTES * 1_000) : undefined;
}

function parseUploadUrlExpiry(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 60 || parsed > 3600) {
    throw new Error("AGENT_ASSET_UPLOAD_URL_TTL_SECONDS must be between 60 and 3600.");
  }
  return parsed;
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
    throw new Error("The AssetStore quotaBytes must be between 1 byte and 10 TiB.");
  }
  return value;
}

async function readFilesystemQuota(
  root: string,
  owner: AssetOwner,
  limitBytes: number,
): Promise<{ readonly activeUploadBytes: number; readonly limitBytes: number; readonly usedBytes: number }> {
  let usedBytes = 0;
  let activeUploadBytes = 0;
  for (const assetId of await childDirectories(join(root, "assets"))) {
    const metadata = await readAssetMetadata(root, assetId);
    if (metadata && metadata.tenantId === owner.tenantId && metadata.principalId === owner.principalId && metadata.status === "ready") {
      usedBytes += metadata.sizeBytes;
    }
  }
  for (const uploadId of await childDirectories(join(root, "uploads"))) {
    const upload = await readUpload(root, uploadId).catch(() => undefined);
    if (upload && upload.owner.tenantId === owner.tenantId && upload.owner.principalId === owner.principalId && upload.status === "uploading") {
      activeUploadBytes += upload.sizeBytes;
    }
  }
  return { activeUploadBytes, limitBytes, usedBytes };
}

/** Serialize quota reservations for one owner without blocking other owners. */
async function withOwnerMutex<T>(
  locks: Map<string, Promise<void>>,
  root: string,
  owner: AssetOwner,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${root}\u0000${owner.tenantId}\u0000${owner.principalId}`;
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

/** Serialize one filesystem asset/upload lifecycle mutation in this process. */
async function withFilesystemLifecycleLock<T>(
  root: string,
  resource: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${root}\u0000${resource}`;
  const previous = filesystemLifecycleLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  filesystemLifecycleLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (filesystemLifecycleLocks.get(key) === current) filesystemLifecycleLocks.delete(key);
  }
}

function publicUpload(record: UploadRecord): AssetUpload {
  const { parts, ...upload } = record;
  return {
    ...upload,
    parts: Object.values(parts).sort((left, right) => left.partNumber - right.partNumber),
  };
}

async function readUpload(root: string, uploadId: string): Promise<UploadRecord> {
  assertIdentifier(uploadId, "uploadId");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(uploadPath(root, uploadId), "utf8"));
  } catch {
    throw new AssetStoreError("not_found", "The asset upload was not found.");
  }
  if (!isUploadRecord(value)) throw new AssetStoreError("invalid", "The asset upload metadata is corrupt.");
  return value;
}

async function readAssetMetadata(root: string, assetId: string): Promise<AssetMetadata | undefined> {
  assertIdentifier(assetId, "assetId");
  try {
    const value = JSON.parse(await readFile(join(root, "assets", assetId, "meta.json"), "utf8")) as unknown;
    return isAssetMetadata(value)
      ? { ...value, scanStatus: value.scanStatus ?? "disabled" }
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: "wx" });
  await rename(temporary, path);
}

function uploadPath(root: string, uploadId: string): string {
  return join(root, "uploads", uploadId, "meta.json");
}

function uploadPartPath(root: string, uploadId: string, partNumber: number): string {
  return join(root, "uploads", uploadId, "parts", `${partNumber}.part`);
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
}, maxBytes: number): void {
  if (input.assetId !== undefined) assertIdentifier(input.assetId, "assetId");
  assertFilename(input.filename);
  if (!input.mediaType || input.mediaType.length > 200) throw new AssetStoreError("invalid", "The asset media type is invalid.");
  assertOwnerInput(input.owner);
  assertIdentifier(input.sessionId, "sessionId");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) throw new AssetStoreError("invalid", "The asset size must be a positive integer.");
  if (input.sizeBytes > maxBytes) throw new AssetStoreError("quota", `The asset exceeds the ${maxBytes} byte quota.`);
}

function assertOwnerInput(owner: AssetOwner): void {
  assertAssetIdentifier(owner.tenantId, "tenantId");
  assertAssetPrincipalIdentifier(owner.principalId, "principalId");
  if (owner.principalType !== undefined) assertAssetPrincipalIdentifier(owner.principalType, "principalType");
  if (owner.issuer !== undefined) assertAssetPrincipalIdentifier(owner.issuer, "issuer");
}

function assertOwner(expected: AssetOwner, actual: AssetOwner): void {
  assertOwnerInput(actual);
  if (expected.tenantId !== actual.tenantId || expected.principalId !== actual.principalId
    || (expected.principalType !== undefined && expected.principalType !== actual.principalType)
    || (expected.issuer ?? "") !== (actual.issuer ?? "")) {
    throw new AssetStoreError("forbidden", "The authenticated principal cannot access this asset.");
  }
}

function sameOwner(expected: { readonly tenantId: string; readonly principalId: string; readonly principalType?: string; readonly issuer?: string }, actual: AssetOwner): boolean {
  return expected.tenantId === actual.tenantId
    && expected.principalId === actual.principalId
    && (expected.principalType === undefined || expected.principalType === actual.principalType)
    && (expected.issuer ?? "") === (actual.issuer ?? "");
}

function assertIdentifier(value: string, name: string): void {
  assertAssetIdentifier(value, name);
}

function assertPartNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new AssetStoreError("invalid", "The asset part number must be a positive integer.");
}

function assertFilename(value: string): void {
  if (value.length === 0 || value.length > 255 || value === "." || value === ".." || value.includes("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AssetStoreError("invalid", "The asset filename is invalid.");
  }
}

function isUploadRecord(value: unknown): value is UploadRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<UploadRecord>;
  return typeof item.assetId === "string"
    && typeof item.uploadId === "string"
    && typeof item.filename === "string"
    && typeof item.mediaType === "string"
    && typeof item.sizeBytes === "number"
    && typeof item.chunkSizeBytes === "number"
    && typeof item.sessionId === "string"
    && typeof item.parts === "object"
    && item.owner !== undefined
    && typeof item.owner === "object";
}

function isAssetMetadata(value: unknown): value is AssetMetadata {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AssetMetadata>;
  return typeof item.assetId === "string"
    && typeof item.filename === "string"
    && typeof item.mediaType === "string"
    && typeof item.sizeBytes === "number"
    && typeof item.status === "string"
    && typeof item.storageKey === "string"
    && typeof item.tenantId === "string"
    && typeof item.principalId === "string"
    && typeof item.sessionId === "string";
}

function resolveScanMode(mode: AssetScanMode | undefined, scanner: AssetScanner | undefined): AssetScanMode {
  const resolved = mode ?? (scanner ? "required" : "disabled");
  if (resolved === "required" && !scanner) {
    throw new Error("An AssetScanner is required when asset scanning is enabled.");
  }
  return resolved;
}
