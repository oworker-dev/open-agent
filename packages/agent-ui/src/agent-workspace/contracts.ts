import type {
  ClientAuth,
  ClientRedirectPolicy,
  MessageStreamEvent,
  HeadersValue,
  PrepareSend,
} from "eve/client";
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
  /** Persisted presentation-event count observed at cancellation. */
  readonly eventCount: number;
  /** Absolute Eve stream cursor observed at cancellation. */
  readonly streamIndex: number;
  readonly turnId: string;
  /**
   * Whether Eve has emitted the authoritative cancellation boundary.
   * Legacy snapshots omit this field and are treated as settled.
   */
  readonly settled?: boolean;
};

export type AgentQueuedTurn = {
  readonly delivery?: "browser" | "server";
  /** Exact Eve turn that may accept this message at its next model boundary. */
  readonly expectedTurnId?: string;
  readonly id: string;
  /** A post-cancellation message is a normal next turn staged until Eve parks. */
  readonly intent?: "active-turn" | "post-cancellation";
  readonly mailboxItemId?: string;
  readonly state:
    | "accepted"
    | "admission-ambiguous"
    | "committed"
    | "delivering"
    | "delivery-failed"
    | "queued";
  readonly submittedAt: number;
  readonly text: string;
};

export type AgentMailboxItemStatus =
  | "accepted"
  | "cancelled"
  | "committed"
  | "delivering"
  | "failed"
  | "queued"
  | "submission-ambiguous";

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

/** Host-provided lifecycle bridge for durable child sessions. */
export type AgentSubagentController = (input: {
  readonly action: AgentSubagentControlAction;
  readonly sessionId: string;
}) => Promise<AgentSubagentSummary | undefined>;

/** Host-provided durable loader. Event streams remain the optimistic fast path. */
export type AgentSubagentLoader = (parentSessionId: string) => Promise<readonly AgentSubagentSummary[]>;

/** A lightweight, server-authoritative Eve lifecycle probe. */
export type AgentSessionBoundary = {
  readonly lastEventAt?: string;
  readonly tailIndex?: number;
  readonly state: "running" | "waiting" | "terminal";
  readonly terminalStatus?: "completed" | "failed";
  readonly turnId?: string;
};

export type AgentSessionInspector = (sessionId: string) => Promise<AgentSessionBoundary>;

/**
 * Coverage of the compact UI transcript against Eve's absolute stream.
 *
 * `endIndex` is the next unread Eve cursor, so a repaired or live transcript
 * that started at zero covers `[startIndex, endIndex)`. Legacy checkpoints do
 * not carry this marker and must never be treated as complete history.
 */
export type AgentTranscriptCoverage = {
  /** True only after the server has read Eve's finite transcript to its tail. */
  readonly authoritative?: boolean;
  readonly complete: boolean;
  readonly endIndex: number;
  readonly startIndex: number;
  readonly version: 1;
};

/** Metadata for a bounded event window. The indexes are ordered transcript
 * positions (end exclusive), not a retention limit and not an Eve cursor. */
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
  /** Server-backed indexes omit the event transcript until the thread is opened. */
  readonly hydration?: "summary";
  readonly id: string;
  readonly interruptedTurns?: readonly AgentInterruptedTurn[];
  readonly pendingTurn?: AgentPendingTurn;
  readonly preferences: AgentThreadPreferences;
  /** Token-bounded settled history retained across an Eve context rewrite. */
  readonly retainedContext?: readonly string[];
  readonly queuedTurns: readonly AgentQueuedTurn[];
  readonly revision?: number;
  readonly session: AgentThreadSessionState;
  readonly status: AgentThreadStatus;
  readonly transcriptCoverage?: AgentTranscriptCoverage;
  /** The bounded history range currently materialized in the browser. */
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
  /** Host-replaceable browser upload transport. */
  readonly assetUpload?: AgentAssetUploadAdapter;
  /** Optional host-authorized URL resolver for persisted session assets. */
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
  /** Upload bytes without placing them in an Agent message or durable event. */
  upload(input: {
    readonly attachmentId: string;
    readonly file: File;
    readonly onProgress: (progress: { readonly totalBytes: number; readonly uploadedBytes: number }) => void;
    readonly sessionId?: string;
    readonly signal: AbortSignal;
  }): Promise<AgentAssetUpload>;
  /** Optional cleanup for a completed upload removed before message send. */
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
  /** Optional GET endpoint (or resolver) returning `{ assets: [...] }` metadata for the active session. */
  readonly assetEndpoint?: AgentAssetEndpoint;
  /** Optional GET endpoint (or resolver) returning `{ deliverables: [...] }` for the active session. */
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
