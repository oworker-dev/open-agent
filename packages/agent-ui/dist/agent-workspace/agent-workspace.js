"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { ClientError } from "eve/client";
import { AlertCircleIcon, ArrowLeftIcon, MenuIcon, PanelLeftCloseIcon, PanelLeftIcon, ServerOffIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button.js";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui/resizable.js";
import { usePanelRef, } from "react-resizable-panels";
import { attachAgentSession, createAgentSession } from "./agent-client.js";
import { AgentChildSessionView } from "./agent-child-session.js";
import { AgentSettingsDialog } from "./agent-settings-dialog.js";
import { AgentSidebar } from "./agent-sidebar.js";
import { AgentSubagentMenu } from "./agent-subagent-menu.js";
import { AgentThreadView } from "./agent-thread.js";
import { AgentThreadStorageConflictError } from "./http-thread-storage.js";
import { messagesFor, resolveBrowserLocale } from "./i18n.js";
import { AGENT_THREAD_STORAGE_VERSION, browserThreadStorage, appendThreadEvent, compactThreadEvents, createAgentThread, } from "./thread-storage.js";
import { hasUnresolvedInputRequests, presentSubagentSessions, } from "./turn-presentation.js";
const DEFAULT_STORAGE_KEY = "open-agent:threads:v1";
const STORAGE_URGENT_SAVE_DELAY_MS = 50;
const STORAGE_STREAM_CHECKPOINT_MS = 15_000;
const WORKBENCH_TRANSITION_MS = 300;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 252;
const SIDEBAR_COLLAPSED_THRESHOLD = 1;
const FLOATING_SIDEBAR_DEFAULT_WIDTH = 288;
export function AgentWorkspace({ client, commands = [], defaultPreferences, extensions = [], hostSlots, initialSubagentSessionId, initialThreadId, mailbox, models, mentions = [], onEvent, onDeleteThread, onActiveSubagentChange, onActiveThreadChange, onStorageError, productName = "Agent", reasoningLevels, runtimeStatus = { provider: "ready" }, storageKey = DEFAULT_STORAGE_KEY, threadStorage = browserThreadStorage, }) {
    validateWorkspaceCatalog(models, reasoningLevels, defaultPreferences);
    const catalogSignature = JSON.stringify({ models, reasoningLevels });
    const stableDefaults = useMemo(() => ({
        modelId: defaultPreferences.modelId,
        reasoning: defaultPreferences.reasoning,
        executionMode: defaultPreferences.executionMode ?? "standard",
    }), [defaultPreferences.executionMode, defaultPreferences.modelId, defaultPreferences.reasoning]);
    const [threads, setThreads] = useState([]);
    const threadsRef = useRef([]);
    const [activeThreadId, setActiveThreadId] = useState();
    const [activeSubagentSessionId, setActiveSubagentSessionId] = useState();
    const [isHydrated, setIsHydrated] = useState(false);
    const [recoveringIds, setRecoveringIds] = useState(new Set());
    const [recoveryErrors, setRecoveryErrors] = useState(new Map());
    const [hydratingThreadIds, setHydratingThreadIds] = useState(new Set());
    const [threadHydrationErrors, setThreadHydrationErrors] = useState(new Map());
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [workbenchMode, setWorkbenchMode] = useState("split");
    const [panelResizing, setPanelResizing] = useState(false);
    const [desktopLayout, setDesktopLayout] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [deletionIssue, setDeletionIssue] = useState(false);
    const [deletingThreadIds, setDeletingThreadIds] = useState(new Set());
    const [ephemeralThreadIds, setEphemeralThreadIds] = useState(new Set());
    const [locale, setLocale] = useState("en");
    const recoveryStarted = useRef(new Set());
    const recoveryControllers = useRef(new Map());
    const storageSaveQueue = useRef(Promise.resolve());
    const storageSaveTimer = useRef(undefined);
    const storageSaveDueAt = useRef(undefined);
    const workbenchTransitionTimer = useRef(undefined);
    const workbenchTransition = useRef(undefined);
    const lastSidebarWidth = useRef(SIDEBAR_DEFAULT_WIDTH);
    const pendingCollection = useRef(undefined);
    const messages = messagesFor(locale);
    const sidebarPanelRef = usePanelRef();
    useEffect(() => {
        const media = window.matchMedia("(min-width: 1024px)");
        const synchronizeLayout = () => {
            const nextDesktopLayout = media.matches;
            window.clearTimeout(workbenchTransitionTimer.current);
            workbenchTransitionTimer.current = undefined;
            workbenchTransition.current = undefined;
            setDesktopLayout(nextDesktopLayout);
            setSidebarOpen(nextDesktopLayout);
            setWorkbenchMode("split");
            setPanelResizing(false);
        };
        synchronizeLayout();
        media.addEventListener("change", synchronizeLayout);
        return () => media.removeEventListener("change", synchronizeLayout);
    }, []);
    useEffect(() => () => window.clearTimeout(workbenchTransitionTimer.current), []);
    useEffect(() => {
        if (!panelResizing)
            return;
        const finishResize = () => setPanelResizing(false);
        window.addEventListener("pointerup", finishResize, { once: true });
        window.addEventListener("pointercancel", finishResize, { once: true });
        window.addEventListener("blur", finishResize, { once: true });
        return () => {
            window.removeEventListener("pointerup", finishResize);
            window.removeEventListener("pointercancel", finishResize);
            window.removeEventListener("blur", finishResize);
        };
    }, [panelResizing]);
    useEffect(() => {
        threadsRef.current = threads;
    }, [threads]);
    useEffect(() => {
        let cancelled = false;
        const restoredLocale = loadLocale(storageKey);
        void Promise.resolve(threadStorage.load(storageKey))
            .then((collection) => {
            if (cancelled)
                return;
            const storedThreads = collection.threads.map((thread) => normalizeThreadPreferences(thread, models, reasoningLevels, stableDefaults));
            const requestedActive = initialThreadId &&
                storedThreads.some((thread) => thread.id === initialThreadId)
                ? initialThreadId
                : undefined;
            const cleanThread = createAgentThread(Date.now(), messagesFor(restoredLocale).newTask, stableDefaults);
            const routeThread = initialThreadId && !requestedActive
                ? { ...cleanThread, id: initialThreadId }
                : undefined;
            const rootThread = initialThreadId ? undefined : cleanThread;
            const restoredThreads = routeThread
                ? [routeThread, ...storedThreads]
                : rootThread
                    ? [rootThread, ...storedThreads]
                    : storedThreads;
            const restoredActive = requestedActive ?? routeThread?.id ?? rootThread?.id ?? restoredThreads[0]?.id;
            setThreads(restoredThreads);
            setActiveThreadId(restoredActive);
            setEphemeralThreadIds(rootThread ? new Set([rootThread.id]) : new Set());
            setActiveSubagentSessionId(requestedActive ? initialSubagentSessionId : undefined);
            setLocale(restoredLocale);
            setSidebarOpen(window.matchMedia("(min-width: 1024px)").matches);
            setIsHydrated(true);
            pendingCollection.current = {
                ...(requestedActive ? { activeThreadId: requestedActive } : {}),
                threads: storedThreads,
                version: AGENT_THREAD_STORAGE_VERSION,
            };
            const busyThreads = restoredThreads.filter(threadNeedsRecovery);
            if (busyThreads.length > 0) {
                setRecoveringIds(new Set(busyThreads.map((thread) => thread.id)));
            }
        })
            .catch((error) => {
            if (cancelled)
                return;
            onStorageError?.(error);
            const fallback = createAgentThread(Date.now(), messagesFor(restoredLocale).newTask, stableDefaults);
            setThreads([fallback]);
            setActiveThreadId(fallback.id);
            setEphemeralThreadIds(new Set([fallback.id]));
            setActiveSubagentSessionId(undefined);
            setLocale(restoredLocale);
            setSidebarOpen(window.matchMedia("(min-width: 1024px)").matches);
            setIsHydrated(true);
        });
        return () => {
            cancelled = true;
        };
    }, [catalogSignature, initialSubagentSessionId, initialThreadId, onStorageError, stableDefaults, storageKey, threadStorage]);
    useEffect(() => {
        if (!isHydrated || !activeThreadId)
            return;
        if (ephemeralThreadIds.has(activeThreadId)) {
            onActiveThreadChange?.(undefined);
            return;
        }
        if (activeSubagentSessionId) {
            onActiveSubagentChange?.(activeThreadId, activeSubagentSessionId);
            return;
        }
        onActiveThreadChange?.(activeThreadId);
    }, [activeSubagentSessionId, activeThreadId, ephemeralThreadIds, isHydrated, onActiveSubagentChange, onActiveThreadChange]);
    useEffect(() => {
        if (!isHydrated)
            return;
        window.localStorage.setItem(`${storageKey}:locale`, locale);
        document.documentElement.lang = locale;
    }, [isHydrated, locale, storageKey]);
    useEffect(() => {
        if (!isHydrated)
            return;
        const persistedThreads = threads.filter((thread) => !ephemeralThreadIds.has(thread.id));
        const collection = {
            activeThreadId: activeThreadId && !ephemeralThreadIds.has(activeThreadId)
                ? activeThreadId
                : undefined,
            threads: persistedThreads,
            version: AGENT_THREAD_STORAGE_VERSION,
        };
        const previousCollection = pendingCollection.current;
        if (previousCollection && sameThreadCollection(previousCollection, collection))
            return;
        pendingCollection.current = collection;
        const saveDelay = isUrgentPersistenceChange(previousCollection, collection)
            ? STORAGE_URGENT_SAVE_DELAY_MS
            : STORAGE_STREAM_CHECKPOINT_MS;
        const dueAt = Date.now() + saveDelay;
        if (storageSaveTimer.current !== undefined &&
            storageSaveDueAt.current !== undefined &&
            storageSaveDueAt.current <= dueAt)
            return;
        window.clearTimeout(storageSaveTimer.current);
        storageSaveDueAt.current = dueAt;
        storageSaveTimer.current = window.setTimeout(() => {
            storageSaveTimer.current = undefined;
            storageSaveDueAt.current = undefined;
            const nextCollection = pendingCollection.current;
            if (!nextCollection)
                return;
            storageSaveQueue.current = storageSaveQueue.current
                .catch(() => undefined)
                .then(async () => {
                const saved = await saveThreadCollectionWithConflictRecovery(storageKey, nextCollection, threadStorage);
                if (!sameThreadCollection(saved, nextCollection)) {
                    setThreads((current) => mergeVisibleThreads(current, saved.threads, ephemeralThreadIds));
                }
            })
                .catch((error) => {
                onStorageError?.(error);
            });
        }, saveDelay);
    }, [activeThreadId, ephemeralThreadIds, isHydrated, onStorageError, storageKey, threadStorage, threads]);
    const updateThread = useCallback((threadId, patch) => {
        if (patch.pendingTurn || patch.events?.length || patch.session?.sessionId) {
            setEphemeralThreadIds((current) => withoutSetValue(current, threadId));
        }
        setThreads((current) => {
            const next = current.map((thread) => thread.id === threadId
                ? {
                    ...thread,
                    ...patch,
                    updatedAt: patch.updatedAt ?? Math.max(Date.now(), thread.updatedAt + 1),
                }
                : thread);
            threadsRef.current = next;
            return next;
        });
    }, []);
    const createThread = useCallback(() => {
        const active = activeThreadId ? threadsRef.current.find((thread) => thread.id === activeThreadId) : undefined;
        if (active && ephemeralThreadIds.has(active.id) && isEmptyDraftThread(active)) {
            setActiveSubagentSessionId(undefined);
            if (!window.matchMedia("(min-width: 1024px)").matches)
                setSidebarOpen(false);
            return;
        }
        const thread = createAgentThread(Date.now(), messages.newTask, stableDefaults);
        setThreads((current) => [thread, ...current]);
        setActiveThreadId(thread.id);
        setEphemeralThreadIds((current) => new Set(current).add(thread.id));
        setActiveSubagentSessionId(undefined);
        if (!window.matchMedia("(min-width: 1024px)").matches)
            setSidebarOpen(false);
    }, [activeThreadId, ephemeralThreadIds, messages.newTask, stableDefaults]);
    const deleteThread = useCallback(async (threadId) => {
        const thread = threads.find((item) => item.id === threadId);
        if (!thread || deletingThreadIds.has(threadId))
            return;
        if (thread && onDeleteThread) {
            setDeletingThreadIds((current) => new Set(current).add(threadId));
            try {
                await onDeleteThread(thread);
                setDeletionIssue(false);
            }
            catch (error) {
                setDeletionIssue(true);
                onStorageError?.(error);
                setDeletingThreadIds((current) => withoutSetValue(current, threadId));
                return;
            }
            setDeletingThreadIds((current) => withoutSetValue(current, threadId));
        }
        recoveryControllers.current.get(threadId)?.abort();
        recoveryControllers.current.delete(threadId);
        recoveryStarted.current.delete(threadId);
        setEphemeralThreadIds((current) => withoutSetValue(current, threadId));
        setRecoveringIds((current) => withoutSetValue(current, threadId));
        setRecoveryErrors((current) => withoutMapKey(current, threadId));
        setThreads((current) => {
            const next = current.filter((thread) => thread.id !== threadId);
            if (next.length === 0) {
                const replacement = createAgentThread(Date.now(), messages.newTask, stableDefaults);
                setActiveThreadId(replacement.id);
                setEphemeralThreadIds((current) => new Set(current).add(replacement.id));
                setActiveSubagentSessionId(undefined);
                return [replacement];
            }
            if (threadId === activeThreadId) {
                setActiveThreadId(next[0]?.id);
                setActiveSubagentSessionId(undefined);
            }
            return next;
        });
    }, [activeThreadId, deletingThreadIds, messages.newTask, onDeleteThread, onStorageError, stableDefaults, threads]);
    const selectThread = useCallback((threadId) => {
        setActiveThreadId(threadId);
        setActiveSubagentSessionId(undefined);
        if (!window.matchMedia("(min-width: 1024px)").matches)
            setSidebarOpen(false);
        const selected = threads.find((thread) => thread.id === threadId);
        if (selected && threadNeedsRecovery(selected)) {
            setRecoveringIds((current) => new Set(current).add(threadId));
        }
    }, [threads]);
    const finishWorkbenchTransition = useCallback((transition, nextMode) => {
        window.clearTimeout(workbenchTransitionTimer.current);
        workbenchTransitionTimer.current = window.setTimeout(() => {
            if (workbenchTransition.current !== transition)
                return;
            workbenchTransition.current = undefined;
            workbenchTransitionTimer.current = undefined;
            setWorkbenchMode(nextMode);
        }, WORKBENCH_TRANSITION_MS + 40);
    }, []);
    const toggleDesktopSidebar = useCallback(() => {
        const panel = sidebarPanelRef.current;
        if (!desktopLayout || !panel)
            return;
        if (workbenchMode === "split") {
            const currentWidth = panel.getSize().inPixels;
            if (currentWidth >= SIDEBAR_MIN_WIDTH)
                lastSidebarWidth.current = currentWidth;
            workbenchTransition.current = "collapsing";
            setWorkbenchMode("collapsing");
            setSidebarOpen(false);
            panel.collapse();
            finishWorkbenchTransition("collapsing", "fullscreen");
            return;
        }
        if (workbenchMode === "fullscreen") {
            workbenchTransition.current = "expanding";
            setWorkbenchMode("expanding");
            setSidebarOpen(true);
            panel.resize(`${clamp(lastSidebarWidth.current, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)}px`);
            finishWorkbenchTransition("expanding", "split");
        }
    }, [desktopLayout, finishWorkbenchTransition, sidebarPanelRef, workbenchMode]);
    const handleSidebarResize = useCallback((size) => {
        if (size.inPixels >= SIDEBAR_MIN_WIDTH) {
            lastSidebarWidth.current = clamp(size.inPixels, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
        }
    }, []);
    const handleDesktopLayoutChanged = useCallback((layout, meta) => {
        if (!desktopLayout || !meta.isUserInteraction)
            return;
        window.clearTimeout(workbenchTransitionTimer.current);
        workbenchTransitionTimer.current = undefined;
        workbenchTransition.current = undefined;
        setPanelResizing(false);
        const sidebarWidth = sidebarPanelRef.current?.getSize().inPixels ?? 0;
        const sidebarPercentage = layout["agent-sidebar"] ?? 0;
        if (sidebarWidth <= SIDEBAR_COLLAPSED_THRESHOLD || sidebarPercentage <= 0.05) {
            setSidebarOpen(false);
            setWorkbenchMode("fullscreen");
            return;
        }
        lastSidebarWidth.current = clamp(sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
        setSidebarOpen(true);
        setWorkbenchMode("split");
    }, [desktopLayout, sidebarPanelRef]);
    const renameThread = useCallback((threadId, title) => {
        const normalized = title.trim();
        if (!normalized)
            return;
        updateThread(threadId, { title: normalized });
    }, [updateThread]);
    const requestThreadRecovery = useCallback((threadId) => {
        setRecoveryErrors((current) => withoutMapKey(current, threadId));
        setRecoveringIds((current) => new Set(current).add(threadId));
    }, []);
    const cancelThreadRecovery = useCallback((threadId) => {
        recoveryControllers.current.get(threadId)?.abort();
        setRecoveringIds((current) => withoutSetValue(current, threadId));
    }, []);
    const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? threads[0];
    const hydrateThread = useCallback((thread) => {
        if (thread.hydration !== "summary" || !threadStorage.loadThread)
            return;
        setThreadHydrationErrors((current) => withoutMapKey(current, thread.id));
        setHydratingThreadIds((current) => new Set(current).add(thread.id));
        void Promise.resolve(threadStorage.loadThread(storageKey, thread.id))
            .then((hydrated) => {
            if (!hydrated)
                throw new Error("The selected Agent session no longer exists.");
            setThreads((current) => {
                const next = current.map((candidate) => candidate.id === thread.id ? hydrated : candidate);
                threadsRef.current = next;
                return next;
            });
            if (threadNeedsRecovery(hydrated)) {
                setRecoveringIds((current) => new Set(current).add(thread.id));
            }
        })
            .catch((error) => {
            onStorageError?.(error);
            setThreadHydrationErrors((current) => new Map(current).set(thread.id, error instanceof Error ? error.message : messages.recoveryFailed));
        })
            .finally(() => setHydratingThreadIds((current) => withoutSetValue(current, thread.id)));
    }, [messages.recoveryFailed, onStorageError, storageKey, threadStorage]);
    useEffect(() => {
        if (!activeThread ||
            activeThread.hydration !== "summary" ||
            hydratingThreadIds.has(activeThread.id) ||
            threadHydrationErrors.has(activeThread.id))
            return;
        hydrateThread(activeThread);
    }, [activeThread, hydrateThread, hydratingThreadIds, threadHydrationErrors]);
    const activeSubagent = activeThread && activeSubagentSessionId
        ? findSubagentSession(activeThread.events, activeSubagentSessionId, locale)
        : undefined;
    const openSubagent = useCallback((sessionId) => {
        if (!activeThread || !findSubagentSession(activeThread.events, sessionId, locale))
            return;
        setActiveSubagentSessionId(sessionId);
    }, [activeThread, locale]);
    const closeSubagent = useCallback(() => setActiveSubagentSessionId(undefined), []);
    const changeActiveThread = useCallback((patch) => {
        if (activeThreadId)
            updateThread(activeThreadId, patch);
    }, [activeThreadId, updateThread]);
    const recoverActiveThread = useCallback(() => {
        if (activeThreadId)
            requestThreadRecovery(activeThreadId);
    }, [activeThreadId, requestThreadRecovery]);
    const recoverThread = useCallback(async (thread) => {
        if (!thread.session.sessionId || recoveryStarted.current.has(thread.id))
            return;
        recoveryStarted.current.add(thread.id);
        setRecoveryErrors((current) => withoutMapKey(current, thread.id));
        const controller = new AbortController();
        recoveryControllers.current.set(thread.id, controller);
        const recoveredCursor = thread.session.streamIndex;
        const connection = createAgentSession(client, thread.preferences, { ...thread.session, streamIndex: recoveredCursor });
        const session = attachAgentSession(connection, connection.initialSession);
        if (!session) {
            recoveryStarted.current.delete(thread.id);
            recoveryControllers.current.delete(thread.id);
            setRecoveringIds((current) => withoutSetValue(current, thread.id));
            return;
        }
        let cursor = recoveredCursor;
        let events = [...thread.events];
        let checkedTailBoundary = false;
        let needsBoundedCatchUp = true;
        let reconnectAttempt = 0;
        let pendingTurn = thread.pendingTurn;
        let queuedTurns = thread.queuedTurns;
        const committedCatchUpTurns = new Map(queuedTurns
            .filter((turn) => turn.delivery === "server" && turn.state === "committed" &&
            !mailboxMessageWasObserved(events, turn))
            .map((turn) => [turn.id, turn]));
        const recoveryOwnedQueuedTurnIds = new Set(queuedTurns.map((turn) => turn.id));
        const consumedQueuedTurnIds = new Set();
        const recoveryOwnedPendingTurnId = pendingTurn?.id;
        const consumedPendingTurnIds = new Set();
        let settled = false;
        const currentClosedInputRequestIds = () => new Set(threadsRef.current.find((candidate) => candidate.id === thread.id)?.closedInputRequestIds ?? thread.closedInputRequestIds);
        const mergeLiveAdmissions = () => {
            const liveThread = threadsRef.current.find((candidate) => candidate.id === thread.id);
            if (!liveThread)
                return;
            const liveQueuedTurnIds = new Set(liveThread.queuedTurns.map((turn) => turn.id));
            queuedTurns = queuedTurns.filter((turn) => !consumedQueuedTurnIds.has(turn.id) &&
                (recoveryOwnedQueuedTurnIds.has(turn.id) || liveQueuedTurnIds.has(turn.id)));
            const localQueuedTurnIds = new Set(queuedTurns.map((turn) => turn.id));
            for (const turn of liveThread.queuedTurns) {
                if (!localQueuedTurnIds.has(turn.id) &&
                    !consumedQueuedTurnIds.has(turn.id)) {
                    queuedTurns = [...queuedTurns, turn];
                    localQueuedTurnIds.add(turn.id);
                }
            }
            const livePendingTurn = liveThread.pendingTurn;
            if (livePendingTurn &&
                livePendingTurn.id !== recoveryOwnedPendingTurnId &&
                !consumedPendingTurnIds.has(livePendingTurn.id)) {
                pendingTurn = livePendingTurn;
            }
            else if (pendingTurn &&
                pendingTurn.id !== recoveryOwnedPendingTurnId &&
                (!livePendingTurn || consumedPendingTurnIds.has(pendingTurn.id))) {
                pendingTurn = undefined;
            }
        };
        const refreshMailboxQueue = async () => {
            mergeLiveAdmissions();
            if (!mailbox)
                return;
            const updates = new Map();
            await Promise.all(queuedTurns.map(async (turn) => {
                if (turn.delivery !== "server" || !turn.mailboxItemId)
                    return;
                try {
                    const receipt = await mailbox.inspect(turn.mailboxItemId);
                    const state = mailboxQueueState(receipt.status);
                    if (state === "committed") {
                        if (!mailboxMessageWasObserved(events, turn))
                            committedCatchUpTurns.set(turn.id, turn);
                        updates.set(turn.id, "remove");
                    }
                    else {
                        updates.set(turn.id, state === "cancelled" ? "remove" : state);
                    }
                }
                catch {
                }
            }));
            if (updates.size === 0)
                return;
            const next = queuedTurns.flatMap((turn) => {
                const state = updates.get(turn.id);
                if (state === "remove")
                    return [];
                return state ? [{ ...turn, state }] : [turn];
            });
            if (sameQueuedTurns(queuedTurns, next))
                return;
            queuedTurns = next;
            updateThread(thread.id, { queuedTurns });
        };
        const hasPendingServerQueue = () => queuedTurns.some((turn) => turn.delivery === "server" && mailboxTurnAwaitsAdmission(turn) && Boolean(turn.mailboxItemId));
        const currentBoundarySettles = () => {
            const last = events.at(-1);
            if (!last || !isRecoveryBoundary(last))
                return false;
            return committedCatchUpTurns.size === 0 &&
                (last.type !== "session.waiting" || !hasPendingServerQueue());
        };
        try {
            while (!settled && !controller.signal.aborted) {
                try {
                    await refreshMailboxQueue();
                    if (currentBoundarySettles()) {
                        settled = true;
                        break;
                    }
                    let consumed = 0;
                    const follow = !needsBoundedCatchUp;
                    needsBoundedCatchUp = false;
                    for await (const event of session.stream({
                        follow,
                        signal: controller.signal,
                        startIndex: cursor,
                        ...(follow ? { streamReconnectPolicy: RECOVERY_STREAM_RECONNECT_POLICY } : {}),
                    })) {
                        mergeLiveAdmissions();
                        events = [...appendThreadEvent(events, event)];
                        cursor += 1;
                        consumed += 1;
                        onEvent?.(event);
                        if (event.type === "message.received") {
                            const clientMessageId = event.data.clientMessageId;
                            if (clientMessageId) {
                                committedCatchUpTurns.delete(clientMessageId);
                                consumedQueuedTurnIds.add(clientMessageId);
                                queuedTurns = queuedTurns.filter((turn) => turn.id !== clientMessageId);
                                if (pendingTurn?.id === clientMessageId) {
                                    consumedPendingTurnIds.add(clientMessageId);
                                    pendingTurn = undefined;
                                }
                            }
                            else {
                                const committedTurn = [...committedCatchUpTurns.values()].find((turn) => turn.text.trim() === event.data.message.trim());
                                if (committedTurn) {
                                    committedCatchUpTurns.delete(committedTurn.id);
                                }
                                else if (pendingTurn) {
                                    consumedPendingTurnIds.add(pendingTurn.id);
                                    pendingTurn = undefined;
                                }
                                else {
                                    const nextBrowserTurn = queuedTurns.find((turn) => turn.delivery !== "server" && turn.text.trim() === event.data.message.trim());
                                    if (nextBrowserTurn) {
                                        consumedQueuedTurnIds.add(nextBrowserTurn.id);
                                        queuedTurns = queuedTurns.filter((turn) => turn.id !== nextBrowserTurn.id);
                                    }
                                }
                            }
                        }
                        updateThread(thread.id, {
                            events: [...events],
                            pendingTurn,
                            queuedTurns,
                            session: { ...session.state, streamIndex: cursor },
                            status: statusFromEvents(events, currentClosedInputRequestIds()),
                        });
                        if (isRecoveryBoundary(event)) {
                            await refreshMailboxQueue();
                            settled = currentBoundarySettles();
                            break;
                        }
                    }
                    await refreshMailboxQueue();
                    if (consumed === 0 &&
                        !checkedTailBoundary &&
                        events.length > 0 &&
                        !isRecoveryBoundary(events.at(-1))) {
                        checkedTailBoundary = true;
                        const missingBoundary = await readTailBoundary(session, controller.signal);
                        if (missingBoundary) {
                            events = [...appendThreadEvent(events, missingBoundary)];
                            await refreshMailboxQueue();
                            updateThread(thread.id, {
                                events: [...events],
                                pendingTurn,
                                queuedTurns,
                                session: { ...session.state, streamIndex: cursor },
                                status: statusFromEvents(events, currentClosedInputRequestIds()),
                            });
                            settled = currentBoundarySettles();
                        }
                    }
                    if (!settled && currentBoundarySettles())
                        settled = true;
                    reconnectAttempt = consumed > 0 ? 0 : reconnectAttempt + 1;
                    setRecoveryErrors((current) => withoutMapKey(current, thread.id));
                }
                catch (error) {
                    if (controller.signal.aborted || isAbortError(error))
                        return;
                    if (!isRetryableRecoveryError(error))
                        throw error;
                    reconnectAttempt += 1;
                }
                if (reconnectAttempt > MAX_RECOVERY_RECONNECT_ATTEMPTS) {
                    throw new Error("The active Agent stream could not be reconnected after repeated transport failures.");
                }
                if (!settled && !controller.signal.aborted) {
                    await waitForRecoveryRetry(controller.signal, reconnectAttempt);
                }
            }
            if (controller.signal.aborted)
                return;
            if (!settled)
                throw new Error("The active Agent stream ended before reaching a durable boundary.");
            mergeLiveAdmissions();
            updateThread(thread.id, {
                events: compactThreadEvents(events),
                pendingTurn,
                queuedTurns,
                session: { ...session.state, streamIndex: cursor },
                status: statusFromEvents(events, currentClosedInputRequestIds()),
            });
        }
        catch (error) {
            if (controller.signal.aborted || isAbortError(error))
                return;
            updateThread(thread.id, { status: "error", updatedAt: Date.now() });
            setRecoveryErrors((current) => new Map(current).set(thread.id, error instanceof Error ? error.message : messages.recoveryFailed));
            console.error("Agent session recovery failed", error);
        }
        finally {
            recoveryStarted.current.delete(thread.id);
            recoveryControllers.current.delete(thread.id);
            setRecoveringIds((current) => {
                const next = new Set(current);
                next.delete(thread.id);
                return next;
            });
        }
    }, [client, mailbox, messages.recoveryFailed, onEvent, updateThread]);
    useEffect(() => () => {
        for (const controller of recoveryControllers.current.values())
            controller.abort();
        recoveryControllers.current.clear();
        window.clearTimeout(storageSaveTimer.current);
    }, []);
    useEffect(() => {
        if (!isHydrated)
            return;
        for (const thread of threads) {
            if (recoveringIds.has(thread.id))
                void recoverThread(thread);
        }
    }, [isHydrated, recoverThread, recoveringIds, threads]);
    const activeIsRecovering = activeThread ? recoveringIds.has(activeThread.id) : false;
    const activeIsHydrating = activeThread?.hydration === "summary";
    if (!isHydrated || !activeThread)
        return _jsx("div", { className: "flex h-dvh items-center justify-center bg-background text-muted-foreground", children: messages.loading });
    const workbenchFullscreen = desktopLayout && workbenchMode === "fullscreen";
    const workbenchTransitioning = workbenchMode === "collapsing" || workbenchMode === "expanding";
    return (_jsxs("div", { className: "open-agent-ui relative h-dvh overflow-hidden bg-sidebar text-foreground", "data-panel-resizing": panelResizing ? "true" : "false", "data-workbench-fullscreen": workbenchFullscreen ? "true" : "false", "data-workbench-mode": desktopLayout ? workbenchMode : "mobile", children: [!desktopLayout ? _jsx(AgentSidebar, { activeThreadId: activeThread.id, brand: productName, deletingThreadIds: deletingThreadIds, hostFooter: hostSlots?.sidebarFooter, locale: locale, messages: messages, onClose: () => setSidebarOpen(false), onDelete: deleteThread, onNew: createThread, onRename: renameThread, onSelect: selectThread, onSettings: () => setSettingsOpen(true), open: sidebarOpen, threads: threads, variant: "mobile" }) : null, _jsxs(ResizablePanelGroup, { className: "h-full", onLayoutChanged: handleDesktopLayoutChanged, orientation: "horizontal", children: [desktopLayout ? (_jsx(ResizablePanel, { className: "block", collapsedSize: "0px", collapsible: true, "data-sidebar-panel": true, defaultSize: `${SIDEBAR_DEFAULT_WIDTH}px`, id: "agent-sidebar", maxSize: `${SIDEBAR_MAX_WIDTH}px`, minSize: `${SIDEBAR_MIN_WIDTH}px`, onResize: handleSidebarResize, panelRef: sidebarPanelRef, children: _jsx(AgentSidebar, { activeThreadId: activeThread.id, brand: productName, deletingThreadIds: deletingThreadIds, hostFooter: hostSlots?.sidebarFooter, locale: locale, messages: messages, onClose: () => setSidebarOpen(false), onDelete: deleteThread, onNew: createThread, onRename: renameThread, onSelect: selectThread, onSettings: () => setSettingsOpen(true), open: sidebarOpen, threads: threads, variant: "desktop" }) })) : null, desktopLayout ? _jsx(ResizableHandle, { className: "flex bg-transparent after:w-2", "data-main-resize-handle": true, disabled: workbenchMode !== "split", onPointerDown: () => {
                            if (workbenchMode === "split")
                                setPanelResizing(true);
                        } }) : null, _jsx(ResizablePanel, { className: "min-w-0 p-0", "data-workbench-panel": true, defaultSize: "100%", id: "agent-workbench", minSize: "0px", children: _jsxs("section", { className: "flex h-full min-w-0 flex-col overflow-hidden bg-card", "data-slot": "agent-workbench", children: [_jsxs("header", { className: "flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-3 lg:h-13 lg:px-4", children: [_jsxs("div", { className: "flex min-w-0 items-center gap-2", children: [_jsx(Button, { "aria-label": messages.openNavigation, className: "lg:hidden", onClick: () => setSidebarOpen(true), size: "icon-sm", variant: "ghost", children: _jsx(MenuIcon, { className: "size-4" }) }), _jsx(Button, { "aria-label": messages.toggleNavigation, className: "hidden lg:inline-flex", disabled: workbenchTransitioning, onClick: toggleDesktopSidebar, size: "icon-sm", variant: "ghost", children: workbenchMode === "split" ? _jsx(PanelLeftCloseIcon, { className: "size-4" }) : _jsx(PanelLeftIcon, { className: "size-4" }) }), activeSubagentSessionId ? (_jsx(Button, { "aria-label": messages.backToTask, onClick: closeSubagent, size: "icon-sm", variant: "ghost", children: _jsx(ArrowLeftIcon, { className: "size-4" }) })) : null, _jsx("h2", { className: "truncate font-medium text-[15px]", children: activeSubagentSessionId ? activeSubagent?.label ?? messages.subagentSession : activeThread.title })] }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsx(AgentSubagentMenu, { activeSessionId: activeSubagentSessionId, events: activeThread.events, locale: locale, onOpen: openSubagent }), hostSlots?.threadHeaderEnd] })] }), deletionIssue ? (_jsxs("div", { className: "flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm", role: "alert", children: [_jsx(AlertCircleIcon, { className: "size-4 shrink-0 text-destructive" }), _jsx("p", { className: "min-w-0 flex-1 text-foreground", children: messages.deleteUnavailable }), _jsx(Button, { onClick: () => setDeletionIssue(false), size: "sm", variant: "outline", children: messages.dismiss })] })) : null, runtimeStatus.provider !== "ready" ? (_jsxs("div", { className: "flex shrink-0 items-start gap-3 border-b border-amber-500/30 bg-amber-500/8 px-4 py-2.5 text-sm", role: "status", children: [_jsx(ServerOffIcon, { className: "mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" }), _jsx("p", { className: "min-w-0 flex-1 text-foreground", children: runtimeStatus.provider === "mock" ? messages.mockProvider : messages.providerUnconfigured })] })) : null, activeIsHydrating ? (_jsx("main", { className: "flex min-h-0 flex-1 items-center justify-center bg-background px-6", children: threadHydrationErrors.has(activeThread.id) ? (_jsxs("div", { className: "max-w-md text-center", role: "alert", children: [_jsx(AlertCircleIcon, { className: "mx-auto size-5 text-destructive" }), _jsx("p", { className: "mt-3 text-sm text-muted-foreground", children: threadHydrationErrors.get(activeThread.id) ?? messages.recoveryFailed }), _jsx(Button, { className: "mt-4", onClick: () => hydrateThread(activeThread), size: "sm", variant: "outline", children: messages.retry })] })) : (_jsx("p", { className: "text-sm text-muted-foreground", role: "status", children: messages.loading })) })) : activeSubagentSessionId ? (activeSubagent ? (_jsx(AgentChildSessionView, { client: client, locale: locale, preferences: activeThread.preferences, sessionId: activeSubagentSessionId })) : (_jsx(UnavailableSubagentView, { locale: locale, onBack: closeSubagent }))) : (_jsx("div", { className: "flex min-h-0 flex-1 flex-col", children: _jsx(AgentThreadView, { client: client, commands: commands, draftStorageKey: ephemeralThreadIds.has(activeThread.id)
                                            ? `${storageKey}:draft:new`
                                            : `${storageKey}:draft:${activeThread.id}`, isRecovering: activeIsRecovering, locale: locale, mailbox: mailbox, mentions: mentions, models: models, onCancelRecovery: () => cancelThreadRecovery(activeThread.id), onChange: changeActiveThread, onEvent: onEvent, onOpenSubagent: openSubagent, onRetryRecovery: () => requestThreadRecovery(activeThread.id), onRecoveryNeeded: recoverActiveThread, providerReady: runtimeStatus.provider !== "unconfigured", recoveryError: recoveryErrors.get(activeThread.id), reasoningLevels: reasoningLevels, thread: activeThread }, `${activeThread.id}:${activeThread.revision ?? 0}:${activeIsRecovering ? "recovering" : "ready"}`) }))] }) })] }), workbenchFullscreen ? (_jsx(FloatingAgentSidebar, { activeThreadId: activeThread.id, brand: productName, deletingThreadIds: deletingThreadIds, hostFooter: hostSlots?.sidebarFooter, locale: locale, messages: messages, onDelete: deleteThread, onNew: createThread, onRename: renameThread, onSelect: selectThread, onSettings: () => setSettingsOpen(true), threads: threads })) : null, _jsx(AgentSettingsDialog, { extensions: extensions, locale: locale, messages: messages, onLocaleChange: setLocale, onOpenChange: setSettingsOpen, open: settingsOpen })] }));
}
function FloatingAgentSidebar({ activeThreadId, brand, deletingThreadIds, hostFooter, locale, messages, onDelete, onNew, onRename, onSelect, onSettings, threads, }) {
    const [open, setOpen] = useState(false);
    const [resizing, setResizing] = useState(false);
    const sidebarPanelRef = usePanelRef();
    useEffect(() => {
        if (!open)
            return;
        const closeWhenPointerLeaves = (event) => {
            if (resizing)
                return;
            const sidebarWidth = sidebarPanelRef.current?.getSize().inPixels ?? FLOATING_SIDEBAR_DEFAULT_WIDTH;
            if (event.clientX > sidebarWidth + 8)
                setOpen(false);
        };
        window.addEventListener("pointermove", closeWhenPointerLeaves);
        return () => window.removeEventListener("pointermove", closeWhenPointerLeaves);
    }, [open, resizing, sidebarPanelRef]);
    return (_jsxs(_Fragment, { children: [!open ? (_jsx("div", { "aria-hidden": true, className: "fixed inset-y-0 left-0 z-50 w-3", "data-floating-sidebar-trigger": true, onMouseEnter: () => setOpen(true) })) : null, _jsx("div", { className: "fixed inset-y-0 left-0 z-40", "data-floating-sidebar": true, "data-open": open ? "true" : "false", "data-resizing": resizing ? "true" : "false", onFocusCapture: () => setOpen(true), children: _jsxs(ResizablePanelGroup, { className: "h-full w-[min(420px,100vw)] pointer-events-none", "data-floating-sidebar-group": true, orientation: "horizontal", children: [_jsx(ResizablePanel, { className: "block min-w-0 pointer-events-auto", "data-floating-sidebar-panel": true, defaultSize: `${FLOATING_SIDEBAR_DEFAULT_WIDTH}px`, id: "floating-agent-sidebar", maxSize: `${SIDEBAR_MAX_WIDTH}px`, minSize: `${SIDEBAR_MIN_WIDTH}px`, panelRef: sidebarPanelRef, children: _jsx("div", { className: "h-full min-w-0", onMouseEnter: () => setOpen(true), children: _jsx(AgentSidebar, { activeThreadId: activeThreadId, brand: brand, deletingThreadIds: deletingThreadIds, hostFooter: hostFooter, locale: locale, messages: messages, onClose: () => setOpen(false), onDelete: onDelete, onNew: () => {
                                        onNew();
                                        setOpen(false);
                                    }, onRename: onRename, onSelect: (threadId) => {
                                        onSelect(threadId);
                                        setOpen(false);
                                    }, onSettings: () => {
                                        onSettings();
                                        setOpen(false);
                                    }, open: open, threads: threads, variant: "floating" }) }) }), _jsx(ResizableHandle, { className: "pointer-events-auto flex bg-transparent after:w-2", "data-floating-sidebar-handle": true, onPointerDown: () => {
                                setOpen(true);
                                setResizing(true);
                            }, onPointerUp: () => setResizing(false) }), _jsx(ResizablePanel, { "aria-hidden": true, className: "pointer-events-none min-w-0 bg-transparent", "data-floating-sidebar-spacer": true, defaultSize: `${SIDEBAR_MAX_WIDTH - FLOATING_SIDEBAR_DEFAULT_WIDTH}px`, id: "floating-agent-sidebar-spacer", minSize: "0px" })] }) })] }));
}
function findSubagentSession(events, sessionId, locale) {
    const sessions = presentSubagentSessions(events);
    const index = sessions.findIndex((candidate) => candidate.childSessionId === sessionId);
    const session = sessions[index];
    if (!session)
        return undefined;
    return {
        label: session.name && session.name !== "agent"
            ? session.name
            : locale === "zh-CN" ? `子代理 ${index + 1}` : `Sub-agent ${index + 1}`,
        ...(session.task ? { task: session.task } : {}),
    };
}
function UnavailableSubagentView({ locale, onBack, }) {
    const messages = messagesFor(locale);
    return (_jsx("main", { className: "flex min-h-0 flex-1 items-center justify-center bg-background px-6", children: _jsxs("div", { className: "max-w-md text-center", children: [_jsx(AlertCircleIcon, { className: "mx-auto size-5 text-muted-foreground" }), _jsx("p", { className: "mt-3 text-sm text-muted-foreground", children: messages.subagentUnavailable }), _jsxs(Button, { className: "mt-4", onClick: onBack, size: "sm", variant: "outline", children: [_jsx(ArrowLeftIcon, { className: "size-4" }), messages.backToTask] })] }) }));
}
const RECOVERY_TAIL_LOOKUP_TIMEOUT_MS = 1_500;
const MAX_RECOVERY_RECONNECT_ATTEMPTS = 6;
const RECOVERY_RETRY_BASE_DELAY_MS = 750;
const RECOVERY_RETRY_MAX_DELAY_MS = 15_000;
const RECOVERY_STREAM_RECONNECT_POLICY = {
    retryableErrorStatuses: [404, 409, 425, 429, 500, 502, 503, 504],
    streamIdleReconnectPolicy: {
        baseDelayMs: 750,
        maxAttempts: 8,
        maxDelayMs: 15_000,
    },
    streamOpenReconnectPolicy: {
        baseDelayMs: 500,
        maxAttempts: 8,
        maxDelayMs: 15_000,
    },
};
async function readTailBoundary(session, parentSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal.addEventListener("abort", abort, { once: true });
    const timeout = window.setTimeout(abort, RECOVERY_TAIL_LOOKUP_TIMEOUT_MS);
    try {
        for await (const event of session.stream({
            signal: controller.signal,
            startIndex: -1,
            streamReconnectPolicy: { reconnect: false },
        })) {
            return isRecoveryBoundary(event) ? event : undefined;
        }
    }
    catch (error) {
        if (!controller.signal.aborted && !isAbortError(error))
            throw error;
    }
    finally {
        window.clearTimeout(timeout);
        parentSignal.removeEventListener("abort", abort);
    }
    return undefined;
}
function waitForRecoveryRetry(signal, attempt) {
    if (signal.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        const finish = () => {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", finish);
            resolve();
        };
        const delay = Math.min(RECOVERY_RETRY_MAX_DELAY_MS, RECOVERY_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
        const timeout = window.setTimeout(finish, delay);
        signal.addEventListener("abort", finish, { once: true });
    });
}
function isRecoveryBoundary(event) {
    return event.type === "session.waiting" || event.type === "session.completed" || event.type === "session.failed";
}
function statusFromEvents(events, closedInputRequestIds = new Set()) {
    const last = events.at(-1);
    if (!last)
        return "ready";
    if (last.type === "session.failed")
        return "error";
    const latestTurnBoundary = [...events].reverse().find((event) => event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled");
    if (latestTurnBoundary?.type === "turn.failed")
        return "error";
    if (last.type === "turn.cancelled")
        return "cancelling";
    if (last.type === "session.waiting") {
        return hasUnresolvedInputRequests(events, closedInputRequestIds) ? "waiting" : "ready";
    }
    if (last.type === "session.completed")
        return "ready";
    if (last.type === "turn.started" || last.type === "step.started" || last.type === "message.appended" || last.type === "reasoning.appended")
        return "streaming";
    return "submitted";
}
function isAbortError(error) {
    return error instanceof Error && error.name === "AbortError";
}
function isRetryableRecoveryError(error) {
    if (error instanceof ClientError) {
        return error.status === 0 || [404, 409, 425, 429, 500, 502, 503, 504].includes(error.status);
    }
    return error instanceof TypeError || (error instanceof Error && /fetch|network|socket|stream/i.test(error.message));
}
function validateWorkspaceCatalog(models, reasoningLevels, defaults) {
    if (models.length === 0 || models.some((model) => !model.id.trim() || !model.label.trim() || !Number.isSafeInteger(model.contextWindowTokens) || model.contextWindowTokens <= 0)) {
        throw new Error("AgentWorkspace requires at least one valid model option.");
    }
    if (new Set(models.map((model) => model.id)).size !== models.length) {
        throw new Error("AgentWorkspace model ids must be unique.");
    }
    if (reasoningLevels.length === 0 || reasoningLevels.some((level) => !level.trim())) {
        throw new Error("AgentWorkspace requires at least one reasoning level.");
    }
    if (!models.some((model) => model.id === defaults.modelId) || !reasoningLevels.includes(defaults.reasoning)) {
        throw new Error("AgentWorkspace defaults must exist in the injected model and reasoning catalogs.");
    }
}
function normalizeThreadPreferences(thread, models, reasoningLevels, defaults) {
    const modelId = models.some((model) => model.id === thread.preferences.modelId)
        ? thread.preferences.modelId
        : defaults.modelId;
    const reasoning = reasoningLevels.includes(thread.preferences.reasoning)
        ? thread.preferences.reasoning
        : defaults.reasoning;
    const executionMode = thread.preferences.executionMode ?? defaults.executionMode;
    return modelId === thread.preferences.modelId && reasoning === thread.preferences.reasoning && executionMode === thread.preferences.executionMode
        ? thread
        : { ...thread, preferences: { executionMode, modelId, reasoning } };
}
function withoutSetValue(source, value) {
    if (!source.has(value))
        return source;
    const next = new Set(source);
    next.delete(value);
    return next;
}
function withoutMapKey(source, key) {
    if (!source.has(key))
        return source;
    const next = new Map(source);
    next.delete(key);
    return next;
}
function threadNeedsRecovery(thread) {
    if (thread.hydration === "summary")
        return false;
    if (!thread.session.sessionId)
        return false;
    if (thread.queuedTurns.some((turn) => (turn.delivery === "server" && mailboxTurnAwaitsAdmission(turn) && Boolean(turn.mailboxItemId)) ||
        (turn.delivery === "server" && turn.state === "committed" && Boolean(turn.mailboxItemId)) ||
        turn.intent === "post-cancellation"))
        return true;
    const pendingTurnInFlight = thread.pendingTurn?.state === "clearing" ||
        thread.pendingTurn?.state === "resubmitting" ||
        thread.pendingTurn?.state === "submitting";
    if (!pendingTurnInFlight && thread.status !== "streaming" && thread.status !== "submitted") {
        return thread.status === "cancelling";
    }
    const lastEvent = thread.events.at(-1);
    return !lastEvent || !isRecoveryBoundary(lastEvent);
}
function isEmptyDraftThread(thread) {
    return thread.events.length === 0 &&
        thread.queuedTurns.length === 0 &&
        !thread.pendingTurn &&
        !thread.session.sessionId;
}
function sameQueuedTurns(left, right) {
    return left.length === right.length && left.every((turn, index) => {
        const candidate = right[index];
        return candidate?.id === turn.id &&
            candidate.delivery === turn.delivery &&
            candidate.intent === turn.intent &&
            candidate.mailboxItemId === turn.mailboxItemId &&
            candidate.state === turn.state;
    });
}
function mailboxQueueState(status) {
    if (status === "failed")
        return "delivery-failed";
    if (status === "submission-ambiguous")
        return "admission-ambiguous";
    if (status === "cancelled")
        return "cancelled";
    return status;
}
function mailboxTurnAwaitsAdmission(turn) {
    return turn.state === "queued" || turn.state === "delivering" ||
        turn.state === "accepted";
}
function mailboxMessageWasObserved(events, turn) {
    return events.some((event) => event.type === "message.received" &&
        event.data.message.trim() === turn.text.trim() &&
        Date.parse(event.meta.at) >= turn.submittedAt);
}
async function saveThreadCollectionWithConflictRecovery(storageKey, collection, storage) {
    let candidate = collection;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            await storage.save(storageKey, candidate);
            return candidate;
        }
        catch (error) {
            if (!(error instanceof AgentThreadStorageConflictError) || attempt === 2)
                throw error;
            const remote = await storage.load(storageKey);
            candidate = mergeThreadCollections(candidate, remote);
        }
    }
    return candidate;
}
function mergeThreadCollections(local, remote) {
    const threads = mergeThreads(local.threads, remote.threads);
    const activeThreadId = local.activeThreadId && threads.some((thread) => thread.id === local.activeThreadId)
        ? local.activeThreadId
        : remote.activeThreadId;
    return {
        ...(activeThreadId ? { activeThreadId } : {}),
        threads,
        version: AGENT_THREAD_STORAGE_VERSION,
    };
}
function mergeThreads(preferred, fallback) {
    const byId = new Map(fallback.map((thread) => [thread.id, thread]));
    for (const thread of preferred) {
        const existing = byId.get(thread.id);
        if (!existing || thread.updatedAt >= existing.updatedAt)
            byId.set(thread.id, thread);
    }
    return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}
