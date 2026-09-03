import type { AgentWorkspaceMailbox } from "./contracts.js";
export type HttpAgentMailboxOptions = {
    readonly endpoint?: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly getAccessToken?: () => string | Promise<string>;
    readonly sessionEndpoint?: string;
};
export declare class AgentMailboxHttpError extends Error {
    readonly code?: string;
    readonly status: number;
    constructor(status: number, message: string, code?: string);
}
export declare function createHttpAgentMailbox(options: HttpAgentMailboxOptions): AgentWorkspaceMailbox;
//# sourceMappingURL=http-agent-mailbox.d.ts.map