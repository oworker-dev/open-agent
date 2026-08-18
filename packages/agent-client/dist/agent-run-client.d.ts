import { type AgentEvent, type RespondAgentRunRequest, type AgentRunSnapshot, type StartAgentRunRequest } from "@oworker/open-agent-contracts/agent-run";
export declare const AGENT_CLIENT_VERSION: "0.1.0-alpha.9";
export declare const AGENT_HOST_SDK_VERSION: "0.1.0-draft";
export type AgentClientHeaders = Readonly<Record<string, string>> | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>);
export type AgentRunClientOptions = {
    readonly baseUrl: string;
    readonly getAccessToken: () => string | Promise<string>;
    readonly fetch?: typeof globalThis.fetch;
    readonly headers?: AgentClientHeaders;
    readonly redirect?: RequestRedirect;
};
export type AgentRunRequestOptions = {
    readonly signal?: AbortSignal;
};
export type AgentRunStartInput = Omit<StartAgentRunRequest, "idempotencyKey"> & {
    readonly idempotencyKey: string;
};
export type AgentRunStartResponse = {
    readonly disposition: "started" | "replayed";
    readonly run: AgentRunSnapshot;
};
export type AgentRunEventsResponse = {
    readonly events: readonly AgentEvent[];
    readonly nextCursor: number;
    readonly run: AgentRunSnapshot;
};
export type AgentRunCancelResponse = {
    readonly cancellation: "accepted" | "already_requested" | "no_active_turn" | "terminal";
    readonly run: AgentRunSnapshot;
};
export type AgentRunRespondResponse = {
    readonly disposition: "accepted" | "replayed";
    readonly run: AgentRunSnapshot;
};
export interface AgentRunClient {
    start(input: AgentRunStartInput, options?: AgentRunRequestOptions): Promise<AgentRunStartResponse>;
    inspect(runId: string, options?: AgentRunRequestOptions): Promise<AgentRunSnapshot>;
    events(runId: string, after?: number, options?: AgentRunRequestOptions): Promise<AgentRunEventsResponse>;
    respond(runId: string, input: RespondAgentRunRequest, options?: AgentRunRequestOptions): Promise<AgentRunRespondResponse>;
    cancel(runId: string, options?: AgentRunRequestOptions): Promise<AgentRunCancelResponse>;
}
export declare function createAgentRunClient(options: AgentRunClientOptions): AgentRunClient;
export declare class AgentClientHttpError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(status: number, message: string, body: unknown);
}
export declare class AgentClientContractError extends Error {
    readonly body: unknown;
    constructor(message: string, body: unknown);
}
//# sourceMappingURL=agent-run-client.d.ts.map