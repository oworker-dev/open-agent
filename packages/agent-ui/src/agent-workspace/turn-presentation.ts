import type { MessageStreamEvent, InputRequest } from "eve/client";
import type { EveDynamicToolPart, EveMessage, EveMessagePart } from "eve/react";
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
  events: readonly MessageStreamEvent[],
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

export type AgentTurnPresentation = {
  readonly endedAt?: number;
  readonly finalPart?: Extract<EveMessagePart, { type: "text" }>;
  /** A terminal step failure is rendered by the step's own activity row. */
  readonly failureAnchored?: boolean;
  readonly proxiedInputParts: readonly EveDynamicToolPart[];
  readonly processParts: readonly EveMessagePart[];
  readonly startedAt?: number;
  readonly status: AgentTurnStatus;
  readonly waitingFor?: InputRequest["kind"];
};

export type AgentTurnPresentationOptions = {
  /**
   * Use the complete root-turn event range for the visual execution group.
   * Eve steering messages intentionally share a turn id, so their assistant
   * segments must share one timer and terminal status in the UI.
   */
  readonly mergeSameTurn?: boolean;
};

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
    // Provider 404s are recoverable in Open Agent even when Eve's durable
    // failure details omit its internal retryable flag. A missing route or
    // model selection must not turn a long-lived interactive session into a
    // terminal conversation; an explicit `retryable: false` above still wins
    // for genuinely terminal failures from older/runtime-specific events.
    return failure.statusCode === 404 || failure.statusCode === 408 || failure.statusCode === 409 || failure.statusCode === 425 || failure.statusCode === 429;
  }
  const category = classifyAgentFailure(failure);
  if (category === "unknown") return false;
  const value = `${failure.code} ${failure.message}`.toLocaleLowerCase();
  return !/\b(?:400|401|403|404|422|unauthori[sz]ed|forbidden|rejected|invalid[_ -]?request)\b/u.test(value);
}

