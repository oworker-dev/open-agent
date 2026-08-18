"use client";

import type { MessageStreamEvent } from "eve/client";
import { useState, type Dispatch, type SetStateAction } from "react";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleStopIcon,
  Clock3Icon,
  LoaderCircleIcon,
  NetworkIcon,
  SquareIcon,
  XCircleIcon,
} from "lucide-react";
import { Button } from "../ui/button.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover.js";
import { cn } from "../utils.js";
import type { AgentLocale } from "./i18n.js";
import {
  mergeSubagentSessions,
  type SubagentSessionPresentation,
} from "./turn-presentation.js";
import type { AgentSubagentController, AgentSubagentSummary } from "./contracts.js";

type DisplayedSubagent = SubagentSessionPresentation & { readonly ordinal: number };

export function AgentSubagentMenu({
  activeSessionId,
  events,
  durableSessions = [],
  locale,
  onControl,
  onOpen,
}: {
  readonly activeSessionId?: string;
  readonly events: readonly MessageStreamEvent[];
  readonly durableSessions?: readonly AgentSubagentSummary[];
  readonly locale: AgentLocale;
  readonly onControl?: AgentSubagentController;
  readonly onOpen: (sessionId: string) => void;
}) {
  const [busySessionId, setBusySessionId] = useState<string>();
  const [statusOverrides, setStatusOverrides] = useState<ReadonlyMap<string, SubagentSessionPresentation["status"]>>(new Map());
  const sessions = mergeSubagentSessions(events, durableSessions)
    .filter((session) => session.childSessionId)
    .map((session, index) => ({
      ...session,
      ...(session.childSessionId && statusOverrides.has(session.childSessionId)
        ? { status: statusOverrides.get(session.childSessionId)! }
        : {}),
      ordinal: index + 1,
    }));
  if (sessions.length === 0) return null;
  const active = sessions.filter((session) => isActive(session));
  const done = sessions.filter((session) => !isActive(session));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label={localize(locale, "Open sub-agents", "打开子代理")}
          className="h-8 gap-1.5 px-2.5 text-sm"
          size="sm"
          variant="ghost"
        >
          <NetworkIcon className="size-4" />
          <span className="hidden sm:inline">{localize(locale, "Sub-agents", "子代理")}</span>
          {active.length > 0 ? (
            <span
              aria-label={localize(locale, `${active.length} active`, `${active.length} 个正在执行`)}
              className="min-w-4 text-xs tabular-nums text-muted-foreground"
            >
              {active.length}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-1.5rem))] p-1.5">
        <SubagentGroup
          activeSessionId={activeSessionId}
          label={localize(locale, "Active", "正在执行")}
          locale={locale}
          onOpen={onOpen}
          onControl={onControl}
          busySessionId={busySessionId}
          setBusySessionId={setBusySessionId}
          setStatusOverrides={setStatusOverrides}
          sessions={active}
        />
        <SubagentGroup
          activeSessionId={activeSessionId}
          label={localize(locale, "Done", "已完成")}
          locale={locale}
          onOpen={onOpen}
          onControl={onControl}
          busySessionId={busySessionId}
          setBusySessionId={setBusySessionId}
          setStatusOverrides={setStatusOverrides}
          sessions={done}
        />
      </PopoverContent>
    </Popover>
  );
}

function SubagentGroup({
  activeSessionId,
  label,
  locale,
  onControl,
  busySessionId,
  setBusySessionId,
  setStatusOverrides,
  onOpen,
  sessions,
}: {
  readonly activeSessionId?: string;
  readonly label: string;
  readonly locale: AgentLocale;
  readonly onControl?: AgentSubagentController;
  readonly busySessionId?: string;
  readonly setBusySessionId: (sessionId: string | undefined) => void;
  readonly setStatusOverrides: Dispatch<SetStateAction<ReadonlyMap<string, SubagentSessionPresentation["status"]>>>;
  readonly onOpen: (sessionId: string) => void;
  readonly sessions: readonly DisplayedSubagent[];
}) {
  if (sessions.length === 0) return null;
  return (
    <section className="py-1" aria-label={label}>
      <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">{label}</h3>
      <div className="space-y-0.5">
        {sessions.map((session) => {
          const sessionId = session.childSessionId!;
          return (
            <div
              className={cn(
                "flex w-full items-center gap-1 rounded-sm px-1 py-0.5 transition-colors hover:bg-accent",
                activeSessionId === sessionId && "bg-accent",
              )}
              key={session.callId ?? sessionId}
            >
              <button
                aria-current={activeSessionId === sessionId ? "page" : undefined}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-1.5 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onOpen(sessionId)}
                type="button"
              >
                <SubagentStatusIcon status={session.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {subagentLabel(session, locale)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {session.task ?? statusLabel(session.status, locale)}
                  </span>
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>
              {onControl ? (
                <Button
                  aria-label={controlLabel(session.status, locale)}
                  className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                  disabled={busySessionId === sessionId}
                  onClick={() => {
                    const action = isActive(session) ? "interrupt" : "close";
                    setBusySessionId(sessionId);
                    void onControl({ action, sessionId })
                      .then((next) => {
                        if (next) {
                      setStatusOverrides((current) => new Map(current).set(
                            sessionId,
                            next.status === "interrupted" || next.status === "closed" ? "cancelled" : next.status,
                          ));
                        }
                      })
                      .catch(() => undefined)
                      .finally(() => setBusySessionId(undefined));
                  }}
                  size="icon-sm"
                  title={controlLabel(session.status, locale)}
                  type="button"
                  variant="ghost"
                >
                  {busySessionId === sessionId ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : isActive(session) ? <SquareIcon className="size-3.5" /> : <XCircleIcon className="size-3.5" />}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SubagentStatusIcon({ status }: { readonly status: SubagentSessionPresentation["status"] }) {
  if (status === "running" || status === "starting") {
    return <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />;
  }
  if (status === "completed") {
    return <CheckCircle2Icon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-300" />;
  }
  if (status === "waiting") {
    return <Clock3Icon className="size-4 shrink-0 text-amber-600 dark:text-amber-300" />;
  }
  if (status === "cancelled") {
    return <CircleStopIcon className="size-4 shrink-0 text-muted-foreground" />;
  }
  return <XCircleIcon className="size-4 shrink-0 text-destructive" />;
}

function subagentLabel(
  session: DisplayedSubagent,
  locale: AgentLocale,
): string {
  if (session.name && session.name !== "agent") return session.name;
  return localize(locale, `Sub-agent ${session.ordinal}`, `子代理 ${session.ordinal}`);
}

function statusLabel(
  status: SubagentSessionPresentation["status"],
  locale: AgentLocale,
): string {
  if (status === "completed") return localize(locale, "Completed", "已完成");
  if (status === "cancelled") return localize(locale, "Stopped", "已停止");
  if (status === "failed") return localize(locale, "Failed", "失败");
  if (status === "waiting") return localize(locale, "Waiting for input", "等待消息");
  return localize(locale, "Working", "正在执行");
}

function isActive(session: SubagentSessionPresentation): boolean {
  return session.status === "running" || session.status === "starting" || session.status === "waiting";
}

function controlLabel(status: SubagentSessionPresentation["status"], locale: AgentLocale): string {
  return isActive({ status, callId: "control" })
    ? localize(locale, "Stop sub-agent", "停止子代理")
    : localize(locale, "Close sub-agent", "关闭子代理");
}

function localize(locale: AgentLocale, english: string, chinese: string): string {
  return locale === "zh-CN" ? chinese : english;
}
