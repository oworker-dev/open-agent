import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  getAgentDatabasePool,
  quoteIdentifier,
  readAgentDatabaseConfig,
  type AgentDatabaseConfig,
} from "./agent-database.ts";
import type { AgentSessionOwner } from "./session-ownership-store.ts";

export type SandboxDeletionStatus = "authorized" | "claimed" | "completed" | "failed";

export type SandboxDeletionRecord = {
  readonly attemptCount: number;
  readonly claimExpiresAt?: string;
  readonly claimToken?: string;
  readonly completedAt?: string;
  readonly containerId?: string;
  readonly containerName?: string;
  readonly lastError?: string;
  readonly notBefore: string;
  readonly principalId: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly sessionId: string;
  readonly status: SandboxDeletionStatus;
  readonly tenantId: string;
  readonly updatedAt: string;
};

export type SandboxDeletionRequestResult =
  | { readonly record: SandboxDeletionRecord; readonly status: "created" | "existing" }
  | { readonly status: "forbidden" | "missing" };

export interface SandboxDeletionStore {
  claim(input: {
    readonly containerId: string;
    readonly containerName: string;
    readonly leaseMs?: number;
    readonly sessionId: string;
  }): Promise<SandboxDeletionRecord | undefined>;
  complete(sessionId: string, claimToken: string): Promise<SandboxDeletionRecord>;
  /**
   * Settle an authorized deletion whose exact Eve container is already absent.
   * Active claims and future not-before boundaries are never overridden.
   */
  completeMissing(sessionId: string): Promise<SandboxDeletionRecord | undefined>;
  fail(sessionId: string, claimToken: string, message: string): Promise<SandboxDeletionRecord>;
  findOwned(sessionId: string, owner: AgentSessionOwner): Promise<SandboxDeletionRecord | undefined>;
  request(input: {
    readonly notBefore?: string;
    readonly owner: AgentSessionOwner;
    readonly reason: string;
    readonly requestedBy: string;
    readonly sessionId: string;
  }): Promise<SandboxDeletionRequestResult>;
}

export function createPostgresSandboxDeletionStore(
  config: AgentDatabaseConfig,
): SandboxDeletionStore {
  const pool = getAgentDatabasePool(config);
  const schema = quoteIdentifier(config.schema);
  return postgresSandboxDeletionStore(
    pool,
    `${schema}."agent_session_owners"`,
    `${schema}."agent_sandbox_deletions"`,
  );
}

export function createPostgresSandboxDeletionStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SandboxDeletionStore | undefined {
  const config = readAgentDatabaseConfig(environment);
  return config ? createPostgresSandboxDeletionStore(config) : undefined;
}

