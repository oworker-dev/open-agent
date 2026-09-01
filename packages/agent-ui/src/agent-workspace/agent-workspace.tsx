"use client";

import { ClientError, type Client, type ClientSession, type MessageStreamEvent } from "eve/client";
import { AlertCircleIcon, ArrowLeftIcon, MenuIcon, PanelLeftCloseIcon, PanelLeftIcon, PanelRightIcon, ServerOffIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "../ui/button.js";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui/resizable.js";
import {
  usePanelRef,
  type Layout,
  type LayoutChangedMeta,
  type PanelSize,
} from "react-resizable-panels";
import { attachAgentSession, createAgentSession } from "./agent-client.js";
import { AgentChildSessionView } from "./agent-child-session.js";
import { AgentSettingsDialog } from "./agent-settings-dialog.js";
import { AgentSidebar } from "./agent-sidebar.js";
import { AgentSubagentMenu } from "./agent-subagent-menu.js";
import { AgentSecondaryView, type AgentSecondaryChild, type AgentSecondaryTab } from "./agent-secondary-view.js";
import { AgentThreadView } from "./agent-thread.js";
import { cn } from "../utils.js";
import type { AgentAssetEndpoint, AgentDeliverableEndpoint, AgentInterruptedTurn, AgentModelOption, AgentPendingTurn, AgentQueuedTurn, AgentSessionAsset, AgentSessionBoundary, AgentSessionInspector, AgentSessionDeliverable, AgentSubagentController, AgentSubagentLoader, AgentSubagentSummary, AgentThread, AgentThreadPatch, AgentThreadPreferences, AgentTranscriptWindow, AgentWorkspaceClientConfig, AgentWorkspaceMailbox } from "./contracts.js";
import { AgentThreadStorageConflictError, AgentThreadStorageHttpError } from "./http-thread-storage.js";
import { messagesFor, resolveBrowserLocale, type AgentLocale, type AgentMessages } from "./i18n.js";
import {
  AGENT_THREAD_STORAGE_VERSION,
  browserThreadStorage,
  appendThreadEventIndexed,
  compactThreadEvents,
  createAgentThread,
  eventIdentity,
  mergeThreadCollectionsForConflict,
  reconcileHydratedPendingTurn,
  reconcilePendingTurnWithEvents,
  type AgentThreadCollection,
  type AgentThreadStorage,
} from "./thread-storage.js";
import {
  hasUnresolvedInputRequests,
  mergeSubagentSessions,
  shouldSuppressInterruptedTurnStreamEvent,
} from "./turn-presentation.js";
import { loadSessionDeliverables } from "./session-deliverables.js";

const DEFAULT_STORAGE_KEY = "open-agent:threads:v1";
const STORAGE_URGENT_SAVE_DELAY_MS = 50;
const STORAGE_STREAM_CHECKPOINT_MS = 15_000;
const WORKBENCH_TRANSITION_MS = 300;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 252;
const SIDEBAR_COLLAPSED_THRESHOLD = 1;
const FLOATING_SIDEBAR_DEFAULT_WIDTH = 288;

type WorkbenchLayoutMode = "split" | "collapsing" | "fullscreen" | "expanding";

export function AgentWorkspace({
  assetEndpoint,
  client,
  commands = [],
  defaultPreferences,
  deliverableEndpoint,
  extensions = [],
  hostSlots,
  initialSubagentSessionId,
  initialThreadId,
  inspectSession,
  loadSubagents,
  controlSubagent,
  mailbox,
  models,
  mentions = [],
  onEvent,
  onOpenAsset,
  onDeleteThread,
  onActiveSubagentChange,
  onActiveThreadChange,
  onOpenDeliverable,
  onStorageError,
  productName = "Agent",
  reasoningLevels,
  runtimeStatus = { provider: "ready" },
  storageKey = DEFAULT_STORAGE_KEY,
  threadStorage = browserThreadStorage,
}: {
  readonly agentName?: string;
  readonly assetEndpoint?: AgentAssetEndpoint;
  readonly client?: AgentWorkspaceClientConfig;
  readonly commands?: readonly import("./contracts.js").AgentPromptMenuItem[];
  readonly defaultPreferences: AgentThreadPreferences;
  readonly deliverableEndpoint?: AgentDeliverableEndpoint;
  readonly extensions?: readonly import("./contracts.js").AgentExtensionInfo[];
  readonly hostSlots?: { readonly sidebarFooter?: React.ReactNode; readonly threadHeaderEnd?: React.ReactNode };
  readonly initialSubagentSessionId?: string;
  readonly initialThreadId?: string;
  readonly inspectSession?: AgentSessionInspector;
  readonly mailbox?: AgentWorkspaceMailbox;
  readonly loadSubagents?: AgentSubagentLoader;
  readonly controlSubagent?: AgentSubagentController;
  readonly models: readonly AgentModelOption[];
  readonly mentions?: readonly import("./contracts.js").AgentPromptMenuItem[];
  readonly onEvent?: (event: MessageStreamEvent) => void;
  readonly onOpenAsset?: (asset: AgentSessionAsset) => void;
  readonly onDeleteThread?: (thread: AgentThread) => void | Promise<void>;
  readonly onActiveSubagentChange?: (threadId: string, sessionId?: string) => void;
  readonly onActiveThreadChange?: (threadId?: string) => void;
  readonly onOpenDeliverable?: (deliverable: AgentSessionDeliverable) => void;
  readonly onStorageError?: (error: unknown) => void;
  readonly productName?: string;
  readonly reasoningLevels: readonly string[];
  readonly runtimeStatus?: import("./contracts.js").AgentRuntimeStatus;
  readonly storageKey?: string;
  readonly threadStorage?: AgentThreadStorage;
}) {
  validateWorkspaceCatalog(models, reasoningLevels, defaultPreferences);
  const catalogSignature = JSON.stringify({ models, reasoningLevels });
  const stableDefaults = useMemo<AgentThreadPreferences>(
    () => ({
      modelId: defaultPreferences.modelId,
      reasoning: defaultPreferences.reasoning,
      executionMode: defaultPreferences.executionMode ?? "standard",
    }),
    [defaultPreferences.executionMode, defaultPreferences.modelId, defaultPreferences.reasoning],
  );
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const threadsRef = useRef<readonly AgentThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>();
  const activeThreadIdRef = useRef<string | undefined>(undefined);
  const [activeSubagentSessionId, setActiveSubagentSessionId] = useState<string>();
  const [isHydrated, setIsHydrated] = useState(false);
  const [recoveringIds, setRecoveringIds] = useState<Set<string>>(new Set());
  const [recoveryErrors, setRecoveryErrors] = useState<Map<string, string>>(new Map());
  const [hydratingThreadIds, setHydratingThreadIds] = useState<Set<string>>(new Set());
  const [threadHydrationErrors, setThreadHydrationErrors] = useState<Map<string, string>>(new Map());
  const [threadHistoryLoading, setThreadHistoryLoading] = useState<Set<string>>(new Set());
  const [threadRuntimeSeeds, setThreadRuntimeSeeds] = useState<Map<string, string>>(new Map());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workbenchMode, setWorkbenchMode] = useState<WorkbenchLayoutMode>("split");
  const [panelResizing, setPanelResizing] = useState(false);
  const [desktopLayout, setDesktopLayout] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deletionIssue, setDeletionIssue] = useState(false);
  const [deletingThreadIds, setDeletingThreadIds] = useState<Set<string>>(new Set());
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  const [secondaryTab, setSecondaryTab] = useState<AgentSecondaryTab>("home");
  const [secondaryChildSessionId, setSecondaryChildSessionId] = useState<string>();
  const [sessionAssets, setSessionAssets] = useState<readonly AgentSessionAsset[]>([]);
  const [sessionDeliverables, setSessionDeliverables] = useState<readonly AgentSessionDeliverable[]>([]);
  const [deliverablesLoading, setDeliverablesLoading] = useState(false);
  const [deliverablesError, setDeliverablesError] = useState<string>();
  const [requestedDeliverable, setRequestedDeliverable] = useState<{ readonly deliverable: AgentSessionDeliverable; readonly requestId: number }>();
  const [durableSubagents, setDurableSubagents] = useState<readonly AgentSubagentSummary[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsError, setAssetsError] = useState<string>();
  const [ephemeralThreadIds, setEphemeralThreadIds] = useState<Set<string>>(new Set());
  const [locale, setLocale] = useState<AgentLocale>("en");
  const recoveryStarted = useRef(new Set<string>());
  const recoveryControllers = useRef(new Map<string, AbortController>());
  const runtimeChecksStarted = useRef(new Set<string>());
  const hydrationInFlight = useRef(new Set<string>());
  const historyWindowInFlight = useRef(new Set<string>());
  const serverHydrationThreads = useRef(new Set<string>());
  const storageSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const storageSaveTimer = useRef<number | undefined>(undefined);
  const storageSaveDueAt = useRef<number | undefined>(undefined);
  const workbenchTransitionTimer = useRef<number | undefined>(undefined);
  const workbenchTransition = useRef<"collapsing" | "expanding" | undefined>(undefined);
  const deliverableRequestSequence = useRef(0);
  const lastSidebarWidth = useRef(SIDEBAR_DEFAULT_WIDTH);
  const pendingCollection = useRef<AgentThreadCollection | undefined>(undefined);
  const messages = messagesFor(locale);
  const sidebarPanelRef = usePanelRef();
  const activeSessionScopeRef = useRef<string | undefined>(undefined);
  activeThreadIdRef.current = activeThreadId;

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
    if (!panelResizing) return;
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
        if (cancelled) return;
        const storedThreads = collection.threads.map((thread) =>
          normalizeThreadPreferences(thread, models, reasoningLevels, stableDefaults)
        );
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

        // Do not infer runtime liveness from a browser checkpoint. A stale
        // `submitted` status is common after a refresh, while Eve may already
        // be parked at `session.waiting`. Runtime inspection below decides
        // whether a live recovery stream is actually needed.
      })
      .catch((error: unknown) => {
        if (cancelled) return;
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
    if (!isHydrated || !activeThreadId) return;
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
    if (!isHydrated) return;
    window.localStorage.setItem(`${storageKey}:locale`, locale);
    document.documentElement.lang = locale;
  }, [isHydrated, locale, storageKey]);

  useEffect(() => {
    if (!isHydrated) return;
    const persistedThreads = threads.filter((thread) => !ephemeralThreadIds.has(thread.id));
    const collection = {
      activeThreadId: activeThreadId && !ephemeralThreadIds.has(activeThreadId)
        ? activeThreadId
        : undefined,
      threads: persistedThreads,
      version: AGENT_THREAD_STORAGE_VERSION,
    } as const;
    const previousCollection = pendingCollection.current;
    if (previousCollection && sameThreadCollection(previousCollection, collection)) return;
    pendingCollection.current = collection;
    const saveDelay = isUrgentPersistenceChange(previousCollection, collection)
      ? STORAGE_URGENT_SAVE_DELAY_MS
      : STORAGE_STREAM_CHECKPOINT_MS;
    const dueAt = Date.now() + saveDelay;
    if (
      storageSaveTimer.current !== undefined &&
      storageSaveDueAt.current !== undefined &&
      storageSaveDueAt.current <= dueAt
    ) return;
    window.clearTimeout(storageSaveTimer.current);
    storageSaveDueAt.current = dueAt;
    storageSaveTimer.current = window.setTimeout(() => {
      storageSaveTimer.current = undefined;
      storageSaveDueAt.current = undefined;
      const nextCollection = pendingCollection.current;
      if (!nextCollection) return;
      storageSaveQueue.current = storageSaveQueue.current
        .catch(() => undefined)
        .then(async () => {
          const saved = await saveThreadCollectionWithConflictRecovery(
            storageKey,
            nextCollection,
            threadStorage,
          );
          if (!sameThreadCollection(saved, nextCollection)) {
            setThreads((current) => mergeVisibleThreads(current, saved.threads, ephemeralThreadIds));
          }
        })
        .catch((error: unknown) => {
          onStorageError?.(error);
        });
    }, saveDelay);
  }, [activeThreadId, ephemeralThreadIds, isHydrated, onStorageError, storageKey, threadStorage, threads]);

  const updateThread = useCallback((threadId: string, patch: AgentThreadPatch) => {
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

  const settleThreadHistory = useCallback(async (
    thread: AgentThread,
    boundary: AgentSessionBoundary,
    preserveRuntimeIdentity = false,
  ) => {
    const failed = boundary.state === "terminal" && boundary.terminalStatus === "failed";
    const settledStatus: AgentThread["status"] = failed ? "error" : "ready";
    const authoritativeTailExclusive = boundary.tailIndex === undefined
      ? thread.session.streamIndex
      : boundary.tailIndex + 1;
    let settledCursor = thread.session.streamIndex;
    let settledEvents = compactThreadEvents(thread.events);
    let caughtUpSettledRange = false;

    // A persisted session.waiting event can belong to an earlier turn. The
    // absolute Eve cursor, not that local boundary, determines whether this
    // browser has consumed the settled run. Catch up the exact missing range
    // before advancing the cursor or publishing a ready state; otherwise a
    // refresh between Eve's durable write and the browser checkpoint can skip
    // the new reply permanently and render the preceding reply in its place.
    if (
      boundary.tailIndex !== undefined &&
      authoritativeTailExclusive > settledCursor &&
      thread.session.sessionId
    ) {
      const connection = createAgentSession(client, thread.preferences, thread.session);
      const session = attachAgentSession(connection, connection.initialSession);
      if (!session) throw new Error("The settled Agent session could not be attached.");
      const missing = await readSettledRange(
        session,
        settledCursor,
        boundary.tailIndex,
        AbortSignal.timeout(RECOVERY_FOLLOW_IDLE_TIMEOUT_MS),
      );
      if (missing.length !== authoritativeTailExclusive - settledCursor) {
        throw new Error("The settled Agent history ended before the authoritative tail.");
      }
      const merged = [...settledEvents];
      const eventIds = new Set(merged.map(eventIdentity));
      for (const event of missing) appendThreadEventIndexed(merged, eventIds, event);
      settledEvents = compactThreadEvents(merged);
      settledCursor = authoritativeTailExclusive;
      caughtUpSettledRange = true;
    } else {
      settledCursor = Math.max(settledCursor, authoritativeTailExclusive);
    }
    const settledSession = {
      ...thread.session,
      streamIndex: settledCursor,
    };
    const settledPendingTurn = reconcileHydratedPendingTurn(thread.pendingTurn, settledEvents);
    // A lifecycle boundary only proves that Eve is settled. It does not prove
    // that this compact browser transcript contains every absolute stream
    // event. Only a live checkpoint or the server repair route may publish a
    // new complete coverage marker.
    const settledCoverage = hasCompleteTranscriptCoverage(thread, settledCursor)
      ? thread.transcriptCoverage
      : undefined;

    // Publish the authoritative lifecycle immediately. This prevents a
    // stale partial tool event from keeping the composer in a running state
    // while the small settled tail is being synchronized silently.
    const settledPatch: AgentThreadPatch = {
      events: settledEvents,
      ...(settledCoverage
        ? { transcriptCoverage: settledCoverage }
        : { transcriptCoverage: undefined }),
      ...(settledPendingTurn ? { pendingTurn: settledPendingTurn } : { pendingTurn: undefined }),
      session: settledSession,
      status: settledStatus,
      updatedAt: Date.now(),
    };
    if (caughtUpSettledRange && activeThreadIdRef.current === thread.id && !preserveRuntimeIdentity) {
      // Eve's reducer seeds `initialEvents` once. A finite settled catch-up is
      // therefore a real recovery handoff, not an ordinary metadata update:
      // remount exactly once with the caught-up snapshot so the old reducer
      // cannot keep rendering (or checkpointing) the previous turn.
      flushSync(() => {
        setThreadRuntimeSeeds((current) => {
          const seed = `settled:${thread.session.sessionId}:${settledCursor}`;
          if (current.get(thread.id) === seed) return current;
          const next = new Map(current);
          next.set(thread.id, seed);
          return next;
        });
        updateThread(thread.id, settledPatch);
      });
    } else {
      updateThread(thread.id, settledPatch);
    }

    // A settled runtime does not prove that the browser transcript is
    // complete. Legacy checkpoints can contain only a small prefix while the
    // Eve cursor is far ahead. Never append a tail window to that prefix: it
    // creates a plausible-looking but permanently incomplete transcript and
    // drops the middle of the task. The server repair path is the only place
    // allowed to rebuild such history from index zero.
    const transcriptComplete = hasCompleteTranscriptCoverage(thread, settledCursor) ||
      settledCursor <= settledEvents.length;
    // A bounded event window is an intentional representation of a long
    // settled transcript. It is not a damaged transcript, and repairing it
    // here would reopen Eve from index zero and replay the entire run on every
    // refresh. Keep the window and lifecycle boundary as-is; older/legacy
    // snapshots without a window may still use the explicit finite repair
    // endpoint below.
    if (
      !transcriptComplete &&
      !thread.transcriptWindow &&
      serverHydrationThreads.current.has(thread.id) &&
      threadStorage.repairThread &&
      thread.session.sessionId &&
      shouldRepairServerTranscript(thread)
    ) {
      try {
        const repaired = await threadStorage.repairThread(storageKey, thread.id);
        if (repaired) {
          const repairedPendingTurn = reconcileHydratedPendingTurn(
            repaired.pendingTurn,
            compactThreadEvents(repaired.events),
          );
          updateThread(thread.id, {
            ...repaired,
            events: compactThreadEvents(repaired.events),
            ...(repairedPendingTurn ? { pendingTurn: repairedPendingTurn } : { pendingTurn: undefined }),
            updatedAt: Date.now(),
          });
          return;
        }
      } catch (error) {
        // A 409 means a new turn was admitted while this repair was racing the
        // boundary. Keep the runtime lifecycle authoritative and let the next
        // durable checkpoint retry; other errors should not reopen a stream.
        if (!(error instanceof AgentThreadStorageHttpError) || error.status !== 409) {
          onStorageError?.(error);
        }
      }
    }
    // A compact legacy prefix whose absolute cursor is ahead of its visible
    // event count has a transcript gap. A bounded tail cannot repair that
    // missing middle. It may still contribute the authoritative terminal
    // boundary for the currently visible turn so stale tool UI can settle;
    // ordinary tail events remain server-repair-only and coverage stays
    // explicitly partial. Windowed transcripts intentionally follow this same
    // rule without escalating to an unbounded repair.
    const safeShortPrefix = !transcriptComplete &&
      thread.session.streamIndex === thread.events.length &&
      boundary.tailIndex !== undefined &&
      boundary.tailIndex + 1 <= SETTLED_TAIL_EVENTS;
    const boundaryOnly = !transcriptComplete && !safeShortPrefix;

    if (
      boundary.tailIndex === undefined ||
      (settledEvents.at(-1) && isRecoveryBoundary(settledEvents.at(-1)!)) ||
      !thread.session.sessionId
    ) return;

    const connection = createAgentSession(client, thread.preferences, settledSession);
    const session = attachAgentSession(connection, connection.initialSession);
    if (!session) return;

    try {
      const tailEvents = await readSettledTail(
        session,
        boundary.tailIndex,
        AbortSignal.timeout(RECOVERY_TAIL_LOOKUP_TIMEOUT_MS * 2),
      );
      if (tailEvents.length === 0) return;
      const latestVisibleTurnId = [...settledEvents].reverse().find((event) =>
        event.type === "turn.started"
      );
      const eventsToMerge = boundaryOnly
        ? tailEvents.filter((event) =>
            event.type === "session.waiting" ||
            event.type === "session.completed" ||
            event.type === "session.failed" ||
            ((event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") &&
              latestVisibleTurnId?.type === "turn.started" &&
              event.data.turnId === latestVisibleTurnId.data.turnId)
          )
        : tailEvents;
      if (eventsToMerge.length === 0) return;
      const events = [...settledEvents];
      const eventIds = new Set(events.map(eventIdentity));
      for (const event of eventsToMerge) appendThreadEventIndexed(events, eventIds, event);
      const nextSettledEvents = compactThreadEvents(events);
      updateThread(thread.id, {
        events: nextSettledEvents,
        ...(settledCoverage
          ? { transcriptCoverage: settledCoverage }
          : { transcriptCoverage: undefined }),
        ...(settledPendingTurn ? { pendingTurn: settledPendingTurn } : { pendingTurn: undefined }),
        revision: (thread.revision ?? 0) + 1,
        session: settledSession,
        status: settledStatus,
        updatedAt: Date.now(),
      });
    } catch {
      // The runtime lifecycle is already settled. A transient tail read must
      // not reopen a live stream or put the completed thread back in recovery.
    }
  }, [client, onStorageError, storageKey, threadStorage, updateThread]);

  const inspectThreadRuntime = useCallback(async (thread: AgentThread) => {
    // Runtime inspection and recovery are owned by the visible thread only.
    // A hydration/selection race must not start a background stream for a
    // thread the user has already left.
    if (activeThreadIdRef.current !== thread.id) return;
    const runtimeCheckKey = runtimeInspectionKey(thread);
    if (
      !thread.session.sessionId ||
      runtimeChecksStarted.current.has(runtimeCheckKey)
    ) return;
    if (!threadNeedsRuntimeInspection(thread)) {
      // A stale browser status must not survive hydration when the durable
      // transcript already contains its session boundary. Normalize the
      // metadata without opening Eve's stream.
      if (thread.status === "streaming" || thread.status === "submitted") {
        updateThread(thread.id, {
          status: statusFromEvents(thread.events, new Set(thread.closedInputRequestIds)),
          updatedAt: Date.now(),
        });
      }
      return;
    }
    runtimeChecksStarted.current.add(runtimeCheckKey);
    if (!inspectSession) {
      setRecoveringIds((current) => new Set(current).add(thread.id));
      return;
    }
      try {
        const boundary = await inspectSession(thread.session.sessionId);
        const currentThread = threadsRef.current.find((candidate) => candidate.id === thread.id);
        if (
          activeThreadIdRef.current !== thread.id ||
          !currentThread ||
          runtimeInspectionKey(currentThread) !== runtimeCheckKey
        ) {
          runtimeChecksStarted.current.delete(runtimeCheckKey);
          return;
        }
      const hasQueuedAdmission = thread.queuedTurns.some((turn) =>
        turn.delivery === "server" && Boolean(turn.mailboxItemId),
      );
      if (boundary.state === "running" || hasQueuedAdmission || thread.status === "cancelling") {
        setRecoveringIds((current) => new Set(current).add(thread.id));
        return;
      }
      await settleThreadHistory(thread, boundary, thread.pendingTurn?.operation === "edit");
    } catch {
      // A failed lifecycle probe is not evidence that a completed session is
      // running, so recovery will start with bounded catch-up only. This also
      // keeps hosts that do not expose an inspector usable during a transient
      // control-plane outage without opening an unsafe live-follow stream.
      runtimeChecksStarted.current.delete(runtimeCheckKey);
      setRecoveringIds((current) => new Set(current).add(thread.id));
    }
  }, [inspectSession, settleThreadHistory, updateThread]);

  const createThread = useCallback(() => {
    const active = activeThreadId ? threadsRef.current.find((thread) => thread.id === activeThreadId) : undefined;
    // Keep one draft placeholder. A repeated click while the user is already
    // on an untouched session should focus that same draft instead of filling
    // the recent-session list with unusable empty rows.
    if (active && ephemeralThreadIds.has(active.id) && isEmptyDraftThread(active)) {
      setActiveSubagentSessionId(undefined);
      if (!window.matchMedia("(min-width: 1024px)").matches) setSidebarOpen(false);
      return;
    }
    const thread = createAgentThread(Date.now(), messages.newTask, stableDefaults);
    setThreads((current) => [thread, ...current]);
    setActiveThreadId(thread.id);
    setEphemeralThreadIds((current) => new Set(current).add(thread.id));
    setActiveSubagentSessionId(undefined);
    if (!window.matchMedia("(min-width: 1024px)").matches) setSidebarOpen(false);
  }, [activeThreadId, ephemeralThreadIds, messages.newTask, stableDefaults]);

  const deleteThread = useCallback(async (threadId: string) => {
    const thread = threads.find((item) => item.id === threadId);
    if (!thread || deletingThreadIds.has(threadId)) return;
    if (thread && onDeleteThread) {
      setDeletingThreadIds((current) => new Set(current).add(threadId));
      try {
        await onDeleteThread(thread);
        setDeletionIssue(false);
      } catch (error) {
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

  const finishWorkbenchTransition = useCallback((transition: "collapsing" | "expanding", nextMode: "fullscreen" | "split") => {
    window.clearTimeout(workbenchTransitionTimer.current);
    workbenchTransitionTimer.current = window.setTimeout(() => {
      if (workbenchTransition.current !== transition) return;
      workbenchTransition.current = undefined;
      workbenchTransitionTimer.current = undefined;
      setWorkbenchMode(nextMode);
    }, WORKBENCH_TRANSITION_MS + 40);
  }, []);

  const toggleDesktopSidebar = useCallback(() => {
    const panel = sidebarPanelRef.current;
    if (!desktopLayout || !panel) return;

    if (workbenchMode === "split") {
      const currentWidth = panel.getSize().inPixels;
      if (currentWidth >= SIDEBAR_MIN_WIDTH) lastSidebarWidth.current = currentWidth;
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

  const handleSidebarResize = useCallback((size: PanelSize) => {
    if (size.inPixels >= SIDEBAR_MIN_WIDTH) {
      lastSidebarWidth.current = clamp(size.inPixels, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
    }
  }, []);

  const handleDesktopLayoutChanged = useCallback((layout: Layout, meta: LayoutChangedMeta) => {
    if (!desktopLayout || !meta.isUserInteraction) return;
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

  const renameThread = useCallback((threadId: string, title: string) => {
    const normalized = title.trim();
    if (!normalized) return;
    updateThread(threadId, { title: normalized });
  }, [updateThread]);

  const requestThreadRecovery = useCallback((threadId: string) => {
    setRecoveryErrors((current) => withoutMapKey(current, threadId));
    setRecoveringIds((current) => new Set(current).add(threadId));
  }, []);

  const cancelThreadRecovery = useCallback((threadId: string) => {
    // Keep the existing recovery stream attached while a user cancellation is
    // being delivered. Eve emits the authoritative `turn.cancelled` and
    // `session.waiting` boundary on that stream; aborting it here forces a
    // second recovery mount and can race a stale tail probe. The recovery
    // loop already observes the durable cancellation and settles itself.
    setRecoveryErrors((current) => withoutMapKey(current, threadId));
  }, []);

  const suspendThreadRecovery = useCallback((threadId: string) => {
    // Recovery belongs to the visible thread. When navigation leaves it,
    // release its HTTP stream; the worker flushes the consumed cursor in its
    // finally block, so reopening the thread can catch up from durable state.
    recoveryControllers.current.get(threadId)?.abort();
    recoveryStarted.current.delete(threadId);
    // The inspection guard is scoped to one visible recovery attempt. Once
    // navigation aborts that attempt, allow the next visit to probe Eve again
    // instead of reusing a stale "already inspected" marker.
    for (const key of runtimeChecksStarted.current) {
      if (key.startsWith(`${threadId}|`)) runtimeChecksStarted.current.delete(key);
    }
    setRecoveringIds((current) => withoutSetValue(current, threadId));
    setRecoveryErrors((current) => withoutMapKey(current, threadId));
  }, []);

  const selectThread = useCallback((threadId: string) => {
    const previousThreadId = activeThreadIdRef.current;
    if (previousThreadId && previousThreadId !== threadId) {
      suspendThreadRecovery(previousThreadId);
    }
    activeThreadIdRef.current = threadId;
    setActiveThreadId(threadId);
    setActiveSubagentSessionId(undefined);
    if (!window.matchMedia("(min-width: 1024px)").matches) setSidebarOpen(false);
  }, [suspendThreadRecovery]);

  useEffect(() => {
    // Navigation can happen through routing or host state, not only the
    // sidebar callback. Enforce the same single-visible-thread ownership for
    // every path and stop stale recovery workers before they accumulate.
    for (const [threadId, controller] of recoveryControllers.current) {
      if (threadId === activeThreadId) continue;
      controller.abort();
      recoveryStarted.current.delete(threadId);
      for (const key of runtimeChecksStarted.current) {
        if (key.startsWith(`${threadId}|`)) runtimeChecksStarted.current.delete(key);
      }
    }
    setRecoveringIds((current) => {
      const next = new Set([...current].filter((threadId) => threadId === activeThreadId));
      return next.size === current.size ? current : next;
    });
  }, [activeThreadId]);

  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? threads[0];
  activeSessionScopeRef.current = activeThread?.session.sessionId;
  const visibleThreads = threads.filter((thread) => !ephemeralThreadIds.has(thread.id));
  const publicationRefreshKey = activeThread ? latestPublicationResultKey(activeThread.events) : undefined;
  const projectedSubagentActivityKey = activeThread
    ? mergeSubagentSessions(activeThread.events, [])
        .map((child) => `${child.childSessionId ?? ""}:${child.status}`)
        .sort()
        .join("|")
    : "";
  const durableSubagentActivityKey = durableSubagents
    .map((child) => `${child.childSessionId}:${child.status}`)
    .sort()
    .join("|");

  useEffect(() => {
    let cancelled = false;
    const sessionId = activeThread?.session.sessionId;
    const projectedSubagents = activeThread
      ? mergeSubagentSessions(activeThread.events, durableSubagents)
      : [];
    const hasActiveProjectedSubagent = projectedSubagents.some((child) =>
      child.status === "starting" || child.status === "running" || child.status === "waiting",
    );
    if (!loadSubagents || !sessionId || !hasActiveProjectedSubagent) {
      setDurableSubagents([]);
      return;
    }
    let inFlight = false;
    const refresh = async () => {
      if (cancelled || inFlight || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      inFlight = true;
      try {
        const next = await loadSubagents(sessionId);
        if (!cancelled) setDurableSubagents(next);
      } catch {
        // Parent events remain useful while the control-plane endpoint is
        // unavailable; the next interval or navigation retries the read.
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeThread?.session.sessionId, durableSubagentActivityKey, loadSubagents, projectedSubagentActivityKey]);

  const refreshAssets = useCallback(() => {
    const sessionId = activeThread?.session.sessionId;
    if (!sessionId) {
      setSessionAssets([]);
      setAssetsError(undefined);
      return;
    }
    const controller = new AbortController();
    setAssetsLoading(true);
    setAssetsError(undefined);
    void (async () => {
      try {
        const configuredHeaders = typeof client?.headers === "function" ? await client.headers() : client?.headers;
        const headers = client?.auth && "bearer" in client.auth
          ? {
            ...(configuredHeaders ?? {}),
            authorization: `Bearer ${typeof client.auth.bearer === "function" ? await client.auth.bearer() : client.auth.bearer}`,
          }
          : configuredHeaders;
        const base = client?.host || (typeof window !== "undefined" ? window.location.origin : "http://localhost");
        const endpoint = resolveSessionAssetEndpoint(assetEndpoint ?? "/api/assets", sessionId);
        const endpointUrl = new URL(endpoint, base);
        if (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") throw new Error("The asset endpoint must use HTTP(S).");
        const response = await fetch(endpointUrl, {
          credentials: "include",
          headers,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Asset list failed (${response.status}).`);
        const body: unknown = await response.json();
        if (activeSessionScopeRef.current === sessionId) setSessionAssets(parseSessionAssets(body));
      } catch (error) {
        if (!controller.signal.aborted) setAssetsError(error instanceof Error ? error.message : "The session assets could not be loaded.");
      } finally {
        if (!controller.signal.aborted) setAssetsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [activeThread?.session.sessionId, assetEndpoint, client]);

  const refreshDeliverables = useCallback(() => {
    const sessionId = activeThread?.session.sessionId;
    if (!sessionId) {
      setSessionDeliverables([]);
      setDeliverablesError(undefined);
      return;
    }
    const controller = new AbortController();
    setDeliverablesLoading(true);
    setDeliverablesError(undefined);
    void loadSessionDeliverables({ client, endpoint: deliverableEndpoint, sessionId, signal: controller.signal })
      .then((items) => {
        if (activeSessionScopeRef.current === sessionId) setSessionDeliverables(items);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setDeliverablesError(error instanceof Error ? error.message : "The session deliverables could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setDeliverablesLoading(false);
      });
    return () => controller.abort();
  }, [activeThread?.session.sessionId, client, deliverableEndpoint]);

  useEffect(() => {
    setActiveSubagentSessionId(undefined);
    setSecondaryTab("home");
    setSecondaryChildSessionId(undefined);
    setRequestedDeliverable(undefined);
    setSessionAssets([]);
    setSessionDeliverables([]);
    setAssetsError(undefined);
    setDeliverablesError(undefined);
  }, [activeThread?.id, activeThread?.session.sessionId]);

  useEffect(() => {
    if (!secondaryOpen || activeSubagentSessionId) return;
    const cleanups = [refreshAssets(), refreshDeliverables()];
    return () => {
      for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    };
  }, [activeSubagentSessionId, publicationRefreshKey, refreshAssets, refreshDeliverables, secondaryOpen]);

  useEffect(() => {
    if (!activeThread?.session.sessionId) setSecondaryOpen(false);
  }, [activeThread?.session.sessionId]);

  const openDeliverable = useCallback((deliverable: AgentSessionDeliverable) => {
    if (onOpenDeliverable) {
      onOpenDeliverable(deliverable);
      return;
    }
    deliverableRequestSequence.current += 1;
    setRequestedDeliverable({ deliverable, requestId: deliverableRequestSequence.current });
    setSecondaryOpen(true);
  }, [onOpenDeliverable]);
  const hydrateThread = useCallback((thread: AgentThread) => {
    if (
      thread.hydration !== "summary" ||
      (!threadStorage.loadThread && !threadStorage.loadThreadWindow) ||
      hydrationInFlight.current.has(thread.id)
    ) return;
    hydrationInFlight.current.add(thread.id);
    serverHydrationThreads.current.add(thread.id);
    setThreadHydrationErrors((current) => withoutMapKey(current, thread.id));
    setHydratingThreadIds((current) => new Set(current).add(thread.id));
    const loadHydratedThread = async (): Promise<{ readonly thread: AgentThread; readonly window?: AgentTranscriptWindow } | undefined> => {
      // Load the durable UI transcript first. Older checkpoints can have a
      // stale coverage marker even though their append-only event log is
      // complete. Repairing before this read would replay a potentially
      // hundreds-of-megabytes Eve stream on every page open.
      if (threadStorage.loadThreadWindow) {
        const windowed = await threadStorage.loadThreadWindow(storageKey, thread.id);
        if (!windowed) return undefined;
        const windowedThread = { ...windowed.thread, transcriptWindow: windowed.window };
        // A browser checkpoint can carry a non-authoritative coverage marker
        // even though the append-only event table still contains only a short
        // prefix (for example after an edit raced a refresh). A bounded window
        // is enough for ordinary viewing, but it is not safe for a future edit;
        // repair that settled legacy transcript once from Eve's finite stream
        // and persist an authoritative marker. Never run this for an active
        // session, where the live recovery path owns the stream.
        if (
          threadStorage.repairThread &&
          windowedThread.session.sessionId &&
          windowedThread.status !== "streaming" &&
          windowedThread.status !== "submitted" &&
          windowedThread.status !== "cancelling" &&
          !pendingTurnInFlight(windowedThread.pendingTurn) &&
          shouldRepairServerTranscript(windowedThread)
        ) {
          try {
            const repaired = await threadStorage.repairThread(storageKey, thread.id);
            if (repaired) return { thread: repaired };
          } catch (error) {
            // A session can become active again between the bounded read and
            // the repair probe. Keep the bounded history in that race; the
            // next settled open can retry without discarding visible events.
            if (!(error instanceof AgentThreadStorageHttpError) || error.status !== 409) throw error;
          }
        }
        return { thread: windowedThread, window: windowed.window };
      }
      if (!threadStorage.loadThread) return undefined;
      const hydrated = await threadStorage.loadThread(storageKey, thread.id);
      if (!hydrated) return undefined;
      if (
        threadStorage.repairThread &&
        hydrated.session.sessionId &&
        !hydrated.transcriptWindow &&
        !pendingTurnInFlight(hydrated.pendingTurn) &&
        shouldRepairServerTranscript(hydrated)
      ) {
        try {
          const repaired = await threadStorage.repairThread(storageKey, thread.id);
          if (repaired) return { thread: repaired };
        } catch (error) {
          if (!(error instanceof AgentThreadStorageHttpError) || error.status !== 409) throw error;
        }
      }
      return { thread: hydrated };
    };
    void loadHydratedThread()
      .then((loaded) => {
        if (!loaded) throw new Error("The selected Agent session no longer exists.");
        const hydrated = loaded.thread;
        const sanitizedEvents = compactThreadEvents(hydrated.events);
        const reconciledPendingTurn = reconcileHydratedPendingTurn(
          hydrated.pendingTurn,
          sanitizedEvents,
        );
        // A compact event array can be locally complete without proving that
        // it covers Eve's authoritative stream. Do not mint a verified marker
        // during hydration; only the finite server repair can do that.
        const healedCoverage = hydrated.transcriptCoverage?.complete === true
          ? hydrated.transcriptCoverage
          : undefined;
        const nextThread = sanitizedEvents.length === hydrated.events.length &&
          healedCoverage === hydrated.transcriptCoverage &&
          reconciledPendingTurn === hydrated.pendingTurn
          ? hydrated
          : {
              ...hydrated,
              events: sanitizedEvents,
              ...(reconciledPendingTurn ? { pendingTurn: reconciledPendingTurn } : {}),
              ...(!reconciledPendingTurn ? { pendingTurn: undefined } : {}),
              ...(healedCoverage ? { transcriptCoverage: healedCoverage } : {}),
              ...(loaded.window ? { transcriptWindow: loaded.window } : {}),
              updatedAt: Date.now(),
            };
        const withWindow = loaded.window && nextThread.transcriptWindow !== loaded.window
          ? { ...nextThread, transcriptWindow: loaded.window }
          : nextThread;
        setThreads((current) => {
          const next = current.map((candidate) => candidate.id === thread.id ? withWindow : candidate);
          threadsRef.current = next;
          return next;
        });
        void inspectThreadRuntime(withWindow);
      })
      .catch((error: unknown) => {
        onStorageError?.(error);
        setThreadHydrationErrors((current) => new Map(current).set(
          thread.id,
          error instanceof Error ? error.message : messages.recoveryFailed,
        ));
      })
      .finally(() => {
        hydrationInFlight.current.delete(thread.id);
        setHydratingThreadIds((current) => withoutSetValue(current, thread.id));
      });
  }, [inspectThreadRuntime, messages.recoveryFailed, onStorageError, storageKey, threadStorage]);

  const loadEarlierThreadEvents = useCallback(async (threadId: string) => {
    const current = threadsRef.current.find((candidate) => candidate.id === threadId);
    const window = current?.transcriptWindow;
    if (
      !current || !window?.hasMoreBefore || !threadStorage.loadThreadWindow ||
      historyWindowInFlight.current.has(threadId)
    ) return;
    historyWindowInFlight.current.add(threadId);
    setThreadHistoryLoading((value) => new Set(value).add(threadId));
    try {
      const loaded = await threadStorage.loadThreadWindow(storageKey, threadId, {
        before: window.startIndex,
      });
      if (!loaded) return;
      const latest = threadsRef.current.find((candidate) => candidate.id === threadId);
      if (!latest) return;
      const latestWindow = latest.transcriptWindow ?? window;
      const mergedEvents = compactThreadEvents([
        ...loaded.thread.events,
        ...latest.events,
      ]);
      updateThread(threadId, {
        events: mergedEvents,
        transcriptWindow: {
          endIndex: Math.max(latestWindow.endIndex, loaded.window.endIndex),
          hasMoreBefore: loaded.window.hasMoreBefore,
          startIndex: loaded.window.startIndex,
          total: Math.max(latestWindow.total, loaded.window.total),
        },
        // AgentThreadView seeds Eve's reducer from initialEvents once per
        // mount. Bump the hydration revision so the newly prepended page is
        // projected immediately instead of remaining invisible in the stale
        // external-store snapshot.
        revision: (latest.revision ?? 0) + 1,
        updatedAt: Date.now(),
      });
    } catch (error) {
      onStorageError?.(error);
    } finally {
      historyWindowInFlight.current.delete(threadId);
      setThreadHistoryLoading((value) => withoutSetValue(value, threadId));
    }
  }, [onStorageError, storageKey, threadStorage, updateThread]);

  useEffect(() => {
    if (
      !activeThread ||
      activeThread.hydration !== "summary" ||
      hydratingThreadIds.has(activeThread.id) ||
      threadHydrationErrors.has(activeThread.id)
    ) return;
    hydrateThread(activeThread);
  }, [activeThread, hydrateThread, hydratingThreadIds, threadHydrationErrors]);

  useEffect(() => {
    if (!isHydrated || !activeThread || activeThread.hydration === "summary") return;
    void inspectThreadRuntime(activeThread);
  }, [
    activeThread?.hydration,
    activeThread?.id,
    inspectThreadRuntime,
    isHydrated,
  ]);

  const activeSubagent = activeThread && activeSubagentSessionId
    ? findSubagentSession(activeThread.events, activeSubagentSessionId, locale, durableSubagents)
    : undefined;
  const openSubagent = useCallback((sessionId: string) => {
    if (!activeThread || !findSubagentSession(activeThread.events, sessionId, locale, durableSubagents)) return;
    setActiveSubagentSessionId(sessionId);
  }, [activeThread, locale]);
  const closeSubagent = useCallback(() => setActiveSubagentSessionId(undefined), []);
  const changeActiveThread = useCallback(
    (patch: AgentThreadPatch) => {
      if (!activeThreadId) return;
      updateThread(activeThreadId, patch);
    },
    [activeThreadId, updateThread],
  );
  const recoverActiveThread = useCallback(() => {
    if (activeThreadId) requestThreadRecovery(activeThreadId);
  }, [activeThreadId, requestThreadRecovery]);

  const recoverThread = useCallback(async (thread: AgentThread) => {
    if (!thread.session.sessionId || recoveryStarted.current.has(thread.id)) return;
    recoveryStarted.current.add(thread.id);
    setRecoveryErrors((current) => withoutMapKey(current, thread.id));
    const controller = new AbortController();
    recoveryControllers.current.set(thread.id, controller);
    // An edit recovery is a replacement of the current transcript branch. Do
    // not remount assistant-ui when its bounded catch-up completes; keeping
    // the existing runtime identity avoids replacing the thinking row twice.
    const editRecovery = thread.pendingTurn?.operation === "edit";
    // Recovery can be cancelled while the initial lifecycle probe is still
    // pending. Keep all exits idempotent and only release state owned by this
    // worker so a fast switch away/back cannot tear down its replacement.
    const releaseRecovery = () => {
      if (recoveryControllers.current.get(thread.id) !== controller) return false;
      recoveryStarted.current.delete(thread.id);
      recoveryControllers.current.delete(thread.id);
      setRecoveringIds((current) => withoutSetValue(current, thread.id));
      return true;
    };
    const events = [...thread.events];

    const recoveredCursor = thread.session.streamIndex;
    const connection = createAgentSession(client, thread.preferences, { ...thread.session, streamIndex: recoveredCursor });
    const session = attachAgentSession(connection, connection.initialSession);
    if (!session) {
      releaseRecovery();
      return;
    }
    let knownRuntimeBoundary: { readonly state: "waiting" | "terminal"; readonly failed?: boolean } | undefined;
    // A live follow stream is only safe after an authoritative Eve inspection
    // says that this session is running. A stale browser checkpoint or a
    // failed/unauthorized inspection must never be treated as proof of life:
    // doing so turns a completed session into an unbounded replay subscription.
    // Hosts that do not expose a lifecycle inspector therefore use bounded
    // catch-up only; they must provide an inspector to opt into live follow.
    // Never assume a recovered session is still running. Without an
    // inspector we can only perform bounded catch-up reads; opening `follow:
    // true` from a stale checkpoint would leave a finished session subscribed
    // forever and is the same failure mode as the historical infinite replay.
    let runtimeBoundaryState: "unknown" | "running" | "waiting" | "terminal" = "unknown";
    let runtimeTailIndex: number | undefined;
    let followIdleTimeouts = 0;
    // A browser checkpoint can remain "submitted" after Eve has already
    // parked or retired the run. Probe the authoritative lifecycle before
    // opening a live follow stream; completed runs must never be replayed.
    if (inspectSession) {
      try {
        const boundary = await inspectSession(session.state.sessionId);
        if (activeThreadIdRef.current !== thread.id || controller.signal.aborted) {
          releaseRecovery();
          return;
        }
        runtimeBoundaryState = boundary.state;
        runtimeTailIndex = boundary.tailIndex;
        if (boundary.state === "waiting" || boundary.state === "terminal") {
          // A settled runtime is history, never a recovery stream. Publish
          // the settled lifecycle first, then read only a small tail window to
          // recover a missing turn boundary or final tool result.
          await settleThreadHistory(thread, boundary, editRecovery);
          releaseRecovery();
          return;
        }
      } catch {
        // A transient probe failure must not discard a valid long-running turn.
        // Continue with the bounded stream policy below.
      }
    }
    const refreshRuntimeBoundary = async (): Promise<typeof runtimeBoundaryState | undefined> => {
      if (!inspectSession || activeThreadIdRef.current !== thread.id || controller.signal.aborted) return undefined;
      try {
        const boundary = await inspectSession(session.state.sessionId);
        if (activeThreadIdRef.current !== thread.id || controller.signal.aborted) return undefined;
        runtimeBoundaryState = boundary.state;
        runtimeTailIndex = boundary.tailIndex;
        if (boundary.state === "waiting" || boundary.state === "terminal") {
          knownRuntimeBoundary = {
            state: boundary.state,
            ...(boundary.terminalStatus === "failed" ? { failed: true } : {}),
          };
          runtimeBoundaryReady = false;
        }
        return runtimeBoundaryState;
      } catch {
        // Fail closed. The recovery loop can retry a bounded read, but it must
        // not open a live follow stream without an explicit running boundary.
        runtimeBoundaryState = "unknown";
        return undefined;
      }
    };
    const recoveryStartCursor = recoveredCursor;
    let cursor = recoveryStartCursor;
    let persistedCursor = recoveryStartCursor;
    const eventIds = new Set(events.map(eventIdentity));
    let recoverySnapshotDirty = false;
    let recoveryEventsSinceFlush = 0;
    let lastRecoveryFlushAt = Date.now();
    let checkedTailBoundary = false;
    let needsBoundedCatchUp = true;
    let reconnectAttempt = 0;
    let runtimeBoundaryReady = false;
    // A refresh can happen after Eve has durably accepted the submitted turn,
    // but before the browser checkpoint that clears `pendingTurn` is written.
    // Reconcile that admission from the persisted message log before opening
    // the recovery stream; otherwise the recovered session remains visually
    // stuck on Stop even after `session.waiting` has arrived.
    const originalPendingTurnId = thread.pendingTurn?.id;
    let pendingTurn = reconcilePendingTurnWithEvents(thread.pendingTurn, events);
    let queuedTurns = thread.queuedTurns;
    let interruptedTurns = thread.interruptedTurns ?? [];
    let cancellationPending = thread.status === "cancelling";
    const committedCatchUpTurns = new Map(
      queuedTurns
        .filter((turn) =>
          turn.delivery === "server" && turn.state === "committed" &&
          !mailboxMessageWasObserved(events, turn)
        )
        .map((turn) => [turn.id, turn]),
    );
    const recoveryOwnedQueuedTurnIds = new Set(queuedTurns.map((turn) => turn.id));
    const consumedQueuedTurnIds = new Set<string>();
    const recoveryOwnedPendingTurnId = originalPendingTurnId;
    // If the acceptance is already present in the persisted event prefix,
    // prevent the live browser snapshot (which may still contain the stale
    // pending admission) from reintroducing it during recovery merges.
    const consumedPendingTurnIds = new Set<string>(
      !pendingTurn && originalPendingTurnId ? [originalPendingTurnId] : [],
    );
    let settled = false;
    const currentClosedInputRequestIds = () => new Set(
      threadsRef.current.find((candidate) => candidate.id === thread.id)?.closedInputRequestIds ?? thread.closedInputRequestIds,
    );

    const mergeLiveAdmissions = () => {
      const liveThread = threadsRef.current.find((candidate) => candidate.id === thread.id);
      if (!liveThread) return;

      if (!sameInterruptedTurns(interruptedTurns, liveThread.interruptedTurns ?? [])) {
        interruptedTurns = liveThread.interruptedTurns ?? [];
      }

      const liveQueuedTurnIds = new Set(liveThread.queuedTurns.map((turn) => turn.id));
      queuedTurns = queuedTurns.filter((turn) =>
        !consumedQueuedTurnIds.has(turn.id) &&
        (recoveryOwnedQueuedTurnIds.has(turn.id) || liveQueuedTurnIds.has(turn.id))
      );
      const localQueuedTurnIds = new Set(queuedTurns.map((turn) => turn.id));
      for (const turn of liveThread.queuedTurns) {
        if (
          !localQueuedTurnIds.has(turn.id) &&
          !consumedQueuedTurnIds.has(turn.id)
        ) {
          queuedTurns = [...queuedTurns, turn];
          localQueuedTurnIds.add(turn.id);
        }
      }

      const livePendingTurn = reconcilePendingTurnWithEvents(liveThread.pendingTurn, events);
      if (liveThread.pendingTurn && !livePendingTurn) {
        // The live React snapshot can lag the durable event prefix by one
        // checkpoint. Do not resurrect an admission that Eve already
        // acknowledged while this recovery loop was running.
        consumedPendingTurnIds.add(liveThread.pendingTurn.id);
        if (pendingTurn?.id === liveThread.pendingTurn.id) pendingTurn = undefined;
      }
      if (
        livePendingTurn &&
        livePendingTurn.id !== recoveryOwnedPendingTurnId &&
        !consumedPendingTurnIds.has(livePendingTurn.id)
      ) {
        pendingTurn = livePendingTurn;
      } else if (
        pendingTurn &&
        pendingTurn.id !== recoveryOwnedPendingTurnId &&
        (!livePendingTurn || consumedPendingTurnIds.has(pendingTurn.id))
      ) {
        pendingTurn = undefined;
      }
    };
    const refreshMailboxQueue = async () => {
      mergeLiveAdmissions();
      if (!mailbox) return;
      const updates = new Map<string, AgentQueuedTurn["state"] | "remove">();
      await Promise.all(queuedTurns.map(async (turn) => {
        if (turn.delivery !== "server" || !turn.mailboxItemId) return;
        try {
          const receipt = await mailbox.inspect(turn.mailboxItemId);
          const state = mailboxQueueState(receipt.status);
          if (state === "committed") {
            if (!mailboxMessageWasObserved(events, turn)) committedCatchUpTurns.set(turn.id, turn);
            updates.set(turn.id, "remove");
          } else {
            updates.set(turn.id, state === "cancelled" ? "remove" : state);
          }
        } catch {
          // Keep the last durable UI snapshot during a transient mailbox outage.
        }
      }));
      if (updates.size === 0) return;
      const next = queuedTurns.flatMap((turn) => {
        const state = updates.get(turn.id);
        if (state === "remove") return [];
        return state ? [{ ...turn, state }] : [turn];
      });
      if (sameQueuedTurns(queuedTurns, next)) return;
      queuedTurns = next;
      updateThread(thread.id, { queuedTurns });
    };
    const hasPendingServerQueue = () => queuedTurns.some((turn) =>
      turn.delivery === "server" && mailboxTurnAwaitsAdmission(turn) && Boolean(turn.mailboxItemId),
    );
    const currentBoundarySettles = () => {
      // A durable edit is admitted against the previous settled turn. The
      // old transcript commonly ends in `session.waiting`; that boundary
      // must not short-circuit recovery before the replacement turn's
      // message.received and completion events arrive.
      if (pendingTurn?.operation === "edit" && isPendingMailboxEdit(pendingTurn)) return false;
      const last = events.at(-1);
      if (knownRuntimeBoundary && runtimeBoundaryReady) {
        if (committedCatchUpTurns.size > 0 || hasPendingServerQueue()) return false;
        // The runtime inspection is authoritative only for an explicit
        // settled state. A boolean readiness marker alone must never unlock
        // the composer after a turn.completed event while Eve is still
        // deciding whether to park the session.
        return knownRuntimeBoundary.state === "waiting" || knownRuntimeBoundary.state === "terminal";
      }
      if (!last || !isRecoveryBoundary(last)) return false;
      if (committedCatchUpTurns.size > 0 || hasPendingServerQueue()) return false;
      // A turn boundary closes one model turn, not the durable session. Eve can
      // still be committing tool output, parking the session, or admitting a
      // queued message. Only session.waiting/session terminal (or the matching
      // authoritative inspection above) is a recovery-safe handoff boundary.
      return last.type === "session.waiting" ||
        last.type === "session.completed" ||
        last.type === "session.failed";
    };
    const recoveryStatus = () => {
      const status = statusFromEvents(events, currentClosedInputRequestIds());
      const last = events.at(-1);
      // `turn.completed` closes one model turn, not the durable Eve session.
      // Keep the composer in the running state until session.waiting (or a
      // terminal session boundary) is observed; otherwise a bounded catch-up
      // page can briefly unlock input and race the still-active run.
      if (
        status === "ready" &&
        runtimeBoundaryState !== "waiting" &&
        runtimeBoundaryState !== "terminal" &&
        last?.type === "turn.completed"
      ) return "streaming" as const;
      return status;
    };
    const flushRecoverySnapshot = (force = false) => {
      // A new recovery worker may have taken ownership after navigation back
      // to this thread. The old worker can finish its aborted iterator, but it
      // must not publish its stale snapshot over the newer worker's state.
      if (recoveryControllers.current.get(thread.id) !== controller) return;
      if (!force && !recoverySnapshotDirty && cursor === persistedCursor) return;
      persistedCursor = cursor;
      recoverySnapshotDirty = false;
      recoveryEventsSinceFlush = 0;
      lastRecoveryFlushAt = Date.now();
      updateThread(thread.id, {
        events: [...events],
        interruptedTurns,
        pendingTurn,
        queuedTurns,
        session: { ...session.state, streamIndex: persistedCursor },
        status: cancellationPending
          ? "cancelling"
          : recoveryStatus(),
      });
    };

    try {
      cursor = await reconcileRecoveryCursor(
        connection.client,
        session.state.sessionId,
        recoveryStartCursor,
        events,
        controller.signal,
      );
      while (!settled && !controller.signal.aborted) {
        try {
          await refreshMailboxQueue();
          if (currentBoundarySettles()) {
            settled = true;
            break;
          }
          let consumed = 0;
          // `follow:true` is a live subscription. It is valid only when the
          // runtime inspection explicitly observed a running session. When
          // inspection is unavailable, keep every request bounded and retry
          // the inspection instead of risking an infinite stream on a stale
          // or already-completed session.
          const follow = !needsBoundedCatchUp && runtimeBoundaryState === "running";
          needsBoundedCatchUp = false;
          let restartFollowFromDurableProgress = false;
          let followIdleTimedOut = false;
          const followController = follow ? new AbortController() : undefined;
          const catchUpController = follow ? undefined : new AbortController();
          const abortFollow = () => followController?.abort();
          const abortCatchUp = () => catchUpController?.abort();
          if (followController) controller.signal.addEventListener("abort", abortFollow, { once: true });
          if (catchUpController) controller.signal.addEventListener("abort", abortCatchUp, { once: true });
          const followWatchdog = followController
            ? watchRecoveryDurableProgress({
                client: connection.client,
                getCursor: () => cursor,
                onProgress: () => {
                  restartFollowFromDurableProgress = true;
                  followController.abort();
                },
                sessionId: session.state.sessionId,
                signal: followController.signal,
              })
            : undefined;
          const followIdleTimer = followController
            ? window.setTimeout(() => {
                followIdleTimedOut = true;
                followController.abort();
              }, RECOVERY_FOLLOW_IDLE_TIMEOUT_MS)
            : undefined;
          try {
            for await (const event of session.stream({
              follow,
              signal: followController?.signal ?? catchUpController?.signal ?? controller.signal,
              startIndex: cursor,
              ...(follow ? { streamReconnectPolicy: RECOVERY_STREAM_RECONNECT_POLICY } : {}),
            })) {
              // User submissions can land between any two events in one streamed
              // recovery response. Merge them before every event so an older
              // recovery snapshot can never erase a newly staged turn.
              mergeLiveAdmissions();
              if (cancellationPending && event.type === "turn.started") {
                interruptedTurns = retargetLatestInterruptedTurn(
                  interruptedTurns,
                  event.data.turnId,
                );
              }
              const suppressEvent = shouldSuppressInterruptedTurnStreamEvent(
                event,
                cursor,
                interruptedTurns,
              );
              if (!suppressEvent) {
                appendThreadEventIndexed(events, eventIds, event);
                recoveryEventsSinceFlush += 1;
              }
              cursor += 1;
              recoverySnapshotDirty = true;
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
                } else {
                  const committedTurn = [...committedCatchUpTurns.values()].find((turn) =>
                    turn.text.trim() === event.data.message.trim()
                  );
                  if (committedTurn) {
                    committedCatchUpTurns.delete(committedTurn.id);
                  } else if (
                    pendingTurn &&
                    (pendingTurn.eventCountAtSubmission === undefined ||
                      events.lastIndexOf(event) >= pendingTurn.eventCountAtSubmission) &&
                    pendingTurn.text.trim() === event.data.message.trim()
                  ) {
                    consumedPendingTurnIds.add(pendingTurn.id);
                    pendingTurn = undefined;
                  } else {
                    const nextBrowserTurn = queuedTurns.find((turn) =>
                      turn.delivery !== "server" && turn.text.trim() === event.data.message.trim()
                    );
                    if (nextBrowserTurn) {
                      consumedQueuedTurnIds.add(nextBrowserTurn.id);
                      queuedTurns = queuedTurns.filter((turn) => turn.id !== nextBrowserTurn.id);
                    }
                  }
                }
              }
              if (
                cancellationPending &&
                (event.type === "session.waiting" || event.type === "session.completed" || event.type === "session.failed")
              ) cancellationPending = false;
              if (
                recoveryEventsSinceFlush >= 32 ||
                Date.now() - lastRecoveryFlushAt >= 75
              ) flushRecoverySnapshot();
              // Durable boundaries are user-visible state transitions. Publish
              // them immediately even when the provider keeps the HTTP stream
              // open between events (notably during cancellation recovery).
              if (
                event.type === "turn.cancelled" ||
                event.type === "turn.completed" ||
                event.type === "turn.failed" ||
                event.type === "session.waiting" ||
                event.type === "session.completed" ||
                event.type === "session.failed"
              ) flushRecoverySnapshot(true);
              if (isRecoveryBoundary(event)) {
                flushRecoverySnapshot(true);
                await refreshMailboxQueue();
                settled = currentBoundarySettles();
                if (settled) break;
              }
            }
          } catch (error) {
            if (!restartFollowFromDurableProgress) throw error;
          } finally {
            if (followIdleTimer !== undefined) window.clearTimeout(followIdleTimer);
            controller.signal.removeEventListener("abort", abortFollow);
            controller.signal.removeEventListener("abort", abortCatchUp);
            followController?.abort();
            catchUpController?.abort();
            await followWatchdog;
            flushRecoverySnapshot();
          }
          // Cancellation or teardown can abort the finite stream after the
          // SDK has returned from the iterator. Do not run tail repair,
          // runtime inspection, or another reconnect pass after that point.
          if (controller.signal.aborted) return;
          if (restartFollowFromDurableProgress && !settled) {
            // The recovery connection itself stopped delivering while Eve's
            // durable log advanced. Catch up from the last UI-consumed cursor
            // before opening another follow stream.
            needsBoundedCatchUp = true;
            reconnectAttempt = 0;
            continue;
          }
          if (followIdleTimedOut && !settled && consumed === 0) {
            // A provider may legitimately spend several minutes before its
            // next durable event. Close this individual HTTP response, then
            // reopen from the same cursor; this keeps the connection bounded
            // without turning a slow but healthy task into a failed session.
            followIdleTimeouts += 1;
            if (followIdleTimeouts >= 3) {
              throw new Error("The Agent recovery stream made no progress after repeated bounded reconnects.");
            }
            needsBoundedCatchUp = true;
            reconnectAttempt = 0;
            continue;
          }
          if (consumed > 0) followIdleTimeouts = 0;
          // A finite catch-up page may end exactly at turn.completed while
          // Eve is still deciding whether to park the session. Re-check the
          // authoritative lifecycle before opening a live follow stream; this
          // also lets the next bounded page deliver session.waiting when it is
          // already present at the tail.
          if (
            !settled &&
            !follow &&
            runtimeBoundaryState === "running" &&
            consumed > 0 &&
            events.at(-1) &&
            (events.at(-1)!.type === "turn.completed" ||
              events.at(-1)!.type === "turn.failed" ||
              events.at(-1)!.type === "turn.cancelled")
          ) {
            runtimeBoundaryState = "unknown";
          }
          if (!settled && !follow && runtimeBoundaryState === "unknown") {
            const refreshedState = await refreshRuntimeBoundary();
            if (refreshedState === "running") {
              // The bounded page reached the current tail. The next loop may
              // follow only because Eve just confirmed the session is live.
              needsBoundedCatchUp = false;
              reconnectAttempt = 0;
              continue;
            }
            if (refreshedState === "waiting" || refreshedState === "terminal") {
              // Re-read from the authoritative tail in bounded pages so the
              // final boundary and delivery are projected before settling.
              needsBoundedCatchUp = true;
              reconnectAttempt = 0;
              continue;
            }
          }
          if (knownRuntimeBoundary) runtimeBoundaryReady = true;
          flushRecoverySnapshot();
          await refreshMailboxQueue();
          // A tail lookup repairs a persisted cursor that already moved past a
          // boundary missing from the UI history. It must only run after the
          // ordered range at `cursor` proves empty; otherwise a settled tail
          // would skip durable model/tool events that the UI has not seen yet.
          if (
            consumed === 0 &&
            !checkedTailBoundary &&
            events.length > 0 &&
            !isRecoveryBoundary(events.at(-1)!)
          ) {
            checkedTailBoundary = true;
            const missingBoundary = await readTailBoundary(session, cursor, controller.signal);
            if (missingBoundary) {
              appendThreadEventIndexed(events, eventIds, missingBoundary);
              recoverySnapshotDirty = true;
              if (
                cancellationPending &&
                (missingBoundary.type === "session.waiting" || missingBoundary.type === "session.completed" || missingBoundary.type === "session.failed")
              ) cancellationPending = false;
              await refreshMailboxQueue();
              flushRecoverySnapshot(true);
              settled = currentBoundarySettles();
            }
          }
          if (!settled && currentBoundarySettles()) settled = true;
          reconnectAttempt = consumed > 0 ? 0 : reconnectAttempt + 1;
          setRecoveryErrors((current) => withoutMapKey(current, thread.id));
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) return;
          if (!isRetryableRecoveryError(error)) throw error;
          reconnectAttempt += 1;
        }
        if (reconnectAttempt > MAX_RECOVERY_RECONNECT_ATTEMPTS) {
          throw new Error("The active Agent stream could not be reconnected after repeated transport failures.");
        }
        if (!settled && !controller.signal.aborted) {
          await waitForRecoveryRetry(controller.signal, reconnectAttempt);
        }
      }
      if (controller.signal.aborted) return;
      if (!settled) throw new Error("The active Agent stream ended before reaching a durable boundary.");
      if (recoveryControllers.current.get(thread.id) !== controller) return;
      mergeLiveAdmissions();
      const recoveryPatch: AgentThreadPatch = {
        events: compactThreadEvents(events),
        interruptedTurns,
        pendingTurn,
        queuedTurns,
        session: { ...session.state, streamIndex: cursor },
        status: cancellationPending
          ? "cancelling"
          : knownRuntimeBoundary?.failed
            ? "error"
            : recoveryStatus(),
      };
      // The mounted Eve reducer is seeded only once. A recovery worker may
      // consume a finite catch-up stream while the child remains mounted; if
      // we simply flip `isRecovering` back to false, the stale live reducer
      // would replace the freshly recovered transcript. Reseed exactly once
      // at the durable handoff so edited replies remain visible after the
      // recovery worker releases its stream.
      if (activeThreadIdRef.current === thread.id && events.length > thread.events.length && !editRecovery) {
        flushSync(() => {
          setThreadRuntimeSeeds((current) => {
            const seed = `recovery:${thread.session.sessionId}:${cursor}`;
            if (current.get(thread.id) === seed) return current;
            const next = new Map(current);
            next.set(thread.id, seed);
            return next;
          });
          updateThread(thread.id, recoveryPatch);
        });
      } else {
        updateThread(thread.id, recoveryPatch);
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      if (recoveryControllers.current.get(thread.id) !== controller) return;
      updateThread(thread.id, { status: "error", updatedAt: Date.now() });
      setRecoveryErrors((current) => new Map(current).set(thread.id, error instanceof Error ? error.message : messages.recoveryFailed));
      console.error("Agent session recovery failed", error);
    } finally {
      // A rapid switch away and back can replace this worker with a newer
      // controller for the same thread. The old worker must not clear the new
      // worker's ownership marker or make its stream look inactive.
      const ownsRecovery = recoveryControllers.current.get(thread.id) === controller;
      if (ownsRecovery) {
        releaseRecovery();
      }
    }
  }, [client, inspectSession, mailbox, messages.recoveryFailed, onEvent, settleThreadHistory, updateThread]);

  useEffect(() => () => {
    for (const controller of recoveryControllers.current.values()) controller.abort();
    recoveryControllers.current.clear();
    window.clearTimeout(storageSaveTimer.current);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    for (const thread of threads) {
      if (recoveringIds.has(thread.id)) void recoverThread(thread);
    }
  }, [isHydrated, recoverThread, recoveringIds, threads]);

  const activeIsRecovering = activeThread ? recoveringIds.has(activeThread.id) : false;
  const activeThreadRuntimeKey = activeThread
    // Recovery state is a render mode, not a reducer identity. Including the
    // transient `recovering` flag here remounted the thread once when recovery
    // started and again when it settled, producing visible edit flashes. The
    // durable seed is the only state that requires reseeding Eve's reducer.
    ? `${activeThread.id}:${activeThread.transcriptWindow?.startIndex ?? 0}:${threadRuntimeSeeds.get(activeThread.id) ?? "initial"}`
    : "none";
  const activeIsHydrating = activeThread?.hydration === "summary";
  if (!isHydrated || !activeThread) return <div className="flex h-dvh items-center justify-center bg-background text-muted-foreground">{messages.loading}</div>;

  const workbenchFullscreen = desktopLayout && workbenchMode === "fullscreen";
  const workbenchTransitioning = workbenchMode === "collapsing" || workbenchMode === "expanding";

  return (
    <div
      className="open-agent-ui relative h-dvh overflow-hidden bg-sidebar text-foreground"
      data-panel-resizing={panelResizing ? "true" : "false"}
      data-workbench-fullscreen={workbenchFullscreen ? "true" : "false"}
      data-workbench-mode={desktopLayout ? workbenchMode : "mobile"}
    >
      {!desktopLayout ? <AgentSidebar activeThreadId={activeThread.id} brand={productName} deletingThreadIds={deletingThreadIds} hostFooter={hostSlots?.sidebarFooter} locale={locale} messages={messages} onClose={() => setSidebarOpen(false)} onDelete={deleteThread} onNew={createThread} onRename={renameThread} onSelect={selectThread} onSettings={() => setSettingsOpen(true)} open={sidebarOpen} threads={visibleThreads} variant="mobile" /> : null}
      <ResizablePanelGroup
        className="h-full"
        onLayoutChanged={handleDesktopLayoutChanged}
        orientation="horizontal"
      >
        {desktopLayout ? (
          <ResizablePanel className="block" collapsedSize="0px" collapsible data-sidebar-panel defaultSize={`${SIDEBAR_DEFAULT_WIDTH}px`} id="agent-sidebar" maxSize={`${SIDEBAR_MAX_WIDTH}px`} minSize={`${SIDEBAR_MIN_WIDTH}px`} onResize={handleSidebarResize} panelRef={sidebarPanelRef}>
            <AgentSidebar activeThreadId={activeThread.id} brand={productName} deletingThreadIds={deletingThreadIds} hostFooter={hostSlots?.sidebarFooter} locale={locale} messages={messages} onClose={() => setSidebarOpen(false)} onDelete={deleteThread} onNew={createThread} onRename={renameThread} onSelect={selectThread} onSettings={() => setSettingsOpen(true)} open={sidebarOpen} threads={visibleThreads} variant="desktop" />
          </ResizablePanel>
        ) : null}
        {desktopLayout ? <ResizableHandle className="flex bg-transparent after:w-2" data-main-resize-handle disabled={workbenchMode !== "split"} onPointerDown={() => {
          if (workbenchMode === "split") setPanelResizing(true);
        }} /> : null}
        <ResizablePanel className="min-w-0 p-0" data-workbench-panel defaultSize="100%" id="agent-workbench" minSize="0px">
          <ResizablePanelGroup className="h-full" orientation="horizontal">
            <ResizablePanel className={cn("min-w-0", secondaryOpen && !desktopLayout && "hidden")} defaultSize={secondaryOpen && !desktopLayout ? "0%" : secondaryOpen ? "70%" : "100%"} id="agent-primary" minSize="0px">
      <section className="flex h-full min-w-0 flex-col overflow-hidden bg-card" data-slot="agent-workbench">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-3 lg:h-13 lg:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button aria-label={messages.openNavigation} className="lg:hidden" onClick={() => setSidebarOpen(true)} size="icon-sm" variant="ghost"><MenuIcon className="size-4" /></Button>
            <Button aria-label={messages.toggleNavigation} className="hidden lg:inline-flex" disabled={workbenchTransitioning} onClick={toggleDesktopSidebar} size="icon-sm" variant="ghost">{workbenchMode === "split" ? <PanelLeftCloseIcon className="size-4" /> : <PanelLeftIcon className="size-4" />}</Button>
            {activeSubagentSessionId ? (
              <Button aria-label={messages.backToTask} onClick={closeSubagent} size="icon-sm" variant="ghost">
                <ArrowLeftIcon className="size-4" />
              </Button>
            ) : null}
            <h2 className="truncate font-medium text-[15px]">
              {activeSubagentSessionId ? activeSubagent?.label ?? messages.subagentSession : activeThread.title}
            </h2>
          </div>
          <div className="flex items-center gap-1">
            <Button aria-label={secondaryOpen ? messages.closeSecondaryView : messages.openSecondaryView} onClick={() => setSecondaryOpen((open) => !open)} size="icon-sm" variant="ghost">
              <PanelRightIcon className="size-4" />
            </Button>
            <AgentSubagentMenu
              activeSessionId={activeSubagentSessionId}
            durableSessions={durableSubagents}
            events={activeThread.events}
            locale={locale}
            onControl={controlSubagent}
            onOpen={openSubagent}
            />
            {hostSlots?.threadHeaderEnd}
          </div>
        </header>
        {deletionIssue ? (
          <div className="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm" role="alert">
            <AlertCircleIcon className="size-4 shrink-0 text-destructive" />
            <p className="min-w-0 flex-1 text-foreground">{messages.deleteUnavailable}</p>
            <Button onClick={() => setDeletionIssue(false)} size="sm" variant="outline">{messages.dismiss}</Button>
          </div>
        ) : null}
        {runtimeStatus.provider !== "ready" ? (
          <div className="flex shrink-0 items-start gap-3 border-b border-amber-500/30 bg-amber-500/8 px-4 py-2.5 text-sm" role="status">
            <ServerOffIcon className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
            <p className="min-w-0 flex-1 text-foreground">{runtimeStatus.provider === "mock" ? messages.mockProvider : messages.providerUnconfigured}</p>
          </div>
        ) : null}
        {activeIsHydrating ? (
          <main className="flex min-h-0 flex-1 items-center justify-center bg-background px-6">
            {threadHydrationErrors.has(activeThread.id) ? (
              <div className="max-w-md text-center" role="alert">
                <AlertCircleIcon className="mx-auto size-5 text-destructive" />
                <p className="mt-3 text-sm text-muted-foreground">
                  {threadHydrationErrors.get(activeThread.id) ?? messages.recoveryFailed}
                </p>
                <Button className="mt-4" onClick={() => hydrateThread(activeThread)} size="sm" variant="outline">
                  {messages.retry}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground" role="status">{messages.loading}</p>
            )}
          </main>
        ) : activeSubagentSessionId ? (
          activeSubagent ? (
            <AgentChildSessionView
              client={client}
              commands={commands}
              locale={locale}
              mailbox={mailbox}
              mentions={mentions}
              models={models}
              onEvent={onEvent}
              onOpenDeliverable={openDeliverable}
              onOpenSubagent={openSubagent}
              onStorageError={onStorageError}
              preferences={activeThread.preferences}
              providerReady={runtimeStatus.provider !== "unconfigured"}
              reasoningLevels={reasoningLevels}
              sessionId={activeSubagentSessionId}
              storageKey={storageKey}
              threadStorage={threadStorage}
            />
          ) : (
            <UnavailableSubagentView locale={locale} onBack={closeSubagent} />
          )
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <AgentThreadView
              client={client}
              commands={commands}
              draftStorageKey={ephemeralThreadIds.has(activeThread.id)
                ? `${storageKey}:draft:new`
                : `${storageKey}:draft:${activeThread.id}`}
              isRecovering={activeIsRecovering}
              historyHasMore={activeThread.transcriptWindow?.hasMoreBefore === true}
              historyLoading={threadHistoryLoading.has(activeThread.id)}
              // Storage revisions are persistence concurrency tokens, not UI
              // generations. Remounting on every checkpoint used to abort an
              // in-flight edit clear/resubmit transaction and reset the
              // assistant-ui scroll state. Only a newly prepended history
              // window or a recovery-mode handoff requires reseeding Eve's
              // reducer from `initialEvents`.
              key={activeThreadRuntimeKey}
              locale={locale}
              mailbox={mailbox}
              mentions={mentions}
              models={models}
              onCancelRecovery={() => cancelThreadRecovery(activeThread.id)}
              onChange={changeActiveThread}
              onEvent={onEvent}
              onOpenDeliverable={openDeliverable}
              onOpenSubagent={openSubagent}
              onLoadEarlier={() => loadEarlierThreadEvents(activeThread.id)}
              onRetryRecovery={() => requestThreadRecovery(activeThread.id)}
              onRecoveryNeeded={recoverActiveThread}
              providerReady={runtimeStatus.provider !== "unconfigured"}
              recoveryError={recoveryErrors.get(activeThread.id)}
              reasoningLevels={reasoningLevels}
              thread={activeThread}
            />
          </div>
        )}
      </section>
            </ResizablePanel>
            {secondaryOpen ? (
              <>
                {desktopLayout ? <ResizableHandle className="flex bg-transparent after:w-2" data-secondary-resize-handle /> : null}
                <ResizablePanel className="min-w-0 border-l border-border/70" defaultSize={desktopLayout ? "30%" : "100%"} id="agent-secondary" maxSize={desktopLayout ? "50%" : "100%"} minSize={desktopLayout ? "260px" : "0px"}>
                  <AgentSecondaryView
                    key={`secondary:${activeThread?.id ?? "empty"}:${activeThread?.session.sessionId ?? "draft"}`}
                    assetUrl={client?.assetUrl}
                    assets={sessionAssets}
                    assetsError={assetsError}
                    assetsLoading={assetsLoading}
                    deliverables={deliverablesError ? undefined : sessionDeliverables}
                    deliverablesError={deliverablesError}
                    deliverablesLoading={deliverablesLoading}
                    children={activeThread ? subagentsForThread(activeThread.events, durableSubagents) : []}
                    childContent={secondaryChildSessionId && activeThread ? (
                      <AgentChildSessionView
                        client={client}
                        commands={commands}
                        locale={locale}
                        mailbox={mailbox}
                        mentions={mentions}
                        models={models}
                        onEvent={onEvent}
                        onOpenDeliverable={openDeliverable}
                        onOpenSubagent={openSubagent}
                        onStorageError={onStorageError}
                        preferences={activeThread.preferences}
                        providerReady={runtimeStatus.provider !== "unconfigured"}
                        reasoningLevels={reasoningLevels}
                        sessionId={secondaryChildSessionId}
                        storageKey={storageKey}
                        threadStorage={threadStorage}
                      />
                    ) : undefined}
                    locale={locale}
                    onClose={() => setSecondaryOpen(false)}
                    onOpenAsset={onOpenAsset ? (asset) => onOpenAsset(asset) : undefined}
                    onOpenDeliverable={onOpenDeliverable}
                    onOpenChild={(sessionId) => {
                      setSecondaryChildSessionId(sessionId);
                    }}
                    onRefreshAssets={refreshAssets}
                    onRefreshDeliverables={refreshDeliverables}
                    onSelectTab={setSecondaryTab}
                    requestedDeliverable={requestedDeliverable?.deliverable}
                    requestedDeliverableRequestId={requestedDeliverable?.requestId}
                    tab={secondaryTab}
                  />
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
      {workbenchFullscreen ? (
        <FloatingAgentSidebar
          activeThreadId={activeThread.id}
          brand={productName}
          deletingThreadIds={deletingThreadIds}
          hostFooter={hostSlots?.sidebarFooter}
          locale={locale}
          messages={messages}
          onDelete={deleteThread}
          onNew={createThread}
          onRename={renameThread}
          onSelect={selectThread}
          onSettings={() => setSettingsOpen(true)}
          threads={visibleThreads}
        />
      ) : null}
      <AgentSettingsDialog extensions={extensions} locale={locale} messages={messages} onLocaleChange={setLocale} onOpenChange={setSettingsOpen} open={settingsOpen} />
    </div>
  );
}

function FloatingAgentSidebar({
  activeThreadId,
  brand,
  deletingThreadIds,
  hostFooter,
  locale,
  messages,
  onDelete,
  onNew,
  onRename,
  onSelect,
  onSettings,
  threads,
}: {
  readonly activeThreadId: string | undefined;
  readonly brand: string;
  readonly deletingThreadIds: ReadonlySet<string>;
  readonly hostFooter?: React.ReactNode;
  readonly locale: AgentLocale;
  readonly messages: AgentMessages;
  readonly onDelete: (threadId: string) => void;
  readonly onNew: () => void;
  readonly onRename: (threadId: string, title: string) => void;
  readonly onSelect: (threadId: string) => void;
  readonly onSettings: () => void;
  readonly threads: readonly AgentThread[];
}) {
  const [open, setOpen] = useState(false);
  const [resizing, setResizing] = useState(false);
  const sidebarPanelRef = usePanelRef();

  useEffect(() => {
    if (!open) return;
    const closeWhenPointerLeaves = (event: PointerEvent) => {
      if (resizing) return;
      const sidebarWidth = sidebarPanelRef.current?.getSize().inPixels ?? FLOATING_SIDEBAR_DEFAULT_WIDTH;
      if (event.clientX > sidebarWidth + 8) setOpen(false);
    };
    window.addEventListener("pointermove", closeWhenPointerLeaves);
    return () => window.removeEventListener("pointermove", closeWhenPointerLeaves);
  }, [open, resizing, sidebarPanelRef]);

  return (
    <>
      {!open ? (
        <div
          aria-hidden
          className="fixed inset-y-0 left-0 z-50 w-3"
          data-floating-sidebar-trigger
          onMouseEnter={() => setOpen(true)}
        />
      ) : null}
      <div
        className="fixed inset-y-0 left-0 z-40"
        data-floating-sidebar
        data-open={open ? "true" : "false"}
        data-resizing={resizing ? "true" : "false"}
        onFocusCapture={() => setOpen(true)}
      >
      <ResizablePanelGroup
        className="h-full w-[min(420px,100vw)] pointer-events-none"
        data-floating-sidebar-group
        orientation="horizontal"
      >
        <ResizablePanel
          className="block min-w-0 pointer-events-auto"
          data-floating-sidebar-panel
          defaultSize={`${FLOATING_SIDEBAR_DEFAULT_WIDTH}px`}
          id="floating-agent-sidebar"
          maxSize={`${SIDEBAR_MAX_WIDTH}px`}
          minSize={`${SIDEBAR_MIN_WIDTH}px`}
          panelRef={sidebarPanelRef}
        >
          <div
            className="h-full min-w-0"
            onMouseEnter={() => setOpen(true)}
          >
            <AgentSidebar
              activeThreadId={activeThreadId}
              brand={brand}
              deletingThreadIds={deletingThreadIds}
              hostFooter={hostFooter}
              locale={locale}
              messages={messages}
              onClose={() => setOpen(false)}
              onDelete={onDelete}
              onNew={() => {
                onNew();
                setOpen(false);
              }}
              onRename={onRename}
              onSelect={(threadId) => {
                onSelect(threadId);
                setOpen(false);
              }}
              onSettings={() => {
                onSettings();
                setOpen(false);
              }}
              open={open}
              threads={threads}
              variant="floating"
            />
          </div>
        </ResizablePanel>
        <ResizableHandle
          className="pointer-events-auto flex bg-transparent after:w-2"
          data-floating-sidebar-handle
          onPointerDown={() => {
            setOpen(true);
            setResizing(true);
          }}
          onPointerUp={() => setResizing(false)}
        />
        <ResizablePanel
          aria-hidden
          className="pointer-events-none min-w-0 bg-transparent"
          data-floating-sidebar-spacer
          defaultSize={`${SIDEBAR_MAX_WIDTH - FLOATING_SIDEBAR_DEFAULT_WIDTH}px`}
          id="floating-agent-sidebar-spacer"
          minSize="0px"
        />
      </ResizablePanelGroup>
      </div>
    </>
  );
}

function findSubagentSession(
  events: readonly MessageStreamEvent[],
  sessionId: string,
  locale: AgentLocale,
  durable: readonly AgentSubagentSummary[] = [],
): { readonly label: string; readonly task?: string } | undefined {
  const sessions = mergeSubagentSessions(events, durable);
  const index = sessions.findIndex((candidate) => candidate.childSessionId === sessionId);
  const session = sessions[index];
  if (!session) return undefined;
  return {
    label: session.name && session.name !== "agent"
      ? session.name
      : locale === "zh-CN" ? `子代理 ${index + 1}` : `Sub-agent ${index + 1}`,
    ...(session.task ? { task: session.task } : {}),
  };
}

function subagentsForThread(events: readonly MessageStreamEvent[], durable: readonly AgentSubagentSummary[] = []): readonly AgentSecondaryChild[] {
  return mergeSubagentSessions(events, durable)
    .filter((session): session is typeof session & { readonly childSessionId: string } => Boolean(session.childSessionId))
    .map((session, index) => ({
      childSessionId: session.childSessionId,
      nickname: session.name && session.name !== "agent" ? session.name : `Sub-agent ${index + 1}`,
      status: session.status,
      ...(session.task ? { task: session.task } : {}),
    }));
}

function UnavailableSubagentView({
  locale,
  onBack,
}: {
  readonly locale: AgentLocale;
  readonly onBack: () => void;
}) {
  const messages = messagesFor(locale);
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center bg-background px-6">
      <div className="max-w-md text-center">
        <AlertCircleIcon className="mx-auto size-5 text-muted-foreground" />
        <p className="mt-3 text-sm text-muted-foreground">{messages.subagentUnavailable}</p>
        <Button className="mt-4" onClick={onBack} size="sm" variant="outline">
          <ArrowLeftIcon className="size-4" />
          {messages.backToTask}
        </Button>
      </div>
    </main>
  );
}

const RECOVERY_TAIL_LOOKUP_TIMEOUT_MS = 1_500;
const SETTLED_TAIL_EVENTS = 64;
const RECOVERY_CURSOR_OVERLAP_EVENTS = 256;
const RECOVERY_PROGRESS_PROBE_DELAY_MS = 10_000;
const RECOVERY_PROGRESS_PROBE_INTERVAL_MS = 10_000;
const RECOVERY_PROGRESS_PROBE_TIMEOUT_MS = 2_500;
// Recovery is a reconnect path, not a permanent browser subscription. A
// healthy active run emits durable events before this window expires; if it
// does not, release the HTTP connection and surface a retryable state.
const RECOVERY_FOLLOW_IDLE_TIMEOUT_MS = 90_000;
const MAX_RECOVERY_RECONNECT_ATTEMPTS = 6;
const RECOVERY_RETRY_BASE_DELAY_MS = 750;
const RECOVERY_RETRY_MAX_DELAY_MS = 15_000;
const RECOVERY_STREAM_RECONNECT_POLICY = {
  // Do not turn a missing session (404) into an endless recovery loop.
  retryableErrorStatuses: [408, 409, 425, 429, 500, 502, 503, 504],
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
} as const;

async function reconcileRecoveryCursor(
  client: Client,
  sessionId: string,
  recoveredCursor: number,
  events: readonly MessageStreamEvent[],
  signal: AbortSignal,
): Promise<number> {
  // An uncompressed transcript with one persisted UI event per consumed Eve
  // event already proves that its absolute cursor is coherent. Cursor repair
  // is only needed for legacy transport pollution, compacted transcripts, or
  // intentionally suppressed interrupted-turn events, where the absolute
  // cursor can be ahead of the visible event count.
  if (recoveredCursor <= events.length) return recoveredCursor;
  const lastObservedEventId = [...events].reverse().find((event) => event.meta.id)?.meta.id;
  if (!lastObservedEventId || recoveredCursor === 0) return recoveredCursor;

  const nearbyStart = Math.max(0, recoveredCursor - RECOVERY_CURSOR_OVERLAP_EVENTS);
  const starts = nearbyStart === 0 ? [0] : [nearbyStart, 0];
  for (const startIndex of starts) {
    const probe = client.sessions.attach(sessionId, { streamIndex: startIndex });
    const probeController = new AbortController();
    const abortProbe = () => probeController.abort();
    signal.addEventListener("abort", abortProbe, { once: true });
    let cursor = startIndex;
    try {
      for await (const event of probe.stream({
        follow: false,
        signal: probeController.signal,
        startIndex,
      })) {
        cursor += 1;
        if (event.meta.id === lastObservedEventId) return cursor;
        // This is only an event-id locator around a claimed cursor, never a
        // transcript loader or retention limit. Settled incomplete histories
        // are rebuilt server-side from the full authoritative stream.
        if (cursor - startIndex >= RECOVERY_CURSOR_OVERLAP_EVENTS) {
          probeController.abort();
          break;
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (probeController.signal.aborted || isAbortError(error)) continue;
      if (isRetryableRecoveryError(error)) return recoveredCursor;
      throw error;
    } finally {
      signal.removeEventListener("abort", abortProbe);
      probeController.abort();
    }
  }
  return recoveredCursor;
}

async function readTailBoundary(
  session: ClientSession,
  startIndex: number,
  parentSignal: AbortSignal,
): Promise<MessageStreamEvent | undefined> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(abort, RECOVERY_TAIL_LOOKUP_TIMEOUT_MS);
  try {
    for await (const event of session.stream({
      // `startIndex: -1` without `follow:false` is a live-follow request and
      // can remain open forever when the durable log has no new event. This
      // repair probe is historical data lookup, so it must always have a
      // finite tail and a non-negative cursor.
      follow: false,
      signal: controller.signal,
      startIndex: Math.max(0, startIndex),
      streamReconnectPolicy: { reconnect: false },
    })) {
      return isRecoveryBoundary(event) ? event : undefined;
    }
  } catch (error) {
    if (!controller.signal.aborted && !isAbortError(error)) throw error;
  } finally {
    window.clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
  return undefined;
}

/**
 * Read only the settled tail needed to repair a stale browser transcript.
 * This is deliberately a bounded, non-following read. A completed session
 * must never replay its entire history just because the UI missed its final
 * boundary event.
 */
async function readSettledTail(
  session: ClientSession,
  tailIndex: number,
  signal: AbortSignal,
): Promise<readonly MessageStreamEvent[]> {
  const startIndex = Math.max(0, tailIndex - SETTLED_TAIL_EVENTS + 1);
  const expectedEvents = Math.max(0, tailIndex - startIndex + 1);
  const events: MessageStreamEvent[] = [];
  for await (const event of session.stream({
    follow: false,
    signal,
    startIndex,
    streamReconnectPolicy: { reconnect: false },
  })) {
    events.push(event);
    // The SDK normally stops at Eve's declared tail. Keep this caller-side
    // guard as a second boundary so a proxy/runtime that leaves a bounded
    // response open cannot turn a settled-history read into a live stream.
    if (events.length >= expectedEvents) break;
  }
  return events;
}

/** Read every durable event in one known settled absolute range. */
async function readSettledRange(
  session: ClientSession,
  startIndex: number,
  tailIndex: number,
  signal: AbortSignal,
): Promise<readonly MessageStreamEvent[]> {
  const expectedEvents = Math.max(0, tailIndex - startIndex + 1);
  const events: MessageStreamEvent[] = [];
  if (expectedEvents === 0) return events;
  for await (const event of session.stream({
    follow: false,
    signal,
    startIndex,
    streamReconnectPolicy: { reconnect: false },
  })) {
    events.push(event);
    if (events.length >= expectedEvents) break;
  }
  return events;
}
async function watchRecoveryDurableProgress({
  client,
  getCursor,
  onProgress,
  sessionId,
  signal,
}: {
  readonly client: Client;
  readonly getCursor: () => number;
  readonly onProgress: () => void;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (!await waitForRecoveryProbe(signal, RECOVERY_PROGRESS_PROBE_DELAY_MS)) return;
  while (!signal.aborted) {
    const probedCursor = getCursor();
    const durableProgress = await hasRecoveryDurableProgress(
      client,
      sessionId,
      probedCursor,
      signal,
    );
    if (signal.aborted) return;
    if (durableProgress && getCursor() === probedCursor) {
      onProgress();
      return;
    }
    if (!await waitForRecoveryProbe(signal, RECOVERY_PROGRESS_PROBE_INTERVAL_MS)) return;
  }
}

async function hasRecoveryDurableProgress(
  client: Client,
  sessionId: string,
  startIndex: number,
  parentSignal: AbortSignal,
): Promise<boolean> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(abort, RECOVERY_PROGRESS_PROBE_TIMEOUT_MS);
  const probe = client.sessions.attach(sessionId, { streamIndex: startIndex });
  try {
    for await (const _event of probe.stream({
      follow: false,
      signal: controller.signal,
      startIndex,
    })) {
      return true;
    }
  } catch (error) {
    if (!controller.signal.aborted && !isRetryableRecoveryError(error)) {
      console.warn("Durable recovery progress probe failed", error);
    }
  } finally {
    window.clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
  return false;
}

function waitForRecoveryProbe(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (elapsed: boolean) => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve(elapsed);
    };
    const abort = () => finish(false);
    const timeout = window.setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function waitForRecoveryRetry(signal: AbortSignal, attempt: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const delay = Math.min(
      RECOVERY_RETRY_MAX_DELAY_MS,
      RECOVERY_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    );
    const timeout = window.setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function isRecoveryBoundary(event: MessageStreamEvent): boolean {
  return event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled" ||
    event.type === "session.waiting" ||
    event.type === "session.completed" ||
    event.type === "session.failed";
}

function statusFromEvents(
  events: readonly MessageStreamEvent[],
  closedInputRequestIds: ReadonlySet<string> = new Set(),
): AgentThread["status"] {
  const last = events.at(-1);
  if (!last) return "ready";
  if (last.type === "session.failed") return "error";
  const latestTurnBoundary = [...events].reverse().find((event) => event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled");
  if (latestTurnBoundary?.type === "turn.failed") return "error";
  // Eve accepts cancellation before the session is parked. Keep this distinct
  // from an active submitted turn so a message sent in that interval becomes
  // the next normal turn rather than mailbox steering.
  if (last.type === "turn.cancelled") return "cancelling";
  if (last.type === "session.waiting") {
    return hasUnresolvedInputRequests(events, closedInputRequestIds) ? "waiting" : "ready";
  }
  if (last.type === "session.completed") return "ready";
  if (latestTurnBoundary?.type === "turn.cancelled") return "cancelling";
  if (latestTurnBoundary?.type === "turn.completed") return "ready";
  if (last.type === "turn.started" || last.type === "step.started" || last.type === "message.appended" || last.type === "reasoning.appended") return "streaming";
  return "submitted";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRetryableRecoveryError(error: unknown): boolean {
  if (error instanceof ClientError) {
    return error.status === 0 || [408, 409, 425, 429, 500, 502, 503, 504].includes(error.status);
  }
  return error instanceof TypeError || (error instanceof Error && /fetch|network|socket|stream/i.test(error.message));
}

function validateWorkspaceCatalog(
  models: readonly AgentModelOption[],
  reasoningLevels: readonly string[],
  defaults: AgentThreadPreferences,
): void {
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

function normalizeThreadPreferences(
  thread: AgentThread,
  models: readonly AgentModelOption[],
  reasoningLevels: readonly string[],
  defaults: AgentThreadPreferences,
): AgentThread {
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

function withoutSetValue<T>(source: Set<T>, value: T): Set<T> {
  if (!source.has(value)) return source;
  const next = new Set(source);
  next.delete(value);
  return next;
}

function withoutMapKey<K, V>(source: Map<K, V>, key: K): Map<K, V> {
  if (!source.has(key)) return source;
  const next = new Map(source);
  next.delete(key);
  return next;
}

function pendingTurnInFlight(pendingTurn: AgentThread["pendingTurn"] | undefined): boolean {
  return pendingTurn?.state === "clearing" ||
    pendingTurn?.state === "resubmitting" ||
    pendingTurn?.state === "submitting";
}

function threadNeedsRecovery(thread: AgentThread): boolean {
  if (thread.hydration === "summary") return false;
  if (!thread.session.sessionId) return false;
  if (thread.queuedTurns.some((turn) =>
    (turn.delivery === "server" && mailboxTurnAwaitsAdmission(turn) && Boolean(turn.mailboxItemId)) ||
    (turn.delivery === "server" && turn.state === "committed" && Boolean(turn.mailboxItemId)) ||
    turn.intent === "post-cancellation"
  )) return true;
  const pendingTurnInFlight = thread.pendingTurn?.state === "clearing" ||
    thread.pendingTurn?.state === "resubmitting" ||
    thread.pendingTurn?.state === "submitting";
  // A durable session boundary is authoritative even when a compacted
  // transcript has a few non-lifecycle events after it. Reopening recovery in
  // that state turns a completed conversation into a replay subscription.
  if (!pendingTurnInFlight && thread.status !== "cancelling" && hasSettledSessionBoundaryForThread(thread.events)) {
    return false;
  }
  if (!pendingTurnInFlight && thread.status !== "streaming" && thread.status !== "submitted") {
    return thread.status === "cancelling";
  }
  const lastEvent = thread.events.at(-1);
  return !lastEvent || !isRecoveryBoundary(lastEvent);
}

function hasSettledSessionBoundaryForThread(events: readonly MessageStreamEvent[]): boolean {
  const latestTurnStart = events.findLastIndex((event) => event.type === "turn.started");
  const latestBoundary = events.findLastIndex((event) =>
    event.type === "session.waiting" ||
    event.type === "session.completed" ||
    event.type === "session.failed",
  );
  return latestBoundary > latestTurnStart;
}

function threadNeedsRuntimeInspection(thread: AgentThread): boolean {
  if (threadNeedsRecovery(thread)) return true;
  // A durable session boundary is a complete lifecycle decision for the
  // current transcript. Missing prefix coverage is a history-pagination
  // concern, not evidence that a settled session is still running. Probing
  // Eve again here only adds latency on refresh and can make a finished turn
  // look like it is replaying. Active admissions/queues/cancellation are
  // handled by `threadNeedsRecovery` above and must continue through the
  // runtime inspection path.
  if (
    hasSettledSessionBoundaryForThread(thread.events) &&
    !thread.pendingTurn &&
    thread.status !== "cancelling" &&
    !thread.queuedTurns.some((turn) => turn.intent === "post-cancellation")
  ) return false;
  // A bounded history window is expected for settled sessions. Its missing
  // prefix is a pagination concern, not evidence that Eve is still running;
  // probing it and invoking transcript repair would re-read the full stream
  // on every refresh. Active/cancelling states still require inspection.
  if (
    thread.transcriptWindow &&
    thread.status !== "streaming" &&
    thread.status !== "submitted" &&
    thread.status !== "cancelling" &&
    !thread.pendingTurn
  ) return false;
  if (!transcriptCoversSession(thread)) return true;
  return thread.pendingTurn?.state === "clearing" ||
    thread.pendingTurn?.state === "resubmitting" ||
    thread.pendingTurn?.state === "submitting";
}

/**
 * Runtime inspection is idempotent for one session/admission snapshot, but a
 * thread can later receive a new Eve session or a new pending admission. A
 * thread-id-only guard would incorrectly suppress that check after an earlier
 * settled inspection. Keep the key scoped to the state that can change the
 * decision to attach a recovery stream.
 */
function runtimeInspectionKey(thread: AgentThread): string {
  // Once message.received acknowledges an optimistic admission, clearing its
  // browser-only pending marker is not a new request generation. Keying the
  // inspection to that stale marker made a refresh discard the Eve tail result
  // exactly when the accepted edit began streaming its first text.
  const pending = reconcilePendingTurnWithEvents(thread.pendingTurn, thread.events);
  const queued = thread.queuedTurns
    .map((turn) => `${turn.id}:${turn.state}`)
    .join(",");
  return [
    thread.id,
    thread.session.sessionId ?? "",
    // submitted/streaming/ready are transient projections of the same durable
    // admission. AgentThreadView can normalize one of them while this
    // inspection is in flight; treating that render-only change as a new
    // generation discards the authoritative tail result and no dependency
    // schedules a replacement inspection. Cancellation is a distinct control
    // transaction and therefore keeps its own key.
    thread.status === "cancelling" ? "cancelling" : "",
    pending?.id ?? "",
    pending?.state ?? "",
    queued,
  ].join("|");
}

function isPendingMailboxEdit(turn: AgentPendingTurn): boolean {
  return turn.operation === "edit" &&
    (turn.state === "submitting" || turn.state === "clearing" || turn.state === "resubmitting");
}

function transcriptCoversSession(thread: AgentThread): boolean {
  return hasCompleteTranscriptCoverage(thread) || thread.session.streamIndex <= thread.events.length;
}

function shouldRepairServerTranscript(thread: AgentThread): boolean {
  // A browser coverage marker is an observation, not proof that the complete
  // Eve stream was read. Only the repair route writes `authoritative: true`.
  // This distinction prevents a stale 195-event snapshot with a 3799-event
  // cursor from being accepted as complete history.
  if (hasCompleteTranscriptCoverage(thread)) return false;
  if (thread.events.length === 0) return true;
  // Current Eve events carry stable IDs. Legacy host snapshots without IDs
  // cannot be mapped safely to an absolute cursor, so retain their settled
  // transcript and use the bounded tail path instead.
  return thread.events.some((event) =>
    typeof event.meta?.id === "string" && event.meta.id.length > 0,
  );
}

function hasCompleteTranscriptCoverage(thread: AgentThread, endIndex = thread.session.streamIndex): boolean {
  const coverage = thread.transcriptCoverage;
  // A browser checkpoint records the cursor it observed, but it may have
  // dropped the middle of the stream while React was remounting. Only the
  // server-side finite repair can prove that the compact transcript covers
  // every event from index zero. Treating a browser marker as authoritative
  // makes a completed session look healthy while silently hiding old tool
  // calls and turns on the next page load.
  const complete = coverage?.authoritative === true &&
    coverage.complete === true &&
    coverage.startIndex === 0 &&
    coverage.endIndex >= endIndex;
  if (!complete) return false;
  // Coverage written before logical edit projection can contain every Eve
  // event and still be the wrong visible branch. Migrate only transcripts
  // whose loaded window proves that they contain an edit boundary; unaffected
  // large sessions keep their existing O(1) hydration path.
  return coverage.projection === "logical-edits-v1" ||
    !thread.events.some((event) => event.type === "context.cleared");
}

function isEmptyDraftThread(thread: AgentThread): boolean {
  return thread.events.length === 0 &&
    thread.queuedTurns.length === 0 &&
    !thread.pendingTurn &&
    !thread.session.sessionId;
}

function sameQueuedTurns(
  left: readonly AgentQueuedTurn[],
  right: readonly AgentQueuedTurn[],
): boolean {
  return left.length === right.length && left.every((turn, index) => {
    const candidate = right[index];
    return candidate?.id === turn.id &&
      candidate.delivery === turn.delivery &&
      candidate.intent === turn.intent &&
      candidate.mailboxItemId === turn.mailboxItemId &&
      candidate.state === turn.state;
  });
}

function sameInterruptedTurns(
  left: readonly AgentInterruptedTurn[],
  right: readonly AgentInterruptedTurn[],
): boolean {
    return left.length === right.length && left.every((turn, index) => {
      const candidate = right[index];
      return candidate?.turnId === turn.turnId &&
      candidate.eventCount === turn.eventCount &&
      candidate.streamIndex === turn.streamIndex &&
      candidate.settled === turn.settled;
    });
}

function retargetLatestInterruptedTurn(
  turns: readonly AgentInterruptedTurn[],
  turnId: string,
): readonly AgentInterruptedTurn[] {
  const latest = turns.at(-1);
  if (!latest || latest.turnId === turnId) return turns;
  return [
    ...turns.slice(0, -1).filter((candidate) => candidate.turnId !== turnId),
    { ...latest, turnId },
  ];
}

function mailboxQueueState(
  status: import("./contracts.js").AgentMailboxItemStatus,
): AgentQueuedTurn["state"] | "cancelled" {
  if (status === "failed") return "delivery-failed";
  if (status === "submission-ambiguous") return "admission-ambiguous";
  if (status === "cancelled") return "cancelled";
  return status;
}

function mailboxTurnAwaitsAdmission(turn: AgentQueuedTurn): boolean {
  return turn.state === "queued" || turn.state === "delivering" ||
    turn.state === "accepted";
}

function mailboxMessageWasObserved(
  events: readonly import("eve/client").MessageStreamEvent[],
  turn: AgentQueuedTurn,
): boolean {
  return events.some((event) =>
    event.type === "message.received" &&
    event.data.message.trim() === turn.text.trim() &&
    Date.parse(event.meta.at) >= turn.submittedAt
  );
}

async function saveThreadCollectionWithConflictRecovery(
  storageKey: string,
  collection: AgentThreadCollection,
  storage: AgentThreadStorage,
): Promise<AgentThreadCollection> {
  let candidate = collection;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await storage.save(storageKey, candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof AgentThreadStorageConflictError) || attempt === 2) throw error;
      // The normal HTTP load is an index-only read. Merging that summary into
      // a local checkpoint would replace a complete remote transcript with an
      // empty `events` array on the next PATCH. Hydrate a bounded remote
      // window before resolving a revision conflict; the extra reads occur
      // only on a conflict and keep the append-only event log authoritative
      // without materializing every historical event.
      const remote = await loadConflictCollection(storageKey, storage);
      candidate = mergeThreadCollectionsForConflict(candidate, remote);
    }
  }
  return candidate;
}

async function loadConflictCollection(
  storageKey: string,
  storage: AgentThreadStorage,
): Promise<AgentThreadCollection> {
  const index = await storage.load(storageKey);
  if (!storage.loadThread && !storage.loadThreadWindow) return index;
  const threads: AgentThread[] = [];
  // Keep hydration sequential. createHttpAgentThreadStorage updates its
  // baseline after each single-thread read; parallel reads can race and leave
  // the baseline containing only the last hydrated thread, which makes the
  // next conflict PATCH look like a deletion of the others.
  for (const thread of index.threads) {
    if (thread.hydration !== "summary") {
      threads.push(thread);
      continue;
    }
    try {
      if (storage.loadThreadWindow) {
        threads.push((await storage.loadThreadWindow(storageKey, thread.id))?.thread ?? thread);
      } else {
        threads.push(await storage.loadThread!(storageKey, thread.id) ?? thread);
      }
    } catch {
      // Preserve the summary only when a single thread cannot be hydrated;
      // the conflict merge will prefer any complete local transcript over
      // this incomplete value instead of silently deleting history.
      threads.push(thread);
    }
  }
  return { ...index, threads };
}

function mergeVisibleThreads(
  current: readonly AgentThread[],
  persisted: readonly AgentThread[],
  ephemeralIds: ReadonlySet<string>,
): AgentThread[] {
  const ephemeral = current.filter((thread) => ephemeralIds.has(thread.id));
  const localPersisted = current.filter((thread) => !ephemeralIds.has(thread.id));
  const merged = mergeThreadCollectionsForConflict(
    { threads: localPersisted, version: AGENT_THREAD_STORAGE_VERSION },
    { threads: persisted, version: AGENT_THREAD_STORAGE_VERSION },
  ).threads;
  return [...ephemeral, ...merged];
}

function sameThreadCollection(
  left: AgentThreadCollection,
  right: AgentThreadCollection,
): boolean {
  return left.activeThreadId === right.activeThreadId &&
    left.threads.length === right.threads.length &&
    left.threads.every((thread, index) => {
      const candidate = right.threads[index];
      return candidate?.id === thread.id && candidate.updatedAt === thread.updatedAt;
    });
}

function isUrgentPersistenceChange(
  previous: AgentThreadCollection | undefined,
  next: AgentThreadCollection,
): boolean {
  if (!previous || previous.activeThreadId !== next.activeThreadId) return true;
  if (previous.threads.length !== next.threads.length) return true;
  const previousThreads = new Map(previous.threads.map((thread) => [thread.id, thread]));
  for (const thread of next.threads) {
    const prior = previousThreads.get(thread.id);
    if (!prior) return true;
    // Persist the first authoritative runtime event promptly. This closes the
    // refresh window between an accepted turn becoming visibly active and the
    // regular streamed checkpoint, without turning every token/event into an
    // urgent database write.
    if (prior.events.length === 0 && thread.events.length > 0) return true;
    if (
      prior.title !== thread.title ||
      prior.revision !== thread.revision ||
      prior.draftRestore?.id !== thread.draftRestore?.id ||
      prior.session.sessionId !== thread.session.sessionId ||
      prior.preferences.executionMode !== thread.preferences.executionMode ||
      prior.preferences.modelId !== thread.preferences.modelId ||
      prior.preferences.reasoning !== thread.preferences.reasoning ||
      !samePendingTurn(prior.pendingTurn, thread.pendingTurn) ||
      !sameQueuedTurns(prior.queuedTurns, thread.queuedTurns) ||
      !sameInterruptedTurns(prior.interruptedTurns ?? [], thread.interruptedTurns ?? []) ||
      !sameStringList(prior.closedInputRequestIds, thread.closedInputRequestIds) ||
      !sameStringList(prior.retainedContext ?? [], thread.retainedContext ?? [])
    ) return true;
    if (
      prior.status !== thread.status &&
      (thread.status === "cancelling" || thread.status === "error" ||
        thread.status === "ready" || thread.status === "waiting")
    ) return true;
    const lastEvent = thread.events.at(-1);
    const priorLastEvent = prior.events.at(-1);
    if (
      !samePersistenceEvent(lastEvent, priorLastEvent) &&
      lastEvent && isUrgentPersistenceEvent(lastEvent)
    ) return true;
  }
  return false;
}

function samePendingTurn(
  left: AgentThread["pendingTurn"],
  right: AgentThread["pendingTurn"],
): boolean {
  if (!left || !right) return left === right;
  return left.id === right.id &&
    left.operation === right.operation &&
    left.state === right.state &&
    left.eventCountAtSubmission === right.eventCountAtSubmission &&
    left.submittedAt === right.submittedAt &&
    left.text === right.text &&
    JSON.stringify(left.files ?? []) === JSON.stringify(right.files ?? []);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePersistenceEvent(
  left: MessageStreamEvent | undefined,
  right: MessageStreamEvent | undefined,
): boolean {
  if (!left || !right) return left === right;
  const leftId = left.meta.id;
  const rightId = right.meta.id;
  if (leftId || rightId) return leftId === rightId;
  // Eve sessions created before stream ids were introduced can still be
  // replayed. Compare the small lifecycle identity fields instead of treating
  // two id-less events as the same event and delaying terminal persistence.
  return JSON.stringify(persistenceEventKey(left)) === JSON.stringify(persistenceEventKey(right));
}

function persistenceEventKey(event: MessageStreamEvent): readonly unknown[] {
  const data = "data" in event && event.data && typeof event.data === "object"
    ? event.data as Record<string, unknown>
    : {};
  return [
    event.type,
    data.turnId,
    data.sequence,
    data.stepIndex,
    data.callId,
    data.requestId,
    data.message,
    data.wait,
    data.finishReason,
    data.status,
  ];
}

function isUrgentPersistenceEvent(event: MessageStreamEvent): boolean {
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

function resolveSessionAssetEndpoint(endpoint: AgentAssetEndpoint, sessionId: string): string {
  if (typeof endpoint === "function") return endpoint(sessionId);
  const encoded = encodeURIComponent(sessionId);
  if (endpoint.includes("{sessionId}")) return endpoint.replaceAll("{sessionId}", encoded);
  if (endpoint.includes(":sessionId")) return endpoint.replaceAll(":sessionId", encoded);
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}sessionId=${encoded}`;
}

function latestPublicationResultKey(events: readonly MessageStreamEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "action.result" || event.data.status !== "completed" || event.data.result.kind !== "tool-result") continue;
    const name = event.data.result.toolName.toLowerCase().replaceAll("-", "_");
    if (["publish_artifact", "artifact_publish", "publish_preview", "website_preview"].includes(name)) {
      return `${event.data.result.callId}:${index}`;
    }
  }
  return undefined;
}

function parseSessionAssets(payload: unknown): readonly AgentSessionAsset[] {
  const values = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.assets)
      ? payload.assets
      : [];
  const assets: AgentSessionAsset[] = [];
  for (const value of values.slice(0, 200)) {
    if (!isRecord(value)) continue;
    const assetId = boundedText(value.assetId, 512);
    const filename = boundedText(value.filename, 255);
    const mediaType = boundedText(value.mediaType, 128);
    const sizeBytes = typeof value.sizeBytes === "number" && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0 ? value.sizeBytes : undefined;
    if (!assetId || !filename || !mediaType || sizeBytes === undefined) continue;
    assets.push({
      assetId,
      ...(boundedText(value.createdAt, 64) ? { createdAt: boundedText(value.createdAt, 64) } : {}),
      ...(safeAssetUrl(value.downloadUrl) ? { downloadUrl: safeAssetUrl(value.downloadUrl) } : {}),
      filename,
      mediaType,
      ...(safeAssetUrl(value.previewUrl) ? { previewUrl: safeAssetUrl(value.previewUrl) } : {}),
      sizeBytes,
      ...(safeAssetUrl(value.url) ? { url: safeAssetUrl(value.url) } : {}),
    });
  }
  return assets;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength ? value.trim() : undefined;
}

function safeAssetUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return undefined;
  if (value.startsWith("/")) return value;
  try {
    const parsed = new URL(value, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function loadLocale(storageKey: string): AgentLocale {
  const stored = window.localStorage.getItem(`${storageKey}:locale`);
  return stored === "en" || stored === "zh-CN" ? stored : resolveBrowserLocale();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
