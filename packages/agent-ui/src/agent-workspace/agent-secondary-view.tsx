"use client";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileIcon,
  ImageIcon,
  MonitorIcon,
  PanelRightCloseIcon,
  RefreshCwIcon,
  UsersRoundIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { StaticMarkdownText } from "../assistant-ui/markdown-text.js";
import { WebPreview } from "../assistant-ui/web-preview.js";
import {
  Attachment,
  AttachmentAction,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "../ui/attachment.js";
import { Button } from "../ui/button.js";
import { cn } from "../utils.js";
import type { AgentSessionAsset, AgentSessionDeliverable } from "./contracts.js";
import type { AgentLocale } from "./i18n.js";
import { mergeSessionDeliverables } from "./session-deliverables.js";

export type AgentSecondaryTab = "home" | "children" | "assets" | "deliverables";
export type AgentSecondaryChild = {
  readonly childSessionId: string;
  readonly nickname: string;
  readonly status: string;
  readonly task?: string;
};

type AgentSecondaryContentTab = {
  readonly id: string;
  readonly kind: "child";
  readonly sessionId: string;
  readonly title: string;
} | {
  readonly deliverable: AgentSessionDeliverable;
  readonly id: string;
  readonly kind: "deliverable";
  readonly title: string;
};

export function AgentSecondaryView({
  assetUrl,
  assets = [],
  assetsError,
  assetsLoading = false,
  childContent,
  children,
  deliverables,
  deliverablesError,
  deliverablesLoading,
  locale,
  onClose,
  onOpenAsset,
  onOpenChild,
  onOpenDeliverable,
  onRefreshAssets,
  onRefreshDeliverables,
  onSelectTab,
  requestedDeliverable,
  requestedDeliverableRequestId,
  tab,
}: {
  readonly assetUrl?: (assetId: string) => string;
  readonly assets?: readonly AgentSessionAsset[];
  readonly assetsError?: string;
  readonly assetsLoading?: boolean;
  readonly childContent?: ReactNode;
  readonly children: readonly AgentSecondaryChild[];
  readonly deliverables?: readonly AgentSessionDeliverable[];
  readonly deliverablesError?: string;
  readonly deliverablesLoading?: boolean;
  readonly locale: AgentLocale;
  readonly onClose: () => void;
  readonly onOpenAsset?: (asset: AgentSessionAsset) => void;
  readonly onOpenChild: (sessionId: string) => void;
  readonly onOpenDeliverable?: (deliverable: AgentSessionDeliverable) => void;
  readonly onRefreshAssets?: () => void;
  readonly onRefreshDeliverables?: () => void;
  /** Legacy route callback retained for alpha SDK compatibility. */
  readonly onSelectTab?: (tab: AgentSecondaryTab) => void;
  readonly requestedDeliverable?: AgentSessionDeliverable;
  readonly requestedDeliverableRequestId?: number;
  /** Legacy initial route retained for alpha SDK compatibility. */
  readonly tab?: AgentSecondaryTab;
}) {
  const isZh = locale === "zh-CN";
  const mergedDeliverables = useMemo(
    () => mergeSessionDeliverables(deliverables, assets),
    [assets, deliverables],
  );
  const [overviewRoute, setOverviewRoute] = useState<AgentSecondaryTab>(normalizeOverviewRoute(tab));
  const [openTabs, setOpenTabs] = useState<readonly AgentSecondaryContentTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("home");
  const consumedDeliverableRequestId = useRef<number | undefined>(undefined);
  const activeTab = openTabs.find((candidate) => candidate.id === activeTabId);

  const selectOverviewRoute = useCallback((route: AgentSecondaryTab) => {
    const normalized = normalizeOverviewRoute(route);
    setOverviewRoute(normalized);
    setActiveTabId("home");
    onSelectTab?.(normalized);
  }, [onSelectTab]);

  const openChild = useCallback((child: AgentSecondaryChild) => {
    const contentTab: AgentSecondaryContentTab = {
      id: `child:${child.childSessionId}`,
      kind: "child",
      sessionId: child.childSessionId,
      title: child.nickname,
    };
    setOpenTabs((current) => upsertContentTab(current, contentTab));
    setActiveTabId(contentTab.id);
    onOpenChild(child.childSessionId);
  }, [onOpenChild]);

  const openDeliverable = useCallback((deliverable: AgentSessionDeliverable) => {
    if (onOpenDeliverable) {
      onOpenDeliverable(deliverable);
      return;
    }
    const contentTab: AgentSecondaryContentTab = {
      deliverable,
      id: `deliverable:${deliverable.kind}:${deliverable.id}`,
      kind: "deliverable",
      title: deliverable.title,
    };
    setOpenTabs((current) => upsertContentTab(current, contentTab));
    setActiveTabId(contentTab.id);
    if (deliverable.kind === "asset") {
      const asset = assets.find((candidate) => candidate.assetId === deliverable.id);
      if (asset) onOpenAsset?.(asset);
    }
  }, [assets, onOpenAsset, onOpenDeliverable]);

  useEffect(() => {
    if (!requestedDeliverable || requestedDeliverableRequestId === undefined) return;
    if (consumedDeliverableRequestId.current === requestedDeliverableRequestId) return;
    consumedDeliverableRequestId.current = requestedDeliverableRequestId;
    openDeliverable(requestedDeliverable);
  }, [openDeliverable, requestedDeliverable, requestedDeliverableRequestId]);

  const activateContentTab = (contentTab: AgentSecondaryContentTab) => {
    setActiveTabId(contentTab.id);
    if (contentTab.kind === "child") onOpenChild(contentTab.sessionId);
  };
  const closeContentTab = (contentTab: AgentSecondaryContentTab) => {
    setOpenTabs((current) => current.filter((candidate) => candidate.id !== contentTab.id));
    if (activeTabId === contentTab.id) setActiveTabId("home");
  };

  const refresh = onRefreshDeliverables ?? onRefreshAssets ?? (() => undefined);
  const loading = deliverablesLoading ?? assetsLoading;
  const error = deliverablesError ?? assetsError;
  const headerTitle = activeTab?.title ?? (overviewRoute === "children"
    ? (isZh ? "子代理" : "Sub-agents")
    : overviewRoute === "deliverables"
      ? (isZh ? "会话资产" : "Session assets")
      : (isZh ? "工作区" : "Workspace"));

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-background" data-agent-secondary-view>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        {activeTab || overviewRoute !== "home" ? (
          <Button
            aria-label={activeTab ? (isZh ? "返回列表" : "Back to list") : (isZh ? "返回概览" : "Back to overview")}
            onClick={() => selectOverviewRoute(activeTab?.kind === "child" ? "children" : activeTab?.kind === "deliverable" ? "deliverables" : "home")}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronLeftIcon className="size-4" />
          </Button>
        ) : null}
        {openTabs.length > 0 ? (
          <h2 className="sr-only">{headerTitle}</h2>
        ) : null}
        {openTabs.length > 0 ? (
          <SecondaryTabBar aria-label={isZh ? "已打开内容" : "Open content"}>
            {openTabs.map((contentTab) => (
              <div className={cn("group/tab flex w-40 shrink-0 items-center rounded-md", activeTabId === contentTab.id && "bg-accent")} key={contentTab.id}>
                <TabButton active={activeTabId === contentTab.id} label={contentTab.title} onClick={() => activateContentTab(contentTab)} />
                <button aria-label={`${isZh ? "关闭" : "Close"} ${contentTab.title}`} className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background/80 hover:text-foreground" onClick={() => closeContentTab(contentTab)} type="button">
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
          </SecondaryTabBar>
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{headerTitle}</h2>
        )}
        <Button aria-label={isZh ? "关闭副视图" : "Close side view"} onClick={onClose} size="icon-sm" variant="ghost">
          <PanelRightCloseIcon className="size-4" />
        </Button>
      </header>

      {activeTabId === "home" ? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {overviewRoute === "home" ? <Overview
              childCount={children.length}
              deliverableCount={mergedDeliverables.length}
              isZh={isZh}
              onChildren={() => selectOverviewRoute("children")}
              onDeliverables={() => selectOverviewRoute("deliverables")}
            /> : null}
            {overviewRoute === "children" ? <ChildList children={children} isZh={isZh} onOpen={openChild} /> : null}
            {overviewRoute === "deliverables" ? <DeliverableList
              assetUrl={assetUrl}
              deliverables={mergedDeliverables}
              error={error}
              isZh={isZh}
              loading={loading}
              onOpen={openDeliverable}
              onRefresh={refresh}
            /> : null}
          </div>
        </>
      ) : activeTab?.kind === "child" ? (
        <div className="flex min-h-0 flex-1 flex-col">{childContent ?? <EmptyState label={isZh ? "子代理会话不可用" : "Sub-agent session unavailable"} />}</div>
      ) : activeTab?.kind === "deliverable" ? (
        <DeliverablePreview assetUrl={assetUrl} deliverable={activeTab.deliverable} locale={locale} />
      ) : null}
    </aside>
  );
}

