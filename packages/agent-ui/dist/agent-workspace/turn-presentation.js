const MAX_DURABLE_STEP_RETRIES = 3;
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
    const terminalFailure = stepIndex === maximumTurnStepIndex
        ? [...events].reverse().find((event) => event.type === "turn.failed" && event.data.turnId === turnId)
        : undefined;
    const latestFailure = failures.at(-1);
    const retryAttempt = Math.max(starts.length - 1, latestFailure && !terminalFailure && !completed ? failures.length : 0);
    const latestStartIndex = stepEvents.findLastIndex((event) => event.type === "step.started");
    const latestAttemptEvents = latestStartIndex >= 0 ? stepEvents.slice(latestStartIndex) : stepEvents;
    const latestAttemptFailed = latestAttemptEvents.some((event) => event.type === "step.failed");
    const endedAt = latestAttemptFailed && !completed && !terminalFailure
        ? undefined
        : modelOutputBoundaryTime(latestAttemptEvents) ?? eventTimestamp(completed ?? terminalFailure);
    return {
        ...(endedAt ? { endedAt } : {}),
        ...(retryAttempt > 0
            ? {
                retry: {
                    attempt: Math.min(retryAttempt, MAX_DURABLE_STEP_RETRIES),
                    ...(latestFailure?.type === "step.failed"
                        ? { error: { code: latestFailure.data.code, message: latestFailure.data.message } }
                        : {}),
                    maximum: MAX_DURABLE_STEP_RETRIES,
                },
            }
            : {}),
        ...(eventTimestamp(starts.at(-1)) ? { startedAt: eventTimestamp(starts.at(-1)) } : {}),
        status: terminalFailure
            ? "failed"
            : completed || endedAt
                ? "completed"
                : "running",
    };
}
export function presentAgentTurn(message, events, closedInputRequestIds = new Set()) {
    if (message.role !== "assistant" || !message.metadata?.turnId)
        return undefined;
    const turnId = message.metadata.turnId;
    const segment = eventsForAssistantSegment(message, events);
    const turnEvents = segment.events;
    const pendingIds = new Set(unresolvedInputRequests(events, closedInputRequestIds).map((request) => request.requestId));
    const pendingRequests = turnEvents
        .flatMap((event) => event.type === "input.requested" ? event.data.requests : [])
        .filter((request) => pendingIds.has(request.requestId));
    const firstAction = turnEvents.find((event) => event.type === "actions.requested");
    const hasTools = firstAction !== undefined || pendingRequests.length > 0 || message.parts.some((part) => part.type === "dynamic-tool");
    if (!hasTools)
        return undefined;
    const terminal = [...turnEvents].reverse().find((event) => event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled");
    const status = pendingRequests.length > 0
        ? "waiting"
        : terminal?.type === "turn.completed"
            ? "completed"
            : terminal?.type === "turn.failed"
                ? "failed"
                : terminal?.type === "turn.cancelled"
                    ? "cancelled"
                    : segment.settledAt !== undefined
                        ? "completed"
                        : "running";
    const finalStepIndex = finalDeliveryStepIndex(turnEvents, message, status);
    let finalPart;
    const processParts = [];
    for (const part of message.parts) {
        if (part.type === "text" && part.stepIndex === finalStepIndex) {
            finalPart = part;
            continue;
        }
        processParts.push(part);
    }
    return {
        endedAt: eventTimestamp(terminal) ?? segment.settledAt,
        finalPart,
        proxiedInputParts: pendingRequests
            .filter((request) => !message.parts.some((part) => part.type === "dynamic-tool" && part.approval?.id === request.requestId))
            .map(toProxiedInputPart),
        processParts,
        startedAt: eventTimestamp(firstAction),
        status,
        ...(pendingRequests[0]?.kind ? { waitingFor: pendingRequests[0].kind } : {}),
    };
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
        if (event.type === "session.completed" || event.type === "session.failed") {
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
    if (events.at(-1)?.type === "session.waiting")
        return true;
    const startedIndex = events.findLastIndex((event) => event.type === "turn.started");
    if (startedIndex < 0)
        return false;
    const started = events[startedIndex];
    if (started?.type !== "turn.started")
        return false;
    return events.slice(startedIndex + 1).some((event) => (event.type === "turn.completed" || event.type === "turn.cancelled") &&
        event.data.turnId === started.data.turnId);
}
export function failureForTurn(events, turnId) {
    if (!turnId)
        return undefined;
    const event = [...events].reverse().find((candidate) => (candidate.type === "turn.failed" || candidate.type === "step.failed") &&
        candidate.data.turnId === turnId);
    return event?.type === "turn.failed" || event?.type === "step.failed"
        ? { code: event.data.code, message: event.data.message }
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
            endedAt: eventTimestamp(parentCancellation),
            name: started?.type === "subagent.called" ? started.data.name : undefined,
            startedAt: eventTimestamp(started),
            status: "cancelled",
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
    const completedDelivery = [...events].reverse().find((event) => event.type === "message.completed" &&
        event.data.message !== null &&
        event.data.finishReason !== "tool-calls");
    if (completedDelivery?.type === "message.completed")
        return completedDelivery.data.stepIndex;
    if (status !== "running")
        return undefined;
    const latestActionStep = events.reduce((latest, event) => event.type === "actions.requested" ? Math.max(latest, event.data.stepIndex) : latest, -1);
    const latestText = [...message.parts].reverse().find((part) => part.type === "text");
    return latestText?.type === "text" && (latestText.stepIndex ?? 0) > latestActionStep
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
    const preliminary = new Map();
    let rootTurnId;
    let nextStepOffset = 0;
    for (const turnId of turnIds) {
        if (!rootTurnId || userTurns.has(turnId)) {
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