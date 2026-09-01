import { AGENT_THREAD_STORAGE_VERSION, eventIdentity, parseThreadCollection, } from "./thread-storage.js";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_READ_RETRY_LIMIT = 2;
const MAX_READ_RETRY_LIMIT = 3;
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
    const requestTimeoutMs = boundedInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 1_000, MAX_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    const readRetryLimit = boundedInteger(options.readRetryLimit ?? DEFAULT_READ_RETRY_LIMIT, 0, MAX_READ_RETRY_LIMIT, "readRetryLimit");
    const revisions = new Map();
    const baselines = new Map();
    let preferredThreadId = options.initialThreadId;
    return {
        async load(storageKey) {
            const knownRevision = revisions.get(storageKey);
            const response = await request(fetchImplementation, options, collectionUrl(endpoint, storageKey, {
                ...(preferredThreadId ? { threadId: preferredThreadId } : {}),
                view: "index",
            }), {
                ...(knownRevision === undefined ? {} : { headers: { "if-none-match": `"${knownRevision}"` } }),
                requestTimeoutMs,
                readRetryLimit,
            });
            if (response.status === 304) {
                const cached = baselines.get(storageKey);
                if (cached && knownRevision !== undefined)
                    return cached;
                throw new AgentThreadStorageHttpError(304, "The Agent thread index cache is unavailable.");
            }
            await requireOk(response);
            const body = await readCollectionResponse(response);
            revisions.set(storageKey, body.revision);
            baselines.set(storageKey, body.collection);
            return body.collection;
        },
        async loadThread(storageKey, threadId) {
            preferredThreadId = threadId;
            const response = await request(fetchImplementation, options, collectionUrl(endpoint, storageKey, { threadId }), { requestTimeoutMs, readRetryLimit });
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
            const response = await request(fetchImplementation, options, collectionUrl(endpoint, storageKey, query), { requestTimeoutMs, readRetryLimit });
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
                        transcriptWindow: body.eventWindow,
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
                requestTimeoutMs,
                readRetryLimit: 0,
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
                requestTimeoutMs,
                readRetryLimit: 0,
            });
            if (response.status === 409) {
                throw new AgentThreadStorageConflictError(expectedRevision, revisionFromEtag(response.headers.get("etag")));
            }
            await requireOk(response);
            revisions.set(storageKey, await readRevisionResponse(response));
            baselines.set(storageKey, baselineAfterPatch(baseline, savedCollection, patch));
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
function baselineAfterPatch(previous, next, patch) {
    const appends = new Map(patch.eventAppends.map((entry) => [entry.threadId, entry]));
    const previousThreads = new Map(previous.threads.map((thread) => [thread.id, thread]));
    const deleted = new Set(patch.deletedThreadIds);
    return {
        ...(next.activeThreadId ? { activeThreadId: next.activeThreadId } : {}),
        threads: next.threads
            .filter((thread) => !deleted.has(thread.id))
            .map((thread) => {
            const prior = previousThreads.get(thread.id);
            if (!prior)
                return thread;
            if (isExplicitTranscriptReplacement(thread))
                return thread;
            const append = appends.get(thread.id);
            if (!append || append.events.length === 0) {
                return { ...thread, events: [...prior.events] };
            }
            if (append.replaceFrom === undefined) {
                const seen = new Set(prior.events.map(eventIdentity));
                const merged = [...prior.events];
                for (const event of append.events) {
                    if (seen.has(eventIdentity(event)))
                        continue;
                    seen.add(eventIdentity(event));
                    merged.push(event);
                }
                return { ...thread, events: merged };
            }
            return thread;
        }),
        version: next.version,
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
            return [withoutTranscriptWindow(thread)];
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
            return [withoutTranscriptWindow({ ...thread, events: [], hydration: "summary" })];
        }
        if (sameEventIds(previous.events, thread.events)) {
            return [withoutTranscriptWindow({ ...thread, events: [], hydration: "summary" })];
        }
        if (!isExplicitTranscriptReplacement(thread)) {
            const unseen = thread.events.filter((event) => {
                const identity = eventIdentity(event);
                return !previous.events.some((candidate) => eventIdentity(candidate) === identity);
            });
            if (unseen.length > 0) {
                eventAppends.push({ events: unseen, threadId: thread.id });
            }
            return [withoutTranscriptWindow({ ...thread, events: [], hydration: "summary" })];
        }
        return [withoutTranscriptWindow(thread)];
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
function withoutTranscriptWindow(thread) {
    const { transcriptWindow: _derivedWindow, ...persisted } = thread;
    return persisted;
}
function isExplicitTranscriptReplacement(thread) {
    const pending = thread.pendingTurn;
    if (!pending)
        return false;
    return pending.state === "clearing" ||
        pending.state === "resubmitting";
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
    const method = (init?.method ?? "GET").toUpperCase();
    const retryLimit = method === "GET"
        ? init?.readRetryLimit ?? options.readRetryLimit ?? DEFAULT_READ_RETRY_LIMIT
        : 0;
    const timeoutMs = init?.requestTimeoutMs ?? options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const accessToken = await resolveAccessToken(options.getAccessToken, timeoutMs);
    if (accessToken !== undefined && !accessToken.trim()) {
        throw new Error("Agent thread storage access token is empty.");
    }
    const { readRetryLimit: _readRetryLimit, requestTimeoutMs: _requestTimeoutMs, ...requestInit } = init ?? {};
    let attempt = 0;
    for (;;) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImplementation(url, {
                ...requestInit,
                credentials: "same-origin",
                headers: {
                    ...requestInit.headers,
                    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
                },
                signal: controller.signal,
            });
            if (attempt >= retryLimit || !isRetryableReadStatus(response.status))
                return response;
            await response.body?.cancel().catch(() => undefined);
            attempt += 1;
            await sleepWithRetryAfter(response.headers.get("retry-after"), attempt);
        }
        catch (error) {
            if (attempt >= retryLimit || !isRetryableReadError(error))
                throw error;
            attempt += 1;
            await sleepWithRetryAfter(undefined, attempt);
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
async function resolveAccessToken(getter, timeoutMs) {
    if (!getter)
        return undefined;
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(getter),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("Agent thread storage access token timed out.")), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
function boundedInteger(value, minimum, maximum, name) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
    }
    return value;
}
function isRetryableReadStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}
function isRetryableReadError(error) {
    if (!(error instanceof Error))
        return false;
    return error instanceof TypeError || error.name === "AbortError" || error.name === "TimeoutError";
}
async function sleepWithRetryAfter(header, attempt) {
    const retryAfterSeconds = header ? Number(header) : NaN;
    const serverDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? Math.min(5_000, retryAfterSeconds * 1_000)
        : 0;
    const exponential = Math.min(2_000, 250 * 2 ** Math.max(0, attempt - 1));
    const delay = Math.max(serverDelay, exponential) + Math.floor(Math.random() * 100);
    await new Promise((resolve) => setTimeout(resolve, delay));
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