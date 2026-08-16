import { randomUUID } from "node:crypto";
import type {
  AgentSubagentRecord,
  AgentSubagentSnapshot,
  AgentSubagentStatus,
  AgentSubagentWaitPolicy,
} from "@oworker/open-agent-contracts/agent-session";
import type { AgentSessionOwner, AgentSessionOwnershipStore } from "../data/session-ownership-store.ts";
import type { AgentSubagentStore, CreateAgentSubagentInput } from "../data/agent-subagent-store.ts";
import type { AgentMailboxStore } from "../data/agent-mailbox-store.ts";
import { enqueueAgentMailboxMessage } from "../agent-mailbox/service.ts";
import { eveAgentSessionRuntime } from "./service.ts";
import { createEveAgentMailboxRuntime } from "../agent-mailbox/eve-runtime.ts";

export class AgentSubagentError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AgentSubagentError";
    this.status = status;
    this.code = code;
  }
}

export type AgentSubagentRuntime = {
  readonly spawn?: (input: {
    readonly accessToken: string;
    readonly owner: AgentSessionOwner;
    readonly parentSessionId: string;
    readonly task: string;
    readonly name?: string;
    readonly waitPolicy: AgentSubagentWaitPolicy;
  }) => Promise<{ readonly childSessionId: string; readonly agentId?: string; readonly name?: string }>;
  readonly inspect: (input: { readonly owner: AgentSessionOwner; readonly sessionId: string }) => Promise<{
    readonly status: "running" | "waiting" | "completed" | "failed" | "cancelled";
    readonly activeTurnId?: string;
  }>;
  readonly cancel: (input: { readonly accessToken: string; readonly sessionId: string }) => Promise<"accepted" | "no_active_turn">;
};

export const eveAgentSubagentRuntime: AgentSubagentRuntime = {
  async inspect(input) {
    const boundary = await createEveAgentMailboxRuntime().inspect(input);
    return boundary.state === "running"
      ? { status: "running" as const, ...(boundary.turnId ? { activeTurnId: boundary.turnId } : {}) }
      : boundary.state === "terminal"
        ? { status: boundary.terminalStatus === "failed" ? "failed" as const : "completed" as const }
        : { status: "waiting" as const };
  },
  async cancel(input) {
    return await eveAgentSessionRuntime.cancel(input);
  },
};

export type AgentSubagentSupervisorOptions = {
  readonly accessToken: string;
  readonly identity: AgentSessionOwner;
  readonly ownershipStore: AgentSessionOwnershipStore;
  readonly store: AgentSubagentStore;
  readonly mailboxStore?: AgentMailboxStore;
  readonly runtime?: AgentSubagentRuntime;
};

export async function listAgentSubagents(options: AgentSubagentSupervisorOptions & {
  readonly parentSessionId: string;
}): Promise<AgentSubagentSnapshot | undefined> {
  const ownership = await options.ownershipStore.verify(options.parentSessionId, options.identity);
  if (ownership !== "owned") return undefined;
  const children = await options.store.listOwned(options.identity, options.parentSessionId);
  return snapshot(options.parentSessionId, children);
}

/**
 * Refresh one child from Eve's authoritative session boundary before it is
 * rendered or acted on. The parent stream is a control-plane projection and
 * may not receive a final event when the browser is on the child view.
 */
export async function inspectAgentSubagent(options: AgentSubagentSupervisorOptions & {
  readonly childSessionId: string;
}): Promise<AgentSubagentRecord | undefined> {
  const child = await ownedChild(options);
  if (!child) return undefined;
  let inspected: Awaited<ReturnType<NonNullable<AgentSubagentRuntime["inspect"]>>>;
  try {
    inspected = await (options.runtime ?? eveAgentSubagentRuntime).inspect({
      owner: options.identity,
      sessionId: child.childSessionId,
    });
  } catch {
    // A transient runtime outage must not make a persisted child disappear
    // from the secondary view. The next refresh can reconcile it again.
    return child;
  }
  const status = mapRuntimeStatus(inspected.status);
  return await options.store.updateOwned(options.identity, child.childSessionId, {
    status,
  }) ?? child;
}

/**
 * Ingest the durable parent events into lifecycle metadata. This is idempotent
 * and intentionally derives state from Eve's authoritative child session ids.
 */
