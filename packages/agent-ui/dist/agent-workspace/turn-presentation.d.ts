import { type SessionStreamEvent } from "eve/client";
import { type Interaction } from "eve/events";
import type { EveMessage, EveMessagePart, EveToolPart } from "eve/react";
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
export declare function mergeSubagentSessions(events: readonly SessionStreamEvent[], durable?: readonly AgentSubagentSummary[]): readonly SubagentSessionPresentation[];
export type AgentTurnFailure = {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
    readonly statusCode?: number;
};
export type AgentFailureCategory = "network" | "provider" | "timeout" | "unknown";
export declare function classifyAgentFailure(failure: AgentTurnFailure): AgentFailureCategory;
export declare function isRetryableAgentFailure(failure: AgentTurnFailure): boolean;
export type AgentTurnPresentation = {
    readonly endedAt?: number;
    readonly finalPart?: Extract<EveMessagePart, {
        type: "text";
    }>;
    readonly failureAnchored?: boolean;
    readonly showExecutionGroup: boolean;
    readonly proxiedInputParts: readonly EveToolPart[];
    readonly processParts: readonly EveMessagePart[];
    readonly startedAt?: number;
    readonly status: AgentTurnStatus;
    readonly waitingFor?: Interaction["request"]["kind"];
};
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
        readonly maximum?: number;
    }[];
    readonly startedAt?: number;
    readonly status: "completed" | "failed" | "running";
};
export declare function presentationSnapshot(events: readonly SessionStreamEvent[]): import("eve/client").ConversationState;
export declare function eventTurnId(event: SessionStreamEvent): string | undefined;
export declare function eventStepIndex(event: SessionStreamEvent, events: readonly SessionStreamEvent[]): number | undefined;
export declare function eventTimestamp(event: SessionStreamEvent | undefined): number | undefined;
export declare function stableUserMessageId(sourceId: string, _turnId: string, _stableRoot: string): string;
export declare function activeTurnIdAfterPendingSubmission(events: readonly SessionStreamEvent[], pending: Pick<AgentPendingTurn, "eventCountAtSubmission" | "submittedAt">): string | undefined;
export declare const INTERRUPTED_TOOL_ERROR = "Open Agent: tool call cancelled before completion.";
export declare const CANCELLING_TOOL_ERROR = "Open Agent: tool call cancellation is pending.";
export declare const INCOMPLETE_TOOL_ERROR = "Open Agent: tool call did not complete.";
export declare function isInterruptedToolPart(part: EveToolPart): boolean;
export declare function isCancellationPendingToolPart(part: EveToolPart): boolean;
export type DisplayEveMessage = EveMessage & {
    readonly metadata?: EveMessage["metadata"] & {
        readonly localStatus?: "cancelled";
        readonly localStopStreamIndex?: number;
    };
};
export declare function isLocallyInterruptedMessage(message: EveMessage): boolean;
export declare function eventsForMessagePresentation(message: EveMessage, events: readonly SessionStreamEvent[]): readonly SessionStreamEvent[];
export declare function projectInterruptedMessages(messages: readonly EveMessage[], events: readonly SessionStreamEvent[], interruptions: readonly AgentInterruptedTurn[]): readonly DisplayEveMessage[];
export declare function presentAgentStep(events: readonly SessionStreamEvent[], turnId: string | undefined, stepIndex: number): AgentStepPresentation;
export declare function reasoningContentForStep(events: readonly SessionStreamEvent[], turnId: string | undefined, stepIndex: number | undefined): string;
export declare function presentAgentTurn(message: EveMessage, events: readonly SessionStreamEvent[], closedIds?: ReadonlySet<string>): AgentTurnPresentation | undefined;
export declare function syntheticMessageReceiptClientMessageId(event: Extract<SessionStreamEvent, {
    type: "delivery.consumed";
}>, _ordinal: number): string;
export declare function unresolvedInputRequests(events: readonly SessionStreamEvent[], closedIds?: ReadonlySet<string>): readonly Interaction[];
export declare function hasUnresolvedInputRequests(events: readonly SessionStreamEvent[], closedIds?: ReadonlySet<string>): boolean;
export declare function hasSettledLatestTurn(events: readonly SessionStreamEvent[]): boolean;
export declare function hasTerminalSessionBoundary(events: readonly SessionStreamEvent[]): boolean;
export declare function failureForTurn(events: readonly SessionStreamEvent[], turnId: string | undefined): AgentTurnFailure | undefined;
export declare function eventsBeforeLastUserTurn(events: readonly SessionStreamEvent[]): readonly SessionStreamEvent[];
export declare function presentSubagentCall(events: readonly SessionStreamEvent[], callId: string): SubagentCallPresentation;
export declare function presentSubagentSessions(events: readonly SessionStreamEvent[]): readonly SubagentSessionPresentation[];
export declare function eventsForAssistantSegment(message: EveMessage, events: readonly SessionStreamEvent[]): {
    readonly events: readonly SessionStreamEvent[];
    readonly settledAt?: number;
};
export declare function withThinkingPlaceholder(message: EveMessage, events: readonly SessionStreamEvent[]): readonly EveMessagePart[];
//# sourceMappingURL=turn-presentation.d.ts.map