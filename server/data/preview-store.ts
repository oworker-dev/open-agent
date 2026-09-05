import type { Pool } from "pg";
import type { AssetStore } from "@oworker/open-agent-contracts/asset";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  getAgentDatabasePool,
  quoteIdentifier,
  readAgentDatabaseConfig,
  type AgentDatabaseConfig,
} from "./agent-database.ts";
import type { PublicationOwner } from "./artifact-store.ts";
import { createAssetStoreFromEnvironment } from "./asset-store.ts";
import {
  deletePublicationObjects,
  readPublicationObject,
  writePublicationObject,
} from "./publication-object.ts";
import { iterateDirectoryEntries } from "./filesystem-directory.ts";
import { normalizePublicationMetadata } from "./publication-metadata.ts";

const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

export type PreviewFileInput = {
  readonly content: Uint8Array;
  readonly mediaType: string;
  readonly path: string;
};

export type PreviewRecord = {
  readonly alias?: string;
  readonly createdAt: string;
  readonly entrypoint: string;
  readonly expiresAt: string;
  readonly fileCount: number;
  readonly previewId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly totalBytes: number;
  readonly version?: string;
};

export type PreviewFile = {
  readonly content: Uint8Array;
  readonly mediaType: string;
  readonly path: string;
};

type PersistedPreviewFile = {
  readonly assetId?: string;
  readonly file: PreviewFileInput;
};

export interface PreviewStore {
  create(input: {
    readonly alias?: string;
    readonly entrypoint: string;
    readonly expiresAt: Date;
    readonly files: readonly PreviewFileInput[];
    readonly previewId?: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly tenantId: string;
    readonly version?: string;
  }): Promise<PreviewRecord>;
  find(previewId: string): Promise<PreviewRecord | undefined>;
  list(sessionId: string, owner: PublicationOwner): Promise<readonly PreviewRecord[]>;
  readFile(previewId: string, path: string): Promise<PreviewFile | undefined>;
  cleanupExpired?(options?: { readonly limit?: number; readonly now?: Date }): Promise<number>;
}

export function createPostgresPreviewStore(
  config: AgentDatabaseConfig,
  assetStore?: AssetStore,
): PreviewStore {
  const pool = getAgentDatabasePool(config);
  const previews = `${quoteIdentifier(config.schema)}."agent_previews"`;
  const files = `${quoteIdentifier(config.schema)}."agent_preview_files"`;
  return postgresPreviewStore(pool, previews, files, assetStore);
}

export function createPostgresPreviewStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PreviewStore | undefined {
  const config = readAgentDatabaseConfig(environment);
  return config
    ? createPostgresPreviewStore(config, createAssetStoreFromEnvironment(environment))
    : undefined;
}

export function createPreviewStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PreviewStore {
  const config = readAgentDatabaseConfig(environment);
  if (config) return createPostgresPreviewStore(config, createAssetStoreFromEnvironment(environment));
  const configuredRoot = environment.AGENT_PREVIEW_STORAGE_PATH?.trim();
  return createFilesystemPreviewStore(
    configuredRoot ? resolve(configuredRoot) : resolve(process.cwd(), ".eve", "previews"),
  );
}

