"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { defaultMessageReducer, isCurrentTurnBoundaryEvent } from "eve/client";
import { useEveAgent } from "eve/react";
import { AssistantRuntimeProvider, unstable_defaultDirectiveFormatter, useExternalStoreRuntime } from "@assistant-ui/react";
import { Clock3Icon, HammerIcon, RotateCcwIcon, SearchIcon, ShieldCheckIcon, SparklesIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button.js";
import { cn } from "../utils.js";
import { attachAgentSession, createAgentSession } from "./agent-client.js";
import { convertEveMessages, getEveMessageContent } from "./eve-message-adapter.js";
import { AssistantThreadSurface } from "./assistant-thread-surface.js";
import { sanitizeAgentError } from "./error-presentation.js";
import { AgentMailboxHttpError } from "./http-agent-mailbox.js";
import { messagesFor } from "./i18n.js";
import { interruptedTurnContextFromEvents, interruptedTurnContextsFromEvents, rewriteContextFromEvents, } from "./retained-context.js";
import { appendThreadEvent, titleFromPrompt } from "./thread-storage.js";
import { eventsBeforeLastUserTurn, hasSettledLatestTurn, isProxiedInputOnlyMessage, projectAgentDisplayTimeline, shouldSuppressInterruptedTurnDisplayEvent, unresolvedInputRequests, } from "./turn-presentation.js";
import { summarizeUsage } from "./usage.js";
const activeEditedTurnOperations = new Set();
const CANCELLATION_STREAM_REATTACH_AFTER_MS = 5_000;
export function AgentThreadView({ client, commands, draftStorageKey, isRecovering = false, locale, mailbox, mentions, models, onChange, onCancelRecovery, onEvent, onOpenSubagent, onRetryRecovery, onRecoveryNeeded, providerReady, recoveryError, reasoningLevels, thread, }) {
    const preferencesRef = useRef(thread.preferences);
    const latestEventsRef = useRef(thread.events);
    const persistedCancellationTurnId = thread.status === "cancelling"
        ? latestStartedTurnId(thread.events)
        : undefined;
    const cancellationRef = useRef({
        ...(persistedCancellationTurnId ? { turnId: persistedCancellationTurnId } : {}),
        requested: thread.status === "cancelling",
    });
    const recoveryRequestedRef = useRef(false);
    const initialEventCountRef = useRef(thread.events.length);
    const initialStreamIndexRef = useRef(thread.session.streamIndex);
    const compactedEventsRef = useRef(thread.events);
    const processedEventCountRef = useRef(thread.events.length);
    const durableProbeInFlightRef = useRef(false);
    const lastObservedEventAtRef = useRef(Date.now());
    const queuedTurnsRef = useRef(thread.queuedTurns);
    const pendingTurnRef = useRef(thread.pendingTurn);
    const retainedContextRef = useRef(thread.retainedContext);
    const interruptedTurnsRef = useRef(thread.interruptedTurns ?? []);
    const closedInputRequestIdsRef = useRef(new Set(thread.closedInputRequestIds));
    const dispatchingQueuedTurnIdRef = useRef(undefined);
    const mailboxEnqueueIdsRef = useRef(new Set());
    const editStagePendingRef = useRef(false);
    const turnAdmissionBusyRef = useRef(false);
    const cancellationRecoveryRef = useRef(() => undefined);
    const [cancellationState, setCancellationState] = useState("idle");
    const [localInterruption, setLocalInterruption] = useState();
    const [cancellationError, setCancellationError] = useState();
    const [queueError, setQueueError] = useState();
    const [turnError, setTurnError] = useState(() => latestTurnFailure(thread.events));
    const messages = messagesFor(locale);
    const recoveryContextWindowTokens = models.find((model) => model.id === thread.preferences.modelId)?.contextWindowTokens ?? models[0]?.contextWindowTokens ?? 272_000;
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
        const recoveredContext = interruptedTurnContextsFromEvents(thread.events, thread.retainedContext, recoveryContextWindowTokens);
        retainedContextRef.current = recoveredContext;
        if (!sameContextEntries(recoveredContext, thread.retainedContext)) {
            onChange({ retainedContext: recoveredContext, updatedAt: Date.now() });
        }
    }, [onChange, recoveryContextWindowTokens, thread.events, thread.retainedContext]);
    useEffect(() => {
        closedInputRequestIdsRef.current = new Set(thread.closedInputRequestIds);
    }, [thread.closedInputRequestIds]);
    const [connection] = useState(() => createAgentSession(client, () => preferencesRef.current, thread.session));
    const sessionRef = useRef(attachAgentSession(connection, connection.initialSession));
    const requestDurableCancellation = useCallback((durableSession, turnId) => {
        const cancellation = cancellationRef.current;
        if (!cancellation.requested)
            return;
        if (turnId) {
            if (cancellation.sentTurnId === turnId)
                return;
            cancellation.sentTurnId = turnId;
        }
        else {
            if (cancellation.sentSessionId === durableSession.state.sessionId)
                return;
            cancellation.sentSessionId = durableSession.state.sessionId;
        }
        void durableSession.cancel(turnId ? { turnId } : undefined)
            .catch((error) => {
            cancellationRef.current = { requested: false, turnId };
            setCancellationError(error instanceof Error ? error.message : "Unable to stop this turn.");
            setCancellationState("idle");
        });
    }, []);
    const handleEvent = useCallback((event) => {
        lastObservedEventAtRef.current = Date.now();
        if (event.type === "turn.started") {
            const cancellation = cancellationRef.current;
            cancellation.turnId = event.data.turnId;
            if (cancellation.requested && cancellation.localTurnId) {
                const interruptedTurns = retargetInterruptedTurn(interruptedTurnsRef.current, cancellation.localTurnId, event.data.turnId);
                interruptedTurnsRef.current = interruptedTurns;
                cancellation.localTurnId = event.data.turnId;
                setLocalInterruption((current) => current
                    ? { ...current, turnId: event.data.turnId }
                    : current);
                onChange({ interruptedTurns, updatedAt: Date.now() });
            }
            const durableSession = sessionRef.current;
            if (durableSession)
                requestDurableCancellation(durableSession, event.data.turnId);
        }
        if (event.type === "turn.failed" || event.type === "session.failed") {
            setTurnError(event.data.message);
        }
        if (event.type === "turn.completed" || event.type === "turn.cancelled") {
            setTurnError(undefined);
        }
        if (event.type === "session.waiting" &&
            cancellationRef.current.requested) {
            cancellationRef.current = { requested: false };
            setCancellationState("idle");
        }
        onEvent?.(event);
    }, [onChange, onEvent, requestDurableCancellation]);
    const agent = useEveAgent({
        auth: connection.auth,
        headers: connection.headers,
        host: connection.host,
        initialEvents: thread.events,
        initialSession: connection.initialSession,
        onEvent: handleEvent,
        onSessionChange: (nextSession) => {
            sessionRef.current = attachAgentSession(connection, nextSession);
            onChange({ session: nextSession ?? { streamIndex: 0 } });
            if (sessionRef.current && cancellationRef.current.requested) {
                requestDurableCancellation(sessionRef.current, cancellationRef.current.turnId);
            }
        },
        prepareSend: client?.prepareSend,
        ...(sessionRef.current ? { session: sessionRef.current } : {}),
    });
    const stopAgent = agent.stop;
    const runtimeIsBusy = agent.status === "submitted" || agent.status === "streaming";
    latestEventsRef.current = agent.events;
    const pendingTurnInFlight = isPendingTurnInFlight(thread.pendingTurn);
    const durableTurnSettled = !pendingTurnInFlight && hasSettledLatestTurn(agent.events);
    const cancellationSettling = cancellationRef.current.requested || thread.status === "cancelling";
    const agentIsBusy = runtimeIsBusy && !localInterruption && !cancellationSettling && !durableTurnSettled;
    const isBusy = pendingTurnInFlight || agentIsBusy ||
        (isRecovering && !localInterruption && !cancellationSettling && !durableTurnSettled);
    const admissionBusy = pendingTurnInFlight || (!durableTurnSettled &&
        (runtimeIsBusy || isRecovering || cancellationSettling));
    const pendingInputRequests = unresolvedInputRequests(agent.events, closedInputRequestIdsRef.current);
    const awaitingInput = pendingInputRequests.length > 0;
    const inputLocked = pendingInputRequests.some((request) => request.kind !== "question");
    const closeInputRequests = useCallback((requestIds) => {
        if (requestIds.length === 0)
            return;
        const next = new Set(closedInputRequestIdsRef.current);
        for (const requestId of requestIds)
            next.add(requestId);
        closedInputRequestIdsRef.current = next;
        onChange({ closedInputRequestIds: [...next] });
    }, [onChange]);
    useEffect(() => {
        turnAdmissionBusyRef.current = admissionBusy;
    }, [admissionBusy]);
    const requestRecovery = useCallback(() => {
        if (recoveryRequestedRef.current)
            return;
        const state = agent.session;
        if (!state)
            return;
        const consumedEvents = Math.max(0, agent.events.length - initialEventCountRef.current);
        const currentSession = {
            ...state,
            streamIndex: initialStreamIndexRef.current + consumedEvents,
        };
        recoveryRequestedRef.current = true;
        onChange({
            session: currentSession,
            status: cancellationRef.current.requested ? "cancelling" : "streaming",
            updatedAt: Date.now(),
        });
        stopAgent();
        onRecoveryNeeded();
    }, [agent.events.length, agent.session, onChange, onRecoveryNeeded, stopAgent]);
    cancellationRecoveryRef.current = requestRecovery;
    useEffect(() => {
        if (isRecovering || !cancellationSettling || !agent.session?.sessionId ||
            recoveryRequestedRef.current)
            return;
        const timer = window.setTimeout(() => {
            if (cancellationRef.current.requested &&
                Date.now() - lastObservedEventAtRef.current >= CANCELLATION_STREAM_REATTACH_AFTER_MS)
                requestRecovery();
        }, CANCELLATION_STREAM_REATTACH_AFTER_MS);
        return () => window.clearTimeout(timer);
    }, [agent.events.length, agent.session?.sessionId, cancellationSettling, isRecovering, requestRecovery]);
    useEffect(() => {
        const lastEvent = agent.events.at(-1);
        if (agent.session?.sessionId &&
            !isRecovering &&
            thread.status !== "ready" &&
            thread.pendingTurn?.state !== "resubmitting" &&
            !cancellationRef.current.requested &&
            !isBusy &&
            !hasSettledLatestTurn(agent.events) &&
            lastEvent &&
            !isSessionBoundary(lastEvent)) {
            requestRecovery();
        }
    }, [agent.events, agent.session?.sessionId, isBusy, isRecovering, requestRecovery, thread.pendingTurn?.state, thread.status]);
    useEffect(() => {
        const durableSession = sessionRef.current;
        if (isRecovering || !agentIsBusy || !agent.session?.sessionId || !durableSession || recoveryRequestedRef.current)
            return;
        let disposed = false;
        let timer;
        const probe = async () => {
            if (disposed || durableProbeInFlightRef.current || recoveryRequestedRef.current)
                return;
            durableProbeInFlightRef.current = true;
            try {
                const consumedEvents = Math.max(0, agent.events.length - initialEventCountRef.current);
                const cursor = initialStreamIndexRef.current + consumedEvents;
                const durableProgress = await hasDurableProgressAfter(durableSession, cursor);
                const streamSilentFor = Date.now() - lastObservedEventAtRef.current;
                if (durableProgress || streamSilentFor >= LIVE_STREAM_REATTACH_AFTER_MS) {
                    requestRecovery();
                }
            }
            finally {
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
    }, [agent.events.length, agent.session?.sessionId, agentIsBusy, isRecovering, requestRecovery]);
    useEffect(() => {
        if (isRecovering)
            return;
        const newEvents = agent.events.slice(processedEventCountRef.current);
        const persistenceInterruptedTurns = localInterruption
            ? upsertInterruptedTurn(interruptedTurnsRef.current, {
                eventCount: localInterruption.events.length,
                streamIndex: localInterruption.streamIndex,
                turnId: localInterruption.turnId,
            })
            : interruptedTurnsRef.current;
        const persistableNewEvents = newEvents.filter((event, index) => !shouldSuppressInterruptedTurnDisplayEvent(event, processedEventCountRef.current + index, persistenceInterruptedTurns));
        const consumedEvents = Math.max(0, agent.events.length - initialEventCountRef.current);
        const streamIndex = Math.max(agent.session?.streamIndex ?? 0, initialStreamIndexRef.current + consumedEvents);
        if (agent.events.length < processedEventCountRef.current) {
            compactedEventsRef.current = agent.events;
        }
        else {
            for (const event of persistableNewEvents) {
                compactedEventsRef.current = appendThreadEvent(compactedEventsRef.current, event);
            }
        }
        processedEventCountRef.current = agent.events.length;
        const acceptedMessages = persistableNewEvents.filter((event) => event.type === "message.received");
        const cancelledTurn = persistableNewEvents.findLast((event) => event.type === "turn.cancelled");
        let retainedContext = retainedContextRef.current;
        if (cancelledTurn?.type === "turn.cancelled") {
            retainedContext = interruptedTurnContextFromEvents(compactedEventsRef.current, cancelledTurn.data.turnId, retainedContext, recoveryContextWindowTokens);
            retainedContextRef.current = retainedContext;
        }
        let acceptedPendingTurn = false;
        let acceptedQueuedTurn = false;
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
            events: compactedEventsRef.current,
            ...(acceptedPendingTurn ? { pendingTurn: undefined } : {}),
            ...(acceptedQueuedTurn ? { queuedTurns: queuedTurnsRef.current } : {}),
            ...(cancelledTurn ? { retainedContext } : {}),
            session: agent.session ? { ...agent.session, streamIndex } : { streamIndex },
            status: cancellationRef.current.requested
                ? "cancelling"
                : turnError ? "error" : awaitingInput ? "waiting" : agent.status,
            updatedAt: Date.now(),
        });
    }, [agent.events, agent.session, agent.status, awaitingInput, isRecovering, localInterruption, onChange, recoveryContextWindowTokens, turnError]);
    const latestTurnId = [...agent.events].reverse().find((event) => event.type === "turn.started")?.data.turnId;
    const hasTurnFailure = Boolean(latestTurnId && latestTurnFailureForId(agent.events, latestTurnId));
    const errorMessage = !hasTurnFailure ? cancellationError ?? turnError ?? agent.error?.message : undefined;
    const runtimeError = recoveryError
        ? sanitizeAgentError(recoveryError)
        : errorMessage
            ? sanitizeAgentError(errorMessage)
            : undefined;
    const usage = summarizeUsage(agent.events);
    useEffect(() => {
        if (agent.status === "error" &&
            thread.pendingTurn?.state === "submitting") {
            const dispatchedId = dispatchingQueuedTurnIdRef.current;
            if (dispatchedId) {
                const queuedTurns = queuedTurnsRef.current.map((turn) => turn.id === dispatchedId ? { ...turn, state: "delivery-failed" } : turn);
                queuedTurnsRef.current = queuedTurns;
                dispatchingQueuedTurnIdRef.current = undefined;
                onChange({ pendingTurn: undefined, queuedTurns });
            }
            else if (!agent.session?.sessionId) {
                onChange({ pendingTurn: { ...thread.pendingTurn, state: "delivery-failed" } });
            }
        }
    }, [agent.session?.sessionId, agent.status, onChange, thread.pendingTurn]);
    const prepareTurn = () => {
        recoveryRequestedRef.current = false;
        cancellationRef.current = { requested: false };
        setLocalInterruption(undefined);
        setCancellationError(undefined);
        setCancellationState("idle");
        setTurnError(undefined);
    };
    const updateQueuedTurns = (queuedTurns) => {
        if (sameQueuedTurnSnapshots(queuedTurnsRef.current, queuedTurns))
            return;
        queuedTurnsRef.current = queuedTurns;
        onChange({ queuedTurns, updatedAt: Date.now() });
    };
    const markQueuedTurnForRetry = (turnId) => {
        setQueueError(undefined);
        const turn = queuedTurnsRef.current.find((candidate) => candidate.id === turnId);
        if (!turn)
            return;
        if (turn.delivery === "server" && turn.mailboxItemId && mailbox) {
            void mailbox.retry(turn.mailboxItemId)
                .then(() => updateQueuedTurns(queuedTurnsRef.current.map((candidate) => candidate.id === turnId ? { ...candidate, state: "queued" } : candidate)))
                .catch((error) => setQueueError(error instanceof Error ? error.message : messages.queueDeliveryFailed));
            return;
        }
        updateQueuedTurns(queuedTurnsRef.current.map((candidate) => candidate.id === turnId ? { ...candidate, state: "queued" } : candidate));
    };
    const removeQueuedTurn = (turnId) => {
        if (dispatchingQueuedTurnIdRef.current === turnId)
            return;
        setQueueError(undefined);
        const turn = queuedTurnsRef.current.find((candidate) => candidate.id === turnId);
        if (!turn)
            return;
        if (turn.delivery === "server" && turn.mailboxItemId && mailbox) {
            if (!mailboxTurnIsCancellable(turn))
                return;
            void mailbox.cancel(turn.mailboxItemId)
                .then((receipt) => reconcileMailboxReceipt(turnId, receipt))
                .catch(async (error) => {
                if (error instanceof AgentMailboxHttpError &&
                    error.code === "mailbox_item_not_cancellable") {
                    try {
                        const receipt = await mailbox.inspect(turn.mailboxItemId);
                        reconcileMailboxReceipt(turnId, receipt);
                        return;
                    }
                    catch {
                    }
                }
                setQueueError(error instanceof Error ? error.message : messages.queueDeliveryFailed);
            });
            return;
        }
        updateQueuedTurns(queuedTurnsRef.current.filter((candidate) => candidate.id !== turnId));
    };
    function reconcileMailboxReceipt(turnId, receipt) {
        const state = mailboxTurnState(receipt.status);
        updateQueuedTurns(state === "cancelled"
            ? queuedTurnsRef.current.filter((candidate) => candidate.id !== turnId)
            : queuedTurnsRef.current.map((candidate) => candidate.id === turnId
                ? { ...candidate, mailboxItemId: receipt.itemId, state }
                : candidate));
        if (state === "committed")
            requestRecovery();
    }
    const withdrawLatestQueuedFollowUp = async () => {
        const turn = queuedTurnsRef.current.findLast((candidate) => candidate.intent === "active-turn" && mailboxTurnIsCancellable(candidate));
        if (!turn)
            return undefined;
        if (turn.delivery !== "server" || !turn.mailboxItemId || !mailbox) {
            updateQueuedTurns(queuedTurnsRef.current.filter((candidate) => candidate.id !== turn.id));
            return turn.text;
        }
        try {
            const receipt = await mailbox.cancel(turn.mailboxItemId);
            reconcileMailboxReceipt(turn.id, receipt);
            return receipt.status === "cancelled" ? turn.text : undefined;
        }
        catch (error) {
            if (error instanceof AgentMailboxHttpError &&
                error.code === "mailbox_item_not_cancellable") {
                try {
                    reconcileMailboxReceipt(turn.id, await mailbox.inspect(turn.mailboxItemId));
                }
                catch {
                }
                return undefined;
            }
            setQueueError(error instanceof Error ? error.message : messages.queueDeliveryFailed);
            return undefined;
        }
    };
    const requestCancellation = () => {
        if (!isBusy || cancellationRef.current.requested)
            return;
        const turnId = cancellationRef.current.turnId ?? latestActiveTurnId(latestEventsRef.current);
        const visibleTurnId = turnId ?? pendingTurnRef.current?.id ?? createPendingTurnId();
        const pendingAtInterruption = pendingTurnRef.current;
        const interruptedPendingTurn = pendingAtInterruption
            ? { ...pendingAtInterruption, state: "interrupted" }
            : undefined;
        const retainedContext = interruptedTurnContextFromEvents(latestEventsRef.current, turnId ?? "pending", retainedContextRef.current, recoveryContextWindowTokens, pendingAtInterruption?.text);
        retainedContextRef.current = retainedContext;
        const interruptionStreamIndex = initialStreamIndexRef.current + Math.max(0, latestEventsRef.current.length - initialEventCountRef.current);
        const interruptedTurn = {
            eventCount: compactedEventsRef.current.length,
            streamIndex: interruptionStreamIndex,
            turnId: visibleTurnId,
        };
        const interruptedTurns = upsertInterruptedTurn(interruptedTurnsRef.current, interruptedTurn);
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
        setCancellationState("idle");
        pendingTurnRef.current = interruptedPendingTurn;
        onChange({
            events: compactedEventsRef.current,
            interruptedTurns,
            pendingTurn: interruptedPendingTurn,
            retainedContext,
            status: "cancelling",
            updatedAt: Date.now(),
        });
        const queuedFollowUpWithdrawal = withdrawLatestQueuedFollowUp();
        const durableSession = sessionRef.current;
        if (durableSession)
            requestDurableCancellation(durableSession, turnId);
        void queuedFollowUpWithdrawal.then((draft) => {
            if (draft === undefined)
                return;
            onChange({
                draftRestore: { id: createPendingTurnId(), text: draft },
                updatedAt: Date.now(),
            });
        });
    };
    const submit = async (message) => {
        const text = expandPromptDirectives(message.text, commands, mentions).trim();
        if (!providerReady)
            return;
        if ((text.length === 0 && message.files.length === 0) || inputLocked)
            return;
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
                setQueueError(undefined);
                updateQueuedTurns([
                    ...queuedTurnsRef.current,
                    {
                        ...(mailbox ? { delivery: "server" } : {}),
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
                state: "submitting",
                submittedAt: Date.now(),
                text,
            };
            pendingTurnRef.current = pendingTurn;
            onChange({ pendingTurn });
        }
        if (text.length > 0 && agent.data.messages.length === 0) {
            onChange({ title: titleFromPrompt(text) });
        }
        await sendPrompt(agent.send, { files: message.files, text }, thread.retainedContext);
    };
    const displayInterruptedTurns = useMemo(() => localInterruption
        ? upsertInterruptedTurn(thread.interruptedTurns ?? [], {
            eventCount: localInterruption.events.length,
            streamIndex: localInterruption.streamIndex,
            turnId: localInterruption.turnId,
        })
        : thread.interruptedTurns ?? [], [localInterruption, thread.interruptedTurns]);
    const interruptedDisplayEvents = useMemo(() => {
        if (displayInterruptedTurns.length === 0)
            return agent.events;
        let visible = agent.events.filter((event, index) => !shouldSuppressInterruptedTurnDisplayEvent(event, index, displayInterruptedTurns));
        for (const interruptedTurn of displayInterruptedTurns) {
            visible = withLocalInterruptedBoundary(visible, interruptedTurn.turnId);
        }
        return visible;
    }, [agent.events, displayInterruptedTurns]);
    const projectedRuntimeMessages = useMemo(() => displayInterruptedTurns.length > 0
        ? messagesFromEvents(interruptedDisplayEvents)
        : agent.data.messages, [agent.data.messages, displayInterruptedTurns.length, interruptedDisplayEvents]);
    const projectedMessages = projectStagedUserMessages(ensureActiveAssistantMessage(projectedRuntimeMessages, interruptedDisplayEvents, isBusy || thread.pendingTurn?.state === "resubmitting" || Boolean(latestTurnFailure(interruptedDisplayEvents)), thread.pendingTurn), thread.queuedTurns.filter((turn) => turn.intent === "post-cancellation"));
    const ungroupedVisibleMessages = projectedMessages.filter((message) => !isProxiedInputOnlyMessage(message, agent.events));
    const ungroupedDisplayEvents = interruptedDisplayEvents;
    const displayTimeline = useMemo(() => projectAgentDisplayTimeline(ungroupedVisibleMessages, ungroupedDisplayEvents), [ungroupedDisplayEvents, ungroupedVisibleMessages]);
    const visibleMessages = displayTimeline.messages;
    const displayEvents = displayTimeline.events;
    const assistantMessages = convertEveMessages({ ...agent.data, messages: visibleMessages }, {
        error: agent.error,
        isRunning: isBusy,
    });
    const queueAdapter = {
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
        steer: (message) => {
            void submit(promptFromAssistantMessage(getEveMessageContent(message)));
        },
        steerItems: [],
    };
    const stageEditedTurn = (prompt) => {
        if (!prompt.text && prompt.files.length === 0)
            return;
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
        sessionRef.current = durableSession;
        setTurnError(undefined);
        const pendingTurn = {
            ...(prompt.files.length > 0 ? { files: prompt.files } : {}),
            id: createPendingTurnId(),
            state: "clearing",
            submittedAt: Date.now(),
            text: prompt.text,
        };
        const retainedEvents = eventsBeforeLastUserTurn(agent.events);
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
    const assistantRuntime = useExternalStoreRuntime({
        adapters: { attachments: browserAttachmentAdapter },
        isDisabled: !providerReady,
        isSendDisabled: inputLocked,
        isRunning: isBusy,
        messages: assistantMessages,
        queue: queueAdapter,
        onCancel: async () => {
            requestCancellation();
        },
        onEdit: async (message) => {
            const content = getEveMessageContent(message);
            const prompt = promptFromAssistantMessage(content);
            stageEditedTurn(prompt);
        },
        onNew: async (message) => {
            await submit(promptFromAssistantMessage(getEveMessageContent(message)));
        },
        onRespondToToolApproval: async (response) => {
            prepareTurn();
            await agent.respond([{ optionId: response.optionId, requestId: response.approvalId, text: response.reason }]);
        },
    });
    useEffect(() => {
        const pendingTurn = thread.pendingTurn;
        if (pendingTurn?.state !== "clearing" ||
            !providerReady ||
            runtimeIsBusy ||
            isRecovering)
            return;
        const durableSession = sessionRef.current;
        if (!durableSession)
            return;
        const releaseOperation = claimEditedTurnOperation(pendingTurn.id, "clear");
        if (!releaseOperation)
            return;
        turnAdmissionBusyRef.current = true;
        prepareTurn();
        void (async () => {
            try {
                const clearResult = await durableSession.clear();
                if (clearResult.status !== "accepted")
                    throw new Error("The session is no longer active.");
                for await (const event of durableSession.stream({ follow: true })) {
                    if (isCurrentTurnBoundaryEvent(event))
                        break;
                }
                onChange({
                    pendingTurn: { ...pendingTurn, state: "resubmitting" },
                    revision: (thread.revision ?? 0) + 1,
                    session: durableSession.state,
                    status: "ready",
                    updatedAt: Date.now(),
                });
            }
            catch (error) {
                turnAdmissionBusyRef.current = false;
                onChange({ pendingTurn: { ...pendingTurn, state: "delivery-failed" }, status: "error" });
                setTurnError(error instanceof Error ? error.message : "Unable to resend this message.");
            }
            finally {
                releaseOperation();
            }
        })();
    }, [isRecovering, onChange, providerReady, runtimeIsBusy, thread.pendingTurn, thread.revision]);
    useEffect(() => {
        const pendingTurn = thread.pendingTurn;
        if (pendingTurn?.state !== "resubmitting" ||
            !providerReady ||
            runtimeIsBusy ||
            isRecovering)
            return;
        const releaseOperation = claimEditedTurnOperation(pendingTurn.id, "resubmit");
        if (!releaseOperation)
            return;
        const claimedTurn = { ...pendingTurn, state: "submitting" };
        prepareTurn();
        pendingTurnRef.current = claimedTurn;
        turnAdmissionBusyRef.current = true;
        onChange({ pendingTurn: claimedTurn });
        void sendPrompt(agent.send, {
            files: pendingTurn.files ?? [],
            text: pendingTurn.text,
        }, thread.retainedContext).catch((error) => {
            turnAdmissionBusyRef.current = false;
            onChange({ pendingTurn: { ...pendingTurn, state: "delivery-failed" }, status: "error" });
            setTurnError(error instanceof Error ? error.message : "Unable to resend this message.");
        }).finally(() => {
            releaseOperation();
        });
    }, [isRecovering, onChange, providerReady, runtimeIsBusy, thread.pendingTurn]);
    useEffect(() => {
        if (!mailbox || !agent.session?.sessionId)
            return;
        const next = queuedTurnsRef.current.find((turn) => turn.delivery === "server" &&
            turn.intent !== "post-cancellation" &&
            turn.state === "queued" &&
            !turn.mailboxItemId &&
            !mailboxEnqueueIdsRef.current.has(turn.id));
        if (!next)
            return;
        mailboxEnqueueIdsRef.current.add(next.id);
        void mailbox.enqueue({
            clientMessageId: next.id,
            ...(thread.retainedContext ? { clientContext: thread.retainedContext } : {}),
            message: next.text,
            preferences: preferencesRef.current,
            sessionId: agent.session.sessionId,
        }).then((receipt) => {
            const state = mailboxTurnState(receipt.status);
            if (state === "cancelled") {
                updateQueuedTurns(queuedTurnsRef.current.filter((turn) => turn.id !== next.id));
                return;
            }
            updateQueuedTurns(queuedTurnsRef.current.map((turn) => turn.id === next.id
                ? { ...turn, mailboxItemId: receipt.itemId, state }
                : turn));
        }).catch((error) => {
            setQueueError(error instanceof Error ? error.message : messages.queueDeliveryFailed);
            updateQueuedTurns(queuedTurnsRef.current.map((turn) => turn.id === next.id ? { ...turn, state: "delivery-failed" } : turn));
        }).finally(() => {
            mailboxEnqueueIdsRef.current.delete(next.id);
        });
    }, [agent.session?.sessionId, mailbox, messages.queueDeliveryFailed, thread.queuedTurns]);
    useEffect(() => {
        if (!mailbox || isRecovering)
            return;
        const tracked = queuedTurnsRef.current.filter((turn) => turn.delivery === "server" && Boolean(turn.mailboxItemId) &&
            turn.state !== "delivery-failed");
        if (tracked.length === 0)
            return;
        let disposed = false;
        const poll = async () => {
            const updates = new Map();
            await Promise.all(tracked.map(async (turn) => {
                try {
                    const receipt = await mailbox.inspect(turn.mailboxItemId);
                    const state = mailboxTurnState(receipt.status);
                    updates.set(turn.id, state === "cancelled" ? "remove" : state);
                }
                catch {
                }
            }));
            if (disposed || updates.size === 0)
                return;
            updateQueuedTurns(queuedTurnsRef.current.flatMap((turn) => {
                const state = updates.get(turn.id);
                if (state === "remove")
                    return [];
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
        if (!mailbox || isRecovering || inputLocked || recoveryRequestedRef.current)
            return;
        const serverTurns = queuedTurnsRef.current.filter((turn) => turn.delivery === "server" && Boolean(turn.mailboxItemId));
        const committedAdmission = serverTurns.some((turn) => turn.state === "committed");
        const parkedDelivery = !admissionBusy && serverTurns.some((turn) => turn.state === "queued" || turn.state === "delivering" || turn.state === "accepted");
        if (!committedAdmission && !parkedDelivery)
            return;
        requestRecovery();
    }, [admissionBusy, inputLocked, isRecovering, mailbox, requestRecovery, thread.queuedTurns]);
    useEffect(() => {
        if (admissionBusy || runtimeIsBusy || inputLocked || !providerReady ||
            dispatchingQueuedTurnIdRef.current ||
            !agent.session?.sessionId)
            return;
        const next = queuedTurnsRef.current.find((turn) => turn.state === "queued" && turn.delivery !== "server");
        if (!next)
            return;
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
        void agent.send(next.text, retainedContextOptions(thread.retainedContext)).catch((error) => {
            dispatchingQueuedTurnIdRef.current = undefined;
            turnAdmissionBusyRef.current = false;
            pendingTurnRef.current = undefined;
            if (isAgentTurnBusyError(error)) {
                onChange({ pendingTurn: undefined, queuedTurns: queuedTurnsRef.current });
                return;
            }
            const queuedTurns = queuedTurnsRef.current.map((turn) => turn.id === next.id ? { ...turn, state: "delivery-failed" } : turn);
            queuedTurnsRef.current = queuedTurns;
            onChange({ pendingTurn: undefined, queuedTurns });
            setTurnError(error instanceof Error ? error.message : messages.queueDeliveryFailed);
        });
    }, [admissionBusy, agent, agent.session?.sessionId, inputLocked, messages.queueDeliveryFailed, onChange, providerReady, runtimeIsBusy, thread.queuedTurns]);
    const respond = (inputResponses) => {
        prepareTurn();
        return agent.respond(inputResponses, retainedContextOptions(thread.retainedContext));
    };
    const closeInputRequest = (requestId) => closeInputRequests([requestId]);
    const visibleQueuedTurns = thread.queuedTurns.filter((turn) => turn.intent !== "post-cancellation");
    return (_jsx(AssistantRuntimeProvider, { runtime: assistantRuntime, children: _jsx("main", { className: "flex min-h-0 flex-1 flex-col overflow-hidden", children: _jsx(AssistantThreadSurface, { cancellationState: cancellationState, commands: commands, composerTop: visibleQueuedTurns.length > 0 || queueError ? (_jsx(FollowUpQueue, { error: queueError, messages: messages, onRemove: removeQueuedTurn, onRetry: markQueuedTurnForRetry, turns: visibleQueuedTurns })) : undefined, draftStorageKey: draftStorageKey, events: displayEvents, eveMessages: visibleMessages, fallbackStartedAt: thread.pendingTurn?.submittedAt, inputDisabled: inputLocked, isBusy: isBusy, locale: locale, mentions: mentions, messages: messages, models: models, onInputResponses: respond, onCloseInputRequest: closeInputRequest, onOpenSubagent: onOpenSubagent, onPreferencesChange: (preferences) => onChange({ preferences }), onDraftRestoreConsumed: (id) => {
                    if (thread.draftRestore?.id === id)
                        onChange({ draftRestore: undefined });
                }, onRetryRuntimeError: recoveryError ? onRetryRecovery : undefined, closedInputRequestIds: closedInputRequestIdsRef.current, preferences: thread.preferences, reasoningLevels: reasoningLevels, draftRestore: thread.draftRestore, runtimeError: runtimeError, usage: usage }) }) }));
}
function expandPromptDirectives(value, commands, mentions) {
    const segments = unstable_defaultDirectiveFormatter.parse(value);
    if (segments.every((segment) => segment.kind === "text"))
        return value;
    const catalogs = new Map([
        ...commands.map((item) => [`command:${item.value}`, item.value]),
        ...mentions.map((item) => [`context:${item.value}`, item.value]),
    ]);
    return segments.map((segment) => {
        if (segment.kind === "text")
            return segment.text;
        return catalogs.get(`${segment.type}:${segment.id}`) ?? segment.label;
    }).join("");
}
export function FollowUpQueue({ error, messages, onRemove, onRetry, turns, }) {
    return (_jsxs("div", { className: "border-b border-border/60 px-1 pb-2 text-sm", "data-agent-steer-queue": true, children: [_jsxs("div", { className: "flex items-center gap-2 px-1 pb-1 text-xs text-muted-foreground", children: [_jsx(Clock3Icon, { className: "size-3.5" }), _jsx("span", { children: messages.queuedFollowUps }), turns.length > 0 ? _jsx("span", { children: turns.length }) : null] }), _jsx("div", { className: "space-y-0.5", children: turns.map((turn) => (_jsxs("div", { className: "flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 hover:bg-muted/55", children: [_jsx("span", { className: cn("size-1.5 shrink-0 rounded-full", turn.state === "delivery-failed" ? "bg-destructive" : "bg-amber-500") }), _jsx("span", { className: "min-w-0 flex-1 truncate text-[13px]", children: turn.text }), turn.state === "delivery-failed" ? _jsx("span", { className: "shrink-0 text-xs text-destructive", children: messages.queueDeliveryFailed }) : turn.state === "admission-ambiguous" ? _jsx("span", { className: "shrink-0 text-xs text-amber-700 dark:text-amber-300", children: messages.queueAdmissionAmbiguous }) : turn.state === "delivering" ? _jsx("span", { className: "shrink-0 text-xs text-muted-foreground", children: messages.queueDelivering }) : turn.state === "accepted" || turn.state === "committed" ? _jsx("span", { className: "shrink-0 text-xs text-muted-foreground", children: messages.queueAccepted }) : null, turn.state === "delivery-failed" ? _jsx(Button, { "aria-label": messages.retryQueuedMessage, className: "size-7", onClick: () => onRetry(turn.id), size: "icon-sm", variant: "ghost", children: _jsx(RotateCcwIcon, { className: "size-3.5" }) }) : null, mailboxTurnIsCancellable(turn) ? _jsx(Button, { "aria-label": messages.removeQueuedMessage, className: "size-7", onClick: () => onRemove(turn.id), size: "icon-sm", variant: "ghost", children: _jsx(XIcon, { className: "size-3.5" }) }) : null] }, turn.id))) }), error ? _jsx("p", { className: "px-1 pt-1 text-xs text-destructive", role: "alert", children: error }) : null] }));
}
function ensureActiveAssistantMessage(messages, events, isBusy, pendingTurn) {
    const projectedMessages = projectPendingUserMessage(messages, pendingTurn);
    if (!isBusy)
        return projectedMessages;
    const started = [...events].reverse().find((event) => event.type === "turn.started");
    const turnId = started?.type === "turn.started" ? started.data.turnId : undefined;
    if (turnId && projectedMessages.some((message) => message.role === "assistant" && message.metadata?.turnId === turnId)) {
        return projectedMessages;
    }
    if (!turnId && !pendingTurn && projectedMessages.at(-1)?.role === "assistant")
        return projectedMessages;
    const placeholderId = turnId ?? pendingTurn?.id ?? "pending-turn";
    return [
        ...projectedMessages,
        {
            id: `${placeholderId}:assistant`,
            metadata: { status: "streaming", ...(turnId ? { turnId } : {}) },
            parts: [],
            role: "assistant",
        },
    ];
}
function projectPendingUserMessage(messages, pendingTurn) {
    if (!pendingTurn)
        return messages;
    const latestMessage = messages.at(-1);
    const alreadyProjected = latestMessage?.role === "user" &&
        pendingTurnMatchesMessage(pendingTurn, latestMessage);
    if (alreadyProjected)
        return messages;
    return [
        ...messages,
        {
            id: `${pendingTurn.id}:user`,
            parts: [
                ...(pendingTurn.text ? [{ text: pendingTurn.text, type: "text" }] : []),
                ...(pendingTurn.files ?? []).map((file) => ({
                    ...(file.filename ? { filename: file.filename } : {}),
                    mediaType: file.mediaType,
                    type: "file",
                    url: file.url,
                })),
            ],
            role: "user",
        },
    ];
}
function projectStagedUserMessages(messages, turns) {
    if (turns.length === 0)
        return messages;
    const projected = [...messages];
    for (const turn of turns) {
        const id = `${turn.id}:user`;
        if (projected.some((message) => message.id === id))
            continue;
        projected.push({
            id,
            parts: [{ text: turn.text, type: "text" }],
            role: "user",
        });
    }
    return projected;
}
function pendingTurnMatchesMessage(pendingTurn, message) {
    if (eveMessageText(message) !== pendingTurn.text)
        return false;
    const messageFiles = message.parts.filter((part) => part.type === "file");
    const pendingFiles = pendingTurn.files ?? [];
    return messageFiles.length === pendingFiles.length && messageFiles.every((file, index) => {
        const pending = pendingFiles[index];
        return pending?.mediaType === file.mediaType &&
            pending.filename === file.filename &&
            pending.url === file.url;
    });
}
function isPendingTurnInFlight(pendingTurn) {
    return pendingTurn?.state === "clearing" ||
        pendingTurn?.state === "resubmitting" ||
        pendingTurn?.state === "submitting";
}
function latestActiveTurnId(events) {
    const turnId = latestStartedTurnId(events);
    if (!turnId)
        return undefined;
    const settled = events.some((event) => (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") &&
        event.data.turnId === turnId);
    return settled ? undefined : turnId;
}
function latestStartedTurnId(events) {
    const latestStarted = events.findLast((event) => event.type === "turn.started");
    return latestStarted?.type === "turn.started" ? latestStarted.data.turnId : undefined;
}
function isAgentTurnBusyError(error) {
    return error instanceof Error && /already processing a turn/i.test(error.message);
}
function messagesFromEvents(events) {
    const reducer = defaultMessageReducer();
    let data = reducer.initial();
    for (const event of events)
        data = reducer.reduce(data, event);
    return data.messages;
}
function retargetInterruptedTurn(turns, fromTurnId, toTurnId) {
    const turn = turns.find((candidate) => candidate.turnId === fromTurnId);
    return turn
        ? upsertInterruptedTurn(turns.filter((candidate) => candidate.turnId !== fromTurnId), { ...turn, turnId: toTurnId })
        : turns;
}
function upsertInterruptedTurn(turns, turn) {
    return [
        ...turns.filter((candidate) => candidate.turnId !== turn.turnId),
        turn,
    ].slice(-32);
}
function eveMessageText(message) {
    return message.parts
        .flatMap((part) => part.type === "text" ? [part.text] : [])
        .join("\n")
        .trim();
}
function createPendingTurnId() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `pending-${Date.now()}`;
}
function claimEditedTurnOperation(turnId, operation) {
    const key = `${turnId}:${operation}`;
    if (activeEditedTurnOperations.has(key))
        return undefined;
    activeEditedTurnOperations.add(key);
    return () => activeEditedTurnOperations.delete(key);
}
function withLocalInterruptedBoundary(events, turnId) {
    const hasTerminalBoundary = events.some((event) => (event.type === "turn.cancelled" || event.type === "turn.completed" || event.type === "turn.failed") &&
        event.data.turnId === turnId);
    if (hasTerminalBoundary)
        return events;
    const started = events.findLast((event) => event.type === "turn.started" && event.data.turnId === turnId);
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
function sameContextEntries(left, right) {
    if (!left || !right)
        return left === right || (left?.length ?? 0) === 0 && (right?.length ?? 0) === 0;
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
function promptFromAssistantMessage(content) {
    if (typeof content === "string")
        return { files: [], text: content };
    const text = content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const files = content.filter((part) => part.type === "file").map((part) => ({ filename: part.filename, mediaType: part.mediaType, url: typeof part.data === "string" ? part.data : String(part.data) }));
    return { files, text };
}
function retainedContextOptions(context) {
    return context && context.length > 0 ? { clientContext: context } : {};
}
async function sendPrompt(send, prompt, context) {
    if (prompt.files.length === 0) {
        await send(prompt.text, retainedContextOptions(context));
        return;
    }
    const parts = [];
    if (prompt.text)
        parts.push({ text: prompt.text, type: "text" });
    for (const file of prompt.files) {
        parts.push({
            data: file.url,
            ...(file.filename ? { filename: file.filename } : {}),
            mediaType: file.mediaType,
            type: "file",
        });
    }
    await send(parts, retainedContextOptions(context));
}
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const browserAttachmentAdapter = {
    accept: "*",
    async add({ file }) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
            throw new Error("Attachments must be 20 MB or smaller.");
        }
        return {
            contentType: file.type || "application/octet-stream",
            file,
            id: typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `attachment-${Date.now()}`,
            name: file.name,
            status: { reason: "composer-send", type: "requires-action" },
            type: file.type.startsWith("image/") ? "image" : "file",
        };
    },
    async remove() {
    },
    async send(attachment) {
        const data = await fileToDataUrl(attachment.file);
        return {
            ...attachment,
            content: [{
                    data,
                    filename: attachment.name,
                    mimeType: attachment.contentType || "application/octet-stream",
                    type: "file",
                }],
            status: { type: "complete" },
        };
    },
};
function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("Unable to read the attachment."));
        reader.readAsDataURL(file);
    });
}
function isSessionBoundary(event) {
    return event.type === "session.waiting" || event.type === "session.completed" || event.type === "session.failed";
}
const DURABLE_PROGRESS_PROBE_DELAY_MS = 15_000;
const DURABLE_PROGRESS_PROBE_INTERVAL_MS = 10_000;
const DURABLE_PROGRESS_PROBE_TIMEOUT_MS = 2_500;
const LIVE_STREAM_REATTACH_AFTER_MS = 30_000;
const MAX_QUEUED_FOLLOW_UPS = 5;
const MAILBOX_STATUS_POLL_MS = 1_500;
function mailboxTurnState(status) {
    if (status === "failed")
        return "delivery-failed";
    if (status === "submission-ambiguous")
        return "admission-ambiguous";
    if (status === "cancelled")
        return "cancelled";
    return status;
}
function mailboxTurnIsCancellable(turn) {
    if (turn.delivery !== "server")
        return true;
    return turn.state === "queued" || turn.state === "delivering" || turn.state === "delivery-failed";
}
function sameQueuedTurnSnapshots(left, right) {
    return left.length === right.length && left.every((turn, index) => {
        const candidate = right[index];
        return candidate?.id === turn.id &&
            candidate.delivery === turn.delivery &&
            candidate.intent === turn.intent &&
            candidate.mailboxItemId === turn.mailboxItemId &&
            candidate.state === turn.state &&
            candidate.submittedAt === turn.submittedAt &&
            candidate.text === turn.text;
    });
}
async function hasDurableProgressAfter(session, startIndex) {
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
    }
    catch (error) {
        if (!controller.signal.aborted && !isTransientProbeError(error)) {
            console.warn("Durable Agent progress probe failed", error);
        }
    }
    finally {
        window.clearTimeout(timeout);
    }
    return false;
}
function isTransientProbeError(error) {
    if (error instanceof Error && error.name === "AbortError")
        return true;
    if (error instanceof TypeError)
        return true;
    return error instanceof Error && /fetch|network|socket|stream/i.test(error.message);
}
function EmptyThread({ disabled, messages, onPrompt }) {
    const suggestions = [
        { icon: SearchIcon, text: messages.suggestionInspect },
        { icon: HammerIcon, text: messages.suggestionImplement },
        { icon: SparklesIcon, text: messages.suggestionResearch },
        { icon: ShieldCheckIcon, text: messages.suggestionReview },
    ];
    return (_jsxs("div", { className: "flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-4 pb-6 text-center", children: [_jsxs("div", { className: "space-y-3", children: [_jsx("div", { className: "mx-auto flex size-10 items-center justify-center rounded-xl border bg-card text-foreground shadow-sm", children: _jsx(SparklesIcon, { className: "size-5" }) }), _jsx("h1", { className: "text-3xl font-medium text-foreground", children: messages.emptyTitle })] }), _jsx("div", { className: "grid w-full max-w-3xl grid-cols-1 gap-2 min-[520px]:grid-cols-2 lg:grid-cols-4", children: suggestions.map(({ icon: Icon, text }, index) => (_jsxs(Button, { className: cn("h-24 flex-col items-start justify-between whitespace-normal px-4 py-3 text-left text-sm lg:h-36", index > 1 && "hidden lg:flex"), disabled: disabled, onClick: () => onPrompt(text), variant: "outline", children: [_jsx(Icon, { className: "size-4 text-muted-foreground" }), _jsx("span", { children: text })] }, text))) })] }));
}
function latestTurnOutcome(events) {
    const event = [...events].reverse().find((candidate) => candidate.type === "turn.cancelled" || candidate.type === "turn.completed" || candidate.type === "turn.failed");
    if (event?.type === "turn.cancelled")
        return "cancelled";
    if (event?.type === "turn.completed")
        return "completed";
    if (event?.type === "turn.failed")
        return "failed";
    return undefined;
}
function latestTurnFailure(events) {
    if (latestTurnOutcome(events) !== "failed")
        return undefined;
    const event = [...events].reverse().find((candidate) => candidate.type === "turn.failed" || candidate.type === "step.failed");
    return event?.type === "turn.failed" || event?.type === "step.failed" ? event.data.message : undefined;
}
function latestTurnFailureForId(events, turnId) {
    const event = [...events].reverse().find((candidate) => (candidate.type === "turn.failed" || candidate.type === "step.failed") && candidate.data.turnId === turnId);
    return event?.type === "turn.failed" || event?.type === "step.failed" ? event.data.message : undefined;
}
//# sourceMappingURL=agent-thread.js.map