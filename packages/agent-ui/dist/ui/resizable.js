"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { GripVerticalIcon } from "lucide-react";
import * as ResizablePrimitive from "react-resizable-panels";
import { cn } from "../utils.js";
function ResizablePanelGroup({ className, ...props }) {
    return (_jsx(ResizablePrimitive.Group, { "data-slot": "resizable-panel-group", className: cn("flex h-full w-full aria-[orientation=vertical]:flex-col", className), ...props }));
}
function ResizablePanel({ ...props }) {
    return _jsx(ResizablePrimitive.Panel, { "data-slot": "resizable-panel", ...props });
}
function ResizableHandle({ withHandle, className, ...props }) {
    return (_jsx(ResizablePrimitive.Separator, { "data-slot": "resizable-handle", className: cn("relative flex w-0 min-w-0 flex-none items-center justify-center bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2 after:bg-transparent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-3 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90", className), ...props, children: withHandle && (_jsx("div", { className: "z-10 flex h-4 w-3 items-center justify-center rounded-xs border bg-border", children: _jsx(GripVerticalIcon, { className: "size-2.5" }) })) }));
}
export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
//# sourceMappingURL=resizable.js.map