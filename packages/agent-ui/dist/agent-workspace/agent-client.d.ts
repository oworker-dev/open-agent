import { Client, type ClientSession, type ClientSessionState, type HeadersValue } from "eve/client";
import type { AgentThreadPreferences, AgentWorkspaceClientConfig } from "./contracts.js";
export type AgentSessionConnection = {
    readonly auth?: AgentWorkspaceClientConfig["auth"];
    readonly client: Client;
    readonly headers: HeadersValue;
    readonly baseUrl: string;
    readonly initialSession?: ClientSessionState;
};
export declare function createAgentSession(config: AgentWorkspaceClientConfig | undefined, preferences: AgentThreadPreferences | (() => AgentThreadPreferences), state?: Partial<ClientSessionState>): AgentSessionConnection;
export declare function attachAgentSession(connection: AgentSessionConnection, state: ClientSessionState | undefined): ClientSession | undefined;
//# sourceMappingURL=agent-client.d.ts.map