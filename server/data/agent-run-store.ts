import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  AgentProfileRef,
  AgentRunParentRef,
  AgentRunPolicy,
  AgentRunResult,
  AgentRunStatus,
  AgentRunUsage,
  JsonValue,
} from "@oworker/open-agent-contracts/agent-run";
import {
  getAgentDatabasePool,
  quoteIdentifier,
  readAgentDatabaseConfig,
  type AgentDatabaseConfig,
} from "./agent-database.ts";

export type AgentRunRecord = {
  readonly cancellationRequestedAt?: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly eventCount: number;
  readonly failure?: { readonly code: string; readonly message: string; readonly retryable: boolean };
  readonly idempotencyKey: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly parent?: AgentRunParentRef;
  readonly policy: AgentRunPolicy;
  readonly principalId: string;
  readonly profile: AgentProfileRef;
  readonly requestFingerprint: string;
  readonly result?: AgentRunResult;
  readonly revision: number;
  readonly runId: string;
  readonly sessionId?: string;
  readonly status: AgentRunStatus;
  readonly tenantId: string;
  readonly updatedAt: string;
  readonly usage: AgentRunUsage;
};

export type ReserveAgentRunInput = {
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly parent?: AgentRunParentRef;
  readonly policy: AgentRunPolicy;
  readonly principalId: string;
  readonly profile: AgentProfileRef;
  readonly requestFingerprint: string;
  readonly tenantId: string;
};

export type ReserveAgentRunResult =
  | { readonly record: AgentRunRecord; readonly status: "reserved" }
  | { readonly record: AgentRunRecord; readonly status: "replay" }
  | { readonly record: AgentRunRecord; readonly status: "conflict" }
  | {
      readonly activeCount: number;
      readonly activeTenantCount: number;
      readonly maxActiveRuns: number;
      readonly maxActiveRunsPerTenant: number;
      readonly status: "capacity";
    };

export type AgentRunProjection = {
  readonly eventCount: number;
  readonly failure?: AgentRunRecord["failure"];
  readonly result?: AgentRunResult;
  readonly status: AgentRunStatus;
  readonly usage: AgentRunUsage;
};

export interface AgentRunStore {
  /**
   * Idempotently binds the exact Eve session to a reserved run. Hosts should
   * return the existing running record when a retry observes that the same
   * session was already attached after a lost database response.
   */
  attachSession(runId: string, sessionId: string): Promise<AgentRunRecord>;
  findOwned(tenantId: string, principalId: string, runId: string): Promise<AgentRunRecord | undefined>;
  /**
   * Resolve a run by its Eve session identity. This is optional so lightweight
   * host integrations can remain session-only, while production persistence
   * can establish real parent/child AgentRun lineage.
   */
  findOwnedBySession?(tenantId: string, principalId: string, sessionId: string): Promise<AgentRunRecord | undefined>;
  markCancelled(runId: string): Promise<AgentRunRecord>;
  markCancellationRequested(runId: string): Promise<AgentRunRecord>;
  markSubmissionFailed(runId: string, message: string): Promise<AgentRunRecord>;
  markSubmissionAmbiguous(runId: string, message: string): Promise<AgentRunRecord>;
  /** Returns only pre-Eve reservations old enough to be reconciled safely. */
  listStaleSubmissions?(olderThanMs: number, limit: number): Promise<readonly AgentRunRecord[]>;
  reserve(input: ReserveAgentRunInput): Promise<ReserveAgentRunResult>;
  updateProjection(runId: string, projection: AgentRunProjection): Promise<AgentRunRecord>;
}

export function createPostgresAgentRunStore(config: AgentDatabaseConfig): AgentRunStore {
  const pool = getAgentDatabasePool(config);
  const table = `${quoteIdentifier(config.schema)}."agent_runs"`;
  return postgresAgentRunStore(pool, table, config);
}

export function createPostgresAgentRunStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentRunStore | undefined {
  const config = readAgentDatabaseConfig(environment);
  return config ? createPostgresAgentRunStore(config) : undefined;
}