function postgresSandboxDeletionStore(
  pool: Pool,
  ownershipTable: string,
  deletionTable: string,
): SandboxDeletionStore {
  return {
    async findOwned(sessionId, owner) {
      assertText(sessionId, "sessionId", 512);
      assertText(owner.tenantId, "tenantId", 512);
      assertText(owner.principalId, "principalId", 512);
      const result = await pool.query<SandboxDeletionRow>(
        `select ${selectColumns()} from ${deletionTable}
          where session_id = $1 and tenant_id = $2 and principal_id = $3`,
        [sessionId, owner.tenantId, owner.principalId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async request(input) {
      assertText(input.sessionId, "sessionId", 512);
      assertText(input.owner.tenantId, "tenantId", 512);
      assertText(input.owner.principalId, "principalId", 512);
      assertText(input.requestedBy, "requestedBy", 512);
      assertText(input.reason, "reason", 1_000);
      const notBefore = input.notBefore ? parseTimestamp(input.notBefore, "notBefore") : undefined;

      return await inTransaction(pool, async (client) => {
        const ownerResult = await client.query<{ principal_id: string; tenant_id: string }>(
          `select tenant_id, principal_id from ${ownershipTable} where session_id = $1 for update`,
          [input.sessionId],
        );
        const owner = ownerResult.rows[0];
        if (!owner) return { status: "missing" } as const;
        if (
          owner.tenant_id !== input.owner.tenantId ||
          owner.principal_id !== input.owner.principalId
        ) return { status: "forbidden" } as const;

        const inserted = await client.query<SandboxDeletionRow>(
          `insert into ${deletionTable}
            (session_id, tenant_id, principal_id, requested_by, reason, not_before)
           values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()))
           on conflict (session_id) do nothing
           returning ${selectColumns()}`,
          [
            input.sessionId,
            input.owner.tenantId,
            input.owner.principalId,
            input.requestedBy,
            input.reason,
            notBefore ?? null,
          ],
        );
        if (inserted.rows[0]) {
          return { record: toRecord(inserted.rows[0]), status: "created" } as const;
        }

        const existing = await client.query<SandboxDeletionRow>(
          `select ${selectColumns()} from ${deletionTable} where session_id = $1`,
          [input.sessionId],
        );
        const record = toRecord(requireRow(existing.rows[0]));
        if (
          record.tenantId !== input.owner.tenantId ||
          record.principalId !== input.owner.principalId
        ) return { status: "forbidden" } as const;
        return { record, status: "existing" } as const;
      });
    },
    async claim(input) {
      assertText(input.sessionId, "sessionId", 512);
      assertText(input.containerId, "containerId", 512);
      assertText(input.containerName, "containerName", 512);
      const leaseMs = input.leaseMs ?? 60_000;
      if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) {
        throw new Error("leaseMs must be an integer from 1000 to 900000.");
      }
      const claimToken = randomUUID();
      const result = await pool.query<SandboxDeletionRow>(
        `update ${deletionTable}
            set status = 'claimed',
                claim_token = $2,
                claim_expires_at = now() + ($3::bigint * interval '1 millisecond'),
                container_id = $4,
                container_name = $5,
                attempt_count = attempt_count + 1,
                last_error = null,
                updated_at = now()
          where session_id = $1
            and not_before <= now()
            and (
              status in ('authorized', 'failed')
              or (status = 'claimed' and claim_expires_at < now())
            )
          returning ${selectColumns()}`,
        [input.sessionId, claimToken, leaseMs, input.containerId, input.containerName],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async complete(sessionId, claimToken) {
      assertText(sessionId, "sessionId", 512);
      assertText(claimToken, "claimToken", 512);
      const result = await pool.query<SandboxDeletionRow>(
        `update ${deletionTable}
            set status = 'completed',
                claim_token = null,
                claim_expires_at = null,
                completed_at = now(),
                updated_at = now()
          where session_id = $1 and status = 'claimed' and claim_token = $2
          returning ${selectColumns()}`,
        [sessionId, claimToken],
      );
      return toRecord(requireRow(result.rows[0]));
    },
    async completeMissing(sessionId) {
      assertText(sessionId, "sessionId", 512);
      const result = await pool.query<SandboxDeletionRow>(
        `update ${deletionTable}
            set status = 'completed',
                claim_token = null,
                claim_expires_at = null,
                container_id = null,
                container_name = null,
                attempt_count = attempt_count + 1,
                last_error = null,
                completed_at = now(),
                updated_at = now()
          where session_id = $1
            and not_before <= now()
            and (
              status in ('authorized', 'failed')
              or (status = 'claimed' and claim_expires_at < now())
            )
          returning ${selectColumns()}`,
        [sessionId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async fail(sessionId, claimToken, message) {
      assertText(sessionId, "sessionId", 512);
      assertText(claimToken, "claimToken", 512);
      const compactMessage = message.trim().slice(0, 2_000) || "Sandbox deletion failed.";
      const result = await pool.query<SandboxDeletionRow>(
        `update ${deletionTable}
            set status = 'failed',
                claim_token = null,
                claim_expires_at = null,
                last_error = $3,
                updated_at = now()
          where session_id = $1 and status = 'claimed' and claim_token = $2
          returning ${selectColumns()}`,
        [sessionId, claimToken, compactMessage],
      );
      return toRecord(requireRow(result.rows[0]));
    },
  };
}

type SandboxDeletionRow = {
  attemptCount: number;
  claimExpiresAt: Date | string | null;
  claimToken: string | null;
  completedAt: Date | string | null;
  containerId: string | null;
  containerName: string | null;
  lastError: string | null;
  notBefore: Date | string;
  principalId: string;
  reason: string;
  requestedAt: Date | string;
  requestedBy: string;
  sessionId: string;
  status: SandboxDeletionStatus;
  tenantId: string;
  updatedAt: Date | string;
};

function selectColumns(): string {
  return `session_id as "sessionId", tenant_id as "tenantId", principal_id as "principalId",
    requested_by as "requestedBy", reason, not_before as "notBefore", status,
    attempt_count as "attemptCount", claim_token as "claimToken",
    claim_expires_at as "claimExpiresAt", container_id as "containerId",
    container_name as "containerName", last_error as "lastError",
    requested_at as "requestedAt", updated_at as "updatedAt", completed_at as "completedAt"`;
}

function toRecord(row: SandboxDeletionRow): SandboxDeletionRecord {
  return {
    attemptCount: row.attemptCount,
    ...(row.claimExpiresAt ? { claimExpiresAt: toIso(row.claimExpiresAt) } : {}),
    ...(row.claimToken ? { claimToken: row.claimToken } : {}),
    ...(row.completedAt ? { completedAt: toIso(row.completedAt) } : {}),
    ...(row.containerId ? { containerId: row.containerId } : {}),
    ...(row.containerName ? { containerName: row.containerName } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    notBefore: toIso(row.notBefore),
    principalId: row.principalId,
    reason: row.reason,
    requestedAt: toIso(row.requestedAt),
    requestedBy: row.requestedBy,
    sessionId: row.sessionId,
    status: row.status,
    tenantId: row.tenantId,
    updatedAt: toIso(row.updatedAt),
  };
}

async function inTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
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

function parseTimestamp(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

function assertText(value: string, name: string, maximum: number): void {
  if (value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${name} must contain between 1 and ${maximum} characters.`);
  }
}

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new Error("Sandbox deletion persistence state changed unexpectedly.");
  return row;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
