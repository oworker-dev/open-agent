"use client";

import type { UserContent } from "ai";
import { defaultMessageReducer, isCurrentTurnBoundaryEvent, type ClientSession, type MessageStreamEvent } from "eve/client";
import { useEveAgent, type EveMessage } from "eve/react";
import { AssistantRuntimeProvider, unstable_defaultDirectiveFormatter, useExternalStoreRuntime, type AppendMessage, type ExternalThreadQueueAdapter } from "@assistant-ui/react";
import { AlertCircleIcon, Clock3Icon, HammerIcon, RotateCcwIcon, SearchIcon, ShieldCheckIcon, SparklesIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button.js";
import { cn } from "../utils.js";
import { attachAgentSession, createAgentSession } from "./agent-client.js";
import { createBrowserAttachmentAdapter, createHttpAgentAssetUploadAdapter } from "./browser-asset-upload.js";
import { convertEveMessages, getEveMessageContent } from "./eve-message-adapter.js";
import type { AgentInputResponse } from "./agent-message.js";
import { AssistantThreadSurface, type AgentApprovalTakeover } from "./assistant-thread-surface.js";
import type { AgentInterruptedTurn, AgentModelOption, AgentPromptMenuItem, AgentQueuedTurn, AgentSessionDeliverable, AgentThread, AgentThreadPatch, AgentTranscriptCoverage, AgentWorkspaceClientConfig, AgentWorkspaceMailbox, PromptInputMessage } from "./contracts.js";
import { sanitizeAgentError } from "./error-presentation.js";
import { AgentMailboxHttpError } from "./http-agent-mailbox.js";
import { messagesFor, type AgentLocale, type AgentMessages } from "./i18n.js";
import {
  interruptedTurnContextFromEvents,
  interruptedTurnContextsFromEvents,
  rewriteContextFromEvents,
} from "./retained-context.js";
import { appendThreadEvent, appendThreadEventIndexed, dedupeThreadEvents, eventIdentity, titleFromPrompt } from "./thread-storage.js";
import {
  eventsBeforeLastUserTurn,
  hasSettledLatestTurn,
  isProxiedInputOnlyMessage,
  normalizeSettledAgentMessages,
  projectAgentDisplayTimeline,
  shouldSuppressInterruptedTurnDisplayEvent,
  shouldSuppressInterruptedTurnStreamEvent,
  unresolvedInputRequests,
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

// An edit remounts the runtime at each durable checkpoint. Operation claims
// outlive a component instance so only one mount advances a given checkpoint.
const activeEditedTurnOperations = new Set<string>();
// A staged edit is an explicit browser action, not merely a persisted
// `pendingTurn` snapshot. Keep that intent across the revision remount that
// replaces the visible transcript. A full page refresh starts with an empty
// set, so stale checkpoints remain retryable instead of auto-submitting.
const pendingEditedTurnOperations = new Set<string>();
const CANCELLATION_STREAM_REATTACH_AFTER_MS = 5_000;

// Long tool calls can outlive a browser/proxy connection. Eve resumes from
// its durable cursor, but the default client policy is intentionally short for
// ordinary chat turns. Keep long-running response streams reconnectable without
// changing the server-side durable loop.
const LONG_RUNNING_STREAM_RECONNECT_POLICY = {
  retryableErrorStatuses: [404, 408, 409, 425, 429, 500, 502, 503, 504],
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
  const editStagePendingRef = useRef(false);
  // These gates intentionally live only for the current React mount. A
  // persisted edit checkpoint is not proof that the browser still owns the
  // clear/resubmit operation; after refresh it must remain retryable instead
  // of silently submitting the same user message again.
  const editResubmitPendingRef = useRef(false);
  const turnAdmissionBusyRef = useRef(false);
  const cancellationRecoveryRef = useRef<() => void>(() => undefined);
  const cancellationIdleTimerRef = useRef<number | undefined>(undefined);
  const [cancellationState, setCancellationState] = useState<"idle" | "requested" | "cancelling">(
    thread.status === "cancelling" ? "cancelling" : "idle",
  );
  const [localInterruption, setLocalInterruption] = useState<LocalInterruption>();
  const [cancellationError, setCancellationError] = useState<string>();
  const [queueError, setQueueError] = useState<string>();
  const [turnError, setTurnError] = useState<string | undefined>(() => latestTurnFailure(thread.events));
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
        }, 50);
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
      if (event.type === "turn.failed" || event.type === "session.failed") {
        setTurnError(event.data.message);
      }
      if (event.type === "turn.completed" || event.type === "turn.cancelled") {
        setTurnError(undefined);
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

  const runtimeIsBusy = agent.status === "submitted" || agent.status === "streaming";
  latestEventsRef.current = agent.events;
  const authoritativeEvents = isRecovering ? thread.events : agent.events;
  // A durable turn boundary is authoritative. React stream state can remain
  // stale after a reconnect even though Eve has already parked the session.
  const pendingTurnInFlight = isPendingTurnInFlight(thread.pendingTurn) &&
    !hasSettledLatestTurn(authoritativeEvents);
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
    if (persistedPendingTurn && compactedEventsRef.current.some((event) =>
      event.type === "message.received" && (
        event.data.clientMessageId === persistedPendingTurn.id ||
        event.data.message.trim() === persistedPendingTurn.text.trim()
      )
    )) {
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
        pendingTurnRef.current = undefined;
        acceptedPendingTurn = true;
      }
    }
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
      status: cancellationRef.current.requested
        ? "cancelling"
        : turnError ? "error" : awaitingInput ? "waiting" : agent.status,
      updatedAt: Date.now(),
    });
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
    : !hasTurnFailure && (turnError || errorMessage)
      ? sanitizeAgentError(turnError ?? errorMessage ?? "The Agent request failed.")
      : undefined;
  const usage = summarizeUsage(agent.events);

  useEffect(() => {
    if (
      agent.status === "error" &&
      thread.pendingTurn?.state === "submitting"
    ) {
      const dispatchedId = dispatchingQueuedTurnIdRef.current;
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
  }, [agent.error, agent.session?.sessionId, agent.status, messages.queueDeliveryFailed, onChange, thread.pendingTurn]);

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
    }
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
    if (admissionBusy || turnAdmissionBusyRef.current) {
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
        id: createPendingTurnId(),
        state: "submitting" as const,
        submittedAt: Date.now(),
        text,
      };
      pendingTurnRef.current = pendingTurn;
      onChange({ pendingTurn });
    }
    if (text.length > 0 && agent.data.messages.length === 0) {
      onChange({ title: titleFromPrompt(text) });
    }

    try {
      await sendPrompt(agent.send, { files: message.files, text }, thread.retainedContext);
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
    const settled = dedupeThreadEvents(effectiveRenderEvents);
    if (displayInterruptedTurns.length === 0) return settled;
    let visible: readonly MessageStreamEvent[] = settled.filter((event, index) =>
      !shouldSuppressInterruptedTurnDisplayEvent(event, index, displayInterruptedTurns)
    );
    for (const interruptedTurn of displayInterruptedTurns) {
      visible = withLocalInterruptedBoundary(visible, interruptedTurn.turnId);
    }
    return visible;
  }, [displayInterruptedTurns, effectiveRenderEvents]);
  const projectedRuntimeMessages = useMemo(() => {
    const source = displayInterruptedTurns.length > 0
      ? messagesFromEvents(interruptedDisplayEvents)
      : effectiveRenderMessages;
    return normalizeSettledAgentMessages(source, interruptedDisplayEvents);
  },
    [displayInterruptedTurns.length, effectiveRenderMessages, interruptedDisplayEvents]);
  const projectedMessages = projectStagedUserMessages(
    ensureActiveAssistantMessage(
      projectedRuntimeMessages,
      interruptedDisplayEvents,
      isBusy || thread.pendingTurn?.state === "resubmitting" || Boolean(latestTurnFailure(interruptedDisplayEvents)),
      thread.pendingTurn,
    ),
    thread.queuedTurns.filter((turn) => turn.intent === "post-cancellation"),
  );
  const ungroupedVisibleMessages = projectedMessages.filter((message) =>
    !isProxiedInputOnlyMessage(message, effectiveRenderEvents),
  );
  const ungroupedDisplayEvents = interruptedDisplayEvents;
  const displayTimeline = useMemo(
    () => projectAgentDisplayTimeline(ungroupedVisibleMessages, ungroupedDisplayEvents),
    [ungroupedDisplayEvents, ungroupedVisibleMessages],
  );
  const visibleMessages = displayTimeline.messages;
  const displayEvents = displayTimeline.events;
  const assistantMessages = convertEveMessages({ ...agent.data, messages: visibleMessages }, {
    assetUrl: client?.assetUrl,
    error: agent.error,
    isRunning: isBusy,
  });
  const queueAdapter: ExternalThreadQueueAdapter = {
    edit: () => {
      throw new Error("Editing a durable mailbox item is not supported.");
    },
    enqueue: (message) => {
      void submit(promptFromAssistantMessage(getEveMessageContent(message)));
    },
    items: thread.queuedTurns.filter((turn) => turn.intent !== "post-cancellation").map((turn) => ({
      id: turn.id,
      parts: [{ text: turn.text, type: "text" }],
      prompt: turn.text,
    })),
    move: () => {
      throw new Error("Reordering durable mailbox items is not supported.");
    },
    remove: removeQueuedTurn,
    // Eve injects follow-ups at the next safe turn boundary. The default
    // assistant-ui steer lane is deliberately mapped to that durable FIFO.
    steer: (message) => {
      void submit(promptFromAssistantMessage(getEveMessageContent(message)));
    },
    steerItems: [],
  };

  const stageEditedTurn = (prompt: PromptInputMessage) => {
    if (!prompt.text && prompt.files.length === 0) return;
    const durableSession = sessionRef.current ?? attachAgentSession(connection, agent.session);
    if (!durableSession) {
      if (thread.pendingTurn?.state === "interrupted" || thread.pendingTurn?.state === "delivery-failed") {
        void submit(prompt);
        return;
      }
      setTurnError("The Agent session is not available. Reload this conversation and try again.");
      return;
    }
    if (admissionBusy || editStagePendingRef.current) {
      setTurnError("The latest message cannot be edited until the current Agent turn reaches a durable boundary.");
      return;
    }
    editStagePendingRef.current = true;
    editResubmitPendingRef.current = false;
    sessionRef.current = durableSession;
    setTurnError(undefined);
    const pendingTurn = {
      ...(prompt.files.length > 0 ? { files: prompt.files } : {}),
      id: createPendingTurnId(),
      state: "clearing" as const,
      submittedAt: Date.now(),
      text: prompt.text,
    };
    pendingEditedTurnOperations.add(`${pendingTurn.id}:clear`);
    const retainedEvents = eventsBeforeLastUserTurn(agent.events);
    // Close assistant-ui's edit composer before replacing its external
    // transcript. Updating both in one React commit can invalidate the message
    // store and turn a valid click into a silent no-op.
    queueMicrotask(() => {
      onChange({
        events: retainedEvents,
        retainedContext: rewriteContextFromEvents(retainedEvents, recoveryContextWindowTokens),
        pendingTurn,
        queuedTurns: [],
        revision: (thread.revision ?? 0) + 1,
        session: durableSession.state,
        status: "ready",
        ...(!retainedEvents.some((event) => event.type === "message.received")
          ? { title: titleFromPrompt(prompt.text) }
          : {}),
        updatedAt: Date.now(),
      });
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
  const assistantRuntime = useExternalStoreRuntime({
    adapters: {
      attachments: attachmentAdapter,
    },
    // Lock regular sends while an approval is pending, but keep the runtime
    // available to the edit composer. assistant-ui intentionally allows edits
    // while `isSendDisabled` is true; `isDisabled` would disable both paths.
    isDisabled: !providerReady,
    isSendDisabled: inputLocked,
    isRunning: isBusy,
    messages: assistantMessages,
    queue: queueAdapter,
    onCancel: async () => {
      requestCancellation();
    },
    onEdit: async (message: AppendMessage) => {
      const content = getEveMessageContent(message);
      const prompt = promptFromAssistantMessage(content);
      stageEditedTurn(prompt);
    },
    onNew: async (message: AppendMessage) => {
      await submit(promptFromAssistantMessage(getEveMessageContent(message)));
    },
    onRespondToToolApproval: async (response) => {
      prepareTurn();
      await agent.respond(
        [{ optionId: response.optionId, requestId: response.approvalId, text: response.reason }],
        retainedContextOptions(thread.retainedContext),
      );
    },
  });

  useEffect(() => {
    const pendingTurn = thread.pendingTurn;
    if (
      pendingTurn?.state !== "clearing" ||
      !providerReady ||
      isRecovering ||
      (!editStagePendingRef.current && !pendingEditedTurnOperations.has(`${pendingTurn.id}:clear`))
    ) return;
    const durableSession = sessionRef.current;
    if (!durableSession) return;
    const releaseOperation = claimEditedTurnOperation(pendingTurn.id, "clear");
    if (!releaseOperation) return;
    turnAdmissionBusyRef.current = true;
    prepareTurn();
    void (async () => {
      try {
        const clearResult = await durableSession.clear();
        if (clearResult.status !== "accepted") throw new Error("The session is no longer active.");
        for await (const event of durableSession.stream({
          follow: true,
          streamReconnectPolicy: LONG_RUNNING_STREAM_RECONNECT_POLICY,
        })) {
          if (isCurrentTurnBoundaryEvent(event)) break;
        }
        pendingEditedTurnOperations.add(`${pendingTurn.id}:resubmit`);
        onChange({
          pendingTurn: { ...pendingTurn, state: "resubmitting" },
          revision: (thread.revision ?? 0) + 1,
          session: durableSession.state,
          status: "ready",
          updatedAt: Date.now(),
        });
        editStagePendingRef.current = false;
        editResubmitPendingRef.current = true;
      } catch (error) {
        editStagePendingRef.current = false;
        editResubmitPendingRef.current = false;
        turnAdmissionBusyRef.current = false;
        onChange({ pendingTurn: { ...pendingTurn, state: "delivery-failed" }, status: "error" });
        setTurnError(error instanceof Error ? error.message : "Unable to resend this message.");
      } finally {
        releaseOperation();
      }
    })();
  }, [isRecovering, onChange, providerReady, runtimeIsBusy, thread.pendingTurn, thread.revision]);

  useEffect(() => {
    const pendingTurn = thread.pendingTurn;
    if (
      pendingTurn?.state !== "resubmitting" ||
      !providerReady ||
      isRecovering ||
      (!editResubmitPendingRef.current && !pendingEditedTurnOperations.has(`${pendingTurn.id}:resubmit`))
    ) return;
    const releaseOperation = claimEditedTurnOperation(pendingTurn.id, "resubmit");
    if (!releaseOperation) return;
    editResubmitPendingRef.current = false;
    const claimedTurn = { ...pendingTurn, state: "submitting" as const };
    prepareTurn();
    pendingTurnRef.current = claimedTurn;
    turnAdmissionBusyRef.current = true;
    onChange({ pendingTurn: claimedTurn });
    void sendPrompt(agent.send, {
      files: pendingTurn.files ?? [],
      text: pendingTurn.text,
    }, thread.retainedContext).catch((error: unknown) => {
      editResubmitPendingRef.current = false;
      turnAdmissionBusyRef.current = false;
      onChange({ pendingTurn: { ...pendingTurn, state: "delivery-failed" }, status: "error" });
      setTurnError(error instanceof Error ? error.message : "Unable to resend this message.");
    }).finally(() => {
      releaseOperation();
    });
  }, [isRecovering, onChange, providerReady, runtimeIsBusy, thread.pendingTurn]);

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
        id: next.id,
        state: "submitting",
        submittedAt: next.submittedAt,
        text: next.text,
      },
    });
    pendingTurnRef.current = {
      id: next.id,
      state: "submitting",
      submittedAt: next.submittedAt,
      text: next.text,
    };
    void agent.send(next.text, retainedContextOptions(thread.retainedContext)).catch((error: unknown) => {
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
          composerTop={visibleQueuedTurns.length > 0 || queueError ? (
            <FollowUpQueue
              error={queueError}
              messages={messages}
              onRemove={removeQueuedTurn}
              onRetry={markQueuedTurnForRetry}
              turns={visibleQueuedTurns}
            />
          ) : undefined}
          draftStorageKey={draftStorageKey}
          historyHasMore={historyHasMore}
          historyLoading={historyLoading}
          events={displayEvents}
          eveMessages={visibleMessages}
          fallbackStartedAt={thread.pendingTurn?.submittedAt}
          inputDisabled={inputLocked}
          isBusy={isBusy}
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
          runtimeError={runtimeError}
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
): readonly EveMessage[] {
  const projectedMessages = projectPendingUserMessage(messages, pendingTurn);
  const terminalFailure = latestTurnFailure(events);
  if (!isBusy && !terminalFailure) return projectedMessages;
  const started = [...events].reverse().find((event) => event.type === "turn.started");
  const turnId = started?.type === "turn.started" ? started.data.turnId : undefined;
  if (turnId && projectedMessages.some((message) => message.role === "assistant" && message.metadata?.turnId === turnId)) {
    return projectedMessages;
  }
  if (!turnId && !pendingTurn && projectedMessages.at(-1)?.role === "assistant") return projectedMessages;
  const placeholderId = turnId ?? pendingTurn?.id ?? "pending-turn";
  const displayTurnId = turnId ?? (terminalFailure ? placeholderId : undefined);
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

function projectPendingUserMessage(
  messages: readonly EveMessage[],
  pendingTurn?: AgentThread["pendingTurn"],
): readonly EveMessage[] {
  if (!pendingTurn) return messages;
  // The assistant response normally follows the accepted user message. Only
  // checking `messages.at(-1)` therefore projected a second copy after a
  // refresh while the pending edit checkpoint was still present. Search the
  // authoritative transcript by content/attachments instead.
  // Only the latest durable user message can acknowledge a pending admission.
  // Matching any earlier identical prompt suppresses a legitimate repeated
  // request and makes the following assistant turn look as if it vanished.
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const alreadyProjected = latestUserMessage !== undefined &&
    pendingTurnMatchesMessage(pendingTurn, latestUserMessage);
  if (alreadyProjected) return messages;
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

function projectStagedUserMessages(
  messages: readonly EveMessage[],
  turns: readonly AgentQueuedTurn[],
): readonly EveMessage[] {
  if (turns.length === 0) return messages;
  const projected = [...messages];
  for (const turn of turns) {
    const id = `${turn.id}:user`;
    if (projected.some((message) => message.id === id)) continue;
    projected.push({
      id,
      parts: [{ text: turn.text, type: "text" }],
      role: "user",
    });
  }
  return projected;
}

function pendingTurnMatchesMessage(
  pendingTurn: NonNullable<AgentThread["pendingTurn"]>,
  message: EveMessage,
): boolean {
  if (eveMessageText(message) !== pendingTurn.text) return false;
  const messageFiles = message.parts.filter((part) => part.type === "file");
  const pendingFiles = pendingTurn.files ?? [];
  return messageFiles.length === pendingFiles.length && messageFiles.every((file, index) => {
    const pending = pendingFiles[index];
    return pending?.mediaType === file.mediaType &&
      pending.filename === file.filename &&
      pending.url === file.url;
  });
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

function eveMessageText(message: EveMessage): string {
  return message.parts
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("\n")
    .trim();
}

function createPendingTurnId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `pending-${Date.now()}`;
}

function claimEditedTurnOperation(
  turnId: string,
  operation: "clear" | "resubmit",
): (() => void) | undefined {
  const key = `${turnId}:${operation}`;
  if (activeEditedTurnOperations.has(key)) return undefined;
  activeEditedTurnOperations.add(key);
  pendingEditedTurnOperations.delete(key);
  return () => activeEditedTurnOperations.delete(key);
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
  const assetNotes = prompt.files
    .filter((file) => file.assetId)
    .map((file) => `[open-agent-asset ${JSON.stringify({ id: file.assetId, mediaType: file.mediaType, name: file.filename ?? "file", ...(file.sizeBytes ? { size: file.sizeBytes } : {}) })}] Attached asset ${file.filename ?? "file"}. Use import_asset before inspecting or processing it.`);
  const text = [prompt.text, ...assetNotes].filter((value) => value.trim().length > 0).join("\n\n");
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
  if (!(error instanceof Error)) return false;
  const description = `${error.name} ${error.message}`.toLowerCase();
  return /network|fetch|stream|socket|chunk|terminated|incomplete|connection|timeout/u.test(description);
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
  const last = events.at(-1);
  return last?.type === "session.waiting" ||
    last?.type === "session.completed" ||
    last?.type === "session.failed";
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
