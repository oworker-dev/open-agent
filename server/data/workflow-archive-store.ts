import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import {
  getAgentDatabasePool,
  quoteIdentifier,
  readAgentDatabaseConfig,
  type AgentDatabaseConfig,
} from "./agent-database.ts";

export type WorkflowArchiveStatus = "pending" | "claimed" | "completed" | "failed";

export type WorkflowArchiveRecord = {
  readonly archiveCreatedAt: string;
  readonly archivedAt?: string;
  readonly attemptCount: number;
  readonly claimExpiresAt?: string;
  readonly claimToken?: string;
  readonly lastError?: string;
  readonly manifestSha256?: string;
  readonly objectKey?: string;
  readonly objectSha256?: string;
  readonly objectSizeBytes?: number;
  readonly recordCount?: number;
  readonly rootRunId: string;
  readonly runCount?: number;
  readonly sourceCompletedAt: string;
  readonly status: WorkflowArchiveStatus;
  readonly updatedAt: string;
};

export interface WorkflowArchiveStore {
  claimNext(leaseMs: number): Promise<WorkflowArchiveRecord | undefined>;
  complete(input: {
    readonly claimToken: string;
    readonly manifestSha256: string;
    readonly objectKey: string;
    readonly objectSha256: string;
    readonly objectSizeBytes: number;
    readonly recordCount: number;
    readonly rootRunId: string;
    readonly runCount: number;
  }): Promise<WorkflowArchiveRecord>;
  fail(rootRunId: string, claimToken: string, message: string, retryDelayMs: number): Promise<boolean>;
  find(rootRunId: string): Promise<WorkflowArchiveRecord | undefined>;
  readDiscoveryCursor(): Promise<WorkflowArchiveDiscoveryCursor | undefined>;
  recordDiscovery(input: {
    readonly candidates: readonly WorkflowArchiveCandidate[];
    readonly cursor?: WorkflowArchiveDiscoveryCursor;
  }): Promise<void>;
  renew(rootRunId: string, claimToken: string, leaseMs: number): Promise<boolean>;
}

export type WorkflowArchiveCandidate = {
  readonly rootRunId: string;
  readonly sourceCompletedAt: string;
};

export type WorkflowArchiveDiscoveryCursor = {
  readonly completedAt: string;
  readonly rootRunId: string;
};

