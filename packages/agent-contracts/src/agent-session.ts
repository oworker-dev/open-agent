import type { JsonValue } from "./agent-run.js";

export const AGENT_SESSION_CONTRACT_VERSION = "0.1.0-draft" as const;

/** Product-level operations are deliberately separate from Eve event types. */
export type AgentSessionOperationKind = "send" | "steer" | "edit" | "cancel" | "approval";

export type AgentSessionOperationState =
  | "queued"
  | "delivering"
  | "accepted"
  | "committed"
  | "failed"
  | "ambiguous"
  | "cancelled";

export type AgentSessionOperation = {
  readonly operationId: string;
  readonly clientMessageId?: string;
  readonly expectedTurnId?: string;
  readonly sessionId: string;
  readonly kind: AgentSessionOperationKind;
  readonly state: AgentSessionOperationState;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastError?: string;
};

/** Serializable position used to resume one durable interactive conversation. */
export type AgentSessionCursor = {
  readonly sessionId?: string;
  readonly eventCursor: number;
};

export type AgentSessionTextPart = {
  readonly type: "text";
  readonly text: string;
};

export type AgentSessionFilePart = {
  readonly type: "file";
  readonly data: string;
  readonly mediaType: string;
  readonly filename?: string;
};

export type AgentSessionUserContent = readonly (AgentSessionTextPart | AgentSessionFilePart)[];

export type AgentSessionInputResponse = {
  readonly requestId: string;
  readonly optionId?: string;
  readonly text?: string;
};

export type AgentSessionInputOption = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly style?: "danger" | "default" | "primary";
};

export type AgentSessionInputRequest = {
  readonly requestId: string;
  readonly prompt: string;
  readonly allowFreeform?: boolean;
  readonly display?: "confirmation" | "select" | "text";
  readonly options?: readonly AgentSessionInputOption[];
  readonly action: {
    readonly callId: string;
    readonly input: Readonly<Record<string, JsonValue>>;
    readonly kind: "tool-call";
    readonly toolName: string;
  };
};

export type AgentSessionSendPayload = {
  readonly clientContext?: string | readonly string[] | Readonly<Record<string, JsonValue>>;
  readonly inputResponses?: readonly AgentSessionInputResponse[];
  readonly message?: string | AgentSessionUserContent;
  readonly outputSchema?: Readonly<Record<string, JsonValue>>;
};

export type AgentSessionEvent = {
  readonly contractVersion: typeof AGENT_SESSION_CONTRACT_VERSION;
  /** Number of durable events consumed after this event. */
  readonly cursor: number;
  readonly data?: JsonValue;
  readonly meta?: JsonValue;
  readonly type: string;
};

/** A bounded server-authoritative history page used after a refresh/reconnect. */
export type AgentSessionHistory = {
  readonly session: AgentSessionSnapshot;
  readonly events: readonly AgentSessionEvent[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
};

export type AgentSessionSnapshot = {
  readonly sessionId: string;
  readonly cursor: AgentSessionCursor;
  readonly status:
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "cancelled"
    | "unknown";
  readonly activeTurnId?: string;
};

export type AgentSessionApprovalStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export type AgentSessionApprovalRequest = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly status: AgentSessionApprovalStatus;
  readonly selection?: "approve" | "reject";
  readonly createdAt: string;
  readonly resolvedAt?: string;
};

export type AgentSessionSteerRequest = {
  readonly clientMessageId: string;
  readonly message: string;
  readonly operationId: string;
  readonly expectedTurnId?: string;
  readonly preferences?: {
    readonly executionMode: "automation" | "cautious" | "standard";
    readonly modelId: string;
    readonly reasoning: string;
  };
};

export type AgentSessionOperationReceipt = {
  readonly ok: true;
  readonly operationId?: string;
  readonly clientMessageId?: string;
  readonly itemId?: string;
  readonly status: AgentSessionOperationState | "no_active_turn";
};

export type AgentSessionTurnResult<TOutput = unknown> = {
  readonly data: TOutput | undefined;
  readonly events: readonly AgentSessionEvent[];
  readonly inputRequests: readonly AgentSessionInputRequest[];
  readonly message: string | undefined;
  readonly sessionId: string;
  readonly status: "completed" | "failed" | "waiting";
};

export type AgentSessionCancellation =
  | { readonly sessionId: string; readonly status: "accepted" }
  | { readonly status: "no_active_turn" };

export type AgentSessionReset =
  | { readonly previousSessionId: string; readonly status: "reset" }
  | { readonly status: "no_active_session" };

/** Lifecycle projection for one Eve delegated child session. */
export type AgentSubagentStatus =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "closed";

export type AgentSubagentWaitPolicy = "wait" | "no-wait";

export type AgentSubagentRecord = {
  readonly childSessionId: string;
  /** Eve's persistent-session id when agent messaging is enabled. */
  readonly agentId?: string;
  readonly parentSessionId: string;
  readonly callId?: string;
  readonly toolName?: string;
  readonly name?: string;
  readonly nickname: string;
  readonly task?: string;
  readonly status: AgentSubagentStatus;
  readonly waitPolicy: AgentSubagentWaitPolicy;
  readonly depth: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly lastError?: string;
};

export type AgentSubagentSnapshot = {
  readonly parentSessionId: string;
  readonly children: readonly AgentSubagentRecord[];
  readonly activeCount: number;
  readonly revision: number;
};

export type AgentSubagentAction =
  | { readonly action: "send"; readonly message: string; readonly operationId?: string }
  | { readonly action: "resume"; readonly message: string; readonly operationId?: string }
  | { readonly action: "wait"; readonly timeoutMs?: number }
  | { readonly action: "interrupt" }
  | { readonly action: "close" };
