"use client";

import {
  ChevronRightIcon,
  DownloadIcon,
  FileIcon,
  ImageIcon,
  PanelRightCloseIcon,
  RefreshCwIcon,
  UsersRoundIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { StaticMarkdownText } from "../assistant-ui/markdown-text.js";
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
import type { AgentSessionAsset } from "./contracts.js";
import type { AgentLocale } from "./i18n.js";

export type AgentSecondaryTab = "home" | "children" | "assets" | "child" | "asset";
export type AgentSecondaryChild = {
  readonly childSessionId: string;
  readonly nickname: string;
  readonly status: string;
  readonly task?: string;
};

export function AgentSecondaryView({
  assets,
  assetsError,
  assetsLoading,
  children,
  childContent,
  locale,
  onClose,
  onOpenAsset,
  onOpenChild,
  onRefreshAssets,
  onSelectTab,
  tab,
  assetUrl,
}: {
  readonly assets: readonly AgentSessionAsset[];
  readonly assetsError?: string;
  readonly assetsLoading: boolean;
  readonly children: readonly AgentSecondaryChild[];
  readonly childContent?: ReactNode;
  readonly locale: AgentLocale;
  readonly onClose: () => void;
  readonly onOpenAsset?: (asset: AgentSessionAsset) => void;
  readonly onOpenChild: (sessionId: string) => void;
  readonly onRefreshAssets: () => void;
  readonly onSelectTab: (tab: AgentSecondaryTab) => void;
  readonly tab: AgentSecondaryTab;
  readonly assetUrl?: (assetId: string) => string;
}) {
  const isZh = locale === "zh-CN";
  const [selectedAsset, setSelectedAsset] = useState<AgentSessionAsset>();
  const isContentTab = tab === "child" || tab === "asset";
  const title = tab === "children"
    ? (isZh ? "子代理" : "Sub-agents")
    : tab === "assets"
      ? (isZh ? "会话资产" : "Session assets")
      : tab === "child"
        ? (isZh ? "子代理会话" : "Sub-agent session")
        : tab === "asset"
          ? selectedAsset?.filename ?? (isZh ? "资产预览" : "Asset preview")
          : (isZh ? "工作区" : "Workspace");

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-background" data-agent-secondary-view>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        {isContentTab ? <Button aria-label={isZh ? "返回列表" : "Back to list"} onClick={() => onSelectTab(tab === "child" ? "children" : "assets")} size="icon-sm" variant="ghost"><ChevronRightIcon className="size-4 rotate-180" /></Button> : null}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
        <Button aria-label={isZh ? "关闭副视图" : "Close side view"} onClick={onClose} size="icon-sm" variant="ghost"><PanelRightCloseIcon className="size-4" /></Button>
      </header>
      {!isContentTab ? <nav aria-label={isZh ? "副视图导航" : "Side view navigation"} className="flex shrink-0 gap-1 border-b border-border/60 px-2 py-1.5">
        <TabButton active={tab === "home"} label={isZh ? "概览" : "Overview"} onClick={() => onSelectTab("home")} />
        <TabButton active={tab === "children"} count={children.length} label={isZh ? "子代理" : "Sub-agents"} onClick={() => onSelectTab("children")} />
        <TabButton active={tab === "assets"} count={assets.length} label={isZh ? "资产" : "Assets"} onClick={() => onSelectTab("assets")} />
      </nav> : null}
      <div className={cn("min-h-0 flex-1 overflow-y-auto", isContentTab ? "p-0" : "p-3")}>
        {tab === "home" ? <div className="grid gap-2">
          <OverviewCard icon={<UsersRoundIcon className="size-4" />} label={isZh ? "子代理" : "Sub-agents"} count={children.length} onClick={() => onSelectTab("children")} />
          <OverviewCard icon={<FileIcon className="size-4" />} label={isZh ? "会话资产" : "Session assets"} count={assets.length} onClick={() => onSelectTab("assets")} />
          <p className="px-1 pt-2 text-xs leading-5 text-muted-foreground">{isZh ? "执行过程和交付结果会在这里留下可访问的引用。大文件始终保存在宿主对象存储中。" : "Execution results and session outputs appear here as durable references. Large files stay in the host object store."}</p>
        </div> : null}
        {tab === "children" ? children.length > 0 ? <div className="divide-y divide-border/50">
          {children.map((child) => <button className="flex w-full items-center gap-3 px-1 py-3 text-left hover:bg-accent/60" key={child.childSessionId} onClick={() => { onSelectTab("child"); onOpenChild(child.childSessionId); }} type="button">
            <span className={cn("size-2 shrink-0 rounded-full", child.status === "running" || child.status === "starting" ? "bg-amber-500" : child.status === "completed" ? "bg-emerald-500" : child.status === "failed" ? "bg-destructive" : "bg-muted-foreground/50")} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{child.nickname}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{child.task || child.status}</span></span>
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
          </button>)}
        </div> : <EmptyState label={isZh ? "还没有子代理" : "No sub-agents yet"} /> : null}
        {tab === "assets" ? <div>
          <div className="mb-2 flex items-center justify-between"><span className="text-xs text-muted-foreground">{isZh ? "已发布到当前会话" : "Published to this session"}</span><Button aria-label={isZh ? "刷新资产" : "Refresh assets"} disabled={assetsLoading} onClick={onRefreshAssets} size="icon-sm" variant="ghost"><RefreshCwIcon className={cn("size-3.5", assetsLoading && "animate-spin")} /></Button></div>
          {assetsError ? <p className="rounded-md bg-destructive/5 px-2.5 py-2 text-xs text-destructive" role="alert">{assetsError}</p> : null}
          {assets.length > 0 ? <div className="flex min-w-0 flex-col gap-2">{assets.map((asset) => <AssetRow asset={asset} assetUrl={assetUrl} key={asset.assetId} onOpenAsset={(value) => { setSelectedAsset(value); onSelectTab("asset"); onOpenAsset?.(value); }} />)}</div> : assetsLoading ? <EmptyState label={isZh ? "加载中…" : "Loading…"} /> : <EmptyState label={isZh ? "当前会话还没有资产" : "No assets in this session"} />}
        </div> : null}
        {tab === "child" ? childContent ?? <EmptyState label={isZh ? "子代理会话不可用" : "Sub-agent session unavailable"} /> : null}
        {tab === "asset" && selectedAsset ? <AssetPreview asset={selectedAsset} assetUrl={assetUrl} locale={locale} /> : null}
      </div>
    </aside>
  );
}

