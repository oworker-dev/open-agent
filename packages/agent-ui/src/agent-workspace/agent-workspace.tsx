"use client";

import { ClientError, type Client, type ClientSession, type MessageStreamEvent } from "eve/client";
import { AlertCircleIcon, ArrowLeftIcon, MenuIcon, PanelLeftCloseIcon, PanelLeftIcon, PanelRightIcon, ServerOffIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { AgentAssetEndpoint, AgentDeliverableEndpoint, AgentInterruptedTurn, AgentModelOption, AgentQueuedTurn, AgentSessionAsset, AgentSessionDeliverable, AgentSubagentController, AgentSubagentLoader, AgentSubagentSummary, AgentThread, AgentThreadPatch, AgentThreadPreferences, AgentWorkspaceClientConfig, AgentWorkspaceMailbox } from "./contracts.js";
import { AgentThreadStorageConflictError } from "./http-thread-storage.js";
import { messagesFor, resolveBrowserLocale, type AgentLocale, type AgentMessages } from "./i18n.js";
import {
  AGENT_THREAD_STORAGE_VERSION,
  browserThreadStorage,
  appendThreadEvent,
  compactThreadEvents,
  createAgentThread,
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
  const [activeSubagentSessionId, setActiveSubagentSessionId] = useState<string>();
  const [isHydrated, setIsHydrated] = useState(false);
  const [recoveringIds, setRecoveringIds] = useState<Set<string>>(new Set());
  const [recoveryErrors, setRecoveryErrors] = useState<Map<string, string>>(new Map());
  const [hydratingThreadIds, setHydratingThreadIds] = useState<Set<string>>(new Set());
  const [threadHydrationErrors, setThreadHydrationErrors] = useState<Map<string, string>>(new Map());
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

        const busyThreads = restoredThreads.filter(threadNeedsRecovery);
        if (busyThreads.length > 0) {
          setRecoveringIds(new Set(busyThreads.map((thread) => thread.id)));
        }
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

  const selectThread = useCallback((threadId: string) => {
    setActiveThreadId(threadId);
    setActiveSubagentSessionId(undefined);
    if (!window.matchMedia("(min-width: 1024px)").matches) setSidebarOpen(false);
    const selected = threads.find((thread) => thread.id === threadId);
    if (selected && threadNeedsRecovery(selected)) {
      setRecoveringIds((current) => new Set(current).add(threadId));
    }
  }, [threads]);

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
    recoveryControllers.current.get(threadId)?.abort();
    setRecoveringIds((current) => withoutSetValue(current, threadId));
  }, []);

  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? threads[0];
  const publicationRefreshKey = activeThread ? latestPublicationResultKey(activeThread.events) : undefined;

  useEffect(() => {
    let cancelled = false;
    const sessionId = activeThread?.session.sessionId;
    if (!loadSubagents || !sessionId) {
      setDurableSubagents([]);
      return;
    }
    const refresh = async () => {
      try {
        const next = await loadSubagents(sessionId);
        if (!cancelled) setDurableSubagents(next);
      } catch {
        // Parent events remain useful while the control-plane endpoint is
        // unavailable; the next interval or navigation retries the read.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeThread?.session.sessionId, loadSubagents]);

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
        setSessionAssets(parseSessionAssets(body));
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
      .then((items) => setSessionDeliverables(items))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setDeliverablesError(error instanceof Error ? error.message : "The session deliverables could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setDeliverablesLoading(false);
      });
    return () => controller.abort();
  }, [activeThread?.session.sessionId, client, deliverableEndpoint]);

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
    if (thread.hydration !== "summary" || !threadStorage.loadThread) return;
    setThreadHydrationErrors((current) => withoutMapKey(current, thread.id));
    setHydratingThreadIds((current) => new Set(current).add(thread.id));
    void Promise.resolve(threadStorage.loadThread(storageKey, thread.id))
      .then((hydrated) => {
        if (!hydrated) throw new Error("The selected Agent session no longer exists.");
        setThreads((current) => {
          const next = current.map((candidate) => candidate.id === thread.id ? hydrated : candidate);
          threadsRef.current = next;
          return next;
        });
        if (threadNeedsRecovery(hydrated)) {
          setRecoveringIds((current) => new Set(current).add(thread.id));
        }
      })
      .catch((error: unknown) => {
        onStorageError?.(error);
        setThreadHydrationErrors((current) => new Map(current).set(
          thread.id,
          error instanceof Error ? error.message : messages.recoveryFailed,
        ));
      })
      .finally(() => setHydratingThreadIds((current) => withoutSetValue(current, thread.id)));
  }, [messages.recoveryFailed, onStorageError, storageKey, threadStorage]);

  useEffect(() => {
    if (
      !activeThread ||
      activeThread.hydration !== "summary" ||
      hydratingThreadIds.has(activeThread.id) ||
      threadHydrationErrors.has(activeThread.id)
    ) return;
    hydrateThread(activeThread);
  }, [activeThread, hydrateThread, hydratingThreadIds, threadHydrationErrors]);

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
      if (activeThreadId) updateThread(activeThreadId, patch);
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
    const recoveryOwnedPendingTurnId = pendingTurn?.id;
    const consumedPendingTurnIds = new Set<string>();
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

      const livePendingTurn = liveThread.pendingTurn;
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
      const last = events.at(-1);
      if (!last || !isRecoveryBoundary(last)) return false;
      return committedCatchUpTurns.size === 0 &&
        (last.type !== "session.waiting" || !hasPendingServerQueue());
    };

    try {
      cursor = await reconcileRecoveryCursor(
        connection.client,
        session.state.sessionId,
        recoveredCursor,
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
          const follow = !needsBoundedCatchUp;
          needsBoundedCatchUp = false;
          let restartFollowFromDurableProgress = false;
          const followController = follow ? new AbortController() : undefined;
          const abortFollow = () => followController?.abort();
          if (followController) controller.signal.addEventListener("abort", abortFollow, { once: true });
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
          try {
            for await (const event of session.stream({
              follow,
              signal: followController?.signal ?? controller.signal,
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
              if (!suppressEvent) events = [...appendThreadEvent(events, event)];
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
                } else {
                  const committedTurn = [...committedCatchUpTurns.values()].find((turn) =>
                    turn.text.trim() === event.data.message.trim()
                  );
                  if (committedTurn) {
                    committedCatchUpTurns.delete(committedTurn.id);
                  } else if (pendingTurn) {
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
              updateThread(thread.id, {
                events: [...events],
                interruptedTurns,
                pendingTurn,
                queuedTurns,
                session: { ...session.state, streamIndex: cursor },
                status: cancellationPending
                  ? "cancelling"
                  : statusFromEvents(events, currentClosedInputRequestIds()),
              });
              if (isRecoveryBoundary(event)) {
                await refreshMailboxQueue();
                settled = currentBoundarySettles();
                break;
              }
            }
          } catch (error) {
            if (!restartFollowFromDurableProgress) throw error;
          } finally {
            controller.signal.removeEventListener("abort", abortFollow);
            followController?.abort();
            await followWatchdog;
          }
          if (restartFollowFromDurableProgress && !settled) {
            // The recovery connection itself stopped delivering while Eve's
            // durable log advanced. Catch up from the last UI-consumed cursor
            // before opening another follow stream.
            needsBoundedCatchUp = true;
            reconnectAttempt = 0;
            continue;
          }
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
            const missingBoundary = await readTailBoundary(session, controller.signal);
            if (missingBoundary) {
              events = [...appendThreadEvent(events, missingBoundary)];
              if (
                cancellationPending &&
                (missingBoundary.type === "session.waiting" || missingBoundary.type === "session.completed" || missingBoundary.type === "session.failed")
              ) cancellationPending = false;
              await refreshMailboxQueue();
              updateThread(thread.id, {
                events: [...events],
                interruptedTurns,
                pendingTurn,
                queuedTurns,
                session: { ...session.state, streamIndex: cursor },
                status: cancellationPending
                  ? "cancelling"
                  : statusFromEvents(events, currentClosedInputRequestIds()),
              });
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
      mergeLiveAdmissions();
      updateThread(thread.id, {
        events: compactThreadEvents(events),
        interruptedTurns,
        pendingTurn,
        queuedTurns,
        session: { ...session.state, streamIndex: cursor },
        status: cancellationPending
          ? "cancelling"
          : statusFromEvents(events, currentClosedInputRequestIds()),
      });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      updateThread(thread.id, { status: "error", updatedAt: Date.now() });
      setRecoveryErrors((current) => new Map(current).set(thread.id, error instanceof Error ? error.message : messages.recoveryFailed));
      console.error("Agent session recovery failed", error);
    } finally {
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
      {!desktopLayout ? <AgentSidebar activeThreadId={activeThread.id} brand={productName} deletingThreadIds={deletingThreadIds} hostFooter={hostSlots?.sidebarFooter} locale={locale} messages={messages} onClose={() => setSidebarOpen(false)} onDelete={deleteThread} onNew={createThread} onRename={renameThread} onSelect={selectThread} onSettings={() => setSettingsOpen(true)} open={sidebarOpen} threads={threads} variant="mobile" /> : null}
      <ResizablePanelGroup
        className="h-full"
        onLayoutChanged={handleDesktopLayoutChanged}
        orientation="horizontal"
      >
        {desktopLayout ? (
          <ResizablePanel className="block" collapsedSize="0px" collapsible data-sidebar-panel defaultSize={`${SIDEBAR_DEFAULT_WIDTH}px`} id="agent-sidebar" maxSize={`${SIDEBAR_MAX_WIDTH}px`} minSize={`${SIDEBAR_MIN_WIDTH}px`} onResize={handleSidebarResize} panelRef={sidebarPanelRef}>
            <AgentSidebar activeThreadId={activeThread.id} brand={productName} deletingThreadIds={deletingThreadIds} hostFooter={hostSlots?.sidebarFooter} locale={locale} messages={messages} onClose={() => setSidebarOpen(false)} onDelete={deleteThread} onNew={createThread} onRename={renameThread} onSelect={selectThread} onSettings={() => setSettingsOpen(true)} open={sidebarOpen} threads={threads} variant="desktop" />
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
              key={`${activeThread.id}:${activeThread.revision ?? 0}:${activeIsRecovering ? "recovering" : "ready"}`}
              locale={locale}
              mailbox={mailbox}
              mentions={mentions}
              models={models}
              onCancelRecovery={() => cancelThreadRecovery(activeThread.id)}
              onChange={changeActiveThread}
              onEvent={onEvent}
              onOpenDeliverable={openDeliverable}
              onOpenSubagent={openSubagent}
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
          threads={threads}
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
const RECOVERY_CURSOR_OVERLAP_EVENTS = 256;
const RECOVERY_PROGRESS_PROBE_DELAY_MS = 10_000;
const RECOVERY_PROGRESS_PROBE_INTERVAL_MS = 10_000;
const RECOVERY_PROGRESS_PROBE_TIMEOUT_MS = 2_500;
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
    let cursor = startIndex;
    try {
      for await (const event of probe.stream({
        follow: false,
        signal,
        startIndex,
      })) {
        cursor += 1;
        if (event.meta.id === lastObservedEventId) return cursor;
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      if (isRetryableRecoveryError(error)) return recoveredCursor;
      throw error;
    }
  }
  return recoveredCursor;
}

async function readTailBoundary(
  session: ClientSession,
  parentSignal: AbortSignal,
): Promise<MessageStreamEvent | undefined> {
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
  } catch (error) {
    if (!controller.signal.aborted && !isAbortError(error)) throw error;
  } finally {
    window.clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
  return undefined;
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
  return event.type === "session.waiting" || event.type === "session.completed" || event.type === "session.failed";
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
  if (last.type === "turn.started" || last.type === "step.started" || last.type === "message.appended" || last.type === "reasoning.appended") return "streaming";
  return "submitted";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRetryableRecoveryError(error: unknown): boolean {
  if (error instanceof ClientError) {
    return error.status === 0 || [404, 409, 425, 429, 500, 502, 503, 504].includes(error.status);
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
  if (!pendingTurnInFlight && thread.status !== "streaming" && thread.status !== "submitted") {
    return thread.status === "cancelling";
  }
  const lastEvent = thread.events.at(-1);
  return !lastEvent || !isRecoveryBoundary(lastEvent);
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
      candidate.streamIndex === turn.streamIndex;
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
      const remote = await storage.load(storageKey);
      candidate = mergeThreadCollections(candidate, remote);
    }
  }
  return candidate;
}

function mergeThreadCollections(
  local: AgentThreadCollection,
  remote: AgentThreadCollection,
): AgentThreadCollection {
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

function mergeThreads(
  preferred: readonly AgentThread[],
  fallback: readonly AgentThread[],
): AgentThread[] {
  const byId = new Map(fallback.map((thread) => [thread.id, thread]));
  for (const thread of preferred) {
    const existing = byId.get(thread.id);
    if (!existing || thread.updatedAt >= existing.updatedAt) byId.set(thread.id, thread);
  }
  return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

function mergeVisibleThreads(
  current: readonly AgentThread[],
  persisted: readonly AgentThread[],
  ephemeralIds: ReadonlySet<string>,
): AgentThread[] {
  const ephemeral = current.filter((thread) => ephemeralIds.has(thread.id));
  const localPersisted = current.filter((thread) => !ephemeralIds.has(thread.id));
  return [...ephemeral, ...mergeThreads(localPersisted, persisted)];
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
      lastEvent?.meta.id !== priorLastEvent?.meta.id &&
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
    left.state === right.state &&
    left.submittedAt === right.submittedAt &&
    left.text === right.text &&
    JSON.stringify(left.files ?? []) === JSON.stringify(right.files ?? []);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
