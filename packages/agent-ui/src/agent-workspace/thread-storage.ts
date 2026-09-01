import type { MessageStreamEvent } from "eve/client";
import type { AgentPendingTurn, AgentQueuedTurn, AgentThread, AgentThreadPreferences, AgentThreadSessionState, AgentThreadStatus, AgentTranscriptCoverage, AgentTranscriptWindow, PromptInputMessage } from "./contracts.js";
import { sanitizeRetainedContext } from "./retained-context.js";

export const AGENT_THREAD_STORAGE_VERSION = 2;
const EMPTY_SESSION: AgentThreadSessionState = { streamIndex: 0 };
const FALLBACK_PREFERENCES: AgentThreadPreferences = {
  executionMode: "standard",
  modelId: "default",
  reasoning: "medium",
};

/**
 * Returns the durable identity of one edit transaction.
 *
 * Editing is retried by both the mounted workspace and a freshly hydrated
 * workspace. A random id makes those retries look like different mailbox
 * messages, so the same edit can be admitted more than once. Keep the id
 * deterministic for the exact session/turn/text tuple; the mailbox already
 * rejects a changed payload under the same id.
 */
export function editOperationId(
  sessionId: string,
  beforeTurnId: string,
  text: string,
): string {
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

function toHex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

export type AgentThreadCollection = {
  readonly activeThreadId?: string;
  readonly threads: readonly AgentThread[];
  readonly version: number;
};

export type AgentThreadStorage = {
  load(storageKey: string): AgentThreadCollection | Promise<AgentThreadCollection>;
  loadThread?(storageKey: string, threadId: string): AgentThread | undefined | Promise<AgentThread | undefined>;
  loadThreadWindow?(
    storageKey: string,
    threadId: string,
    options?: { readonly before?: number; readonly limit?: number },
  ): Promise<{ readonly thread: AgentThread; readonly window: AgentTranscriptWindow } | undefined>;
  /** Rebuilds an unverified settled Eve transcript on the host/server. */
  repairThread?(storageKey: string, threadId: string): AgentThread | undefined | Promise<AgentThread | undefined>;
  save(storageKey: string, collection: AgentThreadCollection): void | Promise<void>;
};

/**
 * Merge a local checkpoint with a collection loaded after a storage revision
 * conflict. Remote event history is authoritative for normal append races;
 * an explicit edit/resubmit is the only operation allowed to replace it.
 */
export function mergeThreadCollectionsForConflict(
  local: AgentThreadCollection,
  remote: AgentThreadCollection,
): AgentThreadCollection {
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

function mergeConflictEvents(
  local: AgentThread,
  remote: AgentThread,
): AgentThread["events"] {
  const localEvents = local.events;
  const remoteEvents = remote.events;
  if (remoteEvents.length === 0) return localEvents;
  if (localEvents.length === 0) return remoteEvents;
  const localIds = new Set(localEvents.map(eventIdentity));
  const remoteIds = new Set(remoteEvents.map(eventIdentity));
  const localSubsetOfRemote = [...localIds].every((id) => remoteIds.has(id));
  const remoteSubsetOfLocal = [...remoteIds].every((id) => localIds.has(id));
  if (localSubsetOfRemote) return remoteEvents;
  if (remoteSubsetOfLocal) return localEvents;

  // Preserve the remote order and append only genuinely new local events.
  // This avoids replacing an authoritative range with an old compact prefix.
  const merged = [...remoteEvents];
  const mergedIds = new Set(remoteIds);
  for (const event of localEvents) {
    const id = eventIdentity(event);
    if (mergedIds.has(id)) continue;
    merged.push(event);
    mergedIds.add(id);
  }
  return compactThreadEvents(merged);
}

export const browserThreadStorage: AgentThreadStorage = {
  load: loadThreadCollection,
  save(storageKey, collection) {
    saveThreadCollection(storageKey, collection.threads, collection.activeThreadId);
  },
};

export function createAgentThread(
  now = Date.now(),
  title = "New session",
  preferences: AgentThreadPreferences = FALLBACK_PREFERENCES,
): AgentThread {
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

export function loadThreadCollection(storageKey: string): AgentThreadCollection {
  if (typeof window === "undefined") {
    return { threads: [], version: AGENT_THREAD_STORAGE_VERSION };
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return { threads: [], version: AGENT_THREAD_STORAGE_VERSION };
    return parseThreadCollection(JSON.parse(raw));
  } catch {
    return { threads: [], version: AGENT_THREAD_STORAGE_VERSION };
  }
}

export function parseThreadCollection(value: unknown): AgentThreadCollection {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== AGENT_THREAD_STORAGE_VERSION) ||
    !Array.isArray(value.threads)
  ) {
    return { threads: [], version: AGENT_THREAD_STORAGE_VERSION };
  }

  const threads = value.threads
    .map(parseThread)
    .filter((thread): thread is AgentThread => !!thread);
  const activeThreadId =
    typeof value.activeThreadId === "string" &&
    threads.some((thread) => thread.id === value.activeThreadId)
      ? value.activeThreadId
      : undefined;

  return { activeThreadId, threads, version: AGENT_THREAD_STORAGE_VERSION };
}

export function saveThreadCollection(
  storageKey: string,
  threads: readonly AgentThread[],
  activeThreadId?: string,
): boolean {
  if (typeof window === "undefined") return false;

  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        activeThreadId,
        threads,
        version: AGENT_THREAD_STORAGE_VERSION,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function titleFromPrompt(prompt: string): string {
  const compact = prompt.replaceAll(/\s+/g, " ").trim();
  if (compact.length === 0) return "New session";
  return compact.length > 42 ? `${compact.slice(0, 41)}...` : compact;
}

function parseThread(value: unknown): AgentThread | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.title !== "string") return undefined;

  const createdAt = numberOrNow(value.createdAt);
  const updatedAt = numberOrNow(value.updatedAt);
  const preferences = isRecord(value.preferences) ? value.preferences : {};
  const session = isRecord(value.session) ? value.session : {};
  const status = isThreadStatus(value.status) ? value.status : "ready";
  const pendingTurn = parsePendingTurn(value.pendingTurn);
  const draftRestore = parseDraftRestore(value.draftRestore);
  const interruptedTurns = parseInterruptedTurns(value.interruptedTurns);
  const closedInputRequestIds = Array.isArray(value.closedInputRequestIds)
    ? [...new Set(value.closedInputRequestIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0))].slice(-128)
    : [];
  const queuedTurns = Array.isArray(value.queuedTurns)
    ? value.queuedTurns
        .map(parseQueuedTurn)
        .filter((turn): turn is AgentQueuedTurn => turn !== undefined)
        .slice(0, 5)
    : [];
  const retainedContext = sanitizeRetainedContext(value.retainedContext) ?? [];
  const transcriptCoverage = parseTranscriptCoverage(value.transcriptCoverage);
  const transcriptWindow = parseTranscriptWindow(value.transcriptWindow);
  const rawEvents = Array.isArray(value.events)
    ? (value.events as readonly MessageStreamEvent[])
    : [];
  const storedStreamIndex =
    typeof session.streamIndex === "number" && session.streamIndex >= 0
      ? session.streamIndex
      : 0;

  return {
    createdAt,
    closedInputRequestIds,
    ...(draftRestore ? { draftRestore } : {}),
    events: compactThreadEvents(rawEvents),
    ...(value.hydration === "summary" ? { hydration: "summary" as const } : {}),
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

function parseTranscriptWindow(value: unknown): AgentTranscriptWindow | undefined {
  if (!isRecord(value) ||
      typeof value.startIndex !== "number" || !Number.isSafeInteger(value.startIndex) || value.startIndex < 0 ||
      typeof value.endIndex !== "number" || !Number.isSafeInteger(value.endIndex) || value.endIndex < value.startIndex ||
      typeof value.total !== "number" || !Number.isSafeInteger(value.total) || value.total < value.endIndex ||
      typeof value.hasMoreBefore !== "boolean") return undefined;
  return {
    endIndex: value.endIndex,
    hasMoreBefore: value.hasMoreBefore,
    startIndex: value.startIndex,
    total: value.total,
  };
}

function parseTranscriptCoverage(value: unknown): AgentTranscriptCoverage | undefined {
  if (!isRecord(value) || value.version !== 1 ||
      typeof value.startIndex !== "number" || !Number.isSafeInteger(value.startIndex) || value.startIndex < 0 ||
      typeof value.endIndex !== "number" || !Number.isSafeInteger(value.endIndex) || value.endIndex < value.startIndex ||
      typeof value.complete !== "boolean") return undefined;
  return {
    ...(value.authoritative === true ? { authoritative: true } : {}),
    complete: value.complete,
    endIndex: value.endIndex,
    ...(value.projection === "logical-edits-v1" ? { projection: value.projection } : {}),
    startIndex: value.startIndex,
    version: 1,
  };
}

function parseDraftRestore(value: unknown): AgentThread["draftRestore"] {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" || !value.id ||
    typeof value.text !== "string" || !value.text.trim()
  ) return undefined;
  return { id: value.id, text: value.text };
}

