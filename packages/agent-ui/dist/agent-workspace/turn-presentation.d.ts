import type { MessageStreamEvent, InputRequest } from "eve/client";
import type { EveDynamicToolPart, EveMessage, EveMessagePart } from "eve/react";
import type { AgentInterruptedTurn, AgentPendingTurn, AgentSubagentSummary } from "./contracts.js";
export type AgentTurnStatus = "cancelled" | "completed" | "failed" | "running" | "waiting";
export type SubagentCallPresentation = {
    readonly childSessionId?: string;
    readonly endedAt?: number;
    readonly name?: string;
    readonly startedAt?: number;
    readonly status: "cancelled" | "completed" | "failed" | "running" | "starting" | "waiting";
};
export type SubagentSessionPresentation = SubagentCallPresentation & {
    readonly callId: string;
    readonly task?: string;
};
export declare function mergeSubagentSessions(events: readonly MessageStreamEvent[], durable?: readonly AgentSubagentSummary[]): readonly SubagentSessionPresentation[];
export type AgentTurnPresentation = {
    readonly endedAt?: number;
    readonly finalPart?: Extract<EveMessagePart, {
        type: "text";
    }>;
    readonly failureAnchored?: boolean;
    readonly proxiedInputParts: readonly EveDynamicToolPart[];
    readonly processParts: readonly EveMessagePart[];
    readonly startedAt?: number;
    readonly status: AgentTurnStatus;
    readonly waitingFor?: InputRequest["kind"];
};
export type AgentTurnPresentationOptions = {
    readonly mergeSameTurn?: boolean;
};
export type AgentTurnFailure = {
    readonly code: string;
    readonly message: string;
};
export type AgentFailureCategory = "network" | "provider" | "timeout" | "unknown";
export declare function classifyAgentFailure(failure: AgentTurnFailure): AgentFailureCategory;
export type AgentStepPresentation = {
    readonly endedAt?: number;
    readonly failure?: AgentTurnFailure;
    readonly retry?: {
        readonly attempt?: number;
        readonly error?: AgentTurnFailure;
        readonly exhausted?: boolean;
        readonly maximum?: number;
    };
    readonly retries?: readonly {
        readonly attempt: number;
        readonly error: AgentTurnFailure;
        readonly exhausted?: boolean;
        readonly maximum: number;
    }[];
    readonly startedAt?: number;
    readonly status: "completed" | "failed" | "running";
};
export type AgentDisplayProjection = {
    readonly events: readonly MessageStreamEvent[];
    readonly messages: readonly EveMessage[];
};
export declare function stableUserMessageId(sourceId: string, turnId: string, stableRoot: string): string;
export declare function activeTurnIdAfterPendingSubmission(events: readonly MessageStreamEvent[], pendingTurn: Pick<AgentPendingTurn, "eventCountAtSubmission" | "submittedAt">): string | undefined;
export declare const INTERRUPTED_TOOL_ERROR = "Open Agent: tool call cancelled before completion.";
export declare const CANCELLING_TOOL_ERROR = "Open Agent: tool call cancellation is pending.";
export declare const INCOMPLETE_TOOL_ERROR = "Open Agent: tool call did not complete.";
export declare function isInterruptedToolPart(part: EveDynamicToolPart): boolean;
export declare function isCancellationPendingToolPart(part: EveDynamicToolPart): boolean;
export declare function sanitizeSettledThreadEvents(events: readonly MessageStreamEvent[]): readonly MessageStreamEvent[];
export declare function normalizeSettledAgentMessages(messages: readonly EveMessage[], events: readonly MessageStreamEvent[]): readonly EveMessage[];
export declare function shouldSuppressInterruptedTurnDisplayEvent(event: MessageStreamEvent, eventIndex: number, turns: readonly AgentInterruptedTurn[]): boolean;
export declare function shouldSuppressInterruptedTurnStreamEvent(event: MessageStreamEvent, streamIndex: number, turns: readonly AgentInterruptedTurn[]): boolean;
export declare function projectAgentDisplayTimeline(messages: readonly EveMessage[], events: readonly MessageStreamEvent[]): AgentDisplayProjection;
export declare function presentAgentStep(events: readonly MessageStreamEvent[], turnId: string | undefined, stepIndex: number): AgentStepPresentation;
export declare function reasoningContentForStep(events: readonly MessageStreamEvent[], turnId: string | undefined, stepIndex: number | undefined): string;
export declare function presentAgentTurn(message: EveMessage, events: readonly MessageStreamEvent[], closedInputRequestIds?: ReadonlySet<string>, options?: AgentTurnPresentationOptions): AgentTurnPresentation | undefined;
export declare function isProxiedInputOnlyMessage(message: EveMessage, events: readonly MessageStreamEvent[]): boolean;
export declare function unresolvedInputRequests(events: readonly MessageStreamEvent[], closedInputRequestIds?: ReadonlySet<string>): readonly InputRequest[];
export declare function hasUnresolvedInputRequests(events: readonly MessageStreamEvent[], closedInputRequestIds?: ReadonlySet<string>): boolean;
export declare function hasSettledLatestTurn(events: readonly MessageStreamEvent[]): boolean;
export declare function failureForTurn(events: readonly MessageStreamEvent[], turnId: string | undefined): AgentTurnFailure | undefined;
export declare function eventsBeforeLastUserTurn(events: readonly MessageStreamEvent[]): readonly MessageStreamEvent[];
export declare function presentSubagentCall(events: readonly MessageStreamEvent[], callId: string): SubagentCallPresentation;
export declare function presentSubagentSessions(events: readonly MessageStreamEvent[]): readonly SubagentSessionPresentation[];
//# sourceMappingURL=turn-presentation.d.ts.map