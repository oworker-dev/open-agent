"use client";

import { useAuiState } from "@assistant-ui/react";
import { useThreadTokenUsage } from "@assistant-ui/react-ai-sdk";
import type { ThreadTokenUsage } from "@assistant-ui/react-ai-sdk";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover.js";
import { cn } from "../utils.js";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from "react";

const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000)
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${tokens}`;
};

const getUsagePercent = (
  totalTokens: number | undefined,
  modelContextWindow: number,
): number => {
  if (!totalTokens) return 0;
  return Math.min((totalTokens / modelContextWindow) * 100, 100);
};

type UsageSeverity = "normal" | "warning" | "critical";

export type ContextDisplayLabels = {
  readonly cacheWrite: string;
  readonly cachedInput: string;
  readonly contextUsage: string;
  readonly estimatedCost: string;
  readonly input: string;
  readonly of: string;
  readonly output: string;
  readonly reasoning: string;
  readonly sessionUsage: string;
};

const defaultLabels: ContextDisplayLabels = {
  cacheWrite: "Cache write",
  cachedInput: "Cached input",
  contextUsage: "Context usage",
  estimatedCost: "Estimated cost",
  input: "Input",
  of: "of",
  output: "Output",
  reasoning: "Reasoning",
  sessionUsage: "Session usage",
};

const getUsageSeverity = (percent: number): UsageSeverity => {
  if (percent > 85) return "critical";
  if (percent >= 65) return "warning";
  return "normal";
};

const getStrokeColor = (percent: number): string => {
  const severity = getUsageSeverity(percent);
  if (severity === "critical") return "stroke-red-500";
  if (severity === "warning") return "stroke-amber-500";
  return "stroke-foreground";
};

const getBarColor = (percent: number): string => {
  const severity = getUsageSeverity(percent);
  if (severity === "critical") return "bg-red-500";
  if (severity === "warning") return "bg-amber-500";
  return "bg-foreground";
};

type ContextDisplayContextValue = {
  interaction: "hover" | "touch";
  labels: ContextDisplayLabels;
  usage: ExtendedThreadTokenUsage | undefined;
  sessionUsage: ExtendedThreadTokenUsage | undefined;
  totalTokens: number;
  percent: number;
  modelContextWindow: number;
  open: boolean;
  setOpen: (open: boolean) => void;
};

type ExtendedThreadTokenUsage = ThreadTokenUsage & {
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
};

const ContextDisplayContext = createContext<ContextDisplayContextValue | null>(
  null,
);

function useContextDisplay(): ContextDisplayContextValue {
  const ctx = useContext(ContextDisplayContext);
  if (!ctx) {
    throw new Error("ContextDisplay.* must be used within ContextDisplay.Root");
  }
  return ctx;
}

type PresetProps = {
  modelContextWindow: number;
  className?: string;
  label?: string;
  labels?: Partial<ContextDisplayLabels>;
  side?: "top" | "bottom" | "left" | "right";
  usage?: ExtendedThreadTokenUsage | undefined;
  sessionUsage?: ExtendedThreadTokenUsage | undefined;
};

type ContextDisplayRootProps = {
  modelContextWindow: number;
  children: ReactNode;
  labels?: Partial<ContextDisplayLabels>;
  usage?: ExtendedThreadTokenUsage | undefined;
  sessionUsage?: ExtendedThreadTokenUsage | undefined;
};

function ContextDisplayRootBase({
  modelContextWindow,
  children,
  labels: labelOverrides,
  usage,
  sessionUsage,
}: {
  modelContextWindow: number;
  children: ReactNode;
  labels: Partial<ContextDisplayLabels> | undefined;
  usage: ExtendedThreadTokenUsage | undefined;
  sessionUsage: ExtendedThreadTokenUsage | undefined;
}) {
  const threadId = useAuiState((s) => s.threadListItem.id);
  const rawTokens = usage?.totalTokens ?? 0;
  const [interaction, setInteraction] = useState<"hover" | "touch">("hover");
  const [open, setOpen] = useState(false);
  const [tokenState, setTokenState] = useState({
    threadId,
    totalTokens: rawTokens > 0 ? rawTokens : 0,
    usage,
  });

  useEffect(() => {
    const media = window.matchMedia("(hover: none) and (pointer: coarse)");
    const updateInteraction = () => {
      setInteraction(media.matches ? "touch" : "hover");
      setOpen(false);
    };
    updateInteraction();
    media.addEventListener("change", updateInteraction);
    return () => media.removeEventListener("change", updateInteraction);
  }, []);

  useEffect(() => {
    setTokenState((prev) => {
      if (prev.threadId !== threadId) {
        return {
          threadId,
          totalTokens: rawTokens > 0 ? rawTokens : 0,
          usage,
        };
      }
      if (rawTokens > 0 && rawTokens !== prev.totalTokens) {
        return { ...prev, totalTokens: rawTokens, usage };
      }
      if (usage !== prev.usage) {
        return { ...prev, usage };
      }
      return prev;
    });
  }, [threadId, rawTokens, usage]);

  const totalTokens = tokenState.totalTokens;
  const percent = getUsagePercent(totalTokens, modelContextWindow);
  const labels = useMemo(
    () => ({ ...defaultLabels, ...labelOverrides }),
    [labelOverrides],
  );

  const contextValue = useMemo(
    () => ({
      interaction,
      labels,
      usage: tokenState.usage,
      sessionUsage,
      totalTokens,
      percent,
      modelContextWindow,
      open,
      setOpen,
    }),
    [interaction, labels, modelContextWindow, open, percent, sessionUsage, tokenState.usage, totalTokens],
  );

  return (
    <ContextDisplayContext.Provider value={contextValue}>
      {interaction === "touch" ? (
        <Popover open={open} onOpenChange={setOpen}>{children}</Popover>
      ) : (
        <TooltipProvider>
          <Tooltip open={open} onOpenChange={setOpen}>{children}</Tooltip>
        </TooltipProvider>
      )}
    </ContextDisplayContext.Provider>
  );
}

function ContextDisplayRootInternal({
  modelContextWindow,
  children,
  labels,
}: {
  modelContextWindow: number;
  children: ReactNode;
  labels: Partial<ContextDisplayLabels> | undefined;
}) {
  const usage = useThreadTokenUsage();
  return (
    <ContextDisplayRootBase
      modelContextWindow={modelContextWindow}
      labels={labels}
      usage={usage}
      sessionUsage={usage}
    >
      {children}
    </ContextDisplayRootBase>
  );
}

function ContextDisplayRoot(props: ContextDisplayRootProps) {
  if (props.usage !== undefined) {
    return (
      <ContextDisplayRootBase
        modelContextWindow={props.modelContextWindow}
        labels={props.labels}
        usage={props.usage}
        sessionUsage={props.sessionUsage}
      >
        {props.children}
      </ContextDisplayRootBase>
    );
  }
  return (
    <ContextDisplayRootInternal modelContextWindow={props.modelContextWindow} labels={props.labels}>
      {props.children}
    </ContextDisplayRootInternal>
  );
}

function ContextDisplayTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<"button">) {
  const { interaction, open } = useContextDisplay();
  const trigger = (
    <button
      type="button"
      data-slot="context-display-trigger"
      aria-expanded={open}
      className={cn(
        "inline-flex items-center rounded-md transition-colors",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
  return interaction === "touch"
    ? <PopoverTrigger asChild>{trigger}</PopoverTrigger>
    : <TooltipTrigger asChild>{trigger}</TooltipTrigger>;
}

type ContextSegment = {
  label: string;
  tokens: number;
};

const getContextSegments = (
  usage: ExtendedThreadTokenUsage | undefined,
  labels: ContextDisplayLabels,
): ContextSegment[] => {
  if (!usage) return [];
  return [
    { label: labels.input, tokens: usage.inputTokens ?? 0 },
    { label: labels.cachedInput, tokens: usage.cachedInputTokens ?? 0 },
    { label: labels.cacheWrite, tokens: usage.cacheWriteTokens ?? 0 },
    { label: labels.output, tokens: usage.outputTokens ?? 0 },
    { label: labels.reasoning, tokens: usage.reasoningTokens ?? 0 },
  ].filter((segment) => segment.tokens > 0);
};

function ContextDisplayContent({
  side = "top",
  className,
}: {
  side?: "top" | "bottom" | "left" | "right" | undefined;
  className?: string;
}) {
  const { interaction, labels, sessionUsage, totalTokens, percent, modelContextWindow } =
    useContextDisplay();
  const segments = getContextSegments(sessionUsage, labels);
  const content = (
    <div className="text-xs">
      <div className="flex items-baseline justify-between gap-6 whitespace-nowrap">
        <span className="font-medium">{labels.contextUsage}</span>
        <span className="text-muted-foreground tabular-nums">
          {formatTokenCount(Math.min(totalTokens, modelContextWindow))} {labels.of}{" "}
          {formatTokenCount(modelContextWindow)}
        </span>
      </div>
      <div className="bg-muted mt-2.5 h-1 overflow-hidden rounded-full">
        <div
          className={cn(
            "h-full w-(--usage-width) rounded-full transition-[width] duration-300",
            totalTokens > 0 && "min-w-1",
            getBarColor(percent),
          )}
          style={{ "--usage-width": `${percent}%` } as React.CSSProperties}
        />
      </div>
      {segments.length > 0 && (
        <div className="mt-3 grid gap-1.5">
          <span className="font-medium">{labels.sessionUsage}</span>
          {segments.map((segment) => (
            <div
              key={segment.label}
              className="flex items-baseline justify-between gap-6"
            >
              <span className="text-muted-foreground">{segment.label}</span>
              <span className="tabular-nums">
                {formatTokenCount(segment.tokens)}
              </span>
            </div>
          ))}
        </div>
      )}
      {sessionUsage?.costUsd && sessionUsage.costUsd > 0 ? (
        <div className="mt-3 flex items-baseline justify-between gap-6 border-t border-border/50 pt-2">
          <span className="text-muted-foreground">{labels.estimatedCost}</span>
          <span className="tabular-nums">${sessionUsage.costUsd.toFixed(4)}</span>
        </div>
      ) : null}
    </div>
  );
  const contentClassName = cn(
    "bg-popover text-popover-foreground w-52 rounded-lg border p-2.5 text-left shadow-md",
    className,
  );

  return interaction === "touch" ? (
    <PopoverContent
      align="end"
      side={side}
      sideOffset={8}
      data-slot="context-display-popover"
      className={contentClassName}
    >
      {content}
    </PopoverContent>
  ) : (
    <TooltipContent
      side={side}
      sideOffset={8}
      hideArrow
      data-slot="context-display-popover"
      className={contentClassName}
    >
      {content}
    </TooltipContent>
  );
}

const RING_SIZE = 16;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function RingVisual() {
  const { percent } = useContextDisplay();

  return (
    <svg
      aria-hidden="true"
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className="-rotate-90"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        className="stroke-muted-foreground/25"
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={
          RING_CIRCUMFERENCE - (percent / 100) * RING_CIRCUMFERENCE
        }
        className={cn(
          "transition-[stroke-dashoffset,stroke] duration-300",
          getStrokeColor(percent),
        )}
      />
    </svg>
  );
}

const ContextDisplayRing: FC<PresetProps> = ({
  modelContextWindow,
  className,
  label = "Context usage",
  labels,
  side,
  sessionUsage,
  usage,
}) => (
  <ContextDisplayRoot labels={labels} modelContextWindow={modelContextWindow} sessionUsage={sessionUsage} usage={usage}>
    <ContextDisplayTrigger
      className={cn(
        "text-muted-foreground hover:text-foreground gap-1.5 px-1.5 py-1 text-xs",
        className,
      )}
      aria-label={label}
    >
      <RingVisual />
    </ContextDisplayTrigger>
    <ContextDisplayContent side={side} />
  </ContextDisplayRoot>
);

function BarVisual() {
  const { percent, totalTokens } = useContextDisplay();

  return (
    <div className="flex items-center gap-2">
      <div className="bg-muted h-1.5 w-16 overflow-hidden rounded-full">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-300",
            getBarColor(percent),
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-muted-foreground text-[10px] tabular-nums">
        {formatTokenCount(totalTokens)} ({Math.round(percent)}%)
      </span>
    </div>
  );
}

const ContextDisplayBar: FC<PresetProps> = ({
  modelContextWindow,
  className,
  label = "Context usage",
  labels,
  side,
  sessionUsage,
  usage,
}) => (
  <ContextDisplayRoot labels={labels} modelContextWindow={modelContextWindow} sessionUsage={sessionUsage} usage={usage}>
    <ContextDisplayTrigger
      className={cn("px-2 py-1", className)}
      aria-label={label}
    >
      <BarVisual />
    </ContextDisplayTrigger>
    <ContextDisplayContent side={side} />
  </ContextDisplayRoot>
);

function TextVisual() {
  const { totalTokens, modelContextWindow } = useContextDisplay();

  return (
    <>
      {formatTokenCount(totalTokens)} / {formatTokenCount(modelContextWindow)}
    </>
  );
}

const ContextDisplayText: FC<PresetProps> = ({
  modelContextWindow,
  className,
  label = "Context usage",
  labels,
  side,
  sessionUsage,
  usage,
}) => (
  <ContextDisplayRoot labels={labels} modelContextWindow={modelContextWindow} sessionUsage={sessionUsage} usage={usage}>
    <ContextDisplayTrigger
      aria-label={label}
      className={cn(
        "text-muted-foreground hover:bg-accent hover:text-accent-foreground px-2 py-1 font-mono text-xs tabular-nums",
        className,
      )}
    >
      <TextVisual />
    </ContextDisplayTrigger>
    <ContextDisplayContent side={side} />
  </ContextDisplayRoot>
);

const ContextDisplay = {} as {
  Root: typeof ContextDisplayRoot;
  Trigger: typeof ContextDisplayTrigger;
  Content: typeof ContextDisplayContent;
  Ring: typeof ContextDisplayRing;
  Bar: typeof ContextDisplayBar;
  Text: typeof ContextDisplayText;
};

ContextDisplay.Root = ContextDisplayRoot;
ContextDisplay.Trigger = ContextDisplayTrigger;
ContextDisplay.Content = ContextDisplayContent;
ContextDisplay.Ring = ContextDisplayRing;
ContextDisplay.Bar = ContextDisplayBar;
ContextDisplay.Text = ContextDisplayText;

export {
  ContextDisplay,
  ContextDisplayRoot,
  ContextDisplayTrigger,
  ContextDisplayContent,
  ContextDisplayRing,
  ContextDisplayBar,
  ContextDisplayText,
};
