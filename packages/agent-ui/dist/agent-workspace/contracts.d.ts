import type { ClientAuth, ClientRedirectPolicy, MessageStreamEvent, HeadersValue, PrepareSend } from "eve/client";
import type { ReactNode } from "react";
import type { AgentThreadStorage } from "./thread-storage.js";
export type AgentThreadStatus = "cancelling" | "error" | "ready" | "streaming" | "submitted" | "waiting";
export type AgentExecutionMode = "automation" | "cautious" | "standard";
export type AgentThreadPreferences = {
    readonly executionMode?: AgentExecutionMode;
    readonly modelId: string;
    readonly reasoning: string;
};
export type AgentPendingTurn = {
    readonly files?: PromptInputMessage["files"];
    readonly id: string;
    readonly state: "clearing" | "delivery-failed" | "interrupted" | "resubmitting" | "submitting";
    readonly submittedAt: number;
    readonly text: string;
};
export type AgentComposerDraftRestore = {
    readonly id: string;
    readonly text: string;
};
export type AgentInterruptedTurn = {
    readonly eventCount: number;
    readonly streamIndex: number;
    readonly turnId: string;
    readonly settled?: boolean;
};
export type AgentQueuedTurn = {
    readonly delivery?: "browser" | "server";
    readonly expectedTurnId?: string;
    readonly id: string;
    readonly intent?: "active-turn" | "post-cancellation";
    readonly mailboxItemId?: string;
    readonly state: "accepted" | "admission-ambiguous" | "committed" | "delivering" | "delivery-failed" | "queued";
    readonly submittedAt: number;
    readonly text: string;
};
export type AgentMailboxItemStatus = "accepted" | "cancelled" | "committed" | "delivering" | "failed" | "queued" | "submission-ambiguous";
export type AgentMailboxReceipt = {
    readonly clientMessageId: string;
    readonly itemId: string;
    readonly lastError?: string;
    readonly status: AgentMailboxItemStatus;
};
export interface AgentWorkspaceMailbox {
    cancel(itemId: string): Promise<AgentMailboxReceipt>;
    enqueue(input: {
        readonly clientMessageId: string;
        readonly clientContext?: readonly string[];
        readonly expectedTurnId?: string;
        readonly message: string;
        readonly operationId: string;
        readonly operationKind: "send" | "steer";
        readonly preferences: AgentThreadPreferences;
        readonly sessionId: string;
    }): Promise<AgentMailboxReceipt>;
    inspect(itemId: string): Promise<AgentMailboxReceipt>;
    retry(itemId: string): Promise<AgentMailboxReceipt>;
}
export type AgentModelOption = {
    readonly contextWindowTokens: number;
    readonly id: string;
    readonly label: string;
};
export type AgentPromptMenuItem = {
    readonly description?: string;
    readonly id: string;
    readonly keywords?: readonly string[];
    readonly label: string;
    readonly translations?: Partial<Record<"en" | "zh-CN", {
        readonly description?: string;
        readonly label?: string;
    }>>;
    readonly value: string;
};
export type PromptInputMessage = {
    readonly files: readonly {
        readonly assetId?: string;
        readonly filename?: string;
        readonly mediaType: string;
        readonly sizeBytes?: number;
        readonly url: string;
    }[];
    readonly text: string;
};
export type AgentExtensionInfo = {
    readonly description?: string;
    readonly id: string;
    readonly kind: "mcp" | "skill";
    readonly label: string;
    readonly status: "available" | "disabled" | "unconfigured";
    readonly version?: string;
};
export type AgentSubagentSummary = {
    readonly callId?: string;
    readonly childSessionId: string;
    readonly name?: string;
    readonly nickname?: string;
    readonly status: "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted" | "closed";
    readonly task?: string;
};
export type AgentSubagentControlAction = "close" | "interrupt" | "wait";
export type AgentSubagentController = (input: {
    readonly action: AgentSubagentControlAction;
    readonly sessionId: string;
}) => Promise<AgentSubagentSummary | undefined>;
export type AgentSubagentLoader = (parentSessionId: string) => Promise<readonly AgentSubagentSummary[]>;
export type AgentSessionBoundary = {
    readonly lastEventAt?: string;
    readonly tailIndex?: number;
    readonly state: "running" | "waiting" | "terminal";
    readonly terminalStatus?: "completed" | "failed";
    readonly turnId?: string;
};
export type AgentSessionInspector = (sessionId: string) => Promise<AgentSessionBoundary>;
export type AgentTranscriptCoverage = {
    readonly authoritative?: boolean;
    readonly complete: boolean;
    readonly endIndex: number;
    readonly startIndex: number;
    readonly version: 1;
};
export type AgentTranscriptWindow = {
    readonly endIndex: number;
    readonly hasMoreBefore: boolean;
    readonly startIndex: number;
    readonly total: number;
};
export type AgentRuntimeStatus = {
    readonly provider: "mock" | "ready" | "unconfigured";
};
export type AgentThreadSessionState = {
    readonly sessionId?: string;
    readonly streamIndex: number;
};
export type AgentThread = {
    readonly createdAt: number;
    readonly closedInputRequestIds: readonly string[];
    readonly events: readonly MessageStreamEvent[];
    readonly draftRestore?: AgentComposerDraftRestore;
    readonly hydration?: "summary";
    readonly id: string;
    readonly interruptedTurns?: readonly AgentInterruptedTurn[];
    readonly pendingTurn?: AgentPendingTurn;
    readonly preferences: AgentThreadPreferences;
    readonly retainedContext?: readonly string[];
    readonly queuedTurns: readonly AgentQueuedTurn[];
    readonly revision?: number;
    readonly session: AgentThreadSessionState;
    readonly status: AgentThreadStatus;
    readonly transcriptCoverage?: AgentTranscriptCoverage;
    readonly transcriptWindow?: AgentTranscriptWindow;
    readonly title: string;
    readonly updatedAt: number;
};
export type AgentThreadPatch = Partial<Omit<AgentThread, "id">>;
export type AgentWorkspaceHostSlots = {
    readonly sidebarFooter?: ReactNode;
    readonly threadHeaderEnd?: ReactNode;
};
export type AgentWorkspaceClientConfig = {
    readonly assetUpload?: AgentAssetUploadAdapter;
    readonly assetUrl?: (assetId: string) => string;
    readonly auth?: ClientAuth;
    readonly headers?: HeadersValue;
    readonly host?: string;
    readonly prepareSend?: PrepareSend;
    readonly redirect?: ClientRedirectPolicy;
};
export type AgentAssetUpload = {
    readonly assetId: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly sizeBytes: number;
};
export type AgentAssetUploadAdapter = {
    upload(input: {
        readonly attachmentId: string;
        readonly file: File;
        readonly onProgress: (progress: {
            readonly totalBytes: number;
            readonly uploadedBytes: number;
        }) => void;
        readonly sessionId?: string;
        readonly signal: AbortSignal;
    }): Promise<AgentAssetUpload>;
    remove?(asset: AgentAssetUpload): Promise<void>;
};
export type AgentSessionAsset = {
    readonly assetId: string;
    readonly createdAt?: string;
    readonly downloadUrl?: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly previewUrl?: string;
    readonly sizeBytes: number;
    readonly url?: string;
};
export type AgentAssetEndpoint = string | ((sessionId: string) => string);
export type AgentSessionDeliverable = {
    readonly createdAt: string;
    readonly expiresAt?: string;
    readonly fileCount?: number;
    readonly id: string;
    readonly kind: "artifact" | "asset" | "website-preview";
    readonly mediaType?: string;
    readonly sizeBytes: number;
    readonly title: string;
    readonly url: string;
};
export type AgentDeliverableEndpoint = string | ((sessionId: string) => string);
export type AgentWorkspaceConfig = {
    readonly agentName: string;
    readonly assetEndpoint?: AgentAssetEndpoint;
    readonly deliverableEndpoint?: AgentDeliverableEndpoint;
    readonly onOpenAsset?: (asset: AgentSessionAsset) => void;
    readonly onOpenDeliverable?: (deliverable: AgentSessionDeliverable) => void;
    readonly client?: AgentWorkspaceClientConfig;
    readonly commands?: readonly AgentPromptMenuItem[];
    readonly defaultPreferences: AgentThreadPreferences;
    readonly extensions?: readonly AgentExtensionInfo[];
    readonly hostSlots?: AgentWorkspaceHostSlots;
    readonly initialThreadId?: string;
    readonly initialSubagentSessionId?: string;
    readonly mailbox?: AgentWorkspaceMailbox;
    readonly models: readonly AgentModelOption[];
    readonly mentions?: readonly AgentPromptMenuItem[];
    readonly onEvent?: (event: MessageStreamEvent) => void;
    readonly onActiveThreadChange?: (threadId?: string) => void;
    readonly onActiveSubagentChange?: (threadId: string, sessionId?: string) => void;
    readonly onDeleteThread?: (thread: AgentThread) => void | Promise<void>;
    readonly onStorageError?: (error: unknown) => void;
    readonly productName: string;
    readonly reasoningLevels: readonly string[];
    readonly runtimeStatus?: AgentRuntimeStatus;
    readonly storageKey?: string;
    readonly threadStorage?: AgentThreadStorage;
    readonly loadSubagents?: AgentSubagentLoader;
    readonly controlSubagent?: AgentSubagentController;
};
//# sourceMappingURL=contracts.d.ts.map