function failureFromData(data: {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly message: string;
}): AgentTurnFailure {
  const statusCode = typeof data.details?.statusCode === "number" && Number.isInteger(data.details.statusCode)
    ? data.details.statusCode
    : typeof data.details?.status === "number" && Number.isInteger(data.details.status)
      ? data.details.status
      : undefined;
  const retryable = typeof data.details?.isRetryable === "boolean"
    ? data.details.isRetryable
    : typeof data.details?.retryable === "boolean"
      ? data.details.retryable
      : undefined;
  return {
    code: data.code,
    message: data.message,
    ...(retryable === undefined ? {} : { retryable }),
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

export type AgentStepPresentation = {
  readonly endedAt?: number;
  readonly failure?: AgentTurnFailure;
  readonly retry?: {
    /** Number of failed attempts observed in the durable stream. */
    readonly attempt?: number;
    readonly error?: AgentTurnFailure;
    /** The retry budget was exhausted at this terminal step. */
    readonly exhausted?: boolean;
    readonly maximum?: number;
  };
  /** Every observed transient failure in this step, in event order. */
  readonly retries?: readonly {
    readonly attempt: number;
    readonly error: AgentTurnFailure;
    readonly exhausted?: boolean;
    readonly maximum: number;
  }[];
  readonly startedAt?: number;
  readonly status: "completed" | "failed" | "running";
};

export type AgentDisplayProjection = {
  readonly events: readonly MessageStreamEvent[];
  readonly messages: readonly EveMessage[];
};

/**
 * Replace only the durable turn prefix while preserving the per-message
 * suffix Eve uses for steering/follow-up receipts.
 */
export function stableUserMessageId(sourceId: string, turnId: string, stableRoot: string): string {
  const prefix = `${turnId}:user`;
  if (sourceId === prefix) return `${stableRoot}:user`;
  if (sourceId.startsWith(`${prefix}:`)) {
    return `${stableRoot}:user:${sourceId.slice(prefix.length + 1)}`;
  }
  return sourceId;
}

/**
 * Return the active turn only when it belongs to the pending admission.
 *
 * Eve can publish a throttled snapshot containing the previous turn's
 * `turn.started` before its terminal event reaches the browser. Treating that
 * snapshot as the new turn causes the previous assistant message to be
 * rebound to the optimistic root and briefly displays stale reasoning.
 */
export function activeTurnIdAfterPendingSubmission(
  events: readonly MessageStreamEvent[],
  pendingTurn: Pick<AgentPendingTurn, "eventCountAtSubmission" | "submittedAt">,
): string | undefined {
  const startedIndex = events.findLastIndex((event) => event.type === "turn.started");
  if (startedIndex < 0) return undefined;
  const started = events[startedIndex];
  if (started?.type !== "turn.started") return undefined;
  const turnId = started.data.turnId;
  const settled = events.some((event) =>
    (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") &&
    event.data.turnId === turnId,
  );
  if (settled) return undefined;

  const submissionIndex = pendingTurn.eventCountAtSubmission;
  // The pending count is measured against the append-only event buffer. A
  // started event before it is historical even when its terminal event is
  // missing from this throttled snapshot.
  if (submissionIndex !== undefined && events.length >= submissionIndex) {
    return startedIndex >= submissionIndex ? turnId : undefined;
  }

  // Display projections may be shorter than the append-only buffer. In that
  // case use Eve's timestamp; without either signal, do not alias history.
  const eventAt = started.meta.at ? Date.parse(started.meta.at) : Number.NaN;
  return Number.isFinite(eventAt) && eventAt >= pendingTurn.submittedAt - 1_000
    ? turnId
    : undefined;
}

/** Marker used only in the UI projection for a tool that was interrupted
 * before Eve produced an action.result. It is never written into Eve's stream.
 */
export const INTERRUPTED_TOOL_ERROR = "Open Agent: tool call cancelled before completion.";
export const CANCELLING_TOOL_ERROR = "Open Agent: tool call cancellation is pending.";
export const INCOMPLETE_TOOL_ERROR = "Open Agent: tool call did not complete.";

export function isInterruptedToolPart(part: EveDynamicToolPart): boolean {
  return part.state === "output-error" && part.errorText === INTERRUPTED_TOOL_ERROR;
}

export function isCancellationPendingToolPart(part: EveDynamicToolPart): boolean {
  return part.state === "output-error" && part.errorText === CANCELLING_TOOL_ERROR;
}

function isLocalInterruptedBoundary(event: MessageStreamEvent): boolean {
  return event.type === "turn.cancelled" && event.meta?.id?.startsWith("local-interrupt-") === true;
}

/**
 * Remove failed tool-input snapshots from the user-visible event projection
 * once a turn has reached a terminal boundary. Eve's own stream remains
 * append-only; this projection is the compact transcript used by the UI and
 * must not make an incomplete provider call look like a successful action.
 */
export function sanitizeSettledThreadEvents(
  events: readonly MessageStreamEvent[],
): readonly MessageStreamEvent[] {
  // A durable turn must have an inbound message anchor. When a browser or
  // event-log checkpoint is interrupted between admission and
  // `message.received`, Eve can still leave later tool/output events behind.
  // Those events are execution residue, not a second user request. Keep HITL
  // continuations (which intentionally have no new message) anchored by the
  // preceding input request, and discard every other orphan turn.
  const anchoredTurns = new Set(
    events.flatMap((event) => event.type === "message.received" ? [event.data.turnId] : []),
  );
  const startedTurns = new Set(
    events.flatMap((event) => event.type === "turn.started" ? [event.data.turnId] : []),
  );
  const continuationTurns = continuationTurnIds(events, anchoredTurns);
  const orphanTurns = new Set<string>();
  // A stream fragment without any message anchor at all is common in unit
  // fixtures and can also be the first bytes observed during live admission.
  // Only classify residue once the same transcript contains at least one
  // authoritative user turn.
  if (anchoredTurns.size > 0) {
    for (const event of events) {
      const turnId = eventTurnId(event);
      // A transport checkpoint can lose `message.received` while retaining
      // the real turn boundary and all of its tool/result events. Such a turn
      // is valid history, not a duplicate admission. Only remove a turn that
      // lacks both authoritative user admission and Eve's turn boundary.
      if (turnId && !anchoredTurns.has(turnId) && !startedTurns.has(turnId) && !continuationTurns.has(turnId)) {
        orphanTurns.add(turnId);
      }
    }
  }
  const terminalTurns = new Set<string>();
  const cancelledTurns = new Set<string>();
  const completedCalls = new Set<string>();
  const lastPartialIndex = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
      terminalTurns.add(event.data.turnId);
      if (event.type === "turn.cancelled") cancelledTurns.add(event.data.turnId);
    }
    if (event.type === "action.input.partial") {
      lastPartialIndex.set(`${event.data.turnId}:${event.data.callId}`, index);
    }
    if (event.type === "action.result" && event.data.status === "completed" && event.data.result.kind === "tool-result") {
      completedCalls.add(`${event.data.turnId}:${event.data.result.callId}`);
    }
  }

  const filtered = events.filter((event, index) => {
    const turnId = eventTurnId(event);
    if (turnId && orphanTurns.has(turnId)) return false;
    if (event.type !== "action.input.partial" || !terminalTurns.has(event.data.turnId) || cancelledTurns.has(event.data.turnId)) return true;
    // A settled action has an authoritative `actions.requested` snapshot and
    // `action.result`; retaining every cumulative input snapshot is the main
    // source of multi-megabyte transcripts. Cancellation is the one case
    // where the last partial remains useful as an audit marker.
    const key = `${event.data.turnId}:${event.data.callId}`;
    return completedCalls.has(key) && lastPartialIndex.get(key) === index;
  });

  // Also discard a step marker when its only event was the abandoned tool
  // argument stream. Keeping it would render a phantom "Thinking" row.
  const stepEvidence = new Set<string>();
  for (const event of filtered) {
    const turnId = eventTurnId(event);
    const stepIndex = eventStepIndex(event);
    if (!turnId || stepIndex === undefined) continue;
    if (
      event.type !== "step.started" &&
      event.type !== "turn.completed" &&
      event.type !== "turn.failed" &&
      event.type !== "turn.cancelled"
    ) stepEvidence.add(`${turnId}:${stepIndex}`);
  }
  const normalized = filtered.filter((event) => {
    if (event.type !== "step.started" || !terminalTurns.has(event.data.turnId)) return true;
    return stepEvidence.has(`${event.data.turnId}:${event.data.stepIndex}`);
  });
  const compacted: MessageStreamEvent[] = [];
  for (const event of normalized) {
    // Keep one cumulative incremental event as the visual anchor for each
    // message/reasoning run. A completion boundary is intentionally retained
    // as a separate event because Eve may emit it after tool results.
    if (event.type === "message.appended" || event.type === "reasoning.appended") {
      const last = compacted.at(-1);
      if (
        last?.type === event.type &&
        last.data.turnId === event.data.turnId &&
        last.data.stepIndex === event.data.stepIndex
      ) {
        compacted[compacted.length - 1] = event;
        continue;
      }
    }
    if (event.type === "session.waiting" && compacted.at(-1)?.type === "session.waiting") {
      compacted[compacted.length - 1] = event;
      continue;
    }
    compacted.push(event);
  }
  return compacted;
}

function continuationTurnIds(
  events: readonly MessageStreamEvent[],
  anchoredTurns: ReadonlySet<string>,
): ReadonlySet<string> {
  const continuation = new Set<string>();
  let inputContinuationPending = false;
  for (const event of events) {
    if (event.type === "input.requested" || event.type === "authorization.required") {
      inputContinuationPending = true;
      continue;
    }
    if (event.type === "message.received") {
      inputContinuationPending = false;
      continue;
    }
    if (event.type === "turn.started") {
      if (inputContinuationPending && !anchoredTurns.has(event.data.turnId)) {
        continuation.add(event.data.turnId);
      }
      inputContinuationPending = false;
    }
  }
  return continuation;
}

/**
 * Repair the browser projection after a reconnect without inventing success.
 *
 * Eve's reducer can retain a tool-input snapshot when the browser persisted the
 * snapshot before the transport failed. A terminal turn is authoritative, but
 * it does not make that tool call successful: only an `action.result` event
 * does. Keep the durable event log append-only. Provider failures retain the
 * last tool input as an explicit failed boundary, while user cancellation
 * preserves the last snapshot as an interrupted tool boundary.
 */
export function normalizeSettledAgentMessages(
  messages: readonly EveMessage[],
  events: readonly MessageStreamEvent[],
): readonly EveMessage[] {
  const terminalTurns = new Map<string, "completed" | "failed" | "cancelled" | "cancelling">();
  for (const event of events) {
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
      terminalTurns.set(
        event.data.turnId,
        event.type === "turn.completed"
          ? "completed"
          : event.type === "turn.failed"
            ? "failed"
            : isLocalInterruptedBoundary(event) ? "cancelling" : "cancelled",
      );
    }
  }

  return messages.map((message) => {
    if (message.role !== "assistant" || !message.metadata?.turnId) return message;
    const messageTurnId = message.metadata.turnId;
    const terminal = terminalTurns.get(messageTurnId);
    if (!terminal) return message;
    // Eve can accept a steering/follow-up message inside the same durable
    // turn. The default reducer then creates one assistant message per
    // `message.received` segment, while the terminal boundary remains shared
    // by the whole turn. Scope action results and partial tool inputs to the
    // segment that produced the message; using the entire turn here causes a
    // successful tool in one segment to be attached to every other segment
    // and falsely synthesized as `tool call did not complete`.
    const segmentEvents = eventsForAssistantSegment(message, events).events;
    const segmentCompletedResults = new Map<string, { readonly output: unknown; readonly toolName: string }>();
    const segmentPartialToolInputs = new Map<string, Extract<MessageStreamEvent, { type: "action.input.partial" }>>();
    for (const event of segmentEvents) {
      if (event.type === "action.result" && event.data.status === "completed" && event.data.result.kind === "tool-result") {
        segmentCompletedResults.set(event.data.result.callId, {
          output: event.data.result.output,
          toolName: event.data.result.toolName,
        });
      }
      if (event.type === "action.input.partial") {
        segmentPartialToolInputs.set(event.data.callId, event);
      }
    }
    let changed = false;
    const parts = message.parts.flatMap((part): EveMessagePart[] => {
      if (part.type !== "dynamic-tool" || !isOpenToolPart(part)) return [part];
      const completed = segmentCompletedResults.get(part.toolCallId);
      changed = true;
      if (!completed) {
        // A user cancellation is a visible lifecycle outcome, not a failed
        // provider fragment. Keep the last input snapshot so the tool card and
        // file diff remain auditable, but use a terminal error state so it can
        // never be mistaken for a successful action.
        if (terminal === "cancelled" || terminal === "cancelling") {
          const toolMetadata = part.toolMetadata?.eve
            ? {
                ...part.toolMetadata,
                eve: {
                  kind: part.toolMetadata.eve.kind,
                  name: part.toolMetadata.eve.name,
                },
              }
            : part.toolMetadata;
          return [{
            errorText: terminal === "cancelled" ? INTERRUPTED_TOOL_ERROR : CANCELLING_TOOL_ERROR,
            input: part.input,
            ...(part.inputText !== undefined ? { inputText: part.inputText } : {}),
            ...(part.stepIndex !== undefined ? { stepIndex: part.stepIndex } : {}),
            state: "output-error",
            toolCallId: part.toolCallId,
            ...(toolMetadata ? { toolMetadata } : {}),
            toolName: part.toolName,
            type: "dynamic-tool",
          } satisfies EveDynamicToolPart];
        }
        // Provider failures and completed turns without a result are still
        // visible attempts. Keep them as terminal error cards so the user can
        // see what failed instead of seeing a mysteriously missing tool.
        return [{
          errorText: incompleteToolError(segmentEvents, messageTurnId, part),
          input: part.input,
          ...(part.inputText !== undefined ? { inputText: part.inputText } : {}),
          ...(part.stepIndex !== undefined ? { stepIndex: part.stepIndex } : {}),
          state: "output-error",
          toolCallId: part.toolCallId,
          ...(part.toolMetadata ? { toolMetadata: part.toolMetadata } : {}),
          toolName: part.toolName,
          type: "dynamic-tool",
        } satisfies EveDynamicToolPart];
      }
      return [{
        input: part.input,
        ...(part.inputText !== undefined ? { inputText: part.inputText } : {}),
        ...(part.stepIndex !== undefined ? { stepIndex: part.stepIndex } : {}),
        output: completed.output,
        state: "output-available",
        toolCallId: part.toolCallId,
        ...(part.toolMetadata ? { toolMetadata: part.toolMetadata } : {}),
        toolName: completed.toolName || part.toolName,
        type: "dynamic-tool",
      } satisfies EveDynamicToolPart];
    });

    // The default reducer leaves a step-start marker even when its only child
    // was the orphaned tool input removed above. Remove those empty markers so
    // a settled turn cannot render a phantom "正在思考" activity.
    const cleanedParts: EveMessagePart[] = [];
    const markerIndexByStep = new Map<number, number>();
    const partialsForMessage = [...segmentPartialToolInputs.values()];
    let markerStepIndex = 0;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      if (part.type !== "step-start") {
        // A terminal Eve boundary closes any text delta that was left in a
        // streaming state when the provider connection failed. Do not let a
        // settled turn keep the composer or reasoning UI looking live.
        if ((part.type === "text" || part.type === "reasoning") && part.state === "streaming") {
          changed = true;
          cleanedParts.push({ ...part, state: "done" });
        } else {
          cleanedParts.push(part);
        }
        continue;
      }
      const nextStep = parts.findIndex((candidate, candidateIndex) =>
        candidateIndex > index && candidate.type === "step-start",
      );
      const end = nextStep < 0 ? parts.length : nextStep;
      const hasContent = parts.slice(index + 1, end).some((candidate) => candidate.type !== "step-start");
      const hasPartialInput = partialsForMessage.some((partial) => partial.data.stepIndex === markerStepIndex);
      if (hasContent || hasPartialInput) {
        markerIndexByStep.set(markerStepIndex, cleanedParts.length);
        cleanedParts.push(part);
      }
      else changed = true;
      markerStepIndex += 1;
    }
    const visibleToolCallIds = new Set(
      cleanedParts.flatMap((part) => part.type === "dynamic-tool" ? [part.toolCallId] : []),
    );
    const syntheticByStep = new Map<number, EveDynamicToolPart[]>();
    for (const partial of partialsForMessage) {
      if (visibleToolCallIds.has(partial.data.callId)) continue;
      changed = true;
      visibleToolCallIds.add(partial.data.callId);
      const synthetic: EveDynamicToolPart = {
        errorText: terminal === "cancelled" || terminal === "cancelling"
          ? terminal === "cancelled" ? INTERRUPTED_TOOL_ERROR : CANCELLING_TOOL_ERROR
          : incompleteToolError(segmentEvents, messageTurnId, {
              input: partial.data.input ?? {},
              stepIndex: partial.data.stepIndex,
              toolCallId: partial.data.callId,
              toolName: partial.data.toolName,
              type: "dynamic-tool",
              state: "input-streaming",
            }),
        input: partial.data.input ?? {},
        inputText: partial.data.inputTextSoFar,
        state: "output-error",
        stepIndex: partial.data.stepIndex,
        toolCallId: partial.data.callId,
        toolName: partial.data.toolName,
        type: "dynamic-tool",
      };
      const stepParts = syntheticByStep.get(partial.data.stepIndex) ?? [];
      stepParts.push(synthetic);
      syntheticByStep.set(partial.data.stepIndex, stepParts);
    }
    for (const [stepIndex, retryParts] of failedRetryToolParts(
      segmentEvents,
      messageTurnId,
      visibleToolCallIds,
    )) {
      changed = true;
      const stepParts = syntheticByStep.get(stepIndex) ?? [];
      stepParts.push(...retryParts);
      syntheticByStep.set(stepIndex, stepParts);
    }
    // Keep a recovered failed tool next to its original step marker. This
    // preserves the event order users saw during the live run.
    const insertions = [...syntheticByStep.entries()]
      .map(([stepIndex, stepParts]) => ({
        index: markerIndexByStep.get(stepIndex) ?? cleanedParts.length - 1,
        stepParts,
      }))
      .sort((left, right) => right.index - left.index);
    for (const insertion of insertions) {
      cleanedParts.splice(insertion.index + 1, 0, ...insertion.stepParts);
    }
    if (message.metadata?.status === "streaming") {
      changed = true;
    }
    return changed
      ? {
          ...message,
          metadata: message.metadata?.status === "streaming"
            ? { ...message.metadata, status: "complete" }
            : message.metadata,
          parts: cleanedParts,
        }
      : message;
  });
}

