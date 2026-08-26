import {
  AGENT_THREAD_STORAGE_VERSION,
  eventIdentity,
  parseThreadCollection,
  type AgentThreadCollection,
  type AgentThreadStorage,
} from "./thread-storage.js";
import type { AgentThread, AgentTranscriptWindow } from "./contracts.js";

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
      const parsedThread = parseThreadCollection({
        threads: [body.thread],
        version: AGENT_THREAD_STORAGE_VERSION,
      }).threads[0];
      // `hydration: "summary"` belongs only to collection indexes. A host
      // that accidentally echoes it from the single-thread endpoint must not
      // make AgentWorkspace request the same transcript forever.
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
      const query: Record<string, string> = { eventWindow: "1", threadId };
      if (windowOptions.before !== undefined) query.eventBefore = String(windowOptions.before);
      if (windowOptions.limit !== undefined) query.eventLimit = String(windowOptions.limit);
      const response = await request(
        fetchImplementation,
        options,
        collectionUrl(endpoint, storageKey, query),
      );
      await requireOk(response);
      const body = await response.json() as {
        eventWindow?: unknown;
        revision?: unknown;
        thread?: unknown;
      };
      if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) {
        throw new Error("Agent thread storage returned an invalid revision.");
      }
      if (body.thread == null || !isTranscriptWindow(body.eventWindow)) return undefined;
      const parsedThread = parseThreadCollection({
        threads: [body.thread],
        version: AGENT_THREAD_STORAGE_VERSION,
      }).threads[0];
      if (!parsedThread) return undefined;
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
            // Keep previously fetched pages in the optimistic baseline so a
            // metadata checkpoint never mistakes a prepend for a truncation.
            events: [...hydrated.events, ...baselineEvents].filter((event, index, all) =>
              all.findIndex((candidate) => eventIdentity(candidate) === eventIdentity(event)) === index,
            ),
          },
        ],
        version: AGENT_THREAD_STORAGE_VERSION,
      });
      revisions.set(storageKey, body.revision as number);
      return { thread: hydrated, window: body.eventWindow };
    },
    async repairThread(storageKey, threadId) {
      preferredThreadId = threadId;
      const response = await request(
        fetchImplementation,
        options,
        repairCollectionUrl(endpoint, storageKey, { threadId }),
        {
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      if (response.status === 404) return undefined;
      await requireOk(response);
      const body = await response.json() as { revision?: unknown; thread?: unknown };
      if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) {
        throw new Error("Agent thread storage returned an invalid revision.");
      }
      if (body.thread == null) return undefined;
      const parsedThread = parseThreadCollection({
        threads: [body.thread],
        version: AGENT_THREAD_STORAGE_VERSION,
      }).threads[0];
      const hydrated = parsedThread ? withoutSummaryHydration(parsedThread) : undefined;
      if (hydrated) {
        revisions.set(storageKey, body.revision as number);
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
      // Snapshot before the asynchronous request. Live stream ingestion uses
      // mutable buffers internally; a caller that keeps appending while this
      // save is in flight must not mutate the baseline associated with the
      // request body that was already sent.
      const savedCollection = snapshotCollection(collection);
      const patch = createCollectionPatch(baseline, savedCollection);
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
      baselines.set(storageKey, savedCollection);
    },
  };
}

function snapshotCollection(collection: AgentThreadCollection): AgentThreadCollection {
  return {
    ...(collection.activeThreadId ? { activeThreadId: collection.activeThreadId } : {}),
    // Event payloads are immutable. Copy only the mutable ownership boundaries
    // so a hot stream cannot change this save's baseline without duplicating
    // large tool output and transcript strings every checkpoint.
    threads: collection.threads.map((thread) => ({
      ...thread,
      events: [...thread.events],
    })),
    version: collection.version,
  };
}

function withoutSummaryHydration(thread: AgentThread): AgentThread {
  const { hydration: _summaryMarker, ...hydrated } = thread;
  return hydrated;
}

