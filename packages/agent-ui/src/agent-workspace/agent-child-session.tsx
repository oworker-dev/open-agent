"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageStreamEvent } from "eve/client";
import { AgentThreadView } from "./agent-thread.js";
import { attachAgentSession, createAgentSession } from "./agent-client.js";
import type {
  AgentModelOption,
  AgentPromptMenuItem,
  AgentThread,
  AgentThreadPatch,
  AgentThreadPreferences,
  AgentWorkspaceClientConfig,
  AgentWorkspaceMailbox,
} from "./contracts.js";
import type { AgentLocale } from "./i18n.js";

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
  onOpenSubagent,
  preferences,
  reasoningLevels,
  sessionId,
}: {
  readonly client?: AgentWorkspaceClientConfig;
  readonly commands: readonly AgentPromptMenuItem[];
  readonly locale: AgentLocale;
  readonly mailbox?: AgentWorkspaceMailbox;
  readonly mentions: readonly AgentPromptMenuItem[];
  readonly models: readonly AgentModelOption[];
  readonly onEvent?: (event: MessageStreamEvent) => void;
  readonly onOpenSubagent?: (sessionId: string) => void;
  readonly preferences: AgentThreadPreferences;
  readonly reasoningLevels: readonly string[];
  readonly sessionId: string;
}) {
  const [thread, setThread] = useState<AgentThread>();
  const [loadError, setLoadError] = useState<string>();
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const handleThreadChange = useCallback((patch: AgentThreadPatch) => {
    setThread((current) => {
      if (!current) return current;
      return { ...current, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
    });
  }, []);

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
        const snapshot = await readChildSnapshot(session, controller.signal);
        if (disposed) return;
        setThread({
          ...createChildThread(sessionId, preferences),
          events: snapshot.events,
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
  }, [client, preferences, reloadGeneration, sessionId]);

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
      onOpenSubagent={onOpenSubagent}
      onRecoveryNeeded={recoverChild}
      providerReady
      reasoningLevels={reasoningLevels}
      thread={thread}
    />
  );
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

  const events: MessageStreamEvent[] = [];
  for await (const event of session.stream({
    follow: true,
    signal,
    startIndex: 0,
    streamReconnectPolicy: { reconnect: false },
  })) {
    events.push(event);
    if (isChildSnapshotBoundary(event)) break;
  }
  return {
    events,
    session: { sessionId: session.state.sessionId, streamIndex: events.length },
  };
}

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
