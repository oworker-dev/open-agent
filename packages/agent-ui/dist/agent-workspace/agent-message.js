"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { BracesIcon, CheckIcon, CheckCircleIcon, ChevronDownIcon, CircleStopIcon, CopyIcon, ExternalLinkIcon, FileIcon, ImageIcon, KeyRoundIcon, LoaderCircleIcon, NetworkIcon, SearchIcon, TerminalIcon, FileSearchIcon, ListChecksIcon, MessageCircleQuestionIcon, ShieldCheckIcon, WifiIcon, XCircleIcon, } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useScrollLock } from "@assistant-ui/react";
import { StaticMarkdownText } from "../assistant-ui/markdown-text.js";
import { copyText } from "../assistant-ui/copy-text.js";
import { ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger, } from "../assistant-ui/reasoning.js";
import { ToolFallbackContent, ToolFallbackRoot, } from "../assistant-ui/tool-fallback.js";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger, } from "../assistant-ui/tool-group.js";
import { DiffViewer } from "../assistant-ui/diff-viewer.js";
import { Button } from "../ui/button.js";
import { Attachment, AttachmentAction, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "../ui/attachment.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { Questionnaire, QuestionnaireChoice, QuestionnaireChoiceDescription, QuestionnaireChoices, QuestionnaireError, QuestionnaireItem, QuestionnaireSubmit, QuestionnaireTitle, } from "../ui/questionnaire.js";
import { cn } from "../utils.js";
import { failureForTurn, presentAgentTurn, presentAgentStep, presentSubagentCall, } from "./turn-presentation.js";
function Message({ children, from, ...props }) {
    return _jsx("article", { className: cn("group flex w-full flex-col", from === "user" ? "items-end" : "items-start"), ...props, children: children });
}
function MessageContent({ children, className }) {
    return _jsx("div", { className: cn("min-w-0 max-w-full", className), children: children });
}
function MessageActions({ children, className }) {
    return _jsx("div", { className: cn("mt-1 flex gap-1", className), children: children });
}
function MessageAction({ children, label, onClick, tooltip }) {
    return _jsx(Button, { "aria-label": label, className: "size-7", onClick: onClick, size: "icon-sm", title: tooltip, variant: "ghost", children: children });
}
function safeStringify(value) {
    try {
        return JSON.stringify(value ?? {}, null, 2);
    }
    catch {
        return String(value);
    }
}
const EMPTY_CLOSED_INPUT_REQUEST_IDS = new Set();
export function AgentMessage({ assetUrl, canRespond, closedInputRequestIds = EMPTY_CLOSED_INPUT_REQUEST_IDS, events, fallbackStartedAt, isStreaming, locale, message, onOpenSubagent, onInputResponses, onCloseInputRequest = () => undefined, showCopyAction = true, }) {
    const displayMessage = assetUrl
        ? {
            ...message,
            parts: message.parts.map((part) => part.type === "file" && part.url?.startsWith("asset://")
                ? { ...part, url: assetUrl(part.url.slice("asset://".length)) }
                : part),
        }
        : message;
    const task = presentAgentTurn(displayMessage, events, closedInputRequestIds);
    const responseText = task?.finalPart?.text ?? (task ? undefined : lastText(displayMessage.parts));
    const failure = failureForTurn(events, displayMessage.metadata?.turnId);
    const hasVisiblePart = displayMessage.parts.some((part) => part.type !== "step-start");
    return (_jsxs(Message, { "data-optimistic": message.metadata?.optimistic ? "true" : undefined, from: message.role, children: [_jsxs(MessageContent, { className: message.role === "assistant" ? "w-full" : undefined, children: [message.role === "assistant" && isStreaming && !hasVisiblePart ? (_jsx(ReasoningRoot, { className: "mb-1", role: "status", streaming: true, variant: "ghost", children: _jsx(ReasoningTrigger, { active: true, label: localize(locale, "Thinking", "正在思考") }) })) : null, task ? (_jsxs(_Fragment, { children: [_jsxs(ExecutionGroup, { collapseWhenSettled: task.status === "completed" && Boolean(task.finalPart?.text.trim() ||
                                    hasLaterFinalDelivery(events, message.metadata?.turnId)), fallbackStartedAt: fallbackStartedAt, locale: locale, task: task, children: [_jsx(ProcessParts, { assetUrl: assetUrl, canRespond: canRespond, closedInputRequestIds: closedInputRequestIds, events: events, inActiveExecution: task.status === "running" || task.status === "waiting", locale: locale, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, onOpenSubagent: onOpenSubagent, parts: task.processParts, turnId: message.metadata?.turnId }), task.proxiedInputParts.map((part) => (_jsxs("div", { className: "space-y-2", children: [_jsx("p", { className: "text-xs font-medium text-amber-700 dark:text-amber-300", children: localize(locale, "A delegated task needs your approval", "子代理任务需要你的批准") }), _jsx(AgentMessagePart, { assetUrl: assetUrl, canRespond: canRespond, closedInputRequestIds: closedInputRequestIds, events: events, inActiveExecution: true, locale: locale, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, onOpenSubagent: onOpenSubagent, part: part, turnId: message.metadata?.turnId })] }, `proxied-input:${part.toolCallId}`)))] }), task.finalPart ? (_jsx("div", { className: "pt-3", children: _jsx(AgentMessagePart, { assetUrl: assetUrl, canRespond: canRespond, events: events, inActiveExecution: false, locale: locale, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, onOpenSubagent: onOpenSubagent, part: task.finalPart, turnId: message.metadata?.turnId }) })) : null] })) : displayMessage.parts.map((part, index) => (_jsx(AgentMessagePart, { assetUrl: assetUrl, canRespond: canRespond, events: events, inActiveExecution: false, locale: locale, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, onOpenSubagent: onOpenSubagent, part: part, turnId: message.metadata?.turnId }, partKey(part, index)))), failure ? _jsx(TurnFailure, { failure: failure, locale: locale }) : null] }), showCopyAction && message.role === "assistant" && responseText && !isStreaming ? (_jsx(CopyResponseAction, { locale: locale, text: responseText })) : null] }));
}
function AgentMessagePart({ assetUrl, canRespond, closedInputRequestIds = EMPTY_CLOSED_INPUT_REQUEST_IDS, events, inActiveExecution, locale, onOpenSubagent, onInputResponses, onCloseInputRequest = () => undefined, part, turnId, }) {
    switch (part.type) {
        case "step-start":
            return null;
        case "text":
            if (!part.text.trim())
                return null;
            return (_jsx("div", { className: "relative break-words", children: _jsx(StaticMarkdownText, { text: part.text }) }));
        case "reasoning": {
            return _jsx(ReasoningPart, { events: events, locale: locale, part: part, turnId: turnId });
        }
        case "file":
            return _jsx(AttachmentPart, { locale: locale, part: part });
        case "authorization":
            return _jsx(AuthorizationPrompt, { locale: locale, part: part });
        case "dynamic-tool": {
            return _jsx(ToolPart, { assetUrl: assetUrl, canRespond: canRespond, closedInputRequestIds: closedInputRequestIds, events: events, inActiveExecution: inActiveExecution, locale: locale, onCloseInputRequest: onCloseInputRequest, onInputResponses: onInputResponses, onOpenSubagent: onOpenSubagent, part: part });
        }
    }
}
function ProcessParts({ assetUrl, canRespond, closedInputRequestIds = EMPTY_CLOSED_INPUT_REQUEST_IDS, events, inActiveExecution, locale, onInputResponses, onCloseInputRequest = () => undefined, onOpenSubagent, parts, turnId, }) {
    const rendered = [];
    let visualStepIndex = -1;
    for (let index = 0; index < parts.length;) {
        const part = parts[index];
        if (part.type === "step-start") {
            visualStepIndex += 1;
            const nextStep = parts.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.type === "step-start");
            const stepEnd = nextStep < 0 ? parts.length : nextStep;
            const hasReasoning = parts.slice(index + 1, stepEnd).some((candidate) => candidate.type === "reasoning" && candidate.stepIndex === visualStepIndex);
            if (!hasReasoning) {
                rendered.push(_jsx(StepActivity, { events: events, locale: locale, stepIndex: visualStepIndex, turnId: turnId }, `step-activity:${turnId}:${visualStepIndex}`));
            }
            index += 1;
            continue;
        }
        if (part.type !== "dynamic-tool") {
            rendered.push(_jsx(AgentMessagePart, { assetUrl: assetUrl, canRespond: canRespond, events: events, inActiveExecution: inActiveExecution, locale: locale, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, closedInputRequestIds: closedInputRequestIds, onOpenSubagent: onOpenSubagent, part: part, turnId: turnId }, partKey(part, index)));
            index += 1;
            continue;
        }
        const toolParts = [];
        let cursor = index;
        while (cursor < parts.length && parts[cursor]?.type === "dynamic-tool") {
            toolParts.push(parts[cursor]);
            cursor += 1;
        }
        if (toolParts.every((toolPart) => Boolean(toolPart.toolMetadata?.eve?.inputRequest))) {
            rendered.push(_jsx("div", { className: "space-y-2", children: toolParts.map((toolPart) => (_jsx(AgentMessagePart, { assetUrl: assetUrl, canRespond: canRespond, events: events, inActiveExecution: inActiveExecution, locale: locale, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, closedInputRequestIds: closedInputRequestIds, onOpenSubagent: onOpenSubagent, part: toolPart, turnId: turnId }, toolPart.toolCallId))) }, `inputs:${toolParts[0]?.toolCallId}`));
            index = cursor;
            continue;
        }
        const active = toolParts.some((toolPart) => !isToolTerminal(toolPart));
        const needsInput = toolParts.some((toolPart) => toolPart.state === "approval-requested" ||
            Boolean(toolPart.toolMetadata?.eve?.inputRequest && !toolPart.toolMetadata.eve.inputResponse));
        if (toolParts.length === 1) {
            rendered.push(_jsx(AgentMessagePart, { assetUrl: assetUrl, canRespond: canRespond, closedInputRequestIds: closedInputRequestIds, events: events, inActiveExecution: inActiveExecution, locale: locale, onCloseInputRequest: onCloseInputRequest, onInputResponses: onInputResponses, onOpenSubagent: onOpenSubagent, part: toolParts[0], turnId: turnId }, toolParts[0].toolCallId));
        }
        else {
            rendered.push(_jsx(ProcessToolGroup, { active: active, assetUrl: assetUrl, canRespond: canRespond, closedInputRequestIds: closedInputRequestIds, events: events, inActiveExecution: inActiveExecution, locale: locale, needsInput: needsInput, onCloseInputRequest: onCloseInputRequest, onInputResponses: onInputResponses, onOpenSubagent: onOpenSubagent, toolParts: toolParts, turnId: turnId }, `tools:${toolParts[0]?.toolCallId}`));
        }
        index = cursor;
    }
    return _jsx(_Fragment, { children: rendered });
}
function ProcessToolGroup({ active, assetUrl, canRespond, closedInputRequestIds, events, inActiveExecution, locale, needsInput, onCloseInputRequest, onInputResponses, onOpenSubagent, toolParts, turnId, }) {
    const [open, setOpen] = useState(active || inActiveExecution || needsInput);
    useEffect(() => {
        if (active || inActiveExecution || needsInput)
            setOpen(true);
    }, [active, inActiveExecution, needsInput]);
    return (_jsxs(ToolGroupRoot, { onOpenChange: setOpen, open: open, variant: "ghost", children: [_jsx(ToolGroupTrigger, { active: active, count: toolParts.length, label: localize(locale, active
                    ? `Running ${toolParts.length} ${toolParts.length === 1 ? "tool" : "tools"}`
                    : `Ran ${toolParts.length} ${toolParts.length === 1 ? "tool" : "tools"}`, active ? `正在运行 ${toolParts.length} 个工具` : `已运行 ${toolParts.length} 个工具`) }), _jsx(ToolGroupContent, { children: toolParts.map((toolPart) => (_jsx(AgentMessagePart, { assetUrl: assetUrl, canRespond: canRespond, closedInputRequestIds: closedInputRequestIds, events: events, inActiveExecution: inActiveExecution, locale: locale, onCloseInputRequest: onCloseInputRequest, onInputResponses: onInputResponses, onOpenSubagent: onOpenSubagent, part: toolPart, turnId: turnId }, toolPart.toolCallId))) })] }));
}
function ToolPart({ assetUrl, canRespond, closedInputRequestIds = EMPTY_CLOSED_INPUT_REQUEST_IDS, events, locale, onInputResponses, onCloseInputRequest = () => undefined, onOpenSubagent, part, }) {
    const inputRequest = part.toolMetadata?.eve?.inputRequest;
    if (inputRequest) {
        return _jsx(InputRequestCard, { canRespond: canRespond, closed: closedInputRequestIds.has(inputRequest.requestId), events: events, locale: locale, onClose: onCloseInputRequest, onInputResponses: onInputResponses, part: part });
    }
    const running = !isToolTerminal(part);
    const defaultOpen = isTodoTool(part) || part.state === "approval-requested";
    const Icon = toolIcon(part);
    const statusLabel = isFileMutationTool(part) ? undefined : toolStatusLabel(locale, part);
    return (_jsxs(ToolFallbackRoot, { className: "my-0", defaultOpen: defaultOpen, children: [_jsxs(CollapsibleTrigger, { className: "group/trigger flex w-fit max-w-full origin-left items-center gap-2 py-1.5 text-left text-sm text-muted-foreground transition-[color,scale] hover:text-foreground active:scale-[0.98]", children: [running ? (_jsx(LoaderCircleIcon, { className: "size-4 shrink-0 animate-spin [animation-duration:0.65s]" })) : part.state === "output-error" || part.state === "output-denied" ? (_jsx(XCircleIcon, { className: "size-4 shrink-0 text-destructive" })) : (_jsx(Icon, { className: "size-4 shrink-0" })), _jsx("span", { className: "truncate", children: toolTitle(locale, part, events) }), statusLabel ? (_jsx("span", { className: cn("shrink-0 text-xs", part.state === "output-error" && "text-destructive"), children: statusLabel })) : null, _jsx(ChevronDownIcon, { className: "size-3.5 shrink-0 -rotate-90 transition-transform group-data-[state=open]/trigger:rotate-0" })] }), _jsxs(ToolFallbackContent, { children: [_jsx(KnownToolContent, { assetUrl: assetUrl, events: events, locale: locale, onOpenSubagent: onOpenSubagent, part: part }), part.errorText ? _jsx("p", { className: "whitespace-pre-wrap text-xs text-destructive", children: part.errorText }) : null] })] }));
}
function KnownToolContent({ assetUrl, events, locale, onOpenSubagent, part, }) {
    const normalized = normalizeToolName(part.toolName);
    const input = asRecord(part.input);
    const output = "output" in part ? part.output : undefined;
    const patch = toolPatch(part);
    const fileChange = toolFileChange(part, events);
    if (part.toolMetadata?.eve?.kind === "subagent-call") {
        return _jsx(SubagentProgress, { events: events, locale: locale, onOpenSubagent: onOpenSubagent, part: part });
    }
    if (["apply_patch", "patch_file", "write_file", "edit_file"].includes(normalized)) {
        if (patch) {
            return _jsx("div", { "data-tool-view": "diff", children: _jsx(DiffViewer, { contentClassName: "max-h-72 overflow-auto", patch: patch, showIcon: true, size: "sm", variant: "muted" }) });
        }
        if (fileChange) {
            return (_jsx("div", { "data-tool-view": "diff", children: _jsx(DiffViewer, { contentClassName: "max-h-72 overflow-auto", newFile: { content: fileChange.newContent, name: fileChange.path }, oldFile: { content: fileChange.oldContent, name: fileChange.path }, showIcon: true, size: "sm", variant: "muted" }) }));
        }
        return _jsx("p", { className: "text-xs text-muted-foreground", children: localize(locale, "Receiving file changes...", "正在接收文件变更…") });
    }
    if (["bash", "shell", "terminal", "exec_command"].includes(normalized)) {
        const command = firstString(input, ["command", "cmd"]);
        const result = shellOutput(output);
        return _jsx(ShellToolContent, { command: command, locale: locale, output: output, result: result, running: !isToolTerminal(part) });
    }
    if (["read_file", "read", "view_file"].includes(normalized)) {
        const path = firstString(input, ["path", "file", "filename"]);
        const result = readableOutput(output);
        return (_jsxs("div", { className: "overflow-hidden rounded-md bg-muted/50 text-xs", "data-tool-view": "file-read", children: [path ? _jsx("p", { className: "truncate border-b border-border/40 px-3 py-2 font-mono text-muted-foreground", children: path }) : null, result ? _jsx("pre", { className: "max-h-72 overflow-auto whitespace-pre px-3 py-2.5 font-mono text-foreground", children: result }) : null] }));
    }
    if (isViewImageTool(normalized)) {
        return _jsx(ViewImageToolContent, { assetUrl: assetUrl, input: input, locale: locale, output: output, running: !isToolTerminal(part) });
    }
    if (["todo", "todo_write", "update_plan"].includes(normalized)) {
        const items = todoItems(part.input, output);
        return (_jsxs("ol", { className: "space-y-1.5 text-sm", "data-tool-view": "tasks", children: [items.map((item, index) => (_jsxs("li", { className: "flex items-start gap-2", children: [_jsx("span", { className: cn("mt-1.5 size-2 shrink-0 rounded-full border", item.done && "border-foreground bg-foreground") }), _jsx("span", { className: cn("min-w-0", item.done && "text-muted-foreground line-through"), children: item.label })] }, `${item.label}:${index}`))), items.length === 0 ? _jsx("li", { className: "text-xs text-muted-foreground", children: localize(locale, "Preparing tasks...", "正在整理任务…") }) : null] }));
    }
    if (["glob", "find_files", "grep", "search_files", "web_search", "search_web", "search"].includes(normalized)) {
        const query = firstString(input, ["query", "pattern", "glob", "path"]);
        const result = readableOutput(output);
        return (_jsxs("div", { className: "overflow-hidden rounded-md bg-muted/50 text-xs", "data-tool-view": "search", children: [query ? _jsx("p", { className: "border-b border-border/40 px-3 py-2 font-mono text-muted-foreground", children: query }) : null, result ? _jsx("pre", { className: "max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 text-foreground", children: result }) : null] }));
    }
    if (["web_fetch", "fetch_url"].includes(normalized)) {
        const record = asRecord(output);
        const contentType = firstString(record, ["contentType", "content_type"]);
        const url = firstString(record, ["url"]) ?? firstString(input, ["url"]);
        const binary = record?.binary === true;
        const content = firstString(record, ["content"]);
        return (_jsxs("div", { className: "overflow-hidden rounded-md bg-muted/50 text-xs", "data-tool-view": "web-fetch", children: [url ? _jsx("p", { className: "truncate border-b border-border/40 px-3 py-2 text-muted-foreground", children: url }) : null, binary ? (_jsxs("p", { className: "px-3 py-2.5 text-muted-foreground", children: [localize(locale, "Binary response kept out of text context", "二进制响应未进入文本上下文"), contentType ? ` · ${contentType}` : ""] })) : content ? (_jsx("pre", { className: "max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 text-foreground", children: content })) : null] }));
    }
    if (["publish_preview", "website_preview"].includes(normalized)) {
        const result = readableOutput(output);
        const url = firstUrl(output) ?? firstString(input, ["url"]);
        return url ? (_jsxs("a", { className: "inline-flex items-center gap-1.5 text-sm underline underline-offset-4", href: url, rel: "noreferrer", target: "_blank", children: [url, _jsx(ExternalLinkIcon, { className: "size-3.5" })] })) : result ? _jsx("p", { className: "whitespace-pre-wrap text-xs text-muted-foreground", children: result }) : null;
    }
    if (["import_remote_asset", "remote_asset_import"].includes(normalized)) {
        const record = asRecord(output);
        const filename = firstString(record, ["filename"]) ?? firstString(input, ["filename"]) ?? localize(locale, "Remote asset", "远程资产");
        const mediaType = firstString(record, ["mediaType", "contentType"]);
        const bytes = firstNumber(record, ["bytes", "sizeBytes"]);
        return (_jsxs("div", { className: "flex items-center gap-2 text-sm", "data-tool-view": "asset-import", children: [_jsx(AttachmentMedia, { variant: "icon", children: _jsx(FileIcon, { className: "size-4" }) }), _jsx("span", { className: "min-w-0 truncate", children: filename }), _jsx("span", { className: "shrink-0 text-xs text-muted-foreground", children: [mediaType, bytes !== undefined ? formatBytes(bytes) : undefined].filter(Boolean).join(" · ") })] }));
    }
    if (["publish_artifact", "artifact_publish"].includes(normalized)) {
        const record = asRecord(output);
        const url = firstUrl(output);
        const filename = firstString(record, ["filename", "name"]) ?? firstString(input, ["filename", "path"]);
        return url ? (_jsxs("a", { className: "inline-flex items-center gap-1.5 text-sm underline underline-offset-4", href: url, rel: "noreferrer", target: "_blank", children: [filename ?? localize(locale, "Open artifact", "打开产物"), _jsx(ExternalLinkIcon, { className: "size-3.5" })] })) : _jsx("p", { className: "text-xs text-muted-foreground", children: filename ?? localize(locale, "Publishing artifact...", "正在发布产物…") });
    }
    if (["record_checkpoint", "checkpoint"].includes(normalized)) {
        const checkpoint = asRecord(output) ?? input;
        const summary = firstString(checkpoint, ["summary"]);
        const rows = [
            { label: localize(locale, "Completed", "已完成"), values: stringArray(checkpoint?.completed) },
            { label: localize(locale, "Next", "下一步"), values: stringArray(checkpoint?.next) },
            { label: localize(locale, "Risks", "风险"), values: stringArray(checkpoint?.risks) },
        ].filter((row) => row.values.length > 0);
        return (_jsxs("div", { className: "space-y-2 text-sm", children: [summary ? _jsx("p", { children: summary }) : null, rows.map((row) => _jsxs("div", { className: "flex gap-2 text-xs", children: [_jsx("span", { className: "w-14 shrink-0 text-muted-foreground", children: row.label }), _jsx("span", { children: row.values.join(" · ") })] }, row.label))] }));
    }
    if (part.toolMetadata?.eve?.kind === "load-skill") {
        const skill = firstString(input, ["name", "skill", "id"]) ?? readableOutput(output);
        return skill ? _jsx("p", { className: "text-xs text-muted-foreground", children: skill }) : null;
    }
    return (_jsxs("div", { className: "space-y-2 text-xs", "data-tool-view": "fallback", children: [part.input !== undefined ? (_jsxs("div", { children: [_jsx("p", { className: "mb-1 text-muted-foreground", children: localize(locale, "Parameters", "参数") }), _jsx("pre", { className: "max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2.5", children: safeStringify(part.input) })] })) : null, output !== undefined ? (_jsxs("div", { children: [_jsx("p", { className: "mb-1 text-muted-foreground", children: localize(locale, "Result", "结果") }), _jsx("pre", { className: "max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2.5", children: safeStringify(output) })] })) : null] }));
}
const VIEW_IMAGE_MEDIA_TYPES = new Set([
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/webp",
]);
function ViewImageToolContent({ assetUrl, input, locale, output, running, }) {
    const record = asRecord(output);
    const path = firstString(record, ["path"]) ?? firstString(input, ["path"])
        ?? localize(locale, "Workspace image", "工作区图片");
    const mediaType = firstString(record, ["mediaType"]);
    const bytes = nonnegativeInteger(record?.bytes);
    const originalBytes = positiveInteger(record?.originalBytes);
    const dimensions = imageDimensions(record?.dimensions);
    const resized = record?.resized === true;
    const assetId = firstString(record, ["assetId"]);
    const previewUrl = assetId
        ? assetUrl?.(assetId) ?? `/api/assets/${encodeURIComponent(assetId)}`
        : undefined;
    const details = [
        mediaType && VIEW_IMAGE_MEDIA_TYPES.has(mediaType) ? mediaType : undefined,
        dimensions ? `${dimensions.width}\u00d7${dimensions.height}` : undefined,
        formatBytes(bytes),
        resized
            ? originalBytes !== undefined
                ? localize(locale, `resized from ${formatBytes(originalBytes)}`, `已从 ${formatBytes(originalBytes)} 缩放`)
                : localize(locale, "resized preview", "已缩放预览图")
            : undefined,
    ].filter((value) => Boolean(value));
    const [previewOpen, setPreviewOpen] = useState(false);
    return (_jsxs("div", { "data-tool-view": "view-image", children: [_jsxs(Attachment, { className: "max-w-[min(100%,28rem)]", size: "default", state: running ? "processing" : "done", children: [_jsx(AttachmentMedia, { className: "size-12", variant: previewUrl ? "image" : "icon", children: previewUrl ? _jsx("img", { alt: path, src: previewUrl }) : _jsx(ImageIcon, { className: "size-5" }) }), _jsxs(AttachmentContent, { children: [_jsx(AttachmentTitle, { title: path, children: path }), _jsx(AttachmentDescription, { children: details.length > 0
                                    ? details.join(" \u00b7 ")
                                    : running
                                        ? localize(locale, "Preparing image preview...", "正在准备图片预览…")
                                        : localize(locale, "Image metadata unavailable", "图片元数据不可用") })] }), previewUrl ? (_jsx(AttachmentTrigger, { "aria-label": localize(locale, `Preview ${path}`, `预览 ${path}`), onClick: () => setPreviewOpen(true), title: localize(locale, "Preview image", "预览图片") })) : null] }), previewOpen && previewUrl ? (_jsx("button", { "aria-label": localize(locale, "Close image preview", "关闭图片预览"), className: "fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-6", onClick: () => setPreviewOpen(false), type: "button", children: _jsx("img", { alt: path, className: "max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-2xl", src: previewUrl }) })) : null] }));
}
function imageDimensions(value) {
    const record = asRecord(value);
    const height = positiveInteger(record?.height);
    const width = positiveInteger(record?.width);
    return height !== undefined && width !== undefined ? { height, width } : undefined;
}
function nonnegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function positiveInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function toolIcon(part) {
    const normalized = normalizeToolName(part.toolName);
    if (isViewImageTool(normalized))
        return ImageIcon;
    if (["bash", "shell", "terminal", "exec_command"].includes(normalized))
        return TerminalIcon;
    if (["read_file", "read", "view_file", "glob", "find_files"].includes(normalized))
        return FileSearchIcon;
    if (["grep", "search_files", "web_search", "search_web", "search"].includes(normalized))
        return SearchIcon;
    if (["web_fetch", "fetch_url"].includes(normalized))
        return ExternalLinkIcon;
    if (["todo", "todo_write", "update_plan"].includes(normalized))
        return ListChecksIcon;
    if (["write_file", "edit_file", "apply_patch", "patch_file", "publish_artifact", "artifact_publish"].includes(normalized))
        return FileIcon;
    if (["record_checkpoint", "checkpoint"].includes(normalized))
        return CheckCircleIcon;
    return BracesIcon;
}
function isToolTerminal(part) {
    return part.state === "output-denied" || part.state === "output-error" ||
        (part.state === "output-available" && part.partial !== true);
}
function normalizeToolName(toolName) {
    return toolName.toLocaleLowerCase().replaceAll("-", "_");
}
function isViewImageTool(normalizedToolName) {
    return normalizedToolName === "view_image" || normalizedToolName.endsWith("__view_image");
}
function isFileMutationTool(part) {
    return ["apply_patch", "patch_file", "write_file", "edit_file"].includes(normalizeToolName(part.toolName));
}
function isTodoTool(part) {
    return ["todo", "todo_write", "update_plan"].includes(normalizeToolName(part.toolName));
}
function fileMutationSummary(part, events = []) {
    const patch = toolPatch(part);
    const change = toolFileChange(part, events);
    const patchPath = patch ? patchFilePath(patch) : undefined;
    const path = change?.path ?? patchPath;
    const patchStats = patch ? patchLineStats(patch) : undefined;
    const additions = patchStats?.additions ?? countContentLines(change?.newContent);
    const deletions = patchStats?.deletions ?? countContentLines(change?.oldContent);
    const output = part.state === "output-available" ? asRecord(part.output) : undefined;
    const existed = typeof output?.existed === "boolean" ? output.existed : undefined;
    const operation = patch?.includes("--- /dev/null") || existed === false || (change && change.oldContent.length === 0)
        ? "create"
        : patch?.includes("+++ /dev/null") || (change && change.newContent.length === 0)
            ? "delete"
            : "edit";
    return { additions, deletions, operation, ...(path ? { path } : {}) };
}
function fileMutationTitle(locale, part, events = []) {
    const running = !isToolTerminal(part);
    const summary = fileMutationSummary(part, events);
    const action = summary.operation === "create"
        ? running ? localize(locale, "Creating", "正在创建") : localize(locale, "Created", "已创建")
        : summary.operation === "delete"
            ? running ? localize(locale, "Deleting", "正在删除") : localize(locale, "Deleted", "已删除")
            : running ? localize(locale, "Editing", "正在编辑") : localize(locale, "Edited", "已编辑");
    const stats = [
        summary.additions > 0 ? `+${summary.additions}` : undefined,
        summary.deletions > 0 ? `-${summary.deletions}` : undefined,
    ].filter(Boolean).join(" ");
    return [action, summary.path, stats].filter(Boolean).join(" ");
}
function patchFilePath(patch) {
    const match = patch.match(/^\+\+\+\s+(?:b\/)?(.+)$/m) ?? patch.match(/^---\s+(?:a\/)?(.+)$/m);
    const path = match?.[1]?.trim();
    return path && path !== "/dev/null" ? path : undefined;
}
function patchLineStats(patch) {
    let additions = 0;
    let deletions = 0;
    for (const line of patch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++"))
            additions += 1;
        if (line.startsWith("-") && !line.startsWith("---"))
            deletions += 1;
    }
    return { additions, deletions };
}
function countContentLines(value) {
    if (!value)
        return 0;
    return value.endsWith("\n") ? value.slice(0, -1).split("\n").length : value.split("\n").length;
}
function StepActivity({ events, locale, stepIndex, turnId, }) {
    const step = presentAgentStep(events, turnId, stepIndex);
    const durationSeconds = useElapsedSeconds(step.startedAt, step.endedAt);
    return (_jsxs(_Fragment, { children: [step.status === "running" && step.retry ? (_jsx(RetryStatus, { locale: locale, retry: step.retry })) : null, _jsx(ReasoningRoot, { className: "mb-1", role: "status", streaming: step.status === "running", variant: "ghost", children: _jsx(ReasoningTrigger, { active: step.status === "running", duration: step.status === "completed" && durationSeconds > 0 ? durationSeconds : undefined, hideChevron: true, label: step.status === "running"
                        ? localize(locale, "Thinking", "正在思考")
                        : localize(locale, "Reasoning complete", "思考完成") }) })] }));
}
function RetryStatus({ locale, retry, }) {
    return (_jsxs(Collapsible, { className: "mb-1 text-sm text-muted-foreground", children: [_jsxs(CollapsibleTrigger, { className: "group/retry flex max-w-full items-center gap-2 py-1.5 text-left hover:text-foreground", children: [_jsx(WifiIcon, { className: "size-4 shrink-0" }), _jsxs("span", { children: [localize(locale, "Reconnecting", "正在重新连接"), " ", retry.attempt, "/", retry.maximum] }), retry.error ? _jsx(ChevronDownIcon, { className: "size-3.5 -rotate-90 transition-transform group-data-[state=open]/retry:rotate-0" }) : null] }), retry.error ? (_jsx(CollapsibleContent, { className: "overflow-hidden", children: _jsxs("div", { className: "ml-6 rounded-lg border border-border/60 px-3 py-2 text-xs", children: [_jsx("p", { className: "break-words text-foreground", children: sanitizeFailureMessage(retry.error.message) }), _jsx("code", { className: "mt-1 block text-muted-foreground", children: retry.error.code })] }) })) : null] }));
}
function ReasoningPart({ events, locale, part, turnId, }) {
    const timing = reasoningTiming(events, turnId, part.stepIndex);
    const step = presentAgentStep(events, turnId, part.stepIndex ?? 0);
    const durationSeconds = useElapsedSeconds(timing.startedAt, timing.endedAt);
    const streaming = part.state === "streaming";
    return (_jsxs(_Fragment, { children: [streaming && step.retry ? _jsx(RetryStatus, { locale: locale, retry: step.retry }) : null, _jsxs(ReasoningRoot, { className: "mb-1", streaming: streaming, variant: "ghost", children: [_jsx(ReasoningTrigger, { active: streaming, duration: !streaming && timing.startedAt && durationSeconds > 0 ? durationSeconds : undefined, label: streaming
                            ? reasoningSummary(part.text) ?? localize(locale, "Thinking", "正在思考")
                            : localize(locale, "Reasoning complete", "思考完成") }), _jsx(ReasoningContent, { "aria-busy": streaming, children: _jsx(ReasoningText, { children: _jsx(StaticMarkdownText, { text: part.text }) }) })] })] }));
}
function reasoningSummary(text) {
    const firstLine = text
        .replaceAll(/^[#>*\-\s]+/gm, "")
        .split(/\n|(?<=[.!?。！？])\s+/u)
        .map((line) => line.trim())
        .find(Boolean);
    if (!firstLine)
        return undefined;
    return firstLine.length > 64 ? `${firstLine.slice(0, 63)}…` : firstLine;
}
function reasoningTiming(events, turnId, stepIndex) {
    const matching = events.filter((event) => (event.type === "step.started" || event.type === "reasoning.appended" || event.type === "reasoning.completed") &&
        (turnId === undefined || event.data.turnId === turnId) &&
        (stepIndex === undefined || ("stepIndex" in event.data && event.data.stepIndex === stepIndex)));
    const startedAt = eventTime(matching[0]);
    const completed = [...matching].reverse().find((event) => event.type === "reasoning.completed");
    return {
        ...(startedAt ? { startedAt } : {}),
        ...(completed ? { endedAt: eventTime(completed) } : {}),
    };
}
function eventTime(event) {
    const at = event?.meta?.at;
    if (!at)
        return undefined;
    const parsed = Date.parse(at);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function toolFileChange(part, events = []) {
    const input = asRecord(part.input);
    const output = part.state === "output-available" ? asRecord(part.output) : undefined;
    if (!input && !output)
        return undefined;
    const newContent = firstString(output, ["content", "newContent", "new_content", "new_string", "replacement"])
        ?? firstString(input, ["content", "newContent", "new_content", "new_string", "replacement"]);
    if (newContent === undefined)
        return undefined;
    const path = firstString(output, ["path", "filePath", "file", "filename"])
        ?? firstString(input, ["path", "filePath", "file", "filename"]);
    const oldContent = firstString(output, ["oldContent", "old_content", "old_string", "before"])
        ?? firstString(input, ["oldContent", "old_content", "old_string", "before"])
        ?? previousFileContent(events, path, part.toolCallId)
        ?? "";
    return { newContent, oldContent, ...(path ? { path } : {}) };
}
function previousFileContent(events, path, currentCallId) {
    if (!path)
        return undefined;
    const reads = new Map();
    let latest;
    for (const event of events) {
        if (event.type === "actions.requested") {
            for (const action of event.data.actions) {
                if (action.callId === currentCallId)
                    return latest;
                if (action.kind !== "tool-call" || !["read_file", "read", "view_file"].includes(normalizeToolName(action.toolName)))
                    continue;
                const actionPath = firstString(asRecord(action.input), ["path", "filePath", "file", "filename"]);
                if (actionPath === path)
                    reads.set(action.callId, actionPath);
            }
            continue;
        }
        if (event.type !== "action.result" || event.data.result.kind !== "tool-result")
            continue;
        if (!reads.has(event.data.result.callId))
            continue;
        latest = readableOutput(event.data.result.output) ?? latest;
    }
    return latest;
}
function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function firstString(record, keys) {
    if (!record)
        return undefined;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.length > 0)
            return value;
    }
    return undefined;
}
function firstNumber(record, keys) {
    if (!record)
        return undefined;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value))
            return value;
    }
    return undefined;
}
function readableOutput(value) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value)) {
        const lines = value.map((item) => readableOutput(item) ?? safeStringify(item));
        return lines.length > 0 ? lines.join("\n") : undefined;
    }
    const record = asRecord(value);
    if (!record)
        return value === undefined ? undefined : String(value);
    return firstString(record, ["stdout", "content", "text", "message", "result", "output", "url"])
        ?? (Object.keys(record).length > 0 ? safeStringify(record) : undefined);
}
function shellOutput(value) {
    if (typeof value === "string")
        return value || undefined;
    const record = asRecord(value);
    if (!record)
        return undefined;
    const stdout = typeof record.stdout === "string" ? record.stdout.trimEnd() : "";
    const stderr = typeof record.stderr === "string" ? record.stderr.trimEnd() : "";
    return [stdout, stderr].filter(Boolean).join("\n") || undefined;
}
function ShellToolContent({ command, locale, output, result, running, }) {
    const [copied, setCopied] = useState(false);
    const exitCode = shellExitCode(output);
    const copyCommand = async () => {
        if (!command)
            return;
        try {
            await copyText(command);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
        }
        catch {
            setCopied(false);
        }
    };
    return (_jsxs("div", { className: "overflow-hidden rounded-md bg-muted/50 font-mono text-xs", "data-tool-view": "terminal", children: [_jsxs("div", { className: "flex min-h-9 items-start gap-2 px-3 py-2.5", children: [_jsx(TerminalIcon, { className: "size-3.5 shrink-0 text-muted-foreground" }), _jsx("pre", { className: "min-w-0 flex-1 overflow-x-auto whitespace-pre text-foreground", children: command ?? localize(locale, "Shell command", "终端命令") }), running ? (_jsx(LoaderCircleIcon, { className: "size-3.5 shrink-0 animate-spin text-muted-foreground" })) : exitCode !== undefined ? (_jsxs("span", { className: cn("shrink-0 tabular-nums", exitCode === 0 ? "text-muted-foreground" : "text-destructive"), children: ["exit ", exitCode] })) : null, command ? (_jsx(Button, { "aria-label": localize(locale, "Copy command", "复制命令"), className: "size-6 shrink-0", onClick: () => void copyCommand(), size: "icon-sm", type: "button", variant: "ghost", children: copied ? _jsx(CheckIcon, { className: "size-3.5" }) : _jsx(CopyIcon, { className: "size-3.5" }) })) : null] }), result ? (_jsx("pre", { className: "max-h-72 overflow-auto border-t border-border/40 bg-background/40 px-3 py-2.5 whitespace-pre text-muted-foreground", children: result })) : !running && output !== undefined ? (_jsx("p", { className: "border-t border-border/50 px-3 py-2 font-sans text-muted-foreground", children: localize(locale, "Command completed with no output.", "命令已完成，没有输出。") })) : null] }));
}
function shellExitCode(value) {
    const record = asRecord(value);
    if (!record)
        return undefined;
    for (const key of ["exitCode", "exit_code", "code"]) {
        const candidate = record[key];
        if (typeof candidate === "number" && Number.isFinite(candidate))
            return candidate;
    }
    return undefined;
}
function stringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function firstUrl(value) {
    const direct = typeof value === "string" ? value : firstString(asRecord(value), ["url", "previewUrl", "preview_url"]);
    if (!direct)
        return undefined;
    const match = direct.match(/https?:\/\/[^\s"'<>]+/u);
    return match?.[0];
}
function todoItems(inputValue, outputValue) {
    const source = todoArray(inputValue) ?? todoArray(outputValue) ?? [];
    return source.flatMap((item) => {
        if (typeof item === "string")
            return [{ done: false, label: item }];
        const record = asRecord(item);
        if (!record)
            return [];
        const label = firstString(record, ["content", "label", "title", "text", "task"]);
        if (!label)
            return [];
        const status = firstString(record, ["status", "state"]);
        const done = record.done === true || status === "completed" || status === "done";
        return [{ done, label }];
    });
}
function todoArray(value) {
    if (Array.isArray(value))
        return value;
    const record = asRecord(value);
    if (!record)
        return undefined;
    const candidate = record.todos ?? record.items ?? record.tasks ?? record.plan;
    return Array.isArray(candidate) ? candidate : undefined;
}
function toolPatch(part) {
    const toolName = part.toolName.toLocaleLowerCase().replaceAll("-", "_");
    if (!["apply_patch", "patch_file"].includes(toolName))
        return undefined;
    return patchFromValue(part.input) ?? patchFromValue(part.output);
}
function patchFromValue(value) {
    if (typeof value === "string")
        return looksLikeUnifiedDiff(value) ? value : undefined;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    const patch = record.patch ?? record.diff;
    return typeof patch === "string" && looksLikeUnifiedDiff(patch) ? patch : undefined;
}
function looksLikeUnifiedDiff(value) {
    return /^(?:diff --git |--- )/m.test(value) && /^\+\+\+ /m.test(value) && /^@@ /m.test(value);
}
function SubagentProgress({ events, locale, onOpenSubagent, part, }) {
    const presentation = presentSubagentCall(events, part.toolCallId);
    const elapsedSeconds = useElapsedSeconds(presentation.startedAt, presentation.endedAt);
    const isActive = presentation.status === "running" || presentation.status === "starting";
    const title = presentation.status === "completed"
        ? localize(locale, "Sub-agent finished and returned its result to the parent Agent", "子代理已完成，结果已返回父 Agent")
        : presentation.status === "cancelled"
            ? localize(locale, "Sub-agent stopped", "子代理已停止")
            : presentation.status === "failed"
                ? localize(locale, "Sub-agent failed and returned control to the parent Agent", "子代理执行失败，控制权已返回父 Agent")
                : presentation.status === "running" && elapsedSeconds >= 45
                    ? localize(locale, "Sub-agent is still working; the parent Agent will resume automatically", "子代理仍在执行；完成后父 Agent 会自动继续")
                    : presentation.status === "running"
                        ? localize(locale, "Sub-agent is working independently", "子代理正在独立执行")
                        : localize(locale, "Starting the delegated task", "正在启动委派任务");
    return (_jsxs("div", { className: cn("flex items-start gap-3 py-1.5 text-sm", presentation.status === "failed"
            ? "text-destructive"
            : "text-foreground"), role: isActive ? "status" : undefined, children: [isActive ? (_jsx(LoaderCircleIcon, { className: "mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" })) : presentation.status === "completed" ? (_jsx(CheckCircleIcon, { className: "mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-300" })) : presentation.status === "cancelled" ? (_jsx(CircleStopIcon, { className: "mt-0.5 size-4 shrink-0 text-muted-foreground" })) : (_jsx(XCircleIcon, { className: "mt-0.5 size-4 shrink-0 text-destructive" })), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "text-foreground", children: title }), _jsxs("p", { className: "mt-0.5 text-xs text-muted-foreground", children: [_jsx(NetworkIcon, { className: "mr-1 inline size-3" }), presentation.name === "agent"
                                ? localize(locale, "Works in the parent Agent workspace.", "在父 Agent 的工作区中执行。")
                                : localize(locale, "Runs in its own isolated workspace.", "在独立隔离的工作区中执行。")] }), presentation.childSessionId && onOpenSubagent ? (_jsxs(Button, { className: "mt-2 h-7 px-2 text-xs", onClick: () => onOpenSubagent(presentation.childSessionId), size: "sm", variant: "outline", children: [_jsx(NetworkIcon, { className: "size-3.5" }), localize(locale, `Open ${presentation.name === "agent" ? "sub-agent" : presentation.name ?? "sub-agent"} session`, `打开${presentation.name && presentation.name !== "agent" ? ` ${presentation.name}` : "子代理"}会话`)] })) : null] }), presentation.startedAt ? (_jsx("span", { className: "shrink-0 text-xs tabular-nums text-muted-foreground", children: formatDuration(elapsedSeconds) })) : null] }));
}
function ExecutionGroup({ children, collapseWhenSettled, fallbackStartedAt, locale, task, }) {
    const isActive = task.status === "running" || task.status === "waiting";
    const hasFinalDelivery = task.status === "completed" && collapseWhenSettled;
    const [open, setOpen] = useState(!hasFinalDelivery);
    const previousStatus = useRef(task.status);
    const previousFinalDelivery = useRef(hasFinalDelivery);
    const executionRef = useRef(null);
    const lockScroll = useScrollLock(executionRef, 200);
    const startedAt = task.startedAt ?? fallbackStartedAt;
    const elapsedSeconds = useElapsedSeconds(startedAt, task.endedAt);
    useEffect(() => {
        const wasActive = previousStatus.current === "running" || previousStatus.current === "waiting";
        const finalDeliveryArrived = !previousFinalDelivery.current && hasFinalDelivery;
        if (task.status === "waiting")
            setOpen(true);
        else if (finalDeliveryArrived || wasActive && hasFinalDelivery)
            setOpen(false);
        else if (wasActive && !isActive)
            setOpen(true);
        previousStatus.current = task.status;
        previousFinalDelivery.current = hasFinalDelivery;
    }, [hasFinalDelivery, isActive, task.status]);
    return (_jsxs(Collapsible, { className: "group/execution w-full", onOpenChange: (nextOpen) => {
            lockScroll();
            setOpen(nextOpen);
        }, open: open, ref: executionRef, children: [_jsx(CollapsibleTrigger, { asChild: true, children: _jsxs("button", { className: "flex w-full items-center gap-1.5 border-b border-border/60 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground", type: "button", children: [_jsx("span", { children: executionLabel(locale, task) }), startedAt && elapsedSeconds > 0 ? _jsx("span", { className: "tabular-nums", children: formatDuration(elapsedSeconds) }) : null, _jsx(ChevronDownIcon, { className: "size-3.5 transition-transform group-data-[state=open]/execution:rotate-180" })] }) }), _jsx(CollapsibleContent, { className: "overflow-hidden data-[state=closed]:animate-out data-[state=open]:animate-in", children: _jsx("div", { className: "mt-2 space-y-3 pt-2", children: children }) })] }));
}
function hasLaterFinalDelivery(events, turnId) {
    if (!turnId)
        return false;
    const turnEnd = events.findIndex((event) => (event.type === "turn.completed" || event.type === "turn.cancelled" || event.type === "turn.failed") &&
        event.data.turnId === turnId);
    if (turnEnd < 0)
        return false;
    return events.slice(turnEnd + 1).some((event) => event.type === "message.completed" &&
        event.data.finishReason === "stop" &&
        typeof event.data.message === "string" &&
        event.data.message.trim().length > 0);
}
function CopyResponseAction({ locale, text }) {
    const [copied, setCopied] = useState(false);
    const timeout = useRef(undefined);
    useEffect(() => () => window.clearTimeout(timeout.current), []);
    return (_jsx(MessageActions, { children: _jsx(MessageAction, { label: localize(locale, "Copy response", "复制回复"), onClick: () => {
                void copyText(text).then(() => {
                    setCopied(true);
                    window.clearTimeout(timeout.current);
                    timeout.current = window.setTimeout(() => setCopied(false), 1_500);
                });
            }, tooltip: localize(locale, copied ? "Copied" : "Copy response", copied ? "已复制" : "复制回复"), children: copied ? _jsx(CheckIcon, { className: "size-3.5" }) : _jsx(CopyIcon, { className: "size-3.5" }) }) }));
}
function useElapsedSeconds(startedAt, endedAt) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (!startedAt || endedAt)
            return;
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [endedAt, startedAt]);
    if (!startedAt)
        return 0;
    return Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1_000));
}
function executionLabel(locale, task) {
    if (task.status === "running")
        return localize(locale, "Working", "正在处理");
    if (task.status === "waiting") {
        return task.waitingFor === "tool-approval"
            ? localize(locale, "Waiting for approval", "等待批准")
            : localize(locale, "Waiting for confirmation", "等待确认");
    }
    if (task.status === "completed")
        return localize(locale, "Worked for", "已处理");
    if (task.status === "cancelled")
        return localize(locale, "Stopped after", "已停止");
    return localize(locale, "Failed after", "执行失败");
}
function formatDuration(totalSeconds) {
    if (totalSeconds < 60)
        return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
function lastText(parts) {
    const part = [...parts].reverse().find((candidate) => candidate.type === "text");
    return part?.type === "text" ? part.text : undefined;
}
function AttachmentPart({ locale, part }) {
    const label = part.filename ?? localize(locale, "Attachment", "附件");
    const detail = [part.mediaType, formatBytes(part.size)].filter(Boolean).join(" - ");
    const isImage = part.mediaType.startsWith("image/") && part.url !== undefined;
    const Icon = isImage ? ImageIcon : FileIcon;
    const [previewOpen, setPreviewOpen] = useState(false);
    return (_jsxs(_Fragment, { children: [_jsxs(Attachment, { className: "max-w-sm", size: "default", state: "done", children: [_jsx(AttachmentMedia, { variant: isImage ? "image" : "icon", children: isImage ? _jsx("img", { alt: label, src: part.url }) : _jsx(Icon, { className: "size-4" }) }), _jsxs(AttachmentContent, { children: [_jsx(AttachmentTitle, { children: label }), detail ? _jsx(AttachmentDescription, { children: detail }) : null] }), isImage && part.url ? (_jsx(AttachmentAction, { "aria-label": localize(locale, "Preview image", "预览图片"), onClick: () => setPreviewOpen(true), title: localize(locale, "Preview image", "预览图片"), children: _jsx(ImageIcon, { className: "size-3.5" }) })) : part.url ? (_jsx(AttachmentAction, { asChild: true, "aria-label": localize(locale, "Open attachment", "打开附件"), title: localize(locale, "Open attachment", "打开附件"), children: _jsx("a", { href: part.url, rel: "noreferrer", target: "_blank", children: _jsx(ExternalLinkIcon, { className: "size-3.5" }) }) })) : null] }), previewOpen && part.url ? (_jsx("button", { className: "fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-6", onClick: () => setPreviewOpen(false), type: "button", children: _jsx("img", { alt: label, className: "max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-2xl", src: part.url }) })) : null] }));
}
function AuthorizationPrompt({ locale, part }) {
    const isAuthorized = part.state === "completed" && part.outcome === "authorized";
    const isCompleted = part.state === "completed";
    const Icon = isAuthorized ? CheckCircleIcon : isCompleted ? XCircleIcon : KeyRoundIcon;
    const instructions = part.authorization?.instructions;
    const shouldShowInstructions = instructions !== undefined && instructions !== part.description;
    return (_jsx("div", { className: cn("space-y-3 rounded-md border p-3", isAuthorized
            ? "border-emerald-500/30 bg-emerald-500/5"
            : isCompleted
                ? "border-destructive/30 bg-destructive/5"
                : "border-blue-500/30 bg-blue-500/5"), children: _jsxs("div", { className: "flex items-start gap-3", children: [_jsx("span", { className: cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full", isAuthorized
                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : isCompleted
                            ? "bg-destructive/10 text-destructive"
                            : "bg-blue-500/10 text-blue-700 dark:text-blue-300"), children: _jsx(Icon, { className: "size-4" }) }), _jsxs("div", { className: "min-w-0 flex-1 space-y-2", children: [_jsx("p", { className: "font-medium text-sm", children: authorizationTitle(part, locale) }), _jsx("p", { className: "text-muted-foreground text-sm", children: authorizationDescription(part, locale) }), shouldShowInstructions ? (_jsx("p", { className: "text-muted-foreground text-sm", children: instructions })) : null, part.state === "required" && part.authorization?.userCode ? (_jsxs("div", { className: "flex flex-wrap items-center gap-2 text-sm", children: [_jsx("span", { className: "text-muted-foreground", children: localize(locale, "Code", "验证码") }), _jsx("code", { className: "rounded-md bg-background px-2 py-1 font-mono", children: part.authorization.userCode })] })) : null, part.state === "required" && part.authorization?.url ? (_jsx(Button, { asChild: true, size: "sm", children: _jsxs("a", { href: part.authorization.url, rel: "noreferrer", target: "_blank", children: [_jsx(ExternalLinkIcon, { className: "size-4" }), localize(locale, `Sign in with ${part.displayName}`, `使用 ${part.displayName} 登录`)] }) })) : null] })] }) }));
}
function authorizationTitle(part, locale) {
    if (part.state === "required") {
        return localize(locale, `Connect ${part.displayName}`, `连接 ${part.displayName}`);
    }
    if (part.outcome === "authorized") {
        return localize(locale, `${part.displayName} connected`, `${part.displayName} 已连接`);
    }
    return localize(locale, `${part.displayName} authorization ${formatAuthorizationOutcome(part.outcome)}`, `${part.displayName} 授权${formatAuthorizationOutcome(part.outcome, locale)}`);
}
function authorizationDescription(part, locale) {
    if (part.state === "required") {
        return part.description;
    }
    if (part.outcome === "authorized") {
        return localize(locale, `${part.displayName} connected.`, `${part.displayName} 已连接。`);
    }
    const tail = part.reason !== undefined ? ` (${part.reason})` : "";
    return localize(locale, `${part.displayName} authorization ${formatAuthorizationOutcome(part.outcome)}${tail}.`, `${part.displayName} 授权${formatAuthorizationOutcome(part.outcome, locale)}${tail}。`);
}
function formatAuthorizationOutcome(outcome, locale = "en") {
    switch (outcome) {
        case "authorized":
            return localize(locale, "authorized", "成功");
        case "declined":
            return localize(locale, "declined", "已拒绝");
        case "failed":
            return localize(locale, "failed", "失败");
        case "timed-out":
            return localize(locale, "timed out", "已超时");
    }
}
function formatBytes(size) {
    if (size === undefined) {
        return undefined;
    }
    if (size < 1024) {
        return `${size} B`;
    }
    if (size < 1024 * 1024) {
        return `${(size / 1024).toFixed(1)} KB`;
    }
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
function InputRequestCard({ canRespond, closed, events, locale, onClose, onInputResponses, part, }) {
    const inputRequest = part.toolMetadata?.eve?.inputRequest;
    if (!inputRequest) {
        return null;
    }
    const inputResponse = part.toolMetadata?.eve?.inputResponse;
    const selectedOption = inputRequest.options?.find((option) => option.id === inputResponse?.optionId);
    const isQuestion = inputRequest.kind === "question";
    const isApproval = inputRequest.kind === "tool-approval";
    const acceptsFreeform = isQuestion && (inputRequest.allowFreeform === true || !inputRequest.options?.length);
    const Icon = isQuestion ? MessageCircleQuestionIcon : isApproval ? ShieldCheckIcon : CircleStopIcon;
    const eyebrow = isQuestion
        ? localize(locale, "Agent question", "Agent 需要确认")
        : isApproval
            ? localize(locale, "Approval required", "请求批准")
            : localize(locale, "Session limit reached", "已达到会话限制");
    const choices = inputRequest.options ?? [];
    const settled = Boolean(inputResponse) || closed;
    const [open, setOpen] = useState(!settled);
    useEffect(() => {
        if (settled)
            setOpen(false);
    }, [settled]);
    const status = closed
        ? localize(locale, "Closed", "已关闭")
        : inputResponse
            ? localize(locale, "Responded", "已回复")
            : isQuestion
                ? localize(locale, "Waiting for confirmation", "等待确认")
                : undefined;
    return (_jsx(Collapsible, { className: cn("my-1 max-w-full transition-[width] duration-200", open ? "w-full max-w-xl" : "w-fit"), onOpenChange: setOpen, open: open, children: _jsx("section", { className: "rounded-xl border border-border/70 bg-background px-3.5 py-3", "data-input-request-kind": inputRequest.kind, children: _jsxs("div", { className: "flex items-start gap-2.5", children: [_jsx(Icon, { className: "mt-0.5 size-4 shrink-0 text-muted-foreground" }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(CollapsibleTrigger, { asChild: true, children: _jsxs("button", { className: "group/request flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium text-muted-foreground hover:text-foreground", type: "button", children: [_jsx("span", { className: "truncate", children: eyebrow }), status ? _jsxs("span", { className: "shrink-0 font-normal text-muted-foreground/80", children: ["\u00B7 ", status] }) : null, _jsx(ChevronDownIcon, { className: "size-3.5 shrink-0 transition-transform group-data-[state=open]/request:rotate-180" })] }) }), !inputResponse && !closed && isQuestion ? _jsx(Button, { className: "h-6 shrink-0 px-2 text-xs", onClick: () => onClose(inputRequest.requestId), size: "sm", type: "button", variant: "ghost", children: localize(locale, "Close", "关闭") }) : null] }), _jsxs(CollapsibleContent, { className: "overflow-hidden", children: [_jsx("p", { className: "mt-1 text-sm leading-6 text-foreground", children: inputRequest.prompt }), isApproval ? _jsx(ApprovalActionPreview, { events: events, locale: locale, part: part }) : null, settled ? (_jsx(InputRequestReview, { closed: closed, inputResponse: inputResponse, locale: locale, options: choices, selectedOptionId: selectedOption?.id })) : (_jsx(QuestionnaireResponseForm, { acceptsFreeform: acceptsFreeform, canRespond: canRespond, locale: locale, onInputResponses: onInputResponses, options: choices, prompt: inputRequest.prompt, requestId: inputRequest.requestId }))] })] })] }) }) }));
}
function ApprovalActionPreview({ events, locale, part, }) {
    const normalized = normalizeToolName(part.toolName);
    const input = asRecord(part.input);
    if (["bash", "shell", "terminal", "exec_command"].includes(normalized)) {
        return (_jsx("div", { className: "mt-3", children: _jsx(ShellToolContent, { command: firstString(input, ["command", "cmd"]), locale: locale, output: undefined, running: false }) }));
    }
    if (isFileMutationTool(part)) {
        const patch = toolPatch(part);
        const change = toolFileChange(part, events);
        if (patch) {
            return _jsx("div", { className: "mt-3", "data-tool-view": "approval-diff", children: _jsx(DiffViewer, { contentClassName: "max-h-56 overflow-auto", patch: patch, showIcon: true, size: "sm", variant: "muted" }) });
        }
        if (change) {
            return (_jsx("div", { className: "mt-3", "data-tool-view": "approval-diff", children: _jsx(DiffViewer, { contentClassName: "max-h-56 overflow-auto", newFile: { content: change.newContent, name: change.path }, oldFile: { content: change.oldContent, name: change.path }, showIcon: true, size: "sm", variant: "muted" }) }));
        }
    }
    return (_jsx("pre", { className: "mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2.5 text-xs text-foreground", "data-tool-view": "approval-input", children: safeStringify(part.input) }));
}
function InputRequestReview({ closed, inputResponse, locale, options, selectedOptionId, }) {
    return (_jsxs("div", { className: "mt-3 space-y-2 text-sm", "data-tool-view": "input-review", children: [_jsx("p", { className: "text-xs text-muted-foreground", children: closed
                    ? localize(locale, "This question was closed. The details remain available for review.", "此问题已关闭，详细内容仍可回看。")
                    : localize(locale, "Response", "回复") }), options.length > 0 ? (_jsx("ul", { className: "space-y-1.5", "aria-label": localize(locale, "Options", "选项"), children: options.map((option) => (_jsxs("li", { className: cn("flex items-start gap-2 rounded-md bg-muted/40 px-2.5 py-2", selectedOptionId === option.id && "bg-accent/80 text-foreground"), children: [_jsx("span", { className: cn("mt-1 size-2 shrink-0 rounded-full border border-muted-foreground/40", selectedOptionId === option.id && "border-primary bg-primary") }), _jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block font-medium", children: option.label }), option.description ? _jsx("span", { className: "block text-xs leading-5 text-muted-foreground", children: option.description }) : null] })] }, option.id))) })) : null, _jsxs("div", { className: "rounded-md bg-muted/40 px-2.5 py-2", children: [_jsx("p", { className: "text-xs text-muted-foreground", children: localize(locale, "Additional information", "补充信息") }), _jsx("p", { className: "mt-1 whitespace-pre-wrap break-words text-foreground", children: inputResponse?.text?.trim() || localize(locale, "No additional information provided.", "未提供补充信息。") })] })] }));
}
const FREEFORM_OPTION_ID = "__open_agent_freeform__";
function QuestionnaireResponseForm({ acceptsFreeform, canRespond, locale, onInputResponses, options, prompt, requestId, }) {
    const [freeformText, setFreeformText] = useState("");
    const [selectedOptionId, setSelectedOptionId] = useState("");
    const hasFreeformAnswer = acceptsFreeform && freeformText.trim().length > 0;
    const questionnaireItems = [{
            choices: [
                ...options.map((option) => ({ value: option.id })),
                ...(acceptsFreeform ? [{ value: FREEFORM_OPTION_ID }] : []),
            ],
            name: "response",
            required: true,
        }];
    return (_jsxs(Questionnaire, { className: "mt-3", items: questionnaireItems, noValidate: true, onSubmit: (event) => {
            event.preventDefault();
            if (!canRespond)
                return;
            const text = freeformText.trim();
            if (!selectedOptionId && !text)
                return;
            void onInputResponses([{
                    ...(selectedOptionId ? { optionId: selectedOptionId } : {}),
                    ...(text ? { text } : {}),
                    requestId,
                }]);
        }, children: [_jsxs(QuestionnaireItem, { name: "response", required: true, children: [_jsx(QuestionnaireTitle, { className: "sr-only", children: prompt }), _jsxs(QuestionnaireChoices, { children: [options.map((option) => (_jsxs(QuestionnaireChoice, { checked: selectedOptionId === option.id, className: option.style === "danger" ? "border-destructive/40 data-checked:bg-destructive/10" : option.style === "primary" ? "data-checked:border-primary/50" : undefined, disabled: !canRespond, onChange: (event) => setSelectedOptionId(event.currentTarget.checked ? option.id : ""), value: option.id, children: [_jsx("span", { className: cn("min-w-0 break-words font-medium", option.style === "danger" && "text-destructive"), children: option.label }), option.description ? _jsx(QuestionnaireChoiceDescription, { children: option.description }) : null] }, option.id))), acceptsFreeform ? (_jsxs(_Fragment, { children: [_jsx(QuestionnaireChoice, { checked: !selectedOptionId && hasFreeformAnswer, className: "hidden", value: FREEFORM_OPTION_ID, children: localize(locale, "Freeform answer", "补充回答") }), _jsx("textarea", { "aria-label": options.length > 0 ? localize(locale, "Additional information", "补充信息") : localize(locale, "Answer", "回答"), className: "min-h-20 w-full resize-y rounded-lg border border-border/70 bg-transparent px-3 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50", disabled: !canRespond, onChange: (event) => setFreeformText(event.currentTarget.value), placeholder: options.length > 0 ? localize(locale, "Add context (optional)", "补充信息（可选）") : localize(locale, "Type your answer", "输入你的回答"), value: freeformText })] })) : null] }), _jsx(QuestionnaireError, { children: localize(locale, "Choose an option or add information to continue.", "请选择一个选项或补充信息后继续。") })] }), _jsx("div", { className: "flex justify-end pt-1", children: _jsx(QuestionnaireSubmit, { disabled: !canRespond, children: localize(locale, "Confirm", "确认") }) })] }));
}
function TurnFailure({ failure, locale }) {
    return (_jsxs("div", { className: "mt-2 flex items-start gap-3 rounded-xl border border-border/70 px-3.5 py-3 text-sm", role: "alert", children: [_jsx(XCircleIcon, { className: "mt-0.5 size-4 shrink-0 text-destructive" }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "font-medium text-foreground", children: localize(locale, "This turn failed", "本轮执行失败") }), _jsx("p", { className: "mt-1 break-words text-muted-foreground", children: sanitizeFailureMessage(failure.message) }), _jsx("code", { className: "mt-1.5 block text-xs text-muted-foreground", children: failure.code })] })] }));
}
function sanitizeFailureMessage(message) {
    return message
        .replace(/(["']?base[_ -]?url["']?\s*[:=]\s*)["']?https?:\/\/[^\s,"'}]+["']?/giu, "$1[hidden]")
        .replace(/https?:\/\/[^\s)\]}>"']+/giu, "[provider endpoint hidden]");
}
function localize(locale, english, chinese) {
    return locale === "zh-CN" ? chinese : english;
}
function toolStatusLabel(locale, part) {
    if (part.state === "output-available" && part.partial === true) {
        return localize(locale, "Running", "运行中");
    }
    switch (part.state) {
        case "approval-requested":
            return localize(locale, "Awaiting approval", "等待批准");
        case "approval-responded":
            return localize(locale, "Responded", "已回复");
        case "input-available":
            return localize(locale, "Running", "运行中");
        case "input-streaming":
            return localize(locale, "Pending", "准备中");
        case "output-available":
            return localize(locale, "Completed", "已完成");
        case "output-denied":
            return localize(locale, "Denied", "已拒绝");
        case "output-error":
            return localize(locale, "Error", "错误");
    }
}
function toolTitle(locale, part, events = []) {
    const kind = part.toolMetadata?.eve?.kind;
    if (kind === "load-skill")
        return localize(locale, "Loaded skill", "加载技能");
    if (kind === "subagent-call")
        return localize(locale, "Sub-agent", "子代理");
    const normalized = part.toolName.toLocaleLowerCase().replaceAll("-", "_");
    if (normalized === "ask_question")
        return localize(locale, "Question", "确认问题");
    if (isFileMutationTool(part))
        return fileMutationTitle(locale, part, events);
    if (["bash", "shell", "terminal", "exec_command"].includes(normalized)) {
        const command = firstString(asRecord(part.input), ["command", "cmd"]);
        return [localize(locale, "Terminal command", "终端命令"), command].filter(Boolean).join(" ");
    }
    if (["publish_preview", "website_preview"].includes(normalized))
        return localize(locale, "Published preview", "发布网站预览");
    if (["import_remote_asset", "remote_asset_import"].includes(normalized)) {
        const filename = firstString(asRecord(part.input), ["filename", "url"]);
        return [localize(locale, "Imported remote asset", "导入远程资产"), filename].filter(Boolean).join(" ");
    }
    if (["publish_artifact", "artifact_publish"].includes(normalized))
        return localize(locale, "Published artifact", "发布产物");
    if (["record_checkpoint", "checkpoint"].includes(normalized))
        return localize(locale, "Saved checkpoint", "保存检查点");
    if (["read_file", "read", "view_file"].includes(normalized)) {
        const path = firstString(asRecord(part.input), ["path", "file", "filename"]);
        return [localize(locale, "Read file", "读取文件"), path].filter(Boolean).join(" ");
    }
    if (isViewImageTool(normalized)) {
        const path = firstString(asRecord(part.input), ["path"]);
        return [localize(locale, "Viewed image", "查看图片"), path].filter(Boolean).join(" ");
    }
    if (["glob", "find_files"].includes(normalized)) {
        const query = firstString(asRecord(part.input), ["query", "pattern", "glob", "path"]);
        return [localize(locale, "Found files", "查找文件"), query].filter(Boolean).join(" ");
    }
    if (["grep", "search_files"].includes(normalized)) {
        const query = firstString(asRecord(part.input), ["query", "pattern", "path"]);
        return [localize(locale, "Searched files", "搜索文件"), query].filter(Boolean).join(" ");
    }
    if (["todo", "todo_write", "update_plan"].includes(normalized))
        return localize(locale, "Updated tasks", "更新任务列表");
    if (["web_search", "search_web", "search"].includes(normalized))
        return localize(locale, "Searched the web", "搜索网页");
    if (["web_fetch", "fetch_url"].includes(normalized)) {
        const url = firstString(asRecord(part.input), ["url"]);
        return [localize(locale, "Fetched webpage", "读取网页"), url].filter(Boolean).join(" ");
    }
    return part.toolName.replaceAll("_", " ");
}
function partKey(part, index) {
    switch (part.type) {
        case "authorization":
            return `authorization:${part.turnId}:${part.stepIndex}:${part.name}`;
        case "dynamic-tool":
            return part.toolCallId;
        default:
            return `${part.type}:${index}`;
    }
}
//# sourceMappingURL=agent-message.js.map