function createCollectionPatch(
  baseline: AgentThreadCollection,
  collection: AgentThreadCollection,
): {
  readonly activeThreadId: string | null;
  readonly deletedThreadIds: readonly string[];
  readonly eventAppends: readonly {
    readonly events: AgentThreadCollection["threads"][number]["events"];
    readonly threadId: string;
  }[];
  readonly upsertThreads: AgentThreadCollection["threads"];
  readonly version: number;
} {
  const previousThreads = new Map(baseline.threads.map((thread) => [thread.id, thread]));
  const nextIds = new Set(collection.threads.map((thread) => thread.id));
  const eventAppends: {
    readonly events: AgentThreadCollection["threads"][number]["events"];
    readonly replaceFrom?: number;
    readonly threadId: string;
  }[] = [];
  const upsertThreads = collection.threads.flatMap((thread) => {
    const previous = previousThreads.get(thread.id);
    if (!previous) return [thread];
    const delta = appendOnlyEventDelta(previous.events, thread.events);
    if (delta) {
      if (delta.events.length > 0) eventAppends.push({
        events: delta.events,
        // A bounded transcript starts at an absolute event-log offset. The
        // local array index is only suitable for the in-memory diff; translate
        // replacement checkpoints back to the server's absolute index so a
        // cumulative tool-input update cannot overwrite older turns.
        ...(delta.replaceFrom === previous.events.length ? {} : {
          replaceFrom: (previous.transcriptWindow?.startIndex ?? 0) + delta.replaceFrom,
        }),
        threadId: thread.id,
      });
      return [{ ...thread, events: [], hydration: "summary" as const }];
    }
    if (sameEventIds(previous.events, thread.events)) {
      return [{ ...thread, events: [], hydration: "summary" as const }];
    }
    // A reconnect/remount can temporarily expose a shorter in-memory snapshot
    // than the server's append-only transcript. Never let that stale view
    // replace durable history. Only the explicit edit/resubmit transaction is
    // allowed to truncate the event log.
    if (!isExplicitTranscriptReplacement(thread)) {
      return [{ ...thread, events: [], hydration: "summary" as const }];
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

function isExplicitTranscriptReplacement(thread: AgentThread): boolean {
  return thread.pendingTurn?.state === "clearing" ||
    thread.pendingTurn?.state === "resubmitting";
}

function appendOnlyEventDelta(
  previous: AgentThreadCollection["threads"][number]["events"],
  next: AgentThreadCollection["threads"][number]["events"],
): { readonly events: AgentThreadCollection["threads"][number]["events"]; readonly replaceFrom: number } | undefined {
  if (next.length < previous.length) return undefined;
  let firstDifference = -1;
  for (let index = 0; index < previous.length; index += 1) {
    if (eventIdentity(previous[index]!) !== eventIdentity(next[index]!)) {
      firstDifference = index;
      break;
    }
  }
  if (firstDifference < 0) firstDifference = previous.length;
  // A normal checkpoint may replace one cumulative snapshot in place, but it
  // must leave every later event at the same position. If the suffix shifted,
  // this is a reordered/recovered snapshot rather than an append delta; let
  // the conflict path or authoritative repair handle it instead of replacing
  // durable history with an ambiguous array.
  for (let index = firstDifference + 1; index < previous.length; index += 1) {
    if (eventIdentity(previous[index]!) !== eventIdentity(next[index]!)) return undefined;
  }
  return { events: next.slice(firstDifference), replaceFrom: firstDifference };
}

function sameEventIds(
  left: AgentThread["events"],
  right: AgentThread["events"],
): boolean {
  return left.length === right.length && left.every((event, index) =>
    right[index] !== undefined && eventIdentity(event) === eventIdentity(right[index]),
  );
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

function isTranscriptWindow(value: unknown): value is AgentTranscriptWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const startIndex = candidate.startIndex;
  const endIndex = candidate.endIndex;
  const total = candidate.total;
  return Number.isSafeInteger(startIndex) && (startIndex as number) >= 0 &&
    Number.isSafeInteger(endIndex) && (endIndex as number) >= (startIndex as number) &&
    Number.isSafeInteger(total) && (total as number) >= (endIndex as number) &&
    typeof candidate.hasMoreBefore === "boolean";
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

function repairCollectionUrl(
  endpoint: string,
  storageKey: string,
  query?: Readonly<Record<string, string>>,
): string {
  const url = `${endpoint}/${encodeURIComponent(storageKey)}/repair`;
  if (!query) return url;
  const search = new URLSearchParams(query);
  return `${url}?${search.toString()}`;
}

function revisionFromEtag(value: string | null): number | undefined {
  const match = value ? /^(?:W\/)?"(\d+)"$/.exec(value.trim()) : undefined;
  const revision = match?.[1] ? Number(match[1]) : undefined;
  return Number.isSafeInteger(revision) ? revision : undefined;
}
