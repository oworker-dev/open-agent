import { type AgentThreadStorage } from "./thread-storage.js";
export type HttpAgentThreadStorageOptions = {
    readonly endpoint?: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly getAccessToken?: () => string | Promise<string>;
    readonly initialThreadId?: string;
};
export declare class AgentThreadStorageConflictError extends Error {
    readonly currentRevision?: number;
    readonly expectedRevision: number;
    constructor(expectedRevision: number, currentRevision?: number);
}
export declare class AgentThreadStorageHttpError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export declare function createHttpAgentThreadStorage(options: HttpAgentThreadStorageOptions): AgentThreadStorage;
//# sourceMappingURL=http-thread-storage.d.ts.map