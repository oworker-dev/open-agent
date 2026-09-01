import { randomUUID } from "node:crypto";
import { isBoundedAgentClientContext } from "@oworker/open-agent-contracts/client-context";
import type { Pool, PoolClient } from "pg";
import {
  getAgentDatabasePool,
  quoteIdentifier,
  readAgentDatabaseConfig,
  type AgentDatabaseConfig,
} from "./agent-database.ts";
import type { AgentSessionOwner } from "./session-ownership-store.ts";

export type AgentMailboxStatus =
  | "accepted"
  | "cancelled"
  | "committed"
  | "delivering"
  | "failed"
  | "queued"
  | "submission-ambiguous";

export type AgentMailboxPayload = {
  readonly clientContext?: readonly string[];
  readonly message: string;
  /** Stable product operation metadata. Eve treats the message as opaque text. */
  readonly operation?: {
    readonly beforeTurnId?: string;
    readonly expectedTurnId?: string;
    readonly kind: "send" | "steer" | "edit";
    readonly operationId: string;
  };
  readonly preferences?: {
    readonly executionMode: "automation" | "cautious" | "standard";
    readonly modelId: string;
    readonly reasoning: string;
  };
};

export type AgentMailboxItem = {
  readonly admissionStartedAt?: string;
  readonly acceptedAt?: string;
  readonly acceptedSessionId?: string;
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly claimExpiresAt?: string;
  readonly claimToken?: string;
  readonly clientMessageId: string;
  readonly committedAt?: string;
  readonly createdAt: string;
  readonly itemId: string;
  readonly lastError?: string;
  readonly payload: AgentMailboxPayload;
  readonly payloadFingerprint: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly issuer?: string;
  readonly sessionId: string;
  readonly status: AgentMailboxStatus;
  readonly tenantId: string;
  readonly updatedAt: string;
};

export type EnqueueAgentMailboxResult =
  | { readonly item: AgentMailboxItem; readonly status: "created" | "replay" }
  | { readonly item: AgentMailboxItem; readonly status: "conflict" }
  | { readonly status: "forbidden" | "full" | "missing-session" };

export interface AgentMailboxStore {
  accept(itemId: string, claimToken: string, acceptedSessionId: string): Promise<AgentMailboxItem>;
  beginAdmission(itemId: string, claimToken: string): Promise<AgentMailboxItem>;
  cancelOwned(owner: AgentSessionOwner, itemId: string): Promise<AgentMailboxItem | undefined>;
  claimNext(options?: { readonly leaseMs?: number }): Promise<AgentMailboxItem | undefined>;
  commit(itemId: string, acceptedSessionId: string): Promise<AgentMailboxItem>;
  defer(itemId: string, claimToken: string, availableAt: string, reason?: string): Promise<AgentMailboxItem>;
  deferRejectedAdmission(itemId: string, claimToken: string, availableAt: string, reason?: string): Promise<AgentMailboxItem>;
  enqueue(input: {
    readonly clientMessageId: string;
    readonly owner: AgentSessionOwner;
    readonly payload: AgentMailboxPayload;
    readonly payloadFingerprint: string;
    readonly sessionId: string;
  }): Promise<EnqueueAgentMailboxResult>;
  fail(itemId: string, claimToken: string, message: string): Promise<AgentMailboxItem>;
  findOwned(owner: AgentSessionOwner, itemId: string): Promise<AgentMailboxItem | undefined>;
  markSubmissionAmbiguous(itemId: string, claimToken: string, message: string): Promise<AgentMailboxItem>;
  retryOwned(owner: AgentSessionOwner, itemId: string): Promise<AgentMailboxItem | undefined>;
}

export function createPostgresAgentMailboxStore(config: AgentDatabaseConfig): AgentMailboxStore {
  const schema = quoteIdentifier(config.schema);
  return postgresAgentMailboxStore(
    getAgentDatabasePool(config),
    `${schema}."agent_session_owners"`,
    `${schema}."agent_mailbox_items"`,
  );
}

export function createPostgresAgentMailboxStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentMailboxStore | undefined {
  const config = readAgentDatabaseConfig(environment);
  return config ? createPostgresAgentMailboxStore(config) : undefined;
}

function postgresAgentMailboxStore(
  pool: Pool,
  ownershipTable: string,
  mailboxTable: string,
): AgentMailboxStore {
  return {
    async enqueue(input) {
      assertOwner(input.owner);
      assertText(input.sessionId, "sessionId", 512);
      assertText(input.clientMessageId, "clientMessageId", 200);
      assertText(input.payloadFingerprint, "payloadFingerprint", 128);
      assertPayload(input.payload);

      return await inTransaction(pool, async (client) => {
        const ownerResult = await client.query<{ principal_id: string; tenant_id: string }>(
          `select tenant_id, principal_id from ${ownershipTable} where session_id = $1 for update`,
          [input.sessionId],
        );
        const owner = ownerResult.rows[0];
        if (!owner) return { status: "missing-session" } as const;
        if (
          owner.tenant_id !== input.owner.tenantId ||
          owner.principal_id !== input.owner.principalId
        ) return { status: "forbidden" } as const;

        const existing = await client.query<AgentMailboxRow>(
          `select ${selectColumns()} from ${mailboxTable}
            where tenant_id = $1 and principal_id = $2 and client_message_id = $3`,
          [input.owner.tenantId, input.owner.principalId, input.clientMessageId],
        );
        if (existing.rows[0]) {
          const item = toRecord(existing.rows[0]);
          return {
            item,
            status: item.payloadFingerprint === input.payloadFingerprint &&
                item.sessionId === input.sessionId
              ? "replay"
              : "conflict",
          } as const;
        }

        const pending = await client.query<{ count: string }>(
          `select count(*)::text as count from ${mailboxTable}
            where session_id = $1
              and status not in ('committed', 'cancelled')`,
          [input.sessionId],
        );
        if (Number(pending.rows[0]?.count ?? "0") >= 5) {
          return { status: "full" } as const;
        }

        const itemId = `mail_${randomUUID()}`;
        const inserted = await client.query<AgentMailboxRow>(
          `insert into ${mailboxTable}
            (item_id, tenant_id, principal_id, session_id, client_message_id,
             principal_type, issuer, payload_fingerprint, payload)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
           on conflict (tenant_id, principal_id, client_message_id) do nothing
           returning ${selectColumns()}`,
          [
            itemId,
            input.owner.tenantId,
            input.owner.principalId,
            input.sessionId,
            input.clientMessageId,
            input.owner.principalType,
            input.owner.issuer ?? null,
            input.payloadFingerprint,
            JSON.stringify(input.payload),
          ],
        );
        return { item: toRecord(requireRow(inserted.rows[0])), status: "created" } as const;
      });
    },
    async claimNext(options) {
      const leaseMs = options?.leaseMs ?? 60_000;
      assertLease(leaseMs);
      await pool.query(
        `update ${mailboxTable}
            set status = 'submission-ambiguous', claim_token = null,
                claim_expires_at = null,
                last_error = 'The dispatcher lease expired after delivery admission began; automatic replay is disabled.',
                updated_at = now()
          where status = 'delivering' and claim_expires_at < now()
            and admission_started_at is not null`,
      );
      const claimToken = randomUUID();
      const result = await pool.query<AgentMailboxRow>(
        `with candidate as (
           select item_id
             from ${mailboxTable} item
            where (
                (item.status = 'queued' and item.available_at <= now())
                or (
                  item.status = 'delivering' and item.claim_expires_at < now()
                  and item.admission_started_at is null
                )
              )
              and not exists (
                select 1 from ${mailboxTable} blocker
                 where blocker.session_id = item.session_id
                   and blocker.item_id <> item.item_id
                   and blocker.status not in ('committed', 'cancelled')
                   and (blocker.created_at, blocker.item_id) < (item.created_at, item.item_id)
              )
            order by item.available_at, item.created_at, item.item_id
            for update skip locked
            limit 1
         )
         update ${mailboxTable} item
            set status = 'delivering',
                claim_token = $1,
                claim_expires_at = now() + ($2::bigint * interval '1 millisecond'),
                admission_started_at = null,
                attempt_count = attempt_count + 1,
                last_error = null,
                updated_at = now()
           from candidate
          where item.item_id = candidate.item_id
         returning ${selectColumns("item")}`,
        [claimToken, leaseMs],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async beginAdmission(itemId, claimToken) {
      assertText(itemId, "itemId", 512);
      assertText(claimToken, "claimToken", 512);
      const result = await pool.query<AgentMailboxRow>(
        `update ${mailboxTable}
            set admission_started_at = now(), updated_at = now()
          where item_id = $1 and status = 'delivering' and claim_token = $2
            and admission_started_at is null and claim_expires_at >= now()
         returning ${selectColumns()}`,
        [itemId, claimToken],
      );
      return toRecord(requireRow(result.rows[0]));
    },
    async defer(itemId, claimToken, availableAt, reason) {
      assertText(itemId, "itemId", 512);
      assertText(claimToken, "claimToken", 512);
      const timestamp = parseTimestamp(availableAt, "availableAt");
      const result = await pool.query<AgentMailboxRow>(
        `update ${mailboxTable}
            set status = 'queued', claim_token = null, claim_expires_at = null,
                admission_started_at = null,
                available_at = $3, last_error = $4, updated_at = now()
          where item_id = $1 and status = 'delivering' and claim_token = $2
            and admission_started_at is null
         returning ${selectColumns()}`,
        [itemId, claimToken, timestamp, compactError(reason)],
      );
      return toRecord(requireRow(result.rows[0]));
    },
    async deferRejectedAdmission(itemId, claimToken, availableAt, reason) {
      assertText(itemId, "itemId", 512);
      assertText(claimToken, "claimToken", 512);
      const timestamp = parseTimestamp(availableAt, "availableAt");
      const result = await pool.query<AgentMailboxRow>(
        `update ${mailboxTable}
            set status = 'queued', claim_token = null, claim_expires_at = null,
                admission_started_at = null,
                available_at = $3, last_error = $4, updated_at = now()
          where item_id = $1 and status = 'delivering' and claim_token = $2
         returning ${selectColumns()}`,
        [itemId, claimToken, timestamp, compactError(reason)],
      );
      return toRecord(requireRow(result.rows[0]));
    },
    async accept(itemId, claimToken, acceptedSessionId) {
      assertText(acceptedSessionId, "acceptedSessionId", 512);
      const accepted = await claimedTransition(pool, mailboxTable, itemId, claimToken, {
        acceptedSessionId,
        status: "accepted",
      }, false);
      if (accepted) return accepted;
      const committed = await pool.query<AgentMailboxRow>(
        `select ${selectColumns()} from ${mailboxTable}
          where item_id = $1 and status = 'committed' and accepted_session_id = $2`,
        [itemId, acceptedSessionId],
      );
      return toRecord(requireRow(committed.rows[0]));
    },
    async commit(itemId, acceptedSessionId) {
      assertText(itemId, "itemId", 512);
      assertText(acceptedSessionId, "acceptedSessionId", 512);
      const result = await pool.query<AgentMailboxRow>(
        `update ${mailboxTable}
            set status = 'committed',
                accepted_session_id = coalesce(accepted_session_id, $2),
                accepted_at = coalesce(accepted_at, now()),
                committed_at = coalesce(committed_at, now()),
                claim_token = null, claim_expires_at = null,
                updated_at = now()
          where item_id = $1
            and status in ('delivering', 'accepted', 'submission-ambiguous', 'committed')
            and (accepted_session_id is null or accepted_session_id = $2)
         returning ${selectColumns()}`,
        [itemId, acceptedSessionId],
      );
      return toRecord(requireRow(result.rows[0]));
    },
    async fail(itemId, claimToken, message) {
      return await claimedTransition(pool, mailboxTable, itemId, claimToken, {
        lastError: compactError(message) ?? "Mailbox delivery failed.",
        status: "failed",
      });
    },
    async markSubmissionAmbiguous(itemId, claimToken, message) {
      return await claimedTransition(pool, mailboxTable, itemId, claimToken, {
        lastError: compactError(message) ?? "Mailbox admission is ambiguous.",
        status: "submission-ambiguous",
      });
    },
    async findOwned(owner, itemId) {
      assertOwner(owner);
      assertText(itemId, "itemId", 512);
      const result = await pool.query<AgentMailboxRow>(
        `select ${selectColumns()} from ${mailboxTable}
          where item_id = $1 and tenant_id = $2 and principal_id = $3`,
        [itemId, owner.tenantId, owner.principalId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async cancelOwned(owner, itemId) {
      assertOwner(owner);
      assertText(itemId, "itemId", 512);
      const result = await pool.query<AgentMailboxRow>(
        `update ${mailboxTable}
            set status = 'cancelled', claim_token = null, claim_expires_at = null,
                admission_started_at = null, last_error = null, updated_at = now()
          where item_id = $1 and tenant_id = $2 and principal_id = $3
            and (
              status in ('queued', 'failed')
              or (status = 'delivering' and admission_started_at is null)
            )
         returning ${selectColumns()}`,
        [itemId, owner.tenantId, owner.principalId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async retryOwned(owner, itemId) {
      assertOwner(owner);
      assertText(itemId, "itemId", 512);
      const result = await pool.query<AgentMailboxRow>(
        `update ${mailboxTable}
            set status = 'queued', available_at = now(), last_error = null,
                admission_started_at = null, updated_at = now()
          where item_id = $1 and tenant_id = $2 and principal_id = $3
            and status = 'failed'
         returning ${selectColumns()}`,
        [itemId, owner.tenantId, owner.principalId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
  };
}

async function claimedTransition(
  pool: Pool,
  table: string,
  itemId: string,
  claimToken: string,
  transition: {
    readonly acceptedSessionId?: string;
    readonly lastError?: string;
    readonly status: "accepted" | "failed" | "submission-ambiguous";
  },
  required: false,
): Promise<AgentMailboxItem | undefined>;
async function claimedTransition(
  pool: Pool,
  table: string,
  itemId: string,
  claimToken: string,
  transition: {
    readonly acceptedSessionId?: string;
    readonly lastError?: string;
    readonly status: "accepted" | "failed" | "submission-ambiguous";
  },
  required?: true,
): Promise<AgentMailboxItem>;
async function claimedTransition(
  pool: Pool,
  table: string,
  itemId: string,
  claimToken: string,
  transition: {
    readonly acceptedSessionId?: string;
    readonly lastError?: string;
    readonly status: "accepted" | "failed" | "submission-ambiguous";
  },
  required = true,
): Promise<AgentMailboxItem | undefined> {
  assertText(itemId, "itemId", 512);
  assertText(claimToken, "claimToken", 512);
  const result = await pool.query<AgentMailboxRow>(
    `update ${table}
        set status = $3, claim_token = null, claim_expires_at = null,
            admission_started_at = admission_started_at,
            accepted_session_id = coalesce($4, accepted_session_id),
            accepted_at = case when $3 = 'accepted' then now() else accepted_at end,
            last_error = $5, updated_at = now()
      where item_id = $1 and status = 'delivering' and claim_token = $2
     returning ${selectColumns()}`,
    [itemId, claimToken, transition.status, transition.acceptedSessionId ?? null, transition.lastError ?? null],
  );
  if (!result.rows[0]) {
    if (required) requireRow(result.rows[0]);
    return undefined;
  }
  return toRecord(result.rows[0]);
}

type AgentMailboxRow = {
  admissionStartedAt: Date | string | null;
  acceptedAt: Date | string | null;
  acceptedSessionId: string | null;
  attemptCount: number;
  availableAt: Date | string;
  claimExpiresAt: Date | string | null;
  claimToken: string | null;
  clientMessageId: string;
  committedAt: Date | string | null;
  createdAt: Date | string;
  itemId: string;
  lastError: string | null;
  payload: AgentMailboxPayload;
  payloadFingerprint: string;
  principalId: string;
  principalType: string;
  issuer: string | null;
  sessionId: string;
  status: AgentMailboxStatus;
  tenantId: string;
  updatedAt: Date | string;
};

function selectColumns(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `${prefix}item_id as "itemId", ${prefix}tenant_id as "tenantId",
    ${prefix}principal_id as "principalId", ${prefix}session_id as "sessionId",
    ${prefix}client_message_id as "clientMessageId",
    ${prefix}principal_type as "principalType", ${prefix}issuer,
    ${prefix}payload_fingerprint as "payloadFingerprint", ${prefix}payload,
    ${prefix}status, ${prefix}attempt_count as "attemptCount",
    ${prefix}available_at as "availableAt", ${prefix}claim_token as "claimToken",
    ${prefix}claim_expires_at as "claimExpiresAt",
    ${prefix}admission_started_at as "admissionStartedAt",
    ${prefix}accepted_session_id as "acceptedSessionId", ${prefix}last_error as "lastError",
    ${prefix}created_at as "createdAt", ${prefix}updated_at as "updatedAt",
    ${prefix}accepted_at as "acceptedAt", ${prefix}committed_at as "committedAt"`;
}

function toRecord(row: AgentMailboxRow): AgentMailboxItem {
  return {
    ...(row.admissionStartedAt ? { admissionStartedAt: toIso(row.admissionStartedAt) } : {}),
    ...(row.acceptedAt ? { acceptedAt: toIso(row.acceptedAt) } : {}),
    ...(row.acceptedSessionId ? { acceptedSessionId: row.acceptedSessionId } : {}),
    attemptCount: row.attemptCount,
    availableAt: toIso(row.availableAt),
    ...(row.claimExpiresAt ? { claimExpiresAt: toIso(row.claimExpiresAt) } : {}),
    ...(row.claimToken ? { claimToken: row.claimToken } : {}),
    clientMessageId: row.clientMessageId,
    ...(row.committedAt ? { committedAt: toIso(row.committedAt) } : {}),
    createdAt: toIso(row.createdAt),
    itemId: row.itemId,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    payload: row.payload,
    payloadFingerprint: row.payloadFingerprint,
    principalId: row.principalId,
    principalType: row.principalType,
    ...(row.issuer ? { issuer: row.issuer } : {}),
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

function assertOwner(owner: AgentSessionOwner): void {
  assertText(owner.tenantId, "tenantId", 512);
  assertText(owner.principalId, "principalId", 512);
  assertText(owner.principalType, "principalType", 512);
}

function assertPayload(payload: AgentMailboxPayload): void {
  assertText(payload.message, "payload.message", 65_536);
  if (payload.operation) {
    assertText(payload.operation.operationId, "payload.operation.operationId", 200);
    if (!["send", "steer", "edit"].includes(payload.operation.kind)) {
      throw new Error("payload.operation.kind is invalid.");
    }
    if (payload.operation.expectedTurnId) {
      assertText(payload.operation.expectedTurnId, "payload.operation.expectedTurnId", 512);
    }
  }
  if (payload.clientContext && !isBoundedAgentClientContext(payload.clientContext)) {
    throw new Error("payload.clientContext exceeds the 20k-token transport budget.");
  }
  if (payload.preferences) {
    assertText(payload.preferences.modelId, "payload.preferences.modelId", 200);
    assertText(payload.preferences.reasoning, "payload.preferences.reasoning", 100);
    if (![
      "automation",
      "cautious",
      "standard",
    ].includes(payload.preferences.executionMode)) {
      throw new Error("payload.preferences.executionMode is invalid.");
    }
  }
}

function assertLease(leaseMs: number): void {
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) {
    throw new Error("leaseMs must be an integer from 1000 to 900000.");
  }
}

function assertText(value: string, name: string, maximum: number): void {
  if (value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${name} must contain between 1 and ${maximum} characters.`);
  }
}

function parseTimestamp(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

function compactError(value: string | undefined): string | null {
  const compact = value?.trim().slice(0, 2_000);
  return compact || null;
}

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new Error("Agent mailbox persistence state changed unexpectedly.");
  return row;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
