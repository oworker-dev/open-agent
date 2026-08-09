"use client";

import {
  AssistantRuntimeProvider,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type ThreadMessage,
} from "@assistant-ui/react";
import { LoaderCircleIcon, MoreHorizontalIcon, PencilIcon, SearchIcon, Settings2Icon, SparklesIcon, SquarePenIcon, Trash2Icon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.js";
import { cn } from "../utils.js";
import type { AgentThread } from "./contracts.js";
import type { AgentLocale, AgentMessages } from "./i18n.js";

export function AgentSidebar({
  activeThreadId,
  brand,
  deletingThreadIds,
  hostFooter,
  locale,
  messages,
  onClose,
  onDelete,
  onNew,
  onRename,
  onSelect,
  onSettings,
  open,
  threads,
  variant = "mobile",
}: {
  readonly activeThreadId: string | undefined;
  readonly brand: string;
  readonly deletingThreadIds: ReadonlySet<string>;
  readonly hostFooter?: React.ReactNode;
  readonly locale: AgentLocale;
  readonly messages: AgentMessages;
  readonly onClose: () => void;
  readonly onDelete: (threadId: string) => void;
  readonly onNew: () => void;
  readonly onRename: (threadId: string, title: string) => void;
  readonly onSelect: (threadId: string) => void;
  readonly onSettings: () => void;
  readonly open: boolean;
  readonly threads: readonly AgentThread[];
  readonly variant?: "desktop" | "floating" | "mobile";
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editingThreadId, setEditingThreadId] = useState<string>();
  const [editingTitle, setEditingTitle] = useState("");
  const filteredThreads = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(locale);
    if (normalizedQuery.length === 0) return threads;
    return threads.filter((thread) => thread.title.toLocaleLowerCase(locale).includes(normalizedQuery));
  }, [locale, query, threads]);
  const listRuntime = useExternalStoreRuntime<ThreadMessage>({
    adapters: {
      threadList: {
        onDelete: async (threadId) => onDelete(threadId),
        onRename: async (threadId, title) => onRename(threadId, title),
        onSwitchToNewThread: async () => onNew(),
        onSwitchToThread: async (threadId) => onSelect(threadId),
        threadId: activeThreadId,
        threads: threads.map((thread) => ({
          custom: { agentStatus: thread.status },
          id: thread.id,
          title: thread.title,
          status: "regular" as const,
        })),
      },
    },
    messages: [],
    onNew: async () => undefined,
  });

  return (
    <AssistantRuntimeProvider runtime={listRuntime}>
      {variant === "mobile" ? <div className={cn("fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px] lg:hidden", open ? "block" : "hidden")} onClick={onClose} /> : null}
      <aside aria-label={messages.threads} className={cn(
        "overflow-hidden border-0 bg-sidebar text-sidebar-foreground",
        variant === "desktop" || variant === "floating"
          ? "h-full w-full"
          : "fixed inset-y-0 left-0 z-40 w-[min(84vw,320px)] shadow-xl transition-transform duration-200 lg:hidden",
        variant === "mobile" && (open ? "translate-x-0" : "-translate-x-full"),
      )}>
        <div className="flex h-full min-w-0 flex-col">
          <div className="flex h-12 items-center justify-between px-3 lg:h-13">
            <div className="flex min-w-0 items-center gap-2 font-semibold">
              <span className="flex size-7 items-center justify-center rounded-md bg-foreground text-background"><SparklesIcon className="size-4" /></span>
              <span className="truncate">{brand}</span>
            </div>
            <div className="flex items-center gap-0.5">
              <Button aria-label={messages.search} onClick={() => setSearchOpen((open) => !open)} size="icon-sm" variant="ghost"><SearchIcon className="size-4" /></Button>
              {variant === "mobile" ? <Button aria-label={messages.closeNavigation} onClick={onClose} size="icon-sm" variant="ghost"><XIcon className="size-4" /></Button> : null}
            </div>
          </div>
          <div className="space-y-1 px-2">
            <Button className="h-9 w-full justify-start gap-2 px-2 text-sm" onClick={onNew} variant="ghost"><SquarePenIcon className="size-4" />{messages.newTask}</Button>
            {searchOpen ? (
              <div className="relative">
                <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input autoFocus className="h-9 bg-background pl-8 pr-8 text-sm" onChange={(event) => setQuery(event.target.value)} placeholder={messages.searchPlaceholder} value={query} />
                <Button aria-label={messages.closeNavigation} className="absolute right-0.5 top-0.5" onClick={() => { setQuery(""); setSearchOpen(false); }} size="icon-sm" variant="ghost"><XIcon className="size-3.5" /></Button>
              </div>
            ) : null}
          </div>
          <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            <p className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">{messages.threads}</p>
            {threads.length === 0 ? <p className="px-2 text-muted-foreground text-sm">{messages.noThreads}</p> : null}
            {threads.length > 0 && filteredThreads.length === 0 ? <p className="px-2 text-muted-foreground text-sm">{messages.noSearchResults}</p> : null}
            <SidebarThreadItems
              activeThreadId={activeThreadId}
              deletingThreadIds={deletingThreadIds}
              editingThreadId={editingThreadId}
              editingTitle={editingTitle}
              messages={messages}
              onDelete={onDelete}
              onRename={onRename}
              setEditingThreadId={setEditingThreadId}
              setEditingTitle={setEditingTitle}
              threads={filteredThreads}
            />
          </div>
          <div className="border-t border-sidebar-border p-2">
            {hostFooter}
            <Button className="h-9 w-full justify-start gap-2 px-2 text-muted-foreground" onClick={onSettings} variant="ghost"><Settings2Icon className="size-4" />{messages.settings}</Button>
          </div>
        </div>
      </aside>
    </AssistantRuntimeProvider>
  );
}