type RetryToolAttempt = {
  readonly actions: ReadonlyArray<Extract<MessageStreamEvent, { type: "actions.requested" }>['data']['actions'][number]>;
  readonly failure?: AgentTurnFailure;
  readonly stepIndex: number;
};

/**
 * Eve retries a step with the same call id in some provider paths. Its
 * reducer consequently keeps only the last tool part. Rebuild the earlier
 * failed attempts from the ordered action/failure events so a retry never
 * erases the tool card the user already saw.
 */
function failedRetryToolParts(
  events: readonly MessageStreamEvent[],
  turnId: string,
  visibleToolCallIds: ReadonlySet<string>,
): ReadonlyMap<number, readonly EveDynamicToolPart[]> {
  const attempts: RetryToolAttempt[] = [];
  let current: { actions: ReadonlyArray<Extract<MessageStreamEvent, { type: "actions.requested" }>['data']['actions'][number]>; stepIndex: number; failure?: AgentTurnFailure } | undefined;
  for (const event of events) {
    if (eventTurnId(event) !== turnId) continue;
    if (event.type === "step.started") {
      current = { actions: [], stepIndex: event.data.stepIndex };
      attempts.push(current);
      continue;
    }
    if (event.type === "actions.requested") {
      if (!current || current.stepIndex !== event.data.stepIndex) {
        current = { actions: [], stepIndex: event.data.stepIndex };
        attempts.push(current);
      }
      current.actions = [...current.actions, ...event.data.actions];
      continue;
    }
    if (event.type === "step.failed") {
      if (!current || current.stepIndex !== event.data.stepIndex) continue;
      current.failure = failureFromData(event.data);
    }
  }

  const failedAttempts = attempts.filter((attempt) => attempt.failure && attempt.actions.length > 0);
  if (failedAttempts.length === 0) return new Map();
  const completedCallIds = new Set(
    events.flatMap((event) => event.type === "action.result" && event.data.status === "completed"
      ? [event.data.result.callId]
      : []),
  );
  const lastFailedAttemptByCall = new Map<string, number>();
  failedAttempts.forEach((attempt, index) => {
    for (const action of attempt.actions) lastFailedAttemptByCall.set(action.callId, index);
  });
  const byStep = new Map<number, EveDynamicToolPart[]>();
  failedAttempts.forEach((attempt, attemptIndex) => {
    for (const action of attempt.actions) {
      // The reducer's visible part represents the final occurrence of this
      // call. Only synthesize earlier occurrences when that final part exists;
      // otherwise the partial-input recovery below owns the latest failure.
      if (
        visibleToolCallIds.has(action.callId) &&
        !completedCallIds.has(action.callId) &&
        lastFailedAttemptByCall.get(action.callId) === attemptIndex
      ) continue;
      const toolName = "toolName" in action && typeof action.toolName === "string"
        ? action.toolName
        : "subagentName" in action && typeof action.subagentName === "string"
          ? action.subagentName
          : "tool";
      const stepParts = byStep.get(attempt.stepIndex) ?? [];
      stepParts.push({
        errorText: attempt.failure!.message,
        input: "input" in action ? action.input ?? {} : {},
        state: "output-error",
        stepIndex: attempt.stepIndex,
        toolCallId: `retry:${turnId}:${attempt.stepIndex}:${attemptIndex}:${action.callId}`,
        toolName,
        type: "dynamic-tool",
      });
      byStep.set(attempt.stepIndex, stepParts);
    }
  });
  return byStep;
}

function incompleteToolError(
  events: readonly MessageStreamEvent[],
  turnId: string,
  part: EveDynamicToolPart,
): string {
  const result = [...events].reverse().find((event) =>
    event.type === "action.result" &&
    event.data.turnId === turnId &&
    event.data.result.callId === part.toolCallId &&
    event.data.status !== "completed",
  );
  if (result?.type === "action.result" && result.data.error?.message) {
    return result.data.error.message;
  }
  const stepFailure = [...events].reverse().find((event) =>
    event.type === "step.failed" &&
    event.data.turnId === turnId &&
    (part.stepIndex === undefined || event.data.stepIndex === part.stepIndex),
  );
  if (stepFailure?.type === "step.failed") return stepFailure.data.message;
  const turnFailure = [...events].reverse().find((event) =>
    event.type === "turn.failed" && event.data.turnId === turnId,
  );
  if (turnFailure?.type === "turn.failed") return turnFailure.data.message;
  return INCOMPLETE_TOOL_ERROR;
}