function parseInterruptedTurns(value: unknown): NonNullable<AgentThread["interruptedTurns"]> {
  if (!Array.isArray(value)) return [];
  const turns = new Map<string, { eventCount: number; settled?: boolean; streamIndex: number; turnId: string }>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate.turnId !== "string" || !candidate.turnId ||
      typeof candidate.eventCount !== "number" ||
      !Number.isSafeInteger(candidate.eventCount) || candidate.eventCount < 0 ||
      typeof candidate.streamIndex !== "number" ||
      !Number.isSafeInteger(candidate.streamIndex) || candidate.streamIndex < 0
    ) continue;
    turns.set(candidate.turnId, {
      eventCount: candidate.eventCount,
      ...(typeof candidate.settled === "boolean" ? { settled: candidate.settled } : {}),
      streamIndex: candidate.streamIndex,
      turnId: candidate.turnId,
    });
  }
  return [...turns.values()].slice(-32);
}

function parseQueuedTurn(value: unknown): AgentQueuedTurn | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" || !value.id ||
    typeof value.text !== "string" || !value.text.trim() ||
    typeof value.submittedAt !== "number" || !Number.isFinite(value.submittedAt) ||
    (
      value.state !== "queued" && value.state !== "delivering" &&
      value.state !== "accepted" && value.state !== "committed" &&
      value.state !== "delivery-failed" && value.state !== "admission-ambiguous"
    )
  ) {
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
  if (
    value.intent === "post-cancellation" &&
    (value.delivery !== "browser" || value.state !== "queued" || mailboxItemId)
  ) {
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

function parsePendingTurn(value: unknown): AgentPendingTurn | undefined {
  if (!isRecord(value)) return undefined;
  const files = parsePromptFiles(value.files);
  if (
    typeof value.id !== "string" || !value.id ||
    typeof value.text !== "string" || (!value.text.trim() && files.length === 0) ||
    typeof value.submittedAt !== "number" || !Number.isFinite(value.submittedAt) ||
    (value.state !== "clearing" && value.state !== "submitting" && value.state !== "resubmitting" && value.state !== "delivery-failed" && value.state !== "interrupted")
  ) {
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

function parsePromptFiles(value: unknown): PromptInputMessage["files"] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PENDING_FILES).flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.mediaType !== "string" || !candidate.mediaType ||
      typeof candidate.url !== "string" || !candidate.url
    ) return [];
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

export function appendThreadEvent(
  events: readonly MessageStreamEvent[],
  event: MessageStreamEvent,
): readonly MessageStreamEvent[] {
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
    // Keep the incremental event as the visual anchor. Eve may emit the
    // completed boundary after tool events have already been flushed; replacing
    // the anchor with that boundary makes a later replay render reasoning or
    // narration below the tools.
    return [...events, event];
  }
  return [...events, event];
}

/**
 * Append a recovery event without repeatedly scanning the whole transcript.
 * The array is intentionally mutable and owned by one recovery loop; callers
 * publish a shallow copy only at their render/checkpoint boundary.
 */
export function appendThreadEventIndexed(
  events: MessageStreamEvent[],
  eventIds: Set<string>,
  event: MessageStreamEvent,
): boolean {
  const identity = eventIdentity(event);
  if (eventIds.has(identity)) return false;
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
  // Completion is a separate lifecycle boundary. Retain it after the
  // cumulative incremental anchor so the reducer can render the final state
  // while the presenter can still recover the original visual position.
  events.push(event);
  return true;
}

// A live Eve stream can contain thousands of cumulative text/tool snapshots.
// Keep the latest snapshot index beside the mutable event array so each
// append is amortized O(1) instead of scanning the entire transcript. WeakMap
// ownership lets discarded transcripts be collected normally.
const cumulativeIndexesByEvents = new WeakMap<MessageStreamEvent[], Map<CumulativeEventKey, number>>();

function cumulativeIndexFor(
  events: MessageStreamEvent[],
): Map<CumulativeEventKey, number> {
  const existing = cumulativeIndexesByEvents.get(events);
  if (existing) return existing;
  const indexes = new Map<CumulativeEventKey, number>();
  for (let index = 0; index < events.length; index += 1) {
    const key = cumulativeEventKey(events[index]!);
    if (key) indexes.set(key, index);
  }
  cumulativeIndexesByEvents.set(events, indexes);
  return indexes;
}

function findLastCumulativeEventIndex(
  events: readonly MessageStreamEvent[],
  key: CumulativeEventKey,
): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (cumulativeEventKey(events[index]!) === key) return index;
  }
  return undefined;
}

