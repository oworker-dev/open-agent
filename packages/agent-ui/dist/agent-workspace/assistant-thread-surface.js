"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { ActionBarPrimitive, AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, unstable_useMentionAdapter, useAui, useAuiState, } from "@assistant-ui/react";
import { LexicalComposerInput } from "@assistant-ui/react-lexical";
import { ArrowDownIcon, ArrowUpIcon, AtSignIcon, CheckIcon, CircleGaugeIcon, CircleXIcon, CopyIcon, ChevronDownIcon, DownloadIcon, FileIcon, LockKeyholeIcon, LoaderCircleIcon, PlusIcon, PencilIcon, RotateCcwIcon, ShieldCheckIcon, SlashIcon, SquareIcon, WrenchIcon, WifiIcon, XIcon, } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ComposerTriggerPopover } from "../assistant-ui/composer-trigger-popover.js";
import { copyText } from "../assistant-ui/copy-text.js";
import { ContextDisplay } from "../assistant-ui/context-display.js";
import { DirectiveText } from "../assistant-ui/directive-text.js";
import { MarkdownText } from "../assistant-ui/markdown-text.js";
import { ModelSelector } from "../assistant-ui/model-selector.js";
import { ToolFallback } from "../assistant-ui/tool-fallback.js";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.js";
import { Button } from "../ui/button.js";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert.js";
import { Attachment, AttachmentGroup } from "../ui/attachment.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { cn } from "../utils.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger, } from "../ui/dropdown-menu.js";
import { AgentMessage } from "./agent-message.js";
import { classifyAgentFailure, presentAgentTurn } from "./turn-presentation.js";
import { useAssetDownload, useAssetText } from "./asset-preview.js";
import { useTaskScrollAnchor } from "./use-task-scroll-anchor.js";
import { receivedClientMessageId } from "./thread-storage.js";
import { AgentHistoryLoading } from "./history-loading.js";
import { AttachmentFileIcon, AttachmentImagePreview } from "./attachment-preview.js";
export function AssistantThreadSurface({ assetUrl, approvalTakeover, cancellationState, closedInputRequestIds, commands, composerTop, composerHidden = false, draftStorageKey, draftRestore, events, eveMessages, fallbackStartedAt, historyHasMore = false, historyLoading = false, historyStartIndex, inputDisabled, isBusy, isRestoring = false, scrollToBottomOnInitialize = true, scrollToBottomOnThreadSwitch = true, sessionTerminal, sessionSettled, messageEditingAllowed, onCancel, locale, mentions, messages, models, onInputResponses, onCloseInputRequest, onDraftRestoreConsumed, onOpenDeliverable, onOpenSubagent, onLoadEarlier, onPreferencesChange, onRetryRuntimeError, preferences, reasoningLevels, runtimeError, runtimeFailure, runtimeRetry, usage, }) {
    const composerIsEditing = useAuiState((state) => state.thread.messages.some((message) => message.composer.isEditing));
    const runtimeDisabled = useAuiState((state) => state.thread.isDisabled);
    const renderedUserId = useAuiState((state) => state.thread.messages.findLast((message) => message.role === "user")?.id);
    const viewportRef = useRef(null);
    const historyRequestInFlightRef = useRef(false);
    const pendingHistoryAnchorRef = useRef(undefined);
    const viewportScrollOnInitialize = scrollToBottomOnInitialize && !composerIsEditing;
    const viewportScrollOnThreadSwitch = scrollToBottomOnThreadSwitch && !composerIsEditing;
    const eveMessagesById = useMemo(() => new Map(eveMessages.map((message) => [message.id, message])), [eveMessages]);
    const lastAssistantMessageId = [...eveMessages].reverse().find((message) => message.role === "assistant")?.id;
    const latestMessage = eveMessages.at(-1);
    const latestUserId = eveMessages.findLast((message) => message.role === "user")?.id;
    const latestUserReceipt = events.findLast((event) => event.type === "delivery.consumed"
        && latestUserId === `${event.data.deliveryId}:user`);
    const userKey = latestUserReceipt?.type === "delivery.consumed"
        ? `${receivedClientMessageId(latestUserReceipt) ?? latestUserReceipt.data.deliveryId}:user`
        : latestUserId;
    const { contentRef, reserveRef, resumeBottomFollow } = useTaskScrollAnchor({
        hasExecutionGroup: latestMessage?.role === "assistant"
            && Boolean(presentAgentTurn(latestMessage, events, closedInputRequestIds)?.showExecutionGroup),
        isBusy,
        isEditing: composerIsEditing,
        isRestoring,
        renderedUserId,
        scrollOnInitialize: viewportScrollOnInitialize,
        scrollOnThreadSwitch: viewportScrollOnThreadSwitch,
        userId: latestUserId,
        userKey,
        viewportRef,
    });
    const canRespondToInputRequest = eveMessages.some((message) => message.parts.some((part) => (part.type === "tool" && part.interaction?.status === "open") || (part.type === "interaction" && part.status === "open")));
    const loadEarlierNearTop = useCallback(() => {
        const viewport = viewportRef.current;
        if (!viewport || !historyHasMore || historyLoading ||
            historyRequestInFlightRef.current || !onLoadEarlier ||
            historyStartIndex === undefined)
            return;
        const viewportTop = viewport.getBoundingClientRect().top;
        const visibleMessage = [...viewport.querySelectorAll("[data-message-id]")].find((element) => element.getBoundingClientRect().bottom > viewportTop);
        historyRequestInFlightRef.current = true;
        pendingHistoryAnchorRef.current = {
            ...(visibleMessage?.dataset.messageId
                ? {
                    messageId: visibleMessage.dataset.messageId,
                    messageOffsetTop: visibleMessage.getBoundingClientRect().top - viewportTop,
                }
                : {}),
            scrollHeight: viewport.scrollHeight,
            scrollTop: viewport.scrollTop,
            startIndex: historyStartIndex,
        };
        void Promise.resolve()
            .then(onLoadEarlier)
            .catch(() => undefined)
            .finally(() => {
            historyRequestInFlightRef.current = false;
        });
    }, [historyHasMore, historyLoading, historyStartIndex, onLoadEarlier]);
    const handleViewportScroll = useCallback(() => {
        const viewport = viewportRef.current;
        if (!viewport || viewport.scrollTop > 240)
            return;
        loadEarlierNearTop();
    }, [loadEarlierNearTop]);
    useLayoutEffect(() => {
        const anchor = pendingHistoryAnchorRef.current;
        const viewport = viewportRef.current;
        if (!anchor || !viewport || historyStartIndex === undefined || historyStartIndex >= anchor.startIndex)
            return;
        let frameCount = 0;
        let frame;
        const restore = () => {
            const currentViewport = viewportRef.current;
            if (!currentViewport)
                return;
            const currentMessage = anchor.messageId
                ? [...currentViewport.querySelectorAll("[data-message-id]")].find((element) => element.dataset.messageId === anchor.messageId)
                : undefined;
            const pageRendered = currentViewport.scrollHeight > anchor.scrollHeight;
            if (pageRendered && currentMessage && anchor.messageOffsetTop !== undefined) {
                const nextOffsetTop = currentMessage.getBoundingClientRect().top - currentViewport.getBoundingClientRect().top;
                currentViewport.scrollTop += nextOffsetTop - anchor.messageOffsetTop;
                pendingHistoryAnchorRef.current = undefined;
                return;
            }
            if (pageRendered) {
                currentViewport.scrollTop = anchor.scrollTop + (currentViewport.scrollHeight - anchor.scrollHeight);
                pendingHistoryAnchorRef.current = undefined;
                return;
            }
            if (frameCount >= 8) {
                pendingHistoryAnchorRef.current = undefined;
            }
            else {
                frameCount += 1;
                frame = window.requestAnimationFrame(restore);
            }
        };
        frame = window.requestAnimationFrame(restore);
        return () => {
            if (frame !== undefined)
                window.cancelAnimationFrame(frame);
        };
    }, [eveMessages.length, historyLoading, historyStartIndex]);
    return (_jsx(ThreadPrimitive.Root, { className: "aui-root flex h-full min-h-0 flex-col bg-background", style: { "--thread-max-width": "48rem" }, children: _jsxs(ThreadPrimitive.Viewport, { "aria-live": "polite", autoScroll: false, scrollToBottomOnRunStart: false, onScroll: handleViewportScroll, ref: viewportRef, scrollToBottomOnInitialize: false, scrollToBottomOnThreadSwitch: false, turnAnchor: "bottom", className: "relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-3 pt-3 sm:px-4 sm:pt-4", "data-slot": "thread-viewport", role: "log", children: [historyLoading ? (_jsxs("div", { className: "pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 text-muted-foreground", "data-agent-history-loading": true, role: "status", children: [_jsx(LoaderCircleIcon, { className: "size-4 animate-spin" }), _jsx("span", { className: "sr-only", children: locale === "zh-CN" ? "正在加载更早消息" : "Loading earlier messages" })] })) : null, _jsxs("div", { ref: contentRef, className: "mx-auto mb-14 flex w-full shrink-0 max-w-(--thread-max-width) flex-col gap-y-6 empty:hidden", children: [_jsx(ThreadPrimitive.Messages, { children: ({ message }) => message.composer.isEditing ? (_jsx(EditMessage, { messages: messages })) : message.role === "user" ? (_jsx(UserMessage, { isBusy: isBusy, messages: messages, messageEditingAllowed: messageEditingAllowed, sessionTerminal: sessionTerminal, sessionSettled: sessionSettled })) : (_jsx(AssistantMessage, { assetUrl: assetUrl, canRespond: !runtimeDisabled && (!isBusy || canRespondToInputRequest), events: events, fallbackStartedAt: fallbackStartedAt, isStreaming: isBusy && !runtimeError && message.id === lastAssistantMessageId, locale: locale, message: eveMessagesById.get(message.id), messages: messages, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, onOpenDeliverable: onOpenDeliverable, onOpenSubagent: onOpenSubagent, closedInputRequestIds: closedInputRequestIds, onRetryRuntimeError: onRetryRuntimeError, runtimeError: message.id === lastAssistantMessageId ? runtimeError : undefined, runtimeFailure: message.id === lastAssistantMessageId ? runtimeFailure : undefined, runtimeRetry: message.id === lastAssistantMessageId ? runtimeRetry : undefined })) }), runtimeError && !lastAssistantMessageId ? (_jsx(RuntimeErrorMessage, { locale: locale, message: runtimeError, messages: messages, onRetry: onRetryRuntimeError, failure: runtimeFailure, retry: runtimeRetry })) : null] }), _jsx("div", { "aria-hidden": "true", className: "shrink-0", "data-slot": "task-scroll-reserve", ref: reserveRef }), _jsx(ThreadPrimitive.Empty, { children: isRestoring ? _jsx(AgentHistoryLoading, { locale: locale }) : !isBusy && !runtimeError ? _jsx(AssistantEmptyState, { messages: messages }) : null }), _jsxs(ThreadPrimitive.ViewportFooter, { "data-slot": "thread-viewport-footer", className: "sticky bottom-0 z-20 mx-auto mt-auto flex w-full shrink-0 max-w-(--thread-max-width) flex-col bg-background pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-0 sm:pb-4 md:pb-5", children: [_jsx(ThreadPrimitive.ScrollToBottom, { asChild: true, children: _jsx(TooltipIconButton, { tooltip: locale === "zh-CN" ? "滚动到底部" : "Scroll to bottom", onClick: resumeBottomFollow, className: "absolute -top-9 left-1/2 z-10 size-8 -translate-x-1/2 rounded-full disabled:invisible", variant: "outline", children: _jsx(ArrowDownIcon, { className: "size-4" }) }) }), composerHidden ? null : _jsx(AssistantComposer, { approvalTakeover: approvalTakeover, cancellationState: cancellationState, commands: commands, composerTop: composerTop, draftStorageKey: draftStorageKey, draftRestore: draftRestore, inputDisabled: inputDisabled, isBusy: isBusy, sessionSettled: sessionSettled, locale: locale, mentions: mentions, messages: messages, models: models, onPreferencesChange: onPreferencesChange, onInputResponses: onInputResponses, onCancel: onCancel, onDraftRestoreConsumed: onDraftRestoreConsumed, preferences: preferences, reasoningLevels: reasoningLevels, usage: usage })] })] }) }));
}
function RuntimeErrorMessage({ failure, locale, message, messages, onRetry, retry, }) {
    const category = classifyAgentFailure(failure ?? { code: "", message });
    const transient = category !== "unknown";
    const title = retry?.exhausted
        ? messages.retryFailed
        : retry
            ? `${messages.retryingRequest} (${retry.attempt}/${retry.maximum})`
            : failure
                ? failureTitle(locale, failure)
                : locale === "zh-CN" ? "本轮执行失败" : messages.requestFailed;
    const detailFailure = retry?.error ?? failure ?? { code: "", message };
    if (retry && !retry.exhausted) {
        return (_jsxs(Collapsible, { className: "mx-auto w-full max-w-(--thread-max-width) text-sm text-muted-foreground", "data-agent-retry": true, defaultOpen: false, children: [_jsxs(CollapsibleTrigger, { className: "group/retry flex max-w-full items-center gap-2 px-1 py-1.5 text-left hover:text-foreground", children: [_jsx(WifiIcon, { className: "size-4 shrink-0" }), _jsx("span", { children: title }), _jsx(ChevronDownIcon, { className: "size-3.5 -rotate-90 transition-transform group-data-[state=open]/retry:rotate-0" })] }), _jsx(CollapsibleContent, { className: "overflow-hidden", children: _jsxs("div", { className: "ml-7 mt-1 max-w-full text-xs", children: [_jsx("p", { className: "break-words text-foreground", children: failureSummary(locale, detailFailure) }), detailFailure.code ? _jsx("code", { className: "mt-1 block break-all text-muted-foreground", children: detailFailure.code }) : null] }) })] }));
    }
    return (_jsxs(Alert, { className: "mx-auto mt-2 w-full max-w-(--thread-max-width) py-2.5", "data-agent-failure-alert": true, "data-agent-message-error": true, variant: "destructive", children: [_jsx(CircleXIcon, {}), _jsx(AlertTitle, { children: title }), _jsxs(AlertDescription, { children: [_jsx("p", { children: failureSummary(locale, detailFailure) }), detailFailure.code ? _jsx("code", { className: "break-all text-xs", children: detailFailure.code }) : null, !retry?.exhausted && !retry && !transient ? _jsx("p", { children: messages.requestPreserved }) : null, onRetry ? (_jsxs(Button, { className: "mt-1 h-7 px-2.5 text-xs", onClick: onRetry, size: "sm", variant: "outline", children: [_jsx(RotateCcwIcon, { className: "size-3.5" }), messages.retry] })) : null] })] }));
}
function failureTitle(locale, failure) {
    switch (classifyAgentFailure(failure)) {
        case "network": return locale === "zh-CN" ? "网络连接失败" : "Network connection failed";
        case "timeout": return locale === "zh-CN" ? "请求超时" : "Request timed out";
        case "provider": return locale === "zh-CN" ? "模型请求失败" : "Model request failed";
        default: return locale === "zh-CN" ? "本轮执行失败" : "This turn failed";
    }
}
function failureSummary(locale, failure) {
    const statusCode = failure.statusCode;
    const status = statusCode === undefined ? "" : ` (HTTP ${statusCode})`;
    switch (classifyAgentFailure(failure)) {
        case "network": return locale === "zh-CN" ? `连接失败${status}。` : `The connection failed${status}.`;
        case "timeout": return locale === "zh-CN" ? `请求超时${status}。` : `The request timed out${status}.`;
        case "provider": return locale === "zh-CN" ? `模型请求未完成${status}。` : `The model request could not be completed${status}.`;
        default: return locale === "zh-CN" ? `请求未完成${status}。` : `The request could not be completed${status}.`;
    }
}
function UserMessage({ isBusy, messages, messageEditingAllowed, sessionTerminal = false, sessionSettled }) {
    const [actionsVisible, setActionsVisible] = useState(false);
    const isLastUserMessage = useAuiState((state) => {
        const lastUser = [...state.thread.messages].reverse().find((message) => message.role === "user");
        return lastUser?.id === state.message.id;
    });
    const canEdit = messageEditingAllowed && isLastUserMessage && !isBusy && !sessionTerminal && sessionSettled !== false;
    return (_jsxs(MessagePrimitive.Root, { className: "group fade-in slide-in-from-bottom-1 animate-in mx-auto grid w-full max-w-(--thread-max-width) auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [&:where(>*)]:col-start-2", children: [_jsxs("div", { className: "col-start-2 ml-auto flex max-w-full flex-col items-end gap-3 empty:hidden", "data-user-attachments": true, children: [_jsx("div", { className: "flex max-w-full flex-wrap justify-end gap-3 empty:hidden", "data-user-image-attachments": true, children: _jsx(MessagePrimitive.Attachments, { children: ({ attachment }) => isImageAttachment(attachment) ? _jsx(UserAttachment, { attachment: attachment, messages: messages }) : null }) }), _jsx("div", { className: "flex max-w-full flex-wrap justify-end gap-2 empty:hidden", "data-user-file-attachments": true, children: _jsx(MessagePrimitive.Attachments, { children: ({ attachment }) => !isImageAttachment(attachment) ? _jsx(UserAttachment, { attachment: attachment, messages: messages }) : null }) })] }), _jsxs("div", { className: "relative col-start-2 min-w-0", children: [_jsx("div", { className: "peer rounded-xl bg-muted px-4 py-2 text-foreground wrap-break-word empty:hidden", onClick: () => {
                            if (window.matchMedia("(pointer: coarse)").matches)
                                setActionsVisible((visible) => !visible);
                        }, children: _jsx(MessagePrimitive.Parts, { components: { Text: DirectiveText } }) }), _jsx("div", { className: cn("flex min-h-7.5 items-center justify-end gap-0.5 pt-1.5 transition-opacity peer-empty:hidden", actionsVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"), children: _jsxs(ActionBarPrimitive.Root, { className: "flex items-center justify-end gap-0.5 text-muted-foreground", children: [_jsx(ReliableCopyButton, { label: messages.copyResponse }), canEdit ? (_jsx(ActionBarPrimitive.Edit, { asChild: true, children: _jsx(TooltipIconButton, { "aria-label": messages.editMessage, className: "text-muted-foreground hover:text-foreground", tooltip: messages.editMessage, children: _jsx(PencilIcon, { className: "size-3.5" }) }) })) : null] }) })] })] }));
}
function isImageAttachment(attachment) {
    return attachment.contentType?.startsWith("image/") ?? attachment.type === "image";
}
function UserAttachment({ attachment, messages }) {
    const isImage = isImageAttachment(attachment);
    const isTextPreviewable = isTextAssetPreviewable(attachment.contentType);
    const contentUrl = attachmentContentUrl(attachment);
    const [textPreviewOpen, setTextPreviewOpen] = useState(false);
    const textPreview = useAssetText(textPreviewOpen && isTextPreviewable ? contentUrl : undefined);
    const download = useAssetDownload(contentUrl, attachment.name);
    return (_jsxs(_Fragment, { children: [isImage ? (_jsx(AttachmentImagePreview, { dismissLabel: messages.dismiss, label: `${messages.attachment}: ${attachment.name}`, name: attachment.name, retryLabel: messages.retry, source: contentUrl })) : (_jsx(Attachment, { className: "h-10 min-w-0 max-w-full flex-nowrap rounded-full", "data-attachment-kind": "file", state: "done", children: _jsxs("button", { "aria-label": `${messages.attachment}: ${attachment.name}`, className: "flex h-full min-w-0 items-center gap-2 rounded-full px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", disabled: download.loading || !contentUrl, onClick: () => isTextPreviewable ? setTextPreviewOpen(true) : void download.download(), title: attachment.name, type: "button", children: [_jsx(AttachmentFileIcon, { filename: attachment.name, mediaType: attachment.contentType }), _jsx("span", { className: "truncate font-medium", children: attachment.name })] }) })), download.error ? _jsx("p", { className: "text-xs text-destructive", role: "alert", children: download.error }) : null, isTextPreviewable ? _jsx(Dialog, { open: textPreviewOpen, onOpenChange: setTextPreviewOpen, children: _jsxs(DialogContent, { className: "grid max-h-[min(80vh,48rem)] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto]", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { className: "truncate pr-8", children: attachment.name }), _jsx(DialogDescription, { children: attachment.contentType ?? messages.attachment })] }), _jsx("div", { className: "min-h-0 overflow-auto rounded-md border bg-muted/20 p-3", children: textPreview.error ? _jsx("p", { className: "text-sm text-destructive", role: "alert", children: textPreview.error })
                                : textPreview.text !== undefined ? _jsx("pre", { className: "whitespace-pre-wrap break-words font-mono text-xs leading-5", children: textPreview.text })
                                    : _jsx("p", { "aria-live": "polite", className: "text-sm text-muted-foreground", children: messages.loading }) }), _jsxs(DialogFooter, { className: "flex-row items-center justify-between sm:justify-between", children: [_jsxs("div", { className: "min-w-0 flex-1 text-xs text-muted-foreground", children: [textPreview.truncated ? messages.previewTruncated : null, textPreview.error ? _jsxs(Button, { className: "mt-1", onClick: textPreview.retry, size: "sm", variant: "ghost", children: [_jsx(RotateCcwIcon, { className: "size-3.5" }), messages.retry] }) : null] }), _jsxs(Button, { disabled: download.loading, onClick: () => void download.download(), size: "sm", children: [_jsx(DownloadIcon, { className: "size-3.5" }), messages.downloadCompleteFile] })] })] }) }) : null] }));
}
function isTextAssetPreviewable(mediaType) {
    const normalized = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
    return Boolean(normalized && (["text/plain", "text/html", "text/markdown", "text/csv", "text/tab-separated-values", "application/json", "application/x-ndjson", "application/yaml", "application/x-yaml"].includes(normalized)));
}
function attachmentContentUrl(attachment) {
    for (const part of attachment.content) {
        const value = part.type === "file" ? part.data : part.type === "image" ? part.image : undefined;
        if (typeof value === "string")
            return value;
        const candidate = value;
        if (candidate instanceof URL)
            return candidate.toString();
    }
    return undefined;
}
function AssistantMessage({ assetUrl, canRespond, closedInputRequestIds, events, fallbackStartedAt, isStreaming, locale, message, messages, onInputResponses, onCloseInputRequest, onOpenDeliverable, onOpenSubagent, onRetryRuntimeError, runtimeError, runtimeFailure, runtimeRetry, }) {
    const task = message
        ? presentAgentTurn(message, events, closedInputRequestIds)
        : undefined;
    const copyableText = message
        ? task
            ? task.status === "completed" ? task.finalPart?.text.trim() : undefined
            : message.metadata?.status === "failed"
                ? undefined
                : message.parts
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
                    .trim() || undefined
        : undefined;
    return (_jsxs(MessagePrimitive.Root, { className: "group relative mx-auto w-full max-w-(--thread-max-width)", children: [_jsxs("div", { className: "min-w-0 px-2 leading-relaxed text-foreground wrap-break-word", children: [message ? (_jsx(AgentMessage, { assetUrl: assetUrl, canRespond: canRespond, closedInputRequestIds: closedInputRequestIds, events: events, fallbackStartedAt: fallbackStartedAt, isStreaming: isStreaming, locale: locale, message: message, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, onOpenDeliverable: onOpenDeliverable, onOpenSubagent: onOpenSubagent, showCopyAction: false })) : (_jsx(MessagePrimitive.Parts, { components: { Text: MarkdownText, tools: { Fallback: ToolFallback } } })), runtimeError ? (_jsx(RuntimeErrorMessage, { failure: runtimeFailure, locale: locale, message: runtimeError, messages: messages, onRetry: onRetryRuntimeError, retry: runtimeRetry })) : null] }), !isStreaming && copyableText ? (_jsx("div", { className: "-mb-7.5 ml-2 flex min-h-7.5 items-center pt-1.5", children: _jsx(ActionBarPrimitive.Root, { autohide: "not-last", className: "text-muted-foreground flex gap-1", hideWhenRunning: true, children: _jsx(ReliableCopyButton, { label: messages.copyResponse, text: copyableText }) }) })) : null] }));
}
function ReliableCopyButton({ label, text }) {
    const aui = useAui();
    const [copied, setCopied] = useState(false);
    const timer = useRef(undefined);
    useEffect(() => () => window.clearTimeout(timer.current), []);
    return (_jsx(TooltipIconButton, { "aria-label": label, className: "text-muted-foreground hover:bg-accent hover:text-foreground", type: "button", tooltip: copied ? "Copied" : label, variant: "ghost", onClick: () => {
            const copyValue = text ?? aui.message.getCopyText();
            void copyText(copyValue).then(() => {
                setCopied(true);
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => setCopied(false), 1_500);
            }).catch(() => setCopied(false));
        }, children: copied ? _jsx(CheckIcon, { className: "size-3.5" }) : _jsx(CopyIcon, { className: "size-3.5" }) }));
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
export function AssistantComposer({ approvalTakeover, cancellationState, commands, composerTop, draftStorageKey, draftRestore, inputDisabled = false, isBusy = false, sessionSettled = false, locale, mentions, messages, models, onPreferencesChange, onInputResponses, onCancel, onDraftRestoreConsumed, preferences, reasoningLevels, usage, }) {
    const aui = useAui();
    const isRunning = useAuiState((state) => state.thread.isRunning);
    const composerIsEmpty = useAuiState((state) => state.composer.isEmpty);
    const composerText = useAuiState((state) => state.composer.text);
    const hasSendableContent = useAuiState((state) => state.composer.text.trim().length > 0
        || state.composer.attachments.some((attachment) => attachment.status.type === "complete" || attachment.status.type === "requires-action"));
    const hasPendingAttachment = useAuiState((state) => state.composer.attachments.some((attachment) => attachment.status.type === "running" || attachment.status.type === "incomplete"));
    const runtimeInputDisabled = useAuiState((state) => state.thread.isDisabled);
    const stopping = cancellationState !== "idle";
    const runtimeBusy = isBusy || (isRunning && !sessionSettled);
    const composerDisabled = inputDisabled || runtimeInputDisabled;
    const composerInputRef = useRef(null);
    const auiRef = useRef(aui);
    const draftHydrationRef = useRef(undefined);
    const previousDraftKeyRef = useRef(undefined);
    auiRef.current = aui;
    const consumedDraftRestoreIdRef = useRef(undefined);
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
        if (!draftRestore || consumedDraftRestoreIdRef.current === draftRestore.id)
            return;
        consumedDraftRestoreIdRef.current = draftRestore.id;
        draftHydrationRef.current = undefined;
        aui.composer.setText(draftRestore.text);
        onDraftRestoreConsumed(draftRestore.id);
    }, [aui, draftRestore, onDraftRestoreConsumed]);
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
        efforts: (candidate.reasoningLevels ?? reasoningLevels).map((level) => ({
            id: level,
            name: formatReasoningLevel(level, locale),
        })),
        id: candidate.id,
        name: candidate.label,
    })), [models, reasoningLevels]);
    const contextLabels = {
        cachedInput: messages.cacheReadTokens,
        cacheWrite: messages.cacheWriteTokens,
        contextUsage: messages.contextUsage,
        estimatedCost: messages.estimatedCost,
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
        cacheWriteTokens: usage.cacheWriteTokens,
        costUsd: usage.costUsd,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: 0,
        totalTokens: usage.inputTokens + usage.outputTokens,
    };
    const touchInput = typeof window !== "undefined" && window.matchMedia("(pointer: coarse) and (not (any-pointer: fine))").matches;
    return (_jsx(ComposerPrimitive.Unstable_TriggerPopoverRoot, { children: _jsxs(ComposerPrimitive.Root, { className: "relative flex w-full flex-col", onSubmit: (event) => {
                event.preventDefault();
                if (!composerDisabled) {
                    aui.composer.send();
                    blurComposerOnTouch(composerInputRef);
                }
            }, children: [_jsxs("div", { className: "flex w-full flex-col gap-2 rounded-[1.5rem] border border-border/70 bg-background p-2.5 shadow-[0_8px_24px_-16px_rgba(0,0,0,0.24)]", children: [composerTop, approvalTakeover ? (_jsx(ApprovalComposerTakeover, { cancellationState: cancellationState, locale: locale, onCancel: onCancel, onRespond: onInputResponses, request: approvalTakeover })) : (_jsxs(_Fragment, { children: [_jsx(AttachmentGroup, { className: "gap-2.5 px-1 py-1 empty:hidden", "data-composer-attachments": true, children: _jsx(ComposerPrimitive.Attachments, { children: ({ attachment }) => (_jsx(ComposerAttachment, { attachment: attachment, messages: messages })) }) }), _jsx(LexicalComposerInput, { "aria-disabled": composerDisabled, directiveChip: DirectiveChip, placeholder: messages.inputPlaceholder, ref: composerInputRef, submitMode: touchInput ? "ctrlEnter" : "enter", onKeyDownCapture: (event) => {
                                        if (touchInput || !isRunning || event.key !== "Enter" || event.shiftKey || composerDisabled || composerIsEmpty)
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
                                    }, className: "aui-composer-input relative max-h-40 min-h-12 w-full resize-none overflow-y-auto bg-transparent px-2 py-1 text-[15px] leading-6 outline-none aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:items-center [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-md [&_.aui-directive-chip]:bg-muted [&_.aui-directive-chip]:px-1.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-foreground [&_.aui-directive-chip-icon]:text-muted-foreground [&_.aui-lexical-input]:min-h-6 [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:inset-x-0 [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:truncate [&_.aui-lexical-placeholder]:px-2 [&_.aui-lexical-placeholder]:py-1 [&_.aui-lexical-placeholder]:text-muted-foreground" }), _jsxs("div", { className: "flex min-h-9 items-center gap-0.5 sm:min-h-8 sm:gap-1", children: [_jsx(ComposerPrimitive.AddAttachment, { asChild: true, children: _jsx(Button, { "aria-label": messages.addFiles, className: "size-9 rounded-full text-muted-foreground sm:size-8", size: "icon-sm", type: "button", variant: "ghost", children: _jsx(PlusIcon, { className: "size-4" }) }) }), _jsx(ExecutionModeMenu, { messages: messages, onChange: (executionMode) => onPreferencesChange({ ...preferences, executionMode }), value: preferences.executionMode ?? "standard" }), _jsx(ModelSelector, { align: "start", className: "h-9 min-w-0 max-w-48 rounded-full px-2 text-muted-foreground sm:h-8 sm:max-w-64", contentClassName: "w-72 max-w-[calc(100vw-1.5rem)] text-xs", effort: preferences.reasoning, effortLabel: messages.reasoning, models: selectorModels, onEffortChange: (reasoning) => onPreferencesChange({ ...preferences, reasoning }), onValueChange: (modelId) => {
                                                const selectedModel = models.find((candidate) => candidate.id === modelId);
                                                const supportedLevels = selectedModel?.reasoningLevels;
                                                const reasoning = supportedLevels && !supportedLevels.includes(preferences.reasoning)
                                                    ? selectedModel.defaultReasoning ?? supportedLevels[0] ?? preferences.reasoning
                                                    : preferences.reasoning;
                                                onPreferencesChange({ ...preferences, modelId, reasoning });
                                            }, searchable: models.length > 6, size: "sm", value: model?.id ?? preferences.modelId, valueClassName: "text-xs font-normal", variant: "ghost", triggerLabel: messages.model }), _jsxs("span", { className: "ml-auto flex min-w-0 items-center gap-0.5 sm:gap-1", children: [model ? (_jsx(ContextDisplay.Ring, { className: "h-9 shrink-0 rounded-full px-1.5 sm:h-8", label: messages.context, labels: contextLabels, modelContextWindow: model.contextWindowTokens, side: "top", sessionUsage: sessionUsage, usage: contextUsage })) : null, _jsx(Button, { "aria-hidden": !((stopping || runtimeBusy) && composerIsEmpty), "aria-label": cancellationState === "idle" ? messages.cancel : messages.stopping, className: cn("size-9 shrink-0 rounded-full sm:size-8", !((stopping || runtimeBusy) && composerIsEmpty) && "hidden"), disabled: cancellationState !== "idle" || !((stopping || runtimeBusy) && composerIsEmpty), onClick: () => onCancel?.(), size: "icon-sm", tabIndex: (stopping || runtimeBusy) && composerIsEmpty ? 0 : -1, type: "button", children: cancellationState === "idle" ? (_jsx(SquareIcon, { className: "size-3.5 fill-current" })) : (_jsx(LoaderCircleIcon, { className: "size-4 animate-spin" })) }), _jsx(Button, { "aria-hidden": (stopping || runtimeBusy) && composerIsEmpty, "aria-label": runtimeBusy && !stopping ? messages.queueFollowUp : messages.send, className: cn("size-9 shrink-0 rounded-full sm:size-8", ((stopping || runtimeBusy) && composerIsEmpty) && "hidden"), disabled: composerDisabled || !hasSendableContent || hasPendingAttachment || ((stopping || runtimeBusy) && composerIsEmpty), onClick: () => {
                                                        aui.composer.send();
                                                        blurComposerOnTouch(composerInputRef);
                                                    }, size: "icon-sm", tabIndex: (stopping || runtimeBusy) && composerIsEmpty ? -1 : 0, type: "button", children: _jsx(ArrowUpIcon, { className: "size-4" }) })] })] })] }))] }), _jsx(ComposerTriggerPopover, { char: "@", ...mention, emptyItemsLabel: messages.noPromptItems }), _jsx(ComposerTriggerPopover, { char: "/", ...command, emptyItemsLabel: messages.noPromptItems })] }) }));
}
function blurComposerOnTouch(inputRef) {
    if (!window.matchMedia("(pointer: coarse)").matches)
        return;
    window.requestAnimationFrame(() => {
        inputRef.current?.querySelector('[role="textbox"]')?.blur();
    });
}
function ComposerAttachment({ attachment, messages }) {
    const [previewUrl, setPreviewUrl] = useState();
    useEffect(() => {
        if (!attachment.file || !attachment.contentType?.startsWith("image/")) {
            setPreviewUrl(undefined);
            return;
        }
        const url = URL.createObjectURL(attachment.file);
        setPreviewUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [attachment.contentType, attachment.file]);
    const isImage = isImageAttachment(attachment);
    const state = attachment.status.type === "incomplete" ? "error" : attachment.status.type === "running" ? "uploading" : "done";
    const progress = attachment.status.type === "running" ? Math.max(0, Math.min(100, Math.round(attachment.status.progress))) : 0;
    const controls = _jsxs(_Fragment, { children: [attachment.status.type === "running" ? (_jsxs("span", { "aria-label": `${messages.attachment}: ${attachment.name}`, "aria-valuemax": 100, "aria-valuemin": 0, "aria-valuenow": progress, "aria-valuetext": `${progress}%`, className: "pointer-events-none absolute left-1.5 top-1.5 z-20 flex size-6 items-center justify-center rounded-full bg-background/95 text-foreground shadow-sm", role: "progressbar", title: `${progress}%`, children: [_jsxs("svg", { "aria-hidden": true, className: "absolute inset-0 size-full -rotate-90", fill: "none", viewBox: "0 0 24 24", children: [_jsx("circle", { className: "text-border", cx: "12", cy: "12", r: "9.5", stroke: "currentColor", strokeWidth: "2" }), _jsx("circle", { cx: "12", cy: "12", pathLength: "100", r: "9.5", stroke: "currentColor", strokeDasharray: "100", strokeDashoffset: 100 - progress, strokeLinecap: "round", strokeWidth: "2" })] }), _jsx("span", { "aria-hidden": true, className: "text-[8px] font-medium tabular-nums", children: progress })] })) : attachment.status.type === "incomplete" ? (_jsx("span", { className: cn("pointer-events-none absolute inset-x-1.5 bottom-9 z-20 line-clamp-2 rounded bg-background/95 px-1.5 py-1 text-[10px] leading-3 text-destructive shadow-sm", isImage && "bottom-1.5"), role: "alert", title: attachment.status.message, children: attachment.status.message ?? messages.attachment })) : null, _jsx(AttachmentPrimitive.Remove, { "aria-label": `${messages.removeAttachment}: ${attachment.name}`, className: "absolute right-1.5 top-1.5 z-20 flex size-6 items-center justify-center rounded-full border border-border/60 bg-background/95 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/attachment:opacity-100 group-focus-within/attachment:opacity-100 [@media(hover:none)]:opacity-100", children: _jsx(XIcon, { className: "size-3.5" }) })] });
    return isImage ? (_jsx(AttachmentImagePreview, { className: "size-24", dismissLabel: messages.dismiss, label: `${messages.attachment}: ${attachment.name}`, name: attachment.name, retryLabel: messages.retry, source: previewUrl, state: state, children: controls })) : (_jsxs(Attachment, { className: "h-24 w-36 min-w-0 max-w-[calc(100vw-4rem)] flex-col flex-nowrap gap-0 overflow-hidden rounded-lg", "data-attachment-kind": "file", state: state, children: [_jsx("div", { className: "flex w-full flex-1 items-center justify-center bg-muted/50 text-muted-foreground", children: _jsx(FileIcon, { className: "size-5", strokeWidth: 1.5 }) }), _jsxs("div", { className: "flex h-8 w-full shrink-0 items-center gap-1.5 px-2", title: attachment.name, children: [_jsx(AttachmentFileIcon, { className: "size-3.5", filename: attachment.name, mediaType: attachment.contentType, preview: true }), _jsx("span", { className: "min-w-0 truncate text-xs", children: attachment.name })] }), controls] }));
}
function ApprovalComposerTakeover({ cancellationState, locale, onCancel, onRespond, request, }) {
    const isZh = locale === "zh-CN";
    const stopping = cancellationState !== "idle";
    const [submitting, setSubmitting] = useState(false);
    const respond = async (optionId) => {
        if (submitting || stopping)
            return;
        setSubmitting(true);
        try {
            await onRespond([{ optionId, interactionId: request.requestId }]);
        }
        finally {
            setSubmitting(false);
        }
    };
    return (_jsxs("section", { "aria-label": isZh ? "工具调用等待批准" : "Tool call awaiting approval", className: "flex min-h-28 items-start gap-3 px-1 py-1", "data-agent-approval-takeover": true, role: "alertdialog", children: [_jsx("span", { className: "flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300", children: _jsx(ShieldCheckIcon, { className: "size-4" }) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "text-sm font-medium text-foreground", children: isZh ? `批准工具调用：${approvalToolLabel(request.toolName, locale)}` : `Approve tool call: ${approvalToolLabel(request.toolName, locale)}` }), _jsx("p", { className: "mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground", children: request.prompt }), _jsx(ApprovalTakeoverDetails, { input: request.input, toolName: request.toolName }), _jsxs("div", { className: "mt-3 flex justify-end gap-2", children: [onCancel ? _jsxs(Button, { className: "mr-auto", disabled: submitting || stopping, onClick: onCancel, size: "sm", title: isZh ? "停止当前任务" : "Stop the current task", variant: "ghost", children: [stopping ? _jsx(LoaderCircleIcon, { className: "size-3.5 animate-spin" }) : _jsx(SquareIcon, { className: "size-3 fill-current" }), stopping ? (isZh ? "正在停止" : "Stopping") : (isZh ? "停止" : "Stop")] }) : null, _jsx(Button, { className: "min-w-16", disabled: submitting || stopping, onClick: () => void respond("deny"), size: "sm", variant: "ghost", children: isZh ? "拒绝" : "Deny" }), _jsxs(Button, { className: "min-w-16", disabled: submitting || stopping, onClick: () => void respond("approve"), size: "sm", children: [submitting ? _jsx(LoaderCircleIcon, { className: "size-3.5 animate-spin" }) : null, isZh ? "批准" : "Approve"] })] })] })] }));
}
function ApprovalTakeoverDetails({ input, toolName }) {
    if (input === undefined)
        return null;
    const normalized = toolName.toLocaleLowerCase().replaceAll("-", "_");
    const record = typeof input === "object" && input !== null && !Array.isArray(input)
        ? input
        : undefined;
    const command = ["bash", "shell", "terminal", "exec_command"].includes(normalized)
        ? [record?.command, record?.cmd].find((value) => typeof value === "string")
        : undefined;
    let detail = command;
    if (!detail) {
        try {
            detail = typeof input === "string" ? input : JSON.stringify(input, null, 2);
        }
        catch {
            detail = String(input);
        }
    }
    if (!detail)
        return null;
    return _jsx("pre", { className: "mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs text-foreground", children: detail });
}
function approvalToolLabel(toolName, locale) {
    const normalized = toolName.toLocaleLowerCase().replaceAll("-", "_");
    if (["bash", "shell", "terminal", "exec_command"].includes(normalized))
        return locale === "zh-CN" ? "终端命令" : "Terminal command";
    if (["apply_patch", "patch_file", "write_file", "edit_file"].includes(normalized))
        return locale === "zh-CN" ? "文件变更" : "File change";
    if (["web_fetch", "fetch_url", "web_search", "search_web"].includes(normalized))
        return locale === "zh-CN" ? "网络访问" : "Network access";
    return toolName;
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
    return (_jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsxs(Button, { "aria-label": messages.executionMode, className: "h-9 max-w-40 gap-1.5 rounded-full px-2.5 text-muted-foreground sm:h-8", type: "button", variant: "ghost", children: [_jsx(ShieldCheckIcon, { className: "size-4" }), _jsx("span", { className: "hidden truncate text-xs sm:inline", children: selected.label })] }) }), _jsxs(DropdownMenuContent, { align: "start", className: "w-80 max-w-[calc(100vw-1.5rem)] text-xs", side: "top", children: [_jsx(DropdownMenuLabel, { className: "text-xs", children: messages.executionMode }), _jsx(DropdownMenuRadioGroup, { onValueChange: (next) => onChange(next), value: value, children: options.map((option) => {
                            const Icon = option.icon;
                            return (_jsxs(DropdownMenuRadioItem, { className: "items-start py-2 text-xs", value: option.value, children: [_jsx(Icon, { className: "mt-0.5 size-3.5 shrink-0 text-muted-foreground" }), _jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block text-xs font-medium text-foreground", children: option.label }), _jsx("span", { className: "mt-0.5 block whitespace-normal text-xs leading-4 text-muted-foreground", children: option.description })] })] }, option.value));
                        }) })] })] }));
}
function formatReasoningLevel(level, locale) {
    if (locale === "zh-CN") {
        if (level === "none")
            return "无";
        if (level === "low")
            return "低";
        if (level === "medium")
            return "中";
        if (level === "high")
            return "高";
        if (level === "xhigh")
            return "极高";
        if (level === "max")
            return "最大";
    }
    if (level === "none")
        return "None";
    if (level === "xhigh")
        return "X high";
    if (level === "max")
        return "Max";
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