function SidebarThreadItems({
  activeThreadId,
  deletingThreadIds,
  editingThreadId,
  editingTitle,
  messages,
  onDelete,
  onRename,
  setEditingThreadId,
  setEditingTitle,
  threads,
}: {
  readonly activeThreadId?: string;
  readonly deletingThreadIds: ReadonlySet<string>;
  readonly editingThreadId?: string;
  readonly editingTitle: string;
  readonly messages: AgentMessages;
  readonly onDelete: (threadId: string) => void;
  readonly onRename: (threadId: string, title: string) => void;
  readonly setEditingThreadId: (threadId: string | undefined) => void;
  readonly setEditingTitle: (title: string) => void;
  readonly threads: readonly AgentThread[];
}) {
  const runtimeThreadIds = useAuiState((state) => state.threads.threadIds);
  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);

  return (
    <ThreadListPrimitive.Root className="space-y-0.5">
      {runtimeThreadIds.map((threadId, index) => {
        const thread = threadsById.get(threadId);
        if (!thread) return null;
        return (
          <ThreadListPrimitive.ItemByIndex
            components={{
              ThreadListItem: () => (
                <ThreadListItemPrimitive.Root
                  className={cn(
                    "group relative flex min-h-9 items-center gap-0.5 rounded-md transition-colors hover:bg-foreground/[0.045]",
                    thread.id === activeThreadId && "bg-foreground/[0.045] text-foreground",
                  )}
                >
                  {editingThreadId === thread.id ? (
                    <Input
                      aria-label={messages.renameThread}
                      autoFocus
                      className="m-1 h-9 min-w-0 flex-1 bg-background text-sm"
                      onBlur={() => {
                        onRename(thread.id, editingTitle);
                        setEditingThreadId(undefined);
                      }}
                      onChange={(event) => setEditingTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") {
                          setEditingThreadId(undefined);
                          setEditingTitle("");
                        }
                      }}
                      value={editingTitle}
                    />
                  ) : <ThreadListItemPrimitive.Trigger
                    aria-current={thread.id === activeThreadId ? "page" : undefined}
                    className={cn("h-9 min-w-0 flex-1 rounded-md px-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50", thread.id === activeThreadId && "font-medium text-foreground")}
                    onDoubleClick={() => {
                      setEditingThreadId(thread.id);
                      setEditingTitle(thread.title);
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <span className={cn("size-1.5 shrink-0 rounded-full", thread.status === "error" ? "bg-destructive" : thread.status === "waiting" ? "bg-amber-500" : thread.status === "streaming" || thread.status === "submitted" ? "bg-emerald-500" : "bg-transparent")} />
                      <span className="truncate">{thread.title}</span>
                    </span>
                  </ThreadListItemPrimitive.Trigger>}
                  {editingThreadId !== thread.id ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button aria-label={messages.threadActions} className="mr-1 opacity-70 hover:bg-transparent group-hover:opacity-100 sm:opacity-0" disabled={deletingThreadIds.has(thread.id)} size="icon-sm" variant="ghost">
                          {deletingThreadIds.has(thread.id) ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <MoreHorizontalIcon className="size-4" />}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => {
                          setEditingThreadId(thread.id);
                          setEditingTitle(thread.title);
                        }}><PencilIcon className="size-4" />{messages.renameThread}</DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDelete(thread.id)}><Trash2Icon className="size-4" />{messages.deleteThread}</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </ThreadListItemPrimitive.Root>
              ),
            }}
            index={index}
            key={thread.id}
          />
        );
      })}
    </ThreadListPrimitive.Root>
  );
}
