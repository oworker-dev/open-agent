export function mergeSubagentSessions(events, durable = []) {
    const projected = presentSubagentSessions(events);
    const bySession = new Map(durable.map((child) => [child.childSessionId, child]));
    const merged = projected.map((session) => {
        const durableSession = session.childSessionId ? bySession.get(session.childSessionId) : undefined;
        if (!durableSession)
            return session;
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
        if (known.has(child.childSessionId))
            continue;
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
function durableStatus(status) {
    if (status === "interrupted" || status === "closed")
        return "cancelled";
    return status;
}
export function classifyAgentFailure(failure) {
    const code = failure.code.toLocaleLowerCase();
    const message = failure.message.toLocaleLowerCase();
    const value = `${code} ${message}`;
    if (/timeout|timed out|deadline|\b408\b|\b504\b/u.test(value))
        return "timeout";
    if (/network|fetch|socket|connection reset|connection refused|econn|dns|chunked encoding/u.test(value))
        return "network";
    if (/provider|model|rate.?limit|\b429\b|overload|upstream|quota|\b5(?:00|02|03)\b|stream.?interrupted|stream.?ended/u.test(value))
        return "provider";
    return "unknown";
}
export function stableUserMessageId(sourceId, turnId, stableRoot) {
    const prefix = `${turnId}:user`;
    if (sourceId === prefix)
        return `${stableRoot}:user`;
    if (sourceId.startsWith(`${prefix}:`)) {
        return `${stableRoot}:user:${sourceId.slice(prefix.length + 1)}`;
    }
    return sourceId;
}
export function activeTurnIdAfterPendingSubmission(events, pendingTurn) {
    const startedIndex = events.findLastIndex((event) => event.type === "turn.started");
    if (startedIndex < 0)
        return undefined;
    const started = events[startedIndex];
    if (started?.type !== "turn.started")
        return undefined;
    const turnId = started.data.turnId;
    const settled = events.some((event) => (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") &&
        event.data.turnId === turnId);
    if (settled)
        return undefined;
    const submissionIndex = pendingTurn.eventCountAtSubmission;
    if (submissionIndex !== undefined && events.length >= submissionIndex) {
        return startedIndex >= submissionIndex ? turnId : undefined;
    }
    const eventAt = started.meta.at ? Date.parse(started.meta.at) : Number.NaN;
    return Number.isFinite(eventAt) && eventAt >= pendingTurn.submittedAt - 1_000
        ? turnId
        : undefined;
}
export const INTERRUPTED_TOOL_ERROR = "Open Agent: tool call cancelled before completion.";
export const CANCELLING_TOOL_ERROR = "Open Agent: tool call cancellation is pending.";
export const INCOMPLETE_TOOL_ERROR = "Open Agent: tool call did not complete.";
export function isInterruptedToolPart(part) {
    return part.state === "output-error" && part.errorText === INTERRUPTED_TOOL_ERROR;
}
export function isCancellationPendingToolPart(part) {
    return part.state === "output-error" && part.errorText === CANCELLING_TOOL_ERROR;
}
function isLocalInterruptedBoundary(event) {
    return event.type === "turn.cancelled" && event.meta?.id?.startsWith("local-interrupt-") === true;
}
export function sanitizeSettledThreadEvents(events) {
    const anchoredTurns = new Set(events.flatMap((event) => event.type === "message.received" ? [event.data.turnId] : []));
    const startedTurns = new Set(events.flatMap((event) => event.type === "turn.started" ? [event.data.turnId] : []));
    const continuationTurns = continuationTurnIds(events, anchoredTurns);
    const orphanTurns = new Set();
    if (anchoredTurns.size > 0) {
        for (const event of events) {
            const turnId = eventTurnId(event);
            if (turnId && !anchoredTurns.has(turnId) && !startedTurns.has(turnId) && !continuationTurns.has(turnId)) {
                orphanTurns.add(turnId);
            }
        }
    }
    const terminalTurns = new Set();
    const cancelledTurns = new Set();
    const completedCalls = new Set();
    const lastPartialIndex = new Map();
    for (const [index, event] of events.entries()) {
        if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
            terminalTurns.add(event.data.turnId);
            if (event.type === "turn.cancelled")
                cancelledTurns.add(event.data.turnId);
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
        if (turnId && orphanTurns.has(turnId))
            return false;
        if (event.type !== "action.input.partial" || !terminalTurns.has(event.data.turnId) || cancelledTurns.has(event.data.turnId))
            return true;
        const key = `${event.data.turnId}:${event.data.callId}`;
        return completedCalls.has(key) && lastPartialIndex.get(key) === index;
    });
    const stepEvidence = new Set();
    for (const event of filtered) {
        const turnId = eventTurnId(event);
        const stepIndex = eventStepIndex(event);
        if (!turnId || stepIndex === undefined)
            continue;
        if (event.type !== "step.started" &&
            event.type !== "turn.completed" &&
            event.type !== "turn.failed" &&
            event.type !== "turn.cancelled")
            stepEvidence.add(`${turnId}:${stepIndex}`);
    }
    const normalized = filtered.filter((event) => {
        if (event.type !== "step.started" || !terminalTurns.has(event.data.turnId))
            return true;
        return stepEvidence.has(`${event.data.turnId}:${event.data.stepIndex}`);
    });
    const compacted = [];
    for (const event of normalized) {
        if (event.type === "message.appended" || event.type === "reasoning.appended") {
            const last = compacted.at(-1);
            if (last?.type === event.type &&
                last.data.turnId === event.data.turnId &&
                last.data.stepIndex === event.data.stepIndex) {
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
function continuationTurnIds(events, anchoredTurns) {
    const continuation = new Set();
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
export function normalizeSettledAgentMessages(messages, events) {
    const terminalTurns = new Map();
    for (const event of events) {
        if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
            terminalTurns.set(event.data.turnId, event.type === "turn.completed"
                ? "completed"
                : event.type === "turn.failed"
                    ? "failed"
                    : isLocalInterruptedBoundary(event) ? "cancelling" : "cancelled");
        }
    }
    return messages.map((message) => {
        if (message.role !== "assistant" || !message.metadata?.turnId)
            return message;
        const messageTurnId = message.metadata.turnId;
        const terminal = terminalTurns.get(messageTurnId);
        if (!terminal)
            return message;
        const segmentEvents = eventsForAssistantSegment(message, events).events;
        const segmentCompletedResults = new Map();
        const segmentPartialToolInputs = new Map();
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
        const parts = message.parts.flatMap((part) => {
            if (part.type !== "dynamic-tool" || !isOpenToolPart(part))
                return [part];
            const completed = segmentCompletedResults.get(part.toolCallId);
            changed = true;
            if (!completed) {
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
                        }];
                }
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
                    }];
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
                }];
        });
        const cleanedParts = [];
        const markerIndexByStep = new Map();
        const partialsForMessage = [...segmentPartialToolInputs.values()];
        let markerStepIndex = 0;
        for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index];
            if (part.type !== "step-start") {
                if ((part.type === "text" || part.type === "reasoning") && part.state === "streaming") {
                    changed = true;
                    cleanedParts.push({ ...part, state: "done" });
                }
                else {
                    cleanedParts.push(part);
                }
                continue;
            }
            const nextStep = parts.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.type === "step-start");
            const end = nextStep < 0 ? parts.length : nextStep;
            const hasContent = parts.slice(index + 1, end).some((candidate) => candidate.type !== "step-start");
            const hasPartialInput = partialsForMessage.some((partial) => partial.data.stepIndex === markerStepIndex);
            if (hasContent || hasPartialInput) {
                markerIndexByStep.set(markerStepIndex, cleanedParts.length);
                cleanedParts.push(part);
            }
            else
                changed = true;
            markerStepIndex += 1;
        }
        const visibleToolCallIds = new Set(cleanedParts.flatMap((part) => part.type === "dynamic-tool" ? [part.toolCallId] : []));
        const syntheticByStep = new Map();
        for (const partial of partialsForMessage) {
            if (visibleToolCallIds.has(partial.data.callId))
                continue;
            changed = true;
            visibleToolCallIds.add(partial.data.callId);
            const synthetic = {
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
        for (const [stepIndex, retryParts] of failedRetryToolParts(segmentEvents, messageTurnId, visibleToolCallIds)) {
            changed = true;
            const stepParts = syntheticByStep.get(stepIndex) ?? [];
            stepParts.push(...retryParts);
            syntheticByStep.set(stepIndex, stepParts);
        }
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
function failedRetryToolParts(events, turnId, visibleToolCallIds) {
    const attempts = [];
    let current;
    for (const event of events) {
        if (eventTurnId(event) !== turnId)
            continue;
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
            if (!current || current.stepIndex !== event.data.stepIndex)
                continue;
            current.failure = { code: event.data.code, message: event.data.message };
        }
    }
    const failedAttempts = attempts.filter((attempt) => attempt.failure && attempt.actions.length > 0);
    if (failedAttempts.length === 0)
        return new Map();
    const completedCallIds = new Set(events.flatMap((event) => event.type === "action.result" && event.data.status === "completed"
        ? [event.data.result.callId]
        : []));
    const lastFailedAttemptByCall = new Map();
    failedAttempts.forEach((attempt, index) => {
        for (const action of attempt.actions)
            lastFailedAttemptByCall.set(action.callId, index);
    });
    const byStep = new Map();
    failedAttempts.forEach((attempt, attemptIndex) => {
        for (const action of attempt.actions) {
            if (visibleToolCallIds.has(action.callId) &&
                !completedCallIds.has(action.callId) &&
                lastFailedAttemptByCall.get(action.callId) === attemptIndex)
                continue;
            const toolName = "toolName" in action && typeof action.toolName === "string"
                ? action.toolName
                : "subagentName" in action && typeof action.subagentName === "string"
                    ? action.subagentName
                    : "tool";
            const stepParts = byStep.get(attempt.stepIndex) ?? [];
            stepParts.push({
                errorText: attempt.failure.message,
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
function incompleteToolError(events, turnId, part) {
    const result = [...events].reverse().find((event) => event.type === "action.result" &&
        event.data.turnId === turnId &&
        event.data.result.callId === part.toolCallId &&
        event.data.status !== "completed");
    if (result?.type === "action.result" && result.data.error?.message) {
        return result.data.error.message;
    }
    const stepFailure = [...events].reverse().find((event) => event.type === "step.failed" &&
        event.data.turnId === turnId &&
        (part.stepIndex === undefined || event.data.stepIndex === part.stepIndex));
    if (stepFailure?.type === "step.failed")
        return stepFailure.data.message;
    const turnFailure = [...events].reverse().find((event) => event.type === "turn.failed" && event.data.turnId === turnId);
    if (turnFailure?.type === "turn.failed")
        return turnFailure.data.message;
    return INCOMPLETE_TOOL_ERROR;
}
function isOpenToolPart(part) {
    return part.state === "input-streaming" ||
        part.state === "input-available" ||
        (part.state === "output-available" && part.partial === true);
}
const MAX_DURABLE_STEP_RETRIES = 3;
function shouldPresentRetryFailure(failure) {
    const category = classifyAgentFailure(failure);
    if (category === "unknown")
        return false;
    const value = `${failure.code} ${failure.message}`.toLocaleLowerCase();
    return !/\b(?:401|403|unauthori[sz]ed|forbidden|rejected|invalid[_ -]?request)\b/u.test(value);
}
export function shouldSuppressInterruptedTurnDisplayEvent(event, eventIndex, turns) {
    return shouldSuppressInterruptedTurnEvent(event, turns, (turn) => eventIndex >= turn.eventCount);
}
export function shouldSuppressInterruptedTurnStreamEvent(event, streamIndex, turns) {
    return shouldSuppressInterruptedTurnEvent(event, turns, (turn) => streamIndex >= turn.streamIndex);
}
function shouldSuppressInterruptedTurnEvent(event, turns, isAfterCancellation) {
    if (event.type === "message.received" ||
        event.type === "turn.cancelled" ||
        event.type === "turn.started")
        return false;
    const turnId = eventTurnId(event);
    if (!turnId)
        return false;
    const interrupted = turns.find((turn) => turn.turnId === turnId);
    return Boolean(interrupted && interrupted.settled !== false && isAfterCancellation(interrupted));
}
export function projectAgentDisplayTimeline(messages, events) {
    const turns = turnDisplayCoordinates(events);
    if (turns.size === 0)
        return { events, messages };
    const projectedEvents = [];
    let latestSourceTerminalTurnId;
    for (const event of events) {
        if (event.type === "session.waiting") {
            const coordinates = latestSourceTerminalTurnId ? turns.get(latestSourceTerminalTurnId) : undefined;
            if (coordinates && !coordinates.finalTurn)
                continue;
            projectedEvents.push(event);
            continue;
        }
        const sourceTurnId = eventTurnId(event);
        const coordinates = sourceTurnId ? turns.get(sourceTurnId) : undefined;
        if (!coordinates) {
            projectedEvents.push(event);
            continue;
        }
        if ((event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") &&
            !coordinates.finalTurn) {
            latestSourceTerminalTurnId = sourceTurnId;
            continue;
        }
        if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
            latestSourceTerminalTurnId = sourceTurnId;
        }
        projectedEvents.push(remapEventCoordinates(event, coordinates.rootTurnId, coordinates.stepOffset));
    }
    const projectedMessages = [];
    const assistantByRoot = new Map();
    for (const message of messages) {
        if (message.role !== "assistant" || !message.metadata?.turnId) {
            if (message.role === "user" && message.metadata?.turnId) {
                const coordinates = turns.get(message.metadata.turnId);
                if (coordinates)
                    assistantByRoot.delete(coordinates.rootTurnId);
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
        if (existing?.role !== "assistant")
            continue;
        projectedMessages[existingIndex] = mergeAssistantMessages(existing, remapped);
    }
    return { events: projectedEvents, messages: projectedMessages };
}
export function presentAgentStep(events, turnId, stepIndex) {
    if (!turnId)
        return { status: "running" };
    const stepEvents = events.filter((event) => eventTurnId(event) === turnId &&
        eventStepIndex(event) === stepIndex);
    const starts = stepEvents.filter((event) => event.type === "step.started");
    const failures = stepEvents.filter((event) => event.type === "step.failed");
    const completed = [...stepEvents].reverse().find((event) => event.type === "step.completed");
    const maximumTurnStepIndex = events.reduce((maximum, event) => eventTurnId(event) === turnId
        ? Math.max(maximum, eventStepIndex(event) ?? -1)
        : maximum, -1);
    const terminalFailureEvent = stepIndex === maximumTurnStepIndex
        ? [...events].reverse().find((event) => event.type === "turn.failed" && event.data.turnId === turnId) ?? [...events].reverse().find((event) => event.type === "session.failed")
        : undefined;
    const terminalFailure = terminalFailureEvent
        ? {
            code: terminalFailureEvent.data.code,
            message: terminalFailureEvent.data.message,
        }
        : undefined;
    const latestFailure = failures.at(-1);
    const retryFailure = latestFailure?.type === "step.failed"
        ? { code: latestFailure.data.code, message: latestFailure.data.message }
        : terminalFailure;
    const retryableFailure = retryFailure && shouldPresentRetryFailure(retryFailure)
        ? retryFailure
        : undefined;
    const observedRetryAttempt = retryableFailure
        ? Math.max(1, failures.length)
        : undefined;
    const retryExhausted = Boolean(terminalFailure && retryableFailure);
    const retryEvents = failures.flatMap((failure, index) => {
        const candidate = { code: failure.data.code, message: failure.data.message };
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
export function reasoningContentForStep(events, turnId, stepIndex) {
    let content = "";
    let completedBlock = false;
    for (const event of events) {
        if (event.type === "step.started" &&
            (turnId === undefined || event.data.turnId === turnId) &&
            (stepIndex === undefined || event.data.stepIndex === stepIndex)) {
            content = "";
            completedBlock = false;
            continue;
        }
        if ((event.type !== "reasoning.appended" && event.type !== "reasoning.completed") ||
            (turnId !== undefined && event.data.turnId !== turnId) ||
            (stepIndex !== undefined && event.data.stepIndex !== stepIndex))
            continue;
        if (event.type === "reasoning.completed") {
            if (event.data.reasoning.trim())
                content = event.data.reasoning;
            completedBlock = true;
            continue;
        }
        if (completedBlock) {
            content = "";
            completedBlock = false;
        }
        if (event.data.reasoningSoFar.trim()) {
            content = event.data.reasoningSoFar;
        }
        else if (event.data.reasoningDelta.trim()) {
            content += event.data.reasoningDelta;
        }
    }
    return content.trim();
}
export function presentAgentTurn(message, events, closedInputRequestIds = new Set(), options = {}) {
    if (message.role !== "assistant" || !message.metadata?.turnId)
        return undefined;
    const turnId = message.metadata.turnId;
    const messageSegment = eventsForAssistantSegment(message, events);
    const turnEvents = options.mergeSameTurn
        ? eventsForRootTurn(events, turnId)
        : messageSegment.events;
    const partEvents = options.mergeSameTurn ? messageSegment.events : turnEvents;
    const pendingIds = new Set(unresolvedInputRequests(events, closedInputRequestIds).map((request) => request.requestId));
    const pendingRequests = partEvents
        .flatMap((event) => event.type === "input.requested" ? event.data.requests : [])
        .filter((request) => pendingIds.has(request.requestId));
    const firstAction = turnEvents.find((event) => event.type === "actions.requested");
    const hasTools = firstAction !== undefined || pendingRequests.length > 0 || message.parts.some((part) => part.type === "dynamic-tool");
    if (!hasTools)
        return undefined;
    const terminal = [...turnEvents].reverse().find((event) => (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled" || event.type === "session.failed") &&
        !isLocalInterruptedBoundary(event));
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
    let finalPart;
    const processParts = [];
    for (const part of orderAssistantMessageParts(message.parts, partEvents, turnId)) {
        if (part.type === "text" && part.stepIndex === finalStepIndex) {
            finalPart = part;
            continue;
        }
        processParts.push(part);
    }
    const failedStep = status === "failed" && turnEvents.some((event) => event.type === "step.failed" && event.data.turnId === turnId);
    const failedStepEvent = failedStep
        ? [...turnEvents].reverse().find((event) => event.type === "step.failed" && event.data.turnId === turnId)
        : undefined;
    const failedStepIndex = failedStepEvent?.data.stepIndex ?? (status === "failed" ? latestStepIndex(turnEvents, turnId) : undefined);
    const failedStepHasPart = failedStepIndex !== undefined && processParts.some((part) => "stepIndex" in part && part.stepIndex === failedStepIndex);
    const markerAnchored = status === "failed" && failedStepIndex !== undefined && hasStepMarkerForIndex(processParts, partEvents, turnId, failedStepIndex);
    const shouldAddFailureMarker = status === "failed" && failedStepIndex !== undefined && !failedStepHasPart && !markerAnchored;
    const displayProcessParts = shouldAddFailureMarker
        ? [...processParts, { type: "step-start" }]
        : processParts;
    const failureAnchored = status === "failed" && (failedStepHasPart || markerAnchored || shouldAddFailureMarker);
    return {
        endedAt: eventTimestamp(terminal) ?? (options.mergeSameTurn ? undefined : messageSegment.settledAt),
        finalPart,
        ...(failureAnchored ? { failureAnchored: true } : {}),
        proxiedInputParts: pendingRequests
            .filter((request) => !message.parts.some((part) => part.type === "dynamic-tool" && part.approval?.id === request.requestId))
            .map(toProxiedInputPart),
        processParts: displayProcessParts,
        startedAt: eventTimestamp(firstAction),
        status,
        ...(pendingRequests[0]?.kind ? { waitingFor: pendingRequests[0].kind } : {}),
    };
}
function orderAssistantMessageParts(parts, events, turnId) {
    if (parts.length < 2 || events.length < 2)
        return parts;
    const markerSteps = new Map();
    let previousStep = -1;
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part.type !== "step-start")
            continue;
        const nextMarker = parts.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.type === "step-start");
        const group = parts.slice(index + 1, nextMarker < 0 ? parts.length : nextMarker);
        const explicitStep = group
            .flatMap((candidate) => "stepIndex" in candidate && typeof candidate.stepIndex === "number"
            ? [candidate.stepIndex]
            : [])
            .sort((left, right) => left - right)[0];
        const nextStep = explicitStep !== undefined
            ? explicitStep
            : events.map(eventStepIndex).find((step) => step !== undefined && step > previousStep);
        if (nextStep !== undefined) {
            markerSteps.set(index, nextStep);
            previousStep = nextStep;
        }
    }
    let activeStep;
    const indexed = parts.map((part, index) => {
        if (part.type === "step-start")
            activeStep = markerSteps.get(index);
        else if ("stepIndex" in part && typeof part.stepIndex === "number")
            activeStep = part.stepIndex;
        const eventIndex = partEventIndex(part, events, turnId, activeStep);
        const eventStep = eventIndex === undefined || !Number.isInteger(eventIndex)
            ? undefined
            : eventStepIndex(events[eventIndex]);
        return {
            eventIndex,
            index,
            isMarker: part.type === "step-start",
            part,
            stepIndex: activeStep,
            sortStep: activeStep ?? eventStep,
        };
    });
    const groups = new Map();
    for (const entry of indexed) {
        if (entry.stepIndex === undefined)
            continue;
        const group = groups.get(entry.stepIndex) ?? [];
        group.push(entry);
        groups.set(entry.stepIndex, group);
    }
    const localOrder = new Map();
    for (const group of groups.values()) {
        const known = group
            .map((entry) => entry.eventIndex)
            .filter((position) => position !== undefined)
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
                .map((candidate) => candidate.eventIndex)
                .sort((left, right) => left - right)[0];
            if (entry.isMarker && firstKnown !== undefined) {
                localOrder.set(entry.index, firstKnown - 1);
            }
            else if (nextKnown !== undefined) {
                localOrder.set(entry.index, nextKnown - 0.25);
            }
            else if (lastKnown !== undefined) {
                localOrder.set(entry.index, lastKnown + 0.25 + unknownAfter++ / 100);
            }
            else {
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
    if (!hasComparablePosition)
        return parts;
    return indexed
        .toSorted((left, right) => (left.sortStep ?? Number.MAX_SAFE_INTEGER) - (right.sortStep ?? Number.MAX_SAFE_INTEGER) ||
        (localOrder.get(left.index) ?? Number.MAX_SAFE_INTEGER) - (localOrder.get(right.index) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index)
        .map((entry) => entry.part);
}
function partEventIndex(part, events, turnId, stepIndex) {
    const matchesStep = (event) => eventTurnId(event) === turnId && (stepIndex === undefined || eventStepIndex(event) === stepIndex);
    if (part.type === "step-start") {
        return firstEventIndex(events, (event) => event.type === "step.started" && matchesStep(event));
    }
    if (part.type === "reasoning") {
        const appended = firstEventIndex(events, (event) => matchesStep(event) && event.type === "reasoning.appended");
        if (appended !== undefined)
            return appended;
        const stepStarted = firstEventIndex(events, (event) => event.type === "step.started" && matchesStep(event));
        if (stepStarted !== undefined)
            return stepStarted + 0.1;
        const firstStepEvent = firstEventIndex(events, matchesStep);
        return firstStepEvent === undefined ? undefined : firstStepEvent - 0.1;
    }
    if (part.type === "text") {
        return firstEventIndex(events, (event) => matchesStep(event) && (event.type === "message.appended" || event.type === "message.completed"));
    }
    if (part.type === "dynamic-tool") {
        return firstEventIndex(events, (event) => matchesStep(event) && ((event.type === "action.input.partial" && event.data.callId === part.toolCallId) ||
            (event.type === "actions.requested" && event.data.actions.some((action) => action.callId === part.toolCallId)) ||
            (event.type === "action.result" && event.data.result.callId === part.toolCallId)));
    }
    return firstEventIndex(events, matchesStep);
}
function firstEventIndex(events, predicate) {
    const index = events.findIndex(predicate);
    return index >= 0 ? index : undefined;
}
function latestStepIndex(events, turnId) {
    return events.reduce((latest, event) => {
        if (eventTurnId(event) !== turnId)
            return latest;
        const stepIndex = eventStepIndex(event);
        return stepIndex === undefined ? latest : Math.max(latest ?? stepIndex, stepIndex);
    }, undefined);
}
function hasStepMarkerForIndex(parts, events, turnId, targetStepIndex) {
    let previousStepIndex = -1;
    for (let index = 0; index < parts.length; index += 1) {
        if (parts[index]?.type !== "step-start")
            continue;
        const nextStep = parts.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.type === "step-start");
        const stepParts = parts.slice(index + 1, nextStep < 0 ? parts.length : nextStep);
        const explicit = stepParts.find((part) => "stepIndex" in part && typeof part.stepIndex === "number");
        const stepIndex = explicit && "stepIndex" in explicit && typeof explicit.stepIndex === "number"
            ? explicit.stepIndex
            : events
                .map(eventStepIndex)
                .filter((candidate) => candidate !== undefined && candidate > previousStepIndex)
                .find((candidate) => events.some((event) => eventTurnId(event) === turnId && eventStepIndex(event) === candidate));
        if (stepIndex === undefined)
            continue;
        previousStepIndex = stepIndex;
        if (stepIndex === targetStepIndex)
            return true;
    }
    return false;
}
export function isProxiedInputOnlyMessage(message, events) {
    if (message.role !== "assistant" || !message.metadata?.turnId)
        return false;
    const turnId = message.metadata.turnId;
    if (events.some((event) => event.type === "turn.started" && event.data.turnId === turnId)) {
        return false;
    }
    const requests = events.flatMap((event) => event.type === "input.requested" && event.data.turnId === turnId
        ? event.data.requests
        : []);
    if (requests.length === 0)
        return false;
    const requestIds = new Set(requests.map((request) => request.requestId));
    return message.parts.every((part) => part.type === "step-start" ||
        (part.type === "dynamic-tool" && part.approval !== undefined && requestIds.has(part.approval.id)));
}
export function unresolvedInputRequests(events, closedInputRequestIds = new Set()) {
    let pending = new Map();
    let hasRequestedInput = false;
    for (const event of events) {
        if (event.type === "input.requested") {
            hasRequestedInput = true;
            for (const request of event.data.requests)
                pending.set(request.requestId, request);
            continue;
        }
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
export function hasUnresolvedInputRequests(events, closedInputRequestIds = new Set()) {
    return unresolvedInputRequests(events, closedInputRequestIds).length > 0;
}
export function hasSettledLatestTurn(events) {
    const startedIndex = events.findLastIndex((event) => event.type === "turn.started");
    const sessionBoundaryIndex = events.findLastIndex((event) => event.type === "session.waiting" || event.type === "session.completed" || event.type === "session.failed");
    if (sessionBoundaryIndex > startedIndex)
        return startedIndex >= 0;
    if (startedIndex < 0)
        return false;
    const started = events[startedIndex];
    if (started?.type !== "turn.started")
        return false;
    return events.slice(startedIndex + 1).some((event) => (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") &&
        event.data.turnId === started.data.turnId) || events.slice(startedIndex + 1).some((event) => event.type === "session.failed");
}
export function failureForTurn(events, turnId) {
    if (!turnId)
        return undefined;
    const event = [...events].reverse().find((candidate) => candidate.type === "turn.failed" && candidate.data.turnId === turnId);
    if (event?.type === "turn.failed") {
        return { code: event.data.code, message: event.data.message };
    }
    const startedIndex = events.findLastIndex((candidate) => candidate.type === "turn.started" && candidate.data.turnId === turnId);
    const sessionFailureIndex = events.findLastIndex((candidate) => candidate.type === "session.failed");
    const sessionFailure = sessionFailureIndex > startedIndex ? events[sessionFailureIndex] : undefined;
    return sessionFailure?.type === "session.failed"
        ? { code: sessionFailure.data.code, message: sessionFailure.data.message }
        : undefined;
}
export function eventsBeforeLastUserTurn(events) {
    const lastUserEvent = events.findLast((event) => event.type === "message.received");
    if (lastUserEvent?.type !== "message.received")
        return [];
    const turnStartIndex = events.findLastIndex((event) => event.type === "turn.started" && event.data.turnId === lastUserEvent.data.turnId);
    if (turnStartIndex >= 0)
        return events.slice(0, turnStartIndex);
    const lastUserTurnIndex = events.lastIndexOf(lastUserEvent);
    return events.slice(0, lastUserTurnIndex);
}
export function presentSubagentCall(events, callId) {
    const started = events.find((event) => event.type === "subagent.called" && event.data.callId === callId);
    const completed = [...events].reverse().find((event) => event.type === "subagent.completed" && event.data.callId === callId);
    const result = [...events].reverse().find((event) => event.type === "action.result" &&
        event.data.result.kind === "subagent-result" &&
        event.data.result.callId === callId);
    const owningTurnId = started?.type === "subagent.called" ? started.data.turnId : undefined;
    const parentCancellation = owningTurnId
        ? [...events].reverse().find((event) => event.type === "turn.cancelled" && event.data.turnId === owningTurnId)
        : undefined;
    const terminalSession = [...events].reverse().find((event) => event.type === "session.completed" || event.type === "session.failed");
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
    if (started?.type !== "subagent.called")
        return { status: "starting" };
    return {
        childSessionId: started.data.childSessionId,
        name: started.data.name,
        startedAt: eventTimestamp(started),
        status: "running",
    };
}
export function presentSubagentSessions(events) {
    const calls = events.flatMap((event) => event.type === "actions.requested"
        ? event.data.actions.filter((action) => action.kind === "subagent-call")
        : []);
    return calls.map((call) => ({
        ...presentSubagentCall(events, call.callId),
        callId: call.callId,
        task: subagentTask(call.input),
    }));
}
function eventsForRootTurn(events, turnId) {
    const start = events.findIndex((event) => event.type === "turn.started" && event.data.turnId === turnId);
    if (start < 0)
        return events.filter((event) => eventTurnId(event) === turnId);
    const next = events.findIndex((event, index) => index > start && event.type === "message.received" && event.data.turnId !== turnId);
    return events.slice(start, next < 0 ? undefined : next);
}
function eventsForAssistantSegment(message, events) {
    const turnId = message.metadata?.turnId;
    if (!turnId)
        return { events: [] };
    const rootEvents = eventsForRootTurn(events, turnId);
    const clientMessageId = assistantSegmentClientMessageId(message, turnId);
    const receiptIndex = rootEvents.findIndex((event) => event.type === "message.received" &&
        event.data.turnId === turnId &&
        (clientMessageId === undefined
            ? event.data.clientMessageId === undefined
            : event.data.clientMessageId === clientMessageId));
    if (receiptIndex < 0)
        return { events: rootEvents };
    const nextReceiptIndex = rootEvents.findIndex((event, index) => index > receiptIndex &&
        event.type === "message.received" &&
        event.data.turnId === turnId);
    if (nextReceiptIndex < 0)
        return { events: rootEvents.slice(receiptIndex) };
    return {
        events: rootEvents.slice(receiptIndex, nextReceiptIndex),
        ...(eventTimestamp(rootEvents[nextReceiptIndex]) !== undefined
            ? { settledAt: eventTimestamp(rootEvents[nextReceiptIndex]) }
            : {}),
    };
}
function assistantSegmentClientMessageId(message, turnId) {
    const prefix = `${turnId}:assistant:`;
    return message.id.startsWith(prefix) ? message.id.slice(prefix.length) || undefined : undefined;
}
function toProxiedInputPart(request) {
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
function finalDeliveryStepIndex(events, message, status) {
    const completedDeliveries = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.type === "message.completed" &&
        event.data.message !== null &&
        event.data.finishReason !== "tool-calls")
        .reverse();
    for (const candidate of completedDeliveries) {
        if (candidate.event.type !== "message.completed")
            continue;
        const candidateStep = candidate.event.data.stepIndex;
        const hasLaterExecution = events.slice(candidate.index + 1).some((event) => (event.type === "step.started" && event.data.stepIndex > candidateStep) ||
            event.type === "actions.requested" ||
            event.type === "action.input.partial" ||
            event.type === "action.result" ||
            event.type === "input.requested");
        if (!hasLaterExecution)
            return candidateStep;
    }
    if (status !== "running")
        return undefined;
    const latestExecutionStep = events.reduce((latest, event) => {
        if (event.type === "step.started" ||
            event.type === "actions.requested" ||
            event.type === "action.input.partial" ||
            event.type === "action.result" ||
            event.type === "input.requested")
            return Math.max(latest, event.data.stepIndex);
        return latest;
    }, -1);
    const latestText = [...message.parts].reverse().find((part) => part.type === "text");
    return latestText?.type === "text" && (latestText.stepIndex ?? 0) > latestExecutionStep
        ? latestText.stepIndex
        : undefined;
}
function eventTurnId(event) {
    if (!("data" in event) || !event.data || typeof event.data !== "object")
        return undefined;
    return "turnId" in event.data && typeof event.data.turnId === "string"
        ? event.data.turnId
        : undefined;
}
function eventTimestamp(event) {
    const timestamp = event?.meta?.at;
    if (!timestamp)
        return undefined;
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function turnDisplayCoordinates(events) {
    const turnIds = events.flatMap((event) => event.type === "turn.started" ? [event.data.turnId] : []);
    const userTurns = new Set(events.flatMap((event) => event.type === "message.received" ? [event.data.turnId] : []));
    const continuations = continuationTurnIds(events, userTurns);
    const preliminary = new Map();
    let rootTurnId;
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
    const finalTurns = new Map();
    for (const [turnId, coordinates] of preliminary)
        finalTurns.set(coordinates.rootTurnId, turnId);
    return new Map([...preliminary].map(([turnId, coordinates]) => [turnId, {
            ...coordinates,
            finalTurn: finalTurns.get(coordinates.rootTurnId) === turnId,
        }]));
}
function remapEventCoordinates(event, rootTurnId, stepOffset) {
    if (!("data" in event) || !event.data || typeof event.data !== "object")
        return event;
    const data = event.data;
    const remapped = {
        ...data,
        ...(typeof data.turnId === "string" ? { turnId: rootTurnId } : {}),
        ...(typeof data.stepIndex === "number" ? { stepIndex: data.stepIndex + stepOffset } : {}),
    };
    return { ...event, data: remapped };
}
function eventStepIndex(event) {
    if (!("data" in event) || !event.data || typeof event.data !== "object")
        return undefined;
    return "stepIndex" in event.data && typeof event.data.stepIndex === "number"
        ? event.data.stepIndex
        : undefined;
}
function remapAssistantMessage(message, rootTurnId, stepOffset) {
    const sourceTurnId = message.metadata?.turnId;
    const segmentPrefix = sourceTurnId ? `${sourceTurnId}:assistant:` : undefined;
    const segmentId = segmentPrefix && message.id.startsWith(segmentPrefix)
        ? message.id.slice(segmentPrefix.length)
        : undefined;
    return {
        ...message,
        id: segmentId ? `${rootTurnId}:assistant:${segmentId}` : `${rootTurnId}:assistant`,
        metadata: { ...message.metadata, turnId: rootTurnId },
        parts: message.parts.map((part) => "stepIndex" in part && typeof part.stepIndex === "number"
            ? { ...part, stepIndex: part.stepIndex + stepOffset }
            : part),
    };
}
function mergeAssistantMessages(left, right) {
    const parts = [...left.parts];
    for (const part of right.parts) {
        if (part.type === "dynamic-tool") {
            const existing = parts.findIndex((candidate) => candidate.type === "dynamic-tool" && candidate.toolCallId === part.toolCallId);
            if (existing >= 0) {
                parts[existing] = part;
                continue;
            }
        }
        if (part.type === "reasoning" && part.stepIndex !== undefined) {
            const existing = parts.findIndex((candidate) => candidate.type === "reasoning" && candidate.stepIndex === part.stepIndex);
            if (existing >= 0) {
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
function modelOutputBoundaryTime(events) {
    const boundary = events.find((event) => event.type === "reasoning.appended" ||
        event.type === "reasoning.completed" ||
        event.type === "message.appended" ||
        event.type === "message.completed" ||
        event.type === "actions.requested" ||
        event.type === "step.failed");
    return eventTimestamp(boundary);
}
function subagentTask(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input))
        return undefined;
    const message = "message" in input ? input.message : undefined;
    return typeof message === "string" && message.trim() ? message.trim() : undefined;
}
//# sourceMappingURL=turn-presentation.js.map