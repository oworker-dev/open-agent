"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ActionBarPrimitive, AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, unstable_useMentionAdapter, useAui, useAuiState, } from "@assistant-ui/react";
import { LexicalComposerInput } from "@assistant-ui/react-lexical";
import { ArrowDownIcon, ArrowUpIcon, AtSignIcon, CheckIcon, CircleGaugeIcon, CircleXIcon, CopyIcon, LockKeyholeIcon, LoaderCircleIcon, PlusIcon, PencilIcon, RotateCcwIcon, ShieldCheckIcon, SlashIcon, SquareIcon, WrenchIcon, } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ComposerTriggerPopover } from "../assistant-ui/composer-trigger-popover.js";
import { ContextDisplay } from "../assistant-ui/context-display.js";
import { copyText } from "../assistant-ui/copy-text.js";
import { DirectiveText } from "../assistant-ui/directive-text.js";
import { MarkdownText } from "../assistant-ui/markdown-text.js";
import { ModelSelector } from "../assistant-ui/model-selector.js";
import { ToolFallback } from "../assistant-ui/tool-fallback.js";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.js";
import { Button } from "../ui/button.js";
import { cn } from "../utils.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger, } from "../ui/dropdown-menu.js";
import { AgentMessage } from "./agent-message.js";
export function AssistantThreadSurface({ cancellationRevision, cancellationState, closedInputRequestIds, commands, composerTop, draftStorageKey, events, eveMessages, fallbackStartedAt, inputDisabled, isBusy, locale, mentions, messages, models, onInputResponses, onCloseInputRequest, onOpenSubagent, onPreferencesChange, onRetryRuntimeError, preferences, reasoningLevels, runtimeError, usage, }) {
    const eveMessagesById = useMemo(() => new Map(eveMessages.map((message) => [message.id, message])), [eveMessages]);
    const lastMessageId = eveMessages.at(-1)?.id;
    const canRespondToInputRequest = eveMessages.some((message) => message.parts.some((part) => part.type === "dynamic-tool" &&
        Boolean(part.toolMetadata?.eve?.inputRequest) &&
        part.toolMetadata?.eve?.inputResponse === undefined));
    return (_jsx(ThreadPrimitive.Root, { className: "aui-root flex h-full min-h-0 flex-col bg-background", style: { "--thread-max-width": "48rem" }, children: _jsxs(ThreadPrimitive.Viewport, { "aria-live": "polite", autoScroll: true, turnAnchor: "top", className: "relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-3 pt-3 sm:px-4 sm:pt-4", "data-slot": "thread-viewport", role: "log", children: [_jsxs("div", { className: "mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-6 empty:hidden", children: [_jsx(ThreadPrimitive.Messages, { children: ({ message }) => message.composer.isEditing ? (_jsx(EditMessage, { messages: messages })) : message.role === "user" ? (_jsx(UserMessage, { messages: messages })) : (_jsx(AssistantMessage, { canRespond: !isBusy || canRespondToInputRequest, events: events, fallbackStartedAt: fallbackStartedAt, isStreaming: isBusy && message.id === lastMessageId, locale: locale, message: eveMessagesById.get(message.id), messages: messages, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, onOpenSubagent: onOpenSubagent, closedInputRequestIds: closedInputRequestIds })) }), runtimeError ? (_jsx(RuntimeErrorMessage, { locale: locale, message: runtimeError, messages: messages, onRetry: onRetryRuntimeError })) : null] }), _jsx(ThreadPrimitive.Empty, { children: !isBusy ? _jsx(AssistantEmptyState, { messages: messages }) : null }), _jsxs(ThreadPrimitive.ViewportFooter, { className: "sticky bottom-0 z-20 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col bg-background pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:pb-4 md:pb-5", children: [_jsx(ThreadPrimitive.ScrollToBottom, { asChild: true, children: _jsx(TooltipIconButton, { tooltip: locale === "zh-CN" ? "滚动到底部" : "Scroll to bottom", className: "absolute -top-9 left-1/2 z-10 size-8 -translate-x-1/2 rounded-full disabled:invisible", variant: "outline", children: _jsx(ArrowDownIcon, { className: "size-4" }) }) }), _jsx(AssistantComposer, { cancellationState: cancellationState, cancellationRevision: cancellationRevision, commands: commands, composerTop: composerTop, draftStorageKey: draftStorageKey, inputDisabled: inputDisabled, locale: locale, mentions: mentions, messages: messages, models: models, onPreferencesChange: onPreferencesChange, preferences: preferences, reasoningLevels: reasoningLevels, usage: usage })] })] }) }));
}
function RuntimeErrorMessage({ locale, message, messages, onRetry, }) {
    return (_jsx("article", { className: "mx-auto flex w-full max-w-(--thread-max-width) flex-col", "data-agent-message-error": true, role: "alert", children: _jsxs("div", { className: "flex items-start gap-3 px-1 text-sm", children: [_jsx(CircleXIcon, { className: "mt-0.5 size-4 shrink-0 text-destructive" }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "font-medium text-foreground", children: locale === "zh-CN" ? "本轮执行失败" : messages.requestFailed }), _jsx("p", { className: "mt-1 break-words text-muted-foreground", children: message }), _jsx("p", { className: "mt-1 text-muted-foreground", children: messages.requestPreserved }), onRetry ? (_jsxs(Button, { className: "mt-2 h-7 px-2.5 text-xs", onClick: onRetry, size: "sm", variant: "outline", children: [_jsx(RotateCcwIcon, { className: "size-3.5" }), messages.retry] })) : null] })] }) }));
}
function UserMessage({ messages }) {
    const [actionsVisible, setActionsVisible] = useState(false);
    const isLastUserMessage = useAuiState((state) => {
        const lastUser = [...state.thread.messages].reverse().find((message) => message.role === "user");
        return lastUser?.id === state.message.id;
    });
    const userText = useAuiState((state) => state.message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.type === "text" ? part.text : "")
        .join("\n"));
    return (_jsxs(MessagePrimitive.Root, { className: "group mx-auto flex w-full max-w-(--thread-max-width) flex-col items-end", children: [_jsx("div", { className: "max-w-[min(44rem,88%)] rounded-2xl bg-muted/75 px-4 py-3 text-[15px] leading-6 text-foreground", onClick: () => {
                    if (window.matchMedia("(pointer: coarse)").matches)
                        setActionsVisible((visible) => !visible);
                }, children: _jsx(MessagePrimitive.Parts, { components: { Text: DirectiveText } }) }), _jsxs("div", { className: cn("mt-0.5 flex min-h-7 items-center transition-opacity", actionsVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"), children: [_jsx(CopyTextAction, { label: messages.copyResponse, text: userText }), _jsx(ActionBarPrimitive.Root, { className: "flex min-h-7 items-center", children: _jsx(ActionBarPrimitive.Edit, { "aria-label": messages.editMessage, className: `inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground ${isLastUserMessage ? "" : "invisible pointer-events-none"}`, children: _jsx(PencilIcon, { className: "size-3.5" }) }) })] })] }));
}
function AssistantMessage({ canRespond, closedInputRequestIds, events, fallbackStartedAt, isStreaming, locale, message, messages, onInputResponses, onCloseInputRequest, onOpenSubagent, }) {
    return (_jsxs(MessagePrimitive.Root, { className: "group mx-auto flex w-full max-w-(--thread-max-width) flex-col", children: [_jsx("div", { className: "min-w-0 px-1 text-[15px] leading-7 text-foreground", children: message ? (_jsx(AgentMessage, { canRespond: canRespond, closedInputRequestIds: closedInputRequestIds, events: events, fallbackStartedAt: fallbackStartedAt, isStreaming: isStreaming, locale: locale, message: message, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, onOpenSubagent: onOpenSubagent, showCopyAction: true })) : (_jsx(MessagePrimitive.Parts, { components: { Text: MarkdownText, tools: { Fallback: ToolFallback } } })) }), _jsx("div", { className: "min-h-7" })] }));
}
function EditMessage({ messages }) {
    const aui = useAui();
    const canSend = useAuiState((state) => state.composer.canSend);
    const resendFromHere = (event) => {
        event.preventDefault();
        if (!canSend)
            return;
        aui.composer.send({ startRun: true });
    };
    return (_jsx(MessagePrimitive.Root, { className: "mx-auto w-full max-w-(--thread-max-width)", "data-agent-edit-composer": true, children: _jsxs(ComposerPrimitive.Root, { className: "rounded-2xl bg-muted/70 px-4 py-3", onSubmit: resendFromHere, children: [_jsx(ComposerPrimitive.Input, { autoComplete: "off", autoFocus: true, className: "min-h-12 w-full resize-none border-0 bg-transparent text-[15px] leading-6 outline-none", id: "agent-edit-message", name: "agent-edit-message" }), _jsxs("div", { className: "mt-2 flex justify-end gap-2", children: [_jsx(ComposerPrimitive.Cancel, { asChild: true, children: _jsx(Button, { className: "h-7 bg-background px-2.5 text-xs", size: "sm", variant: "ghost", children: messages.cancelEdit }) }), _jsx(Button, { className: "h-7 px-2.5 text-xs", disabled: !canSend, size: "sm", type: "submit", children: messages.send })] })] }) }));
}
export function AssistantComposer({ cancellationRevision, cancellationState, commands, composerTop, draftStorageKey, inputDisabled = false, locale, mentions, messages, models, onPreferencesChange, preferences, reasoningLevels, usage, }) {
    const aui = useAui();
    const isRunning = useAuiState((state) => state.thread.isRunning);
    const composerIsEmpty = useAuiState((state) => state.composer.isEmpty);
    const composerText = useAuiState((state) => state.composer.text);
    const runtimeInputDisabled = useAuiState((state) => state.thread.isDisabled);
    const stopping = cancellationState !== "idle";
    const composerDisabled = inputDisabled || runtimeInputDisabled || stopping;
    const composerInputRef = useRef(null);
    const auiRef = useRef(aui);
    const draftHydrationRef = useRef(undefined);
    const previousDraftKeyRef = useRef(undefined);
    auiRef.current = aui;
    const previousCancellationRevision = useRef(cancellationRevision);
    useEffect(() => {
        if (previousCancellationRevision.current !== cancellationRevision) {
            aui.composer.setText("");
            previousCancellationRevision.current = cancellationRevision;
        }
    }, [aui, cancellationRevision]);
    useEffect(() => {
        if (cancellationState !== "idle")
            aui.composer.setText("");
    }, [aui, cancellationState]);
    useEffect(() => {
        if (previousDraftKeyRef.current && previousDraftKeyRef.current !== draftStorageKey) {
            window.localStorage.removeItem(previousDraftKeyRef.current);
        }
        previousDraftKeyRef.current = draftStorageKey;
        const savedDraft = window.localStorage.getItem(draftStorageKey) ?? "";
        draftHydrationRef.current = { key: draftStorageKey, text: savedDraft };
        const composer = auiRef.current.composer;
        if (composer.getState().text !== savedDraft)
            composer.setText(savedDraft);
    }, [draftStorageKey]);
    useEffect(() => {
        const hydration = draftHydrationRef.current;
        if (hydration?.key === draftStorageKey) {
            if (composerText !== hydration.text)
                return;
            draftHydrationRef.current = undefined;
        }
        if (composerText)
            window.localStorage.setItem(draftStorageKey, composerText);
        else
            window.localStorage.removeItem(draftStorageKey);
    }, [composerText, draftStorageKey]);
    useEffect(() => {
        const input = composerInputRef.current?.querySelector('[role="textbox"]');
        if (!input)
            return;
        input.setAttribute("aria-label", messages.inputPlaceholder);
        input.setAttribute("aria-disabled", String(composerDisabled));
        input.setAttribute("contenteditable", String(!composerDisabled));
    }, [composerDisabled, messages.inputPlaceholder]);
    const mention = unstable_useMentionAdapter({
        fallbackIcon: AtSignIcon,
        includeModelContextTools: false,
        items: mentions.map((sourceItem) => {
            const item = localizePromptMenuItem(sourceItem, locale);
            return {
                description: item.description,
                id: item.value,
                label: item.label,
                type: "context",
            };
        }),
    });
    const command = unstable_useMentionAdapter({
        fallbackIcon: SlashIcon,
        includeModelContextTools: false,
        items: commands.map((sourceItem) => {
            const item = localizePromptMenuItem(sourceItem, locale);
            return {
                description: item.description,
                id: item.value,
                label: item.label,
                type: "command",
            };
        }),
    });
    const model = models.find((candidate) => candidate.id === preferences.modelId) ?? models[0];
    const selectorModels = useMemo(() => models.map((candidate) => ({
        efforts: reasoningLevels.map((level) => ({ id: level, name: formatReasoningLevel(level, locale) })),
        id: candidate.id,
        name: candidate.label,
    })), [models, reasoningLevels]);
    const contextLabels = {
        cachedInput: messages.cacheReadTokens,
        contextUsage: messages.contextUsage,
        input: messages.inputTokens,
        of: messages.tokenUsageOf,
        output: messages.outputTokens,
        reasoning: messages.reasoning,
        sessionUsage: messages.sessionUsage,
    };
    const contextUsage = {
        totalTokens: usage.contextInputTokens,
    };
    const sessionUsage = {
        cachedInputTokens: usage.cacheReadTokens,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: 0,
        totalTokens: usage.inputTokens + usage.outputTokens,
    };
    return (_jsx(ComposerPrimitive.Unstable_TriggerPopoverRoot, { children: _jsxs(ComposerPrimitive.Root, { className: "relative flex w-full flex-col", onSubmit: (event) => {
                event.preventDefault();
                if (!composerDisabled) {
                    aui.composer.send();
                    blurComposerOnTouch(composerInputRef);
                }
            }, children: [_jsxs("div", { className: "flex w-full flex-col gap-2 rounded-[1.5rem] border border-border/70 bg-background p-2.5 shadow-[0_8px_24px_-16px_rgba(0,0,0,0.24)]", children: [composerTop, _jsx(ComposerPrimitive.Attachments, { children: ({ attachment }) => (_jsxs(AttachmentPrimitive.Root, { className: "group/attachment mr-1.5 inline-flex max-w-full items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs", children: [_jsx("span", { className: "max-w-52 truncate", children: attachment.name }), _jsx(AttachmentPrimitive.Remove, { "aria-label": messages.removeAttachment, className: "rounded-sm text-muted-foreground hover:text-foreground", children: _jsx("span", { "aria-hidden": true, children: "\u00D7" }) })] })) }), _jsx(LexicalComposerInput, { "aria-disabled": composerDisabled, directiveChip: DirectiveChip, placeholder: messages.inputPlaceholder, ref: composerInputRef, onKeyDownCapture: (event) => {
                                if (!isRunning || event.key !== "Enter" || event.shiftKey || composerDisabled || composerIsEmpty)
                                    return;
                                const input = event.target instanceof HTMLElement
                                    ? event.target.closest('[role="textbox"]')
                                    : null;
                                const pickerOpen = input?.getAttribute("aria-expanded") === "true" ||
                                    Boolean(composerInputRef.current?.querySelector('[data-slot="composer-trigger-popover"][data-state="open"]'));
                                if (pickerOpen)
                                    return;
                                event.preventDefault();
                                aui.composer.send();
                                blurComposerOnTouch(composerInputRef);
                            }, className: "aui-composer-input relative max-h-40 min-h-12 w-full resize-none overflow-y-auto bg-transparent px-2 py-1 text-[15px] leading-6 outline-none aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:items-center [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-md [&_.aui-directive-chip]:bg-muted [&_.aui-directive-chip]:px-1.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-foreground [&_.aui-directive-chip-icon]:text-muted-foreground [&_.aui-lexical-input]:min-h-6 [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:inset-x-0 [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:truncate [&_.aui-lexical-placeholder]:px-2 [&_.aui-lexical-placeholder]:py-1 [&_.aui-lexical-placeholder]:text-muted-foreground" }), _jsxs("div", { className: "flex min-h-9 items-center gap-0.5 sm:min-h-8 sm:gap-1", children: [_jsx(ComposerPrimitive.AddAttachment, { asChild: true, children: _jsx(Button, { "aria-label": messages.addFiles, className: "size-9 rounded-full text-muted-foreground sm:size-8", size: "icon-sm", type: "button", variant: "ghost", children: _jsx(PlusIcon, { className: "size-4" }) }) }), _jsx(ExecutionModeMenu, { messages: messages, onChange: (executionMode) => onPreferencesChange({ ...preferences, executionMode }), value: preferences.executionMode ?? "standard" }), _jsx(ModelSelector, { align: "start", className: "h-9 min-w-0 max-w-48 rounded-full px-2 text-muted-foreground sm:h-8 sm:max-w-64", contentClassName: "w-72 max-w-[calc(100vw-1.5rem)]", effort: preferences.reasoning, effortLabel: messages.reasoning, models: selectorModels, onEffortChange: (reasoning) => onPreferencesChange({ ...preferences, reasoning }), onValueChange: (modelId) => onPreferencesChange({ ...preferences, modelId }), searchable: models.length > 6, size: "sm", value: model?.id ?? preferences.modelId, valueClassName: "text-xs font-normal", variant: "ghost", triggerLabel: messages.model }), _jsxs("span", { className: "ml-auto flex min-w-0 items-center gap-0.5 sm:gap-1", children: [model && usage.contextInputTokens > 0 ? (_jsx(ContextDisplay.Ring, { className: "h-9 shrink-0 rounded-full px-1.5 sm:h-8", label: messages.context, labels: contextLabels, modelContextWindow: model.contextWindowTokens, side: "top", sessionUsage: sessionUsage, usage: contextUsage })) : null, stopping || (isRunning && composerIsEmpty) ? (_jsx(ComposerPrimitive.Cancel, { asChild: true, children: _jsx(Button, { "aria-label": cancellationState === "idle" ? messages.cancel : messages.stopping, className: "size-9 shrink-0 rounded-full sm:size-8", disabled: cancellationState !== "idle", size: "icon-sm", type: "button", children: cancellationState === "idle" ? (_jsx(SquareIcon, { className: "size-3.5 fill-current" })) : (_jsx(LoaderCircleIcon, { className: "size-4 animate-spin" })) }) })) : (_jsx(Button, { "aria-label": isRunning ? messages.queueFollowUp : messages.send, className: "size-9 shrink-0 rounded-full sm:size-8", disabled: composerDisabled, onClick: () => {
                                                aui.composer.send();
                                                blurComposerOnTouch(composerInputRef);
                                            }, size: "icon-sm", type: "button", children: _jsx(ArrowUpIcon, { className: "size-4" }) }))] })] })] }), _jsx(ComposerTriggerPopover, { char: "@", ...mention, emptyItemsLabel: messages.noPromptItems }), _jsx(ComposerTriggerPopover, { char: "/", ...command, emptyItemsLabel: messages.noPromptItems })] }) }));
}
function blurComposerOnTouch(inputRef) {
    if (!window.matchMedia("(pointer: coarse)").matches)
        return;
    window.requestAnimationFrame(() => {
        inputRef.current?.querySelector('[role="textbox"]')?.blur();
    });
}
function DirectiveChip({ directiveId, directiveType, label }) {
    const Icon = directiveType === "command" ? SlashIcon : AtSignIcon;
    return (_jsxs("span", { className: "aui-directive-chip", "data-directive-id": directiveId, "data-directive-type": directiveType, children: [_jsx(Icon, { className: "aui-directive-chip-icon size-3" }), _jsx("span", { children: label })] }));
}
function ExecutionModeMenu({ messages, onChange, value, }) {
    const options = [
        { description: messages.executionStandardDescription, icon: ShieldCheckIcon, label: messages.executionStandard, value: "standard" },
        { description: messages.executionAutomationDescription, icon: CircleGaugeIcon, label: messages.executionAutomation, value: "automation" },
        { description: messages.executionCautiousDescription, icon: LockKeyholeIcon, label: messages.executionCautious, value: "cautious" },
    ];
    const selected = options.find((option) => option.value === value) ?? options[0];
    return (_jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsxs(Button, { "aria-label": messages.executionMode, className: "h-9 max-w-40 gap-1.5 rounded-full px-2.5 text-muted-foreground sm:h-8", type: "button", variant: "ghost", children: [_jsx(ShieldCheckIcon, { className: "size-4" }), _jsx("span", { className: "hidden truncate text-xs sm:inline", children: selected.label })] }) }), _jsxs(DropdownMenuContent, { align: "start", className: "w-80 max-w-[calc(100vw-1.5rem)]", side: "top", children: [_jsx(DropdownMenuLabel, { children: messages.executionMode }), _jsx(DropdownMenuRadioGroup, { onValueChange: (next) => onChange(next), value: value, children: options.map((option) => {
                            const Icon = option.icon;
                            return (_jsxs(DropdownMenuRadioItem, { className: "items-start py-2", value: option.value, children: [_jsx(Icon, { className: "mt-0.5 size-3.5 shrink-0 text-muted-foreground" }), _jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block text-xs font-medium text-foreground", children: option.label }), _jsx("span", { className: "mt-0.5 block whitespace-normal text-xs leading-4 text-muted-foreground", children: option.description })] })] }, option.value));
                        }) })] })] }));
}
function formatReasoningLevel(level, locale) {
    if (locale === "zh-CN") {
        if (level === "low")
            return "低";
        if (level === "medium")
            return "中";
        if (level === "high")
            return "高";
        if (level === "xhigh")
            return "极高";
    }
    if (level === "xhigh")
        return "X high";
    if (level === "medium")
        return "Med";
    return level.charAt(0).toUpperCase() + level.slice(1);
}
function localizePromptMenuItem(item, locale) {
    const translation = item.translations?.[locale];
    if (!translation)
        return item;
    return {
        ...item,
        description: translation.description ?? item.description,
        label: translation.label ?? item.label,
    };
}
function CopyTextAction({ label, text }) {
    const [copied, setCopied] = useState(false);
    const timeout = useRef(undefined);
    useEffect(() => () => window.clearTimeout(timeout.current), []);
    return (_jsx(Button, { "aria-label": label, className: "size-7 text-muted-foreground hover:bg-accent hover:text-foreground", disabled: !text, onClick: () => {
            void copyText(text).then(() => {
                setCopied(true);
                window.clearTimeout(timeout.current);
                timeout.current = window.setTimeout(() => setCopied(false), 1_500);
            }).catch(() => setCopied(false));
        }, size: "icon-sm", type: "button", variant: "ghost", children: copied ? _jsx(CheckIcon, { className: "size-3.5" }) : _jsx(CopyIcon, { className: "size-3.5" }) }));
}
function AssistantEmptyState({ messages }) {
    const suggestions = [
        messages.suggestionInspect,
        messages.suggestionImplement,
        messages.suggestionResearch,
        messages.suggestionReview,
    ];
    const aui = useAui();
    return (_jsxs("div", { className: "mx-auto flex min-h-[min(30rem,62vh)] w-full max-w-(--thread-max-width) flex-1 flex-col items-center justify-center gap-5 px-1 pb-6 text-center sm:gap-6 sm:px-2 sm:pb-8", children: [_jsx(WrenchIcon, { className: "size-8 text-muted-foreground/60" }), _jsx("h1", { className: "text-2xl font-medium tracking-normal text-foreground", children: messages.emptyTitle }), _jsx("div", { className: "grid w-full grid-cols-1 gap-2 min-[520px]:grid-cols-2", children: suggestions.map((suggestion, index) => (_jsx("button", { className: cn("min-h-20 rounded-lg border border-border/70 px-3 py-3 text-left text-sm leading-5 transition-colors hover:bg-muted/50", index > 1 && "hidden min-[520px]:block"), onClick: () => aui.composer.setText(suggestion), type: "button", children: suggestion }, suggestion))) })] }));
}
//# sourceMappingURL=assistant-thread-surface.js.map