/**
 * Eve streams can replay the same event through more than one client
 * subscription, especially while a React tree is being remounted. Events
 * without `meta.id` still need a stable identity; otherwise the transcript
 * and its absolute cursor advance twice for one durable event. Keep the
 * identity deliberately exact: two events with different timestamps, IDs, or
 * payloads remain distinct, while an exact replay is ignored.
 */
export function eventIdentity(event: MessageStreamEvent): string {
  // Eve guarantees that meta.id is stable across reconnects, rewinds, and
  // finished-session replays. Prefer it over the full payload so a transport
  // adapter that normalizes timestamps or fields cannot duplicate one event.
  if (typeof event.meta?.id === "string" && event.meta.id.length > 0) {
    return `id:${event.meta.id}`;
  }
  return `event:${JSON.stringify(event)}`;
}

function hasEventIdentity(events: readonly MessageStreamEvent[], event: MessageStreamEvent): boolean {
  const identity = eventIdentity(event);
  return events.some((candidate) => eventIdentity(candidate) === identity);
}

export function compactThreadEvents(
  events: readonly MessageStreamEvent[],
): readonly MessageStreamEvent[] {
  const compacted: MessageStreamEvent[] = [];
  const identities = new Set<string>();
  const cumulativeIndexes = new Map<string, number>();
  for (const event of events) {
    const identity = eventIdentity(event);
    if (identities.has(identity)) continue;
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
    // Completion is a separate lifecycle boundary. Keep it after the
    // cumulative incremental anchor instead of moving the visual anchor.
    compacted.push(event);
  }
  return compacted;
}

