import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  getAgentDatabasePool,
  quoteIdentifier,
  readAgentDatabaseConfig,
  type AgentDatabaseConfig,
} from "./agent-database.ts";
import type { PublicationOwner } from "./artifact-store.ts";

export type PreviewFileInput = {
  readonly content: Uint8Array;
  readonly mediaType: string;
  readonly path: string;
};

export type PreviewRecord = {
  readonly createdAt: string;
  readonly entrypoint: string;
  readonly expiresAt: string;
  readonly fileCount: number;
  readonly previewId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly totalBytes: number;
};

export type PreviewFile = {
  readonly content: Uint8Array;
  readonly mediaType: string;
  readonly path: string;
};

export interface PreviewStore {
  create(input: {
    readonly entrypoint: string;
    readonly expiresAt: Date;
    readonly files: readonly PreviewFileInput[];
    readonly previewId?: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly tenantId: string;
  }): Promise<PreviewRecord>;
  find(previewId: string): Promise<PreviewRecord | undefined>;
  list(sessionId: string, owner: PublicationOwner): Promise<readonly PreviewRecord[]>;
  readFile(previewId: string, path: string): Promise<PreviewFile | undefined>;
}

export function createPostgresPreviewStore(
  config: AgentDatabaseConfig,
): PreviewStore {
  const pool = getAgentDatabasePool(config);
  const previews = `${quoteIdentifier(config.schema)}."agent_previews"`;
  const files = `${quoteIdentifier(config.schema)}."agent_preview_files"`;
  return postgresPreviewStore(pool, previews, files);
}

export function createPostgresPreviewStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PreviewStore | undefined {
  const config = readAgentDatabaseConfig(environment);
  return config ? createPostgresPreviewStore(config) : undefined;
}

export function createPreviewStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PreviewStore {
  const config = readAgentDatabaseConfig(environment);
  if (config) return createPostgresPreviewStore(config);
  const configuredRoot = environment.AGENT_PREVIEW_STORAGE_PATH?.trim();
  return createFilesystemPreviewStore(
    configuredRoot ? resolve(configuredRoot) : resolve(process.cwd(), ".eve", "previews"),
  );
}

function postgresPreviewStore(pool: Pool, previews: string, files: string): PreviewStore {
  return {
    async create(input) {
      assertPreviewInput(input);
      const previewId = input.previewId ?? `prv_${randomUUID()}`;
      const created = await withTransaction(pool, async (client) => {
        const result = await client.query<PreviewRow>(
          `insert into ${previews}
            (preview_id, session_id, tenant_id, principal_id, entrypoint, expires_at, file_count, total_bytes)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning preview_id, session_id, tenant_id, principal_id, entrypoint,
             expires_at, created_at, file_count, total_bytes`,
          [
            previewId,
            input.sessionId,
            input.tenantId,
            input.principalId,
            input.entrypoint,
            input.expiresAt,
            input.files.length,
            input.files.reduce((total, file) => total + file.content.byteLength, 0),
          ],
        );
        for (const file of input.files) {
          await client.query(
            `insert into ${files} (preview_id, path, media_type, content)
             values ($1, $2, $3, $4)`,
            [previewId, file.path, file.mediaType, Buffer.from(file.content)],
          );
        }
        return toRecord(result.rows[0]);
      });
      return created;
    },
    async find(previewId) {
      const result = await pool.query<PreviewRow>(
        `select preview_id, session_id, tenant_id, principal_id, entrypoint,
           expires_at, created_at, file_count, total_bytes
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
           expires_at, created_at, file_count, total_bytes
         from ${previews}
         where session_id = $1 and tenant_id = $2 and principal_id = $3 and expires_at > now()
         order by created_at desc
         limit 200`,
        [sessionId, owner.tenantId, owner.principalId],
      );
      return result.rows.map(toRecord);
    },
    async readFile(previewId, path) {
      const result = await pool.query<{ path: string; media_type: string; content: Buffer }>(
        `select path, media_type, content from ${files}
         where preview_id = $1 and path = $2`,
        [previewId, path],
      );
      const row = result.rows[0];
      return row
        ? { content: row.content, mediaType: row.media_type, path: row.path }
        : undefined;
    },
  };
}

function createFilesystemPreviewStore(root: string): PreviewStore {
  return {
    async create(input) {
      assertPreviewInput(input);
      const previewId = input.previewId ?? `prv_${randomUUID()}`;
      const record: PreviewRecord = {
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
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        return [];
      }
      const records = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && /^prv_[a-f0-9-]{36}$/u.test(entry.name))
        .slice(0, 2_000)
        .map((entry) => this.find(entry.name)));
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
  };
}

type PreviewRow = {
  created_at: Date | string;
  entrypoint: string;
  expires_at: Date | string;
  file_count: number;
  preview_id: string;
  principal_id: string;
  session_id: string;
  tenant_id: string;
  total_bytes: number;
};

function toRecord(row: PreviewRow): PreviewRecord {
  if (!row) throw new Error("The preview store returned no created preview.");
  return {
    createdAt: asIso(row.created_at),
    entrypoint: row.entrypoint,
    expiresAt: asIso(row.expires_at),
    fileCount: row.file_count,
    previewId: row.preview_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    totalBytes: row.total_bytes,
  };
}

function assertPreviewInput(input: {
  readonly entrypoint: string;
  readonly expiresAt: Date;
  readonly files: readonly PreviewFileInput[];
  readonly principalId: string;
  readonly sessionId: string;
  readonly tenantId: string;
}): void {
  if (!input.sessionId || !input.tenantId || !input.principalId) {
    throw new Error("A preview requires a session and authenticated owner.");
  }
  if (!input.entrypoint || !safePath(input.entrypoint)) throw new Error("The preview entrypoint is invalid.");
  if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= new Date()) {
    throw new Error("The preview expiration must be in the future.");
  }
  if (input.files.length === 0) throw new Error("A preview requires at least one file.");
  const paths = new Set<string>();
  for (const file of input.files) {
    if (!safePath(file.path) || paths.has(file.path)) throw new Error("Preview files contain a duplicate or unsafe path.");
    if (!file.mediaType || file.content.byteLength > 10 * 1024 * 1024) throw new Error("A preview file is invalid or too large.");
    paths.add(file.path);
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

function isPreviewRecord(value: unknown): value is PreviewRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PreviewRecord>;
  return typeof record.previewId === "string"
    && typeof record.entrypoint === "string"
    && typeof record.expiresAt === "string"
    && typeof record.createdAt === "string"
    && typeof record.fileCount === "number"
    && typeof record.totalBytes === "number"
    && typeof record.sessionId === "string"
    && typeof record.tenantId === "string"
    && typeof record.principalId === "string";
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
