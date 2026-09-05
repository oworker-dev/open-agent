export declare const AGENT_RUN_CONTRACT_VERSION: "0.1.0-draft";
export declare const DEFAULT_AGENT_PROFILE: {
    readonly profileId: "general-purpose";
    readonly version: "0.1.0";
};
export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | {
    readonly [key: string]: JsonValue;
} | readonly JsonValue[];
export type AgentRunStatus = "submitting" | "running" | "waiting-input" | "waiting-authorization" | "completed" | "failed" | "cancelled" | "submission-ambiguous";
export type AgentProfileRef = {
    readonly profileId: string;
    readonly version: string;
};
export type AgentExtensionRef = {
    readonly id: string;
    readonly version: string;
};
export type AgentRunLimits = {
    readonly maxDurationMs?: number;
    readonly maxInputTokens?: number;
    readonly maxModelCalls?: number;
    readonly maxOutputTokens?: number;
    readonly maxToolCalls?: number;
    readonly maxTurns?: number;
};
export type AgentExecutionMode = "automation" | "cautious" | "standard";
/** Host-neutral execution policy discovered from the active host. */
export type AgentRunPolicy = {
    readonly executionMode?: AgentExecutionMode;
    readonly hostCapabilities?: readonly string[];
    readonly limits?: AgentRunLimits;
    readonly mcpConnections?: readonly AgentExtensionRef[];
    readonly skills?: readonly AgentExtensionRef[];
    /**
     * Optional session-scoped allowlist of compiled tools. Omitted means the
     * deployment's normal tool set; an empty list intentionally exposes none.
     */
    readonly tools?: readonly string[];
};
export type AgentRunParentRef = {
    readonly depth: number;
    readonly parentRunId: string;
    readonly rootRunId: string;
    readonly source: "agent" | "workflow";
};
export type StartAgentRunRequest = {
    readonly clientContext?: Readonly<Record<string, JsonValue>>;
    readonly correlationId?: string;
    readonly idempotencyKey: string;
    readonly message: string;
    readonly metadata?: Readonly<Record<string, JsonValue>>;
    readonly outputSchema?: Readonly<Record<string, JsonValue>>;
    readonly parent?: AgentRunParentRef;
    readonly policy?: AgentRunPolicy;
    readonly profile: AgentProfileRef;
};
export type AgentRunUsage = {
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly costUsd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly steps: number;
};
export type AgentRunResult = {
    readonly kind: "json";
    readonly value: JsonValue;
} | {
    readonly kind: "text";
    readonly value: string;
};
/** A structured answer to one currently pending Eve input request. */
export type AgentRunInputResponse = {
    readonly requestId: string;
    readonly optionId?: string;
    readonly text?: string;
};
/**
 * Resume a parked AgentRun. The idempotency key covers the complete response
 * batch so hosts can retry an ambiguous HTTP request without answering twice.
 */
export type RespondAgentRunRequest = {
    readonly idempotencyKey: string;
    readonly inputResponses: readonly AgentRunInputResponse[];
};
export type AgentRunSnapshot = {
    readonly contractVersion: typeof AGENT_RUN_CONTRACT_VERSION;
    readonly cancellationRequestedAt?: string;
    readonly correlationId: string;
    readonly createdAt: string;
    readonly eventCount: number;
    readonly failure?: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
    };
    readonly harness: {
        readonly kind: "eve";
        readonly sessionId?: string;
    };
    readonly metadata: Readonly<Record<string, JsonValue>>;
    readonly parent?: AgentRunParentRef;
    readonly policy: AgentRunPolicy;
    readonly profile: AgentProfileRef;
    readonly result?: AgentRunResult;
    readonly revision: number;
    readonly runId: string;
    readonly status: AgentRunStatus;
    readonly updatedAt: string;
    readonly usage: AgentRunUsage;
};
export type AgentEventType = "run.started" | "run.completed" | "run.failed" | "run.cancelled" | "message.received" | "message.delta" | "message.completed" | "reasoning.delta" | "reasoning.completed" | "tool.input.delta" | "tool.requested" | "tool.completed" | "input.requested" | "authorization.required" | "authorization.completed" | "result.completed" | "usage.recorded" | "runtime.event";
export type AgentEvent = {
    readonly contractVersion: typeof AGENT_RUN_CONTRACT_VERSION;
    readonly createdAt?: string;
    readonly data: Readonly<Record<string, JsonValue>>;
    readonly runId: string;
    readonly sequence: number;
    readonly type: AgentEventType;
};
//# sourceMappingURL=agent-run.d.ts.map