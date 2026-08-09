"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ClientError, defaultMessageReducer } from "eve/client";
import { AlertCircleIcon, ArrowDownIcon, CirclePauseIcon, Clock3Icon, LoaderCircleIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger, } from "../ui/alert-dialog.js";
import { Button } from "../ui/button.js";
import { AgentActivity } from "./agent-activity.js";
import { attachAgentSession, createAgentSession } from "./agent-client.js";
import { AgentMessage } from "./agent-message.js";
import { messagesFor } from "./i18n.js";
import { isProxiedInputOnlyMessage } from "./turn-presentation.js";
const CHILD_STREAM_RECONNECT_LIMIT = 8;
const CHILD_WAITING_POLL_MS = 1_500;
export function AgentChildSessionView({ client, locale, preferences, sessionId, }) {
    const [attempt, setAttempt] = useState(0);
    const [events, setEvents] = useState([]);
    const [error, setError] = useState();
    const [phase, setPhase] = useState("connecting");
    const cursorRef = useRef(0);
    const eventsRef = useRef([]);
    const reducer = useMemo(() => defaultMessageReducer(), []);
    const messages = messagesFor(locale);
    useEffect(() => {
        eventsRef.current = [];
        cursorRef.current = 0;
        setEvents([]);
        setError(undefined);
        setPhase("connecting");
    }, [sessionId]);
    useEffect(() => {
        const controller = new AbortController();
        const connection = createAgentSession(client, preferences, { sessionId, streamIndex: 0 });
        const session = attachAgentSession(connection, connection.initialSession);
        if (!session)
            return;
        let projected = eventsRef.current;
        let cursor = cursorRef.current;
        let reconnectFailures = 0;
        setError(undefined);
        void (async () => {
            while (!controller.signal.aborted) {
                try {
                    let consumed = 0;
                    for await (const event of session.stream({ signal: controller.signal, startIndex: cursor })) {
                        cursor += 1;
                        cursorRef.current = cursor;
                        consumed += 1;
                        reconnectFailures = 0;
                        projected = [...projected, event];
                        eventsRef.current = projected;
                        setEvents(projected);
                        setError(undefined);
                        setPhase(phaseFromChildEvents(projected));
                        if (isChildSessionBoundary(event))
                            return;
                    }
                    if (controller.signal.aborted)
                        return;
                    if (phaseFromChildEvents(projected) === "waiting") {
                        await waitForRetry(controller.signal, CHILD_WAITING_POLL_MS);
                        continue;
                    }
                    reconnectFailures += 1;
                    if (reconnectFailures > CHILD_STREAM_RECONNECT_LIMIT) {
                        throw new Error(localize(locale, "The sub-agent stream ended before a durable session boundary.", "子代理事件流在到达持久会话边界前已结束。"));
                    }
                    setPhase("reconnecting");
                    await waitForRetry(controller.signal, reconnectDelay(reconnectFailures, consumed));
                }
                catch (cause) {
                    if (controller.signal.aborted || isAbortError(cause))
                        return;
                    if (isRetryableChildStreamError(cause) && reconnectFailures < CHILD_STREAM_RECONNECT_LIMIT) {
                        reconnectFailures += 1;
                        setPhase("reconnecting");
                        await waitForRetry(controller.signal, reconnectDelay(reconnectFailures, 0));
                        continue;
                    }
                    setError(childSessionError(cause, locale));
                    setPhase("failed");
                    return;
                }
            }
        })();
        return () => controller.abort();
    }, [attempt, client, locale, preferences, sessionId]);
    const data = useMemo(() => events.reduce((current, event) => reducer.reduce(current, event), reducer.initial()), [events, reducer]);
    const visibleMessages = data.messages.filter((message) => !isProxiedInputOnlyMessage(message, events));
    const isActive = phase === "connecting" || phase === "reconnecting" || phase === "running" || phase === "waiting";
    const elapsedSeconds = useChildElapsedSeconds(events);
    const stop = async () => {
        const turnId = latestTurnId(events);
        if (!turnId)
            return;
        const connection = createAgentSession(client, preferences, { sessionId, streamIndex: events.length });
        const session = attachAgentSession(connection, connection.initialSession);
        if (!session)
            return;
        try {
            await session.cancel({ turnId });
        }
        catch (cause) {
            setError(childSessionError(cause, locale));
        }
    };
    return (_jsxs("main", { className: "flex min-h-0 flex-1 flex-col overflow-hidden bg-background", children: [_jsxs("div", { className: "flex min-h-11 shrink-0 items-center gap-2 border-b border-border/70 px-4 text-sm", children: [phase === "waiting" ? (_jsx(CirclePauseIcon, { className: "size-4 text-amber-600 dark:text-amber-300" })) : isActive ? (_jsx(LoaderCircleIcon, { className: "size-4 animate-spin text-muted-foreground" })) : null, _jsx("span", { className: "min-w-0 flex-1 text-muted-foreground", children: childPhaseLabel(phase, locale) }), elapsedSeconds !== undefined ? (_jsxs("span", { className: "flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground", children: [_jsx(Clock3Icon, { className: "size-3.5" }), formatDuration(elapsedSeconds)] })) : null, isActive && latestTurnId(events) ? (_jsxs(AlertDialog, { children: [_jsx(AlertDialogTrigger, { asChild: true, children: _jsxs(Button, { "aria-label": messages.cancel, size: "sm", variant: "outline", children: [_jsx(SquareIcon, { className: "size-3 fill-current" }), messages.cancel] }) }), _jsxs(AlertDialogContent, { size: "sm", children: [_jsxs(AlertDialogHeader, { children: [_jsx(AlertDialogTitle, { children: localize(locale, "Stop this sub-agent?", "停止此子代理？") }), _jsx(AlertDialogDescription, { children: localize(locale, "Completed workspace changes remain. The parent Agent will receive the cancellation result.", "已完成的工作区更改会被保留，父 Agent 将收到取消结果。") })] }), _jsxs(AlertDialogFooter, { children: [_jsx(AlertDialogCancel, { children: localize(locale, "Keep running", "继续执行") }), _jsx(AlertDialogAction, { onClick: () => void stop(), variant: "destructive", children: localize(locale, "Stop sub-agent", "停止子代理") })] })] })] })) : null] }), _jsxs("div", { className: "min-h-0 flex-1 overflow-y-auto", children: [_jsxs("div", { className: "mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-8 sm:px-6 lg:py-10", children: [visibleMessages.map((message, index) => (_jsx(AgentMessage, { canRespond: false, closedInputRequestIds: new Set(), events: events, isStreaming: isActive && index === visibleMessages.length - 1, locale: locale, message: message, onCloseInputRequest: () => undefined, onInputResponses: () => undefined }, message.id))), isActive ? _jsx(AgentActivity, { events: events, messages: messages, mode: "recovery" }) : null, error ? (_jsxs("div", { className: "flex items-start gap-3 border-l-2 border-destructive/60 py-1 pl-3 text-sm", role: "alert", children: [_jsx(AlertCircleIcon, { className: "mt-0.5 size-4 shrink-0 text-destructive" }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "font-medium text-foreground", children: localize(locale, "Could not load this sub-agent session", "无法加载此子代理会话") }), _jsx("p", { className: "mt-0.5 break-words text-muted-foreground", children: error })] }), _jsxs(Button, { onClick: () => setAttempt((value) => value + 1), size: "sm", variant: "outline", children: [_jsx(RotateCcwIcon, { className: "size-4" }), messages.retry] })] })) : null] }), _jsx(Button, { "aria-label": localize(locale, "Scroll to bottom", "滚动到底部"), className: "absolute bottom-24 left-1/2 size-8 -translate-x-1/2 rounded-full shadow-sm", size: "icon-sm", variant: "outline", children: _jsx(ArrowDownIcon, { className: "size-4" }) })] })] }));
}
function phaseFromChildEvents(events) {
    const last = events.at(-1);
    if (!last)
        return "connecting";
    if (last.type === "session.failed" || last.type === "turn.failed")
        return "failed";
    if (last.type === "session.completed")
        return "completed";
    if (last.type === "session.waiting" || last.type === "input.requested")
        return "waiting";
    return "running";
}
function isChildSessionBoundary(event) {
    return event.type === "session.completed" || event.type === "session.failed";
}
function latestTurnId(events) {
    const event = [...events].reverse().find((candidate) => candidate.type === "turn.started");
    return event?.type === "turn.started" ? event.data.turnId : undefined;
}
function childPhaseLabel(phase, locale) {
    if (phase === "connecting")
        return localize(locale, "Connecting to sub-agent...", "正在连接子代理…");
    if (phase === "reconnecting")
        return localize(locale, "Reconnecting to the durable sub-agent run...", "正在重新连接持久化子代理任务…");
    if (phase === "running")
        return localize(locale, "Sub-agent is working", "子代理正在执行");
    if (phase === "waiting")
        return localize(locale, "Sub-agent is waiting for input", "子代理正在等待输入");
    if (phase === "completed")
        return localize(locale, "Sub-agent completed", "子代理已完成");
    return localize(locale, "Sub-agent failed", "子代理执行失败");
}
function childSessionError(error, locale) {
    if (error instanceof ClientError && error.status === 404) {
        return localize(locale, "This child session is unavailable or has expired.", "此子会话不可用或已过期。");
    }
    return error instanceof Error
        ? error.message
        : localize(locale, "The child session stream could not be opened.", "无法打开子会话事件流。");
}
function isAbortError(error) {
    return error instanceof Error && error.name === "AbortError";
}
function isRetryableChildStreamError(error) {
    if (error instanceof ClientError) {
        return error.status === 0 || [404, 409, 425, 429, 500, 502, 503, 504].includes(error.status);
    }
    return error instanceof TypeError || (error instanceof Error && /fetch|network|socket|stream/i.test(error.message));
}
function reconnectDelay(failures, consumed) {
    if (consumed > 0)
        return 250;
    return Math.min(5_000, 500 * 2 ** Math.max(0, failures - 1));
}
function waitForRetry(signal, milliseconds) {
    if (signal.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        const finish = () => {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", finish);
            resolve();
        };
        const timeout = window.setTimeout(finish, milliseconds);
        signal.addEventListener("abort", finish, { once: true });
    });
}
function useChildElapsedSeconds(events) {
    const startedAt = eventTime(events.find((event) => event.type === "turn.started"));
    const endedAt = eventTime([...events].reverse().find((event) => event.type === "session.completed" || event.type === "session.failed" || event.type === "turn.failed"));
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (!startedAt || endedAt)
            return;
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [endedAt, startedAt]);
    if (!startedAt)
        return undefined;
    return Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1_000));
}
function eventTime(event) {
    if (!event?.meta?.at)
        return undefined;
    const timestamp = Date.parse(event.meta.at);
    return Number.isFinite(timestamp) ? timestamp : undefined;
}
function formatDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0
        ? [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":")
        : [minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}
function localize(locale, english, chinese) {
    return locale === "zh-CN" ? chinese : english;
}
//# sourceMappingURL=agent-child-session.js.map