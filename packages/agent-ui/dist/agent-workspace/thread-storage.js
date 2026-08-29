import { sanitizeRetainedContext } from "./retained-context.js";
export const AGENT_THREAD_STORAGE_VERSION = 2;
const EMPTY_SESSION = { streamIndex: 0 };
const FALLBACK_PREFERENCES = {
    executionMode: "standard",
    modelId: "default",
    reasoning: "medium",
};
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
    const localIds = new Set(localEvents.map(eventIdentity));
    const remoteIds = new Set(remoteEvents.map(eventIdentity));
    const localSubsetOfRemote = [...localIds].every((id) => remoteIds.has(id));
    const remoteSubsetOfLocal = [...remoteIds].every((id) => localIds.has(id));
    if (localSubsetOfRemote)
        return remoteEvents;
    if (remoteSubsetOfLocal)
        return localEvents;
    const merged = [...remoteEvents];
    const mergedIds = new Set(remoteIds);
    for (const event of localEvents) {
        const id = eventIdentity(event);
        if (mergedIds.has(id))
            continue;
        merged.push(event);
        mergedIds.add(id);
    }
    return compactThreadEvents(merged);
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
    return {
        ...(typeof value.eventCountAtSubmission === "number" && Number.isInteger(value.eventCountAtSubmission) && value.eventCountAtSubmission >= 0
            ? { eventCountAtSubmission: value.eventCountAtSubmission }
            : {}),
        ...(files.length > 0 ? { files } : {}),
        id: value.id,
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
    if (reconciled.state !== "clearing" && reconciled.state !== "resubmitting" && reconciled.state !== "submitting")
        return reconciled;
    return { ...reconciled, state: "delivery-failed" };
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