function isOpenToolPart(part: EveDynamicToolPart): part is OpenToolPart {
  return part.state === "input-streaming" ||
    part.state === "input-available" ||
    (part.state === "output-available" && part.partial === true);
}

type OpenToolPart =
  | Extract<EveDynamicToolPart, { readonly state: "input-streaming" | "input-available" }>
  | (Extract<EveDynamicToolPart, { readonly state: "output-available" }> & { readonly partial: true });

const MAX_DURABLE_STEP_RETRIES = 3;

/**
 * Eve's message protocol exposes one terminal step failure after its internal
 * model retry budget is exhausted. Only classify failures with a transient
 * transport/provider signature as retry exhaustion; permanent rejections and
 * unknown runtime errors remain an execution failure.
 */
function shouldPresentRetryFailure(failure: AgentTurnFailure): boolean {
  return isRetryableAgentFailure(failure);
}

export function shouldSuppressInterruptedTurnDisplayEvent(
  event: MessageStreamEvent,
  eventIndex: number,
  turns: readonly AgentInterruptedTurn[],
): boolean {
  return shouldSuppressInterruptedTurnEvent(event, turns, (turn) =>
    eventIndex >= turn.eventCount
  );
}

export function shouldSuppressInterruptedTurnStreamEvent(
  event: MessageStreamEvent,
  streamIndex: number,
  turns: readonly AgentInterruptedTurn[],
): boolean {
  return shouldSuppressInterruptedTurnEvent(event, turns, (turn) =>
    streamIndex >= turn.streamIndex
  );
}

function shouldSuppressInterruptedTurnEvent(
  event: MessageStreamEvent,
  turns: readonly AgentInterruptedTurn[],
  isAfterCancellation: (turn: AgentInterruptedTurn) => boolean,
): boolean {
  if (
    event.type === "message.received" ||
    event.type === "turn.cancelled" ||
    event.type === "turn.started"
  ) return false;
  const turnId = eventTurnId(event);
  if (!turnId) return false;
  const interrupted = turns.find((turn) => turn.turnId === turnId);
  // A local cancellation marker is only a UI intent. Keep accepting durable
  // events until Eve confirms `turn.cancelled`; otherwise a tool result that
  // wins the cancellation race would be hidden and the refresh projection
  // would disagree with the live view.
  return Boolean(interrupted && interrupted.settled !== false && isAfterCancellation(interrupted));
}

/**
 * Eve resumes a structured HITL response in a continuation turn without a new
 * user message. The durable protocol should remain untouched, but the chat UI
 * must present that continuation as one execution cycle. This display-only
 * projection merges those assistant fragments and assigns continuous visual
 * step indexes so confirmations do not create a second timer or task group.
 */
export function projectAgentDisplayTimeline(
  messages: readonly EveMessage[],
  events: readonly MessageStreamEvent[],
): AgentDisplayProjection {
  const turns = turnDisplayCoordinates(events);
  if (turns.size === 0) return { events, messages };

  const projectedEvents: MessageStreamEvent[] = [];
  let latestSourceTerminalTurnId: string | undefined;
  for (const event of events) {
    if (event.type === "session.waiting") {
      const coordinates = latestSourceTerminalTurnId ? turns.get(latestSourceTerminalTurnId) : undefined;
      if (coordinates && !coordinates.finalTurn) continue;
      projectedEvents.push(event);
      continue;
    }

    const sourceTurnId = eventTurnId(event);
    const coordinates = sourceTurnId ? turns.get(sourceTurnId) : undefined;
    if (!coordinates) {
      projectedEvents.push(event);
      continue;
    }
    if (
      (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") &&
      !coordinates.finalTurn
    ) {
      latestSourceTerminalTurnId = sourceTurnId;
      continue;
    }
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
      latestSourceTerminalTurnId = sourceTurnId;
    }
    projectedEvents.push(remapEventCoordinates(event, coordinates.rootTurnId, coordinates.stepOffset));
  }

  const projectedMessages: EveMessage[] = [];
  const assistantByRoot = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.metadata?.turnId) {
      if (message.role === "user" && message.metadata?.turnId) {
        const coordinates = turns.get(message.metadata.turnId);
        if (coordinates) assistantByRoot.delete(coordinates.rootTurnId);
      }
      projectedMessages.push(message);
      continue;
    }
    const coordinates = turns.get(message.metadata.turnId);
    if (!coordinates) {
      projectedMessages.push(message);
      continue;
    }
    const remapped = remapAssistantMessage(message, coordinates.rootTurnId, coordinates.stepOffset);
    const existingIndex = assistantByRoot.get(coordinates.rootTurnId);
    if (existingIndex === undefined) {
      assistantByRoot.set(coordinates.rootTurnId, projectedMessages.length);
      projectedMessages.push(remapped);
      continue;
    }
    const existing = projectedMessages[existingIndex];
    if (existing?.role !== "assistant") continue;
    projectedMessages[existingIndex] = mergeAssistantMessages(existing, remapped);
  }

  return { events: projectedEvents, messages: projectedMessages };
}

export function presentAgentStep(
  events: readonly MessageStreamEvent[],
  turnId: string | undefined,
  stepIndex: number,
): AgentStepPresentation {
  if (!turnId) return { status: "running" };
  const stepEvents = events.filter((event) =>
    eventTurnId(event) === turnId &&
    eventStepIndex(event) === stepIndex
  );
  const starts = stepEvents.filter((event) => event.type === "step.started");
  const failures = stepEvents.filter((event) => event.type === "step.failed");
  const completed = [...stepEvents].reverse().find((event) => event.type === "step.completed");
  const maximumTurnStepIndex = events.reduce((maximum, event) =>
    eventTurnId(event) === turnId
      ? Math.max(maximum, eventStepIndex(event) ?? -1)
      : maximum,
  -1);
  const terminalFailureEvent = stepIndex === maximumTurnStepIndex
    ? [...events].reverse().find((event): event is Extract<MessageStreamEvent, { type: "turn.failed" }> =>
        event.type === "turn.failed" && event.data.turnId === turnId
      ) ?? [...events].reverse().find((event): event is Extract<MessageStreamEvent, { type: "session.failed" }> =>
        event.type === "session.failed"
      )
    : undefined;
  const terminalFailure = terminalFailureEvent
    ? failureFromData(terminalFailureEvent.data)
    : undefined;
  const latestFailure = failures.at(-1);
  const retryFailure = latestFailure?.type === "step.failed"
    ? failureFromData(latestFailure.data)
    : terminalFailure;
  const retryableFailure = retryFailure && shouldPresentRetryFailure(retryFailure)
    ? retryFailure
    : undefined;
  // Eve intentionally does not expose an attempt number. Count only durable
  // failed step boundaries that are actually present; the terminal alert does
  // not expose this count, while an in-flight retry row may show it.
  const observedRetryAttempt = retryableFailure
    ? Math.max(1, failures.length)
    : undefined;
  const retryExhausted = Boolean(terminalFailure && retryableFailure);
  const retryEvents = failures.flatMap((failure, index) => {
    const candidate = failureFromData(failure.data);
    return shouldPresentRetryFailure(candidate)
      ? [{
          attempt: index + 1,
          error: candidate,
          ...(retryExhausted && index === failures.length - 1 ? { exhausted: true } : {}),
          maximum: MAX_DURABLE_STEP_RETRIES,
        }]
      : [];
  });
  const retries = retryEvents.length > 0
    ? retryEvents
    : retryableFailure
      ? [{ attempt: 1, error: retryableFailure, ...(retryExhausted ? { exhausted: true } : {}), maximum: MAX_DURABLE_STEP_RETRIES }]
      : [];
  const latestStartIndex = stepEvents.findLastIndex((event) => event.type === "step.started");
  const latestAttemptEvents = latestStartIndex >= 0 ? stepEvents.slice(latestStartIndex) : stepEvents;
  const latestAttemptFailed = latestAttemptEvents.some((event) => event.type === "step.failed");
  const endedAt = latestAttemptFailed && !completed && !terminalFailure
    ? undefined
    : modelOutputBoundaryTime(latestAttemptEvents) ?? eventTimestamp(completed ?? terminalFailureEvent);
  return {
    ...(endedAt ? { endedAt } : {}),
    ...(terminalFailure ? { failure: terminalFailure } : {}),
    ...(retryableFailure && !completed
      ? {
          retry: {
            ...(observedRetryAttempt !== undefined ? { attempt: observedRetryAttempt } : {}),
            ...(retryExhausted ? { exhausted: true } : {}),
            error: retryableFailure,
            maximum: MAX_DURABLE_STEP_RETRIES,
          },
        }
      : {}),
    ...(retries.length > 0 ? { retries } : {}),
    ...(eventTimestamp(starts.at(-1)) ? { startedAt: eventTimestamp(starts.at(-1)) } : {}),
    status: terminalFailure
      ? "failed"
      : completed || endedAt
        ? "completed"
        : "running",
  };
}

