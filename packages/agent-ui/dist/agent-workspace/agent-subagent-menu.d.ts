import type { MessageStreamEvent } from "eve/client";
import type { AgentLocale } from "./i18n.js";
import type { AgentSubagentController, AgentSubagentSummary } from "./contracts.js";
export declare function AgentSubagentMenu({ activeSessionId, events, durableSessions, locale, onControl, onOpen, }: {
    readonly activeSessionId?: string;
    readonly events: readonly MessageStreamEvent[];
    readonly durableSessions?: readonly AgentSubagentSummary[];
    readonly locale: AgentLocale;
    readonly onControl?: AgentSubagentController;
    readonly onOpen: (sessionId: string) => void;
}): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=agent-subagent-menu.d.ts.map