import { type AgentSessionCancellation, type AgentSessionCursor, type AgentSessionEvent, type AgentSessionReset, type AgentSessionSendPayload, type AgentSessionTurnResult } from "@oworker/open-agent-contracts/agent-session";
import type { AgentClientHeaders } from "./agent-run-client.js";
export declare const EVE_AGENT_SESSION_ADAPTER_VERSION: "0.1.0-alpha.9";
export type AgentSessionClientOptions = {
    readonly baseUrl: string;
    readonly getAccessToken: () => string | Promise<string>;
    readonly headers?: AgentClientHeaders;
    readonly redirect?: RequestRedirect;
};
export type AgentSessionSendInput = string | (AgentSessionSendPayload & {
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
});
export type AgentSessionStreamOptions = {
    readonly after?: number;
    readonly follow?: boolean;
    readonly signal?: AbortSignal;
};
export interface AgentSessionTurn<TOutput = unknown> extends AsyncIterable<AgentSessionEvent> {
    readonly sessionId: string;
    result(): Promise<AgentSessionTurnResult<TOutput>>;
}
export interface AgentSession {
    readonly cursor: AgentSessionCursor;
    send<TOutput = unknown>(input: AgentSessionSendInput): Promise<AgentSessionTurn<TOutput>>;
    stream(options?: AgentSessionStreamOptions): AsyncIterable<AgentSessionEvent>;
    cancel(options?: {
        readonly turnId?: string;
    }): Promise<AgentSessionCancellation>;
    reset(): Promise<AgentSessionReset>;
}
export interface AgentSessionClient {
    session(cursor?: AgentSessionCursor): AgentSession;
}
/** Host-neutral adapter over Eve's ID-addressed v27 session and delivery API. */
export declare function createEveAgentSessionClient(options: AgentSessionClientOptions): AgentSessionClient;
//# sourceMappingURL=eve-session-client.d.ts.map