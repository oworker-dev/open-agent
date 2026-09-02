import { sanitizeRetainedContext } from "./retained-context.js";
export const AGENT_THREAD_STORAGE_VERSION = 2;
const EMPTY_SESSION = { streamIndex: 0 };
const eventCursors = new WeakMap();
const FALLBACK_PREFERENCES = {
    executionMode: "standard",
    modelId: "default",
    reasoning: "medium",
};
export function editOperationId(sessionId, beforeTurnId, text) {
    const input = `${sessionId.length}:${sessionId}|${beforeTurnId.length}:${beforeTurnId}|${text.length}:${text}`;
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < input.length; index += 1) {
        const code = input.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ (code + index), 0x01000193);
    }
    return `edit-${toHex(first)}${toHex(second)}`;
}
function toHex(value) {
    return (value >>> 0).toString(16).padStart(8, "0");
}
export function mergeThreadCollectionsForConflict(local, remote) {
    const byId = new Map(remote.threads.map((thread) => [thread.id, thread]));
    for (const thread of local.threads) {
        const existing = byId.get(thread.id);
        if (!existing) {
            byId.set(thread.id, thread);
            continue;
        }
        const selected = thread.updatedAt >= existing.updatedAt ? thread : existing;
        const editInProgress = thread.pendingTurn?.state === "clearing" ||
            thread.pendingTurn?.state === "resubmitting";
        const events = editInProgress
            ? thread.events
            : mergeConflictEvents(thread, existing);
        byId.set(thread.id, {
            ...selected,
            events,
            ...(events.length > 0 ? { hydration: undefined } : {}),
            session: {
                ...selected.session,
                streamIndex: Math.max(thread.session.streamIndex, existing.session.streamIndex),
            },
        });
    }
    const threads = [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
    const activeThreadId = local.activeThreadId && threads.some((thread) => thread.id === local.activeThreadId)
        ? local.activeThreadId
        : remote.activeThreadId;
    return {
        ...(activeThreadId ? { activeThreadId } : {}),
        threads,
        version: AGENT_THREAD_STORAGE_VERSION,
    };
}
function mergeConflictEvents(local, remote) {
    const localEvents = local.events;
    const remoteEvents = remote.events;
    if (remoteEvents.length === 0)
        return localEvents;
    if (localEvents.length === 0)
        return remoteEvents;
    return mergeThreadEventSnapshots(localEvents, remoteEvents);
}
export const browserThreadStorage = {
    load: loadThreadCollection,
    save(storageKey, collection) {
        saveThreadCollection(storageKey, collection.threads, collection.activeThreadId);
    },
};
export function createAgentThread(now = Date.now(), title = "New session", preferences = FALLBACK_PREFERENCES) {
    return {
        createdAt: now,
        closedInputRequestIds: [],
        events: [],
        id: createId(),
        preferences: { ...preferences },
        queuedTurns: [],
        revision: 0,
        session: EMPTY_SESSION,
        status: "ready",
        title,
        updatedAt: now,
    };
}
export function loadThreadCollection(storageKey) {
    if (typeof window === "undefined") {
        return { threads: [], version: AGENT_THREAD_STORAGE_VERSION };
    }
    try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw)
            return { threads: [], version: AGENT_THREAD_STORAGE_VERSION };
        return parseThreadCollection(JSON.parse(raw));
    }
    catch {
        return { threads: [], version: AGENT_THREAD_STORAGE_VERSION };
    }
}
export function parseThreadCollection(value) {
    if (!isRecord(value) ||
        (value.version !== 1 && value.version !== AGENT_THREAD_STORAGE_VERSION) ||
        !Array.isArray(value.threads)) {
        return { threads: [], version: AGENT_THREAD_STORAGE_VERSION };
    }
    const threads = value.threads
        .map(parseThread)
        .filter((thread) => !!thread);
    const activeThreadId = typeof value.activeThreadId === "string" &&
        threads.some((thread) => thread.id === value.activeThreadId)
        ? value.activeThreadId
        : undefined;
    return { activeThreadId, threads, version: AGENT_THREAD_STORAGE_VERSION };
}
export function saveThreadCollection(storageKey, threads, activeThreadId) {
    if (typeof window === "undefined")
        return false;
    try {
        window.localStorage.setItem(storageKey, JSON.stringify({
            activeThreadId,
            threads,
            version: AGENT_THREAD_STORAGE_VERSION,
        }));
        return true;
    }
    catch {
        return false;
    }
}
export function titleFromPrompt(prompt) {
    const compact = prompt.replaceAll(/\s+/g, " ").trim();
    if (compact.length === 0)
        return "New session";
    return compact.length > 42 ? `${compact.slice(0, 41)}...` : compact;
}
function parseThread(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.id !== "string" || typeof value.title !== "string")
        return undefined;
    const createdAt = numberOrNow(value.createdAt);
    const updatedAt = numberOrNow(value.updatedAt);
    const preferences = isRecord(value.preferences) ? value.preferences : {};
    const session = isRecord(value.session) ? value.session : {};
    const status = isThreadStatus(value.status) ? value.status : "ready";
    const pendingTurn = parsePendingTurn(value.pendingTurn);
    const draftRestore = parseDraftRestore(value.draftRestore);
    const interruptedTurns = parseInterruptedTurns(value.interruptedTurns);
    const closedInputRequestIds = Array.isArray(value.closedInputRequestIds)
        ? [...new Set(value.closedInputRequestIds.filter((id) => typeof id === "string" && id.trim().length > 0))].slice(-128)
        : [];
    const queuedTurns = Array.isArray(value.queuedTurns)
        ? value.queuedTurns
            .map(parseQueuedTurn)
            .filter((turn) => turn !== undefined)
            .slice(0, 5)
        : [];
    const retainedContext = sanitizeRetainedContext(value.retainedContext) ?? [];
    const transcriptCoverage = parseTranscriptCoverage(value.transcriptCoverage);
    const transcriptWindow = parseTranscriptWindow(value.transcriptWindow);
    const rawEvents = Array.isArray(value.events)
        ? value.events
        : [];
    const storedStreamIndex = typeof session.streamIndex === "number" && session.streamIndex >= 0
        ? session.streamIndex
        : 0;
    return {
        createdAt,
        closedInputRequestIds,
        ...(draftRestore ? { draftRestore } : {}),
        events: compactThreadEvents(rawEvents),
        ...(value.hydration === "summary" ? { hydration: "summary" } : {}),
        id: value.id,
        ...(interruptedTurns.length > 0 ? { interruptedTurns } : {}),
        ...(pendingTurn ? { pendingTurn } : {}),
        preferences: {
            executionMode: isExecutionMode(preferences.executionMode)
                ? preferences.executionMode
                : FALLBACK_PREFERENCES.executionMode,
            modelId: nonEmptyString(preferences.modelId) ?? FALLBACK_PREFERENCES.modelId,
            reasoning: nonEmptyString(preferences.reasoning) ?? FALLBACK_PREFERENCES.reasoning,
        },
        ...(retainedContext.length > 0 ? { retainedContext } : {}),
        queuedTurns,
        revision: typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision >= 0
            ? value.revision
            : 0,
        session: {
            sessionId: typeof session.sessionId === "string" ? session.sessionId : undefined,
            streamIndex: Math.max(storedStreamIndex, rawEvents.length),
        },
        status,
        ...(transcriptCoverage ? { transcriptCoverage } : {}),
        ...(transcriptWindow ? { transcriptWindow } : {}),
        title: value.title,
        updatedAt,
    };
}
function parseTranscriptWindow(value) {
    if (!isRecord(value) ||
        typeof value.startIndex !== "number" || !Number.isSafeInteger(value.startIndex) || value.startIndex < 0 ||
        typeof value.endIndex !== "number" || !Number.isSafeInteger(value.endIndex) || value.endIndex < value.startIndex ||
        typeof value.total !== "number" || !Number.isSafeInteger(value.total) || value.total < value.endIndex ||
        typeof value.hasMoreBefore !== "boolean")
        return undefined;
    return {
        endIndex: value.endIndex,
        hasMoreBefore: value.hasMoreBefore,
        startIndex: value.startIndex,
        total: value.total,
    };
}
function parseTranscriptCoverage(value) {
    if (!isRecord(value) || value.version !== 1 ||
        typeof value.startIndex !== "number" || !Number.isSafeInteger(value.startIndex) || value.startIndex < 0 ||
        typeof value.endIndex !== "number" || !Number.isSafeInteger(value.endIndex) || value.endIndex < value.startIndex ||
        typeof value.complete !== "boolean")
        return undefined;
    return {
        ...(value.authoritative === true ? { authoritative: true } : {}),
        complete: value.complete,
        endIndex: value.endIndex,
        ...(value.projection === "logical-edits-v1" ? { projection: value.projection } : {}),
        startIndex: value.startIndex,
        version: 1,
    };
}
function parseDraftRestore(value) {
    if (!isRecord(value) ||
        typeof value.id !== "string" || !value.id ||
        typeof value.text !== "string" || !value.text.trim())
        return undefined;
    return { id: value.id, text: value.text };
}
function parseInterruptedTurns(value) {
    if (!Array.isArray(value))
        return [];
    const turns = new Map();
    for (const candidate of value) {
        if (!isRecord(candidate) ||
            typeof candidate.turnId !== "string" || !candidate.turnId ||
            typeof candidate.eventCount !== "number" ||
            !Number.isSafeInteger(candidate.eventCount) || candidate.eventCount < 0 ||
            typeof candidate.streamIndex !== "number" ||
            !Number.isSafeInteger(candidate.streamIndex) || candidate.streamIndex < 0)
            continue;
        turns.set(candidate.turnId, {
            eventCount: candidate.eventCount,
            ...(typeof candidate.settled === "boolean" ? { settled: candidate.settled } : {}),
            streamIndex: candidate.streamIndex,
            turnId: candidate.turnId,
        });
    }
    return [...turns.values()].slice(-32);
}
function parseQueuedTurn(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.id !== "string" || !value.id ||
        typeof value.text !== "string" || !value.text.trim() ||
        typeof value.submittedAt !== "number" || !Number.isFinite(value.submittedAt) ||
        (value.state !== "queued" && value.state !== "delivering" &&
            value.state !== "accepted" && value.state !== "committed" &&
            value.state !== "delivery-failed" && value.state !== "admission-ambiguous")) {
        return undefined;
    }
    const mailboxItemId = typeof value.mailboxItemId === "string" && value.mailboxItemId
        ? value.mailboxItemId
        : undefined;
    const expectedTurnId = typeof value.expectedTurnId === "string" && value.expectedTurnId
        ? value.expectedTurnId
        : undefined;
    const durableDeliveryPhase = value.state === "delivering" ||
        value.state === "accepted" || value.state === "committed";
    if (durableDeliveryPhase && (value.delivery !== "server" || !mailboxItemId)) {
        return undefined;
    }
    if (value.intent === "post-cancellation" &&
        (value.delivery !== "browser" || value.state !== "queued" || mailboxItemId)) {
        return undefined;
    }
    return {
        ...(value.delivery === "server" || value.delivery === "browser"
            ? { delivery: value.delivery }
            : {}),
        ...(expectedTurnId ? { expectedTurnId } : {}),
        id: value.id,
        ...(value.intent === "active-turn" || value.intent === "post-cancellation"
            ? { intent: value.intent }
            : {}),
        ...(mailboxItemId ? { mailboxItemId } : {}),
        state: value.state,
        submittedAt: value.submittedAt,
        text: value.text,
    };
}
function parsePendingTurn(value) {
    if (!isRecord(value))
        return undefined;
    const files = parsePromptFiles(value.files);
    if (typeof value.id !== "string" || !value.id ||
        typeof value.text !== "string" || (!value.text.trim() && files.length === 0) ||
        typeof value.submittedAt !== "number" || !Number.isFinite(value.submittedAt) ||
        (value.state !== "clearing" && value.state !== "submitting" && value.state !== "resubmitting" && value.state !== "delivery-failed" && value.state !== "interrupted")) {
        return undefined;
    }
    const beforeTurnId = typeof value.beforeTurnId === "string" && value.beforeTurnId
        ? value.beforeTurnId
        : undefined;
    const mailboxItemId = typeof value.mailboxItemId === "string" && value.mailboxItemId
        ? value.mailboxItemId
        : undefined;
    if (value.operation === "edit" && (!beforeTurnId || value.delivery !== "server")) {
        return undefined;
    }
    return {
        ...(beforeTurnId ? { beforeTurnId } : {}),
        ...(value.delivery === "browser" || value.delivery === "server"
            ? { delivery: value.delivery }
            : {}),
        ...(typeof value.eventCountAtSubmission === "number" && Number.isInteger(value.eventCountAtSubmission) && value.eventCountAtSubmission >= 0
            ? { eventCountAtSubmission: value.eventCountAtSubmission }
            : {}),
        ...(files.length > 0 ? { files } : {}),
        id: value.id,
        ...(mailboxItemId ? { mailboxItemId } : {}),
        ...(value.operation === "edit" || value.operation === "send"
            ? { operation: value.operation }
            : {}),
        state: value.state,
        submittedAt: value.submittedAt,
        text: value.text,
    };
}
function parsePromptFiles(value) {
    if (!Array.isArray(value))
        return [];
    return value.slice(0, MAX_PENDING_FILES).flatMap((candidate) => {
        if (!isRecord(candidate) ||
            typeof candidate.mediaType !== "string" || !candidate.mediaType ||
            typeof candidate.url !== "string" || !candidate.url)
            return [];
        return [{
                ...(typeof candidate.filename === "string" && candidate.filename
                    ? { filename: candidate.filename.slice(0, 512) }
                    : {}),
                mediaType: candidate.mediaType.slice(0, 255),
                url: candidate.url,
            }];
    });
}
const MAX_PENDING_FILES = 20;
export function appendThreadEvent(events, event) {
    if (hasEventIdentity(events, event)) {
        return events;
    }
    const cumulativeKey = cumulativeEventKey(event);
    if (cumulativeKey) {
        const existingIndex = findLastCumulativeEventIndex(events, cumulativeKey);
        if (existingIndex !== undefined && canReplaceCumulativeEvent(events, existingIndex, event)) {
            return [...events.slice(0, existingIndex), event, ...events.slice(existingIndex + 1)];
        }
        return [...events, event];
    }
    if (event.type === "message.completed" || event.type === "reasoning.completed") {
        return [...events, event];
    }
    return [...events, event];
}
export function appendThreadEventIndexed(events, eventIds, event) {
    const identity = eventIdentity(event);
    if (eventIds.has(identity))
        return false;
    eventIds.add(identity);
    const cumulativeKey = cumulativeEventKey(event);
    if (cumulativeKey) {
        const cumulativeIndexes = cumulativeIndexFor(events);
        const existingIndex = cumulativeIndexes.get(cumulativeKey);
        if (existingIndex !== undefined && canReplaceCumulativeEvent(events, existingIndex, event)) {
            events[existingIndex] = event;
            return true;
        }
        cumulativeIndexes.set(cumulativeKey, events.length);
    }
    events.push(event);
    return true;
}
export function mergeThreadEventSnapshots(left, right) {
    if (left.length === 0)
        return right;
    if (right.length === 0)
        return left;
    const leftIds = new Set(left.map(eventIdentity));
    const rightIds = new Set(right.map(eventIdentity));
    if ([...rightIds].every((id) => leftIds.has(id)))
        return left;
    if ([...leftIds].every((id) => rightIds.has(id)))
        return right;
    const seen = new Set();
    const candidates = [];
    let position = 0;
    for (const event of [...left, ...right]) {
        const identity = eventIdentity(event);
        if (seen.has(identity))
            continue;
        seen.add(identity);
        candidates.push({ event, position });
        position += 1;
    }
    candidates.sort((a, b) => compareEventOrder(a.event, b.event) || a.position - b.position);
    return compactThreadEvents(candidates.map((candidate) => candidate.event));
}
function compareEventOrder(left, right) {
    const leftCursor = eventCursors.get(left);
    const rightCursor = eventCursors.get(right);
    if (leftCursor !== undefined && rightCursor !== undefined && leftCursor !== rightCursor) {
        return leftCursor - rightCursor;
    }
    const leftSequence = eventSequence(left);
    const rightSequence = eventSequence(right);
    if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
    }
    const leftStep = eventStepIndex(left);
    const rightStep = eventStepIndex(right);
    if (leftStep !== undefined && rightStep !== undefined && leftStep !== rightStep) {
        return leftStep - rightStep;
    }
    const leftAt = eventTimestamp(left);
    const rightAt = eventTimestamp(right);
    if (leftAt !== undefined && rightAt !== undefined && leftAt !== rightAt) {
        return leftAt - rightAt;
    }
    return eventLifecycleRank(left) - eventLifecycleRank(right);
}
function eventSequence(event) {
    const value = event.data?.sequence;
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
function eventStepIndex(event) {
    const value = event.data?.stepIndex;
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
function eventTimestamp(event) {
    const value = event.meta?.at;
    if (typeof value !== "string")
        return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
}
function eventLifecycleRank(event) {
    switch (event.type) {
        case "session.started": return -2;
        case "session.waiting":
        case "session.completed":
        case "session.failed": return 100;
        case "turn.started": return 0;
        case "message.received": return 1;
        case "context.cleared": return 1;
        case "step.started": return 2;
        case "reasoning.appended":
        case "reasoning.completed":
        case "message.appended":
        case "message.completed":
        case "action.input.partial":
        case "actions.requested":
        case "input.requested":
        case "authorization.required":
        case "model.retrying": return 3;
        case "action.partial":
        case "action.result":
        case "authorization.completed": return 4;
        case "step.completed":
        case "step.failed": return 5;
        case "turn.completed":
        case "turn.failed":
        case "turn.cancelled": return 6;
        default: return 50;
    }
}
const cumulativeIndexesByEvents = new WeakMap();
function cumulativeIndexFor(events) {
    const existing = cumulativeIndexesByEvents.get(events);
    if (existing)
        return existing;
    const indexes = new Map();
    for (let index = 0; index < events.length; index += 1) {
        const key = cumulativeEventKey(events[index]);
        if (key)
            indexes.set(key, index);
    }
    cumulativeIndexesByEvents.set(events, indexes);
    return indexes;
}
function findLastCumulativeEventIndex(events, key) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (cumulativeEventKey(events[index]) === key)
            return index;
    }
    return undefined;
}
export function eventIdentity(event) {
    if (typeof event.meta?.id === "string" && event.meta.id.length > 0) {
        return `id:${event.meta.id}`;
    }
    return `event:${JSON.stringify(event)}`;
}
export function rememberThreadEventCursor(event, cursor) {
    if (Number.isSafeInteger(cursor) && cursor >= 0 && event && typeof event === "object") {
        eventCursors.set(event, cursor);
    }
}
function hasEventIdentity(events, event) {
    const identity = eventIdentity(event);
    return events.some((candidate) => eventIdentity(candidate) === identity);
}
export function compactThreadEvents(events) {
    const compacted = [];
    const identities = new Set();
    const cumulativeIndexes = new Map();
    for (const event of events) {
        const identity = eventIdentity(event);
        if (identities.has(identity))
            continue;
        identities.add(identity);
        const cumulativeKey = cumulativeEventKey(event);
        if (cumulativeKey) {
            const existingIndex = cumulativeIndexes.get(cumulativeKey);
            if (existingIndex !== undefined && canReplaceCumulativeEvent(compacted, existingIndex, event)) {
                compacted[existingIndex] = event;
                continue;
            }
            cumulativeIndexes.set(cumulativeKey, compacted.length);
        }
        compacted.push(event);
    }
    return compacted;
}
function cumulativeEventKey(event) {
    if (event.type === "message.appended" || event.type === "reasoning.appended") {
        return `${event.type}:${event.data.turnId}:${event.data.stepIndex}`;
    }
    if (event.type === "action.input.partial") {
        return `${event.type}:${event.data.turnId}:${event.data.stepIndex}:${event.data.callId}`;
    }
    return undefined;
}
function canReplaceCumulativeEvent(events, existingIndex, next) {
    const existing = events[existingIndex];
    if (!existing || !cumulativeEventKey(existing) || cumulativeEventKey(existing) !== cumulativeEventKey(next)) {
        return false;
    }
    const scope = stepScope(next);
    for (let index = existingIndex + 1; index < events.length; index += 1) {
        const candidate = events[index];
        if (candidate.type === "step.started" && stepScope(candidate) === scope) {
            return false;
        }
    }
    const previousSnapshot = cumulativeSnapshot(existing);
    const nextSnapshot = cumulativeSnapshot(next);
    if (previousSnapshot === undefined || nextSnapshot === undefined)
        return false;
    return nextSnapshot.length >= previousSnapshot.length;
}
function stepScope(event) {
    if (event.type === "step.started" ||
        event.type === "message.appended" ||
        event.type === "reasoning.appended" ||
        event.type === "action.input.partial") {
        return `${event.data.turnId}:${event.data.stepIndex}`;
    }
    return undefined;
}
function cumulativeSnapshot(event) {
    if (event.type === "message.appended")
        return event.data.messageSoFar;
    if (event.type === "reasoning.appended")
        return event.data.reasoningSoFar;
    if (event.type === "action.input.partial")
        return event.data.inputTextSoFar;
    return undefined;
}
export function reconcilePendingTurnWithEvents(pendingTurn, events) {
    if (!pendingTurn)
        return undefined;
    const latestReceived = [...events].reverse().find((event) => event.type === "message.received");
    const latestReceivedIndex = latestReceived ? events.lastIndexOf(latestReceived) : -1;
    const eventAt = latestReceived?.meta.at ? Date.parse(latestReceived.meta.at) : Number.NaN;
    const submittedAt = pendingTurn.submittedAt;
    const eventCanAcknowledge = !Number.isFinite(eventAt) || eventAt >= submittedAt - 5_000;
    const hasAuthoritativeClientId = latestReceived?.type === "message.received" &&
        typeof latestReceived.data.clientMessageId === "string" &&
        latestReceived.data.clientMessageId.trim().length > 0;
    const isAfterSubmission = pendingTurn.eventCountAtSubmission === undefined ||
        latestReceivedIndex >= pendingTurn.eventCountAtSubmission;
    const accepted = latestReceived?.type === "message.received" && (latestReceived.data.clientMessageId === pendingTurn.id ||
        (!hasAuthoritativeClientId && isAfterSubmission && eventCanAcknowledge && pendingTurn.text.trim().length > 0 &&
            latestReceived.data.message.trim() === pendingTurn.text.trim()));
    return accepted ? undefined : pendingTurn;
}
export function reconcileHydratedPendingTurn(pendingTurn, events) {
    const reconciled = reconcilePendingTurnWithEvents(pendingTurn, events);
    if (!reconciled)
        return undefined;
    if (reconciled.operation === "edit" && reconciled.delivery === "server") {
        return reconciled;
    }
    if (reconciled.state !== "clearing" && reconciled.state !== "resubmitting" && reconciled.state !== "submitting")
        return reconciled;
    return { ...reconciled, state: "delivery-failed" };
}
export function projectThreadEditBranches(events) {
    if (!events.some((event) => event.type === "context.cleared"))
        return events;
    const projected = [];
    for (const event of events) {
        if (event.type === "context.cleared") {
            const targetTurnId = event.data.turnId;
            const previousClearIndex = projected.findLastIndex((candidate) => candidate.type === "context.cleared" && candidate.data.turnId === targetTurnId);
            if (previousClearIndex >= 0)
                projected.splice(previousClearIndex);
            let targetIndex = projected.findLastIndex((candidate) => eventTurnId(candidate) === targetTurnId);
            if (targetIndex >= 0) {
                const actualTargetTurnId = eventTurnId(projected[targetIndex]);
                const turnStartIndex = projected.findLastIndex((candidate, index) => index <= targetIndex && candidate.type === "turn.started" &&
                    candidate.data.turnId === actualTargetTurnId);
                projected.splice(turnStartIndex >= 0 ? turnStartIndex : targetIndex);
            }
        }
        projected.push(event);
    }
    return projected;
}
export function projectPendingThreadEdit(events, beforeTurnId) {
    if (!beforeTurnId || events.some((event) => event.type === "context.cleared" && event.data.turnId === beforeTurnId))
        return events;
    const targetIndex = events.findIndex((event) => eventTurnId(event) === beforeTurnId);
    if (targetIndex < 0)
        return events;
    const turnStartIndex = events.findLastIndex((event, index) => index <= targetIndex && event.type === "turn.started" && event.data.turnId === beforeTurnId);
    return events.slice(0, turnStartIndex >= 0 ? turnStartIndex : targetIndex);
}
export function latestEditableTurnId(events) {
    const conflictTurns = new Set(events.flatMap((event) => event.type === "turn.failed" && event.data.code === "turn_revert_conflict"
        ? [event.data.turnId]
        : []));
    for (const event of [...events].reverse()) {
        if (event.type !== "message.received" || typeof event.data.turnId !== "string")
            continue;
        if (conflictTurns.has(event.data.turnId))
            continue;
        return event.data.turnId;
    }
    return undefined;
}
function eventTurnId(event) {
    return "data" in event && "turnId" in event.data && typeof event.data.turnId === "string"
        ? event.data.turnId
        : undefined;
}
export function dedupeThreadEvents(events) {
    const seen = new Set();
    const deduped = [];
    for (const event of events) {
        const identity = eventIdentity(event);
        if (seen.has(identity))
            continue;
        seen.add(identity);
        deduped.push(event);
    }
    return deduped;
}
function isExecutionMode(value) {
    return value === "automation" || value === "cautious" || value === "standard";
}
function createId() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `thread-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isThreadStatus(value) {
    return value === "cancelling" || value === "error" || value === "ready" ||
        value === "streaming" || value === "submitted" || value === "waiting";
}
function numberOrNow(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}
function nonEmptyString(value) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
//# sourceMappingURL=thread-storage.js.map