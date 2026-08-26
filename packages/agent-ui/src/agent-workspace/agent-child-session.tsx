"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageStreamEvent } from "eve/client";
import { AgentThreadView } from "./agent-thread.js";
import { attachAgentSession, createAgentSession } from "./agent-client.js";
import type {
  AgentModelOption,
  AgentPromptMenuItem,
  AgentSessionDeliverable,
  AgentThread,
  AgentThreadPatch,
  AgentThreadPreferences,
  AgentWorkspaceClientConfig,
  AgentWorkspaceMailbox,
} from "./contracts.js";
import type { AgentLocale } from "./i18n.js";
import { AGENT_THREAD_STORAGE_VERSION, compactThreadEvents, type AgentThreadCollection, type AgentThreadStorage } from "./thread-storage.js";

/**
 * Child sessions intentionally use the same thread controller and assistant-ui
 * surface as root sessions. The parent workspace owns navigation only; it must
 * not replay a child stream with a separate read-only renderer.
 */
export function AgentChildSessionView({
  client,
  commands,
  locale,
  mailbox,
  mentions,
  models,
  onEvent,
  onOpenDeliverable,
  onOpenSubagent,
  onStorageError,
  preferences,
  providerReady = true,
  reasoningLevels,
  sessionId,
  storageKey,
  threadStorage,
}: {
  readonly client?: AgentWorkspaceClientConfig;
  readonly commands: readonly AgentPromptMenuItem[];
  readonly locale: AgentLocale;
  readonly mailbox?: AgentWorkspaceMailbox;
  readonly mentions: readonly AgentPromptMenuItem[];
  readonly models: readonly AgentModelOption[];
  readonly onEvent?: (event: MessageStreamEvent) => void;
  readonly onOpenDeliverable?: (deliverable: AgentSessionDeliverable) => void;
  readonly onOpenSubagent?: (sessionId: string) => void;
  readonly onStorageError?: (error: unknown) => void;
  readonly preferences: AgentThreadPreferences;
  readonly providerReady?: boolean;
  readonly reasoningLevels: readonly string[];
  readonly sessionId: string;
  /** Optional host storage for client-only child state such as queued follow-ups. */
  readonly storageKey?: string;
  readonly threadStorage?: AgentThreadStorage;
}) {
  const [thread, setThread] = useState<AgentThread>();
  const [loadError, setLoadError] = useState<string>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const pendingPersistRef = useRef<AgentThread | undefined>(undefined);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const childStorageKey = storageKey ? `${storageKey}:subagent:${sessionId}` : undefined;

  const flushPersistedChild = useCallback(() => {
    const next = pendingPersistRef.current;
    if (!next || !childStorageKey || !threadStorage) return;
    pendingPersistRef.current = undefined;
    const boundedStorage = Boolean(threadStorage.loadThreadWindow);
    const persisted: AgentThread = {
      ...next,
      // Persist event deltas through the append-only HTTP storage adapter. It
      // sends only the new suffix while retaining the full transcript in the
      // event table for bounded hydration on the next open.
      ...(boundedStorage ? { events: [...next.events], hydration: undefined as undefined, session: { ...next.session } } : {
        // Browser-only/custom legacy stores intentionally retain the old
        // summary behavior. Eve remains authoritative there and localStorage
        // must never receive an unbounded transcript copy.
        events: [],
        hydration: "summary" as const,
        session: { streamIndex: 0 },
      }),
      updatedAt: Date.now(),
    };
    const collection: AgentThreadCollection = {
      activeThreadId: sessionId,
      threads: [persisted],
      version: AGENT_THREAD_STORAGE_VERSION,
    };
    void Promise.resolve(threadStorage.save(childStorageKey, collection)).catch((error: unknown) => onStorageError?.(error));
  }, [childStorageKey, onStorageError, threadStorage]);

  const schedulePersistedChild = useCallback((next: AgentThread) => {
    if (!childStorageKey || !threadStorage) return;
    pendingPersistRef.current = next;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = undefined;
      flushPersistedChild();
    }, 120);
  }, [childStorageKey, flushPersistedChild, threadStorage]);

  const handleThreadChange = useCallback((patch: AgentThreadPatch) => {
    setThread((current) => {
      if (!current) return current;
      const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
      // Persist event/checkpoint deltas as well as presentation state. The
      // storage adapter coalesces hot updates and converts the transcript to
      // an append-only PATCH, so long streams never send the full history.
      const hasClientStateChange = Object.keys(patch).some((key) => key !== "updatedAt");
      if (hasClientStateChange) schedulePersistedChild(next);
      return next;
    });
  }, [schedulePersistedChild]);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setThread(undefined);
    setLoadError(undefined);
    setHistoryLoading(false);
    const connection = createAgentSession(client, preferences, { sessionId, streamIndex: 0 });
    const session = attachAgentSession(connection, connection.initialSession);
    if (!session) {
      setLoadError("The sub-agent session is unavailable.");
      return () => controller.abort();
    }
    void (async () => {
      try {
        // Prefer the host's bounded transcript window. Eve snapshot() always
        // reads from index zero and becomes an unbounded browser payload for
        // long-running children. AgentThreadView owns the single live stream
        // after this prefix and resumes from its absolute end cursor.
        let storedThread: AgentThread | undefined;
        let storedWindow: AgentThread["transcriptWindow"];
        if (childStorageKey && threadStorage?.loadThreadWindow) {
          const windowed = await threadStorage.loadThreadWindow(childStorageKey, sessionId);
          storedThread = windowed?.thread;
          storedWindow = windowed?.window;
          // A brand-new child has no metadata row yet. Initialize the HTTP
          // storage baseline with its empty collection so the first event
          // checkpoint can create the row instead of failing with a missing
          // optimistic revision.
          if (!windowed && threadStorage.load) {
            const emptyCollection = await threadStorage.load(childStorageKey);
            storedThread = emptyCollection.threads.find((candidate) => candidate.id === sessionId);
          }
        } else if (childStorageKey && threadStorage) {
          const storedCollection = await threadStorage.load(childStorageKey);
          storedThread = storedCollection.threads.find((candidate) => candidate.id === sessionId);
        }
        // A host without the event-window contract (or a brand-new child with
        // no checkpoint) retains the Eve snapshot compatibility path. Once a
        // first checkpoint is written, subsequent opens use the bounded path.
        const snapshot = storedWindow
          ? undefined
          : await readChildSnapshot(session, controller.signal);
        if (disposed) return;
        const childDefaults = storedThread?.preferences ?? preferences;
        const initialEvents = storedWindow
          ? storedThread?.events ?? []
          : snapshot?.events ?? [];
        const initialSession = storedWindow
          ? {
              ...(storedThread?.session ?? {}),
              sessionId,
              // Never trust a stale metadata cursor when the bounded window
              // is the authoritative prefix currently materialized in memory.
              streamIndex: storedWindow.endIndex,
            }
          : snapshot!.session;
        const hydratedThread: AgentThread = {
          ...createChildThread(sessionId, preferences),
          ...(storedThread ? persistedChildControls(storedThread) : {}),
          events: initialEvents,
          id: sessionId,
          preferences: childDefaults,
          ...(storedWindow ? { transcriptWindow: storedWindow } : {}),
          session: initialSession,
          status: storedThread?.status ?? statusFromEvents(initialEvents),
          updatedAt: Date.now(),
        };
        setThread(hydratedThread);
        // A child has no parent-side transcript window API of its own. Write
        // the first checkpoint immediately after snapshot hydration so future
        // opens use the bounded event-window path instead of replaying Eve
        // from index zero. Subsequent changes remain coalesced by the normal
        // checkpoint scheduler.
        if (!storedWindow) schedulePersistedChild(hydratedThread);
      } catch (error: unknown) {
        if (disposed || controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "The sub-agent history could not be loaded.");
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [childStorageKey, client, preferences, reloadGeneration, schedulePersistedChild, sessionId, threadStorage]);

  useEffect(() => () => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = undefined;
    flushPersistedChild();
  }, [flushPersistedChild]);

  useEffect(() => {
    setThread((current) => current && current.id === sessionId
      ? { ...current, preferences, updatedAt: Date.now() }
      : current);
  }, [preferences, sessionId]);

  const loadEarlier = useCallback(async () => {
    const current = thread;
    const window = current?.transcriptWindow;
    if (
      !current || !window?.hasMoreBefore || !childStorageKey ||
      !threadStorage?.loadThreadWindow || historyLoading
    ) return;
    setHistoryLoading(true);
    try {
      const loaded = await threadStorage.loadThreadWindow(childStorageKey, sessionId, {
        before: window.startIndex,
      });
      if (!loaded) return;
      setThread((latest) => {
        if (!latest) return latest;
        const latestWindow = latest.transcriptWindow ?? window;
        return {
          ...latest,
          events: compactThreadEvents([...loaded.thread.events, ...latest.events]),
          transcriptWindow: {
            endIndex: Math.max(latestWindow.endIndex, loaded.window.endIndex),
            hasMoreBefore: loaded.window.hasMoreBefore,
            startIndex: loaded.window.startIndex,
            total: Math.max(latestWindow.total, loaded.window.total),
          },
          // AgentThreadView's Eve reducer is initialized once per mount. The
          // revision key below remounts it with the newly prepended page.
          revision: (latest.revision ?? 0) + 1,
          updatedAt: Date.now(),
        };
      });
    } catch (error: unknown) {
      onStorageError?.(error);
    } finally {
      setHistoryLoading(false);
    }
  }, [childStorageKey, historyLoading, onStorageError, sessionId, thread, threadStorage]);

  const recoverChild = useCallback(() => {
    // Rehydrate from Eve's durable snapshot. The thread controller will attach
    // its one live stream after the snapshot commits; no browser-local cursor
    // is used as an authority during recovery.
    setThread(undefined);
    setReloadGeneration((value) => value + 1);
  }, []);

  if (loadError) {
    return <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-destructive" role="alert">{loadError}</div>;
  }
  if (!thread) {
    return <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground" role="status">Loading sub-agent history…</div>;
  }

  return (
    <AgentThreadView
      client={client}
      commands={commands}
      draftStorageKey={`open-agent:child-draft:${sessionId}`}
      locale={locale}
      mailbox={mailbox}
      mentions={mentions}
      models={models}
      onChange={handleThreadChange}
      onEvent={onEvent}
      onOpenDeliverable={onOpenDeliverable}
      onOpenSubagent={onOpenSubagent}
      onRecoveryNeeded={recoverChild}
      providerReady={providerReady}
      reasoningLevels={reasoningLevels}
      thread={thread}
      key={`${thread.id}:${thread.revision ?? 0}`}
      historyHasMore={thread.transcriptWindow?.hasMoreBefore === true}
      historyLoading={historyLoading}
      onLoadEarlier={loadEarlier}
    />
  );
}

