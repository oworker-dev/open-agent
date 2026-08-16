import type { Pool } from "pg";
import type {
  AgentSubagentRecord,
  AgentSubagentStatus,
  AgentSubagentWaitPolicy,
} from "@oworker/open-agent-contracts/agent-session";
import type { AgentSessionOwner } from "./session-ownership-store.ts";
import {
  getAgentDatabasePool,
  quoteIdentifier,
  readAgentDatabaseConfig,
  type AgentDatabaseConfig,
} from "./agent-database.ts";

export type CreateAgentSubagentInput = {
  readonly childSessionId: string;
  readonly agentId?: string;
  readonly parentSessionId: string;
  readonly callId?: string;
  readonly toolName?: string;
  readonly name?: string;
  readonly nickname?: string;
  readonly task?: string;
  readonly status?: AgentSubagentStatus;
  readonly waitPolicy?: AgentSubagentWaitPolicy;
  readonly depth?: number;
  readonly owner: AgentSessionOwner;
};

export type UpdateAgentSubagentInput = {
  readonly agentId?: string;
  readonly name?: string;
  readonly nickname?: string;
  readonly task?: string;
  readonly status?: AgentSubagentStatus;
  readonly waitPolicy?: AgentSubagentWaitPolicy;
  readonly lastError?: string | null;
  readonly startedAt?: string;
  readonly finishedAt?: string | null;
};

export interface AgentSubagentStore {
  create(input: CreateAgentSubagentInput): Promise<AgentSubagentRecord>;
  findOwned(owner: AgentSessionOwner, childSessionId: string): Promise<AgentSubagentRecord | undefined>;
  listOwned(owner: AgentSessionOwner, parentSessionId: string): Promise<readonly AgentSubagentRecord[]>;
  updateOwned(owner: AgentSessionOwner, childSessionId: string, patch: UpdateAgentSubagentInput): Promise<AgentSubagentRecord | undefined>;
}

