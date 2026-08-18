"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useAuiState } from "@assistant-ui/react";
import { useThreadTokenUsage } from "@assistant-ui/react-ai-sdk";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, } from "../ui/tooltip.js";
import { Popover, PopoverContent, PopoverTrigger, } from "../ui/popover.js";
import { cn } from "../utils.js";
import { createContext, useContext, useEffect, useMemo, useState, } from "react";
const formatTokenCount = (tokens) => {
    if (tokens >= 1_000_000)
        return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    if (tokens >= 1_000)
        return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    return `${tokens}`;
};
const getUsagePercent = (totalTokens, modelContextWindow) => {
    if (!totalTokens)
        return 0;
    return Math.min((totalTokens / modelContextWindow) * 100, 100);
};
const defaultLabels = {
    cacheWrite: "Cache write",
    cachedInput: "Cached input",
    contextUsage: "Context usage",
    estimatedCost: "Estimated cost",
    input: "Input",
    of: "of",
    output: "Output",
    reasoning: "Reasoning",
    sessionUsage: "Session usage",
};
const getUsageSeverity = (percent) => {
    if (percent > 85)
        return "critical";
    if (percent >= 65)
        return "warning";
    return "normal";
};
const getStrokeColor = (percent) => {
    const severity = getUsageSeverity(percent);
    if (severity === "critical")
        return "stroke-red-500";
    if (severity === "warning")
        return "stroke-amber-500";
    return "stroke-foreground";
};
const getBarColor = (percent) => {
    const severity = getUsageSeverity(percent);
    if (severity === "critical")
        return "bg-red-500";
    if (severity === "warning")
        return "bg-amber-500";
    return "bg-foreground";
};
const ContextDisplayContext = createContext(null);
function useContextDisplay() {
    const ctx = useContext(ContextDisplayContext);
    if (!ctx) {
        throw new Error("ContextDisplay.* must be used within ContextDisplay.Root");
    }
    return ctx;
}
function ContextDisplayRootBase({ modelContextWindow, children, labels: labelOverrides, usage, sessionUsage, }) {
    const threadId = useAuiState((s) => s.threadListItem.id);
    const rawTokens = usage?.totalTokens ?? 0;
    const [interaction, setInteraction] = useState("hover");
    const [open, setOpen] = useState(false);
    const [tokenState, setTokenState] = useState({
        threadId,
        totalTokens: rawTokens > 0 ? rawTokens : 0,
        usage,
    });
    useEffect(() => {
        const media = window.matchMedia("(hover: none) and (pointer: coarse)");
        const updateInteraction = () => {
            setInteraction(media.matches ? "touch" : "hover");
            setOpen(false);
        };
        updateInteraction();
        media.addEventListener("change", updateInteraction);
        return () => media.removeEventListener("change", updateInteraction);
    }, []);
    useEffect(() => {
        setTokenState((prev) => {
            if (prev.threadId !== threadId) {
                return {
                    threadId,
                    totalTokens: rawTokens > 0 ? rawTokens : 0,
                    usage,
                };
            }
            if (rawTokens > 0 && rawTokens !== prev.totalTokens) {
                return { ...prev, totalTokens: rawTokens, usage };
            }
            if (usage !== prev.usage) {
                return { ...prev, usage };
            }
            return prev;
        });
    }, [threadId, rawTokens, usage]);
    const totalTokens = tokenState.totalTokens;
    const percent = getUsagePercent(totalTokens, modelContextWindow);
    const labels = useMemo(() => ({ ...defaultLabels, ...labelOverrides }), [labelOverrides]);
    const contextValue = useMemo(() => ({
        interaction,
        labels,
        usage: tokenState.usage,
        sessionUsage,
        totalTokens,
        percent,
        modelContextWindow,
        open,
        setOpen,
    }), [interaction, labels, modelContextWindow, open, percent, sessionUsage, tokenState.usage, totalTokens]);
    return (_jsx(ContextDisplayContext.Provider, { value: contextValue, children: interaction === "touch" ? (_jsx(Popover, { open: open, onOpenChange: setOpen, children: children })) : (_jsx(TooltipProvider, { children: _jsx(Tooltip, { open: open, onOpenChange: setOpen, children: children }) })) }));
}
function ContextDisplayRootInternal({ modelContextWindow, children, labels, }) {
    const usage = useThreadTokenUsage();
    return (_jsx(ContextDisplayRootBase, { modelContextWindow: modelContextWindow, labels: labels, usage: usage, sessionUsage: usage, children: children }));
}
function ContextDisplayRoot(props) {
    if (props.usage !== undefined) {
        return (_jsx(ContextDisplayRootBase, { modelContextWindow: props.modelContextWindow, labels: props.labels, usage: props.usage, sessionUsage: props.sessionUsage, children: props.children }));
    }
    return (_jsx(ContextDisplayRootInternal, { modelContextWindow: props.modelContextWindow, labels: props.labels, children: props.children }));
}
function ContextDisplayTrigger({ className, children, ...props }) {
    const { interaction, open } = useContextDisplay();
    const trigger = (_jsx("button", { type: "button", "data-slot": "context-display-trigger", "aria-expanded": open, className: cn("inline-flex items-center rounded-md transition-colors", className), ...props, children: children }));
    return interaction === "touch"
        ? _jsx(PopoverTrigger, { asChild: true, children: trigger })
        : _jsx(TooltipTrigger, { asChild: true, children: trigger });
}
const getContextSegments = (usage, labels) => {
    if (!usage)
        return [];
    return [
        { label: labels.input, tokens: usage.inputTokens ?? 0 },
        { label: labels.cachedInput, tokens: usage.cachedInputTokens ?? 0 },
        { label: labels.cacheWrite, tokens: usage.cacheWriteTokens ?? 0 },
        { label: labels.output, tokens: usage.outputTokens ?? 0 },
        { label: labels.reasoning, tokens: usage.reasoningTokens ?? 0 },
    ].filter((segment) => segment.tokens > 0);
};
function ContextDisplayContent({ side = "top", className, }) {
    const { interaction, labels, sessionUsage, totalTokens, percent, modelContextWindow } = useContextDisplay();
    const segments = getContextSegments(sessionUsage, labels);
    const content = (_jsxs("div", { className: "text-xs", children: [_jsxs("div", { className: "flex items-baseline justify-between gap-6 whitespace-nowrap", children: [_jsx("span", { className: "font-medium", children: labels.contextUsage }), _jsxs("span", { className: "text-muted-foreground tabular-nums", children: [formatTokenCount(Math.min(totalTokens, modelContextWindow)), " ", labels.of, " ", formatTokenCount(modelContextWindow)] })] }), _jsx("div", { className: "bg-muted mt-2.5 h-1 overflow-hidden rounded-full", children: _jsx("div", { className: cn("h-full w-(--usage-width) rounded-full transition-[width] duration-300", totalTokens > 0 && "min-w-1", getBarColor(percent)), style: { "--usage-width": `${percent}%` } }) }), segments.length > 0 && (_jsxs("div", { className: "mt-3 grid gap-1.5", children: [_jsx("span", { className: "font-medium", children: labels.sessionUsage }), segments.map((segment) => (_jsxs("div", { className: "flex items-baseline justify-between gap-6", children: [_jsx("span", { className: "text-muted-foreground", children: segment.label }), _jsx("span", { className: "tabular-nums", children: formatTokenCount(segment.tokens) })] }, segment.label)))] })), sessionUsage?.costUsd && sessionUsage.costUsd > 0 ? (_jsxs("div", { className: "mt-3 flex items-baseline justify-between gap-6 border-t border-border/50 pt-2", children: [_jsx("span", { className: "text-muted-foreground", children: labels.estimatedCost }), _jsxs("span", { className: "tabular-nums", children: ["$", sessionUsage.costUsd.toFixed(4)] })] })) : null] }));
    const contentClassName = cn("bg-popover text-popover-foreground w-52 rounded-lg border p-2.5 text-left shadow-md", className);
    return interaction === "touch" ? (_jsx(PopoverContent, { align: "end", side: side, sideOffset: 8, "data-slot": "context-display-popover", className: contentClassName, children: content })) : (_jsx(TooltipContent, { side: side, sideOffset: 8, hideArrow: true, "data-slot": "context-display-popover", className: contentClassName, children: content }));
}
const RING_SIZE = 16;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
function RingVisual() {
    const { percent } = useContextDisplay();
    return (_jsxs("svg", { "aria-hidden": "true", width: RING_SIZE, height: RING_SIZE, viewBox: `0 0 ${RING_SIZE} ${RING_SIZE}`, className: "-rotate-90", children: [_jsx("circle", { cx: RING_SIZE / 2, cy: RING_SIZE / 2, r: RING_RADIUS, fill: "none", strokeWidth: RING_STROKE, className: "stroke-muted-foreground/25" }), _jsx("circle", { cx: RING_SIZE / 2, cy: RING_SIZE / 2, r: RING_RADIUS, fill: "none", strokeWidth: RING_STROKE, strokeLinecap: "round", strokeDasharray: RING_CIRCUMFERENCE, strokeDashoffset: RING_CIRCUMFERENCE - (percent / 100) * RING_CIRCUMFERENCE, className: cn("transition-[stroke-dashoffset,stroke] duration-300", getStrokeColor(percent)) })] }));
}
const ContextDisplayRing = ({ modelContextWindow, className, label = "Context usage", labels, side, sessionUsage, usage, }) => (_jsxs(ContextDisplayRoot, { labels: labels, modelContextWindow: modelContextWindow, sessionUsage: sessionUsage, usage: usage, children: [_jsx(ContextDisplayTrigger, { className: cn("text-muted-foreground hover:text-foreground gap-1.5 px-1.5 py-1 text-xs", className), "aria-label": label, children: _jsx(RingVisual, {}) }), _jsx(ContextDisplayContent, { side: side })] }));
function BarVisual() {
    const { percent, totalTokens } = useContextDisplay();
    return (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "bg-muted h-1.5 w-16 overflow-hidden rounded-full", children: _jsx("div", { className: cn("h-full rounded-full transition-all duration-300", getBarColor(percent)), style: { width: `${percent}%` } }) }), _jsxs("span", { className: "text-muted-foreground text-[10px] tabular-nums", children: [formatTokenCount(totalTokens), " (", Math.round(percent), "%)"] })] }));
}
const ContextDisplayBar = ({ modelContextWindow, className, label = "Context usage", labels, side, sessionUsage, usage, }) => (_jsxs(ContextDisplayRoot, { labels: labels, modelContextWindow: modelContextWindow, sessionUsage: sessionUsage, usage: usage, children: [_jsx(ContextDisplayTrigger, { className: cn("px-2 py-1", className), "aria-label": label, children: _jsx(BarVisual, {}) }), _jsx(ContextDisplayContent, { side: side })] }));
function TextVisual() {
    const { totalTokens, modelContextWindow } = useContextDisplay();
    return (_jsxs(_Fragment, { children: [formatTokenCount(totalTokens), " / ", formatTokenCount(modelContextWindow)] }));
}
const ContextDisplayText = ({ modelContextWindow, className, label = "Context usage", labels, side, sessionUsage, usage, }) => (_jsxs(ContextDisplayRoot, { labels: labels, modelContextWindow: modelContextWindow, sessionUsage: sessionUsage, usage: usage, children: [_jsx(ContextDisplayTrigger, { "aria-label": label, className: cn("text-muted-foreground hover:bg-accent hover:text-accent-foreground px-2 py-1 font-mono text-xs tabular-nums", className), children: _jsx(TextVisual, {}) }), _jsx(ContextDisplayContent, { side: side })] }));
const ContextDisplay = {};
ContextDisplay.Root = ContextDisplayRoot;
ContextDisplay.Trigger = ContextDisplayTrigger;
ContextDisplay.Content = ContextDisplayContent;
ContextDisplay.Ring = ContextDisplayRing;
ContextDisplay.Bar = ContextDisplayBar;
ContextDisplay.Text = ContextDisplayText;
export { ContextDisplay, ContextDisplayRoot, ContextDisplayTrigger, ContextDisplayContent, ContextDisplayRing, ContextDisplayBar, ContextDisplayText, };
//# sourceMappingURL=context-display.js.map