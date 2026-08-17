"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ArrowUpRightIcon, FileTextIcon } from "lucide-react";
import { cn } from "../utils.js";
export function ArtifactCard({ className, icon, meta, title, ...props }) {
    return (_jsxs("button", { className: cn("group flex w-full max-w-sm items-center gap-3 rounded-lg bg-muted/45 p-3 text-left transition-colors hover:bg-muted/70 active:bg-muted", className), "data-slot": "artifact-card", type: "button", ...props, children: [_jsx("span", { className: "flex size-9 shrink-0 items-center justify-center rounded-md bg-background/75 text-muted-foreground", children: icon ?? _jsx(FileTextIcon, { className: "size-4" }) }), _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block truncate text-sm font-medium", children: title }), _jsx("span", { className: "mt-0.5 block truncate text-xs text-muted-foreground", children: meta })] }), _jsx(ArrowUpRightIcon, { className: "size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" })] }));
}
//# sourceMappingURL=artifact-card.js.map