function persistedChildControls(thread: AgentThread): Pick<AgentThread,
  "closedInputRequestIds" | "preferences" | "queuedTurns"
> & Partial<Pick<AgentThread,
  "draftRestore" | "interruptedTurns" | "pendingTurn" | "retainedContext"
>> {
  return {
    closedInputRequestIds: thread.closedInputRequestIds,
    ...(thread.draftRestore ? { draftRestore: thread.draftRestore } : {}),
    ...(thread.interruptedTurns ? { interruptedTurns: thread.interruptedTurns } : {}),
    ...(thread.pendingTurn ? { pendingTurn: thread.pendingTurn } : {}),
    preferences: thread.preferences,
    ...(thread.retainedContext ? { retainedContext: thread.retainedContext } : {}),
    queuedTurns: thread.queuedTurns,
  };
}

/**
 * Eve snapshots are the authoritative hydration path. Older Eve runtimes and
 * proxies that strip x-eve-stream-tail-index cannot satisfy the bounded
 * snapshot contract, so read one non-reconnecting stream as a compatibility
 * fallback. The fallback stops at a durable session boundary and never starts
 * a second live reader; AgentThreadView owns live follow-up streaming.
 */
async function readChildSnapshot(
  session: NonNullable<ReturnType<typeof attachAgentSession>>,
  signal: AbortSignal,
): Promise<{ readonly events: readonly MessageStreamEvent[]; readonly session: { readonly sessionId: string; readonly streamIndex: number } }> {
  try {
    return await session.snapshot({ signal });
  } catch (error: unknown) {
    if (signal.aborted || !isMissingTailBoundaryError(error)) throw error;
  }

  // Older Eve versions and transparent proxies may not expose the tail
  // header required by `snapshot()`. Keep this compatibility path bounded:
  // an unbounded follow stream here makes a child page wait forever whenever
  // the child is still running or the upstream connection is half-open. The
  // live AgentThreadView stream is attached after this snapshot and remains
  // responsible for following future events. `follow:true` is intentional:
  // older clients reject bounded streams when the proxy cannot provide the
  // tail header, so the timeout is the compatibility boundary.
  const events: MessageStreamEvent[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = window.setTimeout(abort, CHILD_SNAPSHOT_FALLBACK_TIMEOUT_MS);
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const event of session.stream({
      follow: true,
      signal: controller.signal,
      startIndex: 0,
      streamReconnectPolicy: { reconnect: false },
    })) {
      events.push(event);
      if (isChildSnapshotBoundary(event)) break;
    }
  } catch (error: unknown) {
    // A timeout is an expected outcome for a running child on a legacy
    // transport. Return the durable prefix collected so far and let the live
    // stream reconcile the remainder; surface all other failures normally.
    if (!controller.signal.aborted || signal.aborted) throw error;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
  return {
    events,
    session: { sessionId: session.state.sessionId, streamIndex: events.length },
  };
}

const CHILD_SNAPSHOT_FALLBACK_TIMEOUT_MS = 5_000;

function isMissingTailBoundaryError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("x-eve-stream-tail-index");
}

function isChildSnapshotBoundary(event: MessageStreamEvent): boolean {
  return event.type === "session.waiting" || event.type === "session.completed" || event.type === "session.failed";
}

function createChildThread(sessionId: string, preferences: AgentThreadPreferences): AgentThread {
  const now = Date.now();
  return {
    createdAt: now,
    closedInputRequestIds: [],
    events: [],
    id: sessionId,
    preferences,
    queuedTurns: [],
    session: { sessionId, streamIndex: 0 },
    status: "ready",
    title: "Sub-agent",
    updatedAt: now,
  };
}

function statusFromEvents(events: readonly MessageStreamEvent[]): AgentThread["status"] {
  const last = events.at(-1);
  if (!last) return "ready";
  if (last.type === "session.failed" || last.type === "turn.failed") return "error";
  if (last.type === "session.completed") return "ready";
  if (last.type === "session.waiting" || last.type === "turn.completed" || last.type === "turn.cancelled") return "waiting";
  return "streaming";
}