/** Return the actual provider reasoning text for one durable model step. */
export function reasoningContentForStep(
  events: readonly MessageStreamEvent[],
  turnId: string | undefined,
  stepIndex: number | undefined,
): string {
  let content = "";
  let completedBlock = false;
  for (const event of events) {
    if (
      event.type === "step.started" &&
      (turnId === undefined || event.data.turnId === turnId) &&
      (stepIndex === undefined || event.data.stepIndex === stepIndex)
    ) {
      // eve retries an interrupted step with the same turn/step coordinates.
      // A new step boundary starts a new reasoning block; never carry the
      // previous attempt's text into the retry.
      content = "";
      completedBlock = false;
      continue;
    }
    if (
      (event.type !== "reasoning.appended" && event.type !== "reasoning.completed") ||
      (turnId !== undefined && event.data.turnId !== turnId) ||
      (stepIndex !== undefined && event.data.stepIndex !== stepIndex)
    ) continue;
    if (event.type === "reasoning.completed") {
      if (event.data.reasoning.trim()) content = event.data.reasoning;
      completedBlock = true;
      continue;
    }
    if (completedBlock) {
      // Older providers may omit the next step.started and begin a retry with
      // a delta-only reasoning event. Treat that first delta as a fresh block.
      content = "";
      completedBlock = false;
    }
    if (event.data.reasoningSoFar.trim()) {
      content = event.data.reasoningSoFar;
    } else if (event.data.reasoningDelta.trim()) {
      content += event.data.reasoningDelta;
    }
  }
  return content.trim();
}

export function presentAgentTurn(
  message: EveMessage,
  events: readonly MessageStreamEvent[],
  closedInputRequestIds: ReadonlySet<string> = new Set(),
  options: AgentTurnPresentationOptions = {},
): AgentTurnPresentation | undefined {
  if (message.role !== "assistant" || !message.metadata?.turnId) return undefined;

  const turnId = message.metadata.turnId;
  const messageSegment = eventsForAssistantSegment(message, events);
  const turnEvents = options.mergeSameTurn
    ? eventsForRootTurn(events, turnId)
    : messageSegment.events;
  // Root-turn lifecycle events provide the shared timer/status. Part ordering
  // remains scoped to this assistant segment so steering never duplicates the
  // tools already rendered by the preceding segment.
  const partEvents = options.mergeSameTurn ? messageSegment.events : turnEvents;
  const pendingIds = new Set(
    unresolvedInputRequests(events, closedInputRequestIds).map((request) => request.requestId),
  );
  const pendingRequests = partEvents
    .flatMap((event) => event.type === "input.requested" ? event.data.requests : [])
    .filter((request) => pendingIds.has(request.requestId));
  const firstAction = turnEvents.find((event) => event.type === "actions.requested");
  const hasTools = firstAction !== undefined || pendingRequests.length > 0 || message.parts.some((part) => part.type === "dynamic-tool");
  if (!hasTools) return undefined;

  const terminal = [...turnEvents].reverse().find((event) =>
    (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled" || event.type === "session.failed") &&
    !isLocalInterruptedBoundary(event),
  );
  const status = pendingRequests.length > 0
    ? "waiting"
    : terminal?.type === "turn.completed"
    ? "completed"
    : terminal?.type === "turn.failed" || terminal?.type === "session.failed"
      ? "failed"
    : terminal?.type === "turn.cancelled"
        ? "cancelled"
        : !options.mergeSameTurn && messageSegment.settledAt !== undefined
          ? "completed"
        : "running";
  const finalStepIndex = finalDeliveryStepIndex(turnEvents, message, status);
  let finalPart: Extract<EveMessagePart, { type: "text" }> | undefined;
  const processParts: EveMessagePart[] = [];

  // The Eve reducer normally preserves event order, but a reconnect can
  // briefly expose its message snapshot and event snapshot at different
  // render ticks. Re-anchor parts to the durable event sequence before
  // splitting the final delivery from the execution process. This prevents a
  // narration that happened before a tool call from jumping below that tool.
  for (const part of orderAssistantMessageParts(message.parts, partEvents, turnId)) {
    if (part.type === "text" && part.stepIndex === finalStepIndex) {
      finalPart = part;
      continue;
    }
    processParts.push(part);
  }

  const failedStep = status === "failed" && turnEvents.some((event) =>
    event.type === "step.failed" && event.data.turnId === turnId,
  );
  const failedStepEvent = failedStep
    ? [...turnEvents].reverse().find((event): event is Extract<MessageStreamEvent, { type: "step.failed" }> =>
        event.type === "step.failed" && event.data.turnId === turnId,
      )
    : undefined;
  // Eve normally emits step.failed before turn.failed, but a reconnect can
  // expose only the terminal boundary. The last event-bearing step is still
  // the exact place where that failure belongs.
  const failedStepIndex = failedStepEvent?.data.stepIndex ?? (
    status === "failed" ? latestStepIndex(turnEvents, turnId) : undefined
  );
  const failedStepHasPart = failedStepIndex !== undefined && processParts.some((part) =>
    "stepIndex" in part && part.stepIndex === failedStepIndex,
  );
  const markerAnchored = status === "failed" && failedStepIndex !== undefined && hasStepMarkerForIndex(
    processParts,
    partEvents,
    turnId,
    failedStepIndex,
  );
  const shouldAddFailureMarker = status === "failed" && failedStepIndex !== undefined && !failedStepHasPart && !markerAnchored;
  const displayProcessParts = shouldAddFailureMarker
    ? [...processParts, { type: "step-start" as const }]
    : processParts;
  const failureAnchored = status === "failed" && (
    failedStepHasPart || markerAnchored || shouldAddFailureMarker
  );

  return {
    endedAt: eventTimestamp(terminal) ?? (
      options.mergeSameTurn ? undefined : messageSegment.settledAt
    ),
    finalPart,
    ...(failureAnchored ? { failureAnchored: true } : {}),
    proxiedInputParts: pendingRequests
      .filter((request) => !message.parts.some((part) =>
        part.type === "dynamic-tool" && part.approval?.id === request.requestId,
      ))
      .map(toProxiedInputPart),
    // Settled failed provider calls may have no message part left after the
    // orphaned tool snapshot is normalized. Keep one display-only marker so
    // the failure card remains anchored to its actual failed step. A marker
    // from an earlier step is not sufficient: without this tail marker the
    // failure is silently hidden by AgentMessage's duplicate suppression.
    processParts: displayProcessParts,
    startedAt: eventTimestamp(firstAction),
    status,
    ...(pendingRequests[0]?.kind ? { waitingFor: pendingRequests[0].kind } : {}),
  };
}

/**
 * Reconcile a reducer message with its event segment without rebuilding the
 * whole message state. The position of each part is derived from the first
 * event that could have produced it; parts with no matching event keep their
 * original position. This is intentionally stable so a live partial tool
 * snapshot never jumps around while its input grows.
 */
function orderAssistantMessageParts(
  parts: readonly EveMessagePart[],
  events: readonly MessageStreamEvent[],
  turnId: string,
): readonly EveMessagePart[] {
  if (parts.length < 2 || events.length < 2) return parts;

  const markerSteps = new Map<number, number>();
  let previousStep = -1;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.type !== "step-start") continue;
    const nextMarker = parts.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && candidate.type === "step-start",
    );
    const group = parts.slice(index + 1, nextMarker < 0 ? parts.length : nextMarker);
    const explicitStep = group
      .flatMap((candidate) =>
        "stepIndex" in candidate && typeof candidate.stepIndex === "number"
          ? [candidate.stepIndex]
          : [],
      )
      .sort((left, right) => left - right)[0];
    const nextStep = explicitStep !== undefined
      ? explicitStep
      : events.map(eventStepIndex).find((step): step is number => step !== undefined && step > previousStep);
    if (nextStep !== undefined) {
      markerSteps.set(index, nextStep);
      previousStep = nextStep;
    }
  }

  let activeStep: number | undefined;
  const indexed = parts.map((part, index) => {
    if (part.type === "step-start") activeStep = markerSteps.get(index);
    else if ("stepIndex" in part && typeof part.stepIndex === "number") activeStep = part.stepIndex;
    const eventIndex = partEventIndex(part, events, turnId, activeStep);
    // A reducer snapshot can omit the step index on narration parts. If the
    // matching durable event has one, use it for ordering instead of sending
    // the part to the end of the message. This is what keeps narration before
    // a following tool after a reconnect.
    const eventStep = eventIndex === undefined || !Number.isInteger(eventIndex)
      ? undefined
      : eventStepIndex(events[eventIndex]!);
    return {
      eventIndex,
      index,
      isMarker: part.type === "step-start",
      part,
      stepIndex: activeStep,
      sortStep: activeStep ?? eventStep,
    };
  });
  const groups = new Map<number, typeof indexed>();
  for (const entry of indexed) {
    if (entry.stepIndex === undefined) continue;
    const group = groups.get(entry.stepIndex) ?? [];
    group.push(entry);
    groups.set(entry.stepIndex, group);
  }
  // Older persisted snapshots can omit `step.started`. Assign a local order
  // within each step so an unmatched narration remains beside the tool it
  // precedes instead of being sorted to the end of the entire message.
  const localOrder = new Map<number, number>();
  for (const group of groups.values()) {
    const known = group
      .map((entry) => entry.eventIndex)
      .filter((position): position is number => position !== undefined)
      .sort((left, right) => left - right);
    const firstKnown = known[0];
    const lastKnown = known.at(-1);
    let unknownAfter = 0;
    for (const entry of group) {
      if (entry.eventIndex !== undefined) {
        localOrder.set(entry.index, entry.eventIndex);
        continue;
      }
      const nextKnown = group
        .filter((candidate) => candidate.index > entry.index && candidate.eventIndex !== undefined)
        .map((candidate) => candidate.eventIndex!)
        .sort((left, right) => left - right)[0];
      if (entry.isMarker && firstKnown !== undefined) {
        localOrder.set(entry.index, firstKnown - 1);
      } else if (nextKnown !== undefined) {
        localOrder.set(entry.index, nextKnown - 0.25);
      } else if (lastKnown !== undefined) {
        localOrder.set(entry.index, lastKnown + 0.25 + unknownAfter++ / 100);
      } else {
        localOrder.set(entry.index, entry.index);
      }
    }
  }
  for (const entry of indexed) {
    if (!localOrder.has(entry.index)) {
      localOrder.set(entry.index, entry.eventIndex ?? entry.index);
    }
  }
  const hasComparablePosition = indexed.some((entry) => entry.eventIndex !== undefined);
  if (!hasComparablePosition) return parts;
  return indexed
    .toSorted((left, right) =>
      (left.sortStep ?? Number.MAX_SAFE_INTEGER) - (right.sortStep ?? Number.MAX_SAFE_INTEGER) ||
      (localOrder.get(left.index) ?? Number.MAX_SAFE_INTEGER) - (localOrder.get(right.index) ?? Number.MAX_SAFE_INTEGER) ||
      left.index - right.index,
    )
    .map((entry) => entry.part);
}