function Overview({ childCount, deliverableCount, isZh, onChildren, onDeliverables }: { readonly childCount: number; readonly deliverableCount: number; readonly isZh: boolean; readonly onChildren: () => void; readonly onDeliverables: () => void }) {
  return <div className="grid gap-2">
    <OverviewCard count={childCount} icon={<UsersRoundIcon className="size-4" />} label={isZh ? "子代理" : "Sub-agents"} onClick={onChildren} />
    <OverviewCard count={deliverableCount} icon={<FileIcon className="size-4" />} label={isZh ? "会话资产" : "Session assets"} onClick={onDeliverables} />
    <p className="px-1 pt-2 text-xs leading-5 text-muted-foreground">{isZh ? "子代理对话和 Agent 发布的文件、图片、网站会保留为会话级可访问引用。" : "Sub-agent conversations and Agent-published files, images, and websites remain accessible from this session."}</p>
  </div>;
}

function ChildList({ children, isZh, onOpen }: { readonly children: readonly AgentSecondaryChild[]; readonly isZh: boolean; readonly onOpen: (child: AgentSecondaryChild) => void }) {
  if (children.length === 0) return <EmptyState label={isZh ? "还没有子代理" : "No sub-agents yet"} />;
  return <div className="divide-y divide-border/50">{children.map((child) => (
    <button className="flex w-full items-center gap-3 px-1 py-3 text-left hover:bg-accent/60" key={child.childSessionId} onClick={() => onOpen(child)} type="button">
      <span className={cn("size-2 shrink-0 rounded-full", childStatusColor(child.status))} />
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{child.nickname}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{child.task || child.status}</span></span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  ))}</div>;
}

