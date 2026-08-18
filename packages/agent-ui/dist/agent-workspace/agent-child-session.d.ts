import type { MessageStreamEvent } from "eve/client";
import type { AgentModelOption, AgentPromptMenuItem, AgentSessionDeliverable, AgentThreadPreferences, AgentWorkspaceClientConfig, AgentWorkspaceMailbox } from "./contracts.js";
import type { AgentLocale } from "./i18n.js";
import { type AgentThreadStorage } from "./thread-storage.js";
export declare function AgentChildSessionView({ client, commands, locale, mailbox, mentions, models, onEvent, onOpenDeliverable, onOpenSubagent, onStorageError, preferences, providerReady, reasoningLevels, sessionId, storageKey, threadStorage, }: {
    readonly client?: AgentWorkspaceClientConfig;
    readonly commands: readonly AgentPromptMenuItem[];
    readonly locale: AgentLocale;
    readonly mailbox?: AgentWorkspaceMailbox;
    readonly mentions: readonly AgentPromptMenuItem[];
    readonly models: readonly AgentModelOption[];
    readonly onEvent?: (event: MessageStreamEvent) => void;
    readonly onOpenDeliverable?: (deliverable: AgentSessionDeliverable) => void;
    readonly onOpenSubagent?: (sessionId: string) => void;
    readonly onStorageError?: (error: unknown) => void;
    readonly preferences: AgentThreadPreferences;
    readonly providerReady?: boolean;
    readonly reasoningLevels: readonly string[];
    readonly sessionId: string;
    readonly storageKey?: string;
    readonly threadStorage?: AgentThreadStorage;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=agent-child-session.d.ts.map