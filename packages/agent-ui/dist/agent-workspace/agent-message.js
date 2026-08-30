"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { BracesIcon, CheckIcon, CheckCircleIcon, CircleAlertIcon, ChevronDownIcon, CircleStopIcon, CopyIcon, ExternalLinkIcon, FileIcon, ImageIcon, KeyRoundIcon, LoaderCircleIcon, NetworkIcon, SearchIcon, TerminalIcon, FileSearchIcon, ListChecksIcon, MessageCircleQuestionIcon, MonitorIcon, ShieldCheckIcon, WifiIcon, XCircleIcon, } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useScrollLock } from "@assistant-ui/react";
import { StaticMarkdownText } from "../assistant-ui/markdown-text.js";
import { ArtifactCard } from "../assistant-ui/artifact-card.js";
import { copyText } from "../assistant-ui/copy-text.js";
import { ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger, } from "../assistant-ui/reasoning.js";
import { ToolFallbackContent, ToolFallbackRoot, } from "../assistant-ui/tool-fallback.js";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger, } from "../assistant-ui/tool-group.js";
import { DiffViewer } from "../assistant-ui/diff-viewer.js";
import { Button } from "../ui/button.js";
import { Attachment, AttachmentAction, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "../ui/attachment.js";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { Questionnaire, QuestionnaireChoice, QuestionnaireChoiceDescription, QuestionnaireChoices, QuestionnaireError, QuestionnaireItem, QuestionnaireSubmit, QuestionnaireTitle, } from "../ui/questionnaire.js";
import { cn } from "../utils.js";
import { failureForTurn, classifyAgentFailure, isRetryableAgentFailure, isCancellationPendingToolPart, isInterruptedToolPart, presentAgentTurn, presentAgentStep, presentSubagentCall, reasoningContentForStep, } from "./turn-presentation.js";
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
function useThrottledValue(value, delayMs) {
    const latestRef = useRef(value);
    const timerRef = useRef(undefined);
    const [snapshot, setSnapshot] = useState(value);
    latestRef.current = value;
    useEffect(() => {
        if (Object.is(snapshot, value) || timerRef.current !== undefined)
            return;
        timerRef.current = window.setTimeout(() => {
            timerRef.current = undefined;
            setSnapshot(latestRef.current);
        }, delayMs);
    }, [delayMs, snapshot, value]);
    useEffect(() => () => {
        if (timerRef.current !== undefined)
            window.clearTimeout(timerRef.current);
    }, []);
    return snapshot;
}
const EMPTY_CLOSED_INPUT_REQUEST_IDS = new Set();
const DeliverableOpenContext = createContext(undefined);
export function AgentMessage({ assetUrl, canRespond, closedInputRequestIds = EMPTY_CLOSED_INPUT_REQUEST_IDS, events, fallbackStartedAt, isStreaming, isTurnContinuation = false, locale, message, onOpenDeliverable, onOpenSubagent, onInputResponses, onCloseInputRequest = () => undefined, showCopyAction = true, }) {
    const displayMessage = assetUrl
        ? {
            ...message,
            parts: message.parts.map((part) => part.type === "file" && part.url?.startsWith("asset://")
                ? { ...part, url: assetUrl(part.url.slice("asset://".length)) }
                : part),
        }
        : message;
    const task = presentAgentTurn(displayMessage, events, closedInputRequestIds, {
        mergeSameTurn: Boolean(displayMessage.metadata?.turnId),
    });
    const responseText = task?.finalPart?.text ?? (task ? undefined : lastText(displayMessage.parts));
    const failure = failureForTurn(events, displayMessage.metadata?.turnId);
    const hasFailureStepAnchor = task?.failureAnchored === true;
    const executionShellRef = useRef(Boolean(task || isStreaming || failure));
    if (task || isStreaming || failure)
        executionShellRef.current = true;
    const showExecutionShell = executionShellRef.current;
    const executionTask = task ?? {
        proxiedInputParts: [],
        processParts: [],
        startedAt: fallbackStartedAt,
        status: isStreaming ? "running" : failure ? "failed" : "completed",
    };
    const publishedDeliverables = task?.status === "completed"
        ? deliverablesForTurn(events, displayMessage.metadata?.turnId)
        : [];
    const directParts = !task && message.role === "assistant" && isStreaming && !failure &&
        !displayMessage.parts.some((part) => part.type === "reasoning")
        ? [
            {
                state: "streaming",
                stepIndex: activeReasoningStep(events, displayMessage.metadata?.turnId),
                text: "",
                type: "reasoning",
            },
            ...displayMessage.parts,
        ]
        : displayMessage.parts;
    const renderExecutionShell = showExecutionShell && (Boolean(task) || isStreaming || directParts.length > 0);
    return (_jsx(DeliverableOpenContext.Provider, { value: onOpenDeliverable, children: _jsxs(Message, { "data-optimistic": message.metadata?.optimistic ? "true" : undefined, from: message.role, children: [_jsxs(MessageContent, { className: message.role === "assistant" ? "w-full" : undefined, children: [renderExecutionShell ? (_jsxs(_Fragment, { children: [_jsx(ExecutionGroup, { collapseWhenSettled: Boolean(task && task.status === "completed" && (task.finalPart?.text.trim() || hasLaterFinalDelivery(events, message.metadata?.turnId))), fallbackStartedAt: fallbackStartedAt, locale: locale, showTrigger: Boolean(task), task: executionTask, children: _jsxs("div", { className: isTurnContinuation ? "space-y-2" : undefined, children: [_jsx(ProcessParts, { assetUrl: assetUrl, canRespond: canRespond, closedInputRequestIds: closedInputRequestIds, events: events, inActiveExecution: executionTask.status === "running" || executionTask.status === "waiting", locale: locale, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, onOpenSubagent: onOpenSubagent, parts: withReasoningParts(task?.processParts ?? directParts, events, message.metadata?.turnId), turnId: message.metadata?.turnId }), task?.proxiedInputParts.map((part) => (_jsxs("div", { className: "space-y-2", children: [_jsx("p", { className: "text-xs font-medium text-amber-700 dark:text-amber-300", children: localize(locale, "A delegated task needs your approval", "子代理任务需要你的批准") }), _jsx(AgentMessagePart, { assetUrl: assetUrl, canRespond: canRespond, closedInputRequestIds: closedInputRequestIds, events: events, inActiveExecution: true, locale: locale, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, onOpenSubagent: onOpenSubagent, part: part, turnId: message.metadata?.turnId })] }, `proxied-input:${part.toolCallId}`)))] }) }), task?.finalPart ? (_jsx("div", { className: "pt-2", children: _jsx(AgentMessagePart, { assetUrl: assetUrl, canRespond: canRespond, events: events, inActiveExecution: false, locale: locale, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, onOpenSubagent: onOpenSubagent, part: task.finalPart, turnId: message.metadata?.turnId }) })) : null, task && publishedDeliverables.length > 0 ? (_jsx("div", { className: "space-y-2 pt-3", "data-turn-deliverables": true, children: publishedDeliverables.map((deliverable) => _jsx(PublishedDeliverableCard, { deliverable: deliverable, locale: locale }, `${deliverable.kind}:${deliverable.id}`)) })) : null] })) : directParts.map((part, index) => (_jsx(AgentMessagePart, { assetUrl: assetUrl, canRespond: canRespond, events: events, inActiveExecution: false, locale: locale, onInputResponses: onInputResponses, onCloseInputRequest: onCloseInputRequest, onOpenSubagent: onOpenSubagent, part: part, turnId: message.metadata?.turnId }, partKey(part, index)))), failure && !hasFailureStepAnchor ? _jsx(TurnFailure, { failure: failure, locale: locale }) : null] }), showCopyAction && message.role === "assistant" && responseText && !isStreaming ? (_jsx(CopyResponseAction, { locale: locale, text: responseText })) : null] }) }));
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
    let previousStepIndex = -1;
    const toolGroupOrdinalByStep = new Map();
    const lastReasoningPartByStep = new Map();
    const renderedStepActivity = new Set();
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const candidate = parts[partIndex];
        if (candidate?.type === "reasoning" && typeof candidate.stepIndex === "number") {
            lastReasoningPartByStep.set(candidate.stepIndex, partIndex);
        }
    }
    for (let index = 0; index < parts.length;) {
        const part = parts[index];
        if (part.type === "step-start") {
            const nextStep = parts.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.type === "step-start");
            const stepEnd = nextStep < 0 ? parts.length : nextStep;
            const stepParts = parts.slice(index + 1, stepEnd);
            const stepIndex = stepIndexForParts(stepParts, events, turnId, previousStepIndex);
            if (stepIndex !== undefined)
                previousStepIndex = stepIndex;
            const hasReasoning = stepIndex !== undefined && (stepParts.some((candidate) => candidate.type === "reasoning" && candidate.stepIndex === stepIndex) ||
                Boolean(reasoningContentForStep(events, turnId, stepIndex)));
            if (!hasReasoning) {
                const hasStepEvidence = stepIndex !== undefined && events.some((event) => eventStepMatches(event, turnId, stepIndex));
                if (!hasStepEvidence) {
                    index += 1;
                    continue;
                }
                const activityStep = stepIndex ?? previousStepIndex;
                if (activityStep >= 0 && !renderedStepActivity.has(activityStep)) {
                    renderedStepActivity.add(activityStep);
                    rendered.push(_jsx(StepActivity, { events: events, locale: locale, stepIndex: activityStep, turnId: turnId }, `step-activity:${turnId}:${activityStep}`));
                }
            }
            index += 1;
            continue;
        }
        if (part.type === "reasoning" &&
            typeof part.stepIndex === "number" &&
            lastReasoningPartByStep.get(part.stepIndex) !== index) {
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
            const groupStepIndex = stepIndexForParts(toolParts, events, turnId, previousStepIndex) ?? previousStepIndex;
            const groupOrdinal = groupStepIndex === undefined
                ? index
                : toolGroupOrdinalByStep.get(groupStepIndex) ?? 0;
            if (groupStepIndex !== undefined) {
                toolGroupOrdinalByStep.set(groupStepIndex, groupOrdinal + 1);
            }
            rendered.push(_jsx(ProcessToolGroup, { active: active, assetUrl: assetUrl, canRespond: canRespond, closedInputRequestIds: closedInputRequestIds, events: events, inActiveExecution: inActiveExecution, locale: locale, needsInput: needsInput, onCloseInputRequest: onCloseInputRequest, onInputResponses: onInputResponses, onOpenSubagent: onOpenSubagent, toolParts: toolParts, turnId: turnId }, `tools:${turnId ?? "unknown"}:${groupStepIndex ?? "unknown"}:${groupOrdinal}`));
        }
        index = cursor;
    }
    return _jsx(_Fragment, { children: rendered });
}
function withReasoningParts(parts, events, turnId) {
    if (!turnId || !parts.some((part) => part.type === "step-start"))
        return parts;
    const reasoningParts = parts.filter((part) => part.type === "reasoning");
    const remaining = parts.filter((part) => part.type !== "reasoning");
    const next = [];
    const usedReasoning = new Set();
    const representedReasoningSteps = new Set();
    let previousStepIndex = -1;
    for (let index = 0; index < remaining.length; index += 1) {
        const part = remaining[index];
        next.push(part);
        if (part.type !== "step-start")
            continue;
        const nextMarker = remaining.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.type === "step-start");
        const stepParts = remaining.slice(index + 1, nextMarker < 0 ? remaining.length : nextMarker);
        const stepIndex = stepIndexForParts(stepParts, events, turnId, previousStepIndex);
        if (stepIndex === undefined)
            continue;
        previousStepIndex = stepIndex;
        if (representedReasoningSteps.has(stepIndex))
            continue;
        const existing = reasoningParts.find((candidate, candidateIndex) => !usedReasoning.has(candidateIndex) && candidate.stepIndex === stepIndex) ?? reasoningParts.find((candidate, candidateIndex) => !usedReasoning.has(candidateIndex) && candidate.stepIndex === undefined);
        const existingIndex = existing ? reasoningParts.indexOf(existing) : -1;
        if (existingIndex >= 0)
            usedReasoning.add(existingIndex);
        const eventText = reasoningContentForStep(events, turnId, stepIndex);
        const text = eventText || existing?.text.trim() || "";
        if (existing || text) {
            representedReasoningSteps.add(stepIndex);
            next.push({
                ...(existing ?? { state: "done", text, type: "reasoning" }),
                ...(existing?.text.trim() ? {} : { text }),
                stepIndex,
            });
        }
    }
    const representedSteps = new Set(next.flatMap((part) => part.type === "reasoning" && typeof part.stepIndex === "number" ? [part.stepIndex] : []));
    for (let index = 0; index < reasoningParts.length; index += 1) {
        if (usedReasoning.has(index))
            continue;
        const part = reasoningParts[index];
        if (part.stepIndex !== undefined && representedSteps.has(part.stepIndex))
            continue;
        next.push(part);
    }
    return next.length === parts.length && next.every((part, index) => part === parts[index]) ? parts : next;
}
function stepIndexForParts(parts, events, turnId, previousStepIndex) {
    const explicit = parts.find((part) => "stepIndex" in part && typeof part.stepIndex === "number");
    if (explicit && "stepIndex" in explicit && typeof explicit.stepIndex === "number") {
        return explicit.stepIndex;
    }
    if (!turnId)
        return undefined;
    return events
        .map(eventStep)
        .filter((step) => step !== undefined && step > previousStepIndex)
        .find((step) => events.some((event) => eventStepMatches(event, turnId, step)));
}
function eventStep(event) {
    if (!("data" in event) || !event.data || typeof event.data !== "object")
        return undefined;
    return "stepIndex" in event.data && typeof event.data.stepIndex === "number"
        ? event.data.stepIndex
        : undefined;
}
function eventStepMatches(event, turnId, stepIndex) {
    if (!turnId || !("data" in event) || !event.data || typeof event.data !== "object")
        return false;
    const data = event.data;
    return data.turnId === turnId && data.stepIndex === stepIndex;
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
    const interrupted = isInterruptedToolPart(part);
    const cancellationPending = isCancellationPendingToolPart(part);
    const statusLabel = isFileMutationTool(part) ? undefined : toolStatusLabel(locale, part);
    return (_jsxs(ToolFallbackRoot, { className: "my-0", defaultOpen: defaultOpen, children: [_jsxs(CollapsibleTrigger, { className: "group/trigger flex w-fit max-w-full origin-left items-center gap-2 py-1.5 text-left text-sm text-muted-foreground transition-[color,scale] hover:text-foreground active:scale-[0.98]", children: [running ? (_jsx(LoaderCircleIcon, { className: "size-4 shrink-0 animate-spin [animation-duration:0.65s]" })) : interrupted ? (_jsx(CircleStopIcon, { className: "size-4 shrink-0 text-muted-foreground" })) : cancellationPending ? (_jsx(LoaderCircleIcon, { className: "size-4 shrink-0 animate-spin text-muted-foreground [animation-duration:0.9s]" })) : part.state === "output-error" || part.state === "output-denied" ? (_jsx(XCircleIcon, { className: "size-4 shrink-0 text-destructive" })) : (_jsx(Icon, { className: "size-4 shrink-0" })), isFileMutationTool(part) ? (_jsx(FileMutationToolTitle, { events: events, locale: locale, part: part })) : (_jsx("span", { className: "truncate", children: toolTitle(locale, part, events) })), statusLabel ? (_jsx("span", { className: cn("shrink-0 text-xs", part.state === "output-error" && "text-destructive"), children: statusLabel })) : null, _jsx(ChevronDownIcon, { className: "size-3.5 shrink-0 -rotate-90 transition-transform group-data-[state=open]/trigger:rotate-0" })] }), _jsxs(ToolFallbackContent, { children: [_jsx(KnownToolContent, { assetUrl: assetUrl, events: events, locale: locale, onOpenSubagent: onOpenSubagent, part: part }), part.errorText ? (_jsx("p", { className: cn("whitespace-pre-wrap text-xs", interrupted ? "text-muted-foreground" : "text-destructive"), children: interrupted
                            ? localize(locale, "Tool call stopped before completion.", "工具调用在完成前已中断。")
                            : cancellationPending
                                ? localize(locale, "Stopping tool call…", "正在停止工具调用…")
                                : part.errorText })) : null] })] }));
}
function KnownToolContent({ assetUrl, events, locale, onOpenSubagent, part, }) {
    const normalized = normalizeToolName(part.toolName);
    const input = asRecord(part.input);
    const output = "output" in part ? part.output : undefined;
    const openDeliverable = useContext(DeliverableOpenContext);
    if (part.toolMetadata?.eve?.kind === "subagent-call") {
        return _jsx(SubagentProgress, { events: events, locale: locale, onOpenSubagent: onOpenSubagent, part: part });
    }
    if (["apply_patch", "patch_file", "write_file", "edit_file"].includes(normalized)) {
        return _jsx(FileMutationToolContent, { events: events, locale: locale, part: part });
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
        const deliverable = publishedDeliverable(output, "website-preview", url);
        return url ? (_jsx(ArtifactCard, { icon: _jsx(MonitorIcon, { className: "size-4" }), meta: localize(locale, "Website preview", "网站预览"), onClick: () => deliverable && openDeliverable ? openDeliverable(deliverable) : window.open(url, "_blank", "noopener,noreferrer"), title: firstString(asRecord(output), ["title", "entrypoint"]) ?? localize(locale, "Published website", "已发布网站") })) : result ? _jsx("p", { className: "whitespace-pre-wrap text-xs text-muted-foreground", children: result }) : null;
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
        const deliverable = publishedDeliverable(output, "artifact", url);
        return url ? (_jsx(ArtifactCard, { meta: [firstString(record, ["mediaType"]), formatBytes(firstNumber(record, ["bytes", "sizeBytes"]))].filter(Boolean).join(" · ") || localize(locale, "Session artifact", "会话产物"), onClick: () => deliverable && openDeliverable ? openDeliverable(deliverable) : window.open(url, "_blank", "noopener,noreferrer"), title: filename ?? localize(locale, "Open artifact", "打开产物") })) : _jsx("p", { className: "text-xs text-muted-foreground", children: filename ?? localize(locale, "Publishing artifact...", "正在发布产物…") });
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
function FileMutationToolContent({ events, locale, part, }) {
    const previewPart = usePreviewFileMutationPart(part);
    const patch = toolPatch(previewPart);
    const fileChange = toolFileChange(previewPart, events);
    if (patch) {
        return _jsx("div", { "data-tool-view": "diff", children: _jsx(DiffViewer, { contentClassName: "max-h-72 overflow-auto", patch: patch, showIcon: true, size: "sm", variant: "muted" }) });
    }
    if (fileChange) {
        return (_jsx("div", { "data-tool-view": "diff", children: _jsx(DiffViewer, { contentClassName: "max-h-72 overflow-auto", newFile: { content: fileChange.newContent, name: fileChange.path }, oldFile: { content: fileChange.oldContent, name: fileChange.path }, showIcon: true, size: "sm", variant: "muted" }) }));
    }
    if (part.state === "output-error" || part.state === "output-denied") {
        return (_jsx("p", { className: "text-xs text-muted-foreground", children: part.state === "output-denied"
                ? localize(locale, "File change was not approved.", "文件变更未获批准。")
                : localize(locale, "File change failed before a diff was produced.", "文件变更失败，未生成可展示的差异。") }));
    }
    return _jsx("p", { className: "text-xs text-muted-foreground", children: localize(locale, "Receiving file changes...", "正在接收文件变更…") });
}
function FileMutationToolTitle({ events, locale, part, }) {
    const previewPart = usePreviewFileMutationPart(part);
    const summary = fileMutationSummary(previewPart, events);
    return (_jsxs("span", { className: "flex min-w-0 items-center gap-1.5 truncate", children: [_jsxs("span", { className: "truncate", children: [fileMutationActionLabel(locale, previewPart, summary), summary.path ? ` ${summary.path}` : ""] }), summary.additions > 0 ? _jsxs(_Fragment, { children: [_jsx("span", { "aria-hidden": "true", children: " " }), _jsxs("span", { className: "shrink-0 text-green-600 dark:text-green-400", children: ["+", summary.additions] })] }) : null, summary.deletions > 0 ? _jsxs("span", { className: "shrink-0 text-red-600 dark:text-red-400", children: ["-", summary.deletions] }) : null] }));
}
function usePreviewFileMutationPart(part) {
    const liveInput = useThrottledValue(part.input, 75);
    const liveInputText = useThrottledValue(part.inputText, 75);
    return isToolTerminal(part)
        ? part
        : { ...part, input: liveInput, inputText: liveInputText };
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
    if (isCancellationPendingToolPart(part)) {
        const summary = fileMutationSummary(part, events);
        const stats = [
            summary.additions > 0 ? `+${summary.additions}` : undefined,
            summary.deletions > 0 ? `-${summary.deletions}` : undefined,
        ].filter(Boolean).join(" ");
        return [localize(locale, "Stopping", "正在停止"), summary.path, stats].filter(Boolean).join(" ");
    }
    if (isInterruptedToolPart(part)) {
        const summary = fileMutationSummary(part, events);
        const stats = [
            summary.additions > 0 ? `+${summary.additions}` : undefined,
            summary.deletions > 0 ? `-${summary.deletions}` : undefined,
        ].filter(Boolean).join(" ");
        return [localize(locale, "Stopped", "已中断"), summary.path, stats].filter(Boolean).join(" ");
    }
    const running = !isToolTerminal(part);
    const summary = fileMutationSummary(part, events);
    const action = fileMutationActionLabel(locale, part, summary);
    const stats = [
        summary.additions > 0 ? `+${summary.additions}` : undefined,
        summary.deletions > 0 ? `-${summary.deletions}` : undefined,
    ].filter(Boolean).join(" ");
    return [action, summary.path, stats].filter(Boolean).join(" ");
}
function fileMutationActionLabel(locale, part, summary) {
    if (isCancellationPendingToolPart(part))
        return localize(locale, "Stopping", "正在停止");
    if (isInterruptedToolPart(part))
        return localize(locale, "Stopped", "已中断");
    if (part.state === "output-error")
        return localize(locale, "Failed", "失败");
    if (part.state === "output-denied")
        return localize(locale, "Not approved", "未批准");
    const running = !isToolTerminal(part);
    return summary.operation === "create"
        ? running ? localize(locale, "Creating", "正在创建") : localize(locale, "Created", "已创建")
        : summary.operation === "delete"
            ? running ? localize(locale, "Deleting", "正在删除") : localize(locale, "Deleted", "已删除")
            : running ? localize(locale, "Editing", "正在编辑") : localize(locale, "Edited", "已编辑");
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
    const hasReasoningContent = Boolean(reasoningContentForStep(events, turnId, stepIndex));
    const hasToolActivity = events.some((event) => {
        if (event.type !== "actions.requested" && event.type !== "action.input.partial" && event.type !== "action.result")
            return false;
        return eventTurnMatches(event, turnId, stepIndex);
    });
    const timing = reasoningTiming(events, turnId, stepIndex);
    const durationSeconds = useElapsedSeconds(timing.startedAt, timing.endedAt);
    return (_jsx(ReasoningBlock, { durationSeconds: durationSeconds, events: events, failure: step.failure, locale: locale, retryItems: step.retries ?? (step.retry ? [step.retry] : []), stepIndex: stepIndex, streaming: step.status === "running" && !hasToolActivity, text: hasReasoningContent ? reasoningContentForStep(events, turnId, stepIndex) : "", timing: timing, turnId: turnId }));
}
function StepFailure({ failure, locale, }) {
    return (_jsxs(Alert, { className: "mb-2 py-2.5", "data-agent-failure-alert": true, variant: "destructive", children: [_jsx(XCircleIcon, {}), _jsx(AlertTitle, { children: failureTitle(locale, failure) }), _jsxs(AlertDescription, { children: [_jsx("p", { children: failureSummary(locale, failure) }), failure.code ? _jsx("code", { className: "break-all text-xs", children: failure.code }) : null] })] }));
}
function RetryStatus({ locale, retry, }) {
    if (retry.exhausted) {
        const attempt = retry.maximum ?? retry.attempt;
        return (_jsxs(_Fragment, { children: [_jsxs(Collapsible, { className: "mb-1 text-sm text-muted-foreground", "data-agent-retry": true, defaultOpen: false, children: [_jsxs(CollapsibleTrigger, { className: "group/retry flex max-w-full items-center gap-2 py-1.5 text-left hover:text-foreground", children: [_jsx(WifiIcon, { className: "size-4 shrink-0" }), _jsxs("span", { children: [retryTitle(locale, retry.error), attempt !== undefined && retry.maximum !== undefined
                                            ? ` (${attempt}/${retry.maximum})`
                                            : ""] }), _jsx(ChevronDownIcon, { className: "size-3.5 -rotate-90 transition-transform group-data-[state=open]/retry:rotate-0" })] }), retry.error ? (_jsx(CollapsibleContent, { className: "overflow-hidden", children: _jsxs("div", { className: "ml-6 mt-1 max-w-full text-xs", children: [_jsx("p", { className: "break-words text-foreground", children: failureSummary(locale, retry.error) }), retry.error.code ? _jsx("code", { className: "mt-1 block break-all text-muted-foreground", children: retry.error.code }) : null] }) })) : null] }), _jsxs(Alert, { className: "mb-2 py-2.5", "data-agent-failure-alert": true, variant: "destructive", children: [_jsx(CircleAlertIcon, {}), _jsx(AlertTitle, { children: localize(locale, "Retry failed", "重试失败") }), retry.error ? (_jsxs(AlertDescription, { children: [_jsx("p", { children: failureSummary(locale, retry.error) }), retry.error.code ? _jsx("code", { className: "break-all text-xs", children: retry.error.code }) : null] })) : null] })] }));
    }
    return (_jsxs(Collapsible, { className: "mb-1 text-sm text-muted-foreground", "data-agent-retry": true, defaultOpen: false, children: [_jsxs(CollapsibleTrigger, { className: "group/retry flex max-w-full items-center gap-2 py-1.5 text-left hover:text-foreground", children: [_jsx(WifiIcon, { className: "size-4 shrink-0" }), _jsxs("span", { children: [retryTitle(locale, retry.error), retry.attempt !== undefined && retry.maximum !== undefined
                                ? ` (${retry.attempt}/${retry.maximum})`
                                : ""] }), retry.error ? _jsx(ChevronDownIcon, { className: "size-3.5 -rotate-90 transition-transform group-data-[state=open]/retry:rotate-0" }) : null] }), retry.error ? (_jsx(CollapsibleContent, { className: "overflow-hidden", children: _jsxs("div", { className: "ml-6 mt-1 max-w-full text-xs", children: [_jsx("p", { className: "break-words text-foreground", children: failureSummary(locale, retry.error) }), _jsx("code", { className: "mt-1 block break-all text-muted-foreground", children: retry.error.code })] }) })) : null] }));
}
function ReasoningPart({ events, locale, part, turnId, }) {
    const timing = reasoningTiming(events, turnId, part.stepIndex);
    const step = presentAgentStep(events, turnId, part.stepIndex ?? 0);
    const retryItems = step.retries ?? (step.retry ? [step.retry] : []);
    const stepIndex = part.stepIndex ?? 0;
    const durationSeconds = useElapsedSeconds(timing.startedAt, timing.endedAt);
    const retryInFlight = isReasoningRetryInFlight(events, turnId, part.stepIndex);
    const eventText = reasoningContentForStep(events, turnId, part.stepIndex);
    const responseStarted = Boolean(turnId) && !eventText && events.some((event) => (event.type === "message.appended" || event.type === "message.completed") &&
        eventTurnMatches(event, turnId, stepIndex) &&
        (event.type !== "message.appended" || event.data.messageSoFar.trim().length > 0) &&
        (event.type !== "message.completed" || Boolean(event.data.message?.trim())));
    const streaming = (part.state === "streaming" || retryInFlight) && !responseStarted;
    const text = retryInFlight ? eventText : eventText || part.text.trim();
    if (!text && !streaming) {
        return (_jsx(ReasoningBlock, { durationSeconds: durationSeconds, events: events, failure: step.failure, locale: locale, retryItems: retryItems, stepIndex: stepIndex, streaming: false, text: "", timing: timing, turnId: turnId }));
    }
    return (_jsx(ReasoningBlock, { durationSeconds: durationSeconds, events: events, failure: step.failure, locale: locale, retryItems: retryItems, stepIndex: stepIndex, streaming: streaming, text: text, timing: timing, turnId: turnId }));
}
function ReasoningBlock({ durationSeconds, failure, locale, retryItems, stepIndex, streaming, text, timing, turnId, }) {
    const hasText = text.trim().length > 0;
    return (_jsxs(_Fragment, { children: [retryItems.map((retry, index) => (_jsx(RetryStatus, { locale: locale, retry: retry }, `retry:${turnId ?? "unknown"}:${stepIndex}:${index}`))), failure && !retryItems.some((retry) => retry.exhausted) ? _jsx(StepFailure, { failure: failure, locale: locale }) : null, hasText || streaming ? (_jsxs(ReasoningRoot, { className: "mb-1", role: streaming ? "status" : undefined, streaming: streaming, variant: "ghost", children: [_jsx(ReasoningTrigger, { active: streaming, duration: timing.startedAt && durationSeconds > 0 ? durationSeconds : undefined, hideChevron: !hasText, label: reasoningTriggerLabel(locale, streaming, text) }), hasText ? (_jsx(ReasoningContent, { "aria-busy": streaming, children: _jsx(ReasoningText, { children: _jsx(StaticMarkdownText, { text: text }) }) })) : null] })) : null] }));
}
function eventTurnMatches(event, turnId, stepIndex) {
    if (!("data" in event) || !event.data || typeof event.data !== "object")
        return false;
    const data = event.data;
    return (turnId === undefined || data.turnId === turnId) && data.stepIndex === stepIndex;
}
function isReasoningRetryInFlight(events, turnId, stepIndex) {
    if (!turnId || stepIndex === undefined)
        return false;
    let latestStart = -1;
    let latestReasoning = -1;
    let latestCompletion = -1;
    let latestFailure = -1;
    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (!("data" in event))
            continue;
        const data = event.data;
        if (data.turnId !== turnId || data.stepIndex !== stepIndex)
            continue;
        if (event.type === "step.started")
            latestStart = index;
        else if (event.type === "reasoning.appended" || event.type === "reasoning.completed") {
            latestReasoning = index;
            if (event.type === "reasoning.completed")
                latestCompletion = index;
        }
        else if (event.type === "step.failed")
            latestFailure = index;
    }
    return latestStart > latestReasoning && (latestCompletion >= 0 || latestFailure >= 0) &&
        latestStart > Math.max(latestCompletion, latestFailure);
}
function reasoningTriggerLabel(locale, streaming, text) {
    if (streaming)
        return reasoningSummary(text) ?? localize(locale, "Thinking", "正在思考");
    return localize(locale, "Reasoning complete", "思考完成");
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
function activeReasoningStep(events, turnId) {
    const started = [...events].reverse().find((event) => event.type === "step.started" && (turnId === undefined || event.data.turnId === turnId));
    return started?.type === "step.started" ? started.data.stepIndex : 0;
}
function reasoningTiming(events, turnId, stepIndex) {
    const matching = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => (event.type === "reasoning.appended" || event.type === "reasoning.completed") &&
        (turnId === undefined || event.data.turnId === turnId) &&
        (stepIndex === undefined || ("stepIndex" in event.data && event.data.stepIndex === stepIndex)));
    const latestReasoning = matching.at(-1);
    if (!latestReasoning)
        return {};
    const attemptStartIndex = events.findLastIndex((event, index) => index <= latestReasoning.index &&
        event.type === "step.started" &&
        (turnId === undefined || event.data.turnId === turnId) &&
        (stepIndex === undefined || event.data.stepIndex === stepIndex));
    const attemptReasoning = matching.filter(({ index }) => index >= attemptStartIndex);
    const firstAppend = attemptReasoning.find(({ event }) => event.type === "reasoning.appended");
    const completed = [...attemptReasoning].reverse().find(({ event }) => event.type === "reasoning.completed");
    const startedAt = eventTime(firstAppend?.event) ?? eventTime(attemptStartIndex >= 0 ? events[attemptStartIndex] : latestReasoning.event);
    const startedIndex = firstAppend?.index ?? attemptStartIndex;
    const boundary = startedIndex >= 0
        ? events.slice(startedIndex + 1).find((event) => (event.type === "reasoning.completed" || event.type === "actions.requested" || event.type === "message.completed") &&
            (turnId === undefined || event.data.turnId === turnId) &&
            (stepIndex === undefined || ("stepIndex" in event.data && event.data.stepIndex === stepIndex)))
        : undefined;
    return {
        ...(startedAt ? { startedAt } : {}),
        ...(completed ? { endedAt: eventTime(completed.event) } : boundary ? { endedAt: eventTime(boundary) } : {}),
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
    if (direct.startsWith("/") && !direct.startsWith("//"))
        return direct;
    try {
        const parsed = new URL(direct);
        if (parsed.protocol === "http:" || parsed.protocol === "https:")
            return parsed.toString();
    }
    catch {
    }
    const match = direct.match(/https?:\/\/[^\s"'<>]+/u);
    return match?.[0];
}
function publishedDeliverable(value, kind, url) {
    const record = asRecord(value);
    const id = firstString(record, kind === "artifact" ? ["artifactId", "id"] : ["previewId", "id"]);
    if (!record || !id || !url)
        return undefined;
    const title = firstString(record, kind === "artifact" ? ["filename", "name"] : ["title", "entrypoint"])
        ?? (kind === "artifact" ? "Artifact" : "Website preview");
    const createdAt = firstString(record, ["createdAt"]);
    const expiresAt = firstString(record, ["expiresAt"]);
    const fileCount = firstNumber(record, ["fileCount"]);
    const mediaType = firstString(record, ["mediaType"]);
    return {
        createdAt: createdAt ?? new Date().toISOString(),
        ...(expiresAt ? { expiresAt } : {}),
        ...(fileCount !== undefined ? { fileCount } : {}),
        id,
        kind,
        ...(mediaType ? { mediaType } : {}),
        sizeBytes: firstNumber(record, ["bytes", "sizeBytes"]) ?? 0,
        title,
        url,
    };
}
function deliverablesForTurn(events, turnId) {
    if (!turnId)
        return [];
    const deliverables = new Map();
    for (const event of events) {
        if (event.type !== "action.result" || event.data.turnId !== turnId || event.data.status !== "completed" || event.data.result.kind !== "tool-result")
            continue;
        const normalized = normalizeToolName(event.data.result.toolName);
        const kind = ["publish_preview", "website_preview"].includes(normalized)
            ? "website-preview"
            : ["publish_artifact", "artifact_publish"].includes(normalized)
                ? "artifact"
                : undefined;
        if (!kind)
            continue;
        const deliverable = publishedDeliverable(event.data.result.output, kind, firstUrl(event.data.result.output));
        if (deliverable)
            deliverables.set(`${deliverable.kind}:${deliverable.id}`, deliverable);
    }
    return [...deliverables.values()];
}
function PublishedDeliverableCard({ deliverable, locale }) {
    const openDeliverable = useContext(DeliverableOpenContext);
    return _jsx(ArtifactCard, { icon: deliverable.kind === "website-preview" ? _jsx(MonitorIcon, { className: "size-4" }) : undefined, meta: deliverable.kind === "website-preview"
            ? [localize(locale, "Website preview", "网站预览"), deliverable.fileCount ? `${deliverable.fileCount} ${localize(locale, "files", "个文件")}` : undefined, formatBytes(deliverable.sizeBytes)].filter(Boolean).join(" · ")
            : [deliverable.mediaType, formatBytes(deliverable.sizeBytes)].filter(Boolean).join(" · ") || localize(locale, "Session artifact", "会话产物"), onClick: () => openDeliverable ? openDeliverable(deliverable) : window.open(deliverable.url, "_blank", "noopener,noreferrer"), title: deliverable.title });
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
    return patchFromValue(part.input) ??
        patchFromValue(part.output) ??
        partialPatchFromText(part.inputText);
}
function patchFromValue(value) {
    if (typeof value === "string")
        return displayablePatch(value);
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    const patch = record.patch ?? record.diff;
    return typeof patch === "string" ? displayablePatch(patch) : undefined;
}
function displayablePatch(value) {
    if (looksLikeUnifiedDiff(value))
        return value;
    return codexPatchToUnifiedDiff(value);
}
function partialPatchFromText(value) {
    if (!value)
        return undefined;
    const direct = displayablePatch(value);
    if (direct)
        return direct;
    try {
        const parsed = JSON.parse(value);
        const complete = patchFromValue(parsed);
        if (complete)
            return complete;
    }
    catch {
    }
    const match = value.match(/"(?:patch|diff)"\s*:\s*"((?:\\.|[^"\\])*)/u);
    if (!match?.[1])
        return undefined;
    let patchText;
    try {
        patchText = JSON.parse(`"${match[1]}"`);
    }
    catch {
        return undefined;
    }
    return codexPatchToUnifiedDiff(patchText, true) ?? displayablePatch(patchText);
}
function looksLikeUnifiedDiff(value) {
    return /^(?:diff --git |--- )/m.test(value) && /^\+\+\+ /m.test(value) && /^@@ /m.test(value);
}
function codexPatchToUnifiedDiff(value, allowPartial = false) {
    const lines = value.replace(/\r\n?/gu, "\n").split("\n");
    const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch");
    const end = lines.findIndex((line, index) => index > begin && line.trim() === "*** End Patch");
    if (begin < 0 || (!allowPartial && end < 0))
        return undefined;
    const stop = end >= 0 ? end : lines.length;
    const sections = [];
    for (let index = begin + 1; index < stop;) {
        if (!lines[index]?.trim()) {
            index += 1;
            continue;
        }
        const directive = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/u.exec(lines[index]);
        if (!directive) {
            if (allowPartial && sections.length > 0)
                break;
            return undefined;
        }
        const operation = directive[1];
        const sourcePath = directive[2];
        index += 1;
        let destinationPath = sourcePath;
        if (operation === "Update") {
            const move = /^\*\*\* Move to:\s*(.+?)\s*$/u.exec(lines[index] ?? "");
            if (move) {
                destinationPath = move[1];
                index += 1;
            }
        }
        const body = [];
        while (index < stop && !lines[index].startsWith("*** ")) {
            body.push(lines[index]);
            index += 1;
        }
        const displaySourcePath = operation === "Add" ? destinationPath : sourcePath;
        const displayDestinationPath = operation === "Delete" ? sourcePath : destinationPath;
        const oldName = displaySourcePath;
        const newName = displayDestinationPath;
        const hunks = operation === "Add"
            ? addFileHunk(body)
            : operation === "Delete"
                ? []
                : normalizeCodexHunks(body);
        sections.push([
            `diff --git a/${sourcePath} b/${destinationPath}`,
            `--- ${oldName}`,
            `+++ ${newName}`,
            ...hunks,
        ].join("\n"));
    }
    return sections.length > 0 ? sections.join("\n") : undefined;
}
function addFileHunk(lines) {
    const additions = lines.filter((line) => line.startsWith("+"));
    return additions.length > 0
        ? [`@@ -0,0 +1,${additions.length} @@`, ...additions]
        : [];
}
function normalizeCodexHunks(lines) {
    if (lines.length === 0)
        return [];
    const hunkStarts = lines.flatMap((line, index) => line.startsWith("@@") ? [index] : []);
    if (hunkStarts.length === 0)
        return normalizedHunk(lines, 1, 1);
    const normalized = [];
    let fallbackOldStart = 1;
    let fallbackNewStart = 1;
    for (let hunkIndex = 0; hunkIndex < hunkStarts.length; hunkIndex += 1) {
        const start = hunkStarts[hunkIndex];
        const end = hunkStarts[hunkIndex + 1] ?? lines.length;
        const header = lines[start];
        const body = lines.slice(start + 1, end);
        if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(header)) {
            normalized.push(header, ...body);
        }
        else {
            normalized.push(...normalizedHunk(body, fallbackOldStart, fallbackNewStart, header.slice(2).trim()));
        }
        fallbackOldStart += body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
        fallbackNewStart += body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
    }
    return normalized;
}
function normalizedHunk(lines, oldStart, newStart, suffix = "") {
    const body = lines.filter((line) => /^(?: |\+|-|\\)/u.test(line));
    const oldCount = body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
    const newCount = body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
    const trailer = suffix ? ` ${suffix}` : "";
    return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${trailer}`, ...body];
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
function ExecutionGroup({ children, collapseWhenSettled, fallbackStartedAt, locale, showTrigger = true, task, }) {
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
        }, open: open, ref: executionRef, children: [showTrigger ? (_jsx(CollapsibleTrigger, { asChild: true, children: _jsxs("button", { className: "flex w-full items-center gap-1.5 border-b border-border/60 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground", type: "button", children: [_jsx("span", { children: executionLabel(locale, task) }), startedAt && elapsedSeconds > 0 ? _jsx("span", { className: "tabular-nums", children: formatDuration(elapsedSeconds) }) : null, _jsx(ChevronDownIcon, { className: "size-3.5 transition-transform group-data-[state=open]/execution:rotate-180" })] }) })) : null, _jsx(CollapsibleContent, { className: "overflow-hidden data-[state=closed]:animate-out data-[state=open]:animate-in", children: _jsx("div", { className: "mt-2 space-y-3 pt-2", children: children }) })] }));
}
function hasLaterFinalDelivery(events, turnId) {
    if (!turnId)
        return false;
    const turnEnd = events.findIndex((event) => (event.type === "turn.completed" || event.type === "turn.cancelled" || event.type === "turn.failed") &&
        event.data.turnId === turnId);
    if (turnEnd < 0)
        return false;
    const hasFinalMessage = (event) => event.type === "message.completed" &&
        event.data.finishReason === "stop" &&
        event.data.turnId === turnId &&
        typeof event.data.message === "string" &&
        event.data.message.trim().length > 0;
    return events.some(hasFinalMessage) || events.slice(turnEnd + 1).some(hasFinalMessage);
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
        return localize(locale, "Worked for", "已处理完成");
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
            ? localize(locale, `Approve tool call: ${approvalToolName(part.toolName, locale)}`, `批准工具调用：${approvalToolName(part.toolName, locale)}`)
            : localize(locale, "Session limit reached", "已达到会话限制");
    const choices = inputRequest.options ?? [];
    const settled = Boolean(inputResponse) || closed;
    const [open, setOpen] = useState(!settled);
    useEffect(() => {
        if (settled)
            setOpen(false);
    }, [settled]);
    if (isApproval && !settled)
        return null;
    const status = closed
        ? localize(locale, "Closed", "已关闭")
        : inputResponse
            ? localize(locale, "Responded", "已回复")
            : isQuestion
                ? localize(locale, "Waiting for confirmation", "等待确认")
                : undefined;
    return (_jsx(Collapsible, { className: cn("my-1 max-w-full transition-[width] duration-200", open ? "w-full max-w-xl" : "w-fit"), onOpenChange: setOpen, open: open, children: _jsx("section", { className: "rounded-xl border border-border/70 bg-background px-3.5 py-3", "data-input-request-kind": inputRequest.kind, children: _jsxs("div", { className: "flex items-start gap-2.5", children: [_jsx(Icon, { className: "mt-0.5 size-4 shrink-0 text-muted-foreground" }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(CollapsibleTrigger, { asChild: true, children: _jsxs("button", { className: "group/request flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium text-muted-foreground hover:text-foreground", type: "button", children: [_jsx("span", { className: "truncate", children: eyebrow }), status ? _jsxs("span", { className: "shrink-0 font-normal text-muted-foreground/80", children: ["\u00B7 ", status] }) : null, _jsx(ChevronDownIcon, { className: "size-3.5 shrink-0 transition-transform group-data-[state=open]/request:rotate-180" })] }) }), !inputResponse && !closed && isQuestion ? _jsx(Button, { className: "h-6 shrink-0 px-2 text-xs", onClick: () => onClose(inputRequest.requestId), size: "sm", type: "button", variant: "ghost", children: localize(locale, "Close", "关闭") }) : null] }), _jsxs(CollapsibleContent, { className: "overflow-hidden", children: [_jsx("p", { className: "mt-1 text-sm leading-6 text-foreground", children: inputRequest.prompt }), isApproval ? _jsx(ApprovalActionPreview, { events: events, locale: locale, part: part }) : null, settled ? (_jsx(InputRequestReview, { closed: closed, inputResponse: inputResponse, locale: locale, options: choices, selectedOptionId: selectedOption?.id })) : isApproval ? (_jsx("p", { className: "mt-3 text-xs leading-5 text-muted-foreground", children: localize(locale, "Respond using the approval controls below.", "请使用下方批准控件继续。") })) : (_jsx(QuestionnaireResponseForm, { acceptsFreeform: acceptsFreeform, canRespond: canRespond, locale: locale, onInputResponses: onInputResponses, options: choices, prompt: inputRequest.prompt, requestId: inputRequest.requestId }))] })] })] }) }) }));
}
function approvalToolName(toolName, locale) {
    const normalized = normalizeToolName(toolName);
    if (["bash", "shell", "terminal", "exec_command"].includes(normalized))
        return localize(locale, "Terminal command", "终端命令");
    if (["apply_patch", "patch_file", "write_file", "edit_file"].includes(normalized))
        return localize(locale, "File change", "文件变更");
    if (["web_fetch", "fetch_url", "web_search", "search_web"].includes(normalized))
        return localize(locale, "Network access", "网络访问");
    return toolName;
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
    if (isRetryableTurnFailure(failure)) {
        return (_jsx(RetryStatus, { locale: locale, retry: {
                attempt: 1,
                error: failure,
                exhausted: true,
                maximum: 3,
            } }));
    }
    return (_jsxs(Alert, { className: "mt-2 py-2.5", "data-agent-failure-alert": true, variant: "destructive", children: [_jsx(XCircleIcon, {}), _jsx(AlertTitle, { children: failureTitle(locale, failure) }), _jsxs(AlertDescription, { children: [_jsx("p", { children: failureSummary(locale, failure) }), failure.code ? _jsx("code", { className: "break-all text-xs", children: failure.code }) : null] })] }));
}
function isRetryableTurnFailure(failure) {
    return isRetryableAgentFailure(failure);
}
function failureTitle(locale, failure) {
    switch (classifyAgentFailure(failure)) {
        case "network": return localize(locale, "Network error", "网络错误");
        case "timeout": return localize(locale, "Request timed out", "请求超时");
        case "provider": return localize(locale, "Model request failed", "模型请求失败");
        default: return localize(locale, "This turn failed", "本轮执行失败");
    }
}
function failureSummary(locale, failure) {
    const statusCode = failure.statusCode;
    const status = statusCode === undefined ? "" : ` (HTTP ${statusCode})`;
    switch (classifyAgentFailure(failure)) {
        case "network": return localize(locale, `The connection failed${status}.`, `连接失败${status}。`);
        case "timeout": return localize(locale, `The request timed out${status}.`, `请求超时${status}。`);
        case "provider": return localize(locale, `The model request could not be completed${status}.`, `模型请求未完成${status}。`);
        default: return localize(locale, `The request could not be completed${status}.`, `请求未完成${status}。`);
    }
}
function retryTitle(locale, failure) {
    if (!failure)
        return localize(locale, "Retrying", "正在重试");
    switch (classifyAgentFailure(failure)) {
        case "network": return localize(locale, "Reconnecting", "正在重新连接");
        case "timeout": return localize(locale, "Retrying after timeout", "超时后正在重试");
        case "provider": return localize(locale, "Retrying model request", "正在重试模型请求");
        default: return localize(locale, "Retrying", "正在重试");
    }
}
function localize(locale, english, chinese) {
    return locale === "zh-CN" ? chinese : english;
}
function toolStatusLabel(locale, part) {
    if (isCancellationPendingToolPart(part))
        return localize(locale, "Stopping", "正在停止");
    if (isInterruptedToolPart(part))
        return localize(locale, "Stopped", "已中断");
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
        case "reasoning":
            return `reasoning:${part.stepIndex ?? "pending"}`;
        case "dynamic-tool":
            return part.toolCallId;
        default:
            return `${part.type}:${index}`;
    }
}
//# sourceMappingURL=agent-message.js.map