import type { AgentLocale } from "./i18n.js";

export function AgentHistoryLoading({ locale }: { readonly locale: AgentLocale }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-10" data-agent-history-loading role="status">
      <span className="sr-only">{locale === "zh-CN" ? "正在加载会话消息…" : "Loading conversation…"}</span>
      <div aria-hidden="true" className="h-12 w-2/3 animate-pulse self-end rounded-xl bg-muted" />
      <div aria-hidden="true" className="space-y-3">
        <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
        <div className="h-4 w-3/5 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}