function TabButton({ active, count, label, onClick }: { readonly active: boolean; readonly count?: number; readonly label: string; readonly onClick: () => void }) {
  return <button aria-current={active ? "page" : undefined} className={cn("rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground", active && "bg-accent font-medium text-foreground")} onClick={onClick} type="button">{label}{count ? <span className="ml-1 tabular-nums">{count}</span> : null}</button>;
}

function OverviewCard({ count, icon, label, onClick }: { readonly count: number; readonly icon: ReactNode; readonly label: string; readonly onClick: () => void }) {
  return <button className="flex items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-3 text-left transition-colors hover:border-border hover:bg-accent/40" onClick={onClick} type="button"><span className="text-muted-foreground">{icon}</span><span className="min-w-0 flex-1 text-sm font-medium">{label}</span><span className="text-xs tabular-nums text-muted-foreground">{count}</span><ChevronRightIcon className="size-4 text-muted-foreground" /></button>;
}

function AssetRow({ asset, assetUrl, onOpenAsset }: { readonly asset: AgentSessionAsset; readonly assetUrl?: (assetId: string) => string; readonly onOpenAsset?: (asset: AgentSessionAsset) => void }) {
  const url = assetUrl?.(asset.assetId) ?? asset.previewUrl ?? asset.url ?? asset.downloadUrl ?? `/api/assets/${encodeURIComponent(asset.assetId)}`;
  const image = asset.mediaType.startsWith("image/");
  const [previewOpen, setPreviewOpen] = useState(false);
  const open = () => {
    if (onOpenAsset) onOpenAsset(asset);
    else if (image) setPreviewOpen(true);
    else window.open(url, "_blank", "noopener,noreferrer");
  };
  return <>
    <Attachment className="w-full max-w-none" size="sm" state="done">
      <button aria-label={`${image ? "Preview" : "Open"} ${asset.filename}`} className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={open} type="button">
        <AttachmentMedia variant={image ? "image" : "icon"}>{image ? <img alt="" className="size-full object-cover" loading="lazy" src={url} /> : <FileIcon className="size-4" />}</AttachmentMedia>
        <AttachmentContent><AttachmentTitle>{asset.filename}</AttachmentTitle><AttachmentDescription>{asset.mediaType} · {formatBytes(asset.sizeBytes)}</AttachmentDescription></AttachmentContent>
      </button>
      <AttachmentAction asChild aria-label="Download asset" title="Download asset"><a download={asset.filename} href={url} rel="noreferrer" target="_blank"><DownloadIcon className="size-3.5" /></a></AttachmentAction>
      {onOpenAsset ? <AttachmentAction aria-label="Open asset" onClick={open} title="Open asset"><ImageIcon className="size-3.5" /></AttachmentAction> : null}
    </Attachment>
    {previewOpen ? <button aria-label="Close image preview" className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-4" onClick={() => setPreviewOpen(false)} type="button"><img alt={asset.filename} className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain" src={url} /></button> : null}
  </>;
}

