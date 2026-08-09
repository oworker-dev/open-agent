import type { MessageStreamEvent } from "eve/client";
import type { AgentPendingTurn, AgentQueuedTurn, AgentThread, AgentThreadPreferences, AgentThreadSessionState, AgentThreadStatus, PromptInputMessage } from "./contracts.js";
import { sanitizeRetainedContext } from "./retained-context.js";

export const AGENT_THREAD_STORAGE_VERSION = 2;
const EMPTY_SESSION: AgentThreadSessionState = { streamIndex: 0 };
const FALLBACK_PREFERENCES: AgentThreadPreferences = {
  executionMode: "standard",
  modelId: "default",
  reasoning: "medium",
};

export type AgentThreadCollection = {
  readonly activeThreadId?: string;
  readonly threads: readonly AgentThread[];
  readonly version: number;
};

export type AgentThreadStorage = {
  load(storageKey: string): AgentThreadCollection | Promise<AgentThreadCollection>;
  loadThread?(storageKey: string, threadId: string): AgentThread | undefined | Promise<AgentThread | undefined>;
  save(storageKey: string, collection: AgentThreadCollection): void | Promise<void>;
};

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
    events: compactThreadEvents(rawEvents),
    ...(value.hydration === "summary" ? { hydration: "summary" as const } : {}),
    id: value.id,
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
    title: value.title,
    updatedAt,
  };
}

function parseQueuedTurn(value: unknown): AgentQueuedTurn | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" || !value.id ||
    typeof value.text !== "string" || !value.text.trim() ||
    typeof value.submittedAt !== "number" || !Number.isFinite(value.submittedAt) ||
    (value.state !== "queued" && value.state !== "delivery-failed" && value.state !== "admission-ambiguous")
  ) {
    return undefined;
  }
  return {
    ...(value.delivery === "server" || value.delivery === "browser"
      ? { delivery: value.delivery }
      : {}),
    id: value.id,
    ...(typeof value.mailboxItemId === "string" && value.mailboxItemId
      ? { mailboxItemId: value.mailboxItemId }
      : {}),
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
  return {
    ...(files.length > 0 ? { files } : {}),
    id: value.id,
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
  if (event.meta.id && events.some((candidate) => candidate.meta.id === event.meta.id)) {
    return events;
  }
  if (event.type === "message.appended" || event.type === "reasoning.appended") {
    const last = events.at(-1);
    return last?.type === event.type &&
      last.data.turnId === event.data.turnId &&
      last.data.stepIndex === event.data.stepIndex
      ? [...events.slice(0, -1), event]
      : [...events, event];
  }
  if (event.type === "message.completed" || event.type === "reasoning.completed") {
    const incrementalType = event.type === "message.completed"
      ? "message.appended"
      : "reasoning.appended";
    const last = events.at(-1);
    return last?.type === incrementalType &&
      last.data.turnId === event.data.turnId &&
      last.data.stepIndex === event.data.stepIndex
      ? [...events.slice(0, -1), event]
      : [...events, event];
  }
  return [...events, event];
}

export function compactThreadEvents(
  events: readonly MessageStreamEvent[],
): readonly MessageStreamEvent[] {
  const compacted: MessageStreamEvent[] = [];
  for (const event of events) {
    if (event.type === "message.appended" || event.type === "reasoning.appended") {
      const last = compacted.at(-1);
      if (
        last?.type === event.type &&
        last.data.turnId === event.data.turnId &&
        last.data.stepIndex === event.data.stepIndex
      ) {
        compacted[compacted.length - 1] = event;
        continue;
      }
    }
    if (event.type === "message.completed" || event.type === "reasoning.completed") {
      const incrementalType = event.type === "message.completed"
        ? "message.appended"
        : "reasoning.appended";
      const last = compacted.at(-1);
      if (
        last?.type === incrementalType &&
        last.data.turnId === event.data.turnId &&
        last.data.stepIndex === event.data.stepIndex
      ) {
        compacted[compacted.length - 1] = event;
        continue;
      }
    }
    compacted.push(event);
  }
  return compacted;
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
  return value === "error" || value === "ready" || value === "streaming" || value === "submitted" || value === "waiting";
}

function numberOrNow(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