type CumulativeEventKey = string;

function cumulativeEventKey(event: MessageStreamEvent): CumulativeEventKey | undefined {
  if (event.type === "message.appended" || event.type === "reasoning.appended") {
    return `${event.type}:${event.data.turnId}:${event.data.stepIndex}`;
  }
  if (event.type === "action.input.partial") {
    return `${event.type}:${event.data.turnId}:${event.data.stepIndex}:${event.data.callId}`;
  }
  return undefined;
}

/**
 * Cumulative stream events may be emitted again when Eve retries an
 * interrupted durable step. A retry reuses the turn/step key, so replacing an
 * earlier snapshot unconditionally would erase the failed attempt from the
 * transcript. Only replace when the new snapshot is a continuation of the
 * same attempt. A repeated step.started event marks a new attempt; the
 * snapshot-prefix check also protects recovery from a missing boundary event.
 */
function canReplaceCumulativeEvent(
  events: readonly MessageStreamEvent[],
  existingIndex: number,
  next: MessageStreamEvent,
): boolean {
  const existing = events[existingIndex];
  if (!existing || !cumulativeEventKey(existing) || cumulativeEventKey(existing) !== cumulativeEventKey(next)) {
    return false;
  }

  const scope = stepScope(next);
  for (let index = existingIndex + 1; index < events.length; index += 1) {
    const candidate = events[index]!;
    if (candidate.type === "step.started" && stepScope(candidate) === scope) {
      return false;
    }
  }

  const previousSnapshot = cumulativeSnapshot(existing);
  const nextSnapshot = cumulativeSnapshot(next);
  // Eve's cumulative fields are present for all current event versions. If a
  // legacy adapter omits one, retain both events rather than risk data loss.
  if (previousSnapshot === undefined || nextSnapshot === undefined) return false;
  // Provider snapshots are usually textual prefixes. Some adapters serialize
  // a growing JSON value, however, so the newly appended bytes can appear
  // before the closing quote and the full JSON string is no longer a literal
  // prefix. In that case monotonic growth is the only safe signal available;
  // a proper Eve retry still has a repeated step.started boundary above.
  return nextSnapshot.length >= previousSnapshot.length;
}

