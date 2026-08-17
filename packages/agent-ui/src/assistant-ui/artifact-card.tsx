"use client";

import { ArrowUpRightIcon, FileTextIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../utils.js";

/** assistant-ui Artifact Card adapted to the Open Agent theme contract. */
export function ArtifactCard({
  className,
  icon,
  meta,
  title,
  ...props
}: Omit<ComponentProps<"button">, "children" | "title"> & {
  readonly icon?: ReactNode;
  readonly meta: string;
  readonly title: string;
}) {
  return (
    <button
      className={cn(
        "group flex w-full max-w-sm items-center gap-3 rounded-lg bg-muted/45 p-3 text-left transition-colors hover:bg-muted/70 active:bg-muted",
        className,
      )}
      data-slot="artifact-card"
      type="button"
      {...props}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background/75 text-muted-foreground">
        {icon ?? <FileTextIcon className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{meta}</span>
      </span>
      <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}
