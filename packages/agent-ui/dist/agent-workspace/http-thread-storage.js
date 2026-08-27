import { AGENT_THREAD_STORAGE_VERSION, eventIdentity, parseThreadCollection, } from "./thread-storage.js";
export class AgentThreadStorageConflictError extends Error {
    currentRevision;
    expectedRevision;
    constructor(expectedRevision, currentRevision) {
        super("The Agent thread collection changed in another client.");
        this.name = "AgentThreadStorageConflictError";
        this.currentRevision = currentRevision;
        this.expectedRevision = expectedRevision;
    }
}
export class AgentThreadStorageHttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.name = "AgentThreadStorageHttpError";
        this.status = status;
    }
}
export function createHttpAgentThreadStorage(options) {
    const endpoint = (options.endpoint ?? "/api/agent/thread-collections").replace(/\/$/, "");
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const revisions = new Map();
    const baselines = new Map();
    let preferredThreadId = options.initialThreadId;
    return {
        async load(storageKey) {
            const response = await request(fetchImplementation, options, collectionUrl(endpoint, storageKey, {
                ...(preferredThreadId ? { threadId: preferredThreadId } : {}),
                view: "index",
            }));
            await requireOk(response);
            const body = await readCollectionResponse(response);
            revisions.set(storageKey, body.revision);
            baselines.set(storageKey, body.collection);
            return body.collection;
        },
        async loadThread(storageKey, threadId) {
            preferredThreadId = threadId;
            const response = await request(fetchImplementation, options, collectionUrl(endpoint, storageKey, { threadId }));
            await requireOk(response);
            const body = await response.json();
            if (!Number.isSafeInteger(body.revision) || body.revision < 0) {
                throw new Error("Agent thread storage returned an invalid revision.");
            }
            revisions.set(storageKey, body.revision);
            if (body.thread == null)
                return undefined;
            const parsedThread = parseThreadCollection({
                threads: [body.thread],
                version: AGENT_THREAD_STORAGE_VERSION,
            }).threads[0];
            const hydrated = parsedThread ? withoutSummaryHydration(parsedThread) : undefined;
            if (hydrated) {
                const baseline = baselines.get(storageKey);
                baselines.set(storageKey, {
                    ...(baseline?.activeThreadId ? { activeThreadId: baseline.activeThreadId } : {}),
                    threads: [
                        ...(baseline?.threads ?? []).filter((thread) => thread.id !== hydrated.id),
                        hydrated,
                    ],
                    version: AGENT_THREAD_STORAGE_VERSION,
                });
            }
            return hydrated;
        },
        async loadThreadWindow(storageKey, threadId, windowOptions = {}) {
            preferredThreadId = threadId;
            const query = { eventWindow: "1", threadId };
            if (windowOptions.before !== undefined)
                query.eventBefore = String(windowOptions.before);
            if (windowOptions.limit !== undefined)
                query.eventLimit = String(windowOptions.limit);
            const response = await request(fetchImplementation, options, collectionUrl(endpoint, storageKey, query));
            await requireOk(response);
            const body = await response.json();
            if (!Number.isSafeInteger(body.revision) || body.revision < 0) {
                throw new Error("Agent thread storage returned an invalid revision.");
            }
            if (body.thread == null || !isTranscriptWindow(body.eventWindow))
                return undefined;
            const parsedThread = parseThreadCollection({
                threads: [body.thread],
                version: AGENT_THREAD_STORAGE_VERSION,
            }).threads[0];
            if (!parsedThread)
                return undefined;
            const hydrated = withoutSummaryHydration(parsedThread);
            const baseline = baselines.get(storageKey);
            const baselineThread = baseline?.threads.find((thread) => thread.id === hydrated.id);
            const baselineEvents = baselineThread?.events ?? [];
            baselines.set(storageKey, {
                ...(baseline?.activeThreadId ? { activeThreadId: baseline.activeThreadId } : {}),
                threads: [
                    ...(baseline?.threads ?? []).filter((thread) => thread.id !== hydrated.id),
                    {
                        ...hydrated,
                        events: [...hydrated.events, ...baselineEvents].filter((event, index, all) => all.findIndex((candidate) => eventIdentity(candidate) === eventIdentity(event)) === index),
                    },
                ],
                version: AGENT_THREAD_STORAGE_VERSION,
            });
            revisions.set(storageKey, body.revision);
            return { thread: hydrated, window: body.eventWindow };
        },
        async repairThread(storageKey, threadId) {
            preferredThreadId = threadId;
            const response = await request(fetchImplementation, options, repairCollectionUrl(endpoint, storageKey, { threadId }), {
                headers: { "content-type": "application/json" },
                method: "POST",
            });
            if (response.status === 404)
                return undefined;
            await requireOk(response);
            const body = await response.json();
            if (!Number.isSafeInteger(body.revision) || body.revision < 0) {
                throw new Error("Agent thread storage returned an invalid revision.");
            }
            revisions.set(storageKey, body.revision);
            if (body.thread == null)
                return undefined;
            const parsedThread = parseThreadCollection({
                threads: [body.thread],
                version: AGENT_THREAD_STORAGE_VERSION,
            }).threads[0];
            const hydrated = parsedThread ? withoutSummaryHydration(parsedThread) : undefined;
            if (hydrated) {
                const baseline = baselines.get(storageKey);
                baselines.set(storageKey, {
                    ...(baseline?.activeThreadId ? { activeThreadId: baseline.activeThreadId } : {}),
                    threads: [
                        ...(baseline?.threads ?? []).filter((thread) => thread.id !== hydrated.id),
                        hydrated,
                    ],
                    version: AGENT_THREAD_STORAGE_VERSION,
                });
            }
            return hydrated;
        },
        async save(storageKey, collection) {
            preferredThreadId = collection.activeThreadId;
            const expectedRevision = revisions.get(storageKey);
            const baseline = baselines.get(storageKey);
            if (expectedRevision === undefined || baseline === undefined) {
                throw new Error("Agent thread storage must be loaded before it can be saved.");
            }
            const savedCollection = snapshotCollection(collection);
            const patch = createCollectionPatch(baseline, savedCollection);
            const response = await request(fetchImplementation, options, collectionUrl(endpoint, storageKey), {
                body: JSON.stringify(patch),
                headers: {
                    "content-type": "application/json",
                    "if-match": `"${expectedRevision}"`,
                },
                method: "PATCH",
            });
            if (response.status === 409) {
                throw new AgentThreadStorageConflictError(expectedRevision, revisionFromEtag(response.headers.get("etag")));
            }
            await requireOk(response);
            revisions.set(storageKey, await readRevisionResponse(response));
            baselines.set(storageKey, savedCollection);
        },
    };
}
function snapshotCollection(collection) {
    return {
        ...(collection.activeThreadId ? { activeThreadId: collection.activeThreadId } : {}),
        threads: collection.threads.map((thread) => ({
            ...thread,
            events: [...thread.events],
        })),
        version: collection.version,
    };
}
function withoutSummaryHydration(thread) {
    const { hydration: _summaryMarker, ...hydrated } = thread;
    return hydrated;
}
function createCollectionPatch(baseline, collection) {
    const previousThreads = new Map(baseline.threads.map((thread) => [thread.id, thread]));
    const nextIds = new Set(collection.threads.map((thread) => thread.id));
    const eventAppends = [];
    const upsertThreads = collection.threads.flatMap((thread) => {
        const previous = previousThreads.get(thread.id);
        if (!previous)
            return [thread];
        const delta = appendOnlyEventDelta(previous.events, thread.events);
        if (delta) {
            if (delta.events.length > 0)
                eventAppends.push({
                    events: delta.events,
                    ...(delta.replaceFrom === previous.events.length ? {} : {
                        replaceFrom: (previous.transcriptWindow?.startIndex ?? 0) + delta.replaceFrom,
                    }),
                    threadId: thread.id,
                });
            return [{ ...thread, events: [], hydration: "summary" }];
        }
        if (sameEventIds(previous.events, thread.events)) {
            return [{ ...thread, events: [], hydration: "summary" }];
        }
        if (!isExplicitTranscriptReplacement(thread)) {
            return [{ ...thread, events: [], hydration: "summary" }];
        }
        return [thread];
    });
    return {
        activeThreadId: collection.activeThreadId ?? null,
        deletedThreadIds: baseline.threads.flatMap((thread) => nextIds.has(thread.id) ? [] : [thread.id]),
        eventAppends,
        upsertThreads: upsertThreads.filter((thread) => {
            const previous = previousThreads.get(thread.id);
            return !previous || previous !== thread || eventAppends.some((append) => append.threadId === thread.id);
        }),
        version: collection.version,
    };
}
function isExplicitTranscriptReplacement(thread) {
    return thread.pendingTurn?.state === "clearing" ||
        thread.pendingTurn?.state === "resubmitting";
}
function appendOnlyEventDelta(previous, next) {
    if (next.length < previous.length)
        return undefined;
    let firstDifference = -1;
    for (let index = 0; index < previous.length; index += 1) {
        if (eventIdentity(previous[index]) !== eventIdentity(next[index])) {
            firstDifference = index;
            break;
        }
    }
    if (firstDifference < 0)
        firstDifference = previous.length;
    for (let index = firstDifference + 1; index < previous.length; index += 1) {
        if (eventIdentity(previous[index]) !== eventIdentity(next[index]))
            return undefined;
    }
    return { events: next.slice(firstDifference), replaceFrom: firstDifference };
}
function sameEventIds(left, right) {
    return left.length === right.length && left.every((event, index) => right[index] !== undefined && eventIdentity(event) === eventIdentity(right[index]));
}
async function request(fetchImplementation, options, url, init) {
    const accessToken = await options.getAccessToken?.();
    if (accessToken !== undefined && !accessToken.trim()) {
        throw new Error("Agent thread storage access token is empty.");
    }
    return await fetchImplementation(url, {
        ...init,
        credentials: "same-origin",
        headers: {
            ...init?.headers,
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
    });
}
async function requireOk(response) {
    if (response.ok)
        return;
    let message = `Agent thread storage request failed with status ${response.status}.`;
    try {
        const body = await response.json();
        if (typeof body.error === "string")
            message = body.error;
    }
    catch {
    }
    throw new AgentThreadStorageHttpError(response.status, message);
}
async function readRevisionResponse(response) {
    const body = await response.json();
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) {
        throw new Error("Agent thread storage returned an invalid revision.");
    }
    return body.revision;
}
async function readCollectionResponse(response) {
    const body = await response.json();
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) {
        throw new Error("Agent thread storage returned an invalid revision.");
    }
    const collection = parseThreadCollection(body.collection);
    return { collection, revision: body.revision };
}
function isTranscriptWindow(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const candidate = value;
    const startIndex = candidate.startIndex;
    const endIndex = candidate.endIndex;
    const total = candidate.total;
    return Number.isSafeInteger(startIndex) && startIndex >= 0 &&
        Number.isSafeInteger(endIndex) && endIndex >= startIndex &&
        Number.isSafeInteger(total) && total >= endIndex &&
        typeof candidate.hasMoreBefore === "boolean";
}
function collectionUrl(endpoint, storageKey, query) {
    const url = `${endpoint}/${encodeURIComponent(storageKey)}`;
    if (!query)
        return url;
    const search = new URLSearchParams(query);
    return `${url}?${search.toString()}`;
}
function repairCollectionUrl(endpoint, storageKey, query) {
    const url = `${endpoint}/${encodeURIComponent(storageKey)}/repair`;
    if (!query)
        return url;
    const search = new URLSearchParams(query);
    return `${url}?${search.toString()}`;
}
function revisionFromEtag(value) {
    const match = value ? /^(?:W\/)?"(\d+)"$/.exec(value.trim()) : undefined;
    const revision = match?.[1] ? Number(match[1]) : undefined;
    return Number.isSafeInteger(revision) ? revision : undefined;
}
//# sourceMappingURL=http-thread-storage.js.map