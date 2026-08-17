"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AssistantRuntimeProvider, ThreadListItemPrimitive, ThreadListPrimitive, useAuiState, useExternalStoreRuntime, } from "@assistant-ui/react";
import { LoaderCircleIcon, MoreHorizontalIcon, PencilIcon, SearchIcon, Settings2Icon, SparklesIcon, SquarePenIcon, Trash2Icon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, } from "../ui/dropdown-menu.js";
import { cn } from "../utils.js";
export function AgentSidebar({ activeThreadId, brand, deletingThreadIds, hostFooter, locale, messages, onClose, onDelete, onNew, onRename, onSelect, onSettings, open, threads, variant = "mobile", }) {
    const [searchOpen, setSearchOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [editingThreadId, setEditingThreadId] = useState();
    const [editingTitle, setEditingTitle] = useState("");
    const filteredThreads = useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase(locale);
        if (normalizedQuery.length === 0)
            return threads;
        return threads.filter((thread) => thread.title.toLocaleLowerCase(locale).includes(normalizedQuery));
    }, [locale, query, threads]);
    const listRuntime = useExternalStoreRuntime({
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
                    status: "regular",
                })),
            },
        },
        messages: [],
        onNew: async () => undefined,
    });
    return (_jsxs(AssistantRuntimeProvider, { runtime: listRuntime, children: [variant === "mobile" ? _jsx("div", { className: cn("fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px] lg:hidden", open ? "block" : "hidden"), onClick: onClose }) : null, _jsx("aside", { "aria-label": messages.threads, className: cn("overflow-hidden border-0 bg-sidebar text-sidebar-foreground", variant === "desktop" || variant === "floating"
                    ? "h-full w-full"
                    : "fixed inset-y-0 left-0 z-40 w-[min(84vw,320px)] shadow-xl transition-transform duration-200 lg:hidden", variant === "mobile" && (open ? "translate-x-0" : "-translate-x-full")), children: _jsxs("div", { className: "flex h-full min-w-0 flex-col", children: [_jsxs("div", { className: "flex h-12 items-center justify-between px-3 lg:h-13", children: [_jsxs("div", { className: "flex min-w-0 items-center gap-2 font-semibold", children: [_jsx("span", { className: "flex size-7 items-center justify-center rounded-md bg-foreground text-background", children: _jsx(SparklesIcon, { className: "size-4" }) }), _jsx("span", { className: "truncate", children: brand })] }), _jsxs("div", { className: "flex items-center gap-0.5", children: [_jsx(Button, { "aria-label": messages.search, onClick: () => setSearchOpen((open) => !open), size: "icon-sm", variant: "ghost", children: _jsx(SearchIcon, { className: "size-4" }) }), variant === "mobile" ? _jsx(Button, { "aria-label": messages.closeNavigation, onClick: onClose, size: "icon-sm", variant: "ghost", children: _jsx(XIcon, { className: "size-4" }) }) : null] })] }), _jsxs("div", { className: "space-y-1 px-2", children: [_jsxs(Button, { className: "h-9 w-full justify-start gap-2 px-2 text-sm", onClick: onNew, variant: "ghost", children: [_jsx(SquarePenIcon, { className: "size-4" }), messages.newTask] }), searchOpen ? (_jsxs("div", { className: "relative", children: [_jsx(SearchIcon, { className: "absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" }), _jsx(Input, { autoFocus: true, className: "h-9 bg-background pl-8 pr-8 text-sm", onChange: (event) => setQuery(event.target.value), placeholder: messages.searchPlaceholder, value: query }), _jsx(Button, { "aria-label": messages.closeNavigation, className: "absolute right-0.5 top-0.5", onClick: () => { setQuery(""); setSearchOpen(false); }, size: "icon-sm", variant: "ghost", children: _jsx(XIcon, { className: "size-3.5" }) })] })) : null] }), _jsxs("div", { className: "mt-5 min-h-0 flex-1 overflow-y-auto px-2 pb-4", children: [_jsx("p", { className: "px-2 pb-1.5 text-xs font-medium text-muted-foreground", children: messages.threads }), threads.length === 0 ? _jsx("p", { className: "px-2 text-muted-foreground text-sm", children: messages.noThreads }) : null, threads.length > 0 && filteredThreads.length === 0 ? _jsx("p", { className: "px-2 text-muted-foreground text-sm", children: messages.noSearchResults }) : null, _jsx(SidebarThreadItems, { activeThreadId: activeThreadId, deletingThreadIds: deletingThreadIds, editingThreadId: editingThreadId, editingTitle: editingTitle, messages: messages, onDelete: onDelete, onRename: onRename, setEditingThreadId: setEditingThreadId, setEditingTitle: setEditingTitle, threads: filteredThreads })] }), _jsxs("div", { className: "border-t border-sidebar-border p-2", children: [hostFooter, _jsxs(Button, { className: "h-9 w-full justify-start gap-2 px-2 text-muted-foreground", onClick: onSettings, variant: "ghost", children: [_jsx(Settings2Icon, { className: "size-4" }), messages.settings] })] })] }) })] }));
}
function SidebarThreadItems({ activeThreadId, deletingThreadIds, editingThreadId, editingTitle, messages, onDelete, onRename, setEditingThreadId, setEditingTitle, threads, }) {
    const runtimeThreadIds = useAuiState((state) => state.threads.threadIds);
    const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
    return (_jsx(ThreadListPrimitive.Root, { className: "space-y-0.5", children: runtimeThreadIds.map((threadId, index) => {
            const thread = threadsById.get(threadId);
            if (!thread)
                return null;
            return (_jsx(ThreadListPrimitive.ItemByIndex, { components: {
                    ThreadListItem: () => (_jsxs(ThreadListItemPrimitive.Root, { className: cn("group relative flex min-h-9 items-center gap-0.5 overflow-hidden rounded-md border border-transparent transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground", thread.id === activeThreadId && "border-sidebar-ring/40 bg-sidebar-primary/[0.08] text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary"), children: [editingThreadId === thread.id ? (_jsx(Input, { "aria-label": messages.renameThread, autoFocus: true, className: "m-1 h-9 min-w-0 flex-1 bg-background text-sm", onBlur: () => {
                                    onRename(thread.id, editingTitle);
                                    setEditingThreadId(undefined);
                                }, onChange: (event) => setEditingTitle(event.target.value), onKeyDown: (event) => {
                                    if (event.key === "Enter")
                                        event.currentTarget.blur();
                                    if (event.key === "Escape") {
                                        setEditingThreadId(undefined);
                                        setEditingTitle("");
                                    }
                                }, value: editingTitle })) : _jsx(ThreadListItemPrimitive.Trigger, { "aria-current": thread.id === activeThreadId ? "page" : undefined, className: cn("h-9 min-w-0 flex-1 rounded-md px-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50", thread.id === activeThreadId && "font-medium text-foreground"), onDoubleClick: () => {
                                    setEditingThreadId(thread.id);
                                    setEditingTitle(thread.title);
                                }, children: _jsxs("span", { className: "flex items-center gap-2", children: [_jsx("span", { className: cn("size-1.5 shrink-0 rounded-full", thread.status === "error" ? "bg-destructive" : thread.status === "waiting" ? "bg-amber-500" : thread.status === "streaming" || thread.status === "submitted" ? "bg-emerald-500" : "bg-transparent") }), _jsx("span", { className: "truncate", children: thread.title })] }) }), editingThreadId !== thread.id ? (_jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx(Button, { "aria-label": messages.threadActions, className: "mr-1 opacity-70 hover:bg-transparent group-hover:opacity-100 sm:opacity-0", disabled: deletingThreadIds.has(thread.id), size: "icon-sm", variant: "ghost", children: deletingThreadIds.has(thread.id) ? _jsx(LoaderCircleIcon, { className: "size-3.5 animate-spin" }) : _jsx(MoreHorizontalIcon, { className: "size-4" }) }) }), _jsxs(DropdownMenuContent, { align: "end", children: [_jsxs(DropdownMenuItem, { onSelect: () => {
                                                    setEditingThreadId(thread.id);
                                                    setEditingTitle(thread.title);
                                                }, children: [_jsx(PencilIcon, { className: "size-4" }), messages.renameThread] }), _jsxs(DropdownMenuItem, { className: "text-destructive focus:text-destructive", onSelect: () => onDelete(thread.id), children: [_jsx(Trash2Icon, { className: "size-4" }), messages.deleteThread] })] })] })) : null] })),
                }, index: index }, thread.id));
        }) }));
}
//# sourceMappingURL=agent-sidebar.js.map