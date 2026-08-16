import type {
  AgentSessionOperation,
  AgentSessionOperationState,
} from "@oworker/open-agent-contracts/agent-session";

/**
 * Server-side operation transitions are intentionally strict.  Browser state
 * is a projection; only these transitions may move a durable operation
 * forward, which prevents a late provider/mailbox event from reopening it.
 */
const transitions: Readonly<Record<AgentSessionOperationState, readonly AgentSessionOperationState[]>> = {
  accepted: ["committed", "failed", "ambiguous", "cancelled"],
  ambiguous: ["committed", "failed", "cancelled"],
  cancelled: [],
  committed: [],
  delivering: ["accepted", "failed", "ambiguous", "cancelled"],
  failed: ["queued", "cancelled"],
  queued: ["delivering", "cancelled"],
};

export function canTransitionAgentSessionOperation(
  from: AgentSessionOperationState,
  to: AgentSessionOperationState,
): boolean {
  return from === to || transitions[from].includes(to);
}

export function transitionAgentSessionOperation(
  operation: AgentSessionOperation,
  next: AgentSessionOperationState,
  patch: Readonly<Partial<Pick<AgentSessionOperation, "lastError" | "updatedAt">>> = {},
): AgentSessionOperation {
  if (!canTransitionAgentSessionOperation(operation.state, next)) {
    throw new Error(`Agent session operation cannot transition from ${operation.state} to ${next}.`);
  }
  return {
    ...operation,
    ...patch,
    state: next,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  };
}

export function operationIdentityMatches(
  operation: Pick<AgentSessionOperation, "operationId" | "sessionId" | "clientMessageId">,
  candidate: Pick<AgentSessionOperation, "operationId" | "sessionId" | "clientMessageId">,
): boolean {
  return operation.operationId === candidate.operationId &&
    operation.sessionId === candidate.sessionId &&
    operation.clientMessageId === candidate.clientMessageId;
}
