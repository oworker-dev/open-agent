import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AgentRunInputResponse } from "@oworker/open-agent-contracts/agent-run";
import {
  getAgentDatabasePool,
  quoteIdentifier,
  readAgentDatabaseConfig,
  type AgentDatabaseConfig,
} from "./agent-database";

export type AgentRunInputStatus = "accepted" | "failed" | "submission-ambiguous" | "submitting";

export type AgentRunInputRecord = {
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly inputResponses: readonly AgentRunInputResponse[];
  readonly lastError?: string;
  readonly requestFingerprint: string;
  readonly requestIds: readonly string[];
  readonly responseId: string;
  readonly runId: string;
  readonly status: AgentRunInputStatus;
  readonly updatedAt: string;
};

export type ReserveAgentRunInputResult =
  | { readonly record: AgentRunInputRecord; readonly status: "reserved" | "replay" }
  | { readonly record: AgentRunInputRecord; readonly status: "conflict" | "request-already-answered" };

export interface AgentRunInputStore {
  find(runId: string, idempotencyKey: string): Promise<AgentRunInputRecord | undefined>;
  markAccepted(responseId: string): Promise<AgentRunInputRecord>;
  markFailed(responseId: string, message: string): Promise<AgentRunInputRecord>;
  markSubmissionAmbiguous(responseId: string, message: string): Promise<AgentRunInputRecord>;
  reserve(input: {
    readonly idempotencyKey: string;
    readonly inputResponses: readonly AgentRunInputResponse[];
    readonly requestFingerprint: string;
    readonly requestIds: readonly string[];
    readonly runId: string;
  }): Promise<ReserveAgentRunInputResult>;
}

export function createPostgresAgentRunInputStore(config: AgentDatabaseConfig): AgentRunInputStore {
  const pool = getAgentDatabasePool(config);
  const schema = quoteIdentifier(config.schema);
  return postgresAgentRunInputStore(
    pool,
    `${schema}."agent_runs"`,
    `${schema}."agent_run_input_responses"`,
  );
}

export function createPostgresAgentRunInputStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentRunInputStore | undefined {
  const config = readAgentDatabaseConfig(environment);
  return config ? createPostgresAgentRunInputStore(config) : undefined;
}

function postgresAgentRunInputStore(
  pool: Pool,
  runTable: string,
  responseTable: string,
): AgentRunInputStore {
  return {
    async find(runId, idempotencyKey) {
      const result = await pool.query<AgentRunInputRow>(
        `select ${columns()} from ${responseTable}
         where run_id = $1 and idempotency_key = $2`,
        [runId, idempotencyKey],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async reserve(input) {
      return await inTransaction(pool, async (client) => {
        const locked = await client.query(
          `select run_id from ${runTable} where run_id = $1 for update`,
          [input.runId],
        );
        if (!locked.rows[0]) throw new Error("The AgentRun disappeared while reserving its input response.");

        const byIdempotency = await client.query<AgentRunInputRow>(
          `select ${columns()} from ${responseTable}
           where run_id = $1 and idempotency_key = $2`,
          [input.runId, input.idempotencyKey],
        );
        if (byIdempotency.rows[0]) {
          const record = toRecord(byIdempotency.rows[0]);
          return {
            record,
            status: record.requestFingerprint === input.requestFingerprint ? "replay" : "conflict",
          };
        }

        const overlapping = await client.query<AgentRunInputRow>(
          `select ${columns()} from ${responseTable}
           where run_id = $1
             and request_ids && $2::text[]
             and status <> 'failed'
           order by created_at asc
           limit 1`,
          [input.runId, input.requestIds],
        );
        if (overlapping.rows[0]) {
          return { record: toRecord(overlapping.rows[0]), status: "request-already-answered" };
        }

        const responseId = `arsp_${randomUUID()}`;
        const inserted = await client.query<AgentRunInputRow>(
          `insert into ${responseTable}
            (response_id, run_id, idempotency_key, request_fingerprint,
             request_ids, input_responses, status)
           values ($1, $2, $3, $4, $5::text[], $6::jsonb, 'submitting')
           returning ${columns()}`,
          [
            responseId,
            input.runId,
            input.idempotencyKey,
            input.requestFingerprint,
            input.requestIds,
            JSON.stringify(input.inputResponses),
          ],
        );
        return { record: toRecord(requireRow(inserted.rows[0])), status: "reserved" };
      });
    },
    async markAccepted(responseId) {
      return await transition(pool, responseTable, responseId, "accepted");
    },
    async markFailed(responseId, message) {
      return await transition(pool, responseTable, responseId, "failed", message);
    },
    async markSubmissionAmbiguous(responseId, message) {
      return await transition(pool, responseTable, responseId, "submission-ambiguous", message);
    },
  };
}

async function transition(
  pool: Pool,
  table: string,
  responseId: string,
  status: Exclude<AgentRunInputStatus, "submitting">,
  lastError?: string,
): Promise<AgentRunInputRecord> {
  const result = await pool.query<AgentRunInputRow>(
    `update ${table}
        set status = case when status = 'submitting' then $2 else status end,
            last_error = case when status = 'submitting' then $3 else last_error end,
            updated_at = case when status = 'submitting' then now() else updated_at end
      where response_id = $1
      returning ${columns()}`,
    [responseId, status, lastError ?? null],
  );
  return toRecord(requireRow(result.rows[0]));
}

type AgentRunInputRow = {
  createdAt: Date | string;
  idempotencyKey: string;
  inputResponses: readonly AgentRunInputResponse[];
  lastError: string | null;
  requestFingerprint: string;
  requestIds: readonly string[];
  responseId: string;
  runId: string;
  status: AgentRunInputStatus;
  updatedAt: Date | string;
};

function columns(): string {
  return `response_id as "responseId", run_id as "runId",
    idempotency_key as "idempotencyKey", request_fingerprint as "requestFingerprint",
    request_ids as "requestIds", input_responses as "inputResponses", status,
    last_error as "lastError", created_at as "createdAt", updated_at as "updatedAt"`;
}

function toRecord(row: AgentRunInputRow): AgentRunInputRecord {
  return {
    createdAt: iso(row.createdAt),
    idempotencyKey: row.idempotencyKey,
    inputResponses: row.inputResponses,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    requestFingerprint: row.requestFingerprint,
    requestIds: row.requestIds,
    responseId: row.responseId,
    runId: row.runId,
    status: row.status,
    updatedAt: iso(row.updatedAt),
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
  if (!row) throw new Error("The AgentRun input response persistence state changed unexpectedly.");
  return row;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