function DeliverableList({ assetUrl, deliverables, error, isZh, loading, onOpen, onRefresh }: { readonly assetUrl?: (assetId: string) => string; readonly deliverables: readonly AgentSessionDeliverable[]; readonly error?: string; readonly isZh: boolean; readonly loading: boolean; readonly onOpen: (deliverable: AgentSessionDeliverable) => void; readonly onRefresh: () => void }) {
  return <div>
    <div className="mb-2 flex items-center justify-between"><span className="text-xs text-muted-foreground">{isZh ? "当前会话" : "Current session"}</span><Button aria-label={isZh ? "刷新资产" : "Refresh assets"} disabled={loading} onClick={onRefresh} size="icon-sm" variant="ghost"><RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} /></Button></div>
    {error ? <p className="rounded-md bg-destructive/5 px-2.5 py-2 text-xs text-destructive" role="alert">{error}</p> : null}
    {deliverables.length > 0 ? <div className="flex min-w-0 flex-col gap-2">{deliverables.map((deliverable) => <DeliverableRow assetUrl={assetUrl} deliverable={deliverable} key={`${deliverable.kind}:${deliverable.id}`} onOpen={() => onOpen(deliverable)} />)}</div> : loading ? <EmptyState label={isZh ? "加载中…" : "Loading…"} /> : <EmptyState label={isZh ? "当前会话还没有资产" : "No assets in this session"} />}
  </div>;
}

