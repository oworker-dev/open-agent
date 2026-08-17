"use client";

import type {
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
  EveMessagePart,
} from "eve/react";
import {
  BracesIcon,
  CheckIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CircleStopIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileIcon,
  ImageIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  NetworkIcon,
  SearchIcon,
  TerminalIcon,
  FileSearchIcon,
  ListChecksIcon,
  MessageCircleQuestionIcon,
  ShieldCheckIcon,
  WifiIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { InputResponse, MessageStreamEvent } from "eve/client";
import { useScrollLock } from "@assistant-ui/react";
import { StaticMarkdownText } from "../assistant-ui/markdown-text.js";
import { copyText } from "../assistant-ui/copy-text.js";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "../assistant-ui/reasoning.js";
import {
  ToolFallbackContent,
  ToolFallbackRoot,
} from "../assistant-ui/tool-fallback.js";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "../assistant-ui/tool-group.js";
import { DiffViewer } from "../assistant-ui/diff-viewer.js";
import { Button } from "../ui/button.js";
import { Attachment, AttachmentAction, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "../ui/attachment.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import {
  Questionnaire,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireItem,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "../ui/questionnaire.js";
import { cn } from "../utils.js";
import type { AgentLocale } from "./i18n.js";
import {
  failureForTurn,
  presentAgentTurn,
  presentAgentStep,
  presentSubagentCall,
  type AgentTurnPresentation,
  type AgentTurnStatus,
} from "./turn-presentation.js";

function Message({ children, from, ...props }: { readonly children: React.ReactNode; readonly from: string; readonly [key: string]: unknown }) {
  return <article className={cn("group flex w-full flex-col", from === "user" ? "items-end" : "items-start")} {...props}>{children}</article>;
}

function MessageContent({ children, className }: { readonly children: React.ReactNode; readonly className?: string }) {
  return <div className={cn("min-w-0 max-w-full", className)}>{children}</div>;
}

function MessageActions({ children, className }: { readonly children: React.ReactNode; readonly className?: string }) {
  return <div className={cn("mt-1 flex gap-1", className)}>{children}</div>;
}

function MessageAction({ children, label, onClick, tooltip }: { readonly children: React.ReactNode; readonly label: string; readonly onClick: () => void; readonly tooltip?: string }) {
  return <Button aria-label={label} className="size-7" onClick={onClick} size="icon-sm" title={tooltip} variant="ghost">{children}</Button>;
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return String(value); }
}

export type AgentInputResponse = {
  readonly optionId?: string;
  readonly requestId: string;
  readonly text?: string;
};

type EveFilePart = Extract<EveMessagePart, { type: "file" }>;
const EMPTY_CLOSED_INPUT_REQUEST_IDS: ReadonlySet<string> = new Set();

export function AgentMessage({
  assetUrl,
  canRespond,
  closedInputRequestIds = EMPTY_CLOSED_INPUT_REQUEST_IDS,
  events,
  fallbackStartedAt,
  isStreaming,
  locale,
  message,
  onOpenSubagent,
  onInputResponses,
  onCloseInputRequest = () => undefined,
  showCopyAction = true,
}: {
  readonly assetUrl?: (assetId: string) => string;
  readonly canRespond: boolean;
  readonly closedInputRequestIds?: ReadonlySet<string>;
  readonly events: readonly MessageStreamEvent[];
  readonly fallbackStartedAt?: number;
  readonly isStreaming: boolean;
  readonly locale: AgentLocale;
  readonly message: EveMessage;
  readonly onOpenSubagent?: (sessionId: string) => void;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly onCloseInputRequest?: (requestId: string) => void;
  readonly showCopyAction?: boolean;
}) {
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

  return (
    <Message
      data-optimistic={message.metadata?.optimistic ? "true" : undefined}
      from={message.role}
    >
      <MessageContent className={message.role === "assistant" ? "w-full" : undefined}>
        {message.role === "assistant" && isStreaming && !hasVisiblePart ? (
          <ReasoningRoot className="mb-1" role="status" streaming variant="ghost">
            <ReasoningTrigger active label={localize(locale, "Thinking", "正在思考")} />
          </ReasoningRoot>
        ) : null}
        {task ? (
          <>
            <ExecutionGroup
              collapseWhenSettled={task.status === "completed" && Boolean(
                task.finalPart?.text.trim() ||
                hasLaterFinalDelivery(events, message.metadata?.turnId),
              )}
              fallbackStartedAt={fallbackStartedAt}
              locale={locale}
              task={task}
            >
              <ProcessParts
                assetUrl={assetUrl}
                canRespond={canRespond}
                closedInputRequestIds={closedInputRequestIds}
                events={events}
                inActiveExecution={task.status === "running" || task.status === "waiting"}
                locale={locale}
                onInputResponses={onInputResponses}
                onCloseInputRequest={onCloseInputRequest}
                onOpenSubagent={onOpenSubagent}
                parts={task.processParts}
                turnId={message.metadata?.turnId}
              />
              {task.proxiedInputParts.map((part) => (
                <div className="space-y-2" key={`proxied-input:${part.toolCallId}`}>
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                    {localize(locale, "A delegated task needs your approval", "子代理任务需要你的批准")}
                  </p>
                  <AgentMessagePart
                    assetUrl={assetUrl}
                    canRespond={canRespond}
                    closedInputRequestIds={closedInputRequestIds}
                    events={events}
                    inActiveExecution
                    locale={locale}
                    onInputResponses={onInputResponses}
                    onCloseInputRequest={onCloseInputRequest}
                    onOpenSubagent={onOpenSubagent}
                    part={part}
                    turnId={message.metadata?.turnId}
                  />
                </div>
              ))}
            </ExecutionGroup>
            {task.finalPart ? (
              <div className="pt-3">
                <AgentMessagePart
                  assetUrl={assetUrl}
                  canRespond={canRespond}
                  events={events}
                  inActiveExecution={false}
                  locale={locale}
                  onInputResponses={onInputResponses}
                  onCloseInputRequest={onCloseInputRequest}
                  onOpenSubagent={onOpenSubagent}
                  part={task.finalPart}
                  turnId={message.metadata?.turnId}
                />
              </div>
            ) : null}
          </>
        ) : displayMessage.parts.map((part, index) => (
          <AgentMessagePart
            assetUrl={assetUrl}
            canRespond={canRespond}
            events={events}
            inActiveExecution={false}
            key={partKey(part, index)}
            locale={locale}
            onInputResponses={onInputResponses}
            onCloseInputRequest={onCloseInputRequest}
            onOpenSubagent={onOpenSubagent}
            part={part}
            turnId={message.metadata?.turnId}
          />
        ))}
        {failure ? <TurnFailure failure={failure} locale={locale} /> : null}
      </MessageContent>
      {showCopyAction && message.role === "assistant" && responseText && !isStreaming ? (
        <CopyResponseAction locale={locale} text={responseText} />
      ) : null}
    </Message>
  );
}

function AgentMessagePart({
  assetUrl,
  canRespond,
  closedInputRequestIds = EMPTY_CLOSED_INPUT_REQUEST_IDS,
  events,
  inActiveExecution,
  locale,
  onOpenSubagent,
  onInputResponses,
  onCloseInputRequest = () => undefined,
  part,
  turnId,
}: {
  readonly assetUrl?: (assetId: string) => string;
  readonly canRespond: boolean;
  readonly closedInputRequestIds?: ReadonlySet<string>;
  readonly events: readonly MessageStreamEvent[];
  readonly inActiveExecution: boolean;
  readonly locale: AgentLocale;
  readonly onOpenSubagent?: (sessionId: string) => void;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly onCloseInputRequest?: (requestId: string) => void;
  readonly part: EveMessagePart;
  readonly turnId?: string;
}) {
  switch (part.type) {
    case "step-start":
      return null;
    case "text":
      if (!part.text.trim()) return null;
      return (
        <div className="relative break-words">
          <StaticMarkdownText text={part.text} />
        </div>
      );
    case "reasoning": {
      return <ReasoningPart events={events} locale={locale} part={part} turnId={turnId} />;
    }
    case "file":
      return <AttachmentPart locale={locale} part={part} />;
    case "authorization":
      return <AuthorizationPrompt locale={locale} part={part} />;
    case "dynamic-tool": {
      return <ToolPart assetUrl={assetUrl} canRespond={canRespond} closedInputRequestIds={closedInputRequestIds} events={events} inActiveExecution={inActiveExecution} locale={locale} onCloseInputRequest={onCloseInputRequest} onInputResponses={onInputResponses} onOpenSubagent={onOpenSubagent} part={part} />;
    }
  }
}

function ProcessParts({
  assetUrl,
  canRespond,
  closedInputRequestIds = EMPTY_CLOSED_INPUT_REQUEST_IDS,
  events,
  inActiveExecution,
  locale,
  onInputResponses,
  onCloseInputRequest = () => undefined,
  onOpenSubagent,
  parts,
  turnId,
}: {
  readonly assetUrl?: (assetId: string) => string;
  readonly canRespond: boolean;
  readonly closedInputRequestIds?: ReadonlySet<string>;
  readonly events: readonly MessageStreamEvent[];
  readonly inActiveExecution: boolean;
  readonly locale: AgentLocale;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly onCloseInputRequest?: (requestId: string) => void;
  readonly onOpenSubagent?: (sessionId: string) => void;
  readonly parts: readonly EveMessagePart[];
  readonly turnId?: string;
}) {
  const rendered: React.ReactNode[] = [];
  let visualStepIndex = -1;

  for (let index = 0; index < parts.length;) {
    const part = parts[index]!;
    if (part.type === "step-start") {
      visualStepIndex += 1;
      const nextStep = parts.findIndex((candidate, candidateIndex) =>
        candidateIndex > index && candidate.type === "step-start"
      );
      const stepEnd = nextStep < 0 ? parts.length : nextStep;
      const hasReasoning = parts.slice(index + 1, stepEnd).some((candidate) =>
        candidate.type === "reasoning" && candidate.stepIndex === visualStepIndex
      );
      if (!hasReasoning) {
        rendered.push(
          <StepActivity
            events={events}
            key={`step-activity:${turnId}:${visualStepIndex}`}
            locale={locale}
            stepIndex={visualStepIndex}
            turnId={turnId}
          />,
        );
      }
      index += 1;
      continue;
    }
    if (part.type !== "dynamic-tool") {
      rendered.push(
        <AgentMessagePart
          assetUrl={assetUrl}
          canRespond={canRespond}
          events={events}
          inActiveExecution={inActiveExecution}
          key={partKey(part, index)}
          locale={locale}
          onInputResponses={onInputResponses}
          onCloseInputRequest={onCloseInputRequest}
          closedInputRequestIds={closedInputRequestIds}
          onOpenSubagent={onOpenSubagent}
          part={part}
          turnId={turnId}
        />,
      );
      index += 1;
      continue;
    }

    const toolParts: EveDynamicToolPart[] = [];
    let cursor = index;
    while (cursor < parts.length && parts[cursor]?.type === "dynamic-tool") {
      toolParts.push(parts[cursor] as EveDynamicToolPart);
      cursor += 1;
    }
    if (toolParts.every((toolPart) => Boolean(toolPart.toolMetadata?.eve?.inputRequest))) {
      rendered.push(
        <div className="space-y-2" key={`inputs:${toolParts[0]?.toolCallId}`}>
          {toolParts.map((toolPart) => (
            <AgentMessagePart
              assetUrl={assetUrl}
              canRespond={canRespond}
              events={events}
              inActiveExecution={inActiveExecution}
              key={toolPart.toolCallId}
              locale={locale}
              onInputResponses={onInputResponses}
              onCloseInputRequest={onCloseInputRequest}
              closedInputRequestIds={closedInputRequestIds}
              onOpenSubagent={onOpenSubagent}
              part={toolPart}
              turnId={turnId}
            />
          ))}
        </div>,
      );
      index = cursor;
      continue;
    }
    const active = toolParts.some((toolPart) => !isToolTerminal(toolPart));
    const needsInput = toolParts.some((toolPart) =>
      toolPart.state === "approval-requested" ||
      Boolean(toolPart.toolMetadata?.eve?.inputRequest && !toolPart.toolMetadata.eve.inputResponse)
    );
    if (toolParts.length === 1) {
      rendered.push(
        <AgentMessagePart
          assetUrl={assetUrl}
          canRespond={canRespond}
          closedInputRequestIds={closedInputRequestIds}
          events={events}
          inActiveExecution={inActiveExecution}
          key={toolParts[0]!.toolCallId}
          locale={locale}
          onCloseInputRequest={onCloseInputRequest}
          onInputResponses={onInputResponses}
          onOpenSubagent={onOpenSubagent}
          part={toolParts[0]!}
          turnId={turnId}
        />,
      );
    } else {
      rendered.push(<ProcessToolGroup
        active={active}
        assetUrl={assetUrl}
        canRespond={canRespond}
        closedInputRequestIds={closedInputRequestIds}
        events={events}
        inActiveExecution={inActiveExecution}
        key={`tools:${toolParts[0]?.toolCallId}`}
        locale={locale}
        needsInput={needsInput}
        onCloseInputRequest={onCloseInputRequest}
        onInputResponses={onInputResponses}
        onOpenSubagent={onOpenSubagent}
        toolParts={toolParts}
        turnId={turnId}
      />);
    }
    index = cursor;
  }

  return <>{rendered}</>;
}

function ProcessToolGroup({
  active,
  assetUrl,
  canRespond,
  closedInputRequestIds,
  events,
  inActiveExecution,
  locale,
  needsInput,
  onCloseInputRequest,
  onInputResponses,
  onOpenSubagent,
  toolParts,
  turnId,
}: {
  readonly active: boolean;
  readonly assetUrl?: (assetId: string) => string;
  readonly canRespond: boolean;
  readonly closedInputRequestIds: ReadonlySet<string>;
  readonly events: readonly MessageStreamEvent[];
  readonly inActiveExecution: boolean;
  readonly locale: AgentLocale;
  readonly needsInput: boolean;
  readonly onCloseInputRequest: (requestId: string) => void;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly onOpenSubagent?: (sessionId: string) => void;
  readonly toolParts: readonly EveDynamicToolPart[];
  readonly turnId?: string;
}) {
  const [open, setOpen] = useState(active || inActiveExecution || needsInput);
  useEffect(() => {
    if (active || inActiveExecution || needsInput) setOpen(true);
  }, [active, inActiveExecution, needsInput]);
  return (
    <ToolGroupRoot onOpenChange={setOpen} open={open} variant="ghost">
      <ToolGroupTrigger
        active={active}
        count={toolParts.length}
        label={localize(
          locale,
          active
            ? `Running ${toolParts.length} ${toolParts.length === 1 ? "tool" : "tools"}`
            : `Ran ${toolParts.length} ${toolParts.length === 1 ? "tool" : "tools"}`,
          active ? `正在运行 ${toolParts.length} 个工具` : `已运行 ${toolParts.length} 个工具`,
        )}
      />
      <ToolGroupContent>
        {toolParts.map((toolPart) => (
          <AgentMessagePart
            assetUrl={assetUrl}
            canRespond={canRespond}
            closedInputRequestIds={closedInputRequestIds}
            events={events}
            inActiveExecution={inActiveExecution}
            key={toolPart.toolCallId}
            locale={locale}
            onCloseInputRequest={onCloseInputRequest}
            onInputResponses={onInputResponses}
            onOpenSubagent={onOpenSubagent}
            part={toolPart}
            turnId={turnId}
          />
        ))}
      </ToolGroupContent>
    </ToolGroupRoot>
  );
}

function ToolPart({
  assetUrl,
  canRespond,
  closedInputRequestIds = EMPTY_CLOSED_INPUT_REQUEST_IDS,
  events,
  locale,
  onInputResponses,
  onCloseInputRequest = () => undefined,
  onOpenSubagent,
  part,
}: {
  readonly assetUrl?: (assetId: string) => string;
  readonly canRespond: boolean;
  readonly closedInputRequestIds?: ReadonlySet<string>;
  readonly events: readonly MessageStreamEvent[];
  readonly inActiveExecution: boolean;
  readonly locale: AgentLocale;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly onCloseInputRequest?: (requestId: string) => void;
  readonly onOpenSubagent?: (sessionId: string) => void;
  readonly part: EveDynamicToolPart;
}) {
  const inputRequest = part.toolMetadata?.eve?.inputRequest;
  if (inputRequest) {
    return <InputRequestCard canRespond={canRespond} closed={closedInputRequestIds.has(inputRequest.requestId)} events={events} locale={locale} onClose={onCloseInputRequest} onInputResponses={onInputResponses} part={part} />;
  }
  const running = !isToolTerminal(part);
  const defaultOpen = isTodoTool(part) || part.state === "approval-requested";
  const Icon = toolIcon(part);
  const statusLabel = isFileMutationTool(part) ? undefined : toolStatusLabel(locale, part);

  return (
    <ToolFallbackRoot className="my-0" defaultOpen={defaultOpen}>
      <CollapsibleTrigger
        className="group/trigger flex w-fit max-w-full origin-left items-center gap-2 py-1.5 text-left text-sm text-muted-foreground transition-[color,scale] hover:text-foreground active:scale-[0.98]"
      >
        {running ? (
          <LoaderCircleIcon className="size-4 shrink-0 animate-spin [animation-duration:0.65s]" />
        ) : part.state === "output-error" || part.state === "output-denied" ? (
          <XCircleIcon className="size-4 shrink-0 text-destructive" />
        ) : (
          <Icon className="size-4 shrink-0" />
        )}
        <span className="truncate">{toolTitle(locale, part, events)}</span>
        {statusLabel ? (
          <span className={cn("shrink-0 text-xs", part.state === "output-error" && "text-destructive")}>
            {statusLabel}
          </span>
        ) : null}
        <ChevronDownIcon className="size-3.5 shrink-0 -rotate-90 transition-transform group-data-[state=open]/trigger:rotate-0" />
      </CollapsibleTrigger>
      <ToolFallbackContent>
        <KnownToolContent assetUrl={assetUrl} events={events} locale={locale} onOpenSubagent={onOpenSubagent} part={part} />
        {part.errorText ? <p className="whitespace-pre-wrap text-xs text-destructive">{part.errorText}</p> : null}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
}

function KnownToolContent({
  assetUrl,
  events,
  locale,
  onOpenSubagent,
  part,
}: {
  readonly assetUrl?: (assetId: string) => string;
  readonly events: readonly MessageStreamEvent[];
  readonly locale: AgentLocale;
  readonly onOpenSubagent?: (sessionId: string) => void;
  readonly part: EveDynamicToolPart;
}) {
  const normalized = normalizeToolName(part.toolName);
  const input = asRecord(part.input);
  const output = "output" in part ? part.output : undefined;
  const patch = toolPatch(part);
  const fileChange = toolFileChange(part, events);

  if (part.toolMetadata?.eve?.kind === "subagent-call") {
    return <SubagentProgress events={events} locale={locale} onOpenSubagent={onOpenSubagent} part={part} />;
  }

  if (["apply_patch", "patch_file", "write_file", "edit_file"].includes(normalized)) {
    if (patch) {
      return <div data-tool-view="diff"><DiffViewer contentClassName="max-h-72 overflow-auto" patch={patch} showIcon size="sm" variant="muted" /></div>;
    }
    if (fileChange) {
      return (
        <div data-tool-view="diff">
          <DiffViewer
            contentClassName="max-h-72 overflow-auto"
            newFile={{ content: fileChange.newContent, name: fileChange.path }}
            oldFile={{ content: fileChange.oldContent, name: fileChange.path }}
            showIcon
            size="sm"
            variant="muted"
          />
        </div>
      );
    }
    return <p className="text-xs text-muted-foreground">{localize(locale, "Receiving file changes...", "正在接收文件变更…")}</p>;
  }

  if (["bash", "shell", "terminal", "exec_command"].includes(normalized)) {
    const command = firstString(input, ["command", "cmd"]);
    const result = shellOutput(output);
    return <ShellToolContent command={command} locale={locale} output={output} result={result} running={!isToolTerminal(part)} />;
  }

  if (["read_file", "read", "view_file"].includes(normalized)) {
    const path = firstString(input, ["path", "file", "filename"]);
    const result = readableOutput(output);
    return (
      <div className="overflow-hidden rounded-md bg-muted/50 text-xs" data-tool-view="file-read">
        {path ? <p className="truncate border-b border-border/40 px-3 py-2 font-mono text-muted-foreground">{path}</p> : null}
        {result ? <pre className="max-h-72 overflow-auto whitespace-pre px-3 py-2.5 font-mono text-foreground">{result}</pre> : null}
      </div>
    );
  }

  if (isViewImageTool(normalized)) {
    return <ViewImageToolContent assetUrl={assetUrl} input={input} locale={locale} output={output} running={!isToolTerminal(part)} />;
  }

  if (["todo", "todo_write", "update_plan"].includes(normalized)) {
    const items = todoItems(part.input, output);
    return (
      <ol className="space-y-1.5 text-sm" data-tool-view="tasks">
        {items.map((item, index) => (
          <li className="flex items-start gap-2" key={`${item.label}:${index}`}>
            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full border", item.done && "border-foreground bg-foreground")} />
            <span className={cn("min-w-0", item.done && "text-muted-foreground line-through")}>{item.label}</span>
          </li>
        ))}
        {items.length === 0 ? <li className="text-xs text-muted-foreground">{localize(locale, "Preparing tasks...", "正在整理任务…")}</li> : null}
      </ol>
    );
  }

  if (["glob", "find_files", "grep", "search_files", "web_search", "search_web", "search"].includes(normalized)) {
    const query = firstString(input, ["query", "pattern", "glob", "path"]);
    const result = readableOutput(output);
    return (
      <div className="overflow-hidden rounded-md bg-muted/50 text-xs" data-tool-view="search">
        {query ? <p className="border-b border-border/40 px-3 py-2 font-mono text-muted-foreground">{query}</p> : null}
        {result ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 text-foreground">{result}</pre> : null}
      </div>
    );
  }

  if (["web_fetch", "fetch_url"].includes(normalized)) {
    const record = asRecord(output);
    const contentType = firstString(record, ["contentType", "content_type"]);
    const url = firstString(record, ["url"]) ?? firstString(input, ["url"]);
    const binary = record?.binary === true;
    const content = firstString(record, ["content"]);
    return (
      <div className="overflow-hidden rounded-md bg-muted/50 text-xs" data-tool-view="web-fetch">
        {url ? <p className="truncate border-b border-border/40 px-3 py-2 text-muted-foreground">{url}</p> : null}
        {binary ? (
          <p className="px-3 py-2.5 text-muted-foreground">
            {localize(locale, "Binary response kept out of text context", "二进制响应未进入文本上下文")}
            {contentType ? ` · ${contentType}` : ""}
          </p>
        ) : content ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 text-foreground">{content}</pre>
        ) : null}
      </div>
    );
  }

  if (["publish_preview", "website_preview"].includes(normalized)) {
    const result = readableOutput(output);
    const url = firstUrl(output) ?? firstString(input, ["url"]);
    return url ? (
      <a className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4" href={url} rel="noreferrer" target="_blank">
        {url}<ExternalLinkIcon className="size-3.5" />
      </a>
    ) : result ? <p className="whitespace-pre-wrap text-xs text-muted-foreground">{result}</p> : null;
  }

  if (["import_remote_asset", "remote_asset_import"].includes(normalized)) {
    const record = asRecord(output);
    const filename = firstString(record, ["filename"]) ?? firstString(input, ["filename"]) ?? localize(locale, "Remote asset", "远程资产");
    const mediaType = firstString(record, ["mediaType", "contentType"]);
    const bytes = firstNumber(record, ["bytes", "sizeBytes"]);
    return (
      <div className="flex items-center gap-2 text-sm" data-tool-view="asset-import">
        <AttachmentMedia variant="icon"><FileIcon className="size-4" /></AttachmentMedia>
        <span className="min-w-0 truncate">{filename}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{[mediaType, bytes !== undefined ? formatBytes(bytes) : undefined].filter(Boolean).join(" · ")}</span>
      </div>
    );
  }

  if (["publish_artifact", "artifact_publish"].includes(normalized)) {
    const record = asRecord(output);
    const url = firstUrl(output);
    const filename = firstString(record, ["filename", "name"]) ?? firstString(input, ["filename", "path"]);
    return url ? (
      <a className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4" href={url} rel="noreferrer" target="_blank">
        {filename ?? localize(locale, "Open artifact", "打开产物")}<ExternalLinkIcon className="size-3.5" />
      </a>
    ) : <p className="text-xs text-muted-foreground">{filename ?? localize(locale, "Publishing artifact...", "正在发布产物…")}</p>;
  }

  if (["record_checkpoint", "checkpoint"].includes(normalized)) {
    const checkpoint = asRecord(output) ?? input;
    const summary = firstString(checkpoint, ["summary"]);
    const rows = [
      { label: localize(locale, "Completed", "已完成"), values: stringArray(checkpoint?.completed) },
      { label: localize(locale, "Next", "下一步"), values: stringArray(checkpoint?.next) },
      { label: localize(locale, "Risks", "风险"), values: stringArray(checkpoint?.risks) },
    ].filter((row) => row.values.length > 0);
    return (
      <div className="space-y-2 text-sm">
        {summary ? <p>{summary}</p> : null}
        {rows.map((row) => <div className="flex gap-2 text-xs" key={row.label}><span className="w-14 shrink-0 text-muted-foreground">{row.label}</span><span>{row.values.join(" · ")}</span></div>)}
      </div>
    );
  }

  if (part.toolMetadata?.eve?.kind === "load-skill") {
    const skill = firstString(input, ["name", "skill", "id"]) ?? readableOutput(output);
    return skill ? <p className="text-xs text-muted-foreground">{skill}</p> : null;
  }

  return (
    <div className="space-y-2 text-xs" data-tool-view="fallback">
      {part.input !== undefined ? (
        <div><p className="mb-1 text-muted-foreground">{localize(locale, "Parameters", "参数")}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2.5">{safeStringify(part.input)}</pre></div>
      ) : null}
      {output !== undefined ? (
        <div><p className="mb-1 text-muted-foreground">{localize(locale, "Result", "结果")}</p><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2.5">{safeStringify(output)}</pre></div>
      ) : null}
    </div>
  );
}

const VIEW_IMAGE_MEDIA_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);
function ViewImageToolContent({
  assetUrl,
  input,
  locale,
  output,
  running,
}: {
  readonly assetUrl?: (assetId: string) => string;
  readonly input: Record<string, unknown> | undefined;
  readonly locale: AgentLocale;
  readonly output: unknown;
  readonly running: boolean;
}) {
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
  ].filter((value): value is string => Boolean(value));
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <div data-tool-view="view-image">
      <Attachment className="max-w-[min(100%,28rem)]" size="default" state={running ? "processing" : "done"}>
        <AttachmentMedia className="size-12" variant={previewUrl ? "image" : "icon"}>
          {previewUrl ? <img alt={path} src={previewUrl} /> : <ImageIcon className="size-5" />}
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle title={path}>{path}</AttachmentTitle>
          <AttachmentDescription>
            {details.length > 0
              ? details.join(" \u00b7 ")
              : running
                ? localize(locale, "Preparing image preview...", "正在准备图片预览…")
                : localize(locale, "Image metadata unavailable", "图片元数据不可用")}
          </AttachmentDescription>
        </AttachmentContent>
        {previewUrl ? (
          <AttachmentTrigger
            aria-label={localize(locale, `Preview ${path}`, `预览 ${path}`)}
            onClick={() => setPreviewOpen(true)}
            title={localize(locale, "Preview image", "预览图片")}
          />
        ) : null}
      </Attachment>
      {previewOpen && previewUrl ? (
        <button
          aria-label={localize(locale, "Close image preview", "关闭图片预览")}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-6"
          onClick={() => setPreviewOpen(false)}
          type="button"
        >
          <img alt={path} className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-2xl" src={previewUrl} />
        </button>
      ) : null}
    </div>
  );
}

