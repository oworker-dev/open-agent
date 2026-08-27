import type { Pool } from "pg";
import type { AssetStore } from "@oworker/open-agent-contracts/asset";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  getAgentDatabasePool,
  quoteIdentifier,
  readAgentDatabaseConfig,
  type AgentDatabaseConfig,
} from "./agent-database.ts";
import { createAssetStoreFromEnvironment } from "./asset-store.ts";
import {
  deletePublicationObjects,
  readPublicationObject,
  writePublicationObject,
} from "./publication-object.ts";

export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export type ArtifactRecord = {
  readonly artifactId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly totalBytes: number;
};

export type ArtifactFile = {
  readonly content: Uint8Array;
  readonly filename: string;
  readonly mediaType: string;
};

export type PublicationOwner = {
  readonly principalId: string;
  readonly tenantId: string;
};

export interface ArtifactStore {
  create(input: {
    readonly artifactId?: string;
    readonly content: Uint8Array;
    readonly expiresAt: Date;
    readonly filename: string;
    readonly mediaType: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly tenantId: string;
  }): Promise<ArtifactRecord>;
  find(artifactId: string): Promise<ArtifactRecord | undefined>;
  list(sessionId: string, owner: PublicationOwner): Promise<readonly ArtifactRecord[]>;
  read(artifactId: string): Promise<ArtifactFile | undefined>;
  cleanupExpired?(options?: { readonly limit?: number; readonly now?: Date }): Promise<number>;
}

export function createArtifactStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ArtifactStore {
  const config = readAgentDatabaseConfig(environment);
  if (config) return createPostgresArtifactStore(config, createAssetStoreFromEnvironment(environment));
  const configuredRoot = environment.AGENT_ARTIFACT_STORAGE_PATH?.trim();
  return createFilesystemArtifactStore(
    configuredRoot ? resolve(configuredRoot) : resolve(process.cwd(), ".eve", "artifacts"),
  );
}

export function createPostgresArtifactStore(
  config: AgentDatabaseConfig,
  assetStore?: AssetStore,
): ArtifactStore {
  const pool = getAgentDatabasePool(config);
  const table = `${quoteIdentifier(config.schema)}."agent_artifacts"`;
  return postgresArtifactStore(pool, table, assetStore);
}

function postgresArtifactStore(pool: Pool, table: string, assetStore?: AssetStore): ArtifactStore {
  return {
    async create(input) {
      assertArtifactInput(input);
      const artifactId = input.artifactId ?? `art_${randomUUID()}`;
      const owner = { principalId: input.principalId, tenantId: input.tenantId };
      const assetId = assetStore
        ? await writePublicationObject({
            assetStore,
            content: input.content,
            expiresAt: input.expiresAt,
            filename: input.filename,
            mediaType: input.mediaType,
            owner,
            sessionId: input.sessionId,
          })
        : undefined;
      try {
        const result = await pool.query<ArtifactRow>(
          `insert into ${table}
            (artifact_id, session_id, tenant_id, principal_id, filename, media_type,
             content, asset_id, expires_at, total_bytes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           returning artifact_id, session_id, tenant_id, principal_id, filename,
             media_type, expires_at, created_at, total_bytes`,
          [
            artifactId,
            input.sessionId,
            input.tenantId,
            input.principalId,
            input.filename,
            input.mediaType,
            assetId ? null : Buffer.from(input.content),
            assetId ?? null,
            input.expiresAt,
            input.content.byteLength,
          ],
        );
        return toRecord(result.rows[0]);
      } catch (error) {
        if (assetStore && assetId) {
          await deletePublicationObjects(assetStore, [assetId], owner).catch(() => undefined);
        }
        throw error;
      }
    },
    async find(artifactId) {
      const result = await pool.query<ArtifactRow>(
        `select artifact_id, session_id, tenant_id, principal_id, filename,
           media_type, expires_at, created_at, total_bytes
         from ${table} where artifact_id = $1`,
        [artifactId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async list(sessionId, owner) {
      assertListInput(sessionId, owner);
      const result = await pool.query<ArtifactRow>(
        `select artifact_id, session_id, tenant_id, principal_id, filename,
           media_type, expires_at, created_at, total_bytes
         from ${table}
         where session_id = $1 and tenant_id = $2 and principal_id = $3 and expires_at > now()
         order by created_at desc
         limit 200`,
        [sessionId, owner.tenantId, owner.principalId],
      );
      return result.rows.map(toRecord);
    },
    async read(artifactId) {
      const result = await pool.query<ArtifactRow>(
        `select artifact_id, session_id, tenant_id, principal_id, filename,
           media_type, expires_at, created_at, total_bytes, content, asset_id
         from ${table} where artifact_id = $1`,
        [artifactId],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const content = row.asset_id && assetStore
        ? await readPublicationObject({
            assetId: row.asset_id,
            assetStore,
            maximumBytes: MAX_ARTIFACT_BYTES,
            owner: { principalId: row.principal_id, tenantId: row.tenant_id },
          })
        : row.content ?? undefined;
      return content
        ? { content, filename: row.filename, mediaType: row.media_type }
        : undefined;
    },
    async cleanupExpired(options) {
      const limit = normalizeCleanupLimit(options?.limit);
      const now = options?.now ?? new Date();
      const result = await pool.query(
        `with expired as (
            select artifact_id from ${table}
             where expires_at <= $1
             order by expires_at, artifact_id
             limit $2
             for update skip locked
          )
          delete from ${table} artifact
          using expired
          where artifact.artifact_id = expired.artifact_id`,
        [now, limit],
      );
      return result.rowCount ?? 0;
    },
  };
}

function createFilesystemArtifactStore(root: string): ArtifactStore {
  return {
    async create(input) {
      assertArtifactInput(input);
      const artifactId = input.artifactId ?? `art_${randomUUID()}`;
      const record: ArtifactRecord = {
        artifactId,
        createdAt: new Date().toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        filename: input.filename,
        mediaType: input.mediaType,
        principalId: input.principalId,
        sessionId: input.sessionId,
        tenantId: input.tenantId,
        totalBytes: input.content.byteLength,
      };
      const directory = join(root, artifactId);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "content"), input.content, { flag: "wx" });
      await writeFile(join(directory, "meta.json"), JSON.stringify(record), { flag: "wx" });
      return record;
    },
    async find(artifactId) {
      try {
        const value = JSON.parse(await readFile(join(root, artifactId, "meta.json"), "utf8")) as unknown;
        return isArtifactRecord(value) ? value : undefined;
      } catch {
        return undefined;
      }
    },
    async list(sessionId, owner) {
      assertListInput(sessionId, owner);
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        return [];
      }
      const records = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && /^art_[a-f0-9-]{36}$/u.test(entry.name))
        .slice(0, 2_000)
        .map((entry) => this.find(entry.name)));
      const now = Date.now();
      return records
        .filter((record): record is ArtifactRecord => Boolean(
          record
          && record.sessionId === sessionId
          && record.tenantId === owner.tenantId
          && record.principalId === owner.principalId
          && new Date(record.expiresAt).getTime() > now,
        ))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 200);
    },
    async read(artifactId) {
      const record = await this.find(artifactId);
      if (!record) return undefined;
      try {
        const content = await readFile(join(root, artifactId, "content"));
        return { content, filename: record.filename, mediaType: record.mediaType };
      } catch {
        return undefined;
      }
    },
    async cleanupExpired(options) {
      const limit = normalizeCleanupLimit(options?.limit);
      const now = options?.now?.getTime() ?? Date.now();
      let deleted = 0;
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        return 0;
      }
      for (const entry of entries) {
        if (deleted >= limit || !entry.isDirectory()) continue;
        const record = await this.find(entry.name);
        if (!record || Date.parse(record.expiresAt) > now) continue;
        await rm(join(root, entry.name), { force: true, recursive: true });
        deleted += 1;
      }
      return deleted;
    },
  };
}