function DeliverableRow({ assetUrl, deliverable, onOpen }: { readonly assetUrl?: (assetId: string) => string; readonly deliverable: AgentSessionDeliverable; readonly onOpen: () => void }) {
  const url = deliverableUrl(deliverable, assetUrl);
  const image = deliverable.mediaType?.startsWith("image/") ?? false;
  const Icon = deliverable.kind === "website-preview" ? MonitorIcon : image ? ImageIcon : FileIcon;
  return <Attachment className="w-full max-w-none" size="sm" state="done">
    <button aria-label={`${image ? "Preview" : "Open"} ${deliverable.title}`} className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={onOpen} type="button">
      <AttachmentMedia variant={image ? "image" : "icon"}>{image ? <img alt="" className="size-full object-cover" loading="lazy" src={url} /> : <Icon className="size-4" />}</AttachmentMedia>
      <AttachmentContent><AttachmentTitle>{deliverable.title}</AttachmentTitle><AttachmentDescription>{deliverableMeta(deliverable)}</AttachmentDescription></AttachmentContent>
    </button>
    <AttachmentAction asChild aria-label="Download deliverable" title="Download deliverable"><a download={deliverable.title} href={url} rel="noreferrer" target="_blank"><DownloadIcon className="size-3.5" /></a></AttachmentAction>
  </Attachment>;
}

function DeliverablePreview({ assetUrl, deliverable, locale }: { readonly assetUrl?: (assetId: string) => string; readonly deliverable: AgentSessionDeliverable; readonly locale: AgentLocale }) {
  const url = deliverableUrl(deliverable, assetUrl);
  if (deliverable.kind === "website-preview") return <WebsitePreview title={deliverable.title} url={url} />;
  return <FilePreview deliverable={deliverable} locale={locale} url={url} />;
}

function WebsitePreview({ title, url }: { readonly title: string; readonly url: string }) {
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const origin = safeDisplayOrigin(url);
  return <WebPreview
    className="min-h-0 flex-1"
    loading={loading}
    onOpenExternal={() => window.open(url, "_blank", "noopener,noreferrer")}
    onReload={() => { setLoading(true); setGeneration((value) => value + 1); }}
    origin={origin}
  >
    <iframe
      className="size-full min-h-[20rem] border-0 bg-white"
      key={generation}
      onLoad={() => setLoading(false)}
      sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts allow-same-origin"
      src={url}
      title={title}
    />
  </WebPreview>;
}

function FilePreview({ deliverable, locale, url }: { readonly deliverable: AgentSessionDeliverable; readonly locale: AgentLocale; readonly url: string }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const isImage = deliverable.mediaType?.startsWith("image/") ?? false;
  const isText = deliverable.mediaType?.startsWith("text/") || /\.(?:md|markdown|txt|json|csv|html|css|js|ts|tsx|jsx)$/iu.test(deliverable.title);
  useEffect(() => {
    if (!isText || isImage) return;
    const controller = new AbortController();
    void fetch(url, { credentials: "include", signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); })
      .then((value) => setText(value.slice(0, 500_000)))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load deliverable."); });
    return () => controller.abort();
  }, [isImage, isText, url]);
  if (isImage) return <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-muted/20 p-4"><img alt={deliverable.title} className="max-h-[calc(100vh-7rem)] max-w-full rounded-md object-contain" src={url} /></div>;
  if (isText) return <div className="min-h-0 flex-1 overflow-auto p-4">{error ? <p className="text-sm text-destructive">{error}</p> : text === undefined ? <p className="text-sm text-muted-foreground">{locale === "zh-CN" ? "加载中…" : "Loading…"}</p> : /\.(?:md|markdown)$/iu.test(deliverable.title) ? <article className="prose prose-sm max-w-none dark:prose-invert"><StaticMarkdownText text={text} /></article> : <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-5">{text}</pre>}</div>;
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"><FileIcon className="size-8 text-muted-foreground" /><p className="text-sm text-muted-foreground">{locale === "zh-CN" ? "此文件类型不支持在线预览" : "This file type is not previewable online"}</p><Button asChild size="sm" variant="outline"><a download={deliverable.title} href={url} rel="noreferrer" target="_blank"><DownloadIcon className="size-3.5" />{locale === "zh-CN" ? "下载文件" : "Download"}</a></Button></div>;
}

