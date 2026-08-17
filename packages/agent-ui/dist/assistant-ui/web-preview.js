"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import { Button } from "../ui/button.js";
import { cn } from "../utils.js";
export function WebPreview({ children, className, loading, onOpenExternal, onReload, origin, ...props }) {
    return (_jsxs("div", { className: cn("flex size-full min-h-0 flex-col overflow-hidden bg-background", className), "data-slot": "web-preview", ...props, children: [_jsxs("div", { className: "flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2", children: [_jsx(Button, { "aria-label": "Reload the preview", onClick: onReload, size: "icon-sm", variant: "ghost", children: _jsx(RotateCwIcon, { className: cn("size-3.5", loading && "animate-spin motion-reduce:animate-none") }) }), _jsx("span", { className: "min-w-0 flex-1 truncate rounded-full bg-muted/55 px-3 py-1.5 font-mono text-xs text-muted-foreground", children: origin }), _jsx(Button, { "aria-label": "Open the preview in a new tab", onClick: onOpenExternal, size: "icon-sm", variant: "ghost", children: _jsx(ExternalLinkIcon, { className: "size-3.5" }) })] }), _jsxs("div", { className: "relative min-h-0 flex-1", children: [_jsx("div", { className: cn("size-full transition-opacity", loading && "invisible opacity-0"), children: children }), loading ? _jsx("div", { className: "absolute inset-0 flex items-center justify-center text-sm text-muted-foreground", role: "status", children: "Loading preview\u2026" }) : null] })] }));
}
//# sourceMappingURL=web-preview.js.map