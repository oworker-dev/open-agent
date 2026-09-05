"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FileIcon, ImageIcon, MonitorIcon, PanelRightCloseIcon, RefreshCwIcon, UsersRoundIcon, XIcon, } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StaticMarkdownText } from "../assistant-ui/markdown-text.js";
import { WebPreview } from "../assistant-ui/web-preview.js";
import { ArtifactCard } from "../assistant-ui/artifact-card.js";
import { Attachment, AttachmentAction, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, } from "../ui/attachment.js";
import { Button } from "../ui/button.js";
import { cn } from "../utils.js";
import { mergeSessionDeliverables, splitSessionDeliverables } from "./session-deliverables.js";
export function AgentSecondaryView({ assetUrl, assets = [], assetsError, assetsLoading = false, childContent, children, deliverables, deliverablesError, deliverablesLoading, locale, onClose, onOpenAsset, onOpenChild, onOpenDeliverable, onRefreshAssets, onRefreshDeliverables, onSelectTab, requestedDeliverable, requestedDeliverableRequestId, tab, }) {
    const isZh = locale === "zh-CN";
    const deliverableGroups = useMemo(() => splitSessionDeliverables(mergeSessionDeliverables(deliverables, assets)), [assets, deliverables]);
    const [overviewRoute, setOverviewRoute] = useState(normalizeOverviewRoute(tab));
    const [openTabs, setOpenTabs] = useState([]);
    const [activeTabId, setActiveTabId] = useState("home");
    const consumedDeliverableRequestId = useRef(undefined);
    const activeTab = openTabs.find((candidate) => candidate.id === activeTabId);
    const selectOverviewRoute = useCallback((route) => {
        const normalized = normalizeOverviewRoute(route);
        setOverviewRoute(normalized);
        setActiveTabId("home");
        onSelectTab?.(normalized);
    }, [onSelectTab]);
    const openChild = useCallback((child) => {
        const contentTab = {
            id: `child:${child.childSessionId}`,
            kind: "child",
            sessionId: child.childSessionId,
            title: child.nickname,
        };
        setOpenTabs((current) => upsertContentTab(current, contentTab));
        setActiveTabId(contentTab.id);
        onOpenChild(child.childSessionId);
    }, [onOpenChild]);
    const openDeliverable = useCallback((deliverable) => {
        if (onOpenDeliverable) {
            onOpenDeliverable(deliverable);
            return;
        }
        const contentTab = {
            deliverable,
            id: `deliverable:${deliverable.kind}:${deliverable.id}`,
            kind: "deliverable",
            overviewRoute: deliverable.kind === "asset" ? "assets" : "deliverables",
            title: deliverable.title,
        };
        setOpenTabs((current) => upsertContentTab(current, contentTab));
        setActiveTabId(contentTab.id);
        if (deliverable.kind === "asset") {
            const asset = assets.find((candidate) => candidate.assetId === deliverable.id);
            if (asset)
                onOpenAsset?.(asset);
        }
    }, [assets, onOpenAsset, onOpenDeliverable]);
    useEffect(() => {
        if (!requestedDeliverable || requestedDeliverableRequestId === undefined)
            return;
        if (consumedDeliverableRequestId.current === requestedDeliverableRequestId)
            return;
        consumedDeliverableRequestId.current = requestedDeliverableRequestId;
        openDeliverable(requestedDeliverable);
    }, [openDeliverable, requestedDeliverable, requestedDeliverableRequestId]);
    const activateContentTab = (contentTab) => {
        setActiveTabId(contentTab.id);
        if (contentTab.kind === "child")
            onOpenChild(contentTab.sessionId);
    };
    const closeContentTab = (contentTab) => {
        setOpenTabs((current) => current.filter((candidate) => candidate.id !== contentTab.id));
        if (activeTabId === contentTab.id)
            setActiveTabId("home");
    };
    const headerTitle = activeTab?.title ?? (overviewRoute === "children"
        ? (isZh ? "子代理" : "Sub-agents")
        : overviewRoute === "deliverables"
            ? (isZh ? "发布资产" : "Published assets")
            : overviewRoute === "assets"
                ? (isZh ? "会话资产" : "Session assets")
                : (isZh ? "工作区" : "Workspace"));
    return (_jsxs("aside", { className: "flex h-full min-h-0 min-w-0 flex-col bg-background", "data-agent-secondary-view": true, children: [_jsxs("header", { className: "flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3", children: [activeTab || overviewRoute !== "home" ? (_jsx(Button, { "aria-label": activeTab ? (isZh ? "返回列表" : "Back to list") : (isZh ? "返回概览" : "Back to overview"), onClick: () => selectOverviewRoute(activeTab?.kind === "child" ? "children" : activeTab?.kind === "deliverable" ? activeTab.overviewRoute : "home"), size: "icon-sm", variant: "ghost", children: _jsx(ChevronLeftIcon, { className: "size-4" }) })) : null, openTabs.length > 0 ? (_jsx("h2", { className: "sr-only", children: headerTitle })) : null, openTabs.length > 0 ? (_jsx(SecondaryTabBar, { "aria-label": isZh ? "已打开内容" : "Open content", children: openTabs.map((contentTab) => (_jsxs("div", { className: cn("group/tab flex w-40 shrink-0 items-center rounded-md", activeTabId === contentTab.id && "bg-accent"), children: [_jsx(TabButton, { active: activeTabId === contentTab.id, label: contentTab.title, onClick: () => activateContentTab(contentTab) }), _jsx("button", { "aria-label": `${isZh ? "关闭" : "Close"} ${contentTab.title}`, className: "mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background/80 hover:text-foreground", onClick: () => closeContentTab(contentTab), type: "button", children: _jsx(XIcon, { className: "size-3" }) })] }, contentTab.id))) })) : (_jsx("h2", { className: "min-w-0 flex-1 truncate text-sm font-medium", children: headerTitle })), _jsx(Button, { "aria-label": isZh ? "关闭副视图" : "Close side view", onClick: onClose, size: "icon-sm", variant: "ghost", children: _jsx(PanelRightCloseIcon, { className: "size-4" }) })] }), activeTabId === "home" ? (_jsx(_Fragment, { children: _jsxs("div", { className: "min-h-0 flex-1 overflow-y-auto p-3", children: [overviewRoute === "home" ? _jsx(Overview, { assetCount: deliverableGroups.assets.length, childCount: children.length, publicationCount: deliverableGroups.publications.length, isZh: isZh, onChildren: () => selectOverviewRoute("children"), onAssets: () => selectOverviewRoute("assets"), onPublications: () => selectOverviewRoute("deliverables") }) : null, overviewRoute === "children" ? _jsx(ChildList, { children: children, isZh: isZh, onOpen: openChild }) : null, overviewRoute === "assets" ? _jsx(SessionAssetList, { assetUrl: assetUrl, assets: deliverableGroups.assets, error: assetsError, isZh: isZh, loading: assetsLoading, onOpen: openDeliverable, onRefresh: onRefreshAssets ?? (() => undefined) }) : null, overviewRoute === "deliverables" ? _jsx(DeliverableList, { deliverables: deliverableGroups.publications, error: deliverablesError, isZh: isZh, loading: deliverablesLoading ?? false, onOpen: openDeliverable, onRefresh: onRefreshDeliverables ?? (() => undefined) }) : null] }) })) : activeTab?.kind === "child" ? (_jsx("div", { className: "flex min-h-0 flex-1 flex-col", children: childContent ?? _jsx(EmptyState, { label: isZh ? "子代理会话不可用" : "Sub-agent session unavailable" }) })) : activeTab?.kind === "deliverable" ? (_jsx(DeliverablePreview, { assetUrl: assetUrl, deliverable: activeTab.deliverable, locale: locale })) : null] }));
}
function Overview({ assetCount, childCount, isZh, onAssets, onChildren, onPublications, publicationCount }) {
    return _jsxs("div", { className: "grid gap-2", children: [_jsx(OverviewCard, { count: childCount, icon: _jsx(UsersRoundIcon, { className: "size-4" }), label: isZh ? "子代理" : "Sub-agents", onClick: onChildren }), _jsx(OverviewCard, { count: assetCount, icon: _jsx(FileIcon, { className: "size-4" }), label: isZh ? "会话资产" : "Session assets", onClick: onAssets }), _jsx(OverviewCard, { count: publicationCount, icon: _jsx(MonitorIcon, { className: "size-4" }), label: isZh ? "发布资产" : "Published assets", onClick: onPublications }), _jsx("p", { className: "px-1 pt-2 text-xs leading-5 text-muted-foreground", children: isZh ? "子代理对话和 Agent 发布的文件、图片、网站会保留为会话级可访问引用。" : "Sub-agent conversations and Agent-published files, images, and websites remain accessible from this session." })] });
}
function ChildList({ children, isZh, onOpen }) {
    if (children.length === 0)
        return _jsx(EmptyState, { label: isZh ? "还没有子代理" : "No sub-agents yet" });
    return _jsx("div", { className: "divide-y divide-border/50", children: children.map((child) => (_jsxs("button", { className: "flex w-full items-center gap-3 px-1 py-3 text-left hover:bg-accent/60", onClick: () => onOpen(child), type: "button", children: [_jsx("span", { className: cn("size-2 shrink-0 rounded-full", childStatusColor(child.status)) }), _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block truncate text-sm font-medium", children: child.nickname }), _jsx("span", { className: "mt-0.5 block truncate text-xs text-muted-foreground", children: child.task || child.status })] }), _jsx(ChevronRightIcon, { className: "size-4 shrink-0 text-muted-foreground" })] }, child.childSessionId))) });
}
function SessionAssetList({ assetUrl, assets, error, isZh, loading, onOpen, onRefresh }) {
    return _jsxs("div", { children: [_jsxs("div", { className: "mb-2 flex items-center justify-between", children: [_jsx("span", { className: "text-xs text-muted-foreground", children: isZh ? "当前会话" : "Current session" }), _jsx(Button, { "aria-label": isZh ? "刷新会话资产" : "Refresh session assets", disabled: loading, onClick: onRefresh, size: "icon-sm", variant: "ghost", children: _jsx(RefreshCwIcon, { className: cn("size-3.5", loading && "animate-spin") }) })] }), error ? _jsx("p", { className: "rounded-md bg-destructive/5 px-2.5 py-2 text-xs text-destructive", role: "alert", children: error }) : null, assets.length > 0 ? _jsx("div", { className: "flex min-w-0 flex-col gap-2", children: assets.map((asset) => _jsx(SessionAssetRow, { assetUrl: assetUrl, deliverable: asset, onOpen: () => onOpen(asset) }, `${asset.kind}:${asset.id}`)) }) : loading ? _jsx(EmptyState, { label: isZh ? "加载中…" : "Loading…" }) : _jsx(EmptyState, { label: isZh ? "当前会话还没有资产" : "No session assets" })] });
}
function DeliverableList({ deliverables, error, isZh, loading, onOpen, onRefresh }) {
    return _jsxs("div", { children: [_jsxs("div", { className: "mb-2 flex items-center justify-between", children: [_jsx("span", { className: "text-xs text-muted-foreground", children: isZh ? "Agent 发布" : "Agent publications" }), _jsx(Button, { "aria-label": isZh ? "刷新发布资产" : "Refresh published assets", disabled: loading, onClick: onRefresh, size: "icon-sm", variant: "ghost", children: _jsx(RefreshCwIcon, { className: cn("size-3.5", loading && "animate-spin") }) })] }), error ? _jsx("p", { className: "rounded-md bg-destructive/5 px-2.5 py-2 text-xs text-destructive", role: "alert", children: error }) : null, deliverables.length > 0 ? _jsx("div", { className: "flex min-w-0 flex-col gap-2", children: deliverables.map((deliverable) => _jsx(PublishedDeliverableRow, { deliverable: deliverable, isZh: isZh, onOpen: () => onOpen(deliverable) }, `${deliverable.kind}:${deliverable.id}`)) }) : loading ? _jsx(EmptyState, { label: isZh ? "加载中…" : "Loading…" }) : _jsx(EmptyState, { label: isZh ? "当前会话还没有发布资产" : "No published assets" })] });
}
function SessionAssetRow({ assetUrl, deliverable, onOpen }) {
    const url = deliverableUrl(deliverable, assetUrl);
    const image = deliverable.mediaType?.startsWith("image/") ?? false;
    return _jsxs(Attachment, { className: "w-full max-w-none", size: "sm", state: "done", children: [_jsxs("button", { "aria-label": `${image ? "Preview" : "Open"} ${deliverable.title}`, className: "flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50", onClick: onOpen, type: "button", children: [_jsx(AttachmentMedia, { variant: image ? "image" : "icon", children: image ? _jsx("img", { alt: "", className: "size-full object-cover", loading: "lazy", src: url }) : _jsx(FileIcon, { className: "size-4" }) }), _jsxs(AttachmentContent, { children: [_jsx(AttachmentTitle, { children: deliverable.title }), _jsx(AttachmentDescription, { children: sessionAssetMeta(deliverable) })] })] }), _jsx(AttachmentAction, { asChild: true, "aria-label": "Download asset", title: "Download asset", children: _jsx("a", { download: deliverable.title, href: url, rel: "noreferrer", target: "_blank", children: _jsx(DownloadIcon, { className: "size-3.5" }) }) })] });
}
function PublishedDeliverableRow({ deliverable, isZh, onOpen }) {
    const image = deliverable.mediaType?.startsWith("image/") ?? false;
    return _jsx(ArtifactCard, { "aria-label": `${isZh ? "打开" : "Open"} ${deliverable.title}`, icon: deliverable.kind === "website-preview" ? _jsx(MonitorIcon, { className: "size-4" }) : image ? _jsx(ImageIcon, { className: "size-4" }) : undefined, meta: deliverableMeta(deliverable, isZh), onClick: onOpen, title: deliverable.alias ?? deliverable.title });
}
function DeliverablePreview({ assetUrl, deliverable, locale }) {
    const url = deliverableUrl(deliverable, assetUrl);
    if (deliverable.kind === "website-preview")
        return _jsx(WebsitePreview, { title: deliverable.title, url: url });
    return _jsx(FilePreview, { deliverable: deliverable, locale: locale, url: url });
}
function WebsitePreview({ title, url }) {
    const [loading, setLoading] = useState(true);
    const [generation, setGeneration] = useState(0);
    const origin = safeDisplayOrigin(url);
    return _jsx(WebPreview, { className: "min-h-0 flex-1", loading: loading, onOpenExternal: () => window.open(url, "_blank", "noopener,noreferrer"), onReload: () => { setLoading(true); setGeneration((value) => value + 1); }, origin: origin, children: _jsx("iframe", { className: "size-full min-h-[20rem] border-0 bg-white", onLoad: () => setLoading(false), sandbox: "allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts allow-same-origin", src: url, title: title }, generation) });
}
function FilePreview({ deliverable, locale, url }) {
    const [text, setText] = useState();
    const [error, setError] = useState();
    const isImage = deliverable.mediaType?.startsWith("image/") ?? false;
    const isText = deliverable.mediaType?.startsWith("text/") || /\.(?:md|markdown|txt|json|csv|html|css|js|ts|tsx|jsx)$/iu.test(deliverable.title);
    useEffect(() => {
        if (!isText || isImage)
            return;
        const controller = new AbortController();
        void fetch(url, { credentials: "include", signal: controller.signal })
            .then((response) => { if (!response.ok)
            throw new Error(`HTTP ${response.status}`); return response.text(); })
            .then((value) => setText(value.slice(0, 500_000)))
            .catch((reason) => { if (!controller.signal.aborted)
            setError(reason instanceof Error ? reason.message : "Unable to load deliverable."); });
        return () => controller.abort();
    }, [isImage, isText, url]);
    if (isImage)
        return _jsx("div", { className: "flex min-h-0 flex-1 items-start justify-center overflow-auto bg-muted/20 p-4", children: _jsx("img", { alt: deliverable.title, className: "max-h-[calc(100vh-7rem)] max-w-full rounded-md object-contain", src: url }) });
    if (isText)
        return _jsx("div", { className: "min-h-0 flex-1 overflow-auto p-4", children: error ? _jsx("p", { className: "text-sm text-destructive", children: error }) : text === undefined ? _jsx("p", { className: "text-sm text-muted-foreground", children: locale === "zh-CN" ? "加载中…" : "Loading…" }) : /\.(?:md|markdown)$/iu.test(deliverable.title) ? _jsx("article", { className: "prose prose-sm max-w-none dark:prose-invert", children: _jsx(StaticMarkdownText, { text: text }) }) : _jsx("pre", { className: "whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-5", children: text }) });
    return _jsxs("div", { className: "flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center", children: [_jsx(FileIcon, { className: "size-8 text-muted-foreground" }), _jsx("p", { className: "text-sm text-muted-foreground", children: locale === "zh-CN" ? "此文件类型不支持在线预览" : "This file type is not previewable online" }), _jsx(Button, { asChild: true, size: "sm", variant: "outline", children: _jsxs("a", { download: deliverable.title, href: url, rel: "noreferrer", target: "_blank", children: [_jsx(DownloadIcon, { className: "size-3.5" }), locale === "zh-CN" ? "下载文件" : "Download"] }) })] });
}
function TabButton({ active, count, label, onClick }) {
    return _jsxs("button", { "aria-current": active ? "page" : undefined, className: cn("min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground", active && "font-medium text-foreground"), onClick: onClick, title: label, type: "button", children: [label, count ? _jsx("span", { className: "ml-1 tabular-nums", children: count }) : null] });
}
function SecondaryTabBar({ children, ...props }) {
    const drag = useRef(undefined);
    const onPointerDown = (event) => {
        if (event.pointerType === "touch" || event.button !== 0)
            return;
        drag.current = { startX: event.clientX, scrollLeft: event.currentTarget.scrollLeft };
    };
    const onPointerMove = (event) => {
        const state = drag.current;
        if (!state)
            return;
        event.currentTarget.scrollLeft = state.scrollLeft - (event.clientX - state.startX);
    };
    const stopDragging = () => { drag.current = undefined; };
    return _jsx("nav", { ...props, className: "flex min-w-0 flex-1 cursor-grab touch-pan-x select-none items-center gap-1 overflow-x-auto overscroll-x-contain active:cursor-grabbing", onPointerCancel: stopDragging, onPointerDown: onPointerDown, onPointerMove: onPointerMove, onPointerUp: stopDragging, children: children });
}
function OverviewCard({ count, icon, label, onClick }) {
    return _jsxs("button", { className: "flex items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-3 text-left transition-colors hover:border-border hover:bg-accent/40", onClick: onClick, type: "button", children: [_jsx("span", { className: "text-muted-foreground", children: icon }), _jsx("span", { className: "min-w-0 flex-1 text-sm font-medium", children: label }), _jsx("span", { className: "text-xs tabular-nums text-muted-foreground", children: count }), _jsx(ChevronRightIcon, { className: "size-4 text-muted-foreground" })] });
}
function upsertContentTab(tabs, next) {
    return tabs.some((tab) => tab.id === next.id) ? tabs.map((tab) => tab.id === next.id ? next : tab) : [...tabs, next];
}
function normalizeOverviewRoute(tab) {
    return tab === "children" || tab === "assets" || tab === "deliverables" ? tab : "home";
}
function deliverableUrl(deliverable, assetUrl) {
    return deliverable.kind === "asset" ? assetUrl?.(deliverable.id) ?? deliverable.url : deliverable.url;
}
function sessionAssetMeta(deliverable) {
    return [deliverable.mediaType, formatBytes(deliverable.sizeBytes)].filter(Boolean).join(" · ");
}
function deliverableMeta(deliverable, isZh) {
    const title = deliverable.alias && deliverable.title !== deliverable.alias ? deliverable.title : undefined;
    const kind = deliverable.kind === "website-preview" ? (isZh ? "网站预览" : "Website preview") : (isZh ? "发布资产" : "Published artifact");
    const version = deliverable.version ? `v${deliverable.version}` : undefined;
    const fileCount = deliverable.fileCount ? `${deliverable.fileCount} ${isZh ? "个文件" : "files"}` : undefined;
    return [kind, version, title, fileCount, deliverable.mediaType, formatBytes(deliverable.sizeBytes)].filter(Boolean).join(" · ");
}
function childStatusColor(status) {
    if (status === "running" || status === "starting")
        return "bg-amber-500";
    if (status === "completed")
        return "bg-emerald-500";
    if (status === "failed")
        return "bg-destructive";
    return "bg-muted-foreground/50";
}
function safeDisplayOrigin(url) {
    try {
        return new URL(url, window.location.origin).host;
    }
    catch {
        return url;
    }
}
function EmptyState({ label }) { return _jsx("p", { className: "px-1 py-8 text-center text-sm text-muted-foreground", children: label }); }
function formatBytes(value) { if (value === undefined)
    return undefined; if (value < 1024)
    return `${value} B`; if (value < 1024 * 1024)
    return `${Math.round(value / 1024)} KB`; if (value < 1024 * 1024 * 1024)
    return `${(value / 1024 / 1024).toFixed(1)} MB`; return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`; }
//# sourceMappingURL=agent-secondary-view.js.map