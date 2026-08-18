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
import { AGENT_THREAD_STORAGE_VERSION, type AgentThreadCollection, type AgentThreadStorage } from "./thread-storage.js";

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
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const pendingPersistRef = useRef<AgentThread | undefined>(undefined);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const childStorageKey = storageKey ? `${storageKey}:subagent:${sessionId}` : undefined;

  const flushPersistedChild = useCallback(() => {
    const next = pendingPersistRef.current;
    if (!next || !childStorageKey || !threadStorage) return;
    pendingPersistRef.current = undefined;
    const persisted: AgentThread = {
      ...next,
      // Eve's durable stream is the source of truth for transcript/cursor.
      // Keep the client-only controls here so a refresh does not lose a
      // queued follow-up or an in-flight presentation state.
      events: [],
      hydration: "summary",
      session: { streamIndex: 0 },
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
      // Stream events and the absolute cursor are already durable in Eve and
      // can be very high frequency. Persist only presentation/control state.
      const hasClientStateChange = Object.keys(patch).some((key) => key !== "events" && key !== "session" && key !== "updatedAt");
      if (hasClientStateChange) schedulePersistedChild(next);
      return next;
    });
  }, [schedulePersistedChild]);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setThread(undefined);
    setLoadError(undefined);
    const connection = createAgentSession(client, preferences, { sessionId, streamIndex: 0 });
    const session = attachAgentSession(connection, connection.initialSession);
    if (!session) {
      setLoadError("The sub-agent session is unavailable.");
      return () => controller.abort();
    }
    void (async () => {
      try {
        // Hydrate exactly once. AgentThreadView owns the single live stream
        // after this snapshot is projected. Keeping a second child-local SSE
        // here caused duplicate readers and remounted the thread on every
        // event, which made long-running child sessions appear to replay.
        const [snapshot, storedCollection] = await Promise.all([
          readChildSnapshot(session, controller.signal),
          childStorageKey && threadStorage
            ? Promise.resolve(threadStorage.load(childStorageKey))
            : Promise.resolve<AgentThreadCollection | undefined>(undefined),
        ]);
        if (disposed) return;
        const storedThread = storedCollection?.threads.find((candidate) => candidate.id === sessionId);
        const childDefaults = storedThread?.preferences ?? preferences;
        setThread({
          ...createChildThread(sessionId, preferences),
          ...(storedThread ? persistedChildControls(storedThread) : {}),
          events: snapshot.events,
          id: sessionId,
          preferences: childDefaults,
          session: snapshot.session,
          status: statusFromEvents(snapshot.events),
          updatedAt: Date.now(),
        });
      } catch (error: unknown) {
        if (disposed || controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "The sub-agent history could not be loaded.");
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [childStorageKey, client, preferences, reloadGeneration, sessionId, threadStorage]);

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
