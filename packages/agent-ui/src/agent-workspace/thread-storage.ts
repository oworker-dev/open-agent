import { conversationOf, type SessionStreamEvent } from "eve/client";
import { conversation } from "eve/events";
import { parseAssetPrompt } from "@oworker/open-agent-contracts/asset";
import type { AgentInputResponseSubmission, AgentPendingTurn, AgentQueuedTurn, AgentThread, AgentThreadPreferences, AgentThreadSessionState, AgentThreadStatus, AgentTranscriptCoverage, AgentTranscriptWindow, PromptInputMessage } from "./contracts.js";
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
    const events = mergeConflictEvents(thread, existing);
    byId.set(thread.id, {
      ...selected,
      events,
      inputResponseSubmissions: mergeInputResponseSubmissions(
        thread.inputResponseSubmissions ?? [],
        existing.inputResponseSubmissions ?? [],
      ),
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

  // Concurrent checkpoints may overlap. Eve's immutable source positions,
  // rather than browser arrival order or timestamps, define replay order.
  return mergeThreadEventSnapshots(localEvents, remoteEvents);
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
  const inputResponseSubmissions = parseInputResponseSubmissions(value.inputResponseSubmissions);
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
  let transcriptCoverage = parseTranscriptCoverage(value.transcriptCoverage);
  const transcriptWindow = parseTranscriptWindow(value.transcriptWindow);
  const cachedEvents = Array.isArray(value.events)
    ? (value.events as readonly SessionStreamEvent[])
    : [];
  // Invalidate an incompatible cache, preserving the session address needed
  // to rebuild it from the authoritative stream. Never replay old metadata.
  const validCache = cachedEvents.every(isThreadEvent);
  const rawEvents = validCache ? cachedEvents : [];
  if (!validCache) transcriptCoverage = undefined;
  const storedStreamIndex =
    typeof session.streamIndex === "number" && Number.isSafeInteger(session.streamIndex) && session.streamIndex >= 0
      ? session.streamIndex
      : transcriptWindow?.endIndex ?? (transcriptCoverage?.complete ? transcriptCoverage.endIndex : cursorAfterEvents(rawEvents));

  return {
    createdAt,
    closedInputRequestIds,
    ...(draftRestore ? { draftRestore } : {}),
    events: compactThreadEvents(rawEvents),
    ...(value.hydration === "summary" ? { hydration: "summary" as const } : {}),
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

function cursorAfterEvents(events: readonly SessionStreamEvent[]): number {
  const last = events.at(-1);
  if (!last || !Number.isSafeInteger(last.meta?.position?.line)) return 0;
  if (Number.isSafeInteger(last.meta.next)) return last.meta.next!;
  return last.meta.endOfLine === false ? last.meta.position.line : last.meta.position.line + 1;
}

function parseInputResponseSubmissions(value: unknown): readonly AgentInputResponseSubmission[] {
  if (!Array.isArray(value)) return [];
  const submissions = new Map<string, AgentInputResponseSubmission>();
  for (const candidate of value) {
    if (!isRecord(candidate) ||
        typeof candidate.id !== "string" || !candidate.id ||
        !Array.isArray(candidate.responses) || candidate.responses.length === 0 ||
        typeof candidate.streamIndexAtSubmission !== "number" ||
        !Number.isSafeInteger(candidate.streamIndexAtSubmission) || candidate.streamIndexAtSubmission < 0 ||
        typeof candidate.submittedAt !== "number" || !Number.isFinite(candidate.submittedAt) ||
        !isInputResponseSubmissionState(candidate.state)) continue;
    const responses = candidate.responses.flatMap((response) => {
      if (!isRecord(response) || typeof response.interactionId !== "string" || !response.interactionId) return [];
      const optionId = typeof response.optionId === "string" && response.optionId ? response.optionId : undefined;
      const text = typeof response.text === "string" && response.text ? response.text : undefined;
      if (!optionId && !text) return [];
      return [{ ...(optionId ? { optionId } : {}), interactionId: response.interactionId, ...(text ? { text } : {}) }];
    });
    if (responses.length !== candidate.responses.length) continue;
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

function isInputResponseSubmissionState(value: unknown): value is AgentInputResponseSubmission["state"] {
  return value === "submitting" || value === "accepted" || value === "cancelled" ||
    value === "committed" || value === "delivering" || value === "failed" ||
    value === "queued" || value === "submission-ambiguous";
}

export function mergeInputResponseSubmissions(
  left: readonly AgentInputResponseSubmission[],
  right: readonly AgentInputResponseSubmission[],
): readonly AgentInputResponseSubmission[] {
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

export function inputResponseSubmissionFailure(
  submission: AgentInputResponseSubmission,
  events: readonly SessionStreamEvent[],
): string | undefined {
  for (const answer of submission.responses) {
    const submitted = events.find((event) => event.type === "response.submitted" &&
      event.meta.position.line >= submission.streamIndexAtSubmission &&
      event.data.interactionId === answer.interactionId &&
      event.data.value?.optionId === answer.optionId && event.data.value?.text === answer.text);
    if (submitted?.type !== "response.submitted") continue;
    const settled = events.find((event) => event.type === "response.settled" &&
      event.data.responseId === submitted.data.responseId);
    if (settled?.type === "response.settled" && settled.data.outcome !== "applied") {
      return settled.data.reason || "The response was not accepted. Please try again.";
    }
  }
  return undefined;
}

export function inputResponseSubmissionProjectsAnswer(
  submission: AgentInputResponseSubmission,
  events: readonly SessionStreamEvent[] = [],
): boolean {
  return submission.state !== "failed" && submission.state !== "cancelled" &&
    inputResponseSubmissionFailure(submission, events) === undefined;
}

export function hasUnsettledInputResponseSubmission(
  submissions: readonly AgentInputResponseSubmission[],
): boolean {
  return submissions.some((submission) =>
    submission.settledAtStreamIndex === undefined &&
    inputResponseSubmissionProjectsAnswer(submission)
  );
}

export function settleInputResponseSubmissions(
  submissions: readonly AgentInputResponseSubmission[],
  streamIndex: number,
): readonly AgentInputResponseSubmission[] {
  let changed = false;
  const settled = submissions.map((submission) => {
    if (submission.settledAtStreamIndex !== undefined ||
        !inputResponseSubmissionProjectsAnswer(submission) ||
        streamIndex <= submission.streamIndexAtSubmission) return submission;
    changed = true;
    return { ...submission, settledAtStreamIndex: streamIndex };
  });
  return changed ? settled : submissions;
}

function inputResponseStateRank(state: AgentInputResponseSubmission["state"]): number {
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
    ...(value.projection === "v27-source-lines" ? { projection: value.projection } : {}),
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
  const turns = new Map<string, NonNullable<AgentThread["interruptedTurns"]>[number]>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate.turnId !== "string" || !candidate.turnId ||
      typeof candidate.eventCount !== "number" ||
      !Number.isSafeInteger(candidate.eventCount) || candidate.eventCount < 0 ||
      typeof candidate.streamIndex !== "number" ||
      !Number.isSafeInteger(candidate.streamIndex) || candidate.streamIndex < 0
    ) continue;
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

function parsePendingTurn(value: unknown): AgentPendingTurn | undefined {
  if (!isRecord(value)) return undefined;
  const files = parsePromptFiles(value.files);
  if (
    typeof value.id !== "string" || !value.id ||
    typeof value.text !== "string" || (!value.text.trim() && files.length === 0) ||
    typeof value.submittedAt !== "number" || !Number.isFinite(value.submittedAt) ||
    (value.state !== "submitting" && value.state !== "delivery-failed" && value.state !== "interrupted")
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
  events: readonly SessionStreamEvent[],
  event: SessionStreamEvent,
): readonly SessionStreamEvent[] {
  if (events.some((candidate) => eventIdentity(candidate) === eventIdentity(event))) return events;
  const next = [...events];
  insertEventInPositionOrder(next, event);
  return next;
}

/**
 * Append a recovery event without repeatedly scanning the whole transcript.
 * The array is intentionally mutable and owned by one recovery loop; callers
 * publish a shallow copy only at their render/checkpoint boundary.
 */
export function appendThreadEventIndexed(
  events: SessionStreamEvent[],
  eventIds: Set<string>,
  event: SessionStreamEvent,
): boolean {
  const identity = eventIdentity(event);
  if (eventIds.has(identity)) return false;
  eventIds.add(identity);
  insertEventInPositionOrder(events, event);
  return true;
}

/**
 * Merge two render snapshots without allowing a reconnect snapshot to erase
 * events that the live reducer has already observed. The longer snapshot is
 * normally the authoritative one; events unique to the shorter snapshot are
 * retained as a defensive measure for concurrent catch-up.
 */
export function mergeThreadEventSnapshots(
  left: readonly SessionStreamEvent[],
  right: readonly SessionStreamEvent[],
): readonly SessionStreamEvent[] {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const byIdentity = new Map<string, SessionStreamEvent>();
  for (const event of [...left, ...right]) byIdentity.set(eventIdentity(event), event);
  return [...byIdentity.values()].sort(compareEventPosition);
}

/** Order by Eve's immutable event coordinate. Array length is never a cursor. */
function compareEventPosition(left: SessionStreamEvent, right: SessionStreamEvent): number {
  return left.meta.position.line - right.meta.position.line ||
    left.meta.position.index - right.meta.position.index;
}

/**
 * Eve identifies each fact by its source line and its position within the
 * committed line. Progress records use the same coordinate space.
 */
export function eventIdentity(event: SessionStreamEvent): string {
  const { line, index } = event.meta.position;
  return `position:${line}:${index}`;
}

/** Validate the persisted v27 envelope without rewriting reader metadata. */
export function isThreadEvent(value: unknown): value is SessionStreamEvent {
  if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.data) ||
      !isRecord(value.meta) || typeof value.meta.at !== "string" || !isRecord(value.meta.position)) return false;
  const { line, index } = value.meta.position;
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 0 ||
      typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return false;
  if (value.meta.endOfLine !== undefined && typeof value.meta.endOfLine !== "boolean") return false;
  return value.meta.next === undefined || (value.meta.endOfLine !== false &&
    typeof value.meta.next === "number" && Number.isSafeInteger(value.meta.next) && value.meta.next > line);
}

export function threadEventCursor(event: SessionStreamEvent): number | undefined {
  if (!Number.isSafeInteger(event.meta?.position?.line)) return undefined;
  // A source line can contain several facts. Until its final fact arrives,
  // the next unread line is still this line; do not advance the session
  // cursor by fact count or checkpoint a partial commit.
  if (event.meta.next !== undefined) return event.meta.next;
  return event.meta.endOfLine === false ? undefined : event.meta.position.line + 1;
}

function hasEventIdentity(events: readonly SessionStreamEvent[], event: SessionStreamEvent): boolean {
  const identity = eventIdentity(event);
  return events.some((candidate) => eventIdentity(candidate) === identity);
}

export function compactThreadEvents(
  events: readonly SessionStreamEvent[],
): readonly SessionStreamEvent[] {
  const byIdentity = new Map<string, SessionStreamEvent>();
  for (const event of events) byIdentity.set(eventIdentity(event), event);
  return [...byIdentity.values()].sort(compareEventPosition);
}

function insertEventInPositionOrder(
  events: SessionStreamEvent[],
  event: SessionStreamEvent,
): void {
  if (!events.length || compareEventPosition(events[events.length - 1]!, event) <= 0) {
    events.push(event);
    return;
  }
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareEventPosition(events[middle]!, event) <= 0) low = middle + 1;
    else high = middle;
  }
  events.splice(low, 0, event);
}

/** Return a pending browser turn only while the authoritative transcript has
 * not accepted its latest message. Matching is anchored to the latest
 * `delivery.consumed` event so an older identical prompt cannot acknowledge a
 * a newer submission. */
export function reconcilePendingTurnWithEvents(
  pendingTurn: AgentPendingTurn | undefined,
  events: readonly SessionStreamEvent[],
): AgentPendingTurn | undefined {
  if (!pendingTurn) return undefined;
  const accepted = events.some((event) =>
    event.type === "delivery.consumed" && receivedClientMessageId(event) === pendingTurn.id
  );
  return accepted ? undefined : pendingTurn;
}

export function receivedClientMessageId(event: Extract<SessionStreamEvent, { type: "delivery.consumed" }>): string | undefined {
  return parseAssetPrompt(textFromDelivery(event)).clientMessageId;
}

export function textFromDelivery(event: Extract<SessionStreamEvent, { type: "delivery.consumed" }>): string {
  return event.data.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n");
}

/** Hydration never resubmits browser work. */
export function reconcileHydratedPendingTurn(
  pendingTurn: AgentPendingTurn | undefined,
  events: readonly SessionStreamEvent[],
): AgentPendingTurn | undefined {
  const reconciled = reconcilePendingTurnWithEvents(pendingTurn, events);
  if (!reconciled) return undefined;
  // Mailbox edits are server-owned idempotent operations. Refresh may inspect
  // or re-enqueue the same operation id.
  if (reconciled.operation === "edit" && reconciled.delivery === "server") {
    return reconciled;
  }
  // Hydration is read-only. A stale browser admission must never become a
  // fresh model request merely because the page was refreshed. If Eve did not
  // durably acknowledge it with message.received, expose a retryable failure;
  // the user can explicitly resend after inspecting the state.
  if (reconciled.state !== "submitting") return reconciled;
  return { ...reconciled, state: "delivery-failed" };
}

/** The newest selected turn with exactly one user delivery has an edit checkpoint. */
export function latestEditableTurnId(events: readonly SessionStreamEvent[]): string | undefined {
  const latest = conversation(conversationOf(events).view).at(-1);
  if (!latest) return undefined;
  const userReceipts = events.filter((event) => event.type === "delivery.consumed" &&
    event.data.turnId === latest.turnId && event.data.parts.length > 0);
  return userReceipts.length === 1 ? latest.turnId : undefined;
}

/** Remove exact stream replays while preserving incremental/completed pairs. */
export function dedupeThreadEvents(
  events: readonly SessionStreamEvent[],
): readonly SessionStreamEvent[] {
  const seen = new Set<string>();
  const deduped: SessionStreamEvent[] = [];
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
