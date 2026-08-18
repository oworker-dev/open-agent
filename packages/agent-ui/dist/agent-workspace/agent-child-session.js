"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentThreadView } from "./agent-thread.js";
import { attachAgentSession, createAgentSession } from "./agent-client.js";
import { AGENT_THREAD_STORAGE_VERSION } from "./thread-storage.js";
export function AgentChildSessionView({ client, commands, locale, mailbox, mentions, models, onEvent, onOpenDeliverable, onOpenSubagent, onStorageError, preferences, providerReady = true, reasoningLevels, sessionId, storageKey, threadStorage, }) {
    const [thread, setThread] = useState();
    const [loadError, setLoadError] = useState();
    const [reloadGeneration, setReloadGeneration] = useState(0);
    const pendingPersistRef = useRef(undefined);
    const persistTimerRef = useRef(undefined);
    const childStorageKey = storageKey ? `${storageKey}:subagent:${sessionId}` : undefined;
    const flushPersistedChild = useCallback(() => {
        const next = pendingPersistRef.current;
        if (!next || !childStorageKey || !threadStorage)
            return;
        pendingPersistRef.current = undefined;
        const persisted = {
            ...next,
            events: [],
            hydration: "summary",
            session: { streamIndex: 0 },
            updatedAt: Date.now(),
        };
        const collection = {
            activeThreadId: sessionId,
            threads: [persisted],
            version: AGENT_THREAD_STORAGE_VERSION,
        };
        void Promise.resolve(threadStorage.save(childStorageKey, collection)).catch((error) => onStorageError?.(error));
    }, [childStorageKey, onStorageError, threadStorage]);
    const schedulePersistedChild = useCallback((next) => {
        if (!childStorageKey || !threadStorage)
            return;
        pendingPersistRef.current = next;
        if (persistTimerRef.current)
            clearTimeout(persistTimerRef.current);
        persistTimerRef.current = setTimeout(() => {
            persistTimerRef.current = undefined;
            flushPersistedChild();
        }, 120);
    }, [childStorageKey, flushPersistedChild, threadStorage]);
    const handleThreadChange = useCallback((patch) => {
        setThread((current) => {
            if (!current)
                return current;
            const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
            const hasClientStateChange = Object.keys(patch).some((key) => key !== "events" && key !== "session" && key !== "updatedAt");
            if (hasClientStateChange)
                schedulePersistedChild(next);
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
                const [snapshot, storedCollection] = await Promise.all([
                    readChildSnapshot(session, controller.signal),
                    childStorageKey && threadStorage
                        ? Promise.resolve(threadStorage.load(childStorageKey))
                        : Promise.resolve(undefined),
                ]);
                if (disposed)
                    return;
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
            }
            catch (error) {
                if (disposed || controller.signal.aborted)
                    return;
                setLoadError(error instanceof Error ? error.message : "The sub-agent history could not be loaded.");
            }
        })();
        return () => {
            disposed = true;
            controller.abort();
        };
    }, [childStorageKey, client, preferences, reloadGeneration, sessionId, threadStorage]);
    useEffect(() => () => {
        if (persistTimerRef.current)
            clearTimeout(persistTimerRef.current);
        persistTimerRef.current = undefined;
        flushPersistedChild();
    }, [flushPersistedChild]);
    useEffect(() => {
        setThread((current) => current && current.id === sessionId
            ? { ...current, preferences, updatedAt: Date.now() }
            : current);
    }, [preferences, sessionId]);
    const recoverChild = useCallback(() => {
        setThread(undefined);
        setReloadGeneration((value) => value + 1);
    }, []);
    if (loadError) {
        return _jsx("div", { className: "flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-destructive", role: "alert", children: loadError });
    }
    if (!thread) {
        return _jsx("div", { className: "flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground", role: "status", children: "Loading sub-agent history\u2026" });
    }
    return (_jsx(AgentThreadView, { client: client, commands: commands, draftStorageKey: `open-agent:child-draft:${sessionId}`, locale: locale, mailbox: mailbox, mentions: mentions, models: models, onChange: handleThreadChange, onEvent: onEvent, onOpenDeliverable: onOpenDeliverable, onOpenSubagent: onOpenSubagent, onRecoveryNeeded: recoverChild, providerReady: providerReady, reasoningLevels: reasoningLevels, thread: thread }));
}
function persistedChildControls(thread) {
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
async function readChildSnapshot(session, signal) {
    try {
        return await session.snapshot({ signal });
    }
    catch (error) {
        if (signal.aborted || !isMissingTailBoundaryError(error))
            throw error;
    }
    const events = [];
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
            if (isChildSnapshotBoundary(event))
                break;
        }
    }
    catch (error) {
        if (!controller.signal.aborted || signal.aborted)
            throw error;
    }
    finally {
        window.clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
    }
    return {
        events,
        session: { sessionId: session.state.sessionId, streamIndex: events.length },
    };
}
const CHILD_SNAPSHOT_FALLBACK_TIMEOUT_MS = 5_000;
function isMissingTailBoundaryError(error) {
    return error instanceof Error && error.message.includes("x-eve-stream-tail-index");
}
function isChildSnapshotBoundary(event) {
    return event.type === "session.waiting" || event.type === "session.completed" || event.type === "session.failed";
}
function createChildThread(sessionId, preferences) {
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
function statusFromEvents(events) {
    const last = events.at(-1);
    if (!last)
        return "ready";
    if (last.type === "session.failed" || last.type === "turn.failed")
        return "error";
    if (last.type === "session.completed")
        return "ready";
    if (last.type === "session.waiting" || last.type === "turn.completed" || last.type === "turn.cancelled")
        return "waiting";
    return "streaming";
}
//# sourceMappingURL=agent-child-session.js.map