import type { AgentSessionHistory, AgentSessionOperationReceipt, AgentSessionSteerRequest } from "@oworker/open-agent-contracts/agent-session";
import type { AgentClientHeaders } from "./agent-run-client.js";
export type AgentSessionControlClientOptions = {
    readonly baseUrl: string;
    readonly getAccessToken: () => string | Promise<string>;
    readonly headers?: AgentClientHeaders;
    readonly redirect?: RequestRedirect;
};
export interface AgentSessionControlClient {
    history(sessionId: string, options?: {
        readonly after?: number;
        readonly limit?: number;
        readonly signal?: AbortSignal;
    }): Promise<AgentSessionHistory>;
    steer(sessionId: string, request: AgentSessionSteerRequest): Promise<AgentSessionOperationReceipt>;
    cancel(sessionId: string): Promise<AgentSessionOperationReceipt>;
}
/**
 * Host-neutral HTTP control client.  Eve's stream client remains responsible
 * for the live runtime; this adapter owns durable history and mailbox control
 * routes exposed by the Open Agent host service.
 */
export declare function createAgentSessionControlClient(options: AgentSessionControlClientOptions, fetchImplementation?: typeof fetch): AgentSessionControlClient;
//# sourceMappingURL=session-control-client.d.ts.map