import type {
  AgentSessionApprovalRequest,
  AgentSessionApprovalStatus,
} from "@oworker/open-agent-contracts/agent-session";
import type { Pool } from "pg";
import {
  getAgentDatabasePool,
  quoteIdentifier,
  readAgentDatabaseConfig,
  type AgentDatabaseConfig,
} from "../data/agent-database.ts";

type ApprovalResolution = "approve" | "reject" | "cancel" | "expire";
type ApprovalEvent = { readonly type: string; readonly data?: unknown; readonly meta?: unknown; readonly scope?: unknown };

export type AgentSessionApprovalStore = {
  get(requestId: string): Promise<AgentSessionApprovalRequest | undefined>;
  findByToolCall(sessionId: string, toolCallId: string): Promise<AgentSessionApprovalRequest | undefined>;
  listPending(sessionId: string): Promise<readonly AgentSessionApprovalRequest[]>;
  put(request: AgentSessionApprovalRequest): Promise<AgentSessionApprovalRequest>;
  resolve(
    requestId: string,
    resolution: ApprovalResolution,
    resolvedAt?: string,
  ): Promise<AgentSessionApprovalRequest | undefined>;
};

/**
 * Reconcile the durable approval projection from an Eve event page.
 *
 * Eve streams are replayable and may be delivered more than once after a
 * reconnect. `put` is therefore deliberately idempotent and an already
 * resolved request is never downgraded by a replayed `interaction.opened` event.
 */
export async function syncAgentSessionApprovalsFromEvents(options: {
  readonly events: readonly ApprovalEvent[];
  /** A page can open an approval for a call recorded on an earlier source line. */
  readonly readPriorEvents?: () => Promise<readonly ApprovalEvent[]>;
  readonly sessionId: string;
  readonly store: AgentSessionApprovalStore;
}): Promise<readonly AgentSessionApprovalRequest[]> {
  if (options.readPriorEvents) {
    const knownCalls = new Set(options.events.flatMap((event) => event.type === "call.requested" && isRecord(event.data)
      && typeof event.data.callId === "string" ? [event.data.callId] : []));
    const missingCall = options.events.some((event) => event.type === "interaction.opened" && isRecord(event.data)
      && isRecord(event.data.request) && event.data.request.kind === "approval" && isRecord(event.data.subject)
      && typeof event.data.subject.callId === "string" && !knownCalls.has(event.data.subject.callId)
      && !(isRecord(event.data.origin) && isRecord(event.data.origin.call)));
    if (missingCall) return syncAgentSessionApprovalsFromEvents({ sessionId: options.sessionId, store: options.store,
      events: [...await options.readPriorEvents(), ...options.events] });
  }
  const byCall = new Map<string, AgentSessionApprovalRequest>(
    (await options.store.listPending(options.sessionId)).map((request) => [request.toolCallId, request]),
  );
  async function resolveRequest(requestId: string, resolution: ApprovalResolution, at?: string) {
    const current = await options.store.get(requestId);
    if (!current || current.sessionId !== options.sessionId) return;
    const resolved = await options.store.resolve(requestId, resolution, at);
    if (resolved) byCall.set(resolved.toolCallId, resolved);
  }
  const calls = new Map<string, { name: string; input: AgentSessionApprovalRequest["input"] }>();
  for (const event of options.events) {
    const data = isRecord(event.data) ? event.data : undefined;
    if (!data) continue;
    if (event.type === "call.requested" && typeof data.callId === "string" && isRecord(data.capability) && typeof data.capability.name === "string") {
      calls.set(data.callId, { name: data.capability.name, input: isRecord(data.input) ? data.input as AgentSessionApprovalRequest["input"] : {} });
    } else if (event.type === "interaction.opened" && typeof data.interactionId === "string" &&
        isRecord(data.request) && data.request.kind === "approval" && isRecord(data.subject)) {
      const origin = isRecord(data.origin) && isRecord(data.origin.call) ? data.origin.call : undefined;
      const callId = origin?.callId ?? data.subject.callId;
      if (typeof callId !== "string") continue;
      const call = origin && typeof origin.name === "string"
        ? { name: origin.name, input: isRecord(origin.input) ? origin.input as AgentSessionApprovalRequest["input"] : {} }
        : calls.get(callId);
      if (!call) continue;
      const scope = "scope" in event && isRecord(event.scope) ? event.scope : undefined;
      const projected: AgentSessionApprovalRequest = {
        requestId: data.interactionId,
        sessionId: options.sessionId,
        ...(typeof scope?.turnId === "string" ? { turnId: scope.turnId } : {}),
        toolCallId: callId, toolName: call.name, input: call.input,
        status: "requested", createdAt: metaAt(event.meta) ?? new Date().toISOString(),
      };
      byCall.set(callId, await options.store.put(projected));
    } else if (event.type === "interaction.settled" && typeof data.interactionId === "string") {
      if (data.outcome === "accepted" || data.outcome === "declined") {
        await resolveRequest(data.interactionId, data.outcome === "accepted" ? "approve" : "reject", metaAt(event.meta));
      } else if (["withdrawn", "interrupted", "abandoned", "expired", "failed"].includes(String(data.outcome))) {
        await resolveRequest(data.interactionId, data.outcome === "expired" ? "expire" : "cancel", metaAt(event.meta));
      }
    } else if (event.type === "call.settled" && typeof data.callId === "string") {
      const current = byCall.get(data.callId) ?? await options.store.findByToolCall(options.sessionId, data.callId);
      if (!current || current.status !== "requested") continue;
      if (data.outcome !== "rejected" && data.outcome !== "completed" && data.outcome !== "failed") continue;
      const resolved = await options.store.resolve(current.requestId, data.outcome === "rejected" ? "reject" : "approve", metaAt(event.meta));
      if (resolved) byCall.set(resolved.toolCallId, resolved);
    }
  }
  return await options.store.listPending(options.sessionId);
}