function imageDimensions(value: unknown): { readonly height: number; readonly width: number } | undefined {
  const record = asRecord(value);
  const height = positiveInteger(record?.height);
  const width = positiveInteger(record?.width);
  return height !== undefined && width !== undefined ? { height, width } : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function toolIcon(part: EveDynamicToolPart): React.ComponentType<{ className?: string }> {
  const normalized = normalizeToolName(part.toolName);
  if (isViewImageTool(normalized)) return ImageIcon;
  if (["bash", "shell", "terminal", "exec_command"].includes(normalized)) return TerminalIcon;
  if (["read_file", "read", "view_file", "glob", "find_files"].includes(normalized)) return FileSearchIcon;
  if (["grep", "search_files", "web_search", "search_web", "search"].includes(normalized)) return SearchIcon;
  if (["web_fetch", "fetch_url"].includes(normalized)) return ExternalLinkIcon;
  if (["todo", "todo_write", "update_plan"].includes(normalized)) return ListChecksIcon;
  if (["write_file", "edit_file", "apply_patch", "patch_file", "publish_artifact", "artifact_publish"].includes(normalized)) return FileIcon;
  if (["record_checkpoint", "checkpoint"].includes(normalized)) return CheckCircleIcon;
  return BracesIcon;
}

function isToolTerminal(part: EveDynamicToolPart): boolean {
  return part.state === "output-denied" || part.state === "output-error" ||
    (part.state === "output-available" && part.partial !== true);
}

function normalizeToolName(toolName: string): string {
  return toolName.toLocaleLowerCase().replaceAll("-", "_");
}

function isViewImageTool(normalizedToolName: string): boolean {
  return normalizedToolName === "view_image" || normalizedToolName.endsWith("__view_image");
}

function isFileMutationTool(part: EveDynamicToolPart): boolean {
  return ["apply_patch", "patch_file", "write_file", "edit_file"].includes(
    normalizeToolName(part.toolName),
  );
}

function isTodoTool(part: EveDynamicToolPart): boolean {
  return ["todo", "todo_write", "update_plan"].includes(normalizeToolName(part.toolName));
}

type FileMutationSummary = {
  readonly additions: number;
  readonly deletions: number;
  readonly operation: "create" | "delete" | "edit";
  readonly path?: string;
};

function fileMutationSummary(
  part: EveDynamicToolPart,
  events: readonly MessageStreamEvent[] = [],
): FileMutationSummary {
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

function fileMutationTitle(
  locale: AgentLocale,
  part: EveDynamicToolPart,
  events: readonly MessageStreamEvent[] = [],
): string {
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

function patchFilePath(patch: string): string | undefined {
  const match = patch.match(/^\+\+\+\s+(?:b\/)?(.+)$/m) ?? patch.match(/^---\s+(?:a\/)?(.+)$/m);
  const path = match?.[1]?.trim();
  return path && path !== "/dev/null" ? path : undefined;
}

function patchLineStats(patch: string): { readonly additions: number; readonly deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function countContentLines(value: string | undefined): number {
  if (!value) return 0;
  return value.endsWith("\n") ? value.slice(0, -1).split("\n").length : value.split("\n").length;
}

function StepActivity({
  events,
  locale,
  stepIndex,
  turnId,
}: {
  readonly events: readonly MessageStreamEvent[];
  readonly locale: AgentLocale;
  readonly stepIndex: number;
  readonly turnId?: string;
}) {
  const step = presentAgentStep(events, turnId, stepIndex);
  return (
    <>
      {step.status === "running" && step.retry ? (
        <RetryStatus locale={locale} retry={step.retry} />
      ) : null}
      <ReasoningRoot className="mb-1" role="status" streaming={step.status === "running"} variant="ghost">
        <ReasoningTrigger
          active={step.status === "running"}
          hideChevron
          label={step.status === "running"
            ? localize(locale, "Thinking", "正在思考")
            : localize(locale, "Reasoning complete", "思考完成")}
        />
      </ReasoningRoot>
    </>
  );
}

function RetryStatus({
  locale,
  retry,
}: {
  readonly locale: AgentLocale;
  readonly retry: NonNullable<ReturnType<typeof presentAgentStep>["retry"]>;
}) {
  return (
    <Collapsible className="mb-1 text-sm text-muted-foreground">
      <CollapsibleTrigger className="group/retry flex max-w-full items-center gap-2 py-1.5 text-left hover:text-foreground">
        <WifiIcon className="size-4 shrink-0" />
        <span>{localize(locale, "Reconnecting", "正在重新连接")} {retry.attempt}/{retry.maximum}</span>
        {retry.error ? <ChevronDownIcon className="size-3.5 -rotate-90 transition-transform group-data-[state=open]/retry:rotate-0" /> : null}
      </CollapsibleTrigger>
      {retry.error ? (
        <CollapsibleContent className="overflow-hidden">
          <div className="ml-6 rounded-lg border border-border/60 px-3 py-2 text-xs">
            <p className="break-words text-foreground">{sanitizeFailureMessage(retry.error.message)}</p>
            <code className="mt-1 block text-muted-foreground">{retry.error.code}</code>
          </div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

function ReasoningPart({
  events,
  locale,
  part,
  turnId,
}: {
  readonly events: readonly MessageStreamEvent[];
  readonly locale: AgentLocale;
  readonly part: Extract<EveMessagePart, { type: "reasoning" }>;
  readonly turnId?: string;
}) {
  const timing = reasoningTiming(events, turnId, part.stepIndex);
  const step = presentAgentStep(events, turnId, part.stepIndex ?? 0);
  const durationSeconds = useElapsedSeconds(timing.startedAt, timing.endedAt);
  const streaming = part.state === "streaming";
  return (
    <>
      {streaming && step.retry ? <RetryStatus locale={locale} retry={step.retry} /> : null}
      <ReasoningRoot className="mb-1" streaming={streaming} variant="ghost">
        <ReasoningTrigger
          active={streaming}
          duration={timing.startedAt && durationSeconds > 0 ? durationSeconds : undefined}
          label={streaming
            ? reasoningSummary(part.text) ?? localize(locale, "Thinking", "正在思考")
            : localize(locale, "Reasoning complete", "思考完成")}
        />
        <ReasoningContent aria-busy={streaming}>
          <ReasoningText><StaticMarkdownText text={part.text} /></ReasoningText>
        </ReasoningContent>
      </ReasoningRoot>
    </>
  );
}

function reasoningSummary(text: string): string | undefined {
  const firstLine = text
    .replaceAll(/^[#>*\-\s]+/gm, "")
    .split(/\n|(?<=[.!?。！？])\s+/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  return firstLine.length > 64 ? `${firstLine.slice(0, 63)}…` : firstLine;
}

function reasoningTiming(
  events: readonly MessageStreamEvent[],
  turnId: string | undefined,
  stepIndex: number | undefined,
): { readonly endedAt?: number; readonly startedAt?: number } {
  const matching = events.filter((event) =>
    (event.type === "reasoning.appended" || event.type === "reasoning.completed") &&
    (turnId === undefined || event.data.turnId === turnId) &&
    (stepIndex === undefined || ("stepIndex" in event.data && event.data.stepIndex === stepIndex)),
  );
  const startedAt = eventTime(matching.find((event) => event.type === "reasoning.appended") ?? matching[0]);
  const completed = [...matching].reverse().find((event) => event.type === "reasoning.completed");
  return {
    ...(startedAt ? { startedAt } : {}),
    ...(completed ? { endedAt: eventTime(completed) } : {}),
  };
}

function eventTime(event: MessageStreamEvent | undefined): number | undefined {
  const at = event?.meta?.at;
  if (!at) return undefined;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type FileChange = {
  readonly newContent: string;
  readonly oldContent: string;
  readonly path?: string;
};

function toolFileChange(
  part: EveDynamicToolPart,
  events: readonly MessageStreamEvent[] = [],
): FileChange | undefined {
  const input = asRecord(part.input);
  const output = part.state === "output-available" ? asRecord(part.output) : undefined;
  if (!input && !output) return undefined;
  const newContent = firstString(output, ["content", "newContent", "new_content", "new_string", "replacement"])
    ?? firstString(input, ["content", "newContent", "new_content", "new_string", "replacement"]);
  if (newContent === undefined) return undefined;
  const path = firstString(output, ["path", "filePath", "file", "filename"])
    ?? firstString(input, ["path", "filePath", "file", "filename"]);
  const oldContent = firstString(output, ["oldContent", "old_content", "old_string", "before"])
    ?? firstString(input, ["oldContent", "old_content", "old_string", "before"])
    ?? previousFileContent(events, path, part.toolCallId)
    ?? "";
  return { newContent, oldContent, ...(path ? { path } : {}) };
}

function previousFileContent(
  events: readonly MessageStreamEvent[],
  path: string | undefined,
  currentCallId: string,
): string | undefined {
  if (!path) return undefined;
  const reads = new Map<string, string>();
  let latest: string | undefined;
  for (const event of events) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (action.callId === currentCallId) return latest;
        if (action.kind !== "tool-call" || !["read_file", "read", "view_file"].includes(normalizeToolName(action.toolName))) continue;
        const actionPath = firstString(asRecord(action.input), ["path", "filePath", "file", "filename"]);
        if (actionPath === path) reads.set(action.callId, actionPath);
      }
      continue;
    }
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") continue;
    if (!reads.has(event.data.result.callId)) continue;
    latest = readableOutput(event.data.result.output) ?? latest;
  }
  return latest;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstNumber(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readableOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const lines = value.map((item) => readableOutput(item) ?? safeStringify(item));
    return lines.length > 0 ? lines.join("\n") : undefined;
  }
  const record = asRecord(value);
  if (!record) return value === undefined ? undefined : String(value);
  return firstString(record, ["stdout", "content", "text", "message", "result", "output", "url"])
    ?? (Object.keys(record).length > 0 ? safeStringify(record) : undefined);
}

function shellOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  const stdout = typeof record.stdout === "string" ? record.stdout.trimEnd() : "";
  const stderr = typeof record.stderr === "string" ? record.stderr.trimEnd() : "";
  return [stdout, stderr].filter(Boolean).join("\n") || undefined;
}

function ShellToolContent({
  command,
  locale,
  output,
  result,
  running,
}: {
  readonly command?: string;
  readonly locale: AgentLocale;
  readonly output: unknown;
  readonly result?: string;
  readonly running: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const exitCode = shellExitCode(output);
  const copyCommand = async () => {
    if (!command) return;
    try {
      await copyText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="overflow-hidden rounded-md bg-muted/50 font-mono text-xs" data-tool-view="terminal">
      <div className="flex min-h-9 items-start gap-2 px-3 py-2.5">
        <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-foreground">{command ?? localize(locale, "Shell command", "终端命令")}</pre>
        {running ? (
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : exitCode !== undefined ? (
          <span className={cn("shrink-0 tabular-nums", exitCode === 0 ? "text-muted-foreground" : "text-destructive")}>exit {exitCode}</span>
        ) : null}
        {command ? (
          <Button aria-label={localize(locale, "Copy command", "复制命令")} className="size-6 shrink-0" onClick={() => void copyCommand()} size="icon-sm" type="button" variant="ghost">
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </Button>
        ) : null}
      </div>
      {result ? (
        <pre className="max-h-72 overflow-auto border-t border-border/40 bg-background/40 px-3 py-2.5 whitespace-pre text-muted-foreground">{result}</pre>
      ) : !running && output !== undefined ? (
        <p className="border-t border-border/50 px-3 py-2 font-sans text-muted-foreground">{localize(locale, "Command completed with no output.", "命令已完成，没有输出。")}</p>
      ) : null}
    </div>
  );
}

function shellExitCode(value: unknown): number | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["exitCode", "exit_code", "code"]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function firstUrl(value: unknown): string | undefined {
  const direct = typeof value === "string" ? value : firstString(asRecord(value), ["url", "previewUrl", "preview_url"]);
  if (!direct) return undefined;
  const match = direct.match(/https?:\/\/[^\s"'<>]+/u);
  return match?.[0];
}

function todoItems(inputValue: unknown, outputValue: unknown): readonly { readonly done: boolean; readonly label: string }[] {
  const source = todoArray(inputValue) ?? todoArray(outputValue) ?? [];
  return source.flatMap((item) => {
    if (typeof item === "string") return [{ done: false, label: item }];
    const record = asRecord(item);
    if (!record) return [];
    const label = firstString(record, ["content", "label", "title", "text", "task"]);
    if (!label) return [];
    const status = firstString(record, ["status", "state"]);
    const done = record.done === true || status === "completed" || status === "done";
    return [{ done, label }];
  });
}

function todoArray(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return undefined;
  const candidate = record.todos ?? record.items ?? record.tasks ?? record.plan;
  return Array.isArray(candidate) ? candidate : undefined;
}

function toolPatch(part: EveDynamicToolPart): string | undefined {
  const toolName = part.toolName.toLocaleLowerCase().replaceAll("-", "_");
  if (!["apply_patch", "patch_file"].includes(toolName)) return undefined;
  return patchFromValue(part.input) ?? patchFromValue(part.output);
}

function patchFromValue(value: unknown): string | undefined {
  if (typeof value === "string") return displayablePatch(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const patch = record.patch ?? record.diff;
  return typeof patch === "string" ? displayablePatch(patch) : undefined;
}

function displayablePatch(value: string): string | undefined {
  if (looksLikeUnifiedDiff(value)) return value;
  return codexPatchToUnifiedDiff(value);
}

function looksLikeUnifiedDiff(value: string): boolean {
  return /^(?:diff --git |--- )/m.test(value) && /^\+\+\+ /m.test(value) && /^@@ /m.test(value);
}

/** Convert the model-facing Codex patch envelope into a display-only unified diff. */
function codexPatchToUnifiedDiff(value: string): string | undefined {
  const lines = value.replace(/\r\n?/gu, "\n").split("\n");
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const end = lines.findIndex((line, index) => index > begin && line.trim() === "*** End Patch");
  if (begin < 0 || end < 0) return undefined;
  const sections: string[] = [];
  for (let index = begin + 1; index < end;) {
    if (!lines[index]?.trim()) {
      index += 1;
      continue;
    }
    const directive = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/u.exec(lines[index]!);
    if (!directive) return undefined;
    const operation = directive[1]!;
    const sourcePath = directive[2]!;
    index += 1;
    let destinationPath = sourcePath;
    if (operation === "Update") {
      const move = /^\*\*\* Move to:\s*(.+?)\s*$/u.exec(lines[index] ?? "");
      if (move) {
        destinationPath = move[1]!;
        index += 1;
      }
    }
    const body: string[] = [];
    while (index < end && !lines[index]!.startsWith("*** ")) {
      body.push(lines[index]!);
      index += 1;
    }
    const oldName = operation === "Add" ? "/dev/null" : `a/${sourcePath}`;
    const newName = operation === "Delete" ? "/dev/null" : `b/${destinationPath}`;
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

function addFileHunk(lines: readonly string[]): readonly string[] {
  const additions = lines.filter((line) => line.startsWith("+"));
  return additions.length > 0
    ? [`@@ -0,0 +1,${additions.length} @@`, ...additions]
    : [];
}

function normalizeCodexHunks(lines: readonly string[]): readonly string[] {
  if (lines.length === 0) return [];
  const hunkStarts = lines.flatMap((line, index) => line.startsWith("@@") ? [index] : []);
  if (hunkStarts.length === 0) return normalizedHunk(lines, 1, 1);
  const normalized: string[] = [];
  let fallbackOldStart = 1;
  let fallbackNewStart = 1;
  for (let hunkIndex = 0; hunkIndex < hunkStarts.length; hunkIndex += 1) {
    const start = hunkStarts[hunkIndex]!;
    const end = hunkStarts[hunkIndex + 1] ?? lines.length;
    const header = lines[start]!;
    const body = lines.slice(start + 1, end);
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(header)) {
      normalized.push(header, ...body);
    } else {
      normalized.push(...normalizedHunk(body, fallbackOldStart, fallbackNewStart, header.slice(2).trim()));
    }
    fallbackOldStart += body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
    fallbackNewStart += body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
  }
  return normalized;
}

function normalizedHunk(lines: readonly string[], oldStart: number, newStart: number, suffix = ""): readonly string[] {
  const body = lines.filter((line) => /^(?: |\+|-|\\)/u.test(line));
  const oldCount = body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
  const newCount = body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
  const trailer = suffix ? ` ${suffix}` : "";
  return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${trailer}`, ...body];
}

function SubagentProgress({
  events,
  locale,
  onOpenSubagent,
  part,
}: {
  readonly events: readonly MessageStreamEvent[];
  readonly locale: AgentLocale;
  readonly onOpenSubagent?: (sessionId: string) => void;
  readonly part: EveDynamicToolPart;
}) {
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

  return (
    <div
      className={cn(
        "flex items-start gap-3 py-1.5 text-sm",
        presentation.status === "failed"
          ? "text-destructive"
          : "text-foreground",
      )}
      role={isActive ? "status" : undefined}
    >
      {isActive ? (
        <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : presentation.status === "completed" ? (
        <CheckCircleIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
      ) : presentation.status === "cancelled" ? (
        <CircleStopIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      ) : (
        <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          <NetworkIcon className="mr-1 inline size-3" />
          {presentation.name === "agent"
            ? localize(locale, "Works in the parent Agent workspace.", "在父 Agent 的工作区中执行。")
            : localize(locale, "Runs in its own isolated workspace.", "在独立隔离的工作区中执行。")}
        </p>
        {presentation.childSessionId && onOpenSubagent ? (
          <Button
            className="mt-2 h-7 px-2 text-xs"
            onClick={() => onOpenSubagent(presentation.childSessionId!)}
            size="sm"
            variant="outline"
          >
            <NetworkIcon className="size-3.5" />
            {localize(
              locale,
              `Open ${presentation.name === "agent" ? "sub-agent" : presentation.name ?? "sub-agent"} session`,
              `打开${presentation.name && presentation.name !== "agent" ? ` ${presentation.name}` : "子代理"}会话`,
            )}
          </Button>
        ) : null}
      </div>
      {presentation.startedAt ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatDuration(elapsedSeconds)}
        </span>
      ) : null}
    </div>
  );
}

function ExecutionGroup({
  children,
  collapseWhenSettled,
  fallbackStartedAt,
  locale,
  task,
}: {
  readonly children: React.ReactNode;
  readonly collapseWhenSettled: boolean;
  readonly fallbackStartedAt?: number;
  readonly locale: AgentLocale;
  readonly task: AgentTurnPresentation;
}) {
  const isActive = task.status === "running" || task.status === "waiting";
  const hasFinalDelivery = task.status === "completed" && collapseWhenSettled;
  const [open, setOpen] = useState(!hasFinalDelivery);
  const previousStatus = useRef(task.status);
  const previousFinalDelivery = useRef(hasFinalDelivery);
  const executionRef = useRef<HTMLDivElement>(null);
  const lockScroll = useScrollLock(executionRef, 200);
  const startedAt = task.startedAt ?? fallbackStartedAt;
  const elapsedSeconds = useElapsedSeconds(startedAt, task.endedAt);

  useEffect(() => {
    const wasActive = previousStatus.current === "running" || previousStatus.current === "waiting";
    const finalDeliveryArrived = !previousFinalDelivery.current && hasFinalDelivery;
    if (task.status === "waiting") setOpen(true);
    else if (finalDeliveryArrived || wasActive && hasFinalDelivery) setOpen(false);
    else if (wasActive && !isActive) setOpen(true);
    previousStatus.current = task.status;
    previousFinalDelivery.current = hasFinalDelivery;
  }, [hasFinalDelivery, isActive, task.status]);

  return (
    <Collapsible
      className="group/execution w-full"
      onOpenChange={(nextOpen) => {
        lockScroll();
        setOpen(nextOpen);
      }}
      open={open}
      ref={executionRef}
    >
      <CollapsibleTrigger asChild>
        <button
          className="flex w-full items-center gap-1.5 border-b border-border/60 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
          type="button"
        >
          <span>{executionLabel(locale, task)}</span>
          {startedAt && elapsedSeconds > 0 ? <span className="tabular-nums">{formatDuration(elapsedSeconds)}</span> : null}
          <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]/execution:rotate-180" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-out data-[state=open]:animate-in">
        <div className="mt-2 space-y-3 pt-2">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function hasLaterFinalDelivery(
  events: readonly MessageStreamEvent[],
  turnId: string | undefined,
): boolean {
  if (!turnId) return false;
  const turnEnd = events.findIndex((event) =>
    (event.type === "turn.completed" || event.type === "turn.cancelled" || event.type === "turn.failed") &&
    event.data.turnId === turnId,
  );
  if (turnEnd < 0) return false;
  return events.slice(turnEnd + 1).some((event) =>
    event.type === "message.completed" &&
    event.data.finishReason === "stop" &&
    typeof event.data.message === "string" &&
    event.data.message.trim().length > 0,
  );
}

function CopyResponseAction({ locale, text }: { readonly locale: AgentLocale; readonly text: string }) {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timeout.current), []);

  return (
    <MessageActions>
      <MessageAction
        label={localize(locale, "Copy response", "复制回复")}
        onClick={() => {
          void copyText(text).then(() => {
            setCopied(true);
            window.clearTimeout(timeout.current);
            timeout.current = window.setTimeout(() => setCopied(false), 1_500);
          });
        }}
        tooltip={localize(locale, copied ? "Copied" : "Copy response", copied ? "已复制" : "复制回复")}
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </MessageAction>
    </MessageActions>
  );
}

function useElapsedSeconds(startedAt: number | undefined, endedAt: number | undefined): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!startedAt || endedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [endedAt, startedAt]);
  if (!startedAt) return 0;
  return Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1_000));
}

function executionLabel(locale: AgentLocale, task: AgentTurnPresentation): string {
  if (task.status === "running") return localize(locale, "Working", "正在处理");
  if (task.status === "waiting") {
    return task.waitingFor === "tool-approval"
      ? localize(locale, "Waiting for approval", "等待批准")
      : localize(locale, "Waiting for confirmation", "等待确认");
  }
  if (task.status === "completed") return localize(locale, "Worked for", "已处理");
  if (task.status === "cancelled") return localize(locale, "Stopped after", "已停止");
  return localize(locale, "Failed after", "执行失败");
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function lastText(parts: readonly EveMessagePart[]): string | undefined {
  const part = [...parts].reverse().find((candidate) => candidate.type === "text");
  return part?.type === "text" ? part.text : undefined;
}

function AttachmentPart({ locale, part }: { readonly locale: AgentLocale; readonly part: EveFilePart }) {
  const label = part.filename ?? localize(locale, "Attachment", "附件");
  const detail = [part.mediaType, formatBytes(part.size)].filter(Boolean).join(" - ");
  const isImage = part.mediaType.startsWith("image/") && part.url !== undefined;
  const Icon = isImage ? ImageIcon : FileIcon;
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <>
      <Attachment className="max-w-sm" size="default" state="done">
        <AttachmentMedia variant={isImage ? "image" : "icon"}>
          {isImage ? <img alt={label} src={part.url} /> : <Icon className="size-4" />}
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{label}</AttachmentTitle>
          {detail ? <AttachmentDescription>{detail}</AttachmentDescription> : null}
        </AttachmentContent>
        {isImage && part.url ? (
          <AttachmentAction aria-label={localize(locale, "Preview image", "预览图片")} onClick={() => setPreviewOpen(true)} title={localize(locale, "Preview image", "预览图片")}>
            <ImageIcon className="size-3.5" />
          </AttachmentAction>
        ) : part.url ? (
          <AttachmentAction asChild aria-label={localize(locale, "Open attachment", "打开附件")} title={localize(locale, "Open attachment", "打开附件")}>
            <a href={part.url} rel="noreferrer" target="_blank"><ExternalLinkIcon className="size-3.5" /></a>
          </AttachmentAction>
        ) : null}
      </Attachment>
      {previewOpen && part.url ? (
        <button className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-6" onClick={() => setPreviewOpen(false)} type="button">
          <img alt={label} className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-2xl" src={part.url} />
        </button>
      ) : null}
    </>
  );
}

function AuthorizationPrompt({ locale, part }: { readonly locale: AgentLocale; readonly part: EveAuthorizationPart }) {
  const isAuthorized = part.state === "completed" && part.outcome === "authorized";
  const isCompleted = part.state === "completed";
  const Icon = isAuthorized ? CheckCircleIcon : isCompleted ? XCircleIcon : KeyRoundIcon;
  const instructions = part.authorization?.instructions;
  const shouldShowInstructions = instructions !== undefined && instructions !== part.description;

  return (
    <div
      className={cn(
        "space-y-3 rounded-md border p-3",
        isAuthorized
          ? "border-emerald-500/30 bg-emerald-500/5"
          : isCompleted
            ? "border-destructive/30 bg-destructive/5"
            : "border-blue-500/30 bg-blue-500/5",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
            isAuthorized
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : isCompleted
                ? "bg-destructive/10 text-destructive"
                : "bg-blue-500/10 text-blue-700 dark:text-blue-300",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium text-sm">{authorizationTitle(part, locale)}</p>
          <p className="text-muted-foreground text-sm">{authorizationDescription(part, locale)}</p>
          {shouldShowInstructions ? (
            <p className="text-muted-foreground text-sm">{instructions}</p>
          ) : null}
          {part.state === "required" && part.authorization?.userCode ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{localize(locale, "Code", "验证码")}</span>
              <code className="rounded-md bg-background px-2 py-1 font-mono">
                {part.authorization.userCode}
              </code>
            </div>
          ) : null}
          {part.state === "required" && part.authorization?.url ? (
            <Button asChild size="sm">
              <a href={part.authorization.url} rel="noreferrer" target="_blank">
                <ExternalLinkIcon className="size-4" />
                {localize(locale, `Sign in with ${part.displayName}`, `使用 ${part.displayName} 登录`)}
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function authorizationTitle(part: EveAuthorizationPart, locale: AgentLocale): string {
  if (part.state === "required") {
    return localize(locale, `Connect ${part.displayName}`, `连接 ${part.displayName}`);
  }
  if (part.outcome === "authorized") {
    return localize(locale, `${part.displayName} connected`, `${part.displayName} 已连接`);
  }
  return localize(locale, `${part.displayName} authorization ${formatAuthorizationOutcome(part.outcome)}`, `${part.displayName} 授权${formatAuthorizationOutcome(part.outcome, locale)}`);
}

function authorizationDescription(part: EveAuthorizationPart, locale: AgentLocale): string {
  if (part.state === "required") {
    return part.description;
  }
  if (part.outcome === "authorized") {
    return localize(locale, `${part.displayName} connected.`, `${part.displayName} 已连接。`);
  }
  const tail = part.reason !== undefined ? ` (${part.reason})` : "";
  return localize(locale, `${part.displayName} authorization ${formatAuthorizationOutcome(part.outcome)}${tail}.`, `${part.displayName} 授权${formatAuthorizationOutcome(part.outcome, locale)}${tail}。`);
}

function formatAuthorizationOutcome(outcome: NonNullable<EveAuthorizationPart["outcome"]>, locale: AgentLocale = "en"): string {
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

function formatBytes(size: number | undefined): string | undefined {
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

function InputRequestCard({
  canRespond,
  closed,
  events,
  locale,
  onClose,
  onInputResponses,
  part,
}: {
  readonly canRespond: boolean;
  readonly closed: boolean;
  readonly events: readonly MessageStreamEvent[];
  readonly locale: AgentLocale;
  readonly onClose: (requestId: string) => void;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly part: EveDynamicToolPart;
}) {
  const inputRequest = part.toolMetadata?.eve?.inputRequest;
  if (!inputRequest) {
    return null;
  }

  const inputResponse = part.toolMetadata?.eve?.inputResponse;
  const selectedOption = inputRequest.options?.find(
    (option) => option.id === inputResponse?.optionId,
  );

  const isQuestion = inputRequest.kind === "question";
  const isApproval = inputRequest.kind === "tool-approval";
  const acceptsFreeform = isQuestion && (inputRequest.allowFreeform === true || !inputRequest.options?.length);
  const Icon = isQuestion ? MessageCircleQuestionIcon : isApproval ? ShieldCheckIcon : CircleStopIcon;
  const eyebrow = isQuestion
    ? localize(locale, "Agent question", "Agent 需要确认")
    : isApproval
      ? localize(
          locale,
          `Approve tool call: ${approvalToolName(part.toolName, locale)}`,
          `批准工具调用：${approvalToolName(part.toolName, locale)}`,
        )
      : localize(locale, "Session limit reached", "已达到会话限制");

  const choices = inputRequest.options ?? [];

  const settled = Boolean(inputResponse) || closed;
  const [open, setOpen] = useState(!settled);
  useEffect(() => {
    if (settled) setOpen(false);
  }, [settled]);
  if (isApproval && !settled) return null;
  const status = closed
    ? localize(locale, "Closed", "已关闭")
    : inputResponse
      ? localize(locale, "Responded", "已回复")
      : isQuestion
        ? localize(locale, "Waiting for confirmation", "等待确认")
        : undefined;

  return (
    <Collapsible className={cn("my-1 max-w-full transition-[width] duration-200", open ? "w-full max-w-xl" : "w-fit")} onOpenChange={setOpen} open={open}>
      <section className="rounded-xl border border-border/70 bg-background px-3.5 py-3" data-input-request-kind={inputRequest.kind}>
        <div className="flex items-start gap-2.5">
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <CollapsibleTrigger asChild>
                <button className="group/request flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium text-muted-foreground hover:text-foreground" type="button">
                  <span className="truncate">{eyebrow}</span>
                  {status ? <span className="shrink-0 font-normal text-muted-foreground/80">· {status}</span> : null}
                  <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/request:rotate-180" />
                </button>
              </CollapsibleTrigger>
              {!inputResponse && !closed && isQuestion ? <Button className="h-6 shrink-0 px-2 text-xs" onClick={() => onClose(inputRequest.requestId)} size="sm" type="button" variant="ghost">{localize(locale, "Close", "关闭")}</Button> : null}
            </div>
            <CollapsibleContent className="overflow-hidden">
              <p className="mt-1 text-sm leading-6 text-foreground">{inputRequest.prompt}</p>
              {isApproval ? <ApprovalActionPreview events={events} locale={locale} part={part} /> : null}
              {settled ? (
                <InputRequestReview
                  closed={closed}
                  inputResponse={inputResponse}
                  locale={locale}
                  options={choices}
                  selectedOptionId={selectedOption?.id}
                />
              ) : isApproval ? (
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  {localize(locale, "Respond using the approval controls below.", "请使用下方批准控件继续。")}
                </p>
              ) : (
                <QuestionnaireResponseForm
                  acceptsFreeform={acceptsFreeform}
                  canRespond={canRespond}
                  locale={locale}
                  onInputResponses={onInputResponses}
                  options={choices}
                  prompt={inputRequest.prompt}
                  requestId={inputRequest.requestId}
                />
              )}
            </CollapsibleContent>
          </div>
        </div>
      </section>
    </Collapsible>
  );
}

function approvalToolName(toolName: string, locale: AgentLocale): string {
  const normalized = normalizeToolName(toolName);
  if (["bash", "shell", "terminal", "exec_command"].includes(normalized)) return localize(locale, "Terminal command", "终端命令");
  if (["apply_patch", "patch_file", "write_file", "edit_file"].includes(normalized)) return localize(locale, "File change", "文件变更");
  if (["web_fetch", "fetch_url", "web_search", "search_web"].includes(normalized)) return localize(locale, "Network access", "网络访问");
  return toolName;
}

function ApprovalActionPreview({
  events,
  locale,
  part,
}: {
  readonly events: readonly MessageStreamEvent[];
  readonly locale: AgentLocale;
  readonly part: EveDynamicToolPart;
}) {
  const normalized = normalizeToolName(part.toolName);
  const input = asRecord(part.input);
  if (["bash", "shell", "terminal", "exec_command"].includes(normalized)) {
    return (
      <div className="mt-3">
        <ShellToolContent
          command={firstString(input, ["command", "cmd"])}
          locale={locale}
          output={undefined}
          running={false}
        />
      </div>
    );
  }
  if (isFileMutationTool(part)) {
    const patch = toolPatch(part);
    const change = toolFileChange(part, events);
    if (patch) {
      return <div className="mt-3" data-tool-view="approval-diff"><DiffViewer contentClassName="max-h-56 overflow-auto" patch={patch} showIcon size="sm" variant="muted" /></div>;
    }
    if (change) {
      return (
        <div className="mt-3" data-tool-view="approval-diff">
          <DiffViewer
            contentClassName="max-h-56 overflow-auto"
            newFile={{ content: change.newContent, name: change.path }}
            oldFile={{ content: change.oldContent, name: change.path }}
            showIcon
            size="sm"
            variant="muted"
          />
        </div>
      );
    }
  }
  return (
    <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2.5 text-xs text-foreground" data-tool-view="approval-input">
      {safeStringify(part.input)}
    </pre>
  );
}

function InputRequestReview({
  closed,
  inputResponse,
  locale,
  options,
  selectedOptionId,
}: {
  readonly closed: boolean;
  readonly inputResponse?: InputResponse;
  readonly locale: AgentLocale;
  readonly options: readonly { readonly description?: string; readonly id: string; readonly label: string }[];
  readonly selectedOptionId?: string;
}) {
  return (
    <div className="mt-3 space-y-2 text-sm" data-tool-view="input-review">
      <p className="text-xs text-muted-foreground">
        {closed
          ? localize(locale, "This question was closed. The details remain available for review.", "此问题已关闭，详细内容仍可回看。")
          : localize(locale, "Response", "回复")}
      </p>
      {options.length > 0 ? (
        <ul className="space-y-1.5" aria-label={localize(locale, "Options", "选项")}>
          {options.map((option) => (
            <li
              className={cn(
                "flex items-start gap-2 rounded-md bg-muted/40 px-2.5 py-2",
                selectedOptionId === option.id && "bg-accent/80 text-foreground",
              )}
              key={option.id}
            >
              <span className={cn("mt-1 size-2 shrink-0 rounded-full border border-muted-foreground/40", selectedOptionId === option.id && "border-primary bg-primary")} />
              <span className="min-w-0">
                <span className="block font-medium">{option.label}</span>
                {option.description ? <span className="block text-xs leading-5 text-muted-foreground">{option.description}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="rounded-md bg-muted/40 px-2.5 py-2">
        <p className="text-xs text-muted-foreground">{localize(locale, "Additional information", "补充信息")}</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-foreground">
          {inputResponse?.text?.trim() || localize(locale, "No additional information provided.", "未提供补充信息。")}
        </p>
      </div>
    </div>
  );
}

const FREEFORM_OPTION_ID = "__open_agent_freeform__";

function QuestionnaireResponseForm({
  acceptsFreeform,
  canRespond,
  locale,
  onInputResponses,
  options,
  prompt,
  requestId,
}: {
  readonly acceptsFreeform: boolean;
  readonly canRespond: boolean;
  readonly locale: AgentLocale;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly options: readonly { readonly description?: string; readonly id: string; readonly label: string; readonly style?: "danger" | "default" | "primary" }[];
  readonly prompt: string;
  readonly requestId: string;
}) {
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

  return (
    <Questionnaire
      className="mt-3"
      items={questionnaireItems}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!canRespond) return;
        const text = freeformText.trim();
        if (!selectedOptionId && !text) return;
        void onInputResponses([{
          ...(selectedOptionId ? { optionId: selectedOptionId } : {}),
          ...(text ? { text } : {}),
          requestId,
        }]);
      }}
    >
      <QuestionnaireItem name="response" required>
        <QuestionnaireTitle className="sr-only">{prompt}</QuestionnaireTitle>
        <QuestionnaireChoices>
          {options.map((option) => (
            <QuestionnaireChoice
              checked={selectedOptionId === option.id}
              className={option.style === "danger" ? "border-destructive/40 data-checked:bg-destructive/10" : option.style === "primary" ? "data-checked:border-primary/50" : undefined}
              disabled={!canRespond}
              key={option.id}
              onChange={(event) => setSelectedOptionId(event.currentTarget.checked ? option.id : "")}
              value={option.id}
            >
              <span className={cn("min-w-0 break-words font-medium", option.style === "danger" && "text-destructive")}>{option.label}</span>
              {option.description ? <QuestionnaireChoiceDescription>{option.description}</QuestionnaireChoiceDescription> : null}
            </QuestionnaireChoice>
          ))}
          {acceptsFreeform ? (
            <>
              <QuestionnaireChoice checked={!selectedOptionId && hasFreeformAnswer} className="hidden" value={FREEFORM_OPTION_ID}>
                {localize(locale, "Freeform answer", "补充回答")}
              </QuestionnaireChoice>
              <textarea
                aria-label={options.length > 0 ? localize(locale, "Additional information", "补充信息") : localize(locale, "Answer", "回答")}
                className="min-h-20 w-full resize-y rounded-lg border border-border/70 bg-transparent px-3 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canRespond}
                onChange={(event) => setFreeformText(event.currentTarget.value)}
                placeholder={options.length > 0 ? localize(locale, "Add context (optional)", "补充信息（可选）") : localize(locale, "Type your answer", "输入你的回答")}
                value={freeformText}
              />
            </>
          ) : null}
        </QuestionnaireChoices>
        <QuestionnaireError>{localize(locale, "Choose an option or add information to continue.", "请选择一个选项或补充信息后继续。")}</QuestionnaireError>
      </QuestionnaireItem>
      <div className="flex justify-end pt-1">
        <QuestionnaireSubmit disabled={!canRespond}>{localize(locale, "Confirm", "确认")}</QuestionnaireSubmit>
      </div>
    </Questionnaire>
  );
}

function TurnFailure({ failure, locale }: { readonly failure: { readonly code: string; readonly message: string }; readonly locale: AgentLocale }) {
  return (
    <div className="mt-2 flex items-start gap-3 rounded-xl border border-border/70 px-3.5 py-3 text-sm" role="alert">
      <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{localize(locale, "This turn failed", "本轮执行失败")}</p>
        <p className="mt-1 break-words text-muted-foreground">{sanitizeFailureMessage(failure.message)}</p>
        <code className="mt-1.5 block text-xs text-muted-foreground">{failure.code}</code>
      </div>
    </div>
  );
}

function sanitizeFailureMessage(message: string): string {
  return message
    .replace(/(["']?base[_ -]?url["']?\s*[:=]\s*)["']?https?:\/\/[^\s,"'}]+["']?/giu, "$1[hidden]")
    .replace(/https?:\/\/[^\s)\]}>"']+/giu, "[provider endpoint hidden]");
}

function localize(locale: AgentLocale, english: string, chinese: string): string {
  return locale === "zh-CN" ? chinese : english;
}

function toolStatusLabel(locale: AgentLocale, part: EveDynamicToolPart): string {
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

function toolTitle(
  locale: AgentLocale,
  part: EveDynamicToolPart,
  events: readonly MessageStreamEvent[] = [],
): string {
  const kind = part.toolMetadata?.eve?.kind;
  if (kind === "load-skill") return localize(locale, "Loaded skill", "加载技能");
  if (kind === "subagent-call") return localize(locale, "Sub-agent", "子代理");

  const normalized = part.toolName.toLocaleLowerCase().replaceAll("-", "_");
  if (normalized === "ask_question") return localize(locale, "Question", "确认问题");
  if (isFileMutationTool(part)) return fileMutationTitle(locale, part, events);
  if (["bash", "shell", "terminal", "exec_command"].includes(normalized)) {
    const command = firstString(asRecord(part.input), ["command", "cmd"]);
    return [localize(locale, "Terminal command", "终端命令"), command].filter(Boolean).join(" ");
  }
  if (["publish_preview", "website_preview"].includes(normalized)) return localize(locale, "Published preview", "发布网站预览");
  if (["import_remote_asset", "remote_asset_import"].includes(normalized)) {
    const filename = firstString(asRecord(part.input), ["filename", "url"]);
    return [localize(locale, "Imported remote asset", "导入远程资产"), filename].filter(Boolean).join(" ");
  }
  if (["publish_artifact", "artifact_publish"].includes(normalized)) return localize(locale, "Published artifact", "发布产物");
  if (["record_checkpoint", "checkpoint"].includes(normalized)) return localize(locale, "Saved checkpoint", "保存检查点");
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
  if (["todo", "todo_write", "update_plan"].includes(normalized)) return localize(locale, "Updated tasks", "更新任务列表");
  if (["web_search", "search_web", "search"].includes(normalized)) return localize(locale, "Searched the web", "搜索网页");
  if (["web_fetch", "fetch_url"].includes(normalized)) {
    const url = firstString(asRecord(part.input), ["url"]);
    return [localize(locale, "Fetched webpage", "读取网页"), url].filter(Boolean).join(" ");
  }
  return part.toolName.replaceAll("_", " ");
}

function partKey(part: EveMessagePart, index: number): string {
  switch (part.type) {
    case "authorization":
      return `authorization:${part.turnId}:${part.stepIndex}:${part.name}`;
    case "dynamic-tool":
      return part.toolCallId;
    default:
      return `${part.type}:${index}`;
  }
}
