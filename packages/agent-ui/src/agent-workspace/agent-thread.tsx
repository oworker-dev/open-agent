"use client";

import type { UserContent } from "ai";
import { ClientError, defaultMessageReducer, type ClientSession, type MessageStreamEvent } from "eve/client";
import { useEveAgent, type EveMessage } from "eve/react";
import { AssistantRuntimeProvider, unstable_defaultDirectiveFormatter, useExternalStoreRuntime, type AppendMessage, type ExternalStoreAdapter, type ExternalThreadQueueAdapter, type RespondToToolApprovalOptions } from "@assistant-ui/react";
import { AlertCircleIcon, Clock3Icon, HammerIcon, LoaderCircleIcon, RotateCcwIcon, SearchIcon, ShieldCheckIcon, SparklesIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button.js";
import { cn } from "../utils.js";
import { attachAgentSession, createAgentSession } from "./agent-client.js";
import { createBrowserAttachmentAdapter, createHttpAgentAssetUploadAdapter } from "./browser-asset-upload.js";
import { convertEveMessages, getEveMessageContent } from "./eve-message-adapter.js";
import type { AgentInputResponse } from "./agent-message.js";
import { AssistantThreadSurface, type AgentApprovalTakeover } from "./assistant-thread-surface.js";
import type { AgentInterruptedTurn, AgentModelOption, AgentPendingTurn, AgentPromptMenuItem, AgentQueuedTurn, AgentSessionDeliverable, AgentThread, AgentThreadPatch, AgentTranscriptCoverage, AgentWorkspaceClientConfig, AgentWorkspaceMailbox, PromptInputMessage } from "./contracts.js";
import { sanitizeAgentError } from "./error-presentation.js";
import { AgentMailboxHttpError } from "./http-agent-mailbox.js";
import { messagesFor, type AgentLocale, type AgentMessages } from "./i18n.js";
import {
  interruptedTurnContextFromEvents,
  interruptedTurnContextsFromEvents,
} from "./retained-context.js";
import { appendThreadEvent, appendThreadEventIndexed, dedupeThreadEvents, eventIdentity, projectPendingThreadEdit, projectThreadEditBranches, reconcilePendingTurnWithEvents, titleFromPrompt } from "./thread-storage.js";
import {
  activeTurnIdAfterPendingSubmission,
  hasTerminalSessionBoundary,
  hasSettledLatestTurn,
  isRetryableAgentFailure,
  isProxiedInputOnlyMessage,
  normalizeSettledAgentMessages,
  projectAgentDisplayTimeline,
  shouldSuppressInterruptedTurnDisplayEvent,
  shouldSuppressInterruptedTurnStreamEvent,
  stableUserMessageId,
  unresolvedInputRequests,
  type AgentTurnFailure,
} from "./turn-presentation.js";
import { summarizeUsage } from "./usage.js";

type Cancellation = {
  localTurnId?: string;
  requested: boolean;
  sentSessionId?: string;
  sentTurnId?: string;
  turnId?: string;
};

type LocalInterruption = {
  readonly events: readonly MessageStreamEvent[];
  readonly streamIndex: number;
  readonly turnId: string;
};

const CANCELLATION_STREAM_REATTACH_AFTER_MS = 5_000;
const MAX_PROVIDER_SUBMISSION_RETRIES = 3;
// Thread state is a persistence/cache boundary, not the render clock. Eve
// already publishes the live reducer at frame cadence; checkpoint less often
// so the parent workspace is not rebuilt for every provider fragment.
const LIVE_CHECKPOINT_INTERVAL_MS = 250;

type ProviderRetryState = {
  readonly attempt: number;
  readonly error: AgentTurnFailure;
  readonly exhausted?: boolean;
  readonly maximum: number;
};

// Long tool calls can outlive a browser/proxy connection. Eve resumes from
// its durable cursor, but the default client policy is intentionally short for
// ordinary chat turns. Keep long-running response streams reconnectable without
// changing the server-side durable loop.
const LONG_RUNNING_STREAM_RECONNECT_POLICY = {
  // A missing session is terminal; retry only transport/transient statuses.
  retryableErrorStatuses: [408, 409, 425, 429, 500, 502, 503, 504],
  streamIdleReconnectPolicy: {
    baseDelayMs: 500,
    maxAttempts: 64,
    maxDelayMs: 10_000,
  },
  streamOpenReconnectPolicy: {
    baseDelayMs: 500,
    maxAttempts: 32,
    maxDelayMs: 10_000,
  },
} as const;

export function AgentThreadView({
  client,
  commands,
  draftStorageKey,
  historyHasMore = false,
  historyLoading = false,
  isRecovering = false,
  locale,
  mailbox,
  mentions,
  models,
  onChange,
  onCancelRecovery,
  onEvent,
  onOpenDeliverable,
  onOpenSubagent,
  onLoadEarlier,
  onRetryRecovery,
  onRecoveryNeeded,
  providerReady,
  recoveryError,
  reasoningLevels,
  thread,
}: {
  readonly client?: AgentWorkspaceClientConfig;
  readonly commands: readonly AgentPromptMenuItem[];
  readonly draftStorageKey: string;
  readonly historyHasMore?: boolean;
  readonly historyLoading?: boolean;
  readonly isRecovering?: boolean;
  readonly locale: AgentLocale;
  readonly mailbox?: AgentWorkspaceMailbox;
  readonly mentions: readonly AgentPromptMenuItem[];
  readonly models: readonly AgentModelOption[];
  readonly onChange: (patch: AgentThreadPatch) => void;
  readonly onCancelRecovery?: () => void;
  readonly onEvent?: (event: MessageStreamEvent) => void;
  readonly onOpenDeliverable?: (deliverable: AgentSessionDeliverable) => void;
  readonly onOpenSubagent?: (sessionId: string) => void;
  readonly onLoadEarlier?: () => void;
  readonly onRetryRecovery?: () => void;
  readonly onRecoveryNeeded: () => void;
  readonly providerReady: boolean;
  readonly recoveryError?: string;
  readonly reasoningLevels: readonly string[];
  readonly thread: AgentThread;
}) {
  const preferencesRef = useRef(thread.preferences);
  const latestEventsRef = useRef<readonly MessageStreamEvent[]>(thread.events);
  const persistedCancellationTurnId = thread.status === "cancelling"
    ? latestStartedTurnId(thread.events)
    : undefined;
  const cancellationRef = useRef<Cancellation>({
    ...(persistedCancellationTurnId ? { turnId: persistedCancellationTurnId } : {}),
    requested: thread.status === "cancelling",
  });
  const recoveryRequestedRef = useRef(false);
  const initialEventCountRef = useRef(thread.events.length);
  const initialStreamIndexRef = useRef(thread.session.streamIndex);
  const compactedEventsRef = useRef<MessageStreamEvent[]>([...thread.events]);
  const compactedEventIdsRef = useRef(new Set(thread.events.map(eventIdentity)));
  const consumedStreamIndexRef = useRef(thread.session.streamIndex);
  const coverageStartIndexRef = useRef<number | undefined>(
    thread.transcriptCoverage?.complete === true &&
      thread.transcriptCoverage.complete &&
      thread.transcriptCoverage.endIndex === thread.session.streamIndex
      ? thread.transcriptCoverage.startIndex
      : thread.events.length === 0 && thread.session.streamIndex === 0
        ? 0
        : undefined,
  );
  const checkpointDirtyRef = useRef(false);
  const checkpointTimerRef = useRef<number | undefined>(undefined);
  const flushCheckpointRef = useRef<() => void>(() => undefined);
  const processedEventCountRef = useRef(thread.events.length);
  const durableProbeInFlightRef = useRef(false);
  const lastObservedEventAtRef = useRef(Date.now());
  const queuedTurnsRef = useRef<readonly AgentQueuedTurn[]>(thread.queuedTurns);
  const pendingTurnRef = useRef(thread.pendingTurn);
  const retainedContextRef = useRef(thread.retainedContext);
  const interruptedTurnsRef = useRef<readonly AgentInterruptedTurn[]>(thread.interruptedTurns ?? []);
  const closedInputRequestIdsRef = useRef<ReadonlySet<string>>(new Set(thread.closedInputRequestIds));
  const dispatchingQueuedTurnIdRef = useRef<string | undefined>(undefined);
  const mailboxEnqueueIdsRef = useRef(new Set<string>());
  const turnAdmissionBusyRef = useRef(false);
  const cancellationRecoveryRef = useRef<() => void>(() => undefined);
  const stopAgentRef = useRef<() => void>(() => undefined);
  const persistedThreadStatusRef = useRef<AgentThread["status"]>(thread.status);
  const cancellationIdleTimerRef = useRef<number | undefined>(undefined);
  const [cancellationState, setCancellationState] = useState<"idle" | "requested" | "cancelling">(
    thread.status === "cancelling" ? "cancelling" : "idle",
  );
  const [localInterruption, setLocalInterruption] = useState<LocalInterruption>();
  const [cancellationError, setCancellationError] = useState<string>();
  const [queueError, setQueueError] = useState<string>();
  const [turnError, setTurnError] = useState<string | undefined>(() =>
    // A persisted edit admission intentionally keeps the earlier transcript
    // prefix, which may itself end in a failed turn. That historical failure
    // must not seed the new edit with an error banner while it is clearing and
    // resubmitting; the active turn will publish its own failure if needed.
    isPendingTurnInFlight(thread.pendingTurn) ? undefined : latestTurnFailure(thread.events),
  );
  const [providerRetry, setProviderRetry] = useState<ProviderRetryState | undefined>(undefined);
  const [optimisticPendingTurn, setOptimisticPendingTurn] = useState<AgentPendingTurn | undefined>(undefined);
  const [optimisticDisplayTurn, setOptimisticDisplayTurn] = useState<AgentPendingTurn | undefined>(undefined);
  const providerRetryKeyRef = useRef<string | undefined>(undefined);
  const providerRetryAttemptRef = useRef(0);
  const providerRetryTimerRef = useRef<number | undefined>(undefined);
  const messages = messagesFor(locale);
  const recoveryContextWindowTokens = models.find((model) =>
    model.id === thread.preferences.modelId
  )?.contextWindowTokens ?? models[0]?.contextWindowTokens ?? 272_000;

  const settleCancellationUi = useCallback(() => {
    cancellationRef.current = { requested: false };
    // Keep the stopping affordance visible for one paint after Eve has emitted
    // the authoritative cancellation boundary. The HTTP `accepted` response
    // is deliberately not enough to release the composer.
    setCancellationState("cancelling");
    if (cancellationIdleTimerRef.current !== undefined) {
      window.clearTimeout(cancellationIdleTimerRef.current);
    }
    cancellationIdleTimerRef.current = window.setTimeout(() => {
      cancellationIdleTimerRef.current = undefined;
      if (!cancellationRef.current.requested) setCancellationState("idle");
    }, 100);
  }, []);

  useEffect(() => () => {
    if (cancellationIdleTimerRef.current !== undefined) {
      window.clearTimeout(cancellationIdleTimerRef.current);
    }
    if (providerRetryTimerRef.current !== undefined) {
      window.clearTimeout(providerRetryTimerRef.current);
    }
    // A thread can unmount while a hot Eve stream is waiting for its
    // checkpoint cadence (for example when the user switches sessions).
    // Flush the append-only buffer before teardown so the last observed events
    // are not stranded in this component's refs.
    flushCheckpointRef.current();
    // A component switch must release the Eve transport as well. Eve's store
    // does not automatically abort an in-flight send when its React consumer
    // unmounts; without this, every visited running thread can keep a live
    // stream and stale callbacks in the background.
    stopAgentRef.current();
  }, []);

  useEffect(() => {
    preferencesRef.current = thread.preferences;
  }, [thread.preferences]);

  useEffect(() => {
    queuedTurnsRef.current = thread.queuedTurns;
  }, [thread.queuedTurns]);

  useEffect(() => {
    pendingTurnRef.current = thread.pendingTurn;
  }, [thread.pendingTurn]);

  // The external Eve store publishes its optimistic message only after the
  // async submission preparation phase. Keep the browser-only pending copy
  // visible during that gap; it is removed as soon as the durable thread
  // acknowledges or terminally settles the same admission.
  useEffect(() => {
    if (!optimisticPendingTurn) return;
    const durable = thread.pendingTurn;
    if (durable && (durable.id !== optimisticPendingTurn.id || durable.state === "delivery-failed")) {
      setOptimisticPendingTurn(undefined);
    }
  }, [optimisticPendingTurn, thread.pendingTurn]);

  // A failed durable edit is never an active branch. Clear the separate
  // display-only admission copy as soon as its failure receipt is persisted;
  // otherwise that stale copy can continue hiding the original turn after the
  // mailbox request has already failed.
  useEffect(() => {
    const failedEditId = [thread.pendingTurn, optimisticPendingTurn].find((pending) =>
      pending?.operation === "edit" && pending.state === "delivery-failed"
    )?.id;
    if (!failedEditId) return;
    setOptimisticDisplayTurn((current) => current?.id === failedEditId ? undefined : current);
  }, [optimisticPendingTurn, thread.pendingTurn]);

  useEffect(() => {
    interruptedTurnsRef.current = thread.interruptedTurns ?? [];
  }, [thread.interruptedTurns]);

  useEffect(() => {
    const recoveredContext = interruptedTurnContextsFromEvents(
      thread.events,
      thread.retainedContext,
      recoveryContextWindowTokens,
    );
    retainedContextRef.current = recoveredContext;
    if (!sameContextEntries(recoveredContext, thread.retainedContext)) {
      onChange({ retainedContext: recoveredContext, updatedAt: Date.now() });
    }
  }, [onChange, recoveryContextWindowTokens, thread.events, thread.retainedContext]);

  useEffect(() => {
    closedInputRequestIdsRef.current = new Set(thread.closedInputRequestIds);
  }, [thread.closedInputRequestIds]);

  const [connection] = useState(() =>
    createAgentSession(client, () => preferencesRef.current, thread.session),
  );
  const sessionRef = useRef<ClientSession | undefined>(
    attachAgentSession(connection, connection.initialSession),
  );

  const requestDurableCancellation = useCallback((durableSession: ClientSession, turnId?: string) => {
    const requestState = cancellationRef.current;
    if (!requestState.requested) return;
    if (turnId) {
      if (requestState.sentTurnId === turnId) return;
      requestState.sentTurnId = turnId;
    } else {
      if (requestState.sentSessionId === durableSession.state.sessionId) return;
      requestState.sentSessionId = durableSession.state.sessionId;
    }

    void durableSession.cancel(turnId ? { turnId } : undefined)
      .then((result) => {
        // A late response from an older cancel request must not resurrect the
        // stopping state after Eve has already emitted session.waiting and
        // replaced the cancellation object.
        if (cancellationRef.current !== requestState || !requestState.requested) return;
        if (result.status === "no_active_turn") {
          // Eve reports this only when the target is already parked/terminal.
          // There will be no cancellation boundary to wait for in that case.
          settleCancellationUi();
          onChange({ status: "ready", updatedAt: Date.now() });
          return;
        }
        // `accepted` means the cancellation command is durably queued, not
        // that the running turn has stopped. Keep the composer locked while
        // Eve emits turn.cancelled followed by session.waiting.
        setCancellationState("cancelling");
      })
      .catch((error: unknown) => {
        if (cancellationRef.current !== requestState) return;
        if (cancellationIdleTimerRef.current !== undefined) {
          window.clearTimeout(cancellationIdleTimerRef.current);
          cancellationIdleTimerRef.current = undefined;
        }
        // A lost response is ambiguous: Eve may already have accepted the
        // command. Keep the requested marker and the composer locked so a new
        // turn cannot race the still-running server turn. The next durable
        // stream event (or a recovery attach) will settle it authoritatively.
        requestState.sentTurnId = undefined;
        requestState.sentSessionId = undefined;
        setCancellationError(error instanceof Error ? error.message : "Unable to stop this turn.");
        setCancellationState("cancelling");
      });
  }, [onChange, settleCancellationUi]);

  const handleEvent = useCallback(
    (event: MessageStreamEvent) => {
      lastObservedEventAtRef.current = Date.now();
      // Consume the durable event synchronously with Eve's stream callback.
      // React effects are intentionally not part of this checkpoint: a
      // transport error or recovery remount can happen before an effect sees
      // the event, which previously advanced the absolute cursor while
      // dropping its compact transcript projection.
      const sourceIndex = consumedStreamIndexRef.current;
      const suppressed = shouldSuppressInterruptedTurnStreamEvent(event, sourceIndex, interruptedTurnsRef.current);
      if (!suppressed) {
        appendThreadEventIndexed(compactedEventsRef.current, compactedEventIdsRef.current, event);
      }
      // The cursor belongs to the Eve stream position, not to the compact UI
      // projection. A replayed event can be a duplicate in the local event-id
      // set while still occupying one position in this stream response. Using
      // append success as the cursor gate can therefore pin recovery forever
      // at the same startIndex after a reconnect.
      consumedStreamIndexRef.current = sourceIndex + 1;
      checkpointDirtyRef.current = true;
      if (checkpointTimerRef.current === undefined) {
        checkpointTimerRef.current = window.setTimeout(() => {
          checkpointTimerRef.current = undefined;
          flushCheckpointRef.current();
        }, LIVE_CHECKPOINT_INTERVAL_MS);
      }
      if (event.type === "turn.started") {
        const cancellation = cancellationRef.current;
        cancellation.turnId = event.data.turnId;
        if (cancellation.requested && cancellation.localTurnId) {
          const interruptedTurns = retargetInterruptedTurn(
            interruptedTurnsRef.current,
            cancellation.localTurnId,
            event.data.turnId,
          );
          interruptedTurnsRef.current = interruptedTurns;
          cancellation.localTurnId = event.data.turnId;
          setLocalInterruption((current) => current
            ? { ...current, turnId: event.data.turnId }
            : current);
          onChange({ interruptedTurns, updatedAt: Date.now() });
        }
        const durableSession = sessionRef.current;
        if (durableSession) requestDurableCancellation(durableSession, event.data.turnId);
      }
      // A message receipt is the durable acknowledgement for the optimistic
      // submission. Clear only the pre-session retry banner here; stream
      // recovery for an existing session has its own lifecycle and must not
      // be hidden by an unrelated receipt.
      if (event.type === "message.received" && providerRetryKeyRef.current) {
        providerRetryKeyRef.current = undefined;
        providerRetryAttemptRef.current = 0;
        setProviderRetry(undefined);
      }
      if (event.type === "message.received") {
        // Keep the visual copy until Eve's reducer exposes the matching user
        // row. Clearing the admission copy remains safe, because the visual
        // copy is excluded from busy-state calculations.
        setOptimisticPendingTurn((current) => {
          if (!current) return current;
          if (event.data.clientMessageId === current.id) return undefined;
          if (event.data.clientMessageId) return current;
          const eventIndex = compactedEventsRef.current.lastIndexOf(event);
          const isAfterSubmission = current.eventCountAtSubmission === undefined ||
            eventIndex >= current.eventCountAtSubmission;
          return isAfterSubmission && event.data.message.trim() === current.text.trim() ? undefined : current;
        });

        // Consume a queued admission at the receipt boundary as well. The
        // reducer snapshot and the parent thread checkpoint are intentionally
        // asynchronous; waiting for the next React effect leaves an accepted
        // message rendered both in the transcript and in the follow-up queue.
        // Prefer Eve's client id, then the browser dispatch lane. Do not fall
        // back to text matching because repeated prompts are valid turns.
        const clientMessageId = event.data.clientMessageId;
        const dispatchedId = dispatchingQueuedTurnIdRef.current;
        const acceptedQueuedId = clientMessageId && queuedTurnsRef.current.some((turn) => turn.id === clientMessageId)
          ? clientMessageId
          : dispatchedId && queuedTurnsRef.current.some((turn) => turn.id === dispatchedId)
            ? dispatchedId
            : undefined;
        if (acceptedQueuedId) {
          queuedTurnsRef.current = queuedTurnsRef.current.filter((turn) => turn.id !== acceptedQueuedId);
          if (dispatchingQueuedTurnIdRef.current === acceptedQueuedId) {
            dispatchingQueuedTurnIdRef.current = undefined;
          }
          onChange({ queuedTurns: queuedTurnsRef.current, updatedAt: Date.now() });
        }
      }
      if (event.type === "turn.failed" || event.type === "session.failed") {
        setTurnError(event.data.message);
      }
      if (event.type === "turn.completed" || event.type === "turn.cancelled") {
        setTurnError(undefined);
      }
      if (event.type === "session.waiting" || event.type === "session.completed" || event.type === "session.failed") {
        // The send promise resolves at the durable session boundary. Keep the
        // imperative admission gate in sync as well; a stale `true` here
        // would queue every later user message forever.
        turnAdmissionBusyRef.current = false;
      }
      if (event.type === "turn.cancelled") {
        const settledInterruptedTurns = settleInterruptedTurn(
          interruptedTurnsRef.current,
          event.data.turnId,
          sourceIndex + 1,
        );
        if (settledInterruptedTurns !== interruptedTurnsRef.current) {
          interruptedTurnsRef.current = settledInterruptedTurns;
          onChange({ interruptedTurns: settledInterruptedTurns, updatedAt: Date.now() });
        }
        setCancellationState("cancelling");
      }
      if (
        event.type === "session.waiting" &&
        cancellationRef.current.requested &&
        hasCancellationBoundary(compactedEventsRef.current, cancellationRef.current.turnId)
      ) {
        settleCancellationUi();
      }
      onEvent?.(event);
    },
    [onChange, onEvent, requestDurableCancellation, settleCancellationUi],
  );

  const agent = useEveAgent({
    auth: connection.auth,
    headers: connection.headers,
    host: connection.host,
    initialEvents: thread.events,
    initialSession: connection.initialSession,
    // The workspace owns the single pending-turn projection. Eve's default
    // optimistic `client.message.submitted` event is intentionally disabled:
    // admission retries would otherwise append one optimistic user message
    // per attempt before the durable `message.received` acknowledgement.
    optimistic: false,
    onError: (error) => {
      // A response stream can fail after Eve has durably accepted the turn
      // (for example ERR_INCOMPLETE_CHUNKED_ENCODING from a proxy). Treat
      // transport errors as a reconnect signal, not as a failed Agent turn;
      // the workspace remounts this view and catches up from the saved cursor.
      if (
        isRecoverableStreamError(error) &&
        Boolean(sessionRef.current?.state.sessionId) &&
        !isRecovering &&
        !cancellationRef.current.requested &&
        !recoveryRequestedRef.current &&
        !hasSettledLatestTurn(latestEventsRef.current)
      ) {
        recoveryRequestedRef.current = true;
        flushCheckpointRef.current();
        setTurnError(undefined);
        onRecoveryNeeded();
      }
    },
    onEvent: handleEvent,
    onSessionChange: (nextSession) => {
      sessionRef.current = attachAgentSession(connection, nextSession);
      // The transport cursor may move before React commits the matching
      // events. Persist only a newly assigned session id here; the event
      // persistence effect below owns the absolute UI-consumed cursor.
      if (nextSession?.sessionId && nextSession.sessionId !== thread.session.sessionId) {
        onChange({
          session: {
            sessionId: nextSession.sessionId,
            streamIndex: consumedStreamIndexRef.current,
          },
        });
      }
      if (sessionRef.current && cancellationRef.current.requested) {
        requestDurableCancellation(sessionRef.current, cancellationRef.current.turnId);
      }
    },
    prepareSend: client?.prepareSend,
    ...(sessionRef.current ? { session: sessionRef.current } : {}),
  });
  const stopAgent = agent.stop;
  stopAgentRef.current = stopAgent;

  // An initial ClientSession is attached before useEveAgent installs its
  // onSessionChange callback. A refresh during cancellation can therefore
  // miss the normal callback and leave Eve running without reissuing cancel.
  // Reconcile the persisted cancelling state explicitly on every attach.
  useEffect(() => {
    const attachedSession = sessionRef.current;
    // `useEveAgent` may publish its first snapshot without the externally
    // supplied session while it is wiring callbacks. The attached session is
    // already authoritative at this point, so do not gate cancellation on the
    // hook snapshot alone. This is the refresh boundary that prevents a
    // persisted `cancelling` thread from silently continuing on the server.
    if (
      !cancellationRef.current.requested ||
      thread.status !== "cancelling" ||
      !attachedSession?.state.sessionId
    ) return;
    requestDurableCancellation(attachedSession, persistedCancellationTurnId);
  }, [agent.session?.sessionId, persistedCancellationTurnId, requestDurableCancellation, thread.status]);

  const flushLiveCheckpoint = useCallback(() => {
    if (checkpointTimerRef.current !== undefined) {
      window.clearTimeout(checkpointTimerRef.current);
      checkpointTimerRef.current = undefined;
    }
    if (!checkpointDirtyRef.current) return;
    checkpointDirtyRef.current = false;
    const sessionState = agent.session ?? sessionRef.current?.state;
    const coverageStart = coverageStartIndexRef.current;
    const coverage: AgentTranscriptCoverage | undefined = coverageStart === undefined
      ? undefined
      : {
          complete: true,
          endIndex: consumedStreamIndexRef.current,
          startIndex: coverageStart,
          version: 1,
        };
    onChange({
      events: [...compactedEventsRef.current],
      ...(coverage ? { transcriptCoverage: coverage } : {}),
      session: sessionState
        ? { ...sessionState, streamIndex: consumedStreamIndexRef.current }
        : { streamIndex: consumedStreamIndexRef.current },
      updatedAt: Date.now(),
    });
  }, [agent.session, onChange]);
  flushCheckpointRef.current = flushLiveCheckpoint;

  // File edits can emit hundreds of cumulative action.input.partial events.
  // Keep Eve's authoritative state and cursor live on every event, while
  // coalescing the expensive message/diff projection to a bounded cadence.
  // Unlike useDeferredValue, this cannot be starved by a continuous stream of
  // external-store updates: the latest snapshot is always published after the
  // same short interval.
  const liveRenderSource = useMemo(
    () => ({ events: agent.events, messages: agent.data.messages }),
    [agent.data.messages, agent.events],
  );
  const liveRenderSnapshot = useThrottledSnapshot(liveRenderSource, 50);
  const renderEvents = liveRenderSnapshot.events;
  const renderMessages = liveRenderSnapshot.messages;
  // Recovery is owned by the workspace so it can reconnect from Eve's durable
  // cursor. Feed that same snapshot into the visible thread while recovery is
  // active; otherwise useEveAgent's initialEvents store would stay frozen until
  // the recovery remount completed and the UI would appear stuck.
  const recoveryRenderEvents = useThrottledSnapshot(thread.events, 75);
  const recoveryRenderMessages = useMemo(
    () => isRecovering ? messagesFromEvents(recoveryRenderEvents) : [],
    [isRecovering, recoveryRenderEvents],
  );
  const effectiveRenderEvents = isRecovering ? recoveryRenderEvents : renderEvents;
  const effectiveRenderMessages = isRecovering ? recoveryRenderMessages : renderMessages;
  const pendingEditOperation = optimisticPendingTurn ?? thread.pendingTurn;
  const pendingEditTurnId = pendingEditOperation?.operation === "edit" &&
    isPendingTurnInFlight(pendingEditOperation)
    ? pendingEditOperation.beforeTurnId
    : undefined;
  const projectionEvents = useMemo(
    () => projectPendingThreadEdit(
      projectThreadEditBranches(effectiveRenderEvents),
      pendingEditTurnId,
    ),
    [effectiveRenderEvents, pendingEditTurnId],
  );
  const projectionMessages = useMemo(
    () => pendingEditTurnId || projectionEvents !== effectiveRenderEvents
      ? messagesFromEvents(projectionEvents)
      : effectiveRenderMessages,
    [effectiveRenderEvents, effectiveRenderMessages, pendingEditTurnId, projectionEvents],
  );

  const runtimeIsBusy = agent.status === "submitted" || agent.status === "streaming";
  const admissionPendingTurn = optimisticPendingTurn ?? thread.pendingTurn;
  const displayPendingCandidate = optimisticDisplayTurn ?? optimisticPendingTurn ?? thread.pendingTurn;
  // A failed durable edit never became the active conversation branch. Keep
  // its failure receipt for diagnostics/retry, but restore the original user
  // turn instead of rendering the edited text as an unacknowledged send.
  const failedEditOperationId = [optimisticPendingTurn, thread.pendingTurn].find((pending) =>
    pending?.operation === "edit" && pending.state === "delivery-failed"
  )?.id;
  const displayPendingTurn = displayPendingCandidate?.operation === "edit" &&
    (displayPendingCandidate.state === "delivery-failed" || displayPendingCandidate.id === failedEditOperationId)
    ? undefined
    : displayPendingCandidate;
  latestEventsRef.current = agent.events;
  const durableSessionSettled = hasSettledSessionBoundary(thread.events);
  const localSessionSettled = hasSettledSessionBoundary(agent.events);
  // A recovery worker can commit session.waiting before the mounted Eve hook
  // receives the same tail. Keep the durable boundary authoritative across
  // the recovery hand-off so a stale local `isRunning` snapshot cannot reopen
  // a completed composer or trigger another follow stream.
  const authoritativeEvents = isRecovering || (durableSessionSettled && !localSessionSettled)
    ? thread.events
    : agent.events;
  const sessionHasResumableBoundary = hasSettledSessionBoundary(authoritativeEvents) &&
    !hasTerminalSessionBoundary(authoritativeEvents);
  // A stream can surface a terminal admission error before the corresponding
  // lifecycle event reaches the mounted reducer. Treat only a known,
  // non-retryable local error as terminal here; transient transport/provider
  // errors must keep the retry path and editable state alive.
  const localTerminalError = agent.status === "error" && agent.error
    ? !isRetryableAgentFailure(toAgentFailure(agent.error))
    : false;
  // A provider/session admission can fail before the mounted Eve reducer
  // receives the durable `session.failed` event. The workspace still records
  // `status: error` and the session id in that case. Treat that combination as
  // terminal immediately so the edit affordance cannot disappear only after a
  // refresh. A turn-level failure that ends in `session.waiting` remains
  // editable because that session is resumable.
  const sessionTerminal = hasTerminalSessionBoundary(authoritativeEvents) ||
    localTerminalError ||
    (thread.status === "error" &&
      Boolean(thread.session.sessionId) &&
      !sessionHasResumableBoundary);
  // A durable turn boundary is authoritative. React stream state can remain
  // stale after a reconnect even though Eve has already parked the session.
  // A previous turn's `session.waiting` boundary must not hide the optimistic
  // admission for a new message whose POST/stream has not produced its own
  // `message.received` receipt yet. Reconcile against the latest receipt
  // instead of using the session's historical settled flag; otherwise the
  // second message briefly loses both its thinking placeholder and running
  // state until the first model output arrives.
  const pendingTurnAccepted = admissionPendingTurn !== undefined &&
    reconcilePendingTurnWithEvents(admissionPendingTurn, authoritativeEvents) === undefined;
  const pendingTurnInFlight = isPendingTurnInFlight(admissionPendingTurn) && !pendingTurnAccepted;
  const durableTurnSettled = !pendingTurnInFlight &&
    hasSettledLatestTurn(authoritativeEvents) &&
    hasSettledSessionBoundary(authoritativeEvents);
  // A bounded Eve stream can close at its current durable tail while the
  // session is still executing. In that window `agent.status` may already be
  // idle even though the latest persisted turn has no terminal boundary. Keep
  // the Composer's stable stop control available until Eve reports completion,
  // cancellation, failure, or waiting.
  const durableTurnOpen = !pendingTurnInFlight && !durableTurnSettled &&
    thread.status !== "ready" && thread.status !== "error" &&
    authoritativeEvents.some((event) => event.type === "turn.started");
  const cancellationSettling = cancellationRef.current.requested || thread.status === "cancelling";
  const agentIsBusy = (runtimeIsBusy || durableTurnOpen) && !localInterruption && !cancellationSettling && !durableTurnSettled;
  const isBusy = pendingTurnInFlight || agentIsBusy ||
    (isRecovering && !localInterruption && !cancellationSettling && !durableTurnSettled);

  // Eve publishes the receipt before its reducer publishes the corresponding
  // user message. Keep a display-only copy through that handoff; admission
  // state is still cleared at the receipt so completed turns can settle.
  useEffect(() => {
    const pending = optimisticDisplayTurn;
    if (!pending || !hasVisiblePendingUserMessage(pending, effectiveRenderMessages, authoritativeEvents)) return;
    setOptimisticDisplayTurn(undefined);
  }, [authoritativeEvents, effectiveRenderMessages, optimisticDisplayTurn]);

  // Recovery is owned by the workspace and can publish the durable receipt
  // without passing through Eve's live `onEvent` callback. Clear the admission
  // projection from the same receipt + rendered-row invariant so an edited
  // user message is never shown twice after the mailbox hand-off.
  useEffect(() => {
    const pending = optimisticPendingTurn;
    if (!pending || !hasVisiblePendingUserMessage(pending, effectiveRenderMessages, authoritativeEvents)) return;
    setOptimisticPendingTurn(undefined);
  }, [authoritativeEvents, effectiveRenderMessages, optimisticPendingTurn]);

  const admissionBusy = pendingTurnInFlight || (!durableTurnSettled &&
    (runtimeIsBusy || isRecovering || cancellationSettling));
  const pendingInputRequests = unresolvedInputRequests(authoritativeEvents, closedInputRequestIdsRef.current);
  const approvalRequest = pendingInputRequests.find((request) => request.kind === "tool-approval");
  const approvalTakeover: AgentApprovalTakeover | undefined = approvalRequest
    ? {
        input: approvalRequest.action.input,
        requestId: approvalRequest.requestId,
        prompt: approvalRequest.prompt,
        toolName: approvalRequest.action.toolName,
      }
    : undefined;
  const awaitingInput = pendingInputRequests.length > 0;
  // Questions are non-blocking from the composer: a new message is a normal
  // follow-up and Eve clears the pending question. Approvals remain locked so
  // unrelated text cannot accidentally be interpreted as a permission choice.
  const inputLocked = pendingInputRequests.some((request) => request.kind !== "question");

  const closeInputRequests = useCallback((requestIds: readonly string[]) => {
    if (requestIds.length === 0) return;
    const next = new Set(closedInputRequestIdsRef.current);
    for (const requestId of requestIds) next.add(requestId);
    closedInputRequestIdsRef.current = next;
    onChange({ closedInputRequestIds: [...next] });
  }, [onChange]);

  useEffect(() => {
    turnAdmissionBusyRef.current = admissionBusy;
  }, [admissionBusy]);

  const requestRecovery = useCallback(() => {
    if (recoveryRequestedRef.current) return;
    const state = agent.session;
    if (!state) return;
    flushLiveCheckpoint();
    // The ClientSession passed to useEveAgent owns the live transport and may
    // advance its internal cursor before React commits the corresponding event.
    // Recover from the last cursor the UI has actually observed, otherwise a
    // half-open connection can make the replacement stream skip durable events.
    const currentSession = {
      ...state,
      streamIndex: consumedStreamIndexRef.current,
    };
    recoveryRequestedRef.current = true;
    onChange({
      session: currentSession,
      status: cancellationRef.current.requested ? "cancelling" : "streaming",
      updatedAt: Date.now(),
    });
    stopAgent();
    onRecoveryNeeded();
  }, [agent.session, flushLiveCheckpoint, onChange, onRecoveryNeeded, stopAgent]);
  cancellationRecoveryRef.current = requestRecovery;

  useEffect(() => {
    if (
      isRecovering || !cancellationSettling || !agent.session?.sessionId ||
      recoveryRequestedRef.current
    ) return;
    const timer = window.setTimeout(() => {
      if (
        cancellationRef.current.requested &&
        Date.now() - lastObservedEventAtRef.current >= CANCELLATION_STREAM_REATTACH_AFTER_MS
      ) requestRecovery();
    }, CANCELLATION_STREAM_REATTACH_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [agent.events.length, agent.session?.sessionId, cancellationSettling, isRecovering, requestRecovery]);

  useEffect(() => {
    const lastEvent = agent.events.at(-1);
    if (
      agent.session?.sessionId &&
      !isRecovering &&
      thread.status !== "ready" &&
      thread.pendingTurn?.state !== "resubmitting" &&
      !cancellationRef.current.requested &&
      !isBusy &&
      // The recovery worker may have already persisted the terminal boundary
      // while this mounted Eve client still has the old event snapshot. Use
      // the durable thread transcript as the guard so a settled recovery is
      // not immediately reopened by the stale client stream.
      !hasSettledLatestTurn(thread.events) &&
      !hasSettledLatestTurn(agent.events) &&
      lastEvent &&
      !isSessionBoundary(lastEvent)
    ) {
      requestRecovery();
    }
  }, [agent.events, agent.session?.sessionId, isBusy, isRecovering, requestRecovery, thread.pendingTurn?.state, thread.status]);

  useEffect(() => {
    const sessionId = agent.session?.sessionId;
    if (isRecovering || !agentIsBusy || !sessionId || recoveryRequestedRef.current) return;
    let disposed = false;
    let timer: number | undefined;
    const probe = async () => {
      if (disposed || durableProbeInFlightRef.current || recoveryRequestedRef.current) return;
      durableProbeInFlightRef.current = true;
      try {
        const consumedEvents = Math.max(0, agent.events.length - initialEventCountRef.current);
        const cursor = initialStreamIndexRef.current + consumedEvents;
        // A bounded read mutates its ClientSession cursor. Never probe with
        // the session that owns the live turn or its cursor can advance past
        // events React has not consumed, making recovery permanently skip
        // those events.
        const probeSession = connection.client.sessions.attach(
          sessionId,
          { streamIndex: cursor },
        );
        const durableProgress = await hasDurableProgressAfter(probeSession, cursor);
        // Provider calls can legitimately stay silent for minutes. Reattach
        // only when Eve's durable cursor proves that this page missed events;
        // elapsed silence alone cannot distinguish a slow model from a dead
        // browser transport.
        if (durableProgress) requestRecovery();
      } finally {
        durableProbeInFlightRef.current = false;
      }
      if (!disposed && !recoveryRequestedRef.current) {
        timer = window.setTimeout(probe, DURABLE_PROGRESS_PROBE_INTERVAL_MS);
      }
    };
    timer = window.setTimeout(probe, DURABLE_PROGRESS_PROBE_DELAY_MS);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [agent.events.length, agent.session?.sessionId, agentIsBusy, connection.client, isRecovering, requestRecovery]);

  useEffect(() => {
    if (isRecovering) return;
    // Recovery can settle the durable transcript before this mounted Eve
    // client receives the same tail. Do not project that stale client
    // snapshot back over a confirmed terminal/waiting boundary.
    if (
      (thread.status === "ready" || thread.status === "waiting") &&
      hasSettledLatestTurn(thread.events) &&
      !hasSettledLatestTurn(agent.events)
    ) return;
    const previousEventCount = processedEventCountRef.current;
    const snapshotReplaced = agent.events.length < previousEventCount;
    // Eve can replace its in-memory snapshot after a reconnect or context
    // rewrite. A shorter snapshot is not evidence that the durable transcript
    // became shorter; replacing `compactedEventsRef` here used to erase every
    // earlier turn while leaving the absolute cursor unchanged. Merge the
    // snapshot by event identity and keep the append-only projection intact.
    const newEvents = snapshotReplaced
      ? agent.events
      : agent.events.slice(previousEventCount);
    const localInterruptedRecord = localInterruption
      ? interruptedTurnsRef.current.find((turn) => turn.turnId === localInterruption.turnId)
      : undefined;
    const persistenceInterruptedTurns = localInterruption
      ? upsertInterruptedTurn(interruptedTurnsRef.current, {
          eventCount: localInterruption.events.length,
          streamIndex: localInterruption.streamIndex,
          turnId: localInterruption.turnId,
          ...(localInterruptedRecord?.settled !== undefined ? { settled: localInterruptedRecord.settled } : { settled: false }),
        })
      : interruptedTurnsRef.current;
    const persistableNewEvents = snapshotReplaced
      // The replacement snapshot has no stable absolute offset. It is an
      // already-observed view, so never apply an absolute interruption range
      // to it; event identity deduplication below makes this merge idempotent.
      ? newEvents
      : newEvents.filter((event, index) =>
          !shouldSuppressInterruptedTurnDisplayEvent(
            event,
            processedEventCountRef.current + index,
            persistenceInterruptedTurns,
          )
        );
    const streamIndex = consumedStreamIndexRef.current;
    const coverageStart = coverageStartIndexRef.current;
    for (const event of persistableNewEvents) {
      appendThreadEventIndexed(compactedEventsRef.current, compactedEventIdsRef.current, event);
    }
    // Keep the append-only checkpoint lossless. Settled-turn cleanup is a
    // display projection; applying it here used to erase failed tool input
    // and empty step boundaries from the durable transcript, which made a
    // reconnect appear to have lost Agent steps.
    processedEventCountRef.current = agent.events.length;
    const acceptedMessages = persistableNewEvents.filter((event) => event.type === "message.received");
    const cancelledTurn = persistableNewEvents.findLast((event) => event.type === "turn.cancelled");
    let retainedContext = retainedContextRef.current;
    if (cancelledTurn?.type === "turn.cancelled") {
      retainedContext = interruptedTurnContextFromEvents(
        compactedEventsRef.current,
        cancelledTurn.data.turnId,
        retainedContext,
        recoveryContextWindowTokens,
      );
      retainedContextRef.current = retainedContext;
    }
    let acceptedPendingTurn = false;
    let acceptedQueuedTurn = false;
    // A recovery remount may start with a durable event prefix that already
    // contains the submitted message, while the browser checkpoint still
    // carries `pendingTurn: submitting`. Clear that stale admission even when
    // no new `message.received` event arrives in this mount.
    const persistedPendingTurn = pendingTurnRef.current;
    if (persistedPendingTurn && !reconcilePendingTurnWithEvents(persistedPendingTurn, compactedEventsRef.current)) {
      pendingTurnRef.current = undefined;
      acceptedPendingTurn = true;
    }
    for (const event of acceptedMessages) {
      const clientMessageId = event.data.clientMessageId;
      if (clientMessageId) {
        const queueLength = queuedTurnsRef.current.length;
        queuedTurnsRef.current = queuedTurnsRef.current.filter((turn) => turn.id !== clientMessageId);
        acceptedQueuedTurn ||= queuedTurnsRef.current.length !== queueLength;
        if (dispatchingQueuedTurnIdRef.current === clientMessageId) {
          dispatchingQueuedTurnIdRef.current = undefined;
        }
        if (pendingTurnRef.current?.id === clientMessageId) {
          pendingTurnRef.current = undefined;
          acceptedPendingTurn = true;
        }
        continue;
      }

      const dispatchedId = dispatchingQueuedTurnIdRef.current;
      if (dispatchedId) {
        queuedTurnsRef.current = queuedTurnsRef.current.filter((turn) => turn.id !== dispatchedId);
        dispatchingQueuedTurnIdRef.current = undefined;
        acceptedQueuedTurn = true;
      }
      if (pendingTurnRef.current) {
        const pending = pendingTurnRef.current;
        const eventIndex = compactedEventsRef.current.lastIndexOf(event);
        const isAfterSubmission = pending.eventCountAtSubmission === undefined ||
          eventIndex >= pending.eventCountAtSubmission;
        if (!isAfterSubmission || event.data.message.trim() !== pending.text.trim()) continue;
        pendingTurnRef.current = undefined;
        acceptedPendingTurn = true;
      }
    }
    const nextStatus: AgentThread["status"] = cancellationRef.current.requested
      ? "cancelling"
      : turnError ? "error" : awaitingInput ? "waiting" : agent.status;
    const metadataChanged = acceptedPendingTurn || acceptedQueuedTurn ||
      cancelledTurn !== undefined || nextStatus !== persistedThreadStatusRef.current;
    if (metadataChanged) {
      // Live event ingestion is checkpointed by handleEvent. This effect only
      // publishes a parent update when admission or lifecycle metadata changes;
      // a 16ms Eve snapshot must never rebuild the whole workspace by itself.
      persistedThreadStatusRef.current = nextStatus;
      onChange({
        // The recovery buffer is mutated in place for linear-time ingestion.
        // Never let that mutable array escape into React or storage state.
        events: [...compactedEventsRef.current],
        ...(acceptedPendingTurn ? { pendingTurn: undefined } : {}),
        ...(acceptedQueuedTurn ? { queuedTurns: queuedTurnsRef.current } : {}),
        ...(cancelledTurn ? { retainedContext } : {}),
        ...(coverageStart === undefined ? {} : {
          transcriptCoverage: {
            complete: true,
            endIndex: streamIndex,
            startIndex: coverageStart,
            version: 1 as const,
          },
        }),
        session: agent.session ? { ...agent.session, streamIndex } : { streamIndex },
        status: nextStatus,
        updatedAt: Date.now(),
      });
    }
  }, [agent.events, agent.session, agent.status, awaitingInput, isRecovering, localInterruption, onChange, recoveryContextWindowTokens, turnError]);

  const hasTurnFailure = Boolean(latestTurnFailure(authoritativeEvents));
  // Turn/step failures are rendered against their exact execution step by the
  // transcript projection. Do not also surface the transient React `turnError`
  // banner: it races the durable event reducer and used to flash at the bottom
  // of the conversation before disappearing. Only transport/recovery errors
  // without a durable failure use the global runtime banner.
  const transportError = agent.error?.message;
  const errorMessage = !hasTurnFailure
    ? cancellationError ?? (transportError && !isRecoverableStreamError(agent.error) ? transportError : undefined)
    : undefined;
  const runtimeError = recoveryError
    ? sanitizeAgentError(recoveryError)
    : !hasTurnFailure && (providerRetry || turnError || errorMessage)
      ? sanitizeAgentError(providerRetry?.error.message ?? turnError ?? errorMessage ?? "The Agent request failed.")
      : undefined;
  const runtimeFailure: AgentTurnFailure | undefined = recoveryError
    ? { code: "agent_recovery_failed", message: recoveryError }
    : agent.error
      ? toAgentFailure(agent.error)
      : turnError
        ? { code: "agent_turn_failed", message: turnError }
        : undefined;
  const usage = summarizeUsage(agent.events);

  // Eve owns retries inside a durable model step. A failed HTTP submission is
  // outside that loop, however, so a transient gateway response before a
  // session id exists needs one small client-side admission retry. Once Eve
  // has assigned a session, recovery owns the stream and we never resend a
  // potentially accepted request.
  useEffect(() => {
    const error = agent.error;
    const pending = thread.pendingTurn ?? pendingTurnRef.current;
    if (
      !error ||
      !pending ||
      pending.state !== "submitting" ||
      !providerReady ||
      agent.session?.sessionId ||
      !isRetryableSubmissionError(error) ||
      providerRetry?.exhausted
    ) return;

    const failure = toAgentFailure(error);
    // Retry budget belongs to one admission, not to one diagnostic string.
    // Providers often change the message/code between attempts; including
    // those fields in the key reset the counter and could retry forever.
    const key = pending.id;
    if (providerRetryKeyRef.current !== key) {
      providerRetryKeyRef.current = key;
      providerRetryAttemptRef.current = 0;
      setProviderRetry(undefined);
    }
    if (providerRetryTimerRef.current !== undefined) return;

    const nextAttempt = providerRetryAttemptRef.current + 1;
    if (nextAttempt > MAX_PROVIDER_SUBMISSION_RETRIES) {
      const failedPendingTurn = { ...pending, state: "delivery-failed" as const };
      pendingTurnRef.current = failedPendingTurn;
      turnAdmissionBusyRef.current = false;
      setProviderRetry({
        attempt: MAX_PROVIDER_SUBMISSION_RETRIES,
        error: failure,
        exhausted: true,
        maximum: MAX_PROVIDER_SUBMISSION_RETRIES,
      });
      setTurnError(failure.message);
      onChange({ pendingTurn: failedPendingTurn, status: "error", updatedAt: Date.now() });
      return;
    }

    providerRetryAttemptRef.current = nextAttempt;
    setProviderRetry({
      attempt: nextAttempt,
      error: failure,
      maximum: MAX_PROVIDER_SUBMISSION_RETRIES,
    });
    providerRetryTimerRef.current = window.setTimeout(() => {
      providerRetryTimerRef.current = undefined;
      if (pendingTurnRef.current?.id !== pending.id) return;
      void sendPrompt(agent.send, {
        files: pending.files ?? [],
        text: pending.text,
      }, thread.retainedContext).then(() => {
        if (pendingTurnRef.current?.id === pending.id) turnAdmissionBusyRef.current = false;
      }).catch((retryError: unknown) => {
        // send() normally reports errors through useEveAgent's error state;
        // this catch covers host adapters that reject before reaching Eve.
        setTurnError(retryError instanceof Error ? retryError.message : "Agent request failed.");
      });
    }, providerRetryDelay(nextAttempt));
  }, [agent.error, agent.send, agent.session?.sessionId, onChange, providerReady, providerRetry?.exhausted, thread.pendingTurn, thread.retainedContext]);

  useEffect(() => {
    if (
      agent.status === "error" &&
      thread.pendingTurn?.state === "submitting"
    ) {
      const dispatchedId = dispatchingQueuedTurnIdRef.current;
      const transientSubmission = isRetryableSubmissionError(agent.error) &&
        !agent.session?.sessionId &&
        !providerRetry?.exhausted;
      if (transientSubmission) return;
      if (dispatchedId) {
        const queuedTurns = queuedTurnsRef.current.map((turn) =>
          turn.id === dispatchedId ? { ...turn, state: "delivery-failed" as const } : turn,
        );
        queuedTurnsRef.current = queuedTurns;
        dispatchingQueuedTurnIdRef.current = undefined;
        onChange({ pendingTurn: undefined, queuedTurns });
      } else if (!agent.session?.sessionId) {
        const failedPendingTurn = { ...thread.pendingTurn, state: "delivery-failed" as const };
        pendingTurnRef.current = failedPendingTurn;
        turnAdmissionBusyRef.current = false;
        onChange({ pendingTurn: failedPendingTurn, status: "error", updatedAt: Date.now() });
        setTurnError(agent.error?.message ?? messages.queueDeliveryFailed);
      }
    }
  }, [agent.error, agent.session?.sessionId, agent.status, messages.queueDeliveryFailed, onChange, providerRetry?.exhausted, thread.pendingTurn]);

  const prepareTurn = () => {
    recoveryRequestedRef.current = false;
    if (cancellationIdleTimerRef.current !== undefined) {
      window.clearTimeout(cancellationIdleTimerRef.current);
      cancellationIdleTimerRef.current = undefined;
    }
    cancellationRef.current = { requested: false };
    setLocalInterruption(undefined);
    setCancellationError(undefined);
    setCancellationState("idle");
    setTurnError(undefined);
    providerRetryKeyRef.current = undefined;
    providerRetryAttemptRef.current = 0;
    if (providerRetryTimerRef.current !== undefined) {
      window.clearTimeout(providerRetryTimerRef.current);
      providerRetryTimerRef.current = undefined;
    }
    setProviderRetry(undefined);
  };

  // Recovery is owned by the workspace and therefore does not invoke the
  // live agent event callback above. Mirror only the durable cancellation
  // boundary back into the local control. A generic `ready` status is not
  // sufficient because it can be produced by a stale checkpoint or a normal
  // completed turn while the cancellation request is still in flight.
  useEffect(() => {
    if (!cancellationRef.current.requested) return;
    if (hasCancellationBoundary(thread.events, cancellationRef.current.turnId)) {
      settleCancellationUi();
    }
  }, [settleCancellationUi, thread.events]);

  const updateQueuedTurns = (queuedTurns: readonly AgentQueuedTurn[]) => {
    if (sameQueuedTurnSnapshots(queuedTurnsRef.current, queuedTurns)) return;
    queuedTurnsRef.current = queuedTurns;
    onChange({ queuedTurns, updatedAt: Date.now() });
  };

  const markQueuedTurnForRetry = (turnId: string) => {
    setQueueError(undefined);
    const turn = queuedTurnsRef.current.find((candidate) => candidate.id === turnId);
    if (!turn) return;
    if (turn.delivery === "server" && turn.mailboxItemId && mailbox) {
      void mailbox.retry(turn.mailboxItemId)
        .then(() => updateQueuedTurns(queuedTurnsRef.current.map((candidate) =>
          candidate.id === turnId ? { ...candidate, state: "queued" } : candidate,
        )))
        .catch((error: unknown) => setQueueError(
          error instanceof Error ? error.message : messages.queueDeliveryFailed,
        ));
      return;
    }
    updateQueuedTurns(queuedTurnsRef.current.map((candidate) =>
      candidate.id === turnId ? { ...candidate, state: "queued" } : candidate,
    ));
  };

  const removeQueuedTurn = (turnId: string) => {
    if (dispatchingQueuedTurnIdRef.current === turnId) return;
    setQueueError(undefined);
    const turn = queuedTurnsRef.current.find((candidate) => candidate.id === turnId);
    if (!turn) return;
    if (turn.delivery === "server" && turn.mailboxItemId && mailbox) {
      if (!mailboxTurnIsCancellable(turn)) return;
      void mailbox.cancel(turn.mailboxItemId)
        .then((receipt) => reconcileMailboxReceipt(turnId, receipt))
        .catch(async (error: unknown) => {
          if (
            error instanceof AgentMailboxHttpError &&
            error.code === "mailbox_item_not_cancellable"
          ) {
            try {
              const receipt = await mailbox.inspect(turn.mailboxItemId!);
              reconcileMailboxReceipt(turnId, receipt);
              return;
            } catch {
              // Fall through to the actionable delivery error below.
            }
          }
          setQueueError(error instanceof Error ? error.message : messages.queueDeliveryFailed);
        });
      return;
    }
    updateQueuedTurns(queuedTurnsRef.current.filter((candidate) => candidate.id !== turnId));
  };

  function reconcileMailboxReceipt(
    turnId: string,
    receipt: import("./contracts.js").AgentMailboxReceipt,
  ) {
    const state = mailboxTurnState(receipt.status);
    updateQueuedTurns(state === "cancelled"
      ? queuedTurnsRef.current.filter((candidate) => candidate.id !== turnId)
      : queuedTurnsRef.current.map((candidate) =>
          candidate.id === turnId
            ? { ...candidate, mailboxItemId: receipt.itemId, state }
            : candidate,
        ));
    if (state === "committed") requestRecovery();
  }

  const withdrawLatestQueuedFollowUp = async (): Promise<string | undefined> => {
    const turn = queuedTurnsRef.current.findLast((candidate) =>
      candidate.intent === "active-turn" && mailboxTurnIsCancellable(candidate)
    );
    if (!turn) return undefined;
    if (turn.delivery !== "server" || !turn.mailboxItemId || !mailbox) {
      updateQueuedTurns(queuedTurnsRef.current.filter((candidate) => candidate.id !== turn.id));
      return turn.text;
    }
    try {
      const receipt = await mailbox.cancel(turn.mailboxItemId);
      reconcileMailboxReceipt(turn.id, receipt);
      return receipt.status === "cancelled" ? turn.text : undefined;
    } catch (error) {
      if (
        error instanceof AgentMailboxHttpError &&
        error.code === "mailbox_item_not_cancellable"
      ) {
        try {
          reconcileMailboxReceipt(turn.id, await mailbox.inspect(turn.mailboxItemId));
        } catch {
          // Keep the durable queue snapshot if reconciliation is temporarily unavailable.
        }
        return undefined;
      }
      setQueueError(error instanceof Error ? error.message : messages.queueDeliveryFailed);
      return undefined;
    }
  }

  const requestCancellation = () => {
    if (!isBusy || cancellationRef.current.requested) return;
    const turnId = cancellationRef.current.turnId ?? latestActiveTurnId(latestEventsRef.current);
    const visibleTurnId = turnId ?? pendingTurnRef.current?.id ?? createPendingTurnId();
    const pendingAtInterruption = pendingTurnRef.current;
    const interruptedPendingTurn = pendingAtInterruption
      ? { ...pendingAtInterruption, state: "interrupted" as const }
      : undefined;
    const retainedContext = interruptedTurnContextFromEvents(
      latestEventsRef.current,
      turnId ?? "pending",
      retainedContextRef.current,
      recoveryContextWindowTokens,
      pendingAtInterruption?.text,
    );
    retainedContextRef.current = retainedContext;
    const interruptionStreamIndex = initialStreamIndexRef.current + Math.max(
      0,
      latestEventsRef.current.length - initialEventCountRef.current,
    );
    const interruptedTurn = {
      eventCount: compactedEventsRef.current.length,
      streamIndex: interruptionStreamIndex,
      turnId: visibleTurnId,
      settled: false,
    };
    const interruptedTurns = upsertInterruptedTurn(
      interruptedTurnsRef.current,
      interruptedTurn,
    );
    interruptedTurnsRef.current = interruptedTurns;
    cancellationRef.current = {
      ...cancellationRef.current,
      localTurnId: visibleTurnId,
      requested: true,
    };
    setCancellationError(undefined);
    setLocalInterruption({
      events: latestEventsRef.current,
      streamIndex: interruptionStreamIndex,
      turnId: visibleTurnId,
    });
    onCancelRecovery?.();
    const durableSession = sessionRef.current;
    // `accepted` is not the cancellation boundary. Keep the composer in its
    // stopping state until Eve emits turn.cancelled and session.waiting. If
    // the browser has not even obtained an Eve session yet, there is no
    // durable cancellation request to wait for, so the composer can remain
    // interactive immediately.
    // Eve cancellation is asynchronous in both the live and recovery paths.
    // Keep the composer locked until the durable turn.cancelled ->
    // session.waiting boundary arrives; an accepted HTTP response is not a
    // safe point for admitting the next turn.
    const waitsForDurableBoundary = Boolean(durableSession);
    if (!waitsForDurableBoundary) {
      // No Eve session exists yet, so the optimistic submission can be
      // stopped locally and there is no server-side turn to await.
      cancellationRef.current = { requested: false };
      // Abort the in-flight session admission as well. Without this, a slow
      // gateway response can arrive after the user pressed Stop and Eve will
      // still open a live stream for the request that was already cancelled.
      stopAgent();
    }
    // Keep the submitted prompt visible after a local stop, but remove it from
    // the in-flight admission state immediately. Otherwise the browser-only
    // optimistic copy remains `submitting` after the durable pending turn is
    // marked `interrupted`, leaving `isBusy` true and the composer stuck on
    // the stop control until a full remount.
    setOptimisticPendingTurn((current) => current
      ? { ...current, state: "interrupted" }
      : current);
    setCancellationState(waitsForDurableBoundary ? "requested" : "idle");
    pendingTurnRef.current = interruptedPendingTurn;
    onChange({
      events: [...compactedEventsRef.current],
      interruptedTurns,
      pendingTurn: interruptedPendingTurn,
      retainedContext,
      status: waitsForDurableBoundary ? "cancelling" : "ready",
      updatedAt: Date.now(),
    });
    const queuedFollowUpWithdrawal = withdrawLatestQueuedFollowUp();
    if (durableSession) requestDurableCancellation(durableSession, turnId);
    void queuedFollowUpWithdrawal.then((draft) => {
      if (draft === undefined) return;
      onChange({
        draftRestore: { id: createPendingTurnId(), text: draft },
        updatedAt: Date.now(),
      });
    });
  };

  const submit = async (message: PromptInputMessage) => {
    const text = expandPromptDirectives(message.text, commands, mentions).trim();
    if (!providerReady) return;
    if ((text.length === 0 && message.files.length === 0) || inputLocked) return;
    closeInputRequests(pendingInputRequests
      .filter((request) => request.kind === "question")
      .map((request) => request.requestId));
    if (cancellationSettling) {
      if (message.files.length > 0) {
        setQueueError(messages.queueAttachmentsUnsupported);
        return;
      }
      if (queuedTurnsRef.current.length >= MAX_QUEUED_FOLLOW_UPS) {
        setQueueError(messages.queueFull);
        return;
      }
      if (text.length > 0) {
        setQueueError(undefined);
        updateQueuedTurns([
          ...queuedTurnsRef.current,
          {
            delivery: "browser",
            id: createPendingTurnId(),
            intent: "post-cancellation",
            state: "queued",
            submittedAt: Date.now(),
            text,
          },
        ]);
      }
      return;
    }
    // The event handler clears the imperative gate as soon as Eve emits its
    // durable boundary. A render can still carry the previous `admissionBusy`
    // value for one frame; trust the current Eve transcript in that window so
    // a normal next message is not misclassified as a queued follow-up.
    const liveSessionSettled = hasSettledLatestTurn(agent.events) &&
      hasSettledSessionBoundary(agent.events);
    if (liveSessionSettled) turnAdmissionBusyRef.current = false;
    if ((admissionBusy || turnAdmissionBusyRef.current) && !liveSessionSettled) {
      if (message.files.length > 0) {
        setQueueError(messages.queueAttachmentsUnsupported);
        return;
      }
      if (queuedTurnsRef.current.length >= MAX_QUEUED_FOLLOW_UPS) {
        setQueueError(messages.queueFull);
        return;
      }
      if (text.length > 0) {
        const expectedTurnId = latestActiveTurnId(latestEventsRef.current);
        setQueueError(undefined);
        updateQueuedTurns([
          ...queuedTurnsRef.current,
          {
            ...(mailbox ? { delivery: "server" as const } : {}),
            ...(mailbox && expectedTurnId ? { expectedTurnId } : {}),
            id: createPendingTurnId(),
            intent: "active-turn",
            state: "queued",
            submittedAt: Date.now(),
            text,
          },
        ]);
      }
      return;
    }
    turnAdmissionBusyRef.current = true;
    prepareTurn();
    if (text.length > 0 || message.files.length > 0) {
      const pendingTurn = {
        ...(message.files.length > 0 ? { files: message.files } : {}),
        eventCountAtSubmission: compactedEventsRef.current.length,
        id: createPendingTurnId(),
        operation: "send" as const,
        state: "submitting" as const,
        submittedAt: Date.now(),
        text,
      };
      pendingTurnRef.current = pendingTurn;
      setOptimisticPendingTurn(pendingTurn);
      setOptimisticDisplayTurn(pendingTurn);
      onChange({ pendingTurn });
    }
    if (text.length > 0 && agent.data.messages.length === 0) {
      onChange({ title: titleFromPrompt(text) });
    }

    try {
      await sendPrompt(agent.send, { files: message.files, text }, thread.retainedContext);
      // `sendPrompt` resolves only after Eve reaches its durable session
      // boundary. Release the synchronous admission gate after that point so
      // the next user turn is not incorrectly parked in the follow-up queue.
      turnAdmissionBusyRef.current = false;
    } catch (error: unknown) {
      const sessionId = sessionRef.current?.state.sessionId ?? agent.session?.sessionId;
      // A stream can fail after Eve has accepted the turn. In that case the
      // durable session is still authoritative and the workspace must recover
      // from its cursor instead of falsely terminalising the request.
      if (
        sessionId &&
        isRecoverableStreamError(error) &&
        !hasSettledLatestTurn(latestEventsRef.current) &&
        !recoveryRequestedRef.current
      ) {
        setTurnError(undefined);
        requestRecovery();
        return;
      }

      // A submission rejected before Eve assigned a session cannot have been
      // durably accepted. Keep the pending admission intact so the bounded
      // provider-retry effect below can retry the exact same request. Marking
      // it delivery-failed here races that effect and makes a transient 503
      // look like a permanent failure with no retry affordance.
      if (!sessionId && isRetryableSubmissionError(error)) {
        setTurnError(undefined);
        return;
      }

      const pending = pendingTurnRef.current;
      const failedPendingTurn = pending && pending.id
        ? { ...pending, state: "delivery-failed" as const }
        : undefined;
      if (failedPendingTurn) pendingTurnRef.current = failedPendingTurn;
      turnAdmissionBusyRef.current = false;
      setTurnError(error instanceof Error ? error.message : messages.queueDeliveryFailed);
      onChange({
        ...(failedPendingTurn ? { pendingTurn: failedPendingTurn } : {}),
        status: "error",
        updatedAt: Date.now(),
      });
    }
  };

  const displayInterruptedTurns = useMemo(
    () => localInterruption
      ? upsertInterruptedTurn(thread.interruptedTurns ?? [], {
          eventCount: localInterruption.events.length,
          streamIndex: localInterruption.streamIndex,
          turnId: localInterruption.turnId,
        })
      : thread.interruptedTurns ?? [],
    [localInterruption, thread.interruptedTurns],
  );
  const interruptedDisplayEvents = useMemo(() => {
    const settled = dedupeThreadEvents(projectionEvents);
    if (displayInterruptedTurns.length === 0) return settled;
    let visible: readonly MessageStreamEvent[] = settled.filter((event, index) =>
      !shouldSuppressInterruptedTurnDisplayEvent(event, index, displayInterruptedTurns)
    );
    for (const interruptedTurn of displayInterruptedTurns) {
      visible = withLocalInterruptedBoundary(visible, interruptedTurn.turnId);
    }
    return visible;
  }, [displayInterruptedTurns, projectionEvents]);
  const projectedRuntimeMessages = useMemo(() => {
    const source = displayInterruptedTurns.length > 0
      ? messagesFromEvents(interruptedDisplayEvents)
      : projectionMessages;
    return normalizeSettledAgentMessages(source, interruptedDisplayEvents);
  },
    [displayInterruptedTurns.length, interruptedDisplayEvents, projectionMessages]);
  const displayMessageIdentityRef = useRef<DisplayMessageIdentityState>({
    assistantByTurn: new Map(),
    pendingRoot: undefined,
  });
  const projectedMessages = useMemo(() => projectStagedUserMessages(
    stabilizeDisplayMessageIdentities(
      ensureActiveAssistantMessage(
        projectedRuntimeMessages,
        interruptedDisplayEvents,
        isBusy || isPendingTurnInFlight(admissionPendingTurn) || Boolean(latestTurnFailure(interruptedDisplayEvents)),
        displayPendingTurn,
        optimisticPendingTurn?.id === displayPendingTurn?.id,
      ),
      interruptedDisplayEvents,
      displayPendingTurn,
      displayMessageIdentityRef.current,
    ),
    thread.queuedTurns.filter((turn) => turn.intent === "post-cancellation"),
    interruptedDisplayEvents,
  ), [admissionPendingTurn, displayPendingTurn, interruptedDisplayEvents, isBusy, optimisticPendingTurn, projectedRuntimeMessages, thread.queuedTurns]);
  const ungroupedVisibleMessages = useMemo(
    () => projectedMessages.filter((message) =>
      !isProxiedInputOnlyMessage(message, projectionEvents),
    ),
    [projectionEvents, projectedMessages],
  );
  const ungroupedDisplayEvents = interruptedDisplayEvents;
  const displayTimeline = useMemo(
    () => projectAgentDisplayTimeline(ungroupedVisibleMessages, ungroupedDisplayEvents),
    [ungroupedDisplayEvents, ungroupedVisibleMessages],
  );
  const displayEvents = displayTimeline.events;
  const orderedDisplayMessages = orderPendingUserMessage(
    displayTimeline.messages,
    displayPendingTurn,
    displayEvents,
    displayMessageIdentityRef.current,
  );
  // The display-timeline projection can remap same-turn continuation ids.
  // Apply the live pending-root identity after that projection as well, so a
  // pending assistant remains the same assistant-ui message throughout the
  // entire placeholder-to-Eve handoff.
  const visibleMessages = stabilizeDisplayMessageIdentities(
    orderedDisplayMessages,
    displayEvents,
    displayPendingTurn,
    displayMessageIdentityRef.current,
  );
  const assistantMessages = useMemo(
    () => convertEveMessages({ messages: visibleMessages }, {
      assetUrl: client?.assetUrl,
      error: agent.error,
      isRunning: isBusy,
    }),
    [agent.error, client?.assetUrl, isBusy, visibleMessages],
  );
  const queueCallbacksRef = useRef({ removeQueuedTurn, submit });
  queueCallbacksRef.current = { removeQueuedTurn, submit };
  const queueAdapter = useMemo<ExternalThreadQueueAdapter>(() => ({
    edit: () => {
      throw new Error("Editing a durable mailbox item is not supported.");
    },
    enqueue: (message) => {
      void queueCallbacksRef.current.submit(promptFromAssistantMessage(getEveMessageContent(message)));
    },
    items: thread.queuedTurns.filter((turn) => turn.intent !== "post-cancellation").map((turn) => ({
      id: turn.id,
      parts: [{ text: turn.text, type: "text" }],
      prompt: turn.text,
    })),
    move: () => {
      throw new Error("Reordering durable mailbox items is not supported.");
    },
    remove: (turnId) => queueCallbacksRef.current.removeQueuedTurn(turnId),
    // Eve injects follow-ups at the next safe turn boundary. The default
    // assistant-ui steer lane is deliberately mapped to that durable FIFO.
    steer: (message) => {
      void queueCallbacksRef.current.submit(promptFromAssistantMessage(getEveMessageContent(message)));
    },
    steerItems: [],
  }), [thread.queuedTurns]);

  const stageEditedTurn = (message: AppendMessage) => {
    const prompt = promptFromAssistantMessage(getEveMessageContent(message));
    if (!prompt.text && prompt.files.length === 0) return;
    const beforeTurnId = editedTurnId(message, displayMessageIdentityRef.current);
    if (!beforeTurnId) {
      setTurnError(locale === "zh-CN"
        ? "无法确定要编辑的消息，请刷新会话后重试。"
        : "The edited message has no durable turn identity. Reload and try again.");
      return;
    }
    if (!mailbox) {
      setTurnError(locale === "zh-CN"
        ? "当前宿主未配置耐久消息编辑服务。"
        : "This host does not provide durable message editing.");
      return;
    }
    if (sessionTerminal) return;
    const sessionId = sessionRef.current?.state.sessionId ?? agent.session?.sessionId;
    if (!sessionId) {
      setTurnError("The Agent session is not available. Reload this conversation and try again.");
      return;
    }
    if (admissionBusy) {
      setTurnError("The latest message cannot be edited until the current Agent turn reaches a durable boundary.");
      return;
    }
    const text = mailboxPromptText(prompt);
    if (text === undefined) {
      setTurnError(locale === "zh-CN"
        ? "包含内联附件的消息暂时无法编辑。"
        : "Messages with inline attachments cannot be edited yet.");
      return;
    }
    prepareTurn();
    turnAdmissionBusyRef.current = true;
    setTurnError(undefined);
    const pendingTurn = {
      beforeTurnId,
      delivery: "server" as const,
      eventCountAtSubmission: compactedEventsRef.current.length,
      id: createPendingTurnId(),
      operation: "edit" as const,
      state: "submitting" as const,
      submittedAt: Date.now(),
      text,
    };
    pendingTurnRef.current = pendingTurn;
    setOptimisticPendingTurn(pendingTurn);
    setOptimisticDisplayTurn(pendingTurn);
    onChange({
      pendingTurn,
      status: "submitted",
      updatedAt: Date.now(),
    });
  };

  const assetUploadAdapter = useMemo(
    () => client?.assetUpload ?? createHttpAgentAssetUploadAdapter(client),
    [client],
  );
  const attachmentAdapter = useMemo(
    () => createBrowserAttachmentAdapter(
      assetUploadAdapter,
      () => sessionRef.current?.state.sessionId ?? thread.session.sessionId,
    ),
    [assetUploadAdapter, thread.session.sessionId],
  );
  const runtimeCallbacksRef = useRef<{
    cancel: () => void;
    edit: (message: AppendMessage) => void;
    newMessage: (message: AppendMessage) => Promise<void>;
    respondToToolApproval: (response: RespondToToolApprovalOptions) => Promise<void>;
  }>({
    cancel: () => undefined,
    edit: () => undefined,
    newMessage: async () => undefined,
    respondToToolApproval: async () => undefined,
  });
  runtimeCallbacksRef.current = {
    cancel: requestCancellation,
    edit: (message) => {
      stageEditedTurn(message);
    },
    newMessage: (message) => submit(promptFromAssistantMessage(getEveMessageContent(message))),
    respondToToolApproval: async (response) => {
      prepareTurn();
      await agent.respond(
        [{ optionId: response.optionId, requestId: response.approvalId, text: response.reason }],
        retainedContextOptions(thread.retainedContext),
      );
    },
  };
  const assistantRuntimeAdapter = useMemo<ExternalStoreAdapter<ReturnType<typeof convertEveMessages>[number]>>(
    () => ({
      adapters: {
        attachments: attachmentAdapter,
      },
      // Lock regular sends while an approval is pending, but keep the runtime
      // available to the edit composer. assistant-ui intentionally allows edits
      // while `isSendDisabled` is true; `isDisabled` would disable both paths.
      isDisabled: !providerReady,
      isSendDisabled: inputLocked,
      // The workspace projects its own deterministic assistant placeholder
      // while a turn is being admitted. Passing `isRunning` before that
      // placeholder exists makes assistant-ui synthesize a random optimistic
      // message, which is then replaced by Eve's real id and causes a visible
      // remount/top-anchor jump. Let the external runtime mark a run active
      // only once the projected list already ends with an assistant message.
      isRunning: isBusy && assistantMessages.at(-1)?.role === "assistant",
      messages: assistantMessages,
      queue: queueAdapter,
      onCancel: async () => {
        runtimeCallbacksRef.current.cancel();
      },
      onEdit: async (message) => {
        runtimeCallbacksRef.current.edit(message);
      },
      onNew: (message) => runtimeCallbacksRef.current.newMessage(message),
      onRespondToToolApproval: (response) => runtimeCallbacksRef.current.respondToToolApproval(response),
    }),
    [assistantMessages, attachmentAdapter, inputLocked, isBusy, providerReady, queueAdapter],
  );
  const assistantRuntime = useExternalStoreRuntime(assistantRuntimeAdapter);

  useEffect(() => {
    const pendingTurn = thread.pendingTurn;
    // Keep an admitted operation idempotent across the short window where
    // `onChange` has written the mailbox receipt but React has not yet
    // published the updated pending-turn snapshot. Prune ids once their
    // pending operation is no longer the current one so the set stays bounded.
    for (const operationId of mailboxEnqueueIdsRef.current) {
      if (operationId !== pendingTurn?.id) mailboxEnqueueIdsRef.current.delete(operationId);
    }
    if (
      pendingTurn?.operation !== "edit" ||
      pendingTurn.delivery !== "server" ||
      pendingTurn.state !== "submitting" ||
      pendingTurn.mailboxItemId ||
      !pendingTurn.beforeTurnId ||
      !mailbox ||
      !providerReady ||
      mailboxEnqueueIdsRef.current.has(pendingTurn.id)
    ) return;
    const sessionId = sessionRef.current?.state.sessionId ?? agent.session?.sessionId;
    if (!sessionId) return;
    mailboxEnqueueIdsRef.current.add(pendingTurn.id);
    void mailbox.enqueue({
      beforeTurnId: pendingTurn.beforeTurnId,
      clientMessageId: pendingTurn.id,
      ...(thread.retainedContext ? { clientContext: thread.retainedContext } : {}),
      message: pendingTurn.text,
      operationId: pendingTurn.id,
      operationKind: "edit",
      preferences: preferencesRef.current,
      sessionId,
    }).then((receipt) => {
      if (pendingTurnRef.current?.id !== pendingTurn.id) return;
      if (receipt.status === "failed" || receipt.status === "cancelled") {
        const failed = { ...pendingTurn, mailboxItemId: receipt.itemId, state: "delivery-failed" as const };
        pendingTurnRef.current = failed;
        turnAdmissionBusyRef.current = false;
        setOptimisticPendingTurn(failed);
        onChange({ pendingTurn: failed, status: "error", updatedAt: Date.now() });
        setTurnError(receipt.lastError ?? messages.queueDeliveryFailed);
        return;
      }
      const admitted = { ...pendingTurn, mailboxItemId: receipt.itemId };
      pendingTurnRef.current = admitted;
      onChange({ pendingTurn: admitted, status: "submitted", updatedAt: Date.now() });
      if (receipt.status === "committed") requestRecovery();
    }).catch((error: unknown) => {
      if (pendingTurnRef.current?.id !== pendingTurn.id) return;
      const failed = { ...pendingTurn, state: "delivery-failed" as const };
      pendingTurnRef.current = failed;
      turnAdmissionBusyRef.current = false;
      setOptimisticPendingTurn(failed);
      onChange({ pendingTurn: failed, status: "error", updatedAt: Date.now() });
      setTurnError(error instanceof Error ? error.message : messages.queueDeliveryFailed);
    });
  }, [
    agent.session?.sessionId,
    mailbox,
    messages.queueDeliveryFailed,
    onChange,
    providerReady,
    requestRecovery,
    thread.pendingTurn,
    thread.retainedContext,
  ]);

  useEffect(() => {
    const pendingTurn = thread.pendingTurn;
    if (
      pendingTurn?.operation !== "edit" ||
      pendingTurn.delivery !== "server" ||
      pendingTurn.state !== "submitting" ||
      !pendingTurn.mailboxItemId ||
      !mailbox
    ) return;
    let disposed = false;
    const inspect = async () => {
      try {
        const receipt = await mailbox.inspect(pendingTurn.mailboxItemId!);
        if (disposed || pendingTurnRef.current?.id !== pendingTurn.id) return;
        if (receipt.status === "committed") {
          requestRecovery();
          return;
        }
        if (receipt.status === "failed" || receipt.status === "cancelled") {
          const failed = { ...pendingTurn, state: "delivery-failed" as const };
          pendingTurnRef.current = failed;
          turnAdmissionBusyRef.current = false;
          setOptimisticPendingTurn(failed);
          onChange({ pendingTurn: failed, status: "error", updatedAt: Date.now() });
          setTurnError(receipt.lastError ?? messages.queueDeliveryFailed);
        }
      } catch {
        // Keep the last durable receipt while the mailbox endpoint is transiently unavailable.
      }
    };
    void inspect();
    const timer = window.setInterval(() => void inspect(), MAILBOX_STATUS_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [mailbox, messages.queueDeliveryFailed, onChange, requestRecovery, thread.pendingTurn]);

  useEffect(() => {
    if (!mailbox || !agent.session?.sessionId) return;
    const next = queuedTurnsRef.current.find((turn) =>
      turn.delivery === "server" &&
      turn.intent !== "post-cancellation" &&
      turn.state === "queued" &&
      !turn.mailboxItemId &&
      !mailboxEnqueueIdsRef.current.has(turn.id)
    );
    if (!next) return;

    if (next.intent === "active-turn" && !next.expectedTurnId) {
      const expectedTurnId = latestActiveTurnId(agent.events);
      if (expectedTurnId) {
        // Persist the authoritative Eve turn before admission. A browser may
        // accept a follow-up while session creation is still streaming its
        // first turn.started event; classifying it as a normal send in that
        // window would miss the current turn's next model boundary.
        updateQueuedTurns(queuedTurnsRef.current.map((turn) =>
          turn.id === next.id ? { ...turn, expectedTurnId } : turn,
        ));
        return;
      }
      // Keep the durable browser queue until Eve either identifies the active
      // turn or the original admission settles. Once settled, the same item is
      // intentionally delivered as the next normal turn.
      if (admissionBusy) return;
    }

    mailboxEnqueueIdsRef.current.add(next.id);
    void mailbox.enqueue({
      clientMessageId: next.id,
      ...(thread.retainedContext ? { clientContext: thread.retainedContext } : {}),
      ...(next.expectedTurnId ? { expectedTurnId: next.expectedTurnId } : {}),
      message: next.text,
      operationId: next.id,
      operationKind: next.expectedTurnId ? "steer" : "send",
      preferences: preferencesRef.current,
      sessionId: agent.session.sessionId,
    }).then((receipt) => {
      const state = mailboxTurnState(receipt.status);
      if (state === "cancelled") {
        updateQueuedTurns(queuedTurnsRef.current.filter((turn) => turn.id !== next.id));
        return;
      }
      updateQueuedTurns(queuedTurnsRef.current.map((turn) =>
        turn.id === next.id
          ? { ...turn, mailboxItemId: receipt.itemId, state }
          : turn,
      ));
    }).catch((error: unknown) => {
      setQueueError(error instanceof Error ? error.message : messages.queueDeliveryFailed);
      updateQueuedTurns(queuedTurnsRef.current.map((turn) =>
        turn.id === next.id ? { ...turn, state: "delivery-failed" } : turn,
      ));
    }).finally(() => {
      mailboxEnqueueIdsRef.current.delete(next.id);
    });
  }, [admissionBusy, agent.events, agent.session?.sessionId, mailbox, messages.queueDeliveryFailed, thread.queuedTurns]);

  useEffect(() => {
    if (!mailbox || isRecovering) return;
    const tracked = queuedTurnsRef.current.filter((turn) =>
      turn.delivery === "server" && Boolean(turn.mailboxItemId) &&
      turn.state !== "delivery-failed"
    );
    if (tracked.length === 0) return;
    let disposed = false;
    const poll = async () => {
      const updates = new Map<string, AgentQueuedTurn["state"] | "remove">();
      await Promise.all(tracked.map(async (turn) => {
        try {
          const receipt = await mailbox.inspect(turn.mailboxItemId!);
          const state = mailboxTurnState(receipt.status);
          updates.set(turn.id, state === "cancelled" ? "remove" : state);
        } catch {
          // Keep the last durable UI snapshot while mailbox inspection is unavailable.
        }
      }));
      if (disposed || updates.size === 0) return;
      updateQueuedTurns(queuedTurnsRef.current.flatMap((turn) => {
        const state = updates.get(turn.id);
        if (state === "remove") return [];
        return state ? [{ ...turn, state }] : [turn];
      }));
    };
    const timer = window.setInterval(() => void poll(), MAILBOX_STATUS_POLL_MS);
    void poll();
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [isRecovering, mailbox, thread.queuedTurns]);

  useEffect(() => {
    if (!mailbox || isRecovering || inputLocked || recoveryRequestedRef.current) return;
    const serverTurns = queuedTurnsRef.current.filter((turn) =>
      turn.delivery === "server" && Boolean(turn.mailboxItemId)
    );
    const committedAdmission = serverTurns.some((turn) => turn.state === "committed");
    const parkedDelivery = !admissionBusy && serverTurns.some((turn) =>
      turn.state === "queued" || turn.state === "delivering" || turn.state === "accepted"
    );
    if (!committedAdmission && !parkedDelivery) return;
    requestRecovery();
  }, [admissionBusy, inputLocked, isRecovering, mailbox, requestRecovery, thread.queuedTurns]);

  useEffect(() => {
    if (
      admissionBusy || runtimeIsBusy || inputLocked || !providerReady ||
      dispatchingQueuedTurnIdRef.current ||
      !agent.session?.sessionId
    ) return;
    const next = queuedTurnsRef.current.find((turn) =>
      turn.state === "queued" && turn.delivery !== "server"
    );
    if (!next) return;

    dispatchingQueuedTurnIdRef.current = next.id;
    turnAdmissionBusyRef.current = true;
    prepareTurn();
    onChange({
      pendingTurn: {
        eventCountAtSubmission: compactedEventsRef.current.length,
        id: next.id,
        operation: "send",
        state: "submitting",
        submittedAt: next.submittedAt,
        text: next.text,
      },
    });
    pendingTurnRef.current = {
      id: next.id,
      operation: "send",
      state: "submitting",
      submittedAt: next.submittedAt,
      text: next.text,
    };
    void agent.send(next.text, retainedContextOptions(thread.retainedContext)).catch((error: unknown) => {
      if (!agent.session?.sessionId && isRetryableSubmissionError(error)) {
        // Keep this queued admission pending so the same bounded provider
        // retry path can deliver it. Failing the queue item here would race
        // the retry effect and drop a message after a transient gateway error.
        setTurnError(undefined);
        return;
      }
      dispatchingQueuedTurnIdRef.current = undefined;
      turnAdmissionBusyRef.current = false;
      pendingTurnRef.current = undefined;
      if (isAgentTurnBusyError(error)) {
        onChange({ pendingTurn: undefined, queuedTurns: queuedTurnsRef.current });
        return;
      }
      const queuedTurns = queuedTurnsRef.current.map((turn) =>
        turn.id === next.id ? { ...turn, state: "delivery-failed" as const } : turn,
      );
      queuedTurnsRef.current = queuedTurns;
      onChange({ pendingTurn: undefined, queuedTurns });
      setTurnError(error instanceof Error ? error.message : messages.queueDeliveryFailed);
    });
  }, [admissionBusy, agent, agent.session?.sessionId, inputLocked, messages.queueDeliveryFailed, onChange, providerReady, runtimeIsBusy, thread.queuedTurns]);

  const respond = (inputResponses: readonly AgentInputResponse[]) => {
    prepareTurn();
    return agent.respond(inputResponses, retainedContextOptions(thread.retainedContext));
  };

  const closeInputRequest = (requestId: string) => closeInputRequests([requestId]);

  const visibleQueuedTurns = thread.queuedTurns.filter((turn) =>
    turn.intent !== "post-cancellation"
  );

  return (
    <AssistantRuntimeProvider runtime={assistantRuntime}>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <AssistantThreadSurface
        assetUrl={client?.assetUrl}
          approvalTakeover={approvalTakeover}
          cancellationState={cancellationState}
          commands={commands}
          composerTop={isRecovering || visibleQueuedTurns.length > 0 || queueError ? (
            <>
              {isRecovering ? (
                <div className="flex items-center gap-2 border-b border-border/60 px-1 pb-2 text-xs text-muted-foreground" data-agent-recovery-status role="status">
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                  <span>{messages.reconnecting}</span>
                </div>
              ) : null}
              {visibleQueuedTurns.length > 0 || queueError ? (
                <FollowUpQueue
                  error={queueError}
                  messages={messages}
                  onRemove={removeQueuedTurn}
                  onRetry={markQueuedTurnForRetry}
                  turns={visibleQueuedTurns}
                />
              ) : null}
            </>
          ) : undefined}
          draftStorageKey={draftStorageKey}
          historyHasMore={historyHasMore}
          historyLoading={historyLoading}
          events={displayEvents}
          eveMessages={visibleMessages}
          fallbackStartedAt={displayPendingTurn?.submittedAt}
          inputDisabled={inputLocked}
          isBusy={isBusy}
          sessionTerminal={sessionTerminal}
          sessionSettled={durableTurnSettled}
          onCancel={requestCancellation}
          locale={locale}
          mentions={mentions}
          messages={messages}
          models={models}
          onInputResponses={respond}
          onCloseInputRequest={closeInputRequest}
          onOpenDeliverable={onOpenDeliverable}
          onOpenSubagent={onOpenSubagent}
          onLoadEarlier={onLoadEarlier}
          onPreferencesChange={(preferences) => onChange({ preferences })}
          onDraftRestoreConsumed={(id) => {
            if (thread.draftRestore?.id === id) onChange({ draftRestore: undefined });
          }}
          onRetryRuntimeError={recoveryError ? onRetryRecovery : undefined}
          closedInputRequestIds={closedInputRequestIdsRef.current}
          preferences={thread.preferences}
          reasoningLevels={reasoningLevels}
          draftRestore={thread.draftRestore}
          runtimeFailure={runtimeFailure}
          runtimeError={runtimeError}
          runtimeRetry={providerRetry}
          usage={usage}
        />
      </main>
    </AssistantRuntimeProvider>
  );
}

function expandPromptDirectives(
  value: string,
  commands: readonly AgentPromptMenuItem[],
  mentions: readonly AgentPromptMenuItem[],
): string {
  const segments = unstable_defaultDirectiveFormatter.parse(value);
  if (segments.every((segment) => segment.kind === "text")) return value;
  const catalogs = new Map<string, string>([
    ...commands.map((item) => [`command:${item.value}`, item.value] as const),
    ...mentions.map((item) => [`context:${item.value}`, item.value] as const),
  ]);
  return segments.map((segment) => {
    if (segment.kind === "text") return segment.text;
    return catalogs.get(`${segment.type}:${segment.id}`) ?? segment.label;
  }).join("");
}

export function FollowUpQueue({
  error,
  messages,
  onRemove,
  onRetry,
  turns,
}: {
  readonly error?: string;
  readonly messages: AgentMessages;
  readonly onRemove: (turnId: string) => void;
  readonly onRetry: (turnId: string) => void;
  readonly turns: readonly AgentQueuedTurn[];
}) {
  return (
    <div className="border-b border-border/60 px-1 pb-2 text-sm" data-agent-steer-queue>
      <div className="flex items-center gap-2 px-1 pb-1 text-xs text-muted-foreground">
        <Clock3Icon className="size-3.5" />
        <span>{messages.queuedFollowUps}</span>
        {turns.length > 0 ? <span>{turns.length}</span> : null}
      </div>
      <div className="space-y-0.5">
        {turns.map((turn) => (
          <div className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 hover:bg-muted/55" key={turn.id}>
            <span className={cn("size-1.5 shrink-0 rounded-full", turn.state === "delivery-failed" ? "bg-destructive" : "bg-amber-500")} />
            <span className="min-w-0 flex-1 truncate text-[13px]">{turn.text}</span>
            {turn.state === "delivery-failed" ? <span className="shrink-0 text-xs text-destructive">{messages.queueDeliveryFailed}</span> : turn.state === "admission-ambiguous" ? <span className="shrink-0 text-xs text-amber-700 dark:text-amber-300">{messages.queueAdmissionAmbiguous}</span> : turn.state === "delivering" ? <span className="shrink-0 text-xs text-muted-foreground">{messages.queueDelivering}</span> : turn.state === "accepted" || turn.state === "committed" ? <span className="shrink-0 text-xs text-muted-foreground">{messages.queueAccepted}</span> : null}
            {turn.state === "delivery-failed" ? <Button aria-label={messages.retryQueuedMessage} className="size-7" onClick={() => onRetry(turn.id)} size="icon-sm" variant="ghost"><RotateCcwIcon className="size-3.5" /></Button> : null}
            {mailboxTurnIsCancellable(turn) ? <Button aria-label={messages.removeQueuedMessage} className="size-7" onClick={() => onRemove(turn.id)} size="icon-sm" variant="ghost"><XIcon className="size-3.5" /></Button> : null}
          </div>
        ))}
      </div>
      {error ? <p className="px-1 pt-1 text-xs text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}

function ensureActiveAssistantMessage(
  messages: readonly EveMessage[],
  events: readonly MessageStreamEvent[],
  isBusy: boolean,
  pendingTurn?: AgentThread["pendingTurn"],
  optimisticPending = false,
): readonly EveMessage[] {
  const projectedMessages = projectPendingUserMessage(messages, pendingTurn, events, optimisticPending);
  const terminalFailure = latestTurnFailure(events);
  if (!isBusy && !terminalFailure) return projectedMessages;
  const started = [...events].reverse().find((event) => event.type === "turn.started");
  const turnId = started?.type === "turn.started" ? started.data.turnId : undefined;
  // A settled session can have a complete assistant message while the next
  // POST is still waiting for Eve's first `turn.started` event. Keep the new
  // optimistic user turn paired with its own thinking placeholder instead of
  // treating the previous assistant response as the active head.
  const pendingUserIndex = pendingTurn
    ? projectedMessages.findIndex((message) => message.id === `${pendingTurn.id}:user`)
    : -1;
  const sessionSettled = hasSettledLatestTurn(events);
  const activeTurnId = pendingUserIndex >= 0 && sessionSettled
    ? undefined
    : pendingTurn
      ? activeTurnIdAfterPendingSubmission(events, pendingTurn)
      : turnId;
  if (activeTurnId && projectedMessages.some((message) => message.role === "assistant" && message.metadata?.turnId === activeTurnId)) {
    return projectedMessages;
  }
  if (activeTurnId && pendingTurn) {
    const pendingAssistantIndex = projectedMessages.findIndex((message) =>
      message.role === "assistant" && message.id === `${pendingTurn.id}:assistant`,
    );
    if (pendingAssistantIndex >= 0) {
      const pendingAssistant = projectedMessages[pendingAssistantIndex]!;
      const next = [...projectedMessages];
      next[pendingAssistantIndex] = {
        ...pendingAssistant,
        metadata: {
          ...pendingAssistant.metadata,
          status: "streaming",
          turnId: activeTurnId,
        },
      };
      return next;
    }
  }
  if (!activeTurnId && !pendingTurn && projectedMessages.at(-1)?.role === "assistant") return projectedMessages;
  const placeholderId = activeTurnId ?? pendingTurn?.id ?? "pending-turn";
  const displayTurnId = activeTurnId ?? (terminalFailure ? placeholderId : undefined);
  return [
    ...projectedMessages,
    {
      id: `${placeholderId}:assistant`,
      metadata: {
        status: terminalFailure ? "complete" : "streaming",
        ...(displayTurnId ? { turnId: displayTurnId } : {}),
      },
      parts: [],
      role: "assistant",
    },
  ];
}

type DisplayMessageIdentityState = {
  readonly assistantByTurn: Map<string, string>;
  pendingRoot?: string;
  pendingUserRoot?: string;
  pendingUserTurnId?: string;
};

/**
 * Keep assistant-ui's message identity stable while an admitted turn changes
 * from the browser's pending projection to Eve's durable message. The pending
 * id is the first id rendered, so it remains the anchor for the whole live
 * turn; the durable id is only an implementation detail of the Eve adapter.
 */
function stabilizeDisplayMessageIdentities(
  messages: readonly EveMessage[],
  events: readonly MessageStreamEvent[],
  pendingTurn: AgentThread["pendingTurn"] | undefined,
  state: DisplayMessageIdentityState,
): readonly EveMessage[] {
  if (pendingTurn && state.pendingRoot !== pendingTurn.id) {
    // A new admission must not reuse the previous receipt anchor while its
    // own `message.received` event is still pending.
    state.pendingUserRoot = undefined;
    state.pendingUserTurnId = undefined;
    state.pendingRoot = pendingTurn.id;
  }
  // During the first render after submit, the throttled Eve snapshot can
  // still contain the previous turn's `turn.started` without its terminal
  // boundary. Never bind that historical turn to the new optimistic root.
  // Once a root has been bound, remove any stale turn aliases before binding
  // the authoritative new turn; otherwise two assistant rows receive the
  // same React key and the old reasoning appears in the new turn.
  // `orderPendingUserMessage` records the durable turn id from Eve's receipt
  // before the optimistic pending object is cleared. Keep using that receipt
  // anchor for the rest of the handoff; otherwise the first durable assistant
  // snapshot is rendered with its raw Eve id and remounts the row.
  const receiptTurnId = state.pendingUserRoot === state.pendingRoot
    ? state.pendingUserTurnId
    : undefined;
  const activeTurnId = pendingTurn
    ? activeTurnIdAfterPendingSubmission(events, pendingTurn) ?? receiptTurnId
    : receiptTurnId;
  // Once the durable turn has been associated with the pending root, keep
  // that association after Eve acknowledges the message. The optimistic
  // pending record is intentionally cleared before the reducer's final
  // assistant snapshot arrives; deleting the mapping in that handoff makes
  // assistant-ui remount the row from `<turnId>:assistant`, which causes the
  // reasoning placeholder to flash and the message anchor to jump.
  if (pendingTurn && state.pendingRoot) {
    for (const [turnId, root] of state.assistantByTurn) {
      if (root === state.pendingRoot && turnId !== activeTurnId) {
        state.assistantByTurn.delete(turnId);
      }
    }
  }
  if (activeTurnId && state.pendingRoot) {
    state.assistantByTurn.set(activeTurnId, state.pendingRoot);
  }

  let changed = false;
  const stabilized = messages.map((message) => {
    const turnId = message.metadata?.turnId;
    const stableRoot = turnId ? state.assistantByTurn.get(turnId) : undefined;
    if (!stableRoot || !turnId) return message;
    const id = message.role === "assistant"
      ? stableAssistantMessageId(message.id, turnId, stableRoot)
      : stableUserMessageId(message.id, turnId, stableRoot);
    if (id === message.id) return message;
    changed = true;
    return { ...message, id };
  });

  return changed ? stabilized : messages;
}

function stableAssistantMessageId(sourceId: string, turnId: string, stableRoot: string): string {
  const prefix = `${turnId}:assistant`;
  if (sourceId === prefix) return `${stableRoot}:assistant`;
  if (sourceId.startsWith(`${prefix}:`)) {
    return `${stableRoot}:assistant:${sourceId.slice(prefix.length + 1)}`;
  }
  return `${stableRoot}:assistant`;
}


function projectPendingUserMessage(
  messages: readonly EveMessage[],
  pendingTurn?: AgentThread["pendingTurn"],
  events: readonly MessageStreamEvent[] = [],
  optimisticPending = false,
): readonly EveMessage[] {
  if (!pendingTurn) return messages;
  if (messages.some((message) =>
    message.role === "user" &&
    (message.id === `${pendingTurn.id}:user` || message.id.startsWith(`${pendingTurn.id}:user:`)),
  )) return messages;
  // The receipt can arrive one render before Eve's reduced user message. Once
  // the latter is present, keep the durable row and suppress the optimistic
  // copy regardless of whether the browser admission flag has settled yet.
  if (!optimisticPending && hasVisiblePendingUserMessage(pendingTurn, messages, events)) return messages;
  return [
    ...messages,
    {
      id: `${pendingTurn.id}:user`,
      parts: [
        ...(pendingTurn.text ? [{ text: pendingTurn.text, type: "text" as const }] : []),
        ...(pendingTurn.files ?? []).map((file) => ({
          ...(file.filename ? { filename: file.filename } : {}),
          mediaType: file.mediaType,
          type: "file" as const,
          url: file.url,
        })),
      ],
      role: "user" as const,
    },
  ];
}

/**
 * During admission Eve may expose the assistant snapshot before the matching
 * user snapshot. Move that one user row back in front of its assistant so the
 * existing keyed message root is preserved instead of being reordered by the
 * reducer race. This only applies to the currently submitted turn.
 */
function orderPendingUserMessage(
  messages: readonly EveMessage[],
  pendingTurn: AgentPendingTurn | undefined,
  events: readonly MessageStreamEvent[],
  state: DisplayMessageIdentityState,
): readonly EveMessage[] {
  // Keep the receipt's turn anchor for the remainder of this visual handoff.
  // The optimistic copy is intentionally cleared as soon as Eve's reducer
  // exposes the user row, but the reducer can still publish that row after an
  // assistant snapshot. Dropping the anchor at that point lets the list flip
  // back to Eve's transient order and remount every row keyed by index.
  if (pendingTurn) {
    const receipt = acceptedMessageReceivedEvent(pendingTurn, events);
    if (receipt) {
      state.pendingUserRoot = pendingTurn.id;
      state.pendingUserTurnId = receipt.data.turnId;
    }
  }
  const targetTurnId = state.pendingUserTurnId;
  if (!targetTurnId) return messages;
  const userIndex = messages.findIndex((message) =>
    message.role === "user" &&
    messageBelongsToTurn(message, targetTurnId) &&
    (!pendingTurn || message.parts.some((part) => part.type === "text" && part.text.trim() === pendingTurn.text.trim())),
  );
  if (userIndex < 0) return messages;
  const assistantIndex = messages.findIndex((message) =>
    message.role === "assistant" && message.metadata?.turnId === targetTurnId,
  );
  if (assistantIndex < 0 || userIndex < assistantIndex) return messages;
  const next = [...messages];
  const [user] = next.splice(userIndex, 1);
  next.splice(assistantIndex, 0, user!);
  return next;
}

function hasVisiblePendingUserMessage(
  pendingTurn: AgentPendingTurn,
  messages: readonly EveMessage[],
  events: readonly MessageStreamEvent[],
): boolean {
  const received = acceptedMessageReceivedEvent(pendingTurn, events);
  if (!received) return false;
  return messages.some((message) =>
    message.role === "user" &&
    messageBelongsToTurn(message, received.data.turnId) &&
    message.parts.some((part) => part.type === "text" && part.text.trim() === pendingTurn.text.trim()),
  );
}

function messageBelongsToTurn(message: EveMessage, turnId: string): boolean {
  return message.metadata?.turnId === turnId ||
    message.id === `${turnId}:user` ||
    message.id.startsWith(`${turnId}:user:`);
}

function acceptedMessageReceivedEvent(
  pendingTurn: AgentPendingTurn,
  events: readonly MessageStreamEvent[],
): Extract<MessageStreamEvent, { type: "message.received" }> | undefined {
  const receivedIndex = events.findLastIndex((event, eventIndex) => {
    if (event.type !== "message.received") return false;
    if (event.data.clientMessageId === pendingTurn.id) return true;
    if (event.data.clientMessageId) return false;
    const isAfterSubmission = pendingTurn.eventCountAtSubmission === undefined ||
      eventIndex >= pendingTurn.eventCountAtSubmission;
    const eventAt = event.meta.at ? Date.parse(event.meta.at) : Number.NaN;
    // When a host does not echo clientMessageId, a zero/stale event-count
    // snapshot is the only remaining admission hint. Prefer the server event
    // timestamp in that case so an older identical prompt cannot acknowledge
    // the new optimistic row during a repeated submission.
    const eventCanAcknowledge = Number.isFinite(eventAt)
      ? eventAt >= pendingTurn.submittedAt - 5_000
      : isAfterSubmission;
    return isAfterSubmission && eventCanAcknowledge &&
      event.data.message.trim() === pendingTurn.text.trim();
  });
  if (receivedIndex < 0) return undefined;
  const received = events[receivedIndex];
  return received?.type === "message.received" ? received : undefined;
}

export function projectStagedUserMessages(
  messages: readonly EveMessage[],
  turns: readonly AgentQueuedTurn[],
  events: readonly MessageStreamEvent[] = [],
): readonly EveMessage[] {
  if (turns.length === 0) return messages;
  const projected = [...messages];
  for (const turn of turns) {
    const id = `${turn.id}:user`;
    if (projected.some((message) => message.id === id)) continue;
    // Eve acknowledges a mailbox item before its message reducer snapshot is
    // necessarily published. Keep the staged row visible through that one
    // frame; remove it only once the durable user row is present, otherwise a
    // successful follow-up briefly disappears from the transcript.
    const receipt = events.findLast((event) =>
      event.type === "message.received" && event.data.clientMessageId === turn.id,
    );
    if (receipt?.type === "message.received" && projected.some((message) =>
      message.role === "user" &&
      messageBelongsToTurn(message, receipt.data.turnId) &&
      message.parts.some((part) => part.type === "text" && part.text.trim() === turn.text.trim()),
    )) continue;
    projected.push({
      id,
      parts: [{ text: turn.text, type: "text" }],
      role: "user",
    });
  }
  return projected;
}

function isPendingTurnInFlight(pendingTurn?: AgentThread["pendingTurn"]): boolean {
  return pendingTurn?.state === "clearing" ||
    pendingTurn?.state === "resubmitting" ||
    pendingTurn?.state === "submitting";
}

function latestActiveTurnId(events: readonly MessageStreamEvent[]): string | undefined {
  const turnId = latestStartedTurnId(events);
  if (!turnId) return undefined;
  const settled = events.some((event) =>
    (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") &&
    event.data.turnId === turnId
  );
  return settled ? undefined : turnId;
}

function latestStartedTurnId(events: readonly MessageStreamEvent[]): string | undefined {
  const latestStarted = events.findLast((event) => event.type === "turn.started");
  return latestStarted?.type === "turn.started" ? latestStarted.data.turnId : undefined;
}

function isAgentTurnBusyError(error: unknown): boolean {
  return error instanceof Error && /already processing a turn/i.test(error.message);
}

function messagesFromEvents(events: readonly MessageStreamEvent[]): readonly EveMessage[] {
  const reducer = defaultMessageReducer();
  let data = reducer.initial();
  for (const event of events) data = reducer.reduce(data, event);
  return data.messages;
}

function retargetInterruptedTurn(
  turns: readonly AgentInterruptedTurn[],
  fromTurnId: string,
  toTurnId: string,
): readonly AgentInterruptedTurn[] {
  const turn = turns.find((candidate) => candidate.turnId === fromTurnId);
  return turn
    ? upsertInterruptedTurn(
        turns.filter((candidate) => candidate.turnId !== fromTurnId),
        { ...turn, turnId: toTurnId },
      )
    : turns;
}

function settleInterruptedTurn(
  turns: readonly AgentInterruptedTurn[],
  turnId: string,
  streamIndex: number,
): readonly AgentInterruptedTurn[] {
  const turn = turns.find((candidate) => candidate.turnId === turnId);
  if (!turn || turn.settled === true) return turns;
  return upsertInterruptedTurn(turns, {
    ...turn,
    settled: true,
    streamIndex: Math.max(turn.streamIndex, streamIndex),
  });
}

function upsertInterruptedTurn(
  turns: readonly AgentInterruptedTurn[],
  turn: AgentInterruptedTurn,
): readonly AgentInterruptedTurn[] {
  return [
    ...turns.filter((candidate) => candidate.turnId !== turn.turnId),
    turn,
  ].slice(-32);
}

function createPendingTurnId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `pending-${Date.now()}`;
}

function withLocalInterruptedBoundary(
  events: readonly MessageStreamEvent[],
  turnId: string,
): readonly MessageStreamEvent[] {
  const hasTerminalBoundary = events.some((event) =>
    (event.type === "turn.cancelled" || event.type === "turn.completed" || event.type === "turn.failed") &&
    event.data.turnId === turnId,
  );
  if (hasTerminalBoundary) return events;

  const started = events.findLast((event) =>
    event.type === "turn.started" && event.data.turnId === turnId,
  );
  const at = new Date().toISOString();
  return [
    ...events,
    {
      data: {
        sequence: started?.type === "turn.started" ? started.data.sequence : 0,
        turnId,
      },
      meta: { at, id: `local-interrupt-${turnId}` },
      type: "turn.cancelled",
    },
  ];
}

function sameContextEntries(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (!left || !right) return left === right || (left?.length ?? 0) === 0 && (right?.length ?? 0) === 0;
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function promptFromAssistantMessage(content: Parameters<ClientSession["send"]>[0]): PromptInputMessage {
  if (typeof content === "string") return { files: [], text: content };
  const text = content.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n");
  const files = content.filter((part): part is Extract<typeof part, { type: "file" }> => part.type === "file").map((part) => {
    const url = typeof part.data === "string" ? part.data : String(part.data);
    const assetId = url.startsWith("asset://")
      ? url.slice("asset://".length)
      : /^\/api\/assets\/([^/?#]+)/u.exec(url)?.[1];
    return {
      ...(assetId ? { assetId } : {}),
      ...(part.filename ? { filename: part.filename } : {}),
      mediaType: part.mediaType,
      url,
    };
  });
  return { files, text };
}

function editedTurnId(
  message: AppendMessage,
  identities?: DisplayMessageIdentityState,
): string | undefined {
  const metadataTurnId = message.metadata?.custom?.turnId ??
    (message.metadata as { readonly turnId?: unknown } | undefined)?.turnId;
  if (typeof metadataTurnId === "string" && metadataTurnId.trim()) return metadataTurnId;
  if (!message.sourceId) return undefined;

  // assistant-ui's edit composer preserves the displayed message id as
  // `sourceId`, but our live handoff intentionally replaces Eve's
  // `<turnId>:user` id with a stable optimistic root. Resolve that alias back
  // to Eve's durable turn before submitting the revert transaction. Without
  // this reverse lookup an edit targets `pending-...` and Eve correctly
  // rejects the revert precondition, which can look like a normal duplicate
  // send after refresh.
  if (identities) {
    for (const [turnId, stableRoot] of identities.assistantByTurn) {
      if (message.sourceId === `${stableRoot}:user` ||
          message.sourceId.startsWith(`${stableRoot}:user:`)) {
        return turnId;
      }
    }
  }
  const userSuffix = message.sourceId.indexOf(":user");
  return userSuffix > 0 ? message.sourceId.slice(0, userSuffix) : undefined;
}

function mailboxPromptText(prompt: PromptInputMessage): string | undefined {
  if (prompt.files.some((file) => !file.assetId)) return undefined;
  return serializedPromptText(prompt);
}

function serializedPromptText(prompt: PromptInputMessage): string {
  const assetNotes = prompt.files
    .filter((file) => file.assetId)
    .map((file) => `[open-agent-asset ${JSON.stringify({ id: file.assetId, mediaType: file.mediaType, name: file.filename ?? "file", ...(file.sizeBytes ? { size: file.sizeBytes } : {}) })}] Attached asset ${file.filename ?? "file"}. Use import_asset before inspecting or processing it.`);
  return [prompt.text, ...assetNotes].filter((value) => value.trim().length > 0).join("\n\n");
}

function retainedContextOptions(
  context: readonly string[] | undefined,
): Parameters<ReturnType<typeof useEveAgent>["send"]>[1] {
  return {
    ...(context && context.length > 0 ? { clientContext: context } : {}),
    streamReconnectPolicy: LONG_RUNNING_STREAM_RECONNECT_POLICY,
  };
}

async function sendPrompt(
  send: ReturnType<typeof useEveAgent>["send"],
  prompt: PromptInputMessage,
  context: readonly string[] | undefined,
): Promise<void> {
  const text = serializedPromptText(prompt);
  const inlineFiles = prompt.files.filter((file) => !file.assetId);
  if (inlineFiles.length === 0) {
    await send(text, retainedContextOptions(context));
    return;
  }

  const parts: UserContent = [];
  if (text) parts.push({ text, type: "text" });
  for (const file of inlineFiles) {
    parts.push({
      data: file.url,
      ...(file.filename ? { filename: file.filename } : {}),
      mediaType: file.mediaType,
      type: "file",
    });
  }
  await send(parts, retainedContextOptions(context));
}

function isSessionBoundary(event: MessageStreamEvent): boolean {
  return event.type === "session.waiting" || event.type === "session.completed" || event.type === "session.failed";
}

function hasCancellationBoundary(
  events: readonly MessageStreamEvent[],
  turnId?: string,
): boolean {
  let cancelled = false;
  for (const event of events) {
    if (event.type === "turn.cancelled" && (!turnId || event.data.turnId === turnId)) {
      cancelled = true;
      continue;
    }
    if (cancelled && event.type === "session.waiting") return true;
  }
  return false;
}

const DURABLE_PROGRESS_PROBE_DELAY_MS = 15_000;
const DURABLE_PROGRESS_PROBE_INTERVAL_MS = 10_000;
const DURABLE_PROGRESS_PROBE_TIMEOUT_MS = 2_500;
const MAX_QUEUED_FOLLOW_UPS = 5;
const MAILBOX_STATUS_POLL_MS = 1_500;

function mailboxTurnState(
  status: import("./contracts.js").AgentMailboxItemStatus,
): AgentQueuedTurn["state"] | "cancelled" {
  if (status === "failed") return "delivery-failed";
  if (status === "submission-ambiguous") return "admission-ambiguous";
  if (status === "cancelled") return "cancelled";
  return status;
}

function mailboxTurnIsCancellable(turn: AgentQueuedTurn): boolean {
  if (turn.delivery !== "server") return true;
  return turn.state === "queued" || turn.state === "delivering" || turn.state === "delivery-failed";
}

function sameQueuedTurnSnapshots(
  left: readonly AgentQueuedTurn[],
  right: readonly AgentQueuedTurn[],
): boolean {
  return left.length === right.length && left.every((turn, index) => {
    const candidate = right[index];
    return candidate?.id === turn.id &&
      candidate.delivery === turn.delivery &&
      candidate.expectedTurnId === turn.expectedTurnId &&
      candidate.intent === turn.intent &&
      candidate.mailboxItemId === turn.mailboxItemId &&
      candidate.state === turn.state &&
      candidate.submittedAt === turn.submittedAt &&
      candidate.text === turn.text;
  });
}

async function hasDurableProgressAfter(
  session: ClientSession,
  startIndex: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), DURABLE_PROGRESS_PROBE_TIMEOUT_MS);
  try {
    for await (const _event of session.stream({
      follow: false,
      signal: controller.signal,
      startIndex,
    })) {
      return true;
    }
  } catch (error) {
    if (!controller.signal.aborted && !isTransientProbeError(error)) {
      console.warn("Durable Agent progress probe failed", error);
    }
  } finally {
    window.clearTimeout(timeout);
  }
  return false;
}

function isTransientProbeError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  if (error instanceof TypeError) return true;
  return error instanceof Error && /fetch|network|socket|stream/i.test(error.message);
}

function isRecoverableStreamError(error: unknown): boolean {
  if (isRetryableSubmissionError(error)) return true;
  if (!(error instanceof Error)) return false;
  const description = `${error.name} ${error.message}`.toLowerCase();
  return /network|fetch|stream|socket|chunk|terminated|incomplete|connection|timeout/u.test(description);
}

function isRetryableSubmissionError(error: unknown): boolean {
  if (error instanceof ClientError) {
    return error.status === 0 || error.status === 408 || error.status === 409 ||
      error.status === 425 || error.status === 429 || error.status >= 500;
  }
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
  if (status !== undefined && (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500)) return true;
  const description = `${error.name} ${error.message}`.toLowerCase();
  return /network|fetch|socket|chunk|terminated|incomplete|connection|timeout|\b(?:408|409|425|429|5\d{2})\b/u.test(description);
}

function toAgentFailure(error: unknown): AgentTurnFailure {
  if (error instanceof ClientError) {
    const statusCode = error.status >= 100 && error.status <= 599 ? error.status : undefined;
    const retryable = error.status === 0 || error.status === 408 || error.status === 409 ||
      error.status === 425 || error.status === 429 || error.status >= 500;
    return {
      code: error.code ?? `http_${error.status}`,
      message: error.message,
      ...(statusCode === undefined ? {} : { statusCode }),
      retryable,
    };
  }
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "agent_request_failed";
    const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
    const retryable = status === undefined
      ? /network|fetch|socket|chunk|terminated|incomplete|connection|timeout/iu.test(error.message)
      : status === 0 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
    return {
      code,
      message: error.message,
      ...(status === undefined ? {} : { statusCode: status }),
      retryable,
    };
  }
  return { code: "agent_request_failed", message: String(error), retryable: false };
}

function providerRetryDelay(attempt: number): number {
  // Keep the first retry responsive while giving an overloaded gateway a
  // little time to recover. Eve remains responsible for model-step retries.
  return Math.min(4_000, 500 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Coalesce a hot external-store value without allowing a continuous stream to
 * starve the UI. The timer is owned by the hook instance, while the ref always
 * points at the newest authoritative value.
 */
function useThrottledSnapshot<T>(value: T, delayMs: number): T {
  const latestRef = useRef(value);
  const timerRef = useRef<number | undefined>(undefined);
  const [snapshot, setSnapshot] = useState(value);
  latestRef.current = value;

  useEffect(() => {
    if (Object.is(snapshot, value) || timerRef.current !== undefined) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      setSnapshot(latestRef.current);
    }, delayMs);
  }, [delayMs, snapshot, value]);

  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, []);

  return snapshot;
}

function EmptyThread({ disabled, messages, onPrompt }: { readonly disabled: boolean; readonly messages: AgentMessages; readonly onPrompt: (prompt: string) => void }) {
  const suggestions = [
    { icon: SearchIcon, text: messages.suggestionInspect },
    { icon: HammerIcon, text: messages.suggestionImplement },
    { icon: SparklesIcon, text: messages.suggestionResearch },
    { icon: ShieldCheckIcon, text: messages.suggestionReview },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-4 pb-6 text-center">
      <div className="space-y-3">
        <div className="mx-auto flex size-10 items-center justify-center rounded-xl border bg-card text-foreground shadow-sm">
          <SparklesIcon className="size-5" />
        </div>
        <h1 className="text-3xl font-medium text-foreground">{messages.emptyTitle}</h1>
      </div>
      <div className="grid w-full max-w-3xl grid-cols-1 gap-2 min-[520px]:grid-cols-2 lg:grid-cols-4">
        {suggestions.map(({ icon: Icon, text }, index) => (
          <Button className={cn("h-24 flex-col items-start justify-between whitespace-normal px-4 py-3 text-left text-sm lg:h-36", index > 1 && "hidden lg:flex")} disabled={disabled} key={text} onClick={() => onPrompt(text)} variant="outline">
            <Icon className="size-4 text-muted-foreground" />
            <span>{text}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

function latestTurnOutcome(events: readonly MessageStreamEvent[]): "cancelled" | "completed" | "failed" | undefined {
  const startedIndex = events.findLastIndex((candidate) => candidate.type === "turn.started");
  const latestStarted = startedIndex >= 0 ? events[startedIndex] : undefined;
  const turnId = latestStarted?.type === "turn.started" ? latestStarted.data.turnId : undefined;
  const event = [...events.slice(startedIndex + 1)].reverse().find((candidate) =>
    candidate.type === "session.failed" ||
    (turnId !== undefined &&
      (candidate.type === "turn.cancelled" || candidate.type === "turn.completed" || candidate.type === "turn.failed") &&
      candidate.data.turnId === turnId),
  );
  if (event?.type === "turn.cancelled") return "cancelled";
  if (event?.type === "turn.completed") return "completed";
  if (event?.type === "turn.failed" || event?.type === "session.failed") return "failed";
  return undefined;
}

/** A model turn can complete while Eve is still committing the session
 * boundary. The composer must remain locked until the session is parked or
 * terminal, otherwise a follow-up can race the still-active runtime. */
function hasSettledSessionBoundary(events: readonly MessageStreamEvent[]): boolean {
  const latestTurnIndex = events.findLastIndex((event) => event.type === "turn.started");
  const latestBoundaryIndex = events.findLastIndex((event) =>
    event.type === "session.waiting" ||
    event.type === "session.completed" ||
    event.type === "session.failed",
  );
  // A transport snapshot can append non-lifecycle events after the durable
  // boundary. The boundary is still authoritative as long as it belongs to
  // the latest turn; only a newer turn invalidates it.
  return latestBoundaryIndex > latestTurnIndex;
}

function latestTurnFailure(events: readonly MessageStreamEvent[]): string | undefined {
  if (latestTurnOutcome(events) !== "failed") return undefined;
  const startedIndex = events.findLastIndex((candidate) => candidate.type === "turn.started");
  const latestStarted = startedIndex >= 0 ? events[startedIndex] : undefined;
  const turnId = latestStarted?.type === "turn.started" ? latestStarted.data.turnId : undefined;
  const event = [...events.slice(startedIndex + 1)].reverse().find((candidate) =>
    candidate.type === "session.failed" ||
    (turnId !== undefined &&
      (candidate.type === "turn.failed" || candidate.type === "step.failed") &&
      candidate.data.turnId === turnId),
  );
  return event?.type === "turn.failed" || event?.type === "step.failed" || event?.type === "session.failed" ? event.data.message : undefined;
}
