import {
  AGENT_THREAD_STORAGE_VERSION,
  parseThreadCollection,
  type AgentThreadCollection,
  type AgentThreadStorage,
} from "./thread-storage.js";

export type HttpAgentThreadStorageOptions = {
  readonly endpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly getAccessToken?: () => string | Promise<string>;
  readonly initialThreadId?: string;
};

export class AgentThreadStorageConflictError extends Error {
  readonly currentRevision?: number;
  readonly expectedRevision: number;

  constructor(
    expectedRevision: number,
    currentRevision?: number,
  ) {
    super("The Agent thread collection changed in another client.");
    this.name = "AgentThreadStorageConflictError";
    this.currentRevision = currentRevision;
    this.expectedRevision = expectedRevision;
  }
}

export class AgentThreadStorageHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AgentThreadStorageHttpError";
    this.status = status;
  }
}

export function createHttpAgentThreadStorage(
  options: HttpAgentThreadStorageOptions,
): AgentThreadStorage {
  const endpoint = (options.endpoint ?? "/api/agent/thread-collections").replace(/\/$/, "");
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const revisions = new Map<string, number>();
  const baselines = new Map<string, AgentThreadCollection>();
  let preferredThreadId = options.initialThreadId;

  return {
    async load(storageKey) {
      const response = await request(
        fetchImplementation,
        options,
        collectionUrl(endpoint, storageKey, {
          ...(preferredThreadId ? { threadId: preferredThreadId } : {}),
          view: "index",
        }),
      );
      await requireOk(response);
      const body = await readCollectionResponse(response);
      revisions.set(storageKey, body.revision);
      baselines.set(storageKey, body.collection);
      return body.collection;
    },
    async loadThread(storageKey, threadId) {
      preferredThreadId = threadId;
      const response = await request(
        fetchImplementation,
        options,
        collectionUrl(endpoint, storageKey, { threadId }),
      );
      await requireOk(response);
      const body = await response.json() as { revision?: unknown; thread?: unknown };
      if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) {
        throw new Error("Agent thread storage returned an invalid revision.");
      }
      if (body.thread == null) return undefined;
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
      const response = await request(
        fetchImplementation,
        options,
        collectionUrl(endpoint, storageKey),
        {
          body: JSON.stringify(patch),
          headers: {
            "content-type": "application/json",
            "if-match": `"${expectedRevision}"`,
          },
          method: "PATCH",
        },
      );
      if (response.status === 409) {
        throw new AgentThreadStorageConflictError(
          expectedRevision,
          revisionFromEtag(response.headers.get("etag")),
        );
      }
      await requireOk(response);
      revisions.set(storageKey, await readRevisionResponse(response));
      baselines.set(storageKey, collection);
    },
  };
}

function createCollectionPatch(
  baseline: AgentThreadCollection,
  collection: AgentThreadCollection,
): {
  readonly activeThreadId: string | null;
  readonly deletedThreadIds: readonly string[];
  readonly upsertThreads: AgentThreadCollection["threads"];
  readonly version: number;
} {
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

async function request(
  fetchImplementation: typeof globalThis.fetch,
  options: HttpAgentThreadStorageOptions,
  url: string,
  init?: RequestInit,
): Promise<Response> {
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

async function requireOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = `Agent thread storage request failed with status ${response.status}.`;
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Preserve the status-based message when the server did not return JSON.
  }
  throw new AgentThreadStorageHttpError(response.status, message);
}

async function readRevisionResponse(response: Response): Promise<number> {
  const body = await response.json() as { revision?: unknown };
  if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) {
    throw new Error("Agent thread storage returned an invalid revision.");
  }
  return body.revision as number;
}

async function readCollectionResponse(response: Response): Promise<{
  readonly collection: AgentThreadCollection;
  readonly revision: number;
}> {
  const body = await response.json() as { collection?: unknown; revision?: unknown };
  if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) {
    throw new Error("Agent thread storage returned an invalid revision.");
  }
  const collection = parseThreadCollection(body.collection);
  return { collection, revision: body.revision as number };
}

function collectionUrl(
  endpoint: string,
  storageKey: string,
  query?: Readonly<Record<string, string>>,
): string {
  const url = `${endpoint}/${encodeURIComponent(storageKey)}`;
  if (!query) return url;
  const search = new URLSearchParams(query);
  return `${url}?${search.toString()}`;
}

function revisionFromEtag(value: string | null): number | undefined {
  const match = value ? /^(?:W\/)?"(\d+)"$/.exec(value.trim()) : undefined;
  const revision = match?.[1] ? Number(match[1]) : undefined;
  return Number.isSafeInteger(revision) ? revision : undefined;
}