function stepScope(event: MessageStreamEvent): string | undefined {
  if (event.type === "step.started" ||
      event.type === "message.appended" ||
      event.type === "reasoning.appended" ||
      event.type === "action.input.partial") {
    return `${event.data.turnId}:${event.data.stepIndex}`;
  }
  return undefined;
}

function cumulativeSnapshot(event: MessageStreamEvent): string | undefined {
  if (event.type === "message.appended") return event.data.messageSoFar;
  if (event.type === "reasoning.appended") return event.data.reasoningSoFar;
  if (event.type === "action.input.partial") return event.data.inputTextSoFar;
  return undefined;
}

/** Return a pending browser turn only while the authoritative transcript has
 * not accepted its latest message. Matching is anchored to the latest
 * `message.received` event so an older identical prompt cannot acknowledge a
 * newer retry. */
export function reconcilePendingTurnWithEvents(
  pendingTurn: AgentPendingTurn | undefined,
  events: readonly MessageStreamEvent[],
): AgentPendingTurn | undefined {
  if (!pendingTurn) return undefined;
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
  const accepted = latestReceived?.type === "message.received" && (
    latestReceived.data.clientMessageId === pendingTurn.id ||
    (!hasAuthoritativeClientId && isAfterSubmission && eventCanAcknowledge && pendingTurn.text.trim().length > 0 &&
      latestReceived.data.message.trim() === pendingTurn.text.trim())
  );
  return accepted ? undefined : pendingTurn;
}

/** Hydration must never replay a persisted clear/resubmit operation. */
export function reconcileHydratedPendingTurn(
  pendingTurn: AgentPendingTurn | undefined,
  events: readonly MessageStreamEvent[],
): AgentPendingTurn | undefined {
  const reconciled = reconcilePendingTurnWithEvents(pendingTurn, events);
  if (!reconciled) return undefined;
  // Mailbox edits are server-owned idempotent operations. Refresh may inspect
  // or re-enqueue the same operation id, but must not downgrade it into the
  // legacy browser retry path that could submit a second model turn.
  if (reconciled.operation === "edit" && reconciled.delivery === "server") {
    return reconciled;
  }
  // Hydration is read-only. A stale browser admission must never become a
  // fresh model request merely because the page was refreshed. If Eve did not
  // durably acknowledge it with message.received, expose a retryable failure;
  // the user can explicitly resend after inspecting the state.
  if (reconciled.state !== "clearing" && reconciled.state !== "resubmitting" && reconciled.state !== "submitting") return reconciled;
  return { ...reconciled, state: "delivery-failed" };
}

/**
 * Projects append-only Eve audit events onto the active logical conversation.
 * A context.cleared event carrying a settled turn id is Open Agent's durable
 * edit boundary: that turn and its descendants are superseded, while the audit
 * stream and absolute cursor remain untouched.
 */
