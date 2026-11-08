import { conversationOf, type SessionStreamEvent } from "eve/client";
import { activeTurn, call, calls, children, contentPreviews, failure, openInteractions, parts, runs, session, turn, turns, waiting, type Interaction, type SessionView } from "eve/events";
import type { EveMessage, EveMessagePart, EveToolPart } from "eve/react";
import type { AgentInterruptedTurn, AgentPendingTurn, AgentSubagentSummary } from "./contracts.js";

export type AgentTurnStatus = "cancelled" | "completed" | "failed" | "running" | "waiting";

export type SubagentCallPresentation = {
  readonly childSessionId?: string;
  readonly endedAt?: number;
  readonly name?: string;
  readonly startedAt?: number;
  readonly status: "cancelled" | "completed" | "failed" | "running" | "starting" | "waiting";
};

export type SubagentSessionPresentation = SubagentCallPresentation & {
  readonly callId: string;
  readonly task?: string;
};

/** Merge durable server records over the optimistic parent event projection. */
export function mergeSubagentSessions(
  events: readonly SessionStreamEvent[],
  durable: readonly AgentSubagentSummary[] = [],
): readonly SubagentSessionPresentation[] {
  const projected = presentSubagentSessions(events);
  const bySession = new Map(durable.map((child) => [child.childSessionId, child]));
  const merged = projected.map((session) => {
    const durableSession = session.childSessionId ? bySession.get(session.childSessionId) : undefined;
    if (!durableSession) return session;
    return {
      ...session,
      ...(durableSession.callId ? { callId: durableSession.callId } : {}),
      ...(durableSession.name || durableSession.nickname ? { name: durableSession.nickname ?? durableSession.name } : {}),
      ...(durableSession.task ? { task: durableSession.task } : {}),
      status: durableStatus(durableSession.status),
    };
  });
  const known = new Set(projected.map((session) => session.childSessionId).filter(Boolean));
  for (const child of durable) {
    if (known.has(child.childSessionId)) continue;
    merged.push({
      callId: child.callId ?? child.childSessionId,
      childSessionId: child.childSessionId,
      ...(child.name || child.nickname ? { name: child.nickname ?? child.name } : {}),
      ...(child.task ? { task: child.task } : {}),
      status: durableStatus(child.status),
    });
  }
  return merged;
}

function durableStatus(status: AgentSubagentSummary["status"]): SubagentSessionPresentation["status"] {
  if (status === "interrupted" || status === "closed") return "cancelled";
  return status;
}

export type AgentTurnFailure = {
  readonly code: string;
  readonly message: string;
  /** Provider/runtime diagnostics preserved by Eve on failure events. */
  readonly retryable?: boolean;
  readonly statusCode?: number;
};

export type AgentFailureCategory = "network" | "provider" | "timeout" | "unknown";

/** Classify transport/provider failures for a stable user-facing status. */
export function classifyAgentFailure(failure: AgentTurnFailure): AgentFailureCategory {
  const code = failure.code.toLocaleLowerCase();
  const message = failure.message.toLocaleLowerCase();
  const value = `${code} ${message}`;
  if (/timeout|timed out|deadline|\b408\b|\b504\b/u.test(value)) return "timeout";
  // A provider stream ending is normally an upstream retry/failure. Only call
  // it a network error when the diagnostic actually names a transport fault;
  // this avoids turning every exhausted model retry into a vague network flash.
  if (/network|fetch|socket|connection reset|connection refused|econn|dns|chunked encoding/u.test(value)) return "network";
  if (/provider|model|rate.?limit|\b429\b|overload|upstream|quota|\b5(?:00|02|03)\b|stream.?interrupted|stream.?ended/u.test(value)) return "provider";
  return "unknown";
}

/** Decide retryability from Eve diagnostics before falling back to text. */
export function isRetryableAgentFailure(failure: AgentTurnFailure): boolean {
  if (failure.retryable !== undefined) return failure.retryable;
  if (failure.statusCode !== undefined && failure.statusCode >= 400 && failure.statusCode < 500) {
    // Provider 403/404s are recoverable in Open Agent even when Eve's durable
    // failure details omit its internal retryable flag. A missing route or
    // model selection must not turn a long-lived interactive session into a
    // terminal conversation; an explicit `retryable: false` above still wins
    // for genuinely terminal failures from older/runtime-specific events.
    return (failure.statusCode === 403 && failure.code === "MODEL_CALL_FAILED") ||
      failure.statusCode === 404 || failure.statusCode === 408 || failure.statusCode === 409 || failure.statusCode === 425 || failure.statusCode === 429;
  }
  const category = classifyAgentFailure(failure);
  if (category === "unknown") return false;
  const value = `${failure.code} ${failure.message}`.toLocaleLowerCase();
  return !/\b(?:400|401|403|404|422|unauthori[sz]ed|forbidden|rejected|invalid[_ -]?request)\b/u.test(value);
}


