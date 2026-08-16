"use client";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { ChevronRightIcon, DownloadIcon, FileIcon, ImageIcon, PanelRightCloseIcon, RefreshCwIcon, UsersRoundIcon, } from "lucide-react";
import { useEffect, useState } from "react";
import { StaticMarkdownText } from "../assistant-ui/markdown-text.js";
import { Attachment, AttachmentAction, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, } from "../ui/attachment.js";
import { Button } from "../ui/button.js";
import { cn } from "../utils.js";
export function AgentSecondaryView({ assets, assetsError, assetsLoading, children, childContent, locale, onClose, onOpenAsset, onOpenChild, onRefreshAssets, onSelectTab, tab, assetUrl, }) {
    const isZh = locale === "zh-CN";
    const [selectedAsset, setSelectedAsset] = useState();
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
    return (_jsxs("aside", { className: "flex h-full min-h-0 min-w-0 flex-col bg-background", "data-agent-secondary-view": true, children: [_jsxs("header", { className: "flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3", children: [isContentTab ? _jsx(Button, { "aria-label": isZh ? "返回列表" : "Back to list", onClick: () => onSelectTab(tab === "child" ? "children" : "assets"), size: "icon-sm", variant: "ghost", children: _jsx(ChevronRightIcon, { className: "size-4 rotate-180" }) }) : null, _jsx("h2", { className: "min-w-0 flex-1 truncate text-sm font-medium", children: title }), _jsx(Button, { "aria-label": isZh ? "关闭副视图" : "Close side view", onClick: onClose, size: "icon-sm", variant: "ghost", children: _jsx(PanelRightCloseIcon, { className: "size-4" }) })] }), !isContentTab ? _jsxs("nav", { "aria-label": isZh ? "副视图导航" : "Side view navigation", className: "flex shrink-0 gap-1 border-b border-border/60 px-2 py-1.5", children: [_jsx(TabButton, { active: tab === "home", label: isZh ? "概览" : "Overview", onClick: () => onSelectTab("home") }), _jsx(TabButton, { active: tab === "children", count: children.length, label: isZh ? "子代理" : "Sub-agents", onClick: () => onSelectTab("children") }), _jsx(TabButton, { active: tab === "assets", count: assets.length, label: isZh ? "资产" : "Assets", onClick: () => onSelectTab("assets") })] }) : null, _jsxs("div", { className: cn("min-h-0 flex-1 overflow-y-auto", isContentTab ? "p-0" : "p-3"), children: [tab === "home" ? _jsxs("div", { className: "grid gap-2", children: [_jsx(OverviewCard, { icon: _jsx(UsersRoundIcon, { className: "size-4" }), label: isZh ? "子代理" : "Sub-agents", count: children.length, onClick: () => onSelectTab("children") }), _jsx(OverviewCard, { icon: _jsx(FileIcon, { className: "size-4" }), label: isZh ? "会话资产" : "Session assets", count: assets.length, onClick: () => onSelectTab("assets") }), _jsx("p", { className: "px-1 pt-2 text-xs leading-5 text-muted-foreground", children: isZh ? "执行过程和交付结果会在这里留下可访问的引用。大文件始终保存在宿主对象存储中。" : "Execution results and session outputs appear here as durable references. Large files stay in the host object store." })] }) : null, tab === "children" ? children.length > 0 ? _jsx("div", { className: "divide-y divide-border/50", children: children.map((child) => _jsxs("button", { className: "flex w-full items-center gap-3 px-1 py-3 text-left hover:bg-accent/60", onClick: () => { onSelectTab("child"); onOpenChild(child.childSessionId); }, type: "button", children: [_jsx("span", { className: cn("size-2 shrink-0 rounded-full", child.status === "running" || child.status === "starting" ? "bg-amber-500" : child.status === "completed" ? "bg-emerald-500" : child.status === "failed" ? "bg-destructive" : "bg-muted-foreground/50") }), _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block truncate text-sm font-medium", children: child.nickname }), _jsx("span", { className: "mt-0.5 block truncate text-xs text-muted-foreground", children: child.task || child.status })] }), _jsx(ChevronRightIcon, { className: "size-4 shrink-0 text-muted-foreground" })] }, child.childSessionId)) }) : _jsx(EmptyState, { label: isZh ? "还没有子代理" : "No sub-agents yet" }) : null, tab === "assets" ? _jsxs("div", { children: [_jsxs("div", { className: "mb-2 flex items-center justify-between", children: [_jsx("span", { className: "text-xs text-muted-foreground", children: isZh ? "已发布到当前会话" : "Published to this session" }), _jsx(Button, { "aria-label": isZh ? "刷新资产" : "Refresh assets", disabled: assetsLoading, onClick: onRefreshAssets, size: "icon-sm", variant: "ghost", children: _jsx(RefreshCwIcon, { className: cn("size-3.5", assetsLoading && "animate-spin") }) })] }), assetsError ? _jsx("p", { className: "rounded-md bg-destructive/5 px-2.5 py-2 text-xs text-destructive", role: "alert", children: assetsError }) : null, assets.length > 0 ? _jsx("div", { className: "flex min-w-0 flex-col gap-2", children: assets.map((asset) => _jsx(AssetRow, { asset: asset, assetUrl: assetUrl, onOpenAsset: (value) => { setSelectedAsset(value); onSelectTab("asset"); onOpenAsset?.(value); } }, asset.assetId)) }) : assetsLoading ? _jsx(EmptyState, { label: isZh ? "加载中…" : "Loading…" }) : _jsx(EmptyState, { label: isZh ? "当前会话还没有资产" : "No assets in this session" })] }) : null, tab === "child" ? childContent ?? _jsx(EmptyState, { label: isZh ? "子代理会话不可用" : "Sub-agent session unavailable" }) : null, tab === "asset" && selectedAsset ? _jsx(AssetPreview, { asset: selectedAsset, assetUrl: assetUrl, locale: locale }) : null] })] }));
}
function TabButton({ active, count, label, onClick }) {
    return _jsxs("button", { "aria-current": active ? "page" : undefined, className: cn("rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground", active && "bg-accent font-medium text-foreground"), onClick: onClick, type: "button", children: [label, count ? _jsx("span", { className: "ml-1 tabular-nums", children: count }) : null] });
}
function OverviewCard({ count, icon, label, onClick }) {
    return _jsxs("button", { className: "flex items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-3 text-left transition-colors hover:border-border hover:bg-accent/40", onClick: onClick, type: "button", children: [_jsx("span", { className: "text-muted-foreground", children: icon }), _jsx("span", { className: "min-w-0 flex-1 text-sm font-medium", children: label }), _jsx("span", { className: "text-xs tabular-nums text-muted-foreground", children: count }), _jsx(ChevronRightIcon, { className: "size-4 text-muted-foreground" })] });
}
function AssetRow({ asset, assetUrl, onOpenAsset }) {
    const url = assetUrl?.(asset.assetId) ?? asset.previewUrl ?? asset.url ?? asset.downloadUrl ?? `/api/assets/${encodeURIComponent(asset.assetId)}`;
    const image = asset.mediaType.startsWith("image/");
    const [previewOpen, setPreviewOpen] = useState(false);
    const open = () => {
        if (onOpenAsset)
            onOpenAsset(asset);
        else if (image)
            setPreviewOpen(true);
        else
            window.open(url, "_blank", "noopener,noreferrer");
    };
    return _jsxs(_Fragment, { children: [_jsxs(Attachment, { className: "w-full max-w-none", size: "sm", state: "done", children: [_jsxs("button", { "aria-label": `${image ? "Preview" : "Open"} ${asset.filename}`, className: "flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50", onClick: open, type: "button", children: [_jsx(AttachmentMedia, { variant: image ? "image" : "icon", children: image ? _jsx("img", { alt: "", className: "size-full object-cover", loading: "lazy", src: url }) : _jsx(FileIcon, { className: "size-4" }) }), _jsxs(AttachmentContent, { children: [_jsx(AttachmentTitle, { children: asset.filename }), _jsxs(AttachmentDescription, { children: [asset.mediaType, " \u00B7 ", formatBytes(asset.sizeBytes)] })] })] }), _jsx(AttachmentAction, { asChild: true, "aria-label": "Download asset", title: "Download asset", children: _jsx("a", { download: asset.filename, href: url, rel: "noreferrer", target: "_blank", children: _jsx(DownloadIcon, { className: "size-3.5" }) }) }), onOpenAsset ? _jsx(AttachmentAction, { "aria-label": "Open asset", onClick: open, title: "Open asset", children: _jsx(ImageIcon, { className: "size-3.5" }) }) : null] }), previewOpen ? _jsx("button", { "aria-label": "Close image preview", className: "fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-4", onClick: () => setPreviewOpen(false), type: "button", children: _jsx("img", { alt: asset.filename, className: "max-h-[90vh] max-w-[90vw] rounded-xl object-contain", src: url }) }) : null] });
}
function AssetPreview({ asset, assetUrl, locale }) {
    const url = assetUrl?.(asset.assetId) ?? asset.previewUrl ?? asset.url ?? asset.downloadUrl ?? `/api/assets/${encodeURIComponent(asset.assetId)}`;
    const [text, setText] = useState();
    const [error, setError] = useState();
    const isImage = asset.mediaType.startsWith("image/");
    const isText = asset.mediaType.startsWith("text/") || /\.(?:md|markdown|txt|json|csv|html|css|js|ts|tsx|jsx)$/iu.test(asset.filename);
    useEffect(() => {
        if (!isText || isImage)
            return;
        const controller = new AbortController();
        void fetch(url, { credentials: "include", signal: controller.signal })
            .then((response) => { if (!response.ok)
            throw new Error(`HTTP ${response.status}`); return response.text(); })
            .then((value) => setText(value.slice(0, 500_000)))
            .catch((reason) => { if (!controller.signal.aborted)
            setError(reason instanceof Error ? reason.message : "Unable to load asset."); });
        return () => controller.abort();
    }, [isImage, isText, url]);
    if (isImage)
        return _jsx("div", { className: "flex min-h-full items-start justify-center bg-muted/20 p-4", children: _jsx("img", { alt: asset.filename, className: "max-h-[calc(100vh-7rem)] max-w-full rounded-lg object-contain", src: url }) });
    if (isText)
        return _jsx("div", { className: "p-4", children: error ? _jsx("p", { className: "text-sm text-destructive", children: error }) : text === undefined ? _jsx("p", { className: "text-sm text-muted-foreground", children: locale === "zh-CN" ? "加载中…" : "Loading…" }) : /\.(?:md|markdown)$/iu.test(asset.filename) ? _jsx("article", { className: "prose prose-sm max-w-none dark:prose-invert", children: _jsx(StaticMarkdownText, { text: text }) }) : _jsx("pre", { className: "max-h-[calc(100vh-7rem)] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-xs leading-5", children: text }) });
    return _jsxs("div", { className: "flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center", children: [_jsx(FileIcon, { className: "size-8 text-muted-foreground" }), _jsx("p", { className: "text-sm text-muted-foreground", children: locale === "zh-CN" ? "此文件类型不支持在线预览" : "This file type is not previewable online" }), _jsx(Button, { asChild: true, size: "sm", variant: "outline", children: _jsxs("a", { download: asset.filename, href: url, rel: "noreferrer", target: "_blank", children: [_jsx(DownloadIcon, { className: "size-3.5" }), locale === "zh-CN" ? "下载文件" : "Download"] }) })] });
}
function EmptyState({ label }) { return _jsx("p", { className: "px-1 py-8 text-center text-sm text-muted-foreground", children: label }); }
function formatBytes(value) { if (value < 1024)
    return `${value} B`; if (value < 1024 * 1024)
    return `${Math.round(value / 1024)} KB`; if (value < 1024 * 1024 * 1024)
    return `${(value / 1024 / 1024).toFixed(1)} MB`; return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`; }
//# sourceMappingURL=agent-secondary-view.js.map