function postgresAgentRunStore(pool: Pool, table: string, config: AgentDatabaseConfig): AgentRunStore {
  return {
    async reserve(input) {
      const runId = `arun_${randomUUID()}`;
      return await inTransaction(pool, async (client) => {
        // The idempotency lookup happens before admission. Replaying an
        // existing request must remain possible even while the tenant is at
        // capacity, and it must not consume another slot.
        const existing = await client.query<AgentRunRow>(
          `select ${selectColumns()} from ${table}
            where tenant_id = $1 and principal_id = $2 and idempotency_key = $3
            limit 1`,
          [input.tenantId, input.principalId, input.idempotencyKey],
        );
        const row = existing.rows[0];
        if (row) {
          return {
            record: toRecord(row),
            status: row.requestFingerprint === input.requestFingerprint ? "replay" : "conflict",
          } as const;
        }

        const maxActiveRuns = config.maxActiveRuns ?? 0;
        const maxActiveRunsPerTenant = config.maxActiveRunsPerTenant ?? 0;
        if (maxActiveRuns > 0 || maxActiveRunsPerTenant > 0) {
          // Serialize the short admission transaction across all writers. A
          // process-local semaphore would allow multiple Web/Eve replicas to
          // oversubscribe the same host or tenant.
          await client.query(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            ["open-agent:active-run-admission"],
          );
          // Another request with the same idempotency key may have committed
          // while this transaction waited for the admission lock. Re-read it
          // before counting capacity so retries remain replayable at the
          // limit instead of being misclassified as a new request.
          const lockedExisting = await client.query<AgentRunRow>(
            `select ${selectColumns()} from ${table}
              where tenant_id = $1 and principal_id = $2 and idempotency_key = $3
              limit 1`,
            [input.tenantId, input.principalId, input.idempotencyKey],
          );
          const lockedRow = lockedExisting.rows[0];
          if (lockedRow) {
            return {
              record: toRecord(lockedRow),
              status: lockedRow.requestFingerprint === input.requestFingerprint ? "replay" : "conflict",
            } as const;
          }
          const counts = await client.query<{ activeCount: string; activeTenantCount: string }>(
            `select
                count(*)::text as "activeCount",
                count(*) filter (where tenant_id = $1)::text as "activeTenantCount"
               from ${table}
              where status in ('submitting', 'running', 'waiting-input', 'waiting-authorization')`,
            [input.tenantId],
          );
          const activeCount = Number(counts.rows[0]?.activeCount ?? 0);
          const activeTenantCount = Number(counts.rows[0]?.activeTenantCount ?? 0);
          if (
            (maxActiveRuns > 0 && activeCount >= maxActiveRuns) ||
            (maxActiveRunsPerTenant > 0 && activeTenantCount >= maxActiveRunsPerTenant)
          ) {
            return {
              activeCount,
              activeTenantCount,
              maxActiveRuns,
              maxActiveRunsPerTenant,
              status: "capacity",
            } as const;
          }
        }

        const inserted = await client.query<AgentRunRow>(
          `insert into ${table}
            (run_id, tenant_id, principal_id, idempotency_key, request_fingerprint,
             correlation_id, profile, policy, parent, metadata, status)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, 'submitting')
           on conflict (tenant_id, principal_id, idempotency_key) do nothing
           returning ${selectColumns()}`,
          [
            runId,
            input.tenantId,
            input.principalId,
            input.idempotencyKey,
            input.requestFingerprint,
            input.correlationId,
            JSON.stringify(input.profile),
            JSON.stringify(input.policy),
            input.parent ? JSON.stringify(input.parent) : null,
            JSON.stringify(input.metadata),
          ],
        );
        const created = inserted.rows[0];
        if (created) return { record: toRecord(created), status: "reserved" } as const;

        // A caller that raced an installation without the admission lock can
        // still lose the unique constraint. Resolve it as a normal replay or
        // conflict rather than leaking a database error.
        const raced = await client.query<AgentRunRow>(
          `select ${selectColumns()} from ${table}
            where tenant_id = $1 and principal_id = $2 and idempotency_key = $3
            limit 1`,
          [input.tenantId, input.principalId, input.idempotencyKey],
        );
        const racedRow = requireRow(raced.rows[0]);
        return {
          record: toRecord(racedRow),
          status: racedRow.requestFingerprint === input.requestFingerprint ? "replay" : "conflict",
        } as const;
      });
    },
    async attachSession(runId, sessionId) {
      const result = await pool.query<AgentRunRow>(
        `update ${table}
            set eve_session_id = $2,
                status = 'running',
                revision = revision + 1,
                updated_at = now()
          where run_id = $1 and status = 'submitting'
          returning ${selectColumns()}`,
        [runId, sessionId],
      );
      if (result.rows[0]) return toRecord(result.rows[0]);
      // The UPDATE may have committed even if the client lost the response.
      // Make retries idempotent by accepting the already-attached exact
      // session instead of treating it as a failed attach and resetting a
      // live Eve turn.
      const existing = await pool.query<AgentRunRow>(
        `select ${selectColumns()} from ${table}
          where run_id = $1
          limit 1`,
        [runId],
      );
      const row = requireRow(existing.rows[0]);
      if (row.sessionId === sessionId && row.status === "running") return toRecord(row);
      throw new Error("AgentRun session attachment was already settled with a different state.");
    },
    async findOwned(tenantId, principalId, runId) {
      const result = await pool.query<AgentRunRow>(
        `select ${selectColumns()} from ${table}
          where run_id = $1 and tenant_id = $2 and principal_id = $3`,
        [runId, tenantId, principalId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async findOwnedBySession(tenantId, principalId, sessionId) {
      const result = await pool.query<AgentRunRow>(
        `select ${selectColumns()} from ${table}
          where eve_session_id = $1 and tenant_id = $2 and principal_id = $3
          order by created_at desc
          limit 1`,
        [sessionId, tenantId, principalId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async markCancellationRequested(runId) {
      const result = await pool.query<AgentRunRow>(
        `update ${table}
            set cancellation_requested_at = now(),
                revision = revision + 1,
                updated_at = now()
          where run_id = $1
            and cancellation_requested_at is null
            and status not in ('completed', 'failed', 'cancelled', 'submission-ambiguous')
          returning ${selectColumns()}`,
        [runId],
      );
      if (result.rows[0]) return toRecord(result.rows[0]);
      const existing = await pool.query<AgentRunRow>(
        `select ${selectColumns()} from ${table} where run_id = $1`,
        [runId],
      );
      return toRecord(requireRow(existing.rows[0]));
    },
    async markCancelled(runId) {
      const result = await pool.query<AgentRunRow>(
        `update ${table}
            set status = 'cancelled',
                result = null,
                failure = null,
                revision = revision + 1,
                updated_at = now()
          where run_id = $1 and status <> 'cancelled'
          returning ${selectColumns()}`,
        [runId],
      );
      if (result.rows[0]) return toRecord(result.rows[0]);
      const existing = await pool.query<AgentRunRow>(
        `select ${selectColumns()} from ${table} where run_id = $1`,
        [runId],
      );
      return toRecord(requireRow(existing.rows[0]));
    },
    async markSubmissionFailed(runId, message) {
      const result = await pool.query<AgentRunRow>(
        `update ${table}
            set status = 'failed',
                failure = $2::jsonb,
                revision = revision + 1,
                updated_at = now()
          where run_id = $1 and status = 'submitting'
          returning ${selectColumns()}`,
        [runId, JSON.stringify({ code: "runtime-rejected", message, retryable: false })],
      );
      return toRecord(requireRow(result.rows[0]));
    },
    async markSubmissionAmbiguous(runId, message) {
      const result = await pool.query<AgentRunRow>(
        `update ${table}
            set status = 'submission-ambiguous',
                failure = $2::jsonb,
                revision = revision + 1,
                updated_at = now()
          where run_id = $1 and status = 'submitting'
          returning ${selectColumns()}`,
        [runId, JSON.stringify({ code: "submission-ambiguous", message, retryable: false })],
      );
      if (result.rows[0]) return toRecord(result.rows[0]);
      const existing = await pool.query<AgentRunRow>(
        `select ${selectColumns()} from ${table} where run_id = $1`,
        [runId],
      );
      return toRecord(requireRow(existing.rows[0]));
    },
    async listStaleSubmissions(olderThanMs, limit) {
      assertBoundedInteger(olderThanMs, "olderThanMs", 1, 86_400_000);
      assertBoundedInteger(limit, "limit", 1, 10_000);
      const result = await pool.query<AgentRunRow>(
        `select ${selectColumns()} from ${table}
           where status = 'submitting'
             and updated_at < now() - ($1::bigint * interval '1 millisecond')
           order by updated_at asc
           limit $2`,
        [olderThanMs, limit],
      );
      return result.rows.map(toRecord);
    },
    async updateProjection(runId, projection) {
      return await inTransaction(pool, async (client) => {
        const locked = await client.query<AgentRunRow>(
          `select ${selectColumns()} from ${table} where run_id = $1 for update`,
          [runId],
        );
        const current = toRecord(requireRow(locked.rows[0]));
        if (current.eventCount > projection.eventCount) return current;
        const cancellationPending = Boolean(current.cancellationRequestedAt);
        const status = isTerminal(current.status)
          ? current.status
          : cancellationPending && projection.status !== "cancelled"
            ? current.status
            : projection.status;
        const effectiveProjection: AgentRunProjection = cancellationPending || status === "cancelled"
          ? {
              eventCount: projection.eventCount,
              status,
              usage: projection.usage,
            }
          : { ...projection, status };
        if (projectionMatches(current, effectiveProjection, status)) return current;
        const result = await client.query<AgentRunRow>(
          `update ${table}
              set status = $2,
                  event_count = greatest(event_count, $3),
                  usage = $4::jsonb,
                  result = $5::jsonb,
                  failure = $6::jsonb,
                  revision = revision + 1,
                  updated_at = now()
            where run_id = $1
            returning ${selectColumns()}`,
          [
            runId,
            status,
            projection.eventCount,
            JSON.stringify(effectiveProjection.usage),
            effectiveProjection.result ? JSON.stringify(effectiveProjection.result) : null,
            effectiveProjection.failure ? JSON.stringify(effectiveProjection.failure) : null,
          ],
        );
        return toRecord(requireRow(result.rows[0]));
      });
    },
  };
}

type AgentRunRow = {
  cancellationRequestedAt: Date | string | null;
  correlationId: string;
  createdAt: Date | string;
  eventCount: number;
  failure: AgentRunRecord["failure"] | null;
  idempotencyKey: string;
  metadata: AgentRunRecord["metadata"];
  parent: AgentRunParentRef | null;
  policy: AgentRunPolicy;
  principalId: string;
  profile: AgentProfileRef;
  requestFingerprint: string;
  result: AgentRunResult | null;
  revision: string;
  runId: string;
  sessionId: string | null;
  status: AgentRunStatus;
  tenantId: string;
  updatedAt: Date | string;
  usage: AgentRunUsage;
};

function selectColumns(): string {
  return `run_id as "runId", tenant_id as "tenantId", principal_id as "principalId",
    idempotency_key as "idempotencyKey", request_fingerprint as "requestFingerprint",
    correlation_id as "correlationId", profile, policy, parent, metadata, status,
    eve_session_id as "sessionId",
    event_count as "eventCount", usage, result, failure, revision::text,
    cancellation_requested_at as "cancellationRequestedAt",
    created_at as "createdAt", updated_at as "updatedAt"`;
}

function toRecord(row: AgentRunRow): AgentRunRecord {
  return {
    ...(row.cancellationRequestedAt ? { cancellationRequestedAt: toIso(row.cancellationRequestedAt) } : {}),
    correlationId: row.correlationId,
    createdAt: toIso(row.createdAt),
    eventCount: row.eventCount,
    ...(row.failure ? { failure: row.failure } : {}),
    idempotencyKey: row.idempotencyKey,
    metadata: row.metadata,
    ...(row.parent ? { parent: row.parent } : {}),
    policy: row.policy,
    principalId: row.principalId,
    profile: row.profile,
    requestFingerprint: row.requestFingerprint,
    ...(row.result ? { result: row.result } : {}),
    revision: parseRevision(row.revision),
    runId: row.runId,
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    status: row.status,
    tenantId: row.tenantId,
    updatedAt: toIso(row.updatedAt),
    usage: row.usage,
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

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new Error("AgentRun persistence state changed unexpectedly.");
  return row;
}

function isTerminal(status: AgentRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "submission-ambiguous";
}

function projectionMatches(
  current: AgentRunRecord,
  projection: AgentRunProjection,
  status: AgentRunStatus,
): boolean {
  return current.eventCount >= projection.eventCount
    && current.status === status
    && JSON.stringify(current.usage) === JSON.stringify(projection.usage)
    && JSON.stringify(current.result) === JSON.stringify(projection.result)
    && JSON.stringify(current.failure) === JSON.stringify(projection.failure);
}

function parseRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid AgentRun revision.");
  return revision;
}

function assertBoundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