function AssetPreview({ asset, assetUrl, locale }: { readonly asset: AgentSessionAsset; readonly assetUrl?: (assetId: string) => string; readonly locale: AgentLocale }) {
  const url = assetUrl?.(asset.assetId) ?? asset.previewUrl ?? asset.url ?? asset.downloadUrl ?? `/api/assets/${encodeURIComponent(asset.assetId)}`;
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const isImage = asset.mediaType.startsWith("image/");
  const isText = asset.mediaType.startsWith("text/") || /\.(?:md|markdown|txt|json|csv|html|css|js|ts|tsx|jsx)$/iu.test(asset.filename);
  useEffect(() => {
    if (!isText || isImage) return;
    const controller = new AbortController();
    void fetch(url, { credentials: "include", signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); })
      .then((value) => setText(value.slice(0, 500_000)))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load asset."); });
    return () => controller.abort();
  }, [isImage, isText, url]);
  if (isImage) return <div className="flex min-h-full items-start justify-center bg-muted/20 p-4"><img alt={asset.filename} className="max-h-[calc(100vh-7rem)] max-w-full rounded-lg object-contain" src={url} /></div>;
  if (isText) return <div className="p-4">{error ? <p className="text-sm text-destructive">{error}</p> : text === undefined ? <p className="text-sm text-muted-foreground">{locale === "zh-CN" ? "加载中…" : "Loading…"}</p> : /\.(?:md|markdown)$/iu.test(asset.filename) ? <article className="prose prose-sm max-w-none dark:prose-invert"><StaticMarkdownText text={text} /></article> : <pre className="max-h-[calc(100vh-7rem)] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-xs leading-5">{text}</pre>}</div>;
  return <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center"><FileIcon className="size-8 text-muted-foreground" /><p className="text-sm text-muted-foreground">{locale === "zh-CN" ? "此文件类型不支持在线预览" : "This file type is not previewable online"}</p><Button asChild size="sm" variant="outline"><a download={asset.filename} href={url} rel="noreferrer" target="_blank"><DownloadIcon className="size-3.5" />{locale === "zh-CN" ? "下载文件" : "Download"}</a></Button></div>;
}

function EmptyState({ label }: { readonly label: string }) { return <p className="px-1 py-8 text-center text-sm text-muted-foreground">{label}</p>; }
function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`; return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`; }