export function createMemoryAgentSubagentStore(): AgentSubagentStore {
  const records = new Map<string, { owner: AgentSessionOwner; record: AgentSubagentRecord }>();
  return {
    async create(input) {
      assertCreate(input);
      const existing = records.get(input.childSessionId);
      if (existing) {
        if (!sameOwner(existing.owner, input.owner)) throw new Error("The child session is owned by another principal.");
        if (input.status === "running" && (existing.record.status === "starting" || existing.record.status === "waiting")) {
          return (await this.updateOwned(input.owner, input.childSessionId, { status: "running" })) ?? existing.record;
        }
        return existing.record;
      }
      const now = new Date().toISOString();
      const record: AgentSubagentRecord = {
        childSessionId: input.childSessionId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        parentSessionId: input.parentSessionId,
        ...(input.callId ? { callId: input.callId } : {}),
        ...(input.toolName ? { toolName: input.toolName } : {}),
        ...(input.name ? { name: input.name } : {}),
        nickname: input.nickname?.trim() || makeNickname(input.name, input.childSessionId),
        ...(input.task ? { task: input.task } : {}),
        status: input.status ?? "starting",
        waitPolicy: input.waitPolicy ?? "wait",
        depth: input.depth ?? 1,
        createdAt: now,
        updatedAt: now,
        ...(input.status === "running" ? { startedAt: now } : {}),
      };
      records.set(input.childSessionId, { owner: input.owner, record });
      return record;
    },
    async findOwned(owner, childSessionId) {
      const item = records.get(childSessionId);
      return item && sameOwner(item.owner, owner) ? item.record : undefined;
    },
    async listOwned(owner, parentSessionId) {
      return [...records.values()]
        .filter((item) => sameOwner(item.owner, owner) && item.record.parentSessionId === parentSessionId)
        .map((item) => item.record)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async updateOwned(owner, childSessionId, patch) {
      const item = records.get(childSessionId);
      if (!item || !sameOwner(item.owner, owner)) return undefined;
      const current = item.record;
      const now = new Date().toISOString();
      const status = patch.status ?? current.status;
      const idle = status === "waiting" || status === "completed" || status === "failed" || status === "interrupted" || status === "closed";
      const startedAt = patch.startedAt ?? current.startedAt ?? (status === "running" ? now : undefined);
      const finishedAt = patch.finishedAt === null || status === "running" || status === "starting"
        ? undefined
        : patch.finishedAt ?? current.finishedAt ?? (idle ? now : undefined);
      const lastError = patch.lastError === null || status === "running"
        ? undefined
        : patch.lastError ?? current.lastError;
      const {
        finishedAt: _finishedAt,
        lastError: _lastError,
        startedAt: _startedAt,
        ...base
      } = current;
      const record: AgentSubagentRecord = {
        ...base,
        ...(patch.agentId ? { agentId: patch.agentId } : {}),
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.nickname ? { nickname: patch.nickname } : {}),
        ...(patch.task ? { task: patch.task } : {}),
        status,
        ...(patch.waitPolicy ? { waitPolicy: patch.waitPolicy } : {}),
        updatedAt: now,
        ...(lastError ? { lastError } : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(finishedAt ? { finishedAt } : {}),
      };
      records.set(childSessionId, { owner: item.owner, record });
      return record;
    },
  };
}

export function createPostgresAgentSubagentStore(config: AgentDatabaseConfig): AgentSubagentStore {
  const pool = getAgentDatabasePool(config);
  const table = `${quoteIdentifier(config.schema)}."agent_subagent_sessions"`;
  return postgresStore(pool, table);
}

export function createPostgresAgentSubagentStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentSubagentStore | undefined {
  const config = readAgentDatabaseConfig(environment);
  return config ? createPostgresAgentSubagentStore(config) : undefined;
}

function postgresStore(pool: Pool, table: string): AgentSubagentStore {
  return {
    async create(input) {
      assertCreate(input);
      const now = new Date().toISOString();
      const nickname = input.nickname?.trim() || makeNickname(input.name, input.childSessionId);
      const result = await pool.query<Row>(
        `insert into ${table}
          (child_session_id, agent_id, parent_session_id, call_id, tool_name, name, nickname, task,
           status, wait_policy, depth, tenant_id, principal_id, principal_type, issuer, created_at, updated_at, started_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17)
         on conflict (child_session_id) do update set
           agent_id = coalesce(excluded.agent_id, ${table}.agent_id),
           name = coalesce(excluded.name, ${table}.name),
           nickname = coalesce(nullif(excluded.nickname, ''), ${table}.nickname),
           task = coalesce(excluded.task, ${table}.task),
           status = case when ${table}.status in ('starting','waiting') and excluded.status = 'running' then excluded.status else ${table}.status end,
           updated_at = now()
         where ${table}.tenant_id = excluded.tenant_id
           and ${table}.principal_id = excluded.principal_id
           and ${table}.principal_type = excluded.principal_type
           and coalesce(${table}.issuer, '') = coalesce(excluded.issuer, '')
         returning ${columns()}`,
        [
          input.childSessionId, input.agentId ?? null, input.parentSessionId, input.callId ?? null,
          input.toolName ?? null, input.name ?? null, nickname, input.task ?? null,
          input.status ?? "starting", input.waitPolicy ?? "wait", input.depth ?? 1,
          input.owner.tenantId, input.owner.principalId, input.owner.principalType, input.owner.issuer ?? null,
          now, input.status === "running" ? now : null,
        ],
      );
      return toRecord(requireRow(result.rows[0]));
    },
    async findOwned(owner, childSessionId) {
      assertOwner(owner);
      const result = await pool.query<Row>(
        `select ${columns()} from ${table}
         where child_session_id = $1 and tenant_id = $2 and principal_id = $3
           and principal_type = $4 and coalesce(issuer, '') = $5`,
        [childSessionId, owner.tenantId, owner.principalId, owner.principalType, owner.issuer ?? ""],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async listOwned(owner, parentSessionId) {
      assertOwner(owner);
      const result = await pool.query<Row>(
        `select ${columns()} from ${table}
          where parent_session_id = $1 and tenant_id = $2 and principal_id = $3
            and principal_type = $4 and coalesce(issuer, '') = $5
          order by created_at asc`,
        [parentSessionId, owner.tenantId, owner.principalId, owner.principalType, owner.issuer ?? ""],
      );
      return result.rows.map(toRecord);
    },
    async updateOwned(owner, childSessionId, patch) {
      assertOwner(owner);
      const fields: string[] = [];
      const values: unknown[] = [childSessionId, owner.tenantId, owner.principalId, owner.principalType, owner.issuer ?? ""];
      const add = (column: string, value: unknown) => { fields.push(`${column} = $${values.length + 1}`); values.push(value); };
      if (patch.agentId) add("agent_id", patch.agentId);
      if (patch.name) add("name", patch.name);
      if (patch.nickname) add("nickname", patch.nickname);
      if (patch.task) add("task", patch.task);
      if (patch.status) add("status", patch.status);
      if (patch.waitPolicy) add("wait_policy", patch.waitPolicy);
      if (patch.lastError !== undefined) add("last_error", patch.lastError);
      if (patch.startedAt !== undefined) add("started_at", patch.startedAt);
      if (patch.finishedAt !== undefined) add("finished_at", patch.finishedAt);
      if (patch.status === "running") {
        if (patch.startedAt === undefined) fields.push("started_at = coalesce(started_at, now())");
        if (patch.finishedAt === undefined) fields.push("finished_at = null");
        if (patch.lastError === undefined) fields.push("last_error = null");
      } else if (
        patch.finishedAt === undefined &&
        (patch.status === "waiting" || patch.status === "completed" || patch.status === "failed" || patch.status === "interrupted" || patch.status === "closed")
      ) {
        fields.push("finished_at = coalesce(finished_at, now())");
      }
      if (fields.length === 0) return await this.findOwned(owner, childSessionId);
      fields.push("updated_at = now()");
      const result = await pool.query<Row>(
        `update ${table} set ${fields.join(", ")}
          where child_session_id = $1 and tenant_id = $2 and principal_id = $3
            and principal_type = $4 and coalesce(issuer, '') = $5
          returning ${columns()}`,
        values,
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
  };
}

type Row = {
  child_session_id: string; agent_id: string | null; parent_session_id: string; call_id: string | null;
  tool_name: string | null; name: string | null; nickname: string; task: string | null;
  status: AgentSubagentStatus; wait_policy: AgentSubagentWaitPolicy; depth: number;
  tenant_id: string; principal_id: string; principal_type: string; issuer: string | null;
  created_at: string | Date; updated_at: string | Date; started_at: string | Date | null; finished_at: string | Date | null; last_error: string | null;
};

function toRecord(row: Row): AgentSubagentRecord {
  return {
    childSessionId: row.child_session_id,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    parentSessionId: row.parent_session_id,
    ...(row.call_id ? { callId: row.call_id } : {}),
    ...(row.tool_name ? { toolName: row.tool_name } : {}),
    ...(row.name ? { name: row.name } : {}),
    nickname: row.nickname,
    ...(row.task ? { task: row.task } : {}),
    status: row.status,
    waitPolicy: row.wait_policy,
    depth: row.depth,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function columns(): string {
  return "child_session_id, agent_id, parent_session_id, call_id, tool_name, name, nickname, task, status, wait_policy, depth, tenant_id, principal_id, principal_type, issuer, created_at, updated_at, started_at, finished_at, last_error";
}

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new Error("The Agent subagent persistence state changed unexpectedly.");
  return row;
}

function iso(value: string | Date): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function makeNickname(name: string | undefined, childSessionId: string): string {
  const base = (name?.trim() || "subagent").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 24) || "subagent";
  const suffix = childSessionId.replace(/^ses[_-]/i, "").slice(-16) || childSessionId.slice(-8);
  return `${base}-${suffix}`.slice(0, 48);
}
function sameOwner(a: AgentSessionOwner, b: AgentSessionOwner): boolean {
  return a.tenantId === b.tenantId && a.principalId === b.principalId && a.principalType === b.principalType && (a.issuer ?? "") === (b.issuer ?? "");
}
function assertOwner(owner: AgentSessionOwner): void {
  for (const [key, value] of Object.entries(owner)) if (value !== undefined && (typeof value !== "string" || value.trim().length === 0 || value.length > 512)) throw new Error(`${key} is invalid.`);
}
function assertCreate(input: CreateAgentSubagentInput): void {
  assertOwner(input.owner);
  for (const [key, value] of [["childSessionId", input.childSessionId], ["parentSessionId", input.parentSessionId]] as const) if (value.trim().length === 0 || value.length > 512 || /\s/.test(value)) throw new Error(`${key} is invalid.`);
  if (input.depth !== undefined && (!Number.isSafeInteger(input.depth) || input.depth < 1 || input.depth > 32)) throw new Error("depth must be between 1 and 32.");
}
