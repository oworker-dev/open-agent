import { type MessageStreamEvent } from "eve/client";
import type { AgentAssetEndpoint, AgentDeliverableEndpoint, AgentModelOption, AgentSessionAsset, AgentSessionDeliverable, AgentSubagentController, AgentSubagentLoader, AgentThread, AgentThreadPreferences, AgentWorkspaceClientConfig, AgentWorkspaceMailbox } from "./contracts.js";
import { type AgentThreadStorage } from "./thread-storage.js";
export declare function AgentWorkspace({ assetEndpoint, client, commands, defaultPreferences, deliverableEndpoint, extensions, hostSlots, initialSubagentSessionId, initialThreadId, loadSubagents, controlSubagent, mailbox, models, mentions, onEvent, onOpenAsset, onDeleteThread, onActiveSubagentChange, onActiveThreadChange, onOpenDeliverable, onStorageError, productName, reasoningLevels, runtimeStatus, storageKey, threadStorage, }: {
    readonly agentName?: string;
    readonly assetEndpoint?: AgentAssetEndpoint;
    readonly client?: AgentWorkspaceClientConfig;
    readonly commands?: readonly import("./contracts.js").AgentPromptMenuItem[];
    readonly defaultPreferences: AgentThreadPreferences;
    readonly deliverableEndpoint?: AgentDeliverableEndpoint;
    readonly extensions?: readonly import("./contracts.js").AgentExtensionInfo[];
    readonly hostSlots?: {
        readonly sidebarFooter?: React.ReactNode;
        readonly threadHeaderEnd?: React.ReactNode;
    };
    readonly initialSubagentSessionId?: string;
    readonly initialThreadId?: string;
    readonly mailbox?: AgentWorkspaceMailbox;
    readonly loadSubagents?: AgentSubagentLoader;
    readonly controlSubagent?: AgentSubagentController;
    readonly models: readonly AgentModelOption[];
    readonly mentions?: readonly import("./contracts.js").AgentPromptMenuItem[];
    readonly onEvent?: (event: MessageStreamEvent) => void;
    readonly onOpenAsset?: (asset: AgentSessionAsset) => void;
    readonly onDeleteThread?: (thread: AgentThread) => void | Promise<void>;
    readonly onActiveSubagentChange?: (threadId: string, sessionId?: string) => void;
    readonly onActiveThreadChange?: (threadId?: string) => void;
    readonly onOpenDeliverable?: (deliverable: AgentSessionDeliverable) => void;
    readonly onStorageError?: (error: unknown) => void;
    readonly productName?: string;
    readonly reasoningLevels: readonly string[];
    readonly runtimeStatus?: import("./contracts.js").AgentRuntimeStatus;
    readonly storageKey?: string;
    readonly threadStorage?: AgentThreadStorage;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=agent-workspace.d.ts.map