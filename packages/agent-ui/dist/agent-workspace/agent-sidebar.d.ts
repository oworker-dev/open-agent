import type { AgentThread } from "./contracts.js";
import type { AgentLocale, AgentMessages } from "./i18n.js";
export declare function AgentSidebar({ activeThreadId, brand, deletingThreadIds, hostFooter, locale, messages, onClose, onDelete, onNew, onRename, onSelect, onSettings, open, threads, variant, }: {
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
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=agent-sidebar.d.ts.map