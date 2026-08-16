"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { CheckCircle2Icon, ChevronRightIcon, CircleStopIcon, Clock3Icon, LoaderCircleIcon, NetworkIcon, XCircleIcon, } from "lucide-react";
import { Button } from "../ui/button.js";
import { Popover, PopoverContent, PopoverTrigger, } from "../ui/popover.js";
import { cn } from "../utils.js";
import { mergeSubagentSessions, } from "./turn-presentation.js";
export function AgentSubagentMenu({ activeSessionId, events, durableSessions = [], locale, onOpen, }) {
    const sessions = mergeSubagentSessions(events, durableSessions)
        .filter((session) => session.childSessionId)
        .map((session, index) => ({ ...session, ordinal: index + 1 }));
    if (sessions.length === 0)
        return null;
    const active = sessions.filter((session) => isActive(session));
    const done = sessions.filter((session) => !isActive(session));
    return (_jsxs(Popover, { children: [_jsx(PopoverTrigger, { asChild: true, children: _jsxs(Button, { "aria-label": localize(locale, "Open sub-agents", "打开子代理"), className: "h-8 gap-1.5 px-2.5 text-sm", size: "sm", variant: "ghost", children: [_jsx(NetworkIcon, { className: "size-4" }), _jsx("span", { className: "hidden sm:inline", children: localize(locale, "Sub-agents", "子代理") }), active.length > 0 ? (_jsx("span", { "aria-label": localize(locale, `${active.length} active`, `${active.length} 个正在执行`), className: "min-w-4 text-xs tabular-nums text-muted-foreground", children: active.length })) : null] }) }), _jsxs(PopoverContent, { align: "end", className: "w-[min(22rem,calc(100vw-1.5rem))] p-1.5", children: [_jsx(SubagentGroup, { activeSessionId: activeSessionId, label: localize(locale, "Active", "正在执行"), locale: locale, onOpen: onOpen, sessions: active }), _jsx(SubagentGroup, { activeSessionId: activeSessionId, label: localize(locale, "Done", "已完成"), locale: locale, onOpen: onOpen, sessions: done })] })] }));
}
function SubagentGroup({ activeSessionId, label, locale, onOpen, sessions, }) {
    if (sessions.length === 0)
        return null;
    return (_jsxs("section", { className: "py-1", "aria-label": label, children: [_jsx("h3", { className: "px-2 py-1 text-xs font-medium text-muted-foreground", children: label }), _jsx("div", { className: "space-y-0.5", children: sessions.map((session) => {
                    const sessionId = session.childSessionId;
                    return (_jsxs("button", { "aria-current": activeSessionId === sessionId ? "page" : undefined, className: cn("flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left outline-hidden transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring", activeSessionId === sessionId && "bg-accent"), onClick: () => onOpen(sessionId), type: "button", children: [_jsx(SubagentStatusIcon, { status: session.status }), _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block truncate text-sm font-medium text-foreground", children: subagentLabel(session, locale) }), _jsx("span", { className: "block truncate text-xs text-muted-foreground", children: session.task ?? statusLabel(session.status, locale) })] }), _jsx(ChevronRightIcon, { className: "size-4 shrink-0 text-muted-foreground" })] }, session.callId));
                }) })] }));
}
function SubagentStatusIcon({ status }) {
    if (status === "running" || status === "starting") {
        return _jsx(LoaderCircleIcon, { className: "size-4 shrink-0 animate-spin text-muted-foreground" });
    }
    if (status === "completed") {
        return _jsx(CheckCircle2Icon, { className: "size-4 shrink-0 text-emerald-600 dark:text-emerald-300" });
    }
    if (status === "waiting") {
        return _jsx(Clock3Icon, { className: "size-4 shrink-0 text-amber-600 dark:text-amber-300" });
    }
    if (status === "cancelled") {
        return _jsx(CircleStopIcon, { className: "size-4 shrink-0 text-muted-foreground" });
    }
    return _jsx(XCircleIcon, { className: "size-4 shrink-0 text-destructive" });
}
function subagentLabel(session, locale) {
    if (session.name && session.name !== "agent")
        return session.name;
    return localize(locale, `Sub-agent ${session.ordinal}`, `子代理 ${session.ordinal}`);
}
function statusLabel(status, locale) {
    if (status === "completed")
        return localize(locale, "Completed", "已完成");
    if (status === "cancelled")
        return localize(locale, "Stopped", "已停止");
    if (status === "failed")
        return localize(locale, "Failed", "失败");
    if (status === "waiting")
        return localize(locale, "Waiting for input", "等待消息");
    return localize(locale, "Working", "正在执行");
}
function isActive(session) {
    return session.status === "running" || session.status === "starting" || session.status === "waiting";
}
function localize(locale, english, chinese) {
    return locale === "zh-CN" ? chinese : english;
}
//# sourceMappingURL=agent-subagent-menu.js.map