function partEventIndex(
  part: EveMessagePart,
  events: readonly MessageStreamEvent[],
  turnId: string,
  stepIndex: number | undefined,
): number | undefined {
  const matchesStep = (event: MessageStreamEvent): boolean =>
    eventTurnId(event) === turnId && (stepIndex === undefined || eventStepIndex(event) === stepIndex);
  if (part.type === "step-start") {
    return firstEventIndex(events, (event) => event.type === "step.started" && matchesStep(event));
  }
  if (part.type === "reasoning") {
    const appended = firstEventIndex(events, (event) =>
      matchesStep(event) && event.type === "reasoning.appended");
    if (appended !== undefined) return appended;

    // Older compact checkpoints may contain only reasoning.completed. That
    // boundary is emitted after action results by Eve and is not the visual
    // start of the thought. Anchor the fallback to step.started (or just
    // before the first step event) so tools cannot jump above the reasoning.
    const stepStarted = firstEventIndex(events, (event) =>
      event.type === "step.started" && matchesStep(event));
    if (stepStarted !== undefined) return stepStarted + 0.1;
    const firstStepEvent = firstEventIndex(events, matchesStep);
    return firstStepEvent === undefined ? undefined : firstStepEvent - 0.1;
  }
  if (part.type === "text") {
    return firstEventIndex(events, (event) =>
      matchesStep(event) && (event.type === "message.appended" || event.type === "message.completed"));
  }
  if (part.type === "dynamic-tool") {
    return firstEventIndex(events, (event) =>
      matchesStep(event) && (
        (event.type === "action.input.partial" && event.data.callId === part.toolCallId) ||
        (event.type === "actions.requested" && event.data.actions.some((action) => action.callId === part.toolCallId)) ||
        (event.type === "action.result" && event.data.result.callId === part.toolCallId)
      ));
  }
  return firstEventIndex(events, matchesStep);
}

function firstEventIndex(
  events: readonly MessageStreamEvent[],
  predicate: (event: MessageStreamEvent) => boolean,
): number | undefined {
  const index = events.findIndex(predicate);
  return index >= 0 ? index : undefined;
}

function latestStepIndex(events: readonly MessageStreamEvent[], turnId: string): number | undefined {
  return events.reduce<number | undefined>((latest, event) => {
    if (eventTurnId(event) !== turnId) return latest;
    const stepIndex = eventStepIndex(event);
    return stepIndex === undefined ? latest : Math.max(latest ?? stepIndex, stepIndex);
  }, undefined);
}

function hasStepMarkerForIndex(
  parts: readonly EveMessagePart[],
  events: readonly MessageStreamEvent[],
  turnId: string,
  targetStepIndex: number,
): boolean {
  let previousStepIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index]?.type !== "step-start") continue;
    const nextStep = parts.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && candidate.type === "step-start",
    );
    const stepParts = parts.slice(index + 1, nextStep < 0 ? parts.length : nextStep);
    const explicit = stepParts.find((part) =>
      "stepIndex" in part && typeof part.stepIndex === "number",
    );
    const stepIndex = explicit && "stepIndex" in explicit && typeof explicit.stepIndex === "number"
      ? explicit.stepIndex
      : events
        .map(eventStepIndex)
        .filter((candidate): candidate is number => candidate !== undefined && candidate > previousStepIndex)
        .find((candidate) => events.some((event) => eventTurnId(event) === turnId && eventStepIndex(event) === candidate));
    if (stepIndex === undefined) continue;
    previousStepIndex = stepIndex;
    if (stepIndex === targetStepIndex) return true;
  }
  return false;
}

/**
 * Eve proxies descendant HITL requests onto the root stream. They retain the
 * child turn id, so the default reducer creates an otherwise orphaned message.
 * The workspace renders those requests inside the owning root task instead.
 */
export function isProxiedInputOnlyMessage(
  message: EveMessage,
  events: readonly MessageStreamEvent[],
): boolean {
  if (message.role !== "assistant" || !message.metadata?.turnId) return false;
  const turnId = message.metadata.turnId;
  if (events.some((event) => event.type === "turn.started" && event.data.turnId === turnId)) {
    return false;
  }
  const requests = events.flatMap((event) =>
    event.type === "input.requested" && event.data.turnId === turnId
      ? event.data.requests
      : [],
  );
  if (requests.length === 0) return false;
  const requestIds = new Set(requests.map((request) => request.requestId));
  return message.parts.every((part) =>
    part.type === "step-start" ||
    (part.type === "dynamic-tool" && part.approval !== undefined && requestIds.has(part.approval.id)),
  );
}

export function unresolvedInputRequests(
  events: readonly MessageStreamEvent[],
  closedInputRequestIds: ReadonlySet<string> = new Set(),
): readonly InputRequest[] {
  let pending = new Map<string, InputRequest>();
  let hasRequestedInput = false;
  for (const event of events) {
    if (event.type === "input.requested") {
      hasRequestedInput = true;
      for (const request of event.data.requests) pending.set(request.requestId, request);
      continue;
    }
    // Eve resumes a parked request by starting the next root turn. Descendant
    // turn starts are not proxied as top-level events.
    if (event.type === "turn.started" && hasRequestedInput) {
      pending = new Map();
      hasRequestedInput = false;
      continue;
    }
    if (event.type === "turn.cancelled" || event.type === "session.completed" || event.type === "session.failed") {
      pending = new Map();
      hasRequestedInput = false;
    }
  }
  return [...pending.values()].filter((request) => !closedInputRequestIds.has(request.requestId));
}