export type AgentTurnPresentation = {
  readonly endedAt?: number;
  readonly finalPart?: Extract<EveMessagePart, { type: "text" }>;
  readonly failureAnchored?: boolean;
  readonly showExecutionGroup: boolean;
  readonly proxiedInputParts: readonly EveToolPart[];
  readonly processParts: readonly EveMessagePart[];
  readonly startedAt?: number;
  readonly status: AgentTurnStatus;
  readonly waitingFor?: Interaction["request"]["kind"];
};
export type AgentStepPresentation = {
  readonly endedAt?: number;
  readonly failure?: AgentTurnFailure;
  readonly retry?: { readonly attempt?: number; readonly error?: AgentTurnFailure; readonly exhausted?: boolean; readonly maximum?: number };
  readonly retries?: readonly { readonly attempt: number; readonly error: AgentTurnFailure; readonly exhausted?: boolean; readonly maximum?: number }[];
  readonly startedAt?: number;
  readonly status: "completed" | "failed" | "running";
};

// Cache the official fold per immutable event snapshot. Presentation queries share it;
// the durable event log and Eve's own message projection are never rewritten.
const snapshots = new WeakMap<readonly SessionStreamEvent[], {
  readonly length: number;
  readonly last: SessionStreamEvent | undefined;
  readonly value: ReturnType<typeof conversationOf>;
}>();
export function presentationSnapshot(events: readonly SessionStreamEvent[]) {
  const cached = snapshots.get(events);
  // Check append-only buffers as well as immutable React snapshots. Keeping a
  // view cached solely by array identity left imperative admission queries stale.
  if (cached?.length === events.length && cached.last === events.at(-1)) return cached.value;
  const value = conversationOf(events);
  snapshots.set(events, { length: events.length, last: events.at(-1), value });
  return value;
}
export function eventTurnId(event: SessionStreamEvent): string | undefined {
  return event.scope?.turnId ?? ("turnId" in event.data ? event.data.turnId : undefined);
}
export function eventStepIndex(event: SessionStreamEvent, events: readonly SessionStreamEvent[]): number | undefined {
  const runId = event.scope?.runId ?? ("runId" in event.data ? event.data.runId : undefined);
  const turnId = eventTurnId(event);
  const allRuns = runs(presentationSnapshot(events).view, turnId ? { turnId } : undefined);
  return runId ? ((index) => index < 0 ? undefined : index)(allRuns.findIndex((candidate) => candidate.runId === runId)) : undefined;
}
export function eventTimestamp(event: SessionStreamEvent | undefined): number | undefined {
  return timestamp(event?.meta.at);
}
function timestamp(at: string | undefined): number | undefined {
  const value = at ? Date.parse(at) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

export function stableUserMessageId(sourceId: string, _turnId: string, _stableRoot: string): string {
  // v27 user identity belongs to its delivery, independent of turn edits and steering.
  return sourceId;
}
export function activeTurnIdAfterPendingSubmission(events: readonly SessionStreamEvent[], pending: Pick<AgentPendingTurn, "eventCountAtSubmission" | "submittedAt">): string | undefined {
  const current = activeTurn(presentationSnapshot(events).view);
  if (!current) return undefined;
  const index = events.findIndex((event) => event.type === "turn.started" && event.data.turnId === current.turnId);
  if (pending.eventCountAtSubmission !== undefined && events.length >= pending.eventCountAtSubmission) {
    return index >= pending.eventCountAtSubmission ? current.turnId : undefined;
  }
  return (timestamp(current.startedAt) ?? 0) >= pending.submittedAt - 1000 ? current.turnId : undefined;
}

export const INTERRUPTED_TOOL_ERROR = "Open Agent: tool call cancelled before completion.";
export const CANCELLING_TOOL_ERROR = "Open Agent: tool call cancellation is pending.";
export const INCOMPLETE_TOOL_ERROR = "Open Agent: tool call did not complete.";
export function isInterruptedToolPart(part: EveToolPart): boolean { return part.state === "cancelled"; }
export function isCancellationPendingToolPart(part: EveToolPart): boolean { return part.error?.code === "LOCAL_CANCELLATION_PENDING"; }

/** App-owned presentation state, never a fabricated Eve lifecycle fact. */
export type DisplayEveMessage = EveMessage & {
  readonly metadata?: EveMessage["metadata"] & {
    readonly localStatus?: "cancelled";
    readonly localStopStreamIndex?: number;
  };
};

export function isLocallyInterruptedMessage(message: EveMessage): boolean {
  return (message as DisplayEveMessage).metadata?.localStatus === "cancelled";
}

/** Every message-local query must observe the same frozen source prefix. */
export function eventsForMessagePresentation(message: EveMessage, events: readonly SessionStreamEvent[]): readonly SessionStreamEvent[] {
  const boundary = (message as DisplayEveMessage).metadata?.localStopStreamIndex;
  return boundary === undefined ? events : events.filter((event) => event.meta.position.line < boundary);
}

/**
 * Freeze only the interrupted turn's assistant rows at the observed complete
 * source-line boundary. Always fold the full log: receipts and cancellation
 * settlement may share a commit with output that arrived after Stop.
 */
export function projectInterruptedMessages(
  messages: readonly EveMessage[],
  events: readonly SessionStreamEvent[],
  interruptions: readonly AgentInterruptedTurn[],
): readonly DisplayEveMessage[] {
  if (!interruptions.length) return messages;
  const frozen = new Map<string, { streamIndex: number; messages: Map<string, EveMessage> }>();
  for (const interruption of interruptions) {
    if (frozen.has(interruption.turnId)) continue;
    const prefix = events.filter((event) => event.meta.position.line < interruption.streamIndex);
    const snapshot = conversationOf(prefix);
    frozen.set(interruption.turnId, { streamIndex: interruption.streamIndex, messages: new Map(snapshot.messages
      .filter((message) => message.role === "assistant" && message.metadata?.turnId === interruption.turnId)
      .map((message) => [message.id, message])) });
  }
  return messages.flatMap((message): DisplayEveMessage[] => {
    const turnId = message.metadata?.turnId;
    const stopped = message.role === "assistant" && turnId ? frozen.get(turnId) : undefined;
    if (!stopped) return [message];
    const observed = stopped.messages.get(message.id);
    // A receipt after Stop may introduce an assistant segment. Keep an empty
    // stopped anchor rather than showing any newly generated content.
    return [{
      ...message,
      parts: (observed?.parts ?? []).map((part) => {
        if (part.type === "text" || part.type === "reasoning") return { ...part, state: "done" };
        if (part.type === "interaction" && part.status === "open") return { ...part, status: "settled", outcome: "interrupted" };
        if (part.type === "tool" && !["completed", "failed", "rejected", "cancelled"].includes(part.state)) {
          return { ...part, inputText: undefined, state: "cancelled",
            ...(part.interaction ? { interaction: { ...part.interaction, status: "settled", outcome: "interrupted" } } : {}),
            error: { code: "LOCAL_CANCELLATION_PENDING", message: CANCELLING_TOOL_ERROR } };
        }
        return part;
      }),
      metadata: { ...message.metadata, status: "complete", localStatus: "cancelled", localStopStreamIndex: stopped.streamIndex },
    }];
  });
}

export function presentAgentStep(events: readonly SessionStreamEvent[], turnId: string | undefined, stepIndex: number): AgentStepPresentation {
  if (!turnId) return { status: "running" };
  const view = presentationSnapshot(events).view;
  const run = runs(view, { turnId })[stepIndex];
  const latest = runs(view, { turnId }).at(-1);
  const terminalFailure = latest?.runId === run?.runId ? failure(view, turnId) : undefined;
  const runFailure = run?.outcome === "failed" ? run.error : undefined;
  const error = terminalFailure ?? runFailure;
  const retries = events.flatMap((event) => event.type === "model.retried" && event.data.runId === run?.runId
    ? [{ attempt: event.data.attempt + 1, error: event.data.error, ...(error ? { exhausted: true } : {}) }]
    : []);
  return {
    ...(timestamp(run?.startedAt) !== undefined ? { startedAt: timestamp(run?.startedAt) } : {}),
    ...(timestamp(run?.endedAt) !== undefined ? { endedAt: timestamp(run?.endedAt) } : {}),
    ...(error ? { failure: error } : {}),
    ...(retries.length ? { retries, retry: retries.at(-1) } : {}),
    status: error ? "failed" : run?.status === "settled" ? "completed" : "running",
  };
}
export function reasoningContentForStep(events: readonly SessionStreamEvent[], turnId: string | undefined, stepIndex: number | undefined): string {
  if (!turnId) return "";
  const view = presentationSnapshot(events).view;
  const selected = runs(view, { turnId }).filter((_run, index) => stepIndex === undefined || index === stepIndex);
  const ids = new Set(selected.map((run) => run.runId));
  return [...parts(view, { turnId, kind: "reasoning" }).flatMap((part) => ids.has(part.runId) && typeof part.value === "string" ? [part.value] : []),
    ...contentPreviews(view).flatMap((part) => part.kind === "reasoning" && part.runId && ids.has(part.runId) ? [part.text] : [])].join("\n").trim();
}

export function presentAgentTurn(message: EveMessage, events: readonly SessionStreamEvent[], closedIds: ReadonlySet<string> = new Set()): AgentTurnPresentation | undefined {
  const turnId = message.metadata?.turnId;
  if (message.role !== "assistant" || !turnId) return undefined;
  const view = presentationSnapshot(events).view;
  const owner = turn(view, turnId);
  const segment = eventsForAssistantSegment(message, events);
  const interactionIds = new Set(message.parts.flatMap((part) => part.type === "interaction"
    ? [part.interactionId] : part.type === "tool" && part.interaction ? [part.interaction.interactionId] : []));
  const pending = unresolvedInputRequests(events, closedIds).filter((item) => interactionIds.has(item.interactionId));
  const hasExecution = isLocallyInterruptedMessage(message) || message.parts.some((part) => part.type !== "text") || runs(view, { turnId }).length > 0 || pending.length > 0;
  if (!hasExecution) return undefined;
  const showExecutionGroup = pending.length > 0 || message.parts.some((part) =>
    part.type === "interaction" || part.type === "tool" && part.kind !== "control",
  );
  const replyIds = new Set(parts(view, { turnId }).filter((part) => part.kind === "text" && part.phase === "reply").map((part) => part.partId));
  const finalPart = message.parts.findLast((part): part is Extract<EveMessagePart, { type: "text" }> => part.type === "text" && part.id !== undefined && replyIds.has(part.id));
  let ended = timestamp(owner?.endedAt);
  let status: AgentTurnStatus;
  if (isLocallyInterruptedMessage(message)) status = "cancelled";
  else if (segment.settledAt !== undefined) {
    // Background tasks can outlive a steering boundary. Their own call and
    // approval stay live in the original row, independently of the new work.
    const ownCalls = message.parts.flatMap((part) => part.type === "tool" ? [call(view, part.callId)] : []).filter((item) => item !== undefined);
    status = pending.length ? "waiting" : ownCalls.some((item) =>
      item.state === "requested" || item.state === "approval" || item.state === "running" || item.state === "blocked",
    ) ? "running" : "completed";
    ended = status === "completed" ? Math.max(segment.settledAt, ...ownCalls.flatMap((item) => {
      const at = timestamp(item.endedAt);
      return at === undefined ? [] : [at];
    })) : undefined;
  } else status = owner?.outcome ?? (pending.length ? "waiting" : ended !== undefined ? "completed" : "running");
  return {
    endedAt: ended,
    finalPart,
    processParts: message.parts.filter((part) => part !== finalPart),
    proxiedInputParts: [],
    showExecutionGroup,
    startedAt: eventTimestamp(segment.events.find((event) => event.type === "model.started" || event.type === "call.requested")) ?? timestamp(owner?.startedAt),
    status,
    ...(pending[0] ? { waitingFor: pending[0].request.kind } : {}),
  };
}

export function syntheticMessageReceiptClientMessageId(event: Extract<SessionStreamEvent, { type: "delivery.consumed" }>, _ordinal: number): string { return event.data.deliveryId; }

export function unresolvedInputRequests(events: readonly SessionStreamEvent[], closedIds: ReadonlySet<string> = new Set()): readonly Interaction[] {
  return openInteractions(presentationSnapshot(events).view).filter((item) => !closedIds.has(item.interactionId));
}
export function hasUnresolvedInputRequests(events: readonly SessionStreamEvent[], closedIds: ReadonlySet<string> = new Set()): boolean { return unresolvedInputRequests(events, closedIds).length > 0; }
export function hasSettledLatestTurn(events: readonly SessionStreamEvent[]): boolean {
  const view = presentationSnapshot(events).view;
  const state = session(view);
  return state.status === "ended" || turns(view).at(-1)?.status === "settled";
}
export function hasTerminalSessionBoundary(events: readonly SessionStreamEvent[]): boolean { return session(presentationSnapshot(events).view).status === "ended"; }
export function failureForTurn(events: readonly SessionStreamEvent[], turnId: string | undefined): AgentTurnFailure | undefined { return turnId ? failure(presentationSnapshot(events).view, turnId) : undefined; }
export function eventsBeforeLastUserTurn(events: readonly SessionStreamEvent[]): readonly SessionStreamEvent[] {
  const receipt = events.findLast((event) => event.type === "delivery.consumed" && event.data.parts.length > 0);
  if (receipt?.type !== "delivery.consumed") return [];
  const index = events.findIndex((event) => event.type === "turn.started" && event.data.turnId === receipt.data.turnId);
  return events.slice(0, index < 0 ? events.indexOf(receipt) : index);
}
export function presentSubagentCall(events: readonly SessionStreamEvent[], callId: string): SubagentCallPresentation {
  const view = presentationSnapshot(events).view;
  const child = children(view).find((entry) => entry.callId === callId);
  const entry = call(view, callId);
  const state = entry?.state;
  return {
    ...(child ? { childSessionId: child.sessionId, name: child.name } : {}),
    startedAt: timestamp(entry?.startedAt), endedAt: timestamp(entry?.endedAt),
    status: !entry ? "starting" : state === "completed" ? "completed" : state === "failed" || state === "rejected" ? "failed" : state === "cancelled" ? "cancelled" : state === "approval" || state === "blocked" ? "waiting" : "running",
  };
}
export function presentSubagentSessions(events: readonly SessionStreamEvent[]): readonly SubagentSessionPresentation[] {
  return events.flatMap((event) => event.type === "call.requested" && event.data.capability.kind === "agent"
    ? [{ ...presentSubagentCall(events, event.data.callId), callId: event.data.callId, task: subagentTask(event.data.input) }]
    : []);
}
export function eventsForAssistantSegment(message: EveMessage, events: readonly SessionStreamEvent[]): { readonly events: readonly SessionStreamEvent[]; readonly settledAt?: number } {
  const turnId = message.metadata?.turnId;
  if (!turnId) return { events: [] };
  // Read boundaries from Eve's ordered rows. Before any assistant content is
  // committed, several deliveries can precede the root assistant row; its id
  // alone does not identify which receipt immediately precedes it. The app
  // may also retain an optimistic id for that root during admission.
  const messages = presentationSnapshot(events).messages;
  let index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) index = messages.findIndex((item) => item.id === `${turnId}:assistant`);
  const previousUser = messages.slice(0, index < 0 ? 0 : index).findLast((item) => item.role === "user" && item.metadata?.turnId === turnId);
  const nextUser = index < 0 ? undefined : messages.slice(index + 1).find((item) => item.role === "user" && item.metadata?.turnId === turnId);
  const receiptIndex = (user: EveMessage | undefined) => user ? events.findIndex((event) =>
    event.type === "delivery.consumed" && `${event.data.deliveryId}:user` === user.id,
  ) : -1;
  const receipt = receiptIndex(previousUser);
  const start = receipt >= 0 ? receipt : events.findIndex((event) => event.type === "turn.started" && event.data.turnId === turnId);
  const next = receiptIndex(nextUser);
  return { events: events.slice(Math.max(0, start), next < 0 ? undefined : next).filter((event) => eventTurnId(event) === turnId), ...(next >= 0 ? { settledAt: eventTimestamp(events[next]) } : {}) };
}

