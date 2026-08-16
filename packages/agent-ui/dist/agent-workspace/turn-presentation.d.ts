import type { MessageStreamEvent, InputRequest } from "eve/client";
import type { EveDynamicToolPart, EveMessage, EveMessagePart } from "eve/react";
import type { AgentInterruptedTurn, AgentSubagentSummary } from "./contracts.js";
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
    readonly proxiedInputParts: readonly EveDynamicToolPart[];
    readonly processParts: readonly EveMessagePart[];
    readonly startedAt?: number;
    readonly status: AgentTurnStatus;
    readonly waitingFor?: InputRequest["kind"];
};
export type AgentTurnFailure = {
    readonly code: string;
    readonly message: string;
};
export type AgentStepPresentation = {
    readonly endedAt?: number;
    readonly retry?: {
        readonly attempt: number;
        readonly error?: AgentTurnFailure;
        readonly maximum: number;
    };
    readonly startedAt?: number;
    readonly status: "completed" | "failed" | "running";
};
export type AgentDisplayProjection = {
    readonly events: readonly MessageStreamEvent[];
    readonly messages: readonly EveMessage[];
};
export declare function shouldSuppressInterruptedTurnDisplayEvent(event: MessageStreamEvent, eventIndex: number, turns: readonly AgentInterruptedTurn[]): boolean;
export declare function shouldSuppressInterruptedTurnStreamEvent(event: MessageStreamEvent, streamIndex: number, turns: readonly AgentInterruptedTurn[]): boolean;
export declare function projectAgentDisplayTimeline(messages: readonly EveMessage[], events: readonly MessageStreamEvent[]): AgentDisplayProjection;
export declare function presentAgentStep(events: readonly MessageStreamEvent[], turnId: string | undefined, stepIndex: number): AgentStepPresentation;
export declare function presentAgentTurn(message: EveMessage, events: readonly MessageStreamEvent[], closedInputRequestIds?: ReadonlySet<string>): AgentTurnPresentation | undefined;
export declare function isProxiedInputOnlyMessage(message: EveMessage, events: readonly MessageStreamEvent[]): boolean;
export declare function unresolvedInputRequests(events: readonly MessageStreamEvent[], closedInputRequestIds?: ReadonlySet<string>): readonly InputRequest[];
export declare function hasUnresolvedInputRequests(events: readonly MessageStreamEvent[], closedInputRequestIds?: ReadonlySet<string>): boolean;
export declare function hasSettledLatestTurn(events: readonly MessageStreamEvent[]): boolean;
export declare function failureForTurn(events: readonly MessageStreamEvent[], turnId: string | undefined): AgentTurnFailure | undefined;
export declare function eventsBeforeLastUserTurn(events: readonly MessageStreamEvent[]): readonly MessageStreamEvent[];
export declare function presentSubagentCall(events: readonly MessageStreamEvent[], callId: string): SubagentCallPresentation;
export declare function presentSubagentSessions(events: readonly MessageStreamEvent[]): readonly SubagentSessionPresentation[];
//# sourceMappingURL=turn-presentation.d.ts.map