function TabButton({ active, count, label, onClick }: { readonly active: boolean; readonly count?: number; readonly label: string; readonly onClick: () => void }) {
  return <button aria-current={active ? "page" : undefined} className={cn("min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground", active && "font-medium text-foreground")} onClick={onClick} title={label} type="button">{label}{count ? <span className="ml-1 tabular-nums">{count}</span> : null}</button>;
}

function SecondaryTabBar({ children, ...props }: { readonly children: ReactNode; readonly "aria-label": string }) {
  const drag = useRef<{ readonly startX: number; readonly scrollLeft: number } | undefined>(undefined);
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch" || event.button !== 0) return;
    // Do not capture the pointer here. Capturing on pointerdown retargets the
    // browser's subsequent click to the nav and can swallow an ordinary tab
    // activation after returning from a preview. Native touch scrolling still
    // handles mobile; mouse dragging remains available while over the tab bar.
    drag.current = { startX: event.clientX, scrollLeft: event.currentTarget.scrollLeft };
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state) return;
    event.currentTarget.scrollLeft = state.scrollLeft - (event.clientX - state.startX);
  };
  const stopDragging = () => { drag.current = undefined; };
  return <nav
    {...props}
    className="flex min-w-0 flex-1 cursor-grab touch-pan-x select-none items-center gap-1 overflow-x-auto overscroll-x-contain active:cursor-grabbing"
    onPointerCancel={stopDragging}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={stopDragging}
  >{children}</nav>;
}

function OverviewCard({ count, icon, label, onClick }: { readonly count: number; readonly icon: ReactNode; readonly label: string; readonly onClick: () => void }) {
  return <button className="flex items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-3 text-left transition-colors hover:border-border hover:bg-accent/40" onClick={onClick} type="button"><span className="text-muted-foreground">{icon}</span><span className="min-w-0 flex-1 text-sm font-medium">{label}</span><span className="text-xs tabular-nums text-muted-foreground">{count}</span><ChevronRightIcon className="size-4 text-muted-foreground" /></button>;
}

function upsertContentTab(tabs: readonly AgentSecondaryContentTab[], next: AgentSecondaryContentTab): readonly AgentSecondaryContentTab[] {
  return tabs.some((tab) => tab.id === next.id) ? tabs.map((tab) => tab.id === next.id ? next : tab) : [...tabs, next];
}

function normalizeOverviewRoute(tab: AgentSecondaryTab | undefined): AgentSecondaryTab {
  return tab === "children" ? "children" : tab === "assets" || tab === "deliverables" ? "deliverables" : "home";
}

function deliverableUrl(deliverable: AgentSessionDeliverable, assetUrl?: (assetId: string) => string): string {
  return deliverable.kind === "asset" ? assetUrl?.(deliverable.id) ?? deliverable.url : deliverable.url;
}

function deliverableMeta(deliverable: AgentSessionDeliverable): string {
  return [deliverable.kind === "website-preview" ? "Website" : deliverable.mediaType, deliverable.fileCount ? `${deliverable.fileCount} files` : undefined, formatBytes(deliverable.sizeBytes)].filter(Boolean).join(" · ");
}

function childStatusColor(status: string): string {
  if (status === "running" || status === "starting") return "bg-amber-500";
  if (status === "completed") return "bg-emerald-500";
  if (status === "failed") return "bg-destructive";
  return "bg-muted-foreground/50";
}

function safeDisplayOrigin(url: string): string {
  try { return new URL(url, window.location.origin).host; } catch { return url; }
}

function EmptyState({ label }: { readonly label: string }) { return <p className="px-1 py-8 text-center text-sm text-muted-foreground">{label}</p>; }
function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`; return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`; }
