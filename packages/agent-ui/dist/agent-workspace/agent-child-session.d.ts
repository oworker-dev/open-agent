import type { MessageStreamEvent } from "eve/client";
import type { AgentModelOption, AgentPromptMenuItem, AgentThreadPreferences, AgentWorkspaceClientConfig, AgentWorkspaceMailbox } from "./contracts.js";
import type { AgentLocale } from "./i18n.js";
export declare function AgentChildSessionView({ client, commands, locale, mailbox, mentions, models, onEvent, onOpenSubagent, preferences, reasoningLevels, sessionId, }: {
    readonly client?: AgentWorkspaceClientConfig;
    readonly commands: readonly AgentPromptMenuItem[];
    readonly locale: AgentLocale;
    readonly mailbox?: AgentWorkspaceMailbox;
    readonly mentions: readonly AgentPromptMenuItem[];
    readonly models: readonly AgentModelOption[];
    readonly onEvent?: (event: MessageStreamEvent) => void;
    readonly onOpenSubagent?: (sessionId: string) => void;
    readonly preferences: AgentThreadPreferences;
    readonly reasoningLevels: readonly string[];
    readonly sessionId: string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=agent-child-session.d.ts.map