function mergeVisibleThreads(current, persisted, ephemeralIds) {
    const ephemeral = current.filter((thread) => ephemeralIds.has(thread.id));
    const localPersisted = current.filter((thread) => !ephemeralIds.has(thread.id));
    return [...ephemeral, ...mergeThreads(localPersisted, persisted)];
}
function sameThreadCollection(left, right) {
    return left.activeThreadId === right.activeThreadId &&
        left.threads.length === right.threads.length &&
        left.threads.every((thread, index) => {
            const candidate = right.threads[index];
            return candidate?.id === thread.id && candidate.updatedAt === thread.updatedAt;
        });
}
function isUrgentPersistenceChange(previous, next) {
    if (!previous || previous.activeThreadId !== next.activeThreadId)
        return true;
    if (previous.threads.length !== next.threads.length)
        return true;
    const previousThreads = new Map(previous.threads.map((thread) => [thread.id, thread]));
    for (const thread of next.threads) {
        const prior = previousThreads.get(thread.id);
        if (!prior)
            return true;
        if (prior.title !== thread.title ||
            prior.revision !== thread.revision ||
            prior.draftRestore?.id !== thread.draftRestore?.id ||
            prior.session.sessionId !== thread.session.sessionId ||
            prior.preferences.executionMode !== thread.preferences.executionMode ||
            prior.preferences.modelId !== thread.preferences.modelId ||
            prior.preferences.reasoning !== thread.preferences.reasoning ||
            !samePendingTurn(prior.pendingTurn, thread.pendingTurn) ||
            !sameQueuedTurns(prior.queuedTurns, thread.queuedTurns) ||
            !sameStringList(prior.closedInputRequestIds, thread.closedInputRequestIds) ||
            !sameStringList(prior.retainedContext ?? [], thread.retainedContext ?? []))
            return true;
        if (prior.status !== thread.status &&
            (thread.status === "cancelling" || thread.status === "error" ||
                thread.status === "ready" || thread.status === "waiting"))
            return true;
        const lastEvent = thread.events.at(-1);
        const priorLastEvent = prior.events.at(-1);
        if (lastEvent?.meta.id !== priorLastEvent?.meta.id &&
            lastEvent && isUrgentPersistenceEvent(lastEvent))
            return true;
    }
    return false;
}
function samePendingTurn(left, right) {
    if (!left || !right)
        return left === right;
    return left.id === right.id &&
        left.state === right.state &&
        left.submittedAt === right.submittedAt &&
        left.text === right.text &&
        JSON.stringify(left.files ?? []) === JSON.stringify(right.files ?? []);
}
function sameStringList(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function isUrgentPersistenceEvent(event) {
    return event.type === "authorization.completed" ||
        event.type === "authorization.required" ||
        event.type === "compaction.completed" ||
        event.type === "input.requested" ||
        event.type === "message.received" ||
        event.type === "session.completed" ||
        event.type === "session.failed" ||
        event.type === "session.waiting" ||
        event.type === "turn.cancelled" ||
        event.type === "turn.completed" ||
        event.type === "turn.failed";
}
function loadLocale(storageKey) {
    const stored = window.localStorage.getItem(`${storageKey}:locale`);
    return stored === "en" || stored === "zh-CN" ? stored : resolveBrowserLocale();
}
function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}
//# sourceMappingURL=agent-workspace.js.map