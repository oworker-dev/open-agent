import { conversationOf } from "eve/client";
import { conversation } from "eve/events";
import { parseAssetPrompt } from "@oworker/open-agent-contracts/asset";
import { sanitizeRetainedContext } from "./retained-context.js";
export const AGENT_THREAD_STORAGE_VERSION = 2;
const EMPTY_SESSION = { streamIndex: 0 };
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
        const events = mergeConflictEvents(thread, existing);
        byId.set(thread.id, {
            ...selected,
            events,
            inputResponseSubmissions: mergeInputResponseSubmissions(thread.inputResponseSubmissions ?? [], existing.inputResponseSubmissions ?? []),
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
    const inputResponseSubmissions = parseInputResponseSubmissions(value.inputResponseSubmissions);
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
    let transcriptCoverage = parseTranscriptCoverage(value.transcriptCoverage);
    const transcriptWindow = parseTranscriptWindow(value.transcriptWindow);
    const cachedEvents = Array.isArray(value.events)
        ? value.events
        : [];
    const validCache = cachedEvents.every(isThreadEvent);
    const rawEvents = validCache ? cachedEvents : [];
    if (!validCache)
        transcriptCoverage = undefined;
    const storedStreamIndex = typeof session.streamIndex === "number" && Number.isSafeInteger(session.streamIndex) && session.streamIndex >= 0
        ? session.streamIndex
        : transcriptWindow?.endIndex ?? (transcriptCoverage?.complete ? transcriptCoverage.endIndex : cursorAfterEvents(rawEvents));
    return {
        createdAt,
        closedInputRequestIds,
        ...(draftRestore ? { draftRestore } : {}),
        events: compactThreadEvents(rawEvents),
        ...(value.hydration === "summary" ? { hydration: "summary" } : {}),
        id: value.id,
        ...(interruptedTurns.length > 0 ? { interruptedTurns } : {}),
        ...(inputResponseSubmissions.length > 0 ? { inputResponseSubmissions } : {}),
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
            streamIndex: storedStreamIndex,
        },
        status,
        ...(transcriptCoverage ? { transcriptCoverage } : {}),
        ...(transcriptWindow ? { transcriptWindow } : {}),
        title: value.title,
        updatedAt,
    };
}
function cursorAfterEvents(events) {
    const last = events.at(-1);
    if (!last || !Number.isSafeInteger(last.meta?.position?.line))
        return 0;
    if (Number.isSafeInteger(last.meta.next))
        return last.meta.next;
    return last.meta.endOfLine === false ? last.meta.position.line : last.meta.position.line + 1;
}
function parseInputResponseSubmissions(value) {
    if (!Array.isArray(value))
        return [];
    const submissions = new Map();
    for (const candidate of value) {
        if (!isRecord(candidate) ||
            typeof candidate.id !== "string" || !candidate.id ||
            !Array.isArray(candidate.responses) || candidate.responses.length === 0 ||
            typeof candidate.streamIndexAtSubmission !== "number" ||
            !Number.isSafeInteger(candidate.streamIndexAtSubmission) || candidate.streamIndexAtSubmission < 0 ||
            typeof candidate.submittedAt !== "number" || !Number.isFinite(candidate.submittedAt) ||
            !isInputResponseSubmissionState(candidate.state))
            continue;
        const responses = candidate.responses.flatMap((response) => {
            if (!isRecord(response) || typeof response.interactionId !== "string" || !response.interactionId)
                return [];
            const optionId = typeof response.optionId === "string" && response.optionId ? response.optionId : undefined;
            const text = typeof response.text === "string" && response.text ? response.text : undefined;
            if (!optionId && !text)
                return [];
            return [{ ...(optionId ? { optionId } : {}), interactionId: response.interactionId, ...(text ? { text } : {}) }];
        });
        if (responses.length !== candidate.responses.length)
            continue;
        submissions.set(candidate.id, {
            id: candidate.id,
            ...(typeof candidate.mailboxItemId === "string" && candidate.mailboxItemId
                ? { mailboxItemId: candidate.mailboxItemId }
                : {}),
            responses,
            ...(typeof candidate.settledAtStreamIndex === "number" &&
                Number.isSafeInteger(candidate.settledAtStreamIndex) && candidate.settledAtStreamIndex >= 0
                ? { settledAtStreamIndex: candidate.settledAtStreamIndex }
                : {}),
            state: candidate.state,
            streamIndexAtSubmission: candidate.streamIndexAtSubmission,
            submittedAt: candidate.submittedAt,
        });
    }
    return [...submissions.values()].sort((left, right) => left.submittedAt - right.submittedAt);
}
function isInputResponseSubmissionState(value) {
    return value === "submitting" || value === "accepted" || value === "cancelled" ||
        value === "committed" || value === "delivering" || value === "failed" ||
        value === "queued" || value === "submission-ambiguous";
}
export function mergeInputResponseSubmissions(left, right) {
    const submissions = new Map(right.map((entry) => [entry.id, entry]));
    for (const entry of left) {
        const current = submissions.get(entry.id);
        if (!current || entry.settledAtStreamIndex !== undefined ||
            (current.settledAtStreamIndex === undefined && inputResponseStateRank(entry.state) >= inputResponseStateRank(current.state))) {
            submissions.set(entry.id, entry);
        }
    }
    return [...submissions.values()].sort((a, b) => a.submittedAt - b.submittedAt);
}
export function inputResponseSubmissionFailure(submission, events) {
    for (const answer of submission.responses) {
        const submitted = events.find((event) => event.type === "response.submitted" &&
            event.meta.position.line >= submission.streamIndexAtSubmission &&
            event.data.interactionId === answer.interactionId &&
            event.data.value?.optionId === answer.optionId && event.data.value?.text === answer.text);
        if (submitted?.type !== "response.submitted")
            continue;
        const settled = events.find((event) => event.type === "response.settled" &&
            event.data.responseId === submitted.data.responseId);
        if (settled?.type === "response.settled" && settled.data.outcome !== "applied") {
            return settled.data.reason || "The response was not accepted. Please try again.";
        }
    }
    return undefined;
}
export function inputResponseSubmissionProjectsAnswer(submission, events = []) {
    return submission.state !== "failed" && submission.state !== "cancelled" &&
        inputResponseSubmissionFailure(submission, events) === undefined;
}
export function hasUnsettledInputResponseSubmission(submissions) {
    return submissions.some((submission) => submission.settledAtStreamIndex === undefined &&
        inputResponseSubmissionProjectsAnswer(submission));
}
export function settleInputResponseSubmissions(submissions, streamIndex) {
    let changed = false;
    const settled = submissions.map((submission) => {
        if (submission.settledAtStreamIndex !== undefined ||
            !inputResponseSubmissionProjectsAnswer(submission) ||
            streamIndex <= submission.streamIndexAtSubmission)
            return submission;
        changed = true;
        return { ...submission, settledAtStreamIndex: streamIndex };
    });
    return changed ? settled : submissions;
}
function inputResponseStateRank(state) {
    switch (state) {
        case "submitting": return 0;
        case "queued": return 1;
        case "delivering": return 2;
        case "accepted": return 3;
        case "committed": return 4;
        case "submission-ambiguous": return 5;
        case "failed": return 6;
        case "cancelled": return 7;
    }
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
        ...(value.projection === "v27-source-lines" ? { projection: value.projection } : {}),
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
        const pendingMessage = parsePendingTurn(candidate.pendingMessage);
        turns.set(candidate.turnId, {
            eventCount: candidate.eventCount,
            ...(pendingMessage?.state === "interrupted" && pendingMessage.id === candidate.pendingClientMessageId
                ? { pendingMessage } : {}),
            ...(typeof candidate.pendingClientMessageId === "string" && candidate.pendingClientMessageId
                ? { pendingClientMessageId: candidate.pendingClientMessageId } : {}),
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
    return {
        ...(value.delivery === "server" || value.delivery === "browser"
            ? { delivery: value.delivery }
            : {}),
        ...(expectedTurnId ? { expectedTurnId } : {}),
        id: value.id,
        ...(value.intent === "active-turn"
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
        (value.state !== "submitting" && value.state !== "delivery-failed" && value.state !== "interrupted")) {
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
    if (events.some((candidate) => eventIdentity(candidate) === eventIdentity(event)))
        return events;
    const next = [...events];
    insertEventInPositionOrder(next, event);
    return next;
}
export function appendThreadEventIndexed(events, eventIds, event) {
    const identity = eventIdentity(event);
    if (eventIds.has(identity))
        return false;
    eventIds.add(identity);
    insertEventInPositionOrder(events, event);
    return true;
}
export function mergeThreadEventSnapshots(left, right) {
    if (left.length === 0)
        return right;
    if (right.length === 0)
        return left;
    const byIdentity = new Map();
    for (const event of [...left, ...right])
        byIdentity.set(eventIdentity(event), event);
    return [...byIdentity.values()].sort(compareEventPosition);
}
function compareEventPosition(left, right) {
    return left.meta.position.line - right.meta.position.line ||
        left.meta.position.index - right.meta.position.index;
}
export function eventIdentity(event) {
    const { line, index } = event.meta.position;
    return `position:${line}:${index}`;
}
export function isThreadEvent(value) {
    if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.data) ||
        !isRecord(value.meta) || typeof value.meta.at !== "string" || !isRecord(value.meta.position))
        return false;
    const { line, index } = value.meta.position;
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 0 ||
        typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
        return false;
    if (value.meta.endOfLine !== undefined && typeof value.meta.endOfLine !== "boolean")
        return false;
    return value.meta.next === undefined || (value.meta.endOfLine !== false &&
        typeof value.meta.next === "number" && Number.isSafeInteger(value.meta.next) && value.meta.next > line);
}
export function threadEventCursor(event) {
    if (!Number.isSafeInteger(event.meta?.position?.line))
        return undefined;
    if (event.meta.next !== undefined)
        return event.meta.next;
    return event.meta.endOfLine === false ? undefined : event.meta.position.line + 1;
}
function hasEventIdentity(events, event) {
    const identity = eventIdentity(event);
    return events.some((candidate) => eventIdentity(candidate) === identity);
}
export function compactThreadEvents(events) {
    const byIdentity = new Map();
    for (const event of events)
        byIdentity.set(eventIdentity(event), event);
    return [...byIdentity.values()].sort(compareEventPosition);
}
function insertEventInPositionOrder(events, event) {
    if (!events.length || compareEventPosition(events[events.length - 1], event) <= 0) {
        events.push(event);
        return;
    }
    let low = 0;
    let high = events.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (compareEventPosition(events[middle], event) <= 0)
            low = middle + 1;
        else
            high = middle;
    }
    events.splice(low, 0, event);
}
export function reconcilePendingTurnWithEvents(pendingTurn, events) {
    if (!pendingTurn)
        return undefined;
    const accepted = events.some((event) => event.type === "delivery.consumed" && receivedClientMessageId(event) === pendingTurn.id);
    return accepted ? undefined : pendingTurn;
}
export function receivedClientMessageId(event) {
    return parseAssetPrompt(textFromDelivery(event)).clientMessageId;
}
export function textFromDelivery(event) {
    return event.data.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n");
}
export function reconcileHydratedPendingTurn(pendingTurn, events) {
    const reconciled = reconcilePendingTurnWithEvents(pendingTurn, events);
    if (!reconciled)
        return undefined;
    if (reconciled.operation === "edit" && reconciled.delivery === "server") {
        return reconciled;
    }
    if (reconciled.state !== "submitting")
        return reconciled;
    return { ...reconciled, state: "delivery-failed" };
}
export function latestEditableTurnId(events) {
    const latest = conversation(conversationOf(events).view).at(-1);
    if (!latest)
        return undefined;
    const userReceipts = events.filter((event) => event.type === "delivery.consumed" &&
        event.data.turnId === latest.turnId && event.data.parts.length > 0);
    return userReceipts.length === 1 ? latest.turnId : undefined;
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