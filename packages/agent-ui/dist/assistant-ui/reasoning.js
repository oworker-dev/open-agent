"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { memo, useCallback, useRef, useState, } from "react";
import { cva } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { useScrollLock, } from "@assistant-ui/react";
import { MarkdownText } from "./markdown-text.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, } from "../ui/collapsible.js";
import { cn } from "../utils.js";
const ANIMATION_DURATION = 200;
const reasoningVariants = cva("aui-reasoning-root mb-4 w-full", {
    variants: {
        variant: {
            outline: "rounded-lg border px-3 py-2",
            ghost: "",
            muted: "bg-muted/50 rounded-lg px-3 py-2",
        },
    },
    defaultVariants: {
        variant: "outline",
    },
});
function ReasoningRoot({ className, variant, open: controlledOpen, onOpenChange: controlledOnOpenChange, defaultOpen = false, streaming: _streaming, children, ...props }) {
    const collapsibleRef = useRef(null);
    const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
    const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);
    const isControlled = controlledOpen !== undefined;
    const isOpen = isControlled
        ? controlledOpen
        : uncontrolledOpen;
    const handleOpenChange = useCallback((open) => {
        lockScroll();
        if (!isControlled) {
            setUncontrolledOpen(open);
        }
        controlledOnOpenChange?.(open);
    }, [lockScroll, isControlled, controlledOnOpenChange]);
    return (_jsx(Collapsible, { ref: collapsibleRef, "data-slot": "reasoning-root", "data-variant": variant, open: isOpen, onOpenChange: handleOpenChange, className: cn("group/reasoning-root", reasoningVariants({ variant, className })), style: {
            "--animation-duration": `${ANIMATION_DURATION}ms`,
        }, ...props, children: children }));
}
function ReasoningFade({ side = "bottom", className, ...props }) {
    if (side === "top") {
        return (_jsx("div", { "data-slot": "reasoning-fade", className: cn("aui-reasoning-fade pointer-events-none absolute inset-x-0 top-0 z-10 h-8", "bg-[linear-gradient(to_bottom,var(--color-background),transparent)]", "group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_bottom,color-mix(in_oklab,var(--color-muted)_50%,var(--color-background)),transparent)]", "fade-in-0 animate-in", "duration-(--animation-duration)", className), ...props }));
    }
    return (_jsx("div", { "data-slot": "reasoning-fade", className: cn("aui-reasoning-fade pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8", "bg-[linear-gradient(to_top,var(--color-background),transparent)]", "group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_top,color-mix(in_oklab,var(--color-muted)_50%,var(--color-background)),transparent)]", "fade-in-0 animate-in", "duration-(--animation-duration)", className), ...props }));
}
function ReasoningTrigger({ active, duration, hideChevron = false, label = "Reasoning", className, ...props }) {
    const durationText = duration !== undefined && duration > 0 ? ` ${duration}s` : "";
    const displayLabel = typeof label === "string" ? `${label}${durationText}` : label;
    return (_jsxs(CollapsibleTrigger, { "data-slot": "reasoning-trigger", className: cn("aui-reasoning-trigger group/trigger text-muted-foreground hover:text-foreground flex max-w-[75%] origin-left items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]", className), ...props, children: [_jsx("span", { "data-slot": "reasoning-trigger-label", className: cn("aui-reasoning-trigger-label-wrapper relative inline-block whitespace-nowrap leading-none tabular-nums", active && "text-foreground/80"), children: _jsx("span", { children: displayLabel }) }), !hideChevron ? (_jsx(ChevronDownIcon, { "data-slot": "reasoning-trigger-chevron", className: cn("aui-reasoning-trigger-chevron mt-0.5 size-4 shrink-0", "transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none", "-rotate-90", "group-data-open/trigger:rotate-0", "group-data-panel-open/trigger:rotate-0") })) : null] }));
}
function ReasoningContent({ className, children, ...props }) {
    return (_jsxs(CollapsibleContent, { "data-slot": "reasoning-content", className: cn("aui-reasoning-content text-muted-foreground relative overflow-hidden text-sm outline-none", "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none", "data-closed:animate-collapsible-up", "data-open:animate-collapsible-down", "data-closed:fill-mode-forwards", "data-closed:pointer-events-none", "data-open:duration-(--animation-duration)", "data-closed:duration-(--animation-duration)", className), ...props, children: [_jsx(ReasoningFade, { side: "top" }), children] }));
}
function ReasoningText({ className, children, ...props }) {
    return (_jsx("div", { "data-slot": "reasoning-text", className: cn("aui-reasoning-text relative z-0 max-h-64 overflow-y-auto ps-6 pt-2 pb-2 leading-relaxed text-pretty", "transform-gpu transition-[transform,opacity] ease-[cubic-bezier(0.32,0.72,0,1)]", "motion-reduce:animate-none", "group-data-open/collapsible-content:animate-in", "group-data-closed/collapsible-content:animate-out", "group-data-open/collapsible-content:fade-in-0", "group-data-closed/collapsible-content:fade-out-0", "group-data-open/collapsible-content:slide-in-from-top-4", "group-data-closed/collapsible-content:slide-out-to-top-4", "group-data-open/collapsible-content:blur-in-[2px]", "group-data-closed/collapsible-content:blur-out-[2px]", "group-data-open/collapsible-content:duration-(--animation-duration)", "group-data-closed/collapsible-content:duration-(--animation-duration)", className), ...props, children: _jsx("div", { className: "aui-reasoning-text-content space-y-4", children: children }) }));
}
const ReasoningImpl = () => _jsx(MarkdownText, {});
const Reasoning = memo(ReasoningImpl);
Reasoning.displayName = "Reasoning";
Reasoning.Root = ReasoningRoot;
Reasoning.Trigger = ReasoningTrigger;
Reasoning.Content = ReasoningContent;
Reasoning.Text = ReasoningText;
Reasoning.Fade = ReasoningFade;
export { Reasoning, ReasoningRoot, ReasoningTrigger, ReasoningContent, ReasoningText, ReasoningFade, reasoningVariants, };
//# sourceMappingURL=reasoning.js.map