export function projectThreadEditBranches(
  events: readonly MessageStreamEvent[],
): readonly MessageStreamEvent[] {
  if (!events.some((event) => event.type === "context.cleared")) return events;
  const projected: MessageStreamEvent[] = [];
  for (const event of events) {
    if (event.type === "context.cleared") {
      const targetTurnId = event.data.turnId;
      // A retried edit can emit another clear marker for the same durable
      // target after its first replacement branch was already appended. Drop
      // that prior replacement before applying the newest one; otherwise a
      // refresh would present each retry as a separate conversation turn.
      const previousClearIndex = projected.findLastIndex((candidate) =>
        candidate.type === "context.cleared" && candidate.data.turnId === targetTurnId,
      );
      if (previousClearIndex >= 0) projected.splice(previousClearIndex);
      let targetIndex = projected.findLastIndex((candidate) =>
        eventTurnId(candidate) === targetTurnId
      );
      // A durable edit always carries the exact `beforeTurnId`. Do not guess
      // a target for older/foreign clear markers: deleting the last user turn
      // by position can silently remove valid history after a refresh. The
      // marker remains in the append-only projection and the runtime's
      // authoritative branch metadata decides whether an older branch is
      // superseded.
      if (targetIndex >= 0) {
        const actualTargetTurnId = eventTurnId(projected[targetIndex]!);
        const turnStartIndex = projected.findLastIndex((candidate, index) =>
          index <= targetIndex && candidate.type === "turn.started" &&
          candidate.data.turnId === actualTargetTurnId
        );
        projected.splice(turnStartIndex >= 0 ? turnStartIndex : targetIndex);
      }
    }
    projected.push(event);
  }
  return projected;
}

/** Hides the addressed latest turn while its durable edit is still queued. */
export function projectPendingThreadEdit(
  events: readonly MessageStreamEvent[],
  beforeTurnId?: string,
): readonly MessageStreamEvent[] {
  if (!beforeTurnId || events.some((event) =>
    event.type === "context.cleared" && event.data.turnId === beforeTurnId
  )) return events;
  const targetIndex = events.findIndex((event) => eventTurnId(event) === beforeTurnId);
  if (targetIndex < 0) return events;
  const turnStartIndex = events.findLastIndex((event, index) =>
    index <= targetIndex && event.type === "turn.started" && event.data.turnId === beforeTurnId
  );
  return events.slice(0, turnStartIndex >= 0 ? turnStartIndex : targetIndex);
}

/**
 * Returns the latest user turn that can be used as an edit checkpoint.
 *
 * The rendered assistant-ui message may carry a stable display alias after
 * one or more edits, so its sourceId is not a durable Eve turn id. The latest
 * accepted receipt in the projected event stream is authoritative instead.
 * A turn that failed with Eve's revert-conflict marker never established a
 * checkpoint and must not be selected again on a retry.
 */
export function latestEditableTurnId(
  events: readonly MessageStreamEvent[],
): string | undefined {
  const conflictTurns = new Set(events.flatMap((event) =>
    event.type === "turn.failed" && event.data.code === "turn_revert_conflict"
      ? [event.data.turnId]
      : [],
  ));
  for (const event of [...events].reverse()) {
    if (event.type !== "message.received" || typeof event.data.turnId !== "string") continue;
    if (conflictTurns.has(event.data.turnId)) continue;
    return event.data.turnId;
  }
  return undefined;
}

function eventTurnId(event: MessageStreamEvent): string | undefined {
  return "data" in event && "turnId" in event.data && typeof event.data.turnId === "string"
    ? event.data.turnId
    : undefined;
}

/** Remove exact stream replays while preserving incremental/completed pairs. */
export function dedupeThreadEvents(
  events: readonly MessageStreamEvent[],
): readonly MessageStreamEvent[] {
  const seen = new Set<string>();
  const deduped: MessageStreamEvent[] = [];
  for (const event of events) {
    const identity = eventIdentity(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    deduped.push(event);
  }
  return deduped;
}

function isExecutionMode(value: unknown): value is AgentThreadPreferences["executionMode"] {
  return value === "automation" || value === "cautious" || value === "standard";
}

function createId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `thread-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThreadStatus(value: unknown): value is AgentThreadStatus {
  return value === "cancelling" || value === "error" || value === "ready" ||
    value === "streaming" || value === "submitted" || value === "waiting";
}

function numberOrNow(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