export function createPostgresWorkflowArchiveStore(
  config: AgentDatabaseConfig,
  pool: Pick<Pool, "connect" | "query"> = getAgentDatabasePool(config),
): WorkflowArchiveStore {
  const table = `${quoteIdentifier(config.schema)}."workflow_archives"`;
  const discoveryTable = `${quoteIdentifier(config.schema)}."workflow_archive_discovery"`;
  return {
    async find(rootRunId) {
      assertRootRunId(rootRunId);
      const result = await pool.query<WorkflowArchiveRow>(
        `select ${selectColumns()} from ${table} where root_run_id = $1`,
        [rootRunId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async claimNext(leaseMs) {
      assertLease(leaseMs);
      const claimToken = randomUUID();
      const result = await pool.query<WorkflowArchiveRow>(
        `update ${table}
            set status = 'claimed',
                claim_token = $1,
                claim_expires_at = now() + ($2::bigint * interval '1 millisecond'),
                attempt_count = attempt_count + 1,
                last_error = null,
                updated_at = now()
          where root_run_id = (
            select root_run_id from ${table}
             where next_attempt_at <= now()
               and (
                 status in ('pending', 'failed')
                 or (status = 'claimed' and claim_expires_at < now())
               )
             order by source_completed_at, root_run_id
             for update skip locked
             limit 1
          )
          returning ${selectColumns()}`,
        [claimToken, leaseMs],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async complete(input) {
      assertRootRunId(input.rootRunId);
      assertText(input.claimToken, "claimToken", 128);
      assertSha256(input.manifestSha256, "manifestSha256");
      assertSha256(input.objectSha256, "objectSha256");
      assertText(input.objectKey, "objectKey", 2_000);
      assertCount(input.objectSizeBytes, "objectSizeBytes", true);
      assertCount(input.recordCount, "recordCount", true);
      assertCount(input.runCount, "runCount", false);
      const result = await pool.query<WorkflowArchiveRow>(
        `update ${table}
            set status = 'completed',
                claim_token = null,
                claim_expires_at = null,
                object_key = $3,
                object_sha256 = $4,
                manifest_sha256 = $5,
                object_size_bytes = $6,
                record_count = $7,
                run_count = $8,
                last_error = null,
                archived_at = now(),
                updated_at = now()
          where root_run_id = $1 and status = 'claimed' and claim_token = $2
          returning ${selectColumns()}`,
        [
          input.rootRunId,
          input.claimToken,
          input.objectKey,
          input.objectSha256,
          input.manifestSha256,
          input.objectSizeBytes,
          input.recordCount,
          input.runCount,
        ],
      );
      return toRecord(requireRow(result.rows[0]));
    },
    async fail(rootRunId, claimToken, message, retryDelayMs) {
      assertRootRunId(rootRunId);
      assertText(claimToken, "claimToken", 128);
      assertDelay(retryDelayMs);
      const compactMessage = message.trim().slice(0, 2_000) || "Workflow archive failed.";
      const result = await pool.query(
        `update ${table}
            set status = 'failed',
                claim_token = null,
                claim_expires_at = null,
                next_attempt_at = now() + ($4::bigint * interval '1 millisecond'),
                last_error = $3,
                updated_at = now()
          where root_run_id = $1 and status = 'claimed' and claim_token = $2`,
        [rootRunId, claimToken, compactMessage, retryDelayMs],
      );
      return (result.rowCount ?? 0) === 1;
    },
    async readDiscoveryCursor() {
      const result = await pool.query<{
        cursorCompletedAt: Date | string | null;
        cursorRootRunId: string | null;
      }>(
        `select cursor_completed_at as "cursorCompletedAt", cursor_root_run_id as "cursorRootRunId"
           from ${discoveryTable} where singleton = true`,
      );
      const row = result.rows[0];
      if (!row?.cursorCompletedAt || !row.cursorRootRunId) return undefined;
      return { completedAt: toIso(row.cursorCompletedAt), rootRunId: row.cursorRootRunId };
    },
    async recordDiscovery(input) {
      for (const candidate of input.candidates) {
        assertRootRunId(candidate.rootRunId);
        parseTimestamp(candidate.sourceCompletedAt, "sourceCompletedAt");
      }
      if (input.cursor) {
        assertRootRunId(input.cursor.rootRunId);
        parseTimestamp(input.cursor.completedAt, "cursor.completedAt");
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (input.candidates.length > 0) {
          await client.query(
            `insert into ${table} (root_run_id, source_completed_at)
             select root_run_id, source_completed_at
               from unnest($1::text[], $2::timestamptz[]) as discovered(root_run_id, source_completed_at)
             on conflict (root_run_id) do nothing`,
            [
              input.candidates.map((candidate) => candidate.rootRunId),
              input.candidates.map((candidate) => candidate.sourceCompletedAt),
            ],
          );
        }
        await client.query(
          `update ${discoveryTable}
              set cursor_completed_at = $1::timestamptz,
                  cursor_root_run_id = $2,
                  updated_at = now()
            where singleton = true`,
          [input.cursor?.completedAt ?? null, input.cursor?.rootRunId ?? null],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async renew(rootRunId, claimToken, leaseMs) {
      assertRootRunId(rootRunId);
      assertText(claimToken, "claimToken", 128);
      assertLease(leaseMs);
      const result = await pool.query(
        `update ${table}
            set claim_expires_at = now() + ($3::bigint * interval '1 millisecond'),
                updated_at = now()
          where root_run_id = $1 and status = 'claimed' and claim_token = $2`,
        [rootRunId, claimToken, leaseMs],
      );
      return (result.rowCount ?? 0) === 1;
    },
  };
}

export function createPostgresWorkflowArchiveStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkflowArchiveStore | undefined {
  const config = readAgentDatabaseConfig(environment);
  return config ? createPostgresWorkflowArchiveStore(config) : undefined;
}

type WorkflowArchiveRow = {
  archiveCreatedAt: Date | string;
  archivedAt: Date | string | null;
  attemptCount: number;
  claimExpiresAt: Date | string | null;
  claimToken: string | null;
  lastError: string | null;
  manifestSha256: string | null;
  objectKey: string | null;
  objectSha256: string | null;
  objectSizeBytes: number | string | null;
  recordCount: number | string | null;
  rootRunId: string;
  runCount: number | null;
  sourceCompletedAt: Date | string;
  status: WorkflowArchiveStatus;
  updatedAt: Date | string;
};

function selectColumns(): string {
  return `root_run_id as "rootRunId", status, archive_created_at as "archiveCreatedAt",
    source_completed_at as "sourceCompletedAt",
    attempt_count as "attemptCount", claim_token as "claimToken",
    claim_expires_at as "claimExpiresAt", object_key as "objectKey",
    object_sha256 as "objectSha256", manifest_sha256 as "manifestSha256",
    object_size_bytes as "objectSizeBytes", record_count as "recordCount",
    run_count as "runCount", last_error as "lastError", archived_at as "archivedAt",
    updated_at as "updatedAt"`;
}

function toRecord(row: WorkflowArchiveRow): WorkflowArchiveRecord {
  return {
    archiveCreatedAt: toIso(row.archiveCreatedAt),
    ...(row.archivedAt ? { archivedAt: toIso(row.archivedAt) } : {}),
    attemptCount: row.attemptCount,
    ...(row.claimExpiresAt ? { claimExpiresAt: toIso(row.claimExpiresAt) } : {}),
    ...(row.claimToken ? { claimToken: row.claimToken } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.manifestSha256 ? { manifestSha256: row.manifestSha256 } : {}),
    ...(row.objectKey ? { objectKey: row.objectKey } : {}),
    ...(row.objectSha256 ? { objectSha256: row.objectSha256 } : {}),
    ...(row.objectSizeBytes !== null ? { objectSizeBytes: Number(row.objectSizeBytes) } : {}),
    ...(row.recordCount !== null ? { recordCount: Number(row.recordCount) } : {}),
    rootRunId: row.rootRunId,
    ...(row.runCount !== null ? { runCount: row.runCount } : {}),
    sourceCompletedAt: toIso(row.sourceCompletedAt),
    status: row.status,
    updatedAt: toIso(row.updatedAt),
  };
}

function assertRootRunId(value: string): void {
  assertText(value, "rootRunId", 512);
  if (/\s/u.test(value)) throw new Error("rootRunId must not contain whitespace.");
}

function assertLease(value: number): void {
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 24 * 60 * 60 * 1_000) {
    throw new Error("leaseMs must be an integer from 60000 to 86400000.");
  }
}

function assertDelay(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 24 * 60 * 60 * 1_000) {
    throw new Error("retryDelayMs must be an integer from 1000 to 86400000.");
  }
}

function assertCount(value: number, name: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be a safe ${allowZero ? "non-negative" : "positive"} integer.`);
  }
}

function assertSha256(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest.`);
}

function assertText(value: string, name: string, maximum: number): void {
  if (!value.trim() || value.length > maximum) {
    throw new Error(`${name} must contain between 1 and ${maximum} characters.`);
  }
}

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new Error("Workflow archive lease changed before completion.");
  return row;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseTimestamp(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}
