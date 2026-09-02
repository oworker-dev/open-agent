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
  /** Abort a storage request instead of leaving the workspace in Loading forever. */
  readonly requestTimeoutMs?: number;
  /** Retry only idempotent GET reads after transient transport/status failures. */
  readonly readRetryLimit?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_READ_RETRY_LIMIT = 2;
const MAX_READ_RETRY_LIMIT = 3;

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
  const requestTimeoutMs = boundedInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    1_000,
    MAX_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs",
  );
  const readRetryLimit = boundedInteger(
    options.readRetryLimit ?? DEFAULT_READ_RETRY_LIMIT,
    0,
    MAX_READ_RETRY_LIMIT,
    "readRetryLimit",
  );
  const revisions = new Map<string, number>();
  const baselines = new Map<string, AgentThreadCollection>();
  let preferredThreadId = options.initialThreadId;

  return {
    async load(storageKey) {
      const knownRevision = revisions.get(storageKey);
      const { response, body } = await request(
        fetchImplementation,
        options,
        collectionUrl(endpoint, storageKey, {
          ...(preferredThreadId ? { threadId: preferredThreadId } : {}),
          view: "index",
        }),
        {
          ...(knownRevision === undefined ? {} : { headers: { "if-none-match": `"${knownRevision}"` } }),
          requestTimeoutMs,
          readRetryLimit,
        },
        readCollectionResponse,
      );
      if (response.status === 304) {
        const cached = baselines.get(storageKey);
        if (cached && knownRevision !== undefined) return cached;
        throw new AgentThreadStorageHttpError(304, "The Agent thread index cache is unavailable.");
      }
      await requireOk(response);
      if (!body) throw new Error("Agent thread storage returned an empty collection response.");
      revisions.set(storageKey, body.revision);
      baselines.set(storageKey, body.collection);
      return body.collection;
    },
    async loadThread(storageKey, threadId) {
      preferredThreadId = threadId;
      const { response, body } = await request(
        fetchImplementation,
        options,
        collectionUrl(endpoint, storageKey, { threadId }),
        { requestTimeoutMs, readRetryLimit },
        readThreadResponse,
      );
      await requireOk(response);
      if (!body) throw new Error("Agent thread storage returned an empty thread response.");
      if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) {
        throw new Error("Agent thread storage returned an invalid revision.");
      }
      revisions.set(storageKey, body.revision as number);
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
      const { response, body } = await request(
        fetchImplementation,
        options,
        collectionUrl(endpoint, storageKey, query),
        { requestTimeoutMs, readRetryLimit },
        readThreadWindowResponse,
      );
      await requireOk(response);
      if (!body) throw new Error("Agent thread storage returned an empty transcript response.");
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
            transcriptWindow: body.eventWindow,
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
      const { response, body } = await request(
        fetchImplementation,
        options,
        repairCollectionUrl(endpoint, storageKey, { threadId }),
        {
          headers: { "content-type": "application/json" },
          method: "POST",
          requestTimeoutMs,
          readRetryLimit: 0,
        },
        readThreadResponse,
      );
      if (response.status === 404) return undefined;
      await requireOk(response);
      if (!body) throw new Error("Agent thread storage returned an empty repair response.");
      if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) {
        throw new Error("Agent thread storage returned an invalid revision.");
      }
      revisions.set(storageKey, body.revision as number);
      if (body.thread == null) return undefined;
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
      // Snapshot before the asynchronous request. Live stream ingestion uses
      // mutable buffers internally; a caller that keeps appending while this
      // save is in flight must not mutate the baseline associated with the
      // request body that was already sent.
      const savedCollection = snapshotCollection(collection);
      const patch = createCollectionPatch(baseline, savedCollection);
      const { response } = await request(
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
          requestTimeoutMs,
          readRetryLimit: 0,
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
      // The server stores stream events in the append-only event table. When a
      // reconnect exposes a reordered/shorter snapshot, the patch deliberately
      // appends only event identities that were not in the previous baseline;
      // keep those durable events in the next diff baseline as well. Setting
      // the raw (incomplete) browser snapshot here would cause every following
      // checkpoint to rediscover the same history as missing and could make a
      // later edit replace the wrong prefix.
      baselines.set(storageKey, baselineAfterPatch(baseline, savedCollection, patch));
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

function baselineAfterPatch(
  previous: AgentThreadCollection,
  next: AgentThreadCollection,
  patch: ReturnType<typeof createCollectionPatch>,
): AgentThreadCollection {
  const appends = new Map(patch.eventAppends.map((entry) => [entry.threadId, entry]));
  const previousThreads = new Map(previous.threads.map((thread) => [thread.id, thread]));
  const deleted = new Set(patch.deletedThreadIds);
  return {
    ...(next.activeThreadId ? { activeThreadId: next.activeThreadId } : {}),
    threads: next.threads
      .filter((thread) => !deleted.has(thread.id))
      .map((thread) => {
        const prior = previousThreads.get(thread.id);
        if (!prior) return thread;
        if (isExplicitTranscriptReplacement(thread)) return thread;
        const append = appends.get(thread.id);
        if (!append || append.events.length === 0) {
          return { ...thread, events: [...prior.events] };
        }
        if (append.replaceFrom === undefined) {
          const seen = new Set(prior.events.map(eventIdentity));
          const merged = [...prior.events];
          for (const event of append.events) {
            if (seen.has(eventIdentity(event))) continue;
            seen.add(eventIdentity(event));
            merged.push(event);
          }
          return { ...thread, events: merged };
        }
        // A replacement checkpoint carried the complete local transcript (or
        // a bounded window with an absolute cursor). The browser snapshot is
        // the best baseline for that operation; the server validates its
        // prefix before applying it.
        return thread;
      }),
    version: next.version,
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
    readonly replaceFrom?: number;
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
    if (!previous) return [withoutTranscriptWindow(thread)];
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
      return [withoutTranscriptWindow({ ...thread, events: [], hydration: "summary" as const })];
    }
    if (sameEventIds(previous.events, thread.events)) {
      return [withoutTranscriptWindow({ ...thread, events: [], hydration: "summary" as const })];
    }
    // A reconnect/remount can temporarily expose a shorter in-memory snapshot
    // than the server's append-only transcript. Never let that stale view
    // replace durable history. Only the explicit edit/resubmit transaction is
    // allowed to truncate the event log.
    if (!isExplicitTranscriptReplacement(thread)) {
      // A reconnect can expose a snapshot whose ordering/length no longer
      // matches the last local baseline. Do not silently turn that change into
      // a metadata-only checkpoint: retain every event identity that is new to
      // the baseline and append it in stream order. Existing durable events
      // remain untouched, so this path is lossless even when the snapshot is
      // only a partial tail.
      const unseen = thread.events.filter((event) => {
        const identity = eventIdentity(event);
        return !previous.events.some((candidate) => eventIdentity(candidate) === identity);
      });
      if (unseen.length > 0) {
        eventAppends.push({ events: unseen, threadId: thread.id });
      }
      return [withoutTranscriptWindow({ ...thread, events: [], hydration: "summary" as const })];
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

function withoutTranscriptWindow(thread: AgentThread): AgentThread {
  const { transcriptWindow: _derivedWindow, ...persisted } = thread;
  return persisted;
}

function isExplicitTranscriptReplacement(thread: AgentThread): boolean {
  const pending = thread.pendingTurn;
  if (!pending) return false;
  // Only legacy browser clear/resubmit snapshots may carry a shortened event
  // array. Server-owned edits keep Eve's append-only audit stream intact.
  return pending.state === "clearing" ||
    pending.state === "resubmitting";
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

async function request<T = never>(
  fetchImplementation: typeof globalThis.fetch,
  options: HttpAgentThreadStorageOptions,
  url: string,
  init?: RequestInit & {
    readonly readRetryLimit?: number;
    readonly requestTimeoutMs?: number;
  },
  read?: (response: Response) => Promise<T>,
): Promise<{ readonly body?: T; readonly response: Response }> {
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
      if (attempt >= retryLimit || !isRetryableReadStatus(response.status)) {
        if (read && response.ok) {
          try {
            return { body: await read(response), response };
          } catch (error) {
            if (attempt >= retryLimit || !isRetryableReadError(error)) throw error;
            attempt += 1;
            await sleepWithRetryAfter(undefined, attempt);
            continue;
          }
        }
        return { response };
      }
      await response.body?.cancel().catch(() => undefined);
      attempt += 1;
      await sleepWithRetryAfter(response.headers.get("retry-after"), attempt);
    } catch (error) {
      if (attempt >= retryLimit || !isRetryableReadError(error)) throw error;
      attempt += 1;
      await sleepWithRetryAfter(undefined, attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function resolveAccessToken(
  getter: HttpAgentThreadStorageOptions["getAccessToken"],
  timeoutMs: number,
): Promise<string | undefined> {
  if (!getter) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(getter),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Agent thread storage access token timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function isRetryableReadStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableReadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // A truncated chunked body can surface as TypeError in fetch implementations
  // or SyntaxError when response.json() sees an incomplete JSON document.
  return error instanceof TypeError || error instanceof SyntaxError ||
    error.name === "AbortError" || error.name === "TimeoutError";
}

async function sleepWithRetryAfter(header: string | null | undefined, attempt: number): Promise<void> {
  const retryAfterSeconds = header ? Number(header) : NaN;
  const serverDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? Math.min(5_000, retryAfterSeconds * 1_000)
    : 0;
  const exponential = Math.min(2_000, 250 * 2 ** Math.max(0, attempt - 1));
  const delay = Math.max(serverDelay, exponential) + Math.floor(Math.random() * 100);
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
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

type ThreadResponse = { revision?: unknown; thread?: unknown };
type ThreadWindowResponse = { eventWindow?: unknown; revision?: unknown; thread?: unknown };

async function readThreadResponse(response: Response): Promise<ThreadResponse> {
  return await response.json() as ThreadResponse;
}

async function readThreadWindowResponse(response: Response): Promise<ThreadWindowResponse> {
  return await response.json() as ThreadWindowResponse;
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
