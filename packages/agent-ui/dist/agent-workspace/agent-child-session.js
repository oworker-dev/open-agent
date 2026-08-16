"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
import { AgentThreadView } from "./agent-thread.js";
import { attachAgentSession, createAgentSession } from "./agent-client.js";
export function AgentChildSessionView({ client, commands, locale, mailbox, mentions, models, onEvent, onOpenSubagent, preferences, reasoningLevels, sessionId, }) {
    const [thread, setThread] = useState();
    const [loadError, setLoadError] = useState();
    const [reloadGeneration, setReloadGeneration] = useState(0);
    const handleThreadChange = useCallback((patch) => {
        setThread((current) => {
            if (!current)
                return current;
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
                const snapshot = await readChildSnapshot(session, controller.signal);
                if (disposed)
                    return;
                setThread({
                    ...createChildThread(sessionId, preferences),
                    events: snapshot.events,
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
    }, [client, preferences, reloadGeneration, sessionId]);
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
    return (_jsx(AgentThreadView, { client: client, commands: commands, draftStorageKey: `open-agent:child-draft:${sessionId}`, locale: locale, mailbox: mailbox, mentions: mentions, models: models, onChange: handleThreadChange, onEvent: onEvent, onOpenSubagent: onOpenSubagent, onRecoveryNeeded: recoverChild, providerReady: true, reasoningLevels: reasoningLevels, thread: thread }));
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
    for await (const event of session.stream({
        follow: true,
        signal,
        startIndex: 0,
        streamReconnectPolicy: { reconnect: false },
    })) {
        events.push(event);
        if (isChildSnapshotBoundary(event))
            break;
    }
    return {
        events,
        session: { sessionId: session.state.sessionId, streamIndex: events.length },
    };
}
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