/** Add only the current empty model step; Eve already owns real reasoning parts. */
export function withThinkingPlaceholder(message: EveMessage, events: readonly SessionStreamEvent[]): readonly EveMessagePart[] {
  const turnId = message.metadata?.turnId;
  if (!turnId || message.metadata?.status !== "streaming" || isLocallyInterruptedMessage(message)) return message.parts;
  const view = presentationSnapshot(events).view;
  const steps = runs(view, { turnId });
  const stepIndex = steps.length - 1;
  const run = steps[stepIndex];
  if (!run || run.status === "settled" || message.parts.some((part) => part.type === "reasoning" && part.stepIndex === stepIndex)) return message.parts;
  if (calls(view, { turnId }).some((item) => item.runId === run.runId && item.kind !== "control") ||
      parts(view, { turnId, kind: "text" }).some((part) => part.runId === run.runId && typeof part.value === "string" && part.value.trim()) ||
      contentPreviews(view).some((part) => part.runId === run.runId && part.kind === "text" && part.text.trim())) return message.parts;
  return [...message.parts, { type: "reasoning", state: "streaming", stepIndex, text: "" }];
}
function subagentTask(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const key of ["task", "prompt", "message"]) { const value = Reflect.get(input, key); if (typeof value === "string") return value; }
  return undefined;
}
