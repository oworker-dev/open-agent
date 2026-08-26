"use client";

import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useMentionAdapter,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import type { Attachment as AssistantAttachment, CompleteAttachment } from "@assistant-ui/react";
import { LexicalComposerInput, type DirectiveChipProps } from "@assistant-ui/react-lexical";
import type { MessageStreamEvent } from "eve/client";
import type { EveMessage } from "eve/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  AtSignIcon,
  CheckIcon,
  CircleGaugeIcon,
  CircleXIcon,
  CopyIcon,
  FileIcon,
  ImageIcon,
  LockKeyholeIcon,
  LoaderCircleIcon,
  PlusIcon,
  PencilIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  SlashIcon,
  SquareIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ComposerTriggerPopover } from "../assistant-ui/composer-trigger-popover.js";
import { copyText } from "../assistant-ui/copy-text.js";
import { ContextDisplay } from "../assistant-ui/context-display.js";
import { DirectiveText } from "../assistant-ui/directive-text.js";
import { MarkdownText } from "../assistant-ui/markdown-text.js";
import { ModelSelector, type ModelOption } from "../assistant-ui/model-selector.js";
import { ToolFallback } from "../assistant-ui/tool-fallback.js";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.js";
import { Button } from "../ui/button.js";
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "../ui/attachment.js";
import { cn } from "../utils.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.js";
import { AgentMessage, type AgentInputResponse } from "./agent-message.js";
import { presentAgentTurn } from "./turn-presentation.js";
import type { AgentComposerDraftRestore, AgentExecutionMode, AgentModelOption, AgentPromptMenuItem, AgentSessionDeliverable, AgentThreadPreferences } from "./contracts.js";
import type { AgentLocale, AgentMessages } from "./i18n.js";
import type { AgentUsageSummary } from "./usage.js";

export type AgentCancellationState = "idle" | "requested" | "cancelling";

export type AgentApprovalTakeover = {
  readonly input?: unknown;
  readonly requestId: string;
  readonly prompt: string;
  readonly toolName: string;
};