export function hasUnresolvedInputRequests(
  events: readonly MessageStreamEvent[],
  closedInputRequestIds: ReadonlySet<string> = new Set(),
): boolean {
  return unresolvedInputRequests(events, closedInputRequestIds).length > 0;
}

/** Treats Eve's persisted turn boundary as authoritative over stale UI stream state. */
export function hasSettledLatestTurn(events: readonly MessageStreamEvent[]): boolean {
  const startedIndex = events.findLastIndex((event) => event.type === "turn.started");
  const sessionBoundaryIndex = events.findLastIndex((event) =>
    event.type === "session.waiting" || event.type === "session.completed" || event.type === "session.failed",
  );
  // A session boundary settles the latest turn only when it follows the latest
  // turn start (or when no turn start was ever emitted). Looking only at
  // `events.at(-1)` was brittle when a checkpoint appended a non-lifecycle
  // event after `session.waiting`; conversely, accepting any historical
  // waiting event could unlock a newer turn after an out-of-order recovery
  // merge.
  // A session can fail before Eve emits `turn.started` (for example, a model
  // request rejected while the first turn is being admitted). The session
  // boundary is still authoritative in that shape; requiring a turn start
  // here leaves the UI in a phantom running/editable state forever.
  if (sessionBoundaryIndex > startedIndex) return true;
  if (startedIndex < 0) return false;
  const started = events[startedIndex];
  if (started?.type !== "turn.started") return false;
  return events.slice(startedIndex + 1).some((event) =>
    (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") &&
    event.data.turnId === started.data.turnId
  ) || events.slice(startedIndex + 1).some((event) =>
    event.type === "session.failed"
  );
}

/**
 * Whether the latest session boundary is terminal rather than resumable.
 * `session.waiting` is intentionally excluded: Eve accepts another message
 * in that state, while completed/failed sessions reject clear/send controls.
 */
export function hasTerminalSessionBoundary(events: readonly MessageStreamEvent[]): boolean {
  const startedIndex = events.findLastIndex((event) => event.type === "turn.started");
  const terminalIndex = events.findLastIndex((event) =>
    event.type === "session.completed" || event.type === "session.failed",
  );
  return terminalIndex > startedIndex;
}

export function failureForTurn(
  events: readonly MessageStreamEvent[],
  turnId: string | undefined,
): AgentTurnFailure | undefined {
  if (!turnId) return undefined;
  // A step failure is an intermediate retry signal. Only a durable terminal
  // boundary belongs in the message-level failure slot; otherwise a transient
  // provider retry flashes a second error card at the bottom of the thread.
  const event = [...events].reverse().find((candidate) =>
    candidate.type === "turn.failed" && candidate.data.turnId === turnId,
  );
  if (event?.type === "turn.failed") {
    return failureFromData(event.data);
  }
  const startedIndex = events.findLastIndex((candidate) =>
    candidate.type === "turn.started" && candidate.data.turnId === turnId,
  );
  const sessionFailureIndex = events.findLastIndex((candidate) => candidate.type === "session.failed");
  const sessionFailure = sessionFailureIndex > startedIndex ? events[sessionFailureIndex] : undefined;
  return sessionFailure?.type === "session.failed"
    ? failureFromData(sessionFailure.data)
    : undefined;
}

/** Keeps the settled transcript before the latest user turn for edit/resend. */
export function eventsBeforeLastUserTurn(
  events: readonly MessageStreamEvent[],
): readonly MessageStreamEvent[] {
  const lastUserEvent = events.findLast((event) => event.type === "message.received");
  if (lastUserEvent?.type !== "message.received") return [];

  const turnStartIndex = events.findLastIndex((event) =>
    event.type === "turn.started" && event.data.turnId === lastUserEvent.data.turnId,
  );
  if (turnStartIndex >= 0) return events.slice(0, turnStartIndex);

  const lastUserTurnIndex = events.lastIndexOf(lastUserEvent);
  return events.slice(0, lastUserTurnIndex);
}

export function presentSubagentCall(
  events: readonly MessageStreamEvent[],
  callId: string,
): SubagentCallPresentation {
  const started = events.find((event) =>
    event.type === "subagent.called" && event.data.callId === callId,
  );
  const completed = [...events].reverse().find((event) =>
    event.type === "subagent.completed" && event.data.callId === callId,
  );
  const result = [...events].reverse().find((event) =>
    event.type === "action.result" &&
    event.data.result.kind === "subagent-result" &&
    event.data.result.callId === callId,
  );
  const owningTurnId = started?.type === "subagent.called" ? started.data.turnId : undefined;
  const parentCancellation = owningTurnId
    ? [...events].reverse().find((event) =>
        event.type === "turn.cancelled" && event.data.turnId === owningTurnId,
      )
    : undefined;
  const terminalSession = [...events].reverse().find((event) =>
    event.type === "session.completed" || event.type === "session.failed",
  );

  if (result?.type === "action.result" && result.data.status !== "completed") {
    return {
      childSessionId: started?.type === "subagent.called" ? started.data.childSessionId : undefined,
      endedAt: eventTimestamp(result),
      name: started?.type === "subagent.called" ? started.data.name : undefined,
      startedAt: eventTimestamp(started),
      status: "failed",
    };
  }
  if (completed || result) {
    return {
      childSessionId: started?.type === "subagent.called" ? started.data.childSessionId : undefined,
      endedAt: eventTimestamp(result ?? completed),
      name: started?.type === "subagent.called" ? started.data.name : undefined,
      startedAt: eventTimestamp(started),
      status: "completed",
    };
  }
  if (parentCancellation?.type === "turn.cancelled") {
    return {
      childSessionId: started?.type === "subagent.called" ? started.data.childSessionId : undefined,
      name: started?.type === "subagent.called" ? started.data.name : undefined,
      startedAt: eventTimestamp(started),
      // The parent boundary means cancellation was requested recursively, not
      // that this child has emitted its own turn.cancelled/session.waiting.
      // Keep the card open until the child lifecycle projection confirms it.
      status: "waiting",
    };
  }
  if (terminalSession) {
    return {
      childSessionId: started?.type === "subagent.called" ? started.data.childSessionId : undefined,
      endedAt: eventTimestamp(terminalSession),
      name: started?.type === "subagent.called" ? started.data.name : undefined,
      startedAt: eventTimestamp(started),
      status: "failed",
    };
  }
  if (started?.type !== "subagent.called") return { status: "starting" };
  return {
    childSessionId: started.data.childSessionId,
    name: started.data.name,
    startedAt: eventTimestamp(started),
    status: "running",
  };
}

export function presentSubagentSessions(
  events: readonly MessageStreamEvent[],
): readonly SubagentSessionPresentation[] {
  const calls = events.flatMap((event) =>
    event.type === "actions.requested"
      ? event.data.actions.filter((action) => action.kind === "subagent-call")
      : [],
  );
  return calls.map((call) => ({
    ...presentSubagentCall(events, call.callId),
    callId: call.callId,
    task: subagentTask(call.input),
  }));
}

function eventsForRootTurn(
  events: readonly MessageStreamEvent[],
  turnId: string,
): readonly MessageStreamEvent[] {
  const start = events.findIndex((event) =>
    event.type === "turn.started" && event.data.turnId === turnId,
  );
  if (start < 0) return events.filter((event) => eventTurnId(event) === turnId);
  const next = events.findIndex((event, index) =>
    index > start && event.type === "message.received" && event.data.turnId !== turnId
  );
  return events.slice(start, next < 0 ? undefined : next);
}

function eventsForAssistantSegment(
  message: EveMessage,
  events: readonly MessageStreamEvent[],
): { readonly events: readonly MessageStreamEvent[]; readonly settledAt?: number } {
  const turnId = message.metadata?.turnId;
  if (!turnId) return { events: [] };

  const rootEvents = eventsForRootTurn(events, turnId);
  const clientMessageId = assistantSegmentClientMessageId(message, turnId);
  const receiptIndex = rootEvents.findIndex((event) =>
    event.type === "message.received" &&
    event.data.turnId === turnId &&
    (clientMessageId === undefined
      ? event.data.clientMessageId === undefined
      : event.data.clientMessageId === clientMessageId)
  );
  if (receiptIndex < 0) return { events: rootEvents };

  const nextReceiptIndex = rootEvents.findIndex((event, index) =>
    index > receiptIndex &&
    event.type === "message.received" &&
    event.data.turnId === turnId
  );
  if (nextReceiptIndex < 0) return { events: rootEvents.slice(receiptIndex) };
  return {
    events: rootEvents.slice(receiptIndex, nextReceiptIndex),
    ...(eventTimestamp(rootEvents[nextReceiptIndex]) !== undefined
      ? { settledAt: eventTimestamp(rootEvents[nextReceiptIndex]) }
      : {}),
  };
}

function assistantSegmentClientMessageId(
  message: EveMessage,
  turnId: string,
): string | undefined {
  const prefix = `${turnId}:assistant:`;
  return message.id.startsWith(prefix) ? message.id.slice(prefix.length) || undefined : undefined;
}

function toProxiedInputPart(request: InputRequest): EveDynamicToolPart {
  return {
    approval: { id: request.requestId },
    input: request.action.input,
    state: "approval-requested",
    toolCallId: request.action.callId,
    toolMetadata: {
      eve: {
        inputRequest: {
          allowFreeform: request.allowFreeform,
          display: request.display,
          kind: request.kind,
          options: request.options,
          prompt: request.prompt,
          requestId: request.requestId,
        },
        kind: "tool-call",
        name: request.action.toolName,
      },
    },
    toolName: request.action.toolName,
    type: "dynamic-tool",
  };
}

function finalDeliveryStepIndex(
  events: readonly MessageStreamEvent[],
  message: EveMessage,
  status: AgentTurnStatus,
): number | undefined {
  const completedDeliveries = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) =>
      event.type === "message.completed" &&
      event.data.message !== null &&
      event.data.finishReason !== "tool-calls",
    )
    .reverse();
  for (const candidate of completedDeliveries) {
    if (candidate.event.type !== "message.completed") continue;
    const candidateStep = candidate.event.data.stepIndex;
    // A model can narrate before moving to a later tool step. Until the
    // terminal delivery arrives, that narration belongs in the execution
    // process; treating it as final makes the tool card jump ahead of it.
    const hasLaterExecution = events.slice(candidate.index + 1).some((event) =>
      (event.type === "step.started" && event.data.stepIndex > candidateStep) ||
      event.type === "actions.requested" ||
      event.type === "action.input.partial" ||
      event.type === "action.result" ||
      event.type === "input.requested",
    );
    if (!hasLaterExecution) return candidateStep;
  }
  if (status !== "running") return undefined;

  const latestExecutionStep = events.reduce((latest, event) => {
    if (
      event.type === "step.started" ||
      event.type === "actions.requested" ||
      event.type === "action.input.partial" ||
      event.type === "action.result" ||
      event.type === "input.requested"
    ) return Math.max(latest, event.data.stepIndex);
    return latest;
  }, -1);
  const latestText = [...message.parts].reverse().find((part) => part.type === "text");
  return latestText?.type === "text" && (latestText.stepIndex ?? 0) > latestExecutionStep
    ? latestText.stepIndex
    : undefined;
}

