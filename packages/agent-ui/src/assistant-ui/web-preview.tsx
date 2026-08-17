"use client";

import { ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "../ui/button.js";
import { cn } from "../utils.js";

/**
 * assistant-ui Web Preview chrome. The caller owns iframe sandboxing and URL
 * authorization; this component only presents the controls and loading state.
 */
export function WebPreview({
  children,
  className,
  loading,
  onOpenExternal,
  onReload,
  origin,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  readonly children: ReactNode;
  readonly loading: boolean;
  readonly onOpenExternal?: () => void;
  readonly onReload?: () => void;
  readonly origin: string;
}) {
  return (
    <div className={cn("flex size-full min-h-0 flex-col overflow-hidden bg-background", className)} data-slot="web-preview" {...props}>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        <Button aria-label="Reload the preview" onClick={onReload} size="icon-sm" variant="ghost">
          <RotateCwIcon className={cn("size-3.5", loading && "animate-spin motion-reduce:animate-none")} />
        </Button>
        <span className="min-w-0 flex-1 truncate rounded-full bg-muted/55 px-3 py-1.5 font-mono text-xs text-muted-foreground">{origin}</span>
        <Button aria-label="Open the preview in a new tab" onClick={onOpenExternal} size="icon-sm" variant="ghost">
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className={cn("size-full transition-opacity", loading && "invisible opacity-0")}>{children}</div>
        {loading ? <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground" role="status">Loading preview…</div> : null}
      </div>
    </div>
  );
}
