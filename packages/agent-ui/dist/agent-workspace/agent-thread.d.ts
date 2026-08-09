import { type MessageStreamEvent } from "eve/client";
import type { AgentModelOption, AgentPromptMenuItem, AgentQueuedTurn, AgentThread, AgentThreadPatch, AgentWorkspaceClientConfig, AgentWorkspaceMailbox } from "./contracts.js";
import { type AgentLocale, type AgentMessages } from "./i18n.js";
export declare function AgentThreadView({ client, commands, draftStorageKey, isRecovering, locale, mailbox, mentions, models, onChange, onCancelRecovery, onEvent, onOpenSubagent, onRetryRecovery, onRecoveryNeeded, providerReady, recoveryError, reasoningLevels, thread, }: {
    readonly client?: AgentWorkspaceClientConfig;
    readonly commands: readonly AgentPromptMenuItem[];
    readonly draftStorageKey: string;
    readonly isRecovering?: boolean;
    readonly locale: AgentLocale;
    readonly mailbox?: AgentWorkspaceMailbox;
    readonly mentions: readonly AgentPromptMenuItem[];
    readonly models: readonly AgentModelOption[];
    readonly onChange: (patch: AgentThreadPatch) => void;
    readonly onCancelRecovery?: () => void;
    readonly onEvent?: (event: MessageStreamEvent) => void;
    readonly onOpenSubagent?: (sessionId: string) => void;
    readonly onRetryRecovery?: () => void;
    readonly onRecoveryNeeded: () => void;
    readonly providerReady: boolean;
    readonly recoveryError?: string;
    readonly reasoningLevels: readonly string[];
    readonly thread: AgentThread;
}): import("react/jsx-runtime").JSX.Element;
export declare function FollowUpQueue({ error, messages, onRemove, onRetry, turns, }: {
    readonly error?: string;
    readonly messages: AgentMessages;
    readonly onRemove: (turnId: string) => void;
    readonly onRetry: (turnId: string) => void;
    readonly turns: readonly AgentQueuedTurn[];
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=agent-thread.d.ts.map