function eventTurnId(event: MessageStreamEvent): string | undefined {
  if (!("data" in event) || !event.data || typeof event.data !== "object") return undefined;
  return "turnId" in event.data && typeof event.data.turnId === "string"
    ? event.data.turnId
    : undefined;
}

function eventTimestamp(event: MessageStreamEvent | undefined): number | undefined {
  const timestamp = event?.meta?.at;
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type TurnDisplayCoordinates = {
  readonly finalTurn: boolean;
  readonly rootTurnId: string;
  readonly stepOffset: number;
};

function turnDisplayCoordinates(
  events: readonly MessageStreamEvent[],
): ReadonlyMap<string, TurnDisplayCoordinates> {
  const turnIds = events.flatMap((event) => event.type === "turn.started" ? [event.data.turnId] : []);
  const userTurns = new Set(events.flatMap((event) => event.type === "message.received" ? [event.data.turnId] : []));
  // A turn without `message.received` is only a visual continuation when Eve
  // explicitly parked for HITL input immediately before it. Treating every
  // unanchored turn as a continuation merges independent turns after a partial
  // checkpoint and makes their steps/reasoning appear to disappear.
  const continuations = continuationTurnIds(events, userTurns);
  const preliminary = new Map<string, Omit<TurnDisplayCoordinates, "finalTurn">>();
  let rootTurnId: string | undefined;
  let nextStepOffset = 0;
  for (const turnId of turnIds) {
    if (!rootTurnId || userTurns.has(turnId) || !continuations.has(turnId)) {
      rootTurnId = turnId;
      nextStepOffset = 0;
    }
    preliminary.set(turnId, { rootTurnId, stepOffset: nextStepOffset });
    const maximumStepIndex = events.reduce((maximum, event) => {
      const stepIndex = eventStepIndex(event);
      return eventTurnId(event) === turnId && stepIndex !== undefined
        ? Math.max(maximum, stepIndex)
        : maximum;
    }, -1);
    nextStepOffset += maximumStepIndex + 1;
  }

  const finalTurns = new Map<string, string>();
  for (const [turnId, coordinates] of preliminary) finalTurns.set(coordinates.rootTurnId, turnId);
  return new Map([...preliminary].map(([turnId, coordinates]) => [turnId, {
    ...coordinates,
    finalTurn: finalTurns.get(coordinates.rootTurnId) === turnId,
  }]));
}

function remapEventCoordinates(
  event: MessageStreamEvent,
  rootTurnId: string,
  stepOffset: number,
): MessageStreamEvent {
  if (!("data" in event) || !event.data || typeof event.data !== "object") return event;
  const data = event.data as Record<string, unknown>;
  const remapped = {
    ...data,
    ...(typeof data.turnId === "string" ? { turnId: rootTurnId } : {}),
    ...(typeof data.stepIndex === "number" ? { stepIndex: data.stepIndex + stepOffset } : {}),
  };
  return { ...event, data: remapped } as MessageStreamEvent;
}

function eventStepIndex(event: MessageStreamEvent): number | undefined {
  if (!("data" in event) || !event.data || typeof event.data !== "object") return undefined;
  return "stepIndex" in event.data && typeof event.data.stepIndex === "number"
    ? event.data.stepIndex
    : undefined;
}

function remapAssistantMessage(
  message: EveMessage,
  rootTurnId: string,
  stepOffset: number,
): EveMessage {
  const sourceTurnId = message.metadata?.turnId;
  const segmentPrefix = sourceTurnId ? `${sourceTurnId}:assistant:` : undefined;
  const segmentId = segmentPrefix && message.id.startsWith(segmentPrefix)
    ? message.id.slice(segmentPrefix.length)
    : undefined;
  return {
    ...message,
    id: segmentId ? `${rootTurnId}:assistant:${segmentId}` : `${rootTurnId}:assistant`,
    metadata: { ...message.metadata, turnId: rootTurnId },
    parts: message.parts.map((part) =>
      "stepIndex" in part && typeof part.stepIndex === "number"
        ? { ...part, stepIndex: part.stepIndex + stepOffset }
        : part),
  };
}

function mergeAssistantMessages(left: EveMessage, right: EveMessage): EveMessage {
  const parts = [...left.parts];
  for (const part of right.parts) {
    if (part.type === "dynamic-tool") {
      const existing = parts.findIndex((candidate) =>
        candidate.type === "dynamic-tool" && candidate.toolCallId === part.toolCallId
      );
      if (existing >= 0) {
        parts[existing] = part;
        continue;
      }
    }
    if (part.type === "reasoning" && part.stepIndex !== undefined) {
      const existing = parts.findIndex((candidate) =>
        candidate.type === "reasoning" && candidate.stepIndex === part.stepIndex,
      );
      if (existing >= 0) {
        // Same-turn continuation/retry snapshots can carry the same logical
        // reasoning step more than once. Keep one part; the event projection
        // supplies the authoritative text for the current attempt.
        parts[existing] = part;
        continue;
      }
    }
    parts.push(part);
  }
  return {
    ...left,
    metadata: {
      ...left.metadata,
      status: right.metadata?.status ?? left.metadata?.status,
    },
    parts,
  };
}

function modelOutputBoundaryTime(
  events: readonly MessageStreamEvent[],
): number | undefined {
  const boundary = events.find((event) =>
    event.type === "reasoning.appended" ||
    event.type === "reasoning.completed" ||
    event.type === "message.appended" ||
    event.type === "message.completed" ||
    event.type === "actions.requested" ||
    event.type === "step.failed"
  );
  return eventTimestamp(boundary);
}

function subagentTask(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const message = "message" in input ? input.message : undefined;
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
}
