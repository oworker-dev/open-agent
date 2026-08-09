import { AGENT_THREAD_STORAGE_VERSION, parseThreadCollection, } from "./thread-storage.js";
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
            if (body.thread == null)
                return undefined;
            return parseThreadCollection({
                threads: [body.thread],
                version: AGENT_THREAD_STORAGE_VERSION,
            }).threads[0];
        },
        async save(storageKey, collection) {
            preferredThreadId = collection.activeThreadId;
            const expectedRevision = revisions.get(storageKey);
            const baseline = baselines.get(storageKey);
            if (expectedRevision === undefined || baseline === undefined) {
                throw new Error("Agent thread storage must be loaded before it can be saved.");
            }
            const patch = createCollectionPatch(baseline, collection);
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
            baselines.set(storageKey, collection);
        },
    };
}
function createCollectionPatch(baseline, collection) {
    const previousThreads = new Map(baseline.threads.map((thread) => [thread.id, thread]));
    const nextIds = new Set(collection.threads.map((thread) => thread.id));
    return {
        activeThreadId: collection.activeThreadId ?? null,
        deletedThreadIds: baseline.threads.flatMap((thread) => nextIds.has(thread.id) ? [] : [thread.id]),
        upsertThreads: collection.threads.filter((thread) => {
            const previous = previousThreads.get(thread.id);
            return !previous || previous !== thread;
        }),
        version: collection.version,
    };
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
function collectionUrl(endpoint, storageKey, query) {
    const url = `${endpoint}/${encodeURIComponent(storageKey)}`;
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