function postgresPreviewStore(
  pool: Pool,
  previews: string,
  files: string,
  assetStore?: AssetStore,
): PreviewStore {
  return {
    async create(input) {
      assertPreviewInput(input);
      const metadata = normalizePublicationMetadata(input);
      const previewId = input.previewId ?? `prv_${randomUUID()}`;
      const owner = { principalId: input.principalId, tenantId: input.tenantId };
      const persisted: readonly PersistedPreviewFile[] = assetStore
        ? await persistPreviewFiles(assetStore, input.files, {
            expiresAt: input.expiresAt,
            owner,
            sessionId: input.sessionId,
          })
        : input.files.map((file) => ({ file }));
      try {
        return await withTransaction(pool, async (client) => {
          const result = await client.query<PreviewRow>(
            `insert into ${previews}
              (preview_id, session_id, tenant_id, principal_id, entrypoint, expires_at, file_count, total_bytes, alias, version)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             returning preview_id, session_id, tenant_id, principal_id, entrypoint,
               expires_at, created_at, file_count, total_bytes, alias, version`,
            [
              previewId,
              input.sessionId,
              input.tenantId,
              input.principalId,
              input.entrypoint,
              input.expiresAt,
              input.files.length,
              input.files.reduce((total, file) => total + file.content.byteLength, 0),
              metadata.alias ?? null,
              metadata.version ?? null,
            ],
          );
          for (const item of persisted) {
            await client.query(
              `insert into ${files} (preview_id, path, media_type, content, asset_id)
               values ($1, $2, $3, $4, $5)`,
              [
                previewId,
                item.file.path,
                item.file.mediaType,
                item.assetId ? null : Buffer.from(item.file.content),
                item.assetId ?? null,
              ],
            );
          }
          return toRecord(result.rows[0]);
        });
      } catch (error) {
        if (assetStore) {
          await deletePublicationObjects(
            assetStore,
            persisted.flatMap((item) => item.assetId ? [item.assetId] : []),
            owner,
          ).catch(() => undefined);
        }
        throw error;
      }
    },
    async find(previewId) {
      const result = await pool.query<PreviewRow>(
        `select preview_id, session_id, tenant_id, principal_id, entrypoint,
           expires_at, created_at, file_count, total_bytes, alias, version
         from ${previews}
         where preview_id = $1`,
        [previewId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async list(sessionId, owner) {
      assertListInput(sessionId, owner);
      const result = await pool.query<PreviewRow>(
        `select preview_id, session_id, tenant_id, principal_id, entrypoint,
           expires_at, created_at, file_count, total_bytes, alias, version
         from ${previews}
         where session_id = $1 and tenant_id = $2 and principal_id = $3 and expires_at > now()
         order by created_at desc
         limit 200`,
        [sessionId, owner.tenantId, owner.principalId],
      );
      return result.rows.map(toRecord);
    },
    async readFile(previewId, path) {
      const result = await pool.query<{
        asset_id: string | null;
        content: Buffer | null;
        media_type: string;
        path: string;
        principal_id: string;
        tenant_id: string;
      }>(
        `select file.path, file.media_type, file.content, file.asset_id,
           preview.tenant_id, preview.principal_id
         from ${files} file
         join ${previews} preview on preview.preview_id = file.preview_id
         where file.preview_id = $1 and file.path = $2`,
        [previewId, path],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const content = row.asset_id && assetStore
        ? await readPublicationObject({
            assetId: row.asset_id,
            assetStore,
            maximumBytes: MAX_PREVIEW_BYTES,
            owner: { principalId: row.principal_id, tenantId: row.tenant_id },
          })
        : row.content ?? undefined;
      return content ? { content, mediaType: row.media_type, path: row.path } : undefined;
    },
    async cleanupExpired(options) {
      const limit = normalizeCleanupLimit(options?.limit);
      const now = options?.now ?? new Date();
      const result = await pool.query(
        `with expired as (
            select preview_id from ${previews}
             where expires_at <= $1
             order by expires_at, preview_id
             limit $2
             for update skip locked
          )
          delete from ${previews} preview
          using expired
          where preview.preview_id = expired.preview_id`,
        [now, limit],
      );
      return result.rowCount ?? 0;
    },
  };
}

async function persistPreviewFiles(
  assetStore: AssetStore,
  files: readonly PreviewFileInput[],
  input: {
    readonly expiresAt: Date;
    readonly owner: PublicationOwner;
    readonly sessionId: string;
  },
): Promise<readonly PersistedPreviewFile[]> {
  const results: Array<PersistedPreviewFile | undefined> = new Array(files.length);
  let cursor = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const file = files[index];
        if (!file) return;
        if (file.content.byteLength === 0) {
          results[index] = { file };
          continue;
        }
        const assetId = await writePublicationObject({
          assetStore,
          content: file.content,
          expiresAt: input.expiresAt,
          filename: file.path.slice(file.path.lastIndexOf("/") + 1),
          mediaType: file.mediaType,
          owner: input.owner,
          sessionId: input.sessionId,
        });
        results[index] = { assetId, file };
      }
    }));
    return results as PersistedPreviewFile[];
  } catch (error) {
    await deletePublicationObjects(
      assetStore,
      results.flatMap((item) => item?.assetId ? [item.assetId] : []),
      input.owner,
    ).catch(() => undefined);
    throw error;
  }
}

function createFilesystemPreviewStore(root: string): PreviewStore {
  return {
    async create(input) {
      assertPreviewInput(input);
      const metadata = normalizePublicationMetadata(input);
      const previewId = input.previewId ?? `prv_${randomUUID()}`;
      const record: PreviewRecord = {
        ...metadata,
        createdAt: new Date().toISOString(),
        entrypoint: input.entrypoint,
        expiresAt: input.expiresAt.toISOString(),
        fileCount: input.files.length,
        previewId,
        principalId: input.principalId,
        sessionId: input.sessionId,
        tenantId: input.tenantId,
        totalBytes: input.files.reduce((total, file) => total + file.content.byteLength, 0),
      };
      const directory = join(root, previewId);
      await mkdir(join(directory, "files"), { recursive: true });
      for (const file of input.files) {
        const destination = join(directory, "files", file.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.content, { flag: "wx" });
      }
      await writeFile(join(directory, "meta.json"), JSON.stringify(record), { flag: "wx" });
      return record;
    },
    async find(previewId) {
      try {
        const value = JSON.parse(await readFile(join(root, previewId, "meta.json"), "utf8")) as PreviewRecord;
        return isPreviewRecord(value) ? value : undefined;
      } catch {
        return undefined;
      }
    },
    async list(sessionId, owner) {
      assertListInput(sessionId, owner);
      const entries = [];
      for await (const entry of iterateDirectoryEntries(root)) {
        if (!entry.isDirectory() || !/^prv_[a-f0-9-]{36}$/u.test(entry.name)) continue;
        entries.push(entry);
        if (entries.length >= 2_000) break;
      }
      const records = await Promise.all(entries.map((entry) => this.find(entry.name)));
      const now = Date.now();
      return records
        .filter((record): record is PreviewRecord => Boolean(
          record
          && record.sessionId === sessionId
          && record.tenantId === owner.tenantId
          && record.principalId === owner.principalId
          && new Date(record.expiresAt).getTime() > now,
        ))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 200);
    },
    async readFile(previewId, path) {
      if (!safePath(path)) return undefined;
      try {
        const preview = await this.find(previewId);
        if (!preview) return undefined;
        const content = await readFile(join(root, previewId, "files", path));
        return { content, mediaType: mediaTypeFromPath(path), path };
      } catch {
        return undefined;
      }
    },
    async cleanupExpired(options) {
      const limit = normalizeCleanupLimit(options?.limit);
      const now = options?.now?.getTime() ?? Date.now();
      let deleted = 0;
      for await (const entry of iterateDirectoryEntries(root)) {
        if (deleted >= limit) break;
        if (!entry.isDirectory()) continue;
        const record = await this.find(entry.name);
        if (!record || Date.parse(record.expiresAt) > now) continue;
        await rm(join(root, entry.name), { force: true, recursive: true });
        deleted += 1;
      }
      return deleted;
    },
  };
}

type PreviewRow = {
  alias?: string | null;
  created_at: Date | string;
  entrypoint: string;
  expires_at: Date | string;
  file_count: number;
  preview_id: string;
  principal_id: string;
  session_id: string;
  tenant_id: string;
  total_bytes: number | string;
  version?: string | null;
};

function toRecord(row: PreviewRow): PreviewRecord {
  if (!row) throw new Error("The preview store returned no created preview.");
  return {
    ...(row.alias ? { alias: row.alias } : {}),
    createdAt: asIso(row.created_at),
    entrypoint: row.entrypoint,
    expiresAt: asIso(row.expires_at),
    fileCount: row.file_count,
    previewId: row.preview_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    totalBytes: asByteCount(row.total_bytes),
    ...(row.version ? { version: row.version } : {}),
  };
}

function assertPreviewInput(input: {
  readonly alias?: string;
  readonly entrypoint: string;
  readonly expiresAt: Date;
  readonly files: readonly PreviewFileInput[];
  readonly principalId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly version?: string;
}): void {
  normalizePublicationMetadata(input);
  if (!input.sessionId || !input.tenantId || !input.principalId) {
    throw new Error("A preview requires a session and authenticated owner.");
  }
  if (!input.entrypoint || !safePath(input.entrypoint)) throw new Error("The preview entrypoint is invalid.");
  if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= new Date()) {
    throw new Error("The preview expiration must be in the future.");
  }
  if (input.files.length === 0 || input.files.length > 1_000) {
    throw new Error("A preview requires between 1 and 1000 files.");
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of input.files) {
    if (!safePath(file.path) || paths.has(file.path)) throw new Error("Preview files contain a duplicate or unsafe path.");
    if (!file.mediaType || file.content.byteLength > 10 * 1024 * 1024) throw new Error("A preview file is invalid or too large.");
    totalBytes += file.content.byteLength;
    paths.add(file.path);
  }
  if (totalBytes === 0 || totalBytes > MAX_PREVIEW_BYTES) {
    throw new Error("A preview must contain between 1 byte and 25 MiB.");
  }
}

function assertListInput(sessionId: string, owner: PublicationOwner): void {
  if (!sessionId || sessionId.length > 512 || !owner.tenantId || !owner.principalId) {
    throw new Error("A publication list requires a valid session and authenticated owner.");
  }
}

function safePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..") && !value.split("/").includes("");
}

function normalizeCleanupLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("Preview cleanup limit must be an integer from 1 to 10000.");
  }
  return limit;
}

function isPreviewRecord(value: unknown): value is PreviewRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PreviewRecord>;
  return typeof record.previewId === "string"
    && (record.alias === undefined || typeof record.alias === "string")
    && typeof record.entrypoint === "string"
    && typeof record.expiresAt === "string"
    && typeof record.createdAt === "string"
    && typeof record.fileCount === "number"
    && typeof record.totalBytes === "number"
    && typeof record.sessionId === "string"
    && typeof record.tenantId === "string"
    && typeof record.principalId === "string"
    && (record.version === undefined || typeof record.version === "string");
}

function asByteCount(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("The preview size is invalid.");
  return parsed;
}

function mediaTypeFromPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({
    css: "text/css; charset=utf-8",
    gif: "image/gif",
    html: "text/html; charset=utf-8",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    wav: "audio/wav",
    webm: "video/webm",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function withTransaction<T>(pool: Pool, fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await fn(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