export async function syncAgentSubagentsFromEvents(options: AgentSubagentSupervisorOptions & {
  readonly parentSessionId: string;
  readonly events: readonly { readonly type: string; readonly data?: unknown }[];
}): Promise<readonly AgentSubagentRecord[]> {
  const ownership = await options.ownershipStore.verify(options.parentSessionId, options.identity);
  if (ownership !== "owned") return [];
  const children = new Map((await options.store.listOwned(options.identity, options.parentSessionId)).map((item) => [item.childSessionId, item]));
  const byCall = new Map([...children.values()].filter((item) => item.callId).map((item) => [item.callId!, item]));
  const parentCancelled = options.events.some((event) => event.type === "turn.cancelled");
  const parentTerminal = options.events.some((event) => event.type === "session.failed" || event.type === "session.completed");
  for (const event of options.events) {
    const data = eventData(event);
    if (!data) continue;
    if (event.type === "subagent.called" && typeof data.childSessionId === "string" && data.childSessionId.trim()) {
      const childSessionId = data.childSessionId;
      const created = await options.store.create({
        childSessionId,
        parentSessionId: options.parentSessionId,
        owner: options.identity,
        ...(typeof data.agentId === "string" ? { agentId: data.agentId } : {}),
        ...(typeof data.callId === "string" ? { callId: data.callId } : {}),
        ...(typeof data.toolName === "string" ? { toolName: data.toolName } : {}),
        ...(typeof data.name === "string" ? { name: data.name } : {}),
        ...(typeof data.task === "string" ? { task: data.task } : typeof data.input === "object" && data.input && typeof (data.input as Record<string, unknown>).message === "string" ? { task: (data.input as Record<string, unknown>).message as string } : {}),
        status: "running",
        waitPolicy: data.waitPolicy === "no-wait" ? "no-wait" : "wait",
        depth: typeof data.depth === "number" && Number.isSafeInteger(data.depth) ? data.depth : 1,
      });
      children.set(childSessionId, created);
      if (created.callId) byCall.set(created.callId, created);
    } else if (event.type === "subagent.completed") {
      const callId = typeof data.callId === "string" ? data.callId : undefined;
      const child = (callId ? byCall.get(callId) : undefined) ?? (typeof data.childSessionId === "string" ? children.get(data.childSessionId) : undefined);
      if (!child) continue;
      const result = data.result;
      const failed = isRecord(result) && (
        result.status === "failed" ||
        result.isError === true ||
        typeof result.error === "string"
      );
      const updated = await options.store.updateOwned(options.identity, child.childSessionId, {
        status: failed ? "failed" : "completed",
        ...(failed && isRecord(result) && typeof result.error === "string" ? { lastError: result.error.slice(0, 2_000) } : {}),
      });
      if (updated) children.set(updated.childSessionId, updated);
    }
  }
  if (parentCancelled || parentTerminal) {
    const status: AgentSubagentStatus = parentCancelled ? "interrupted" : "failed";
    for (const child of children.values()) {
      if (child.status !== "starting" && child.status !== "running" && child.status !== "waiting") continue;
      const updated = await options.store.updateOwned(options.identity, child.childSessionId, { status });
      if (updated) children.set(updated.childSessionId, updated);
    }
  }
  return [...children.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function spawnAgentSubagent(options: AgentSubagentSupervisorOptions & {
  readonly parentSessionId: string;
  readonly task: string;
  readonly name?: string;
  readonly nickname?: string;
  readonly waitPolicy?: AgentSubagentWaitPolicy;
}): Promise<AgentSubagentRecord> {
  const parent = await options.ownershipStore.verify(options.parentSessionId, options.identity);
  if (parent !== "owned") throw new AgentSubagentError(parent === "missing" ? 404 : 403, "agent_session_not_found", "The parent Agent session is not available.");
  const task = options.task.trim();
  if (!task || task.length > 100_000) throw new AgentSubagentError(400, "agent_subagent_task_invalid", "The subagent task must contain between 1 and 100000 characters.");
  const runtime = options.runtime ?? eveAgentSubagentRuntime;
  if (!runtime.spawn) throw new AgentSubagentError(501, "agent_subagent_spawn_unsupported", "The active Agent runtime does not expose external subagent spawning; ask the parent Agent to delegate the task.");
  const active = (await options.store.listOwned(options.identity, options.parentSessionId)).filter((item) => item.status === "starting" || item.status === "running" || item.status === "waiting");
  if (active.length >= 16) throw new AgentSubagentError(429, "agent_subagent_limit_reached", "A session may have at most sixteen active subagents.");
  const child = await runtime.spawn({
    accessToken: options.accessToken,
    owner: options.identity,
    parentSessionId: options.parentSessionId,
    task,
    ...(options.name ? { name: options.name } : {}),
    waitPolicy: options.waitPolicy ?? "wait",
  });
  return await options.store.create({
    childSessionId: child.childSessionId,
    ...(child.agentId ? { agentId: child.agentId } : {}),
    parentSessionId: options.parentSessionId,
    owner: options.identity,
    ...(options.name || child.name ? { name: options.name ?? child.name } : {}),
    ...(options.nickname ? { nickname: options.nickname } : {}),
    task,
    status: "starting",
    waitPolicy: options.waitPolicy ?? "wait",
    depth: 1,
  });
}

export async function sendAgentSubagentMessage(options: AgentSubagentSupervisorOptions & {
  readonly childSessionId: string;
  readonly message: string;
  readonly resume?: boolean;
  readonly operationId?: string;
}): Promise<AgentSubagentRecord | undefined> {
  const child = await ownedChild(options);
  if (!child) return undefined;
  if (child.status === "closed" || child.status === "completed" || child.status === "interrupted" && !options.resume) {
    throw new AgentSubagentError(409, "agent_subagent_not_resumable", "This subagent is not accepting messages in its current state.");
  }
  if (!options.mailboxStore) throw new AgentSubagentError(503, "agent_mailbox_unavailable", "The Agent mailbox is not configured.");
  const message = options.message.trim();
  if (!message || message.length > 100_000) throw new AgentSubagentError(400, "agent_subagent_message_invalid", "The subagent message is invalid.");
  let operationKind: "send" | "steer" = "send";
  let expectedTurnId: string | undefined;
  if (!options.resume && child.status === "running") {
    const inspected = await (options.runtime ?? eveAgentSubagentRuntime).inspect({
      owner: options.identity,
      sessionId: child.childSessionId,
    });
    if (inspected.status !== "running" || !inspected.activeTurnId) {
      throw new AgentSubagentError(409, "agent_subagent_busy", "The subagent is still starting its active turn. Try again when it reaches a turn boundary.");
    }
    operationKind = "steer";
    expectedTurnId = inspected.activeTurnId;
  }
  const operationId = options.operationId?.trim() || `subagent-${randomUUID()}`;
  const clientMessageId = `subagent-${randomUUID()}`;
  const result = await enqueueAgentMailboxMessage({
    clientMessageId,
    ...(expectedTurnId ? { expectedTurnId } : {}),
    message,
    operationId,
    operationKind,
    owner: options.identity,
    sessionId: child.childSessionId,
    store: options.mailboxStore,
  });
  if (!("item" in result)) throw new AgentSubagentError(result.status === "full" ? 429 : 409, "agent_subagent_message_rejected", "The subagent did not accept the message.");
  return await options.store.updateOwned(options.identity, child.childSessionId, { status: "running" });
}

export async function waitForAgentSubagent(options: AgentSubagentSupervisorOptions & {
  readonly childSessionId: string;
  readonly timeoutMs?: number;
}): Promise<AgentSubagentRecord | undefined> {
  const child = await ownedChild(options);
  if (!child) return undefined;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 0), 300_000);
  const deadline = Date.now() + timeoutMs;
  const runtime = options.runtime ?? eveAgentSubagentRuntime;
  let current = child;
  while (Date.now() <= deadline) {
    const inspected = await runtime.inspect({ owner: options.identity, sessionId: child.childSessionId });
    const status = mapRuntimeStatus(inspected.status);
    current = await options.store.updateOwned(options.identity, child.childSessionId, { status }) ?? current;
    if (status === "waiting" || status === "completed" || status === "failed" || status === "interrupted" || status === "closed") return current;
    if (timeoutMs === 0) break;
    await delay(Math.min(500, Math.max(20, deadline - Date.now())));
  }
  return current;
}