export function AssistantThreadSurface({
  assetUrl,
  approvalTakeover,
  cancellationState,
  closedInputRequestIds,
  commands,
  composerTop,
  draftStorageKey,
  draftRestore,
  events,
  eveMessages,
  fallbackStartedAt,
  historyHasMore = false,
  historyLoading = false,
  inputDisabled,
  isBusy,
  locale,
  mentions,
  messages,
  models,
  onInputResponses,
  onCloseInputRequest,
  onDraftRestoreConsumed,
  onOpenDeliverable,
  onOpenSubagent,
  onLoadEarlier,
  onPreferencesChange,
  onRetryRuntimeError,
  preferences,
  reasoningLevels,
  runtimeError,
  usage,
}: {
  readonly assetUrl?: (assetId: string) => string;
  readonly approvalTakeover?: AgentApprovalTakeover;
  readonly cancellationState: AgentCancellationState;
  readonly closedInputRequestIds: ReadonlySet<string>;
  readonly commands: readonly AgentPromptMenuItem[];
  readonly composerTop?: ReactNode;
  readonly draftStorageKey: string;
  readonly draftRestore?: AgentComposerDraftRestore;
  readonly events: readonly MessageStreamEvent[];
  readonly eveMessages: readonly EveMessage[];
  readonly fallbackStartedAt?: number;
  readonly historyHasMore?: boolean;
  readonly historyLoading?: boolean;
  /** Locks the main composer without disabling assistant-ui's edit composer. */
  readonly inputDisabled?: boolean;
  readonly isBusy: boolean;
  readonly locale: AgentLocale;
  readonly mentions: readonly AgentPromptMenuItem[];
  readonly messages: AgentMessages;
  readonly models: readonly AgentModelOption[];
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly onCloseInputRequest: (requestId: string) => void;
  readonly onDraftRestoreConsumed: (id: string) => void;
  readonly onOpenDeliverable?: (deliverable: AgentSessionDeliverable) => void;
  readonly onOpenSubagent?: (sessionId: string) => void;
  readonly onLoadEarlier?: () => void;
  readonly onPreferencesChange: (preferences: AgentThreadPreferences) => void;
  readonly onRetryRuntimeError?: () => void;
  readonly preferences: AgentThreadPreferences;
  readonly reasoningLevels: readonly string[];
  readonly runtimeError?: string;
  readonly usage: AgentUsageSummary;
}) {
  const eveMessagesById = useMemo(
    () => new Map(eveMessages.map((message) => [message.id, message])),
    [eveMessages],
  );
  const lastMessageId = eveMessages.at(-1)?.id;
  const canRespondToInputRequest = eveMessages.some((message) =>
    message.parts.some((part) =>
      part.type === "dynamic-tool" &&
      Boolean(part.toolMetadata?.eve?.inputRequest) &&
      part.toolMetadata?.eve?.inputResponse === undefined,
    ),
  );

  return (
    <ThreadPrimitive.Root
      className="aui-root flex h-full min-h-0 flex-col bg-background"
      style={{ "--thread-max-width": "48rem" } as React.CSSProperties}
    >
      <ThreadPrimitive.Viewport
        aria-live="polite"
        autoScroll
        turnAnchor="top"
        className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-3 pt-3 sm:px-4 sm:pt-4"
        data-slot="thread-viewport"
        role="log"
      >
        {historyHasMore ? (
          <div className="mx-auto mb-3 flex w-full max-w-(--thread-max-width) justify-center">
            <Button
              className="text-xs text-muted-foreground"
              disabled={historyLoading}
              onClick={onLoadEarlier}
              size="sm"
              variant="ghost"
            >
              {historyLoading ? (locale === "zh-CN" ? "正在加载更早消息…" : "Loading earlier messages…") : (locale === "zh-CN" ? "加载更早消息" : "Load earlier messages")}
            </Button>
          </div>
        ) : null}
        <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-6 pb-3 empty:hidden">
          <ThreadPrimitive.Messages>
            {({ message }) => message.composer.isEditing ? (
              <EditMessage messages={messages} />
            ) : message.role === "user" ? (
              <UserMessage messages={messages} />
          ) : (
            <AssistantMessage
              assetUrl={assetUrl}
              canRespond={!isBusy || canRespondToInputRequest}
              events={events}
                fallbackStartedAt={fallbackStartedAt}
              isStreaming={isBusy && message.id === lastMessageId}
              isTurnContinuation={isSteeringContinuationMessage(message, events)}
              locale={locale}
                message={eveMessagesById.get(message.id)}
                messages={messages}
                onInputResponses={onInputResponses}
                onCloseInputRequest={onCloseInputRequest}
                onOpenDeliverable={onOpenDeliverable}
                onOpenSubagent={onOpenSubagent}
                closedInputRequestIds={closedInputRequestIds}
              />
          )}
          </ThreadPrimitive.Messages>
          {runtimeError ? (
            <RuntimeErrorMessage
              locale={locale}
              message={runtimeError}
              messages={messages}
              onRetry={onRetryRuntimeError}
            />
          ) : null}
        </div>

        <ThreadPrimitive.Empty>
          {!isBusy ? <AssistantEmptyState messages={messages} /> : null}
        </ThreadPrimitive.Empty>

        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 z-20 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col bg-background pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-0 sm:pb-4 md:pb-5">
          <ThreadPrimitive.ScrollToBottom asChild>
            <TooltipIconButton
              tooltip={locale === "zh-CN" ? "滚动到底部" : "Scroll to bottom"}
              className="absolute -top-9 left-1/2 z-10 size-8 -translate-x-1/2 rounded-full disabled:invisible"
              variant="outline"
            >
              <ArrowDownIcon className="size-4" />
            </TooltipIconButton>
          </ThreadPrimitive.ScrollToBottom>
          <AssistantComposer
            approvalTakeover={approvalTakeover}
            cancellationState={cancellationState}
            commands={commands}
            composerTop={composerTop}
            draftStorageKey={draftStorageKey}
            draftRestore={draftRestore}
            inputDisabled={inputDisabled}
            locale={locale}
            mentions={mentions}
            messages={messages}
            models={models}
            onPreferencesChange={onPreferencesChange}
            onInputResponses={onInputResponses}
            onDraftRestoreConsumed={onDraftRestoreConsumed}
            preferences={preferences}
            reasoningLevels={reasoningLevels}
            usage={usage}
          />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function isSteeringContinuationMessage(message: {
  readonly id: string;
  readonly metadata?: unknown;
  readonly role: string;
}, events: readonly MessageStreamEvent[]): boolean {
  const metadata = typeof message.metadata === "object" && message.metadata !== null
    ? message.metadata as { readonly turnId?: unknown }
    : undefined;
  const turnId = typeof metadata?.turnId === "string" ? metadata.turnId : undefined;
  if (message.role !== "assistant" || !turnId || !message.id.startsWith(`${turnId}:assistant:`)) return false;
  const clientMessageId = message.id.slice(`${turnId}:assistant:`.length);
  if (!clientMessageId) return false;
  const receipts = events.filter((event) =>
    event.type === "message.received" && event.data.turnId === turnId,
  );
  const segmentIndex = receipts.findIndex((event) =>
    event.type === "message.received" && event.data.clientMessageId === clientMessageId,
  );
  // A first message may also carry a client id. Only a receipt after another
  // message in the same Eve turn is a steering continuation.
  return segmentIndex > 0 || (segmentIndex < 0 && receipts.length > 0);
}

function RuntimeErrorMessage({
  locale,
  message,
  messages,
  onRetry,
}: {
  readonly locale: AgentLocale;
  readonly message: string;
  readonly messages: AgentMessages;
  readonly onRetry?: () => void;
}) {
  return (
    <article className="mx-auto flex w-full max-w-(--thread-max-width) flex-col" data-agent-message-error role="alert">
      <div className="flex items-start gap-3 px-1 text-sm">
        <CircleXIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            {locale === "zh-CN" ? "本轮执行失败" : messages.requestFailed}
          </p>
          <p className="mt-1 break-words text-muted-foreground">{message}</p>
          <p className="mt-1 text-muted-foreground">{messages.requestPreserved}</p>
          {onRetry ? (
            <Button className="mt-2 h-7 px-2.5 text-xs" onClick={onRetry} size="sm" variant="outline">
              <RotateCcwIcon className="size-3.5" />
              {messages.retry}
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function UserMessage({ messages }: { readonly messages: AgentMessages }) {
  const [actionsVisible, setActionsVisible] = useState(false);
  const isLastUserMessage = useAuiState((state) => {
    const lastUser = [...state.thread.messages].reverse().find((message) => message.role === "user");
    return lastUser?.id === state.message.id;
  });
  return (
    <MessagePrimitive.Root className="group mx-auto flex w-full max-w-(--thread-max-width) scroll-mt-5 flex-col items-end">
      <AttachmentGroup className="mb-2 max-w-[88%] justify-end py-0 empty:hidden">
        <MessagePrimitive.Attachments>
          {({ attachment }) => <UserAttachment attachment={attachment} messages={messages} />}
        </MessagePrimitive.Attachments>
      </AttachmentGroup>
      <div
        className="max-w-[min(44rem,88%)] rounded-2xl bg-muted/75 px-4 py-3 text-[15px] leading-6 text-foreground"
        onClick={() => {
          if (window.matchMedia("(pointer: coarse)").matches) setActionsVisible((visible) => !visible);
        }}
      >
        <MessagePrimitive.Parts components={{ Text: DirectiveText }} />
      </div>
      <div className={cn("mt-0.5 flex min-h-7 items-center transition-opacity", actionsVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>
        <ActionBarPrimitive.Root className="flex min-h-7 items-center gap-0.5">
          <ReliableCopyButton label={messages.copyResponse} />
          {isLastUserMessage ? (
            <ActionBarPrimitive.Edit
              aria-label={messages.editMessage}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <PencilIcon className="size-3.5" />
            </ActionBarPrimitive.Edit>
          ) : null}
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function UserAttachment({ attachment, messages }: { readonly attachment: CompleteAttachment; readonly messages: AgentMessages }) {
  const isImage = attachment.contentType?.startsWith("image/") ?? attachment.type === "image";
  const previewUrl = isImage ? attachmentContentUrl(attachment) : undefined;
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <>
      {isImage ? (
        <Attachment className="size-24 min-w-0 overflow-hidden p-0 sm:size-28" orientation="vertical" size="sm" state="done">
          <AttachmentMedia className="size-full rounded-xl" variant={previewUrl ? "image" : "icon"}>
            {previewUrl ? <img alt={attachment.name} src={previewUrl} /> : <ImageIcon className="size-5" />}
          </AttachmentMedia>
          {previewUrl ? (
            <AttachmentTrigger aria-label={`${messages.attachment}: ${attachment.name}`} onClick={() => setPreviewOpen(true)} />
          ) : null}
        </Attachment>
      ) : (
        <Attachment className="max-w-72" size="sm" state="done">
          <AttachmentMedia variant="icon"><FileIcon className="size-4" /></AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{attachment.name}</AttachmentTitle>
            <AttachmentDescription>{attachment.contentType ?? messages.attachment}</AttachmentDescription>
          </AttachmentContent>
        </Attachment>
      )}
      {previewOpen && previewUrl ? (
        <button aria-label={messages.dismiss} className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-4" onClick={() => setPreviewOpen(false)} type="button">
          <img alt={attachment.name} className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain" src={previewUrl} />
        </button>
      ) : null}
    </>
  );
}

function attachmentContentUrl(attachment: CompleteAttachment): string | undefined {
  for (const part of attachment.content) {
    const value = part.type === "file" ? part.data : part.type === "image" ? part.image : undefined;
    if (typeof value === "string") return value;
    const candidate: unknown = value;
    if (candidate instanceof URL) return candidate.toString();
  }
  return undefined;
}

function AssistantMessage({
  assetUrl,
  canRespond,
  closedInputRequestIds,
  events,
  fallbackStartedAt,
  isStreaming,
  isTurnContinuation,
  locale,
  message,
  messages,
  onInputResponses,
  onCloseInputRequest,
  onOpenDeliverable,
  onOpenSubagent,
}: {
  readonly assetUrl?: (assetId: string) => string;
  readonly canRespond: boolean;
  readonly closedInputRequestIds: ReadonlySet<string>;
  readonly events: readonly MessageStreamEvent[];
  readonly fallbackStartedAt?: number;
  readonly isStreaming: boolean;
  readonly isTurnContinuation: boolean;
  readonly locale: AgentLocale;
  readonly message?: EveMessage;
  readonly messages: AgentMessages;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly onCloseInputRequest: (requestId: string) => void;
  readonly onOpenDeliverable?: (deliverable: AgentSessionDeliverable) => void;
  readonly onOpenSubagent?: (sessionId: string) => void;
}) {
  const task = message
    ? presentAgentTurn(message, events, closedInputRequestIds, { mergeSameTurn: true })
    : undefined;
  const copyableText = message
    ? task
      ? task.status === "completed" ? task.finalPart?.text.trim() : undefined
      : message.metadata?.status === "failed"
        ? undefined
        : message.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim() || undefined
    : undefined;
  return (
    <MessagePrimitive.Root className="group mx-auto flex w-full max-w-(--thread-max-width) scroll-mt-5 flex-col">
      <div className="min-w-0 px-1 text-[15px] leading-7 text-foreground">
        {message ? (
          <AgentMessage
            assetUrl={assetUrl}
            canRespond={canRespond}
            closedInputRequestIds={closedInputRequestIds}
            events={events}
            fallbackStartedAt={fallbackStartedAt}
            isStreaming={isStreaming}
            isTurnContinuation={isTurnContinuation}
            locale={locale}
            message={message}
            onInputResponses={onInputResponses}
            onCloseInputRequest={onCloseInputRequest}
            onOpenDeliverable={onOpenDeliverable}
            onOpenSubagent={onOpenSubagent}
            showCopyAction={false}
          />
        ) : (
          <MessagePrimitive.Parts components={{ Text: MarkdownText, tools: { Fallback: ToolFallback } }} />
        )}
      </div>
      {!isStreaming && copyableText ? (
        <ActionBarPrimitive.Root className="mt-1 flex min-h-7 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <ReliableCopyButton label={messages.copyResponse} text={copyableText} />
        </ActionBarPrimitive.Root>
      ) : null}
    </MessagePrimitive.Root>
  );
}

function ReliableCopyButton({ label, text }: { readonly label: string; readonly text?: string }) {
  const aui = useAui();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <Button
      aria-label={label}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      size="icon-sm"
      title={copied ? "Copied" : label}
      type="button"
      variant="ghost"
      onClick={() => {
        const copyValue = text ?? aui.message.getCopyText();
        void copyText(copyValue).then(() => {
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1_500);
        }).catch(() => setCopied(false));
      }}
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </Button>
  );
}

function EditMessage({ messages }: { readonly messages: AgentMessages }) {
  const aui = useAui();
  const canSend = useAuiState((state) => state.composer.canSend);

  const resendFromHere = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) return;
    // Editing rewinds and reruns from this message. assistant-ui otherwise
    // treats unchanged content as a no-op and never calls the host onEdit.
    aui.composer.send({ startRun: true });
  };

  return (
    <MessagePrimitive.Root className="mx-auto w-full max-w-(--thread-max-width)" data-agent-edit-composer>
      <ComposerPrimitive.Root className="rounded-2xl bg-muted/70 px-4 py-3" onSubmit={resendFromHere}>
        <ComposerPrimitive.Input
          autoComplete="off"
          autoFocus
          className="min-h-12 w-full resize-none border-0 bg-transparent text-[15px] leading-6 outline-none"
          id="agent-edit-message"
          name="agent-edit-message"
        />
        <div className="mt-2 flex justify-end gap-2">
          <ComposerPrimitive.Cancel asChild>
            <Button className="h-7 bg-background px-2.5 text-xs" size="sm" variant="ghost">{messages.cancelEdit}</Button>
          </ComposerPrimitive.Cancel>
          <Button className="h-7 px-2.5 text-xs" disabled={!canSend} size="sm" type="submit">{messages.send}</Button>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

export function AssistantComposer({
  approvalTakeover,
  cancellationState,
  commands,
  composerTop,
  draftStorageKey,
  draftRestore,
  inputDisabled = false,
  locale,
  mentions,
  messages,
  models,
  onPreferencesChange,
  onInputResponses,
  onDraftRestoreConsumed,
  preferences,
  reasoningLevels,
  usage,
}: {
  readonly approvalTakeover?: AgentApprovalTakeover;
  readonly cancellationState: AgentCancellationState;
  readonly commands: readonly AgentPromptMenuItem[];
  readonly composerTop?: ReactNode;
  readonly draftStorageKey: string;
  readonly draftRestore?: AgentComposerDraftRestore;
  readonly inputDisabled?: boolean;
  readonly locale: AgentLocale;
  readonly mentions: readonly AgentPromptMenuItem[];
  readonly messages: AgentMessages;
  readonly models: readonly AgentModelOption[];
  readonly onPreferencesChange: (preferences: AgentThreadPreferences) => void;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly onDraftRestoreConsumed: (id: string) => void;
  readonly preferences: AgentThreadPreferences;
  readonly reasoningLevels: readonly string[];
  readonly usage: AgentUsageSummary;
}) {
  const aui = useAui();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const composerIsEmpty = useAuiState((state) => state.composer.isEmpty);
  const composerText = useAuiState((state) => state.composer.text);
  const runtimeInputDisabled = useAuiState((state) => state.thread.isDisabled);
  const stopping = cancellationState !== "idle";
  const composerDisabled = inputDisabled || runtimeInputDisabled || stopping;
  const composerInputRef = useRef<HTMLDivElement>(null);
  const auiRef = useRef(aui);
  const draftHydrationRef = useRef<{ readonly key: string; readonly text: string } | undefined>(undefined);
  const previousDraftKeyRef = useRef<string | undefined>(undefined);
  auiRef.current = aui;
  const consumedDraftRestoreIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousDraftKeyRef.current && previousDraftKeyRef.current !== draftStorageKey) {
      window.localStorage.removeItem(previousDraftKeyRef.current);
    }
    previousDraftKeyRef.current = draftStorageKey;
    const savedDraft = window.localStorage.getItem(draftStorageKey) ?? "";
    draftHydrationRef.current = { key: draftStorageKey, text: savedDraft };
    const composer = auiRef.current.composer;
    if (composer.getState().text !== savedDraft) composer.setText(savedDraft);
  }, [draftStorageKey]);
  useEffect(() => {
    if (!draftRestore || consumedDraftRestoreIdRef.current === draftRestore.id) return;
    consumedDraftRestoreIdRef.current = draftRestore.id;
    draftHydrationRef.current = undefined;
    aui.composer.setText(draftRestore.text);
    onDraftRestoreConsumed(draftRestore.id);
  }, [aui, draftRestore, onDraftRestoreConsumed]);
  useEffect(() => {
    const hydration = draftHydrationRef.current;
    if (hydration?.key === draftStorageKey) {
      if (composerText !== hydration.text) return;
      draftHydrationRef.current = undefined;
    }
    if (composerText) window.localStorage.setItem(draftStorageKey, composerText);
    else window.localStorage.removeItem(draftStorageKey);
  }, [composerText, draftStorageKey]);
  useEffect(() => {
    const input = composerInputRef.current?.querySelector<HTMLElement>('[role="textbox"]');
    if (!input) return;
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
  const selectorModels = useMemo<readonly ModelOption[]>(() => models.map((candidate) => ({
    efforts: reasoningLevels.map((level) => ({ id: level, name: formatReasoningLevel(level, locale) })),
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

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root
        className="relative flex w-full flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!composerDisabled) {
            aui.composer.send();
            blurComposerOnTouch(composerInputRef);
          }
        }}
      >
        <div className="flex w-full flex-col gap-2 rounded-[1.5rem] border border-border/70 bg-background p-2.5 shadow-[0_8px_24px_-16px_rgba(0,0,0,0.24)]">
          {approvalTakeover ? (
            <ApprovalComposerTakeover locale={locale} onRespond={onInputResponses} request={approvalTakeover} />
          ) : (
            <>
              {composerTop}
              <AttachmentGroup className="px-1 py-0.5 empty:hidden">
                <ComposerPrimitive.Attachments>
                  {({ attachment }) => (
                    <ComposerAttachment attachment={attachment} messages={messages} />
                  )}
                </ComposerPrimitive.Attachments>
              </AttachmentGroup>
              <LexicalComposerInput
            aria-disabled={composerDisabled}
            directiveChip={DirectiveChip}
            placeholder={messages.inputPlaceholder}
            ref={composerInputRef}
            submitMode={touchInput ? "ctrlEnter" : "enter"}
            onKeyDownCapture={(event) => {
              if (touchInput || !isRunning || event.key !== "Enter" || event.shiftKey || composerDisabled || composerIsEmpty) return;
              const input = event.target instanceof HTMLElement
                ? event.target.closest<HTMLElement>('[role="textbox"]')
                : null;
              const pickerOpen = input?.getAttribute("aria-expanded") === "true" ||
                Boolean(composerInputRef.current?.querySelector('[data-slot="composer-trigger-popover"][data-state="open"]'));
              if (pickerOpen) return;
              event.preventDefault();
              aui.composer.send();
              blurComposerOnTouch(composerInputRef);
            }}
            className="aui-composer-input relative max-h-40 min-h-12 w-full resize-none overflow-y-auto bg-transparent px-2 py-1 text-[15px] leading-6 outline-none aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:items-center [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-md [&_.aui-directive-chip]:bg-muted [&_.aui-directive-chip]:px-1.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-foreground [&_.aui-directive-chip-icon]:text-muted-foreground [&_.aui-lexical-input]:min-h-6 [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:inset-x-0 [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:truncate [&_.aui-lexical-placeholder]:px-2 [&_.aui-lexical-placeholder]:py-1 [&_.aui-lexical-placeholder]:text-muted-foreground"
              />
              <div className="flex min-h-9 items-center gap-0.5 sm:min-h-8 sm:gap-1">
                <ComposerPrimitive.AddAttachment asChild>
                  <Button aria-label={messages.addFiles} className="size-9 rounded-full text-muted-foreground sm:size-8" size="icon-sm" type="button" variant="ghost">
                    <PlusIcon className="size-4" />
                  </Button>
                </ComposerPrimitive.AddAttachment>
                <ExecutionModeMenu messages={messages} onChange={(executionMode) => onPreferencesChange({ ...preferences, executionMode })} value={preferences.executionMode ?? "standard"} />
                <ModelSelector
              align="start"
              className="h-9 min-w-0 max-w-48 rounded-full px-2 text-muted-foreground sm:h-8 sm:max-w-64"
              contentClassName="w-72 max-w-[calc(100vw-1.5rem)] text-xs"
              effort={preferences.reasoning}
              effortLabel={messages.reasoning}
              models={selectorModels}
              onEffortChange={(reasoning) => onPreferencesChange({ ...preferences, reasoning })}
              onValueChange={(modelId) => onPreferencesChange({ ...preferences, modelId })}
              searchable={models.length > 6}
              size="sm"
              value={model?.id ?? preferences.modelId}
              valueClassName="text-xs font-normal"
              variant="ghost"
              triggerLabel={messages.model}
                />
                <span className="ml-auto flex min-w-0 items-center gap-0.5 sm:gap-1">
              {model ? (
                <ContextDisplay.Ring
                  className="h-9 shrink-0 rounded-full px-1.5 sm:h-8"
                  label={messages.context}
                  labels={contextLabels}
                  modelContextWindow={model.contextWindowTokens}
                  side="top"
                  sessionUsage={sessionUsage}
                  usage={contextUsage}
                />
              ) : null}
              {/**
               * Keep both controls mounted for the lifetime of the composer.
               * Eve emits frequent stream checkpoints; swapping a Cancel
               * primitive for a normal Button at each checkpoint makes the
               * visible control detach while a user is clicking it. A stable
               * DOM anchor preserves the assistant-ui cancellation contract
               * without changing the visual one-button interaction.
               */}
              <ComposerPrimitive.Cancel asChild>
                <Button
                  aria-hidden={!(stopping || (isRunning && composerIsEmpty))}
                  aria-label={cancellationState === "idle" ? messages.cancel : messages.stopping}
                  className={cn("size-9 shrink-0 rounded-full sm:size-8", !(stopping || (isRunning && composerIsEmpty)) && "hidden")}
                  disabled={cancellationState !== "idle" || !(stopping || (isRunning && composerIsEmpty))}
                  size="icon-sm"
                  tabIndex={stopping || (isRunning && composerIsEmpty) ? 0 : -1}
                  type="button"
                >
                  {cancellationState === "idle" ? (
                    <SquareIcon className="size-3.5 fill-current" />
                  ) : (
                    <LoaderCircleIcon className="size-4 animate-spin" />
                  )}
                </Button>
              </ComposerPrimitive.Cancel>
              <Button
                aria-hidden={stopping || (isRunning && composerIsEmpty)}
                aria-label={isRunning ? messages.queueFollowUp : messages.send}
                className={cn("size-9 shrink-0 rounded-full sm:size-8", (stopping || (isRunning && composerIsEmpty)) && "hidden")}
                disabled={composerDisabled || stopping || (isRunning && composerIsEmpty)}
                onClick={() => {
                  aui.composer.send();
                  blurComposerOnTouch(composerInputRef);
                }}
                size="icon-sm"
                tabIndex={stopping || (isRunning && composerIsEmpty) ? -1 : 0}
                type="button"
              >
                <ArrowUpIcon className="size-4" />
              </Button>
                </span>
              </div>
            </>
          )}
        </div>

        <ComposerTriggerPopover char="@" {...mention} emptyItemsLabel={messages.noPromptItems} />
        <ComposerTriggerPopover char="/" {...command} emptyItemsLabel={messages.noPromptItems} />
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}

function blurComposerOnTouch(inputRef: React.RefObject<HTMLDivElement | null>) {
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  window.requestAnimationFrame(() => {
    inputRef.current?.querySelector<HTMLElement>('[role="textbox"]')?.blur();
  });
}

function ComposerAttachment({ attachment, messages }: { readonly attachment: AssistantAttachment; readonly messages: AgentMessages }) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => {
    if (!attachment.file || !attachment.contentType?.startsWith("image/")) {
      setPreviewUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(attachment.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment.contentType, attachment.file]);
  const isImage = attachment.contentType?.startsWith("image/") ?? attachment.type === "image";
  const state = attachment.status.type === "incomplete" ? "error" : attachment.status.type === "running" ? "uploading" : "done";
  if (isImage) {
    return (
      <>
        <Attachment className="size-20 min-w-0 overflow-hidden p-0" orientation="vertical" size="sm" state={state}>
          <AttachmentMedia className="size-full rounded-xl" variant={previewUrl ? "image" : "icon"}>
            {previewUrl ? <img alt={attachment.name} src={previewUrl} /> : <ImageIcon className="size-5" />}
          </AttachmentMedia>
          {previewUrl ? <AttachmentTrigger aria-label={`${messages.attachment}: ${attachment.name}`} onClick={() => setPreviewOpen(true)} /> : null}
          {attachment.status.type === "running" ? (
            <span className="pointer-events-none absolute inset-x-1 bottom-1 z-20 rounded-full bg-background/90 px-1 py-0.5 text-center text-[10px] tabular-nums text-foreground">
              {Math.round(attachment.status.progress)}%
            </span>
          ) : null}
          <AttachmentPrimitive.Remove aria-label={messages.removeAttachment} className="absolute right-1 top-1 z-20 flex size-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground hover:text-foreground">
            <XIcon className="size-3" />
          </AttachmentPrimitive.Remove>
        </Attachment>
        {previewOpen && previewUrl ? (
          <button aria-label={messages.dismiss} className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-4" onClick={() => setPreviewOpen(false)} type="button">
            <img alt={attachment.name} className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain" src={previewUrl} />
          </button>
        ) : null}
      </>
    );
  }
  return (
    <Attachment className="max-w-[min(18rem,calc(100vw-2rem))]" size="sm" state={state}>
      <AttachmentMedia variant="icon"><FileIcon className="size-4" /></AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.name}</AttachmentTitle>
        <AttachmentDescription>
          {attachment.status.type === "running"
            ? `${Math.round(attachment.status.progress)}%`
            : attachment.status.type === "incomplete"
              ? attachment.status.message ?? messages.attachment
              : messages.attachment}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentPrimitive.Remove aria-label={messages.removeAttachment} className="relative z-20 rounded-sm text-muted-foreground hover:text-foreground">
        <XIcon className="size-3" />
      </AttachmentPrimitive.Remove>
    </Attachment>
  );
}

function ApprovalComposerTakeover({
  locale,
  onRespond,
  request,
}: {
  readonly locale: AgentLocale;
  readonly onRespond: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly request: AgentApprovalTakeover;
}) {
  const isZh = locale === "zh-CN";
  const [submitting, setSubmitting] = useState(false);
  const respond = async (optionId: string) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onRespond([{ optionId, requestId: request.requestId }]);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section
      aria-label={isZh ? "工具调用等待批准" : "Tool call awaiting approval"}
      className="flex min-h-28 items-start gap-3 px-1 py-1"
      data-agent-approval-takeover
      role="alertdialog"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300">
        <ShieldCheckIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          {isZh ? `批准工具调用：${approvalToolLabel(request.toolName, locale)}` : `Approve tool call: ${approvalToolLabel(request.toolName, locale)}`}
        </p>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{request.prompt}</p>
        <ApprovalTakeoverDetails input={request.input} toolName={request.toolName} />
        <div className="mt-3 flex justify-end gap-2">
          <Button className="min-w-16" disabled={submitting} onClick={() => void respond("deny")} size="sm" variant="ghost">{isZh ? "拒绝" : "Deny"}</Button>
          <Button className="min-w-16" disabled={submitting} onClick={() => void respond("approve")} size="sm">
            {submitting ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
            {isZh ? "批准" : "Approve"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function ApprovalTakeoverDetails({ input, toolName }: { readonly input: unknown; readonly toolName: string }) {
  if (input === undefined) return null;
  const normalized = toolName.toLocaleLowerCase().replaceAll("-", "_");
  const record = typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
  const command = ["bash", "shell", "terminal", "exec_command"].includes(normalized)
    ? [record?.command, record?.cmd].find((value): value is string => typeof value === "string")
    : undefined;
  let detail: string | undefined = command;
  if (!detail) {
    try {
      detail = typeof input === "string" ? input : JSON.stringify(input, null, 2);
    } catch {
      detail = String(input);
    }
  }
  if (!detail) return null;
  return <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs text-foreground">{detail}</pre>;
}

function approvalToolLabel(toolName: string, locale: AgentLocale): string {
  const normalized = toolName.toLocaleLowerCase().replaceAll("-", "_");
  if (["bash", "shell", "terminal", "exec_command"].includes(normalized)) return locale === "zh-CN" ? "终端命令" : "Terminal command";
  if (["apply_patch", "patch_file", "write_file", "edit_file"].includes(normalized)) return locale === "zh-CN" ? "文件变更" : "File change";
  if (["web_fetch", "fetch_url", "web_search", "search_web"].includes(normalized)) return locale === "zh-CN" ? "网络访问" : "Network access";
  return toolName;
}

function DirectiveChip({ directiveId, directiveType, label }: DirectiveChipProps) {
  const Icon = directiveType === "command" ? SlashIcon : AtSignIcon;
  return (
    <span className="aui-directive-chip" data-directive-id={directiveId} data-directive-type={directiveType}>
      <Icon className="aui-directive-chip-icon size-3" />
      <span>{label}</span>
    </span>
  );
}

function ExecutionModeMenu({
  messages,
  onChange,
  value,
}: {
  readonly messages: AgentMessages;
  readonly onChange: (value: AgentExecutionMode) => void;
  readonly value: AgentExecutionMode;
}) {
  const options: readonly {
    readonly description: string;
    readonly icon: React.ComponentType<{ className?: string }>;
    readonly label: string;
    readonly value: AgentExecutionMode;
  }[] = [
    { description: messages.executionStandardDescription, icon: ShieldCheckIcon, label: messages.executionStandard, value: "standard" },
    { description: messages.executionAutomationDescription, icon: CircleGaugeIcon, label: messages.executionAutomation, value: "automation" },
    { description: messages.executionCautiousDescription, icon: LockKeyholeIcon, label: messages.executionCautious, value: "cautious" },
  ];
  const selected = options.find((option) => option.value === value) ?? options[0]!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={messages.executionMode} className="h-9 max-w-40 gap-1.5 rounded-full px-2.5 text-muted-foreground sm:h-8" type="button" variant="ghost">
          <ShieldCheckIcon className="size-4" />
          <span className="hidden truncate text-xs sm:inline">{selected.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-1.5rem)] text-xs" side="top">
        <DropdownMenuLabel className="text-xs">{messages.executionMode}</DropdownMenuLabel>
        <DropdownMenuRadioGroup onValueChange={(next) => onChange(next as AgentExecutionMode)} value={value}>
          {options.map((option) => {
            const Icon = option.icon;
            return (
              <DropdownMenuRadioItem className="items-start py-2 text-xs" key={option.value} value={option.value}>
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-foreground">{option.label}</span>
                  <span className="mt-0.5 block whitespace-normal text-xs leading-4 text-muted-foreground">{option.description}</span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function formatReasoningLevel(level: string, locale: AgentLocale): string {
  if (locale === "zh-CN") {
    if (level === "low") return "低";
    if (level === "medium") return "中";
    if (level === "high") return "高";
    if (level === "xhigh") return "极高";
  }
  if (level === "xhigh") return "X high";
  if (level === "medium") return "Med";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function localizePromptMenuItem(
  item: AgentPromptMenuItem,
  locale: AgentLocale,
): AgentPromptMenuItem {
  const translation = item.translations?.[locale];
  if (!translation) return item;
  return {
    ...item,
    description: translation.description ?? item.description,
    label: translation.label ?? item.label,
  };
}

function AssistantEmptyState({ messages }: { readonly messages: AgentMessages }) {
  const suggestions = [
    messages.suggestionInspect,
    messages.suggestionImplement,
    messages.suggestionResearch,
    messages.suggestionReview,
  ];
  const aui = useAui();

  return (
    <div className="mx-auto flex min-h-[min(30rem,62vh)] w-full max-w-(--thread-max-width) flex-1 flex-col items-center justify-center gap-5 px-1 pb-6 text-center sm:gap-6 sm:px-2 sm:pb-8">
      <WrenchIcon className="size-8 text-muted-foreground/60" />
      <h1 className="text-2xl font-medium tracking-normal text-foreground">{messages.emptyTitle}</h1>
      <div className="grid w-full grid-cols-1 gap-2 min-[520px]:grid-cols-2">
        {suggestions.map((suggestion, index) => (
          <button
            className={cn(
              "min-h-20 rounded-lg border border-border/70 px-3 py-3 text-left text-sm leading-5 transition-colors hover:bg-muted/50",
              index > 1 && "hidden min-[520px]:block",
            )}
            key={suggestion}
            onClick={() => aui.composer.setText(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