type ArtifactRow = {
  asset_id?: string | null;
  artifact_id: string;
  created_at: Date | string;
  expires_at: Date | string;
  filename: string;
  media_type: string;
  principal_id: string;
  session_id: string;
  tenant_id: string;
  total_bytes: number;
  content?: Buffer | null;
};

function toRecord(row: ArtifactRow): ArtifactRecord {
  if (!row) throw new Error("The artifact store returned no created artifact.");
  return {
    artifactId: row.artifact_id,
    createdAt: asIso(row.created_at),
    expiresAt: asIso(row.expires_at),
    filename: row.filename,
    mediaType: row.media_type,
    principalId: row.principal_id,
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    totalBytes: row.total_bytes,
  };
}

function assertArtifactInput(input: {
  readonly content: Uint8Array;
  readonly expiresAt: Date;
  readonly filename: string;
  readonly mediaType: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly tenantId: string;
}): void {
  if (!input.sessionId || !input.tenantId || !input.principalId) {
    throw new Error("An artifact requires a session and authenticated owner.");
  }
  if (!safeFilename(input.filename)) throw new Error("The artifact filename is invalid.");
  if (!input.mediaType || input.mediaType.length > 200) throw new Error("The artifact media type is invalid.");
  if (input.content.byteLength === 0 || input.content.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error("The artifact must be between 1 byte and 25 MiB.");
  }
  if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= new Date()) {
    throw new Error("The artifact expiration must be in the future.");
  }
}

function assertListInput(sessionId: string, owner: PublicationOwner): void {
  if (!sessionId || sessionId.length > 512 || !owner.tenantId || !owner.principalId) {
    throw new Error("A publication list requires a valid session and authenticated owner.");
  }
}

function safeFilename(value: string): boolean {
  return value.length > 0
    && value.length <= 255
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function normalizeCleanupLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("Artifact cleanup limit must be an integer from 1 to 10000.");
  }
  return limit;
}

function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ArtifactRecord>;
  return typeof record.artifactId === "string"
    && /^art_[a-f0-9-]{36}$/u.test(record.artifactId)
    && typeof record.createdAt === "string"
    && typeof record.expiresAt === "string"
    && typeof record.filename === "string"
    && typeof record.mediaType === "string"
    && typeof record.principalId === "string"
    && typeof record.sessionId === "string"
    && typeof record.tenantId === "string"
    && typeof record.totalBytes === "number";
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