export async function interruptAgentSubagent(options: AgentSubagentSupervisorOptions & { readonly childSessionId: string }): Promise<AgentSubagentRecord | undefined> {
  const child = await ownedChild(options);
  if (!child) return undefined;
  const result = await (options.runtime ?? eveAgentSubagentRuntime).cancel({ accessToken: options.accessToken, sessionId: child.childSessionId });
  return await options.store.updateOwned(options.identity, child.childSessionId, { status: result === "accepted" ? "interrupted" : child.status });
}

export async function closeAgentSubagent(options: AgentSubagentSupervisorOptions & { readonly childSessionId: string }): Promise<AgentSubagentRecord | undefined> {
  const child = await ownedChild(options);
  if (!child) return undefined;
  if (child.status === "running" || child.status === "starting") {
    await (options.runtime ?? eveAgentSubagentRuntime).cancel({ accessToken: options.accessToken, sessionId: child.childSessionId });
  }
  return await options.store.updateOwned(options.identity, child.childSessionId, { status: "closed" });
}

async function ownedChild(options: AgentSubagentSupervisorOptions & { readonly childSessionId: string }): Promise<AgentSubagentRecord | undefined> {
  const child = await options.store.findOwned(options.identity, options.childSessionId);
  if (!child) return undefined;
  const parent = await options.ownershipStore.verify(child.parentSessionId, options.identity);
  return parent === "owned" ? child : undefined;
}

function snapshot(parentSessionId: string, children: readonly AgentSubagentRecord[]): AgentSubagentSnapshot {
  return {
    parentSessionId,
    children,
    activeCount: children.filter((child) => child.status === "starting" || child.status === "running" || child.status === "waiting").length,
    revision: children.reduce((max, child) => Math.max(max, Date.parse(child.updatedAt) || 0), 0),
  };
}

function mapRuntimeStatus(status: "running" | "waiting" | "completed" | "failed" | "cancelled"): AgentSubagentStatus {
  return status === "cancelled" ? "interrupted" : status;
}
function eventData(event: { readonly data?: unknown }): Record<string, unknown> | undefined {
  return isRecord(event.data) ? event.data : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