/**
 * Small reference store useful to hosts and tests.  Production hosts should
 * provide the same contract backed by their database; the Agent kernel never
 * assumes a particular persistence engine.
 */
export function createMemoryAgentSessionApprovalStore(): AgentSessionApprovalStore {
  const records = new Map<string, AgentSessionApprovalRequest>();
  return {
    async get(requestId) {
      return records.get(requestId);
    },
    async findByToolCall(sessionId, toolCallId) {
      return [...records.values()].find((request) => request.sessionId === sessionId && request.toolCallId === toolCallId);
    },
    async listPending(sessionId) {
      return [...records.values()]
        .filter((request) => request.sessionId === sessionId && request.status === "requested")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async put(request) {
      const existing = records.get(request.requestId);
      if (existing && !sameRequest(existing, request)) {
        throw new Error("The approval request id is already bound to another request.");
      }
      records.set(request.requestId, existing ?? request);
      return existing ?? request;
    },
    async resolve(requestId, resolution, resolvedAt = new Date().toISOString()) {
      const current = records.get(requestId);
      if (!current) return undefined;
      if (current.status !== "requested") return current;
      const status: AgentSessionApprovalStatus = resolution === "approve" ? "approved" : resolution === "reject" ? "rejected" : resolution === "expire" ? "expired" : "cancelled";
      const resolved = { ...current, resolvedAt, ...(resolution === "approve" || resolution === "reject" ? { selection: resolution } : {}), status };
      records.set(requestId, resolved);
      return resolved;
    },
  };
}

/**
 * Durable approval store used by production hosts. Approval records are
 * keyed by Eve's request id and are intentionally separate from the Eve
 * event stream: the stream remains the source of truth for replay while this
 * table makes the current pending state cheap to recover after a restart.
 */
export function createPostgresAgentSessionApprovalStore(
  config: AgentDatabaseConfig,
): AgentSessionApprovalStore {
  const pool = getAgentDatabasePool(config);
  const table = `${quoteIdentifier(config.schema)}."agent_session_approvals"`;
  return postgresApprovalStore(pool, table);
}

export function createPostgresAgentSessionApprovalStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentSessionApprovalStore | undefined {
  const config = readAgentDatabaseConfig(environment);
  return config ? createPostgresAgentSessionApprovalStore(config) : undefined;
}

function postgresApprovalStore(pool: Pool, table: string): AgentSessionApprovalStore {
  return {
    async get(requestId) {
      const result = await pool.query<ApprovalRow>(
        `select ${approvalColumns()} from ${table} where request_id = $1`,
        [requestId],
      );
      return result.rows[0] ? toApproval(result.rows[0]) : undefined;
    },
    async findByToolCall(sessionId, toolCallId) {
      const result = await pool.query<ApprovalRow>(
        `select ${approvalColumns()} from ${table} where session_id = $1 and tool_call_id = $2 limit 1`,
        [sessionId, toolCallId],
      );
      return result.rows[0] ? toApproval(result.rows[0]) : undefined;
    },
    async listPending(sessionId) {
      const result = await pool.query<ApprovalRow>(
        `select ${approvalColumns()} from ${table}
         where session_id = $1 and status = 'requested'
         order by created_at asc`,
        [sessionId],
      );
      return result.rows.map(toApproval);
    },
    async put(request) {
      assertApprovalRequest(request);
      const result = await pool.query<ApprovalRow>(
        `insert into ${table}
          (request_id, session_id, turn_id, tool_call_id, tool_name, input, status,
           selection, created_at, resolved_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
         on conflict (request_id) do update set
           session_id = ${table}.session_id
         returning ${approvalColumns()}`,
        [
          request.requestId,
          request.sessionId,
          request.turnId ?? null,
          request.toolCallId,
          request.toolName,
          JSON.stringify(request.input),
          request.status,
          request.selection ?? null,
          request.createdAt,
          request.resolvedAt ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("The approval request could not be persisted.");
      const persisted = toApproval(row);
      if (!sameRequest(persisted, request)) {
        throw new Error("The approval request id is already bound to another request.");
      }
      return persisted;
    },
    async resolve(requestId, resolution, resolvedAt = new Date().toISOString()) {
      const status: AgentSessionApprovalStatus = resolution === "approve" ? "approved" : resolution === "reject" ? "rejected" : resolution === "expire" ? "expired" : "cancelled";
      const result = await pool.query<ApprovalRow>(
        `update ${table}
         set status = case when status = 'requested' then $2 else status end,
             selection = case when status = 'requested' then $3 else selection end,
             resolved_at = case when status = 'requested' then $4 else resolved_at end
         where request_id = $1
         returning ${approvalColumns()}`,
        [requestId, status, resolution === "approve" || resolution === "reject" ? resolution : null, resolvedAt],
      );
      return result.rows[0] ? toApproval(result.rows[0]) : undefined;
    },
  };
}

type ApprovalRow = {
  request_id: string;
  session_id: string;
  turn_id: string | null;
  tool_call_id: string;
  tool_name: string;
  input: unknown;
  status: AgentSessionApprovalStatus;
  selection: "approve" | "reject" | null;
  created_at: string | Date;
  resolved_at: string | Date | null;
};

function approvalColumns(): string {
  return "request_id, session_id, turn_id, tool_call_id, tool_name, input, status, selection, created_at, resolved_at";
}

function toApproval(row: ApprovalRow): AgentSessionApprovalRequest {
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    input: isJsonObject(row.input) ? row.input : {},
    status: row.status,
    ...(row.selection ? { selection: row.selection } : {}),
    createdAt: iso(row.created_at),
    ...(row.resolved_at ? { resolvedAt: iso(row.resolved_at) } : {}),
  };
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isJsonObject(value: unknown): value is Record<string, never> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertApprovalRequest(request: AgentSessionApprovalRequest): void {
  for (const [key, value] of Object.entries(request)) {
    if ((key === "input" || value === undefined) && key === "input") continue;
    if (typeof value === "string" && (value.trim().length === 0 || value.length > 1_000_000)) {
      throw new Error(`${key} is invalid.`);
    }
  }
}

function sameRequest(
  left: AgentSessionApprovalRequest,
  right: AgentSessionApprovalRequest,
): boolean {
  return left.requestId === right.requestId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.toolCallId === right.toolCallId &&
    left.toolName === right.toolName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metaAt(value: unknown): string | undefined {
  return isRecord(value) && typeof value.at === "string" ? value.at : undefined;
}
