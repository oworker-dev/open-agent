export declare const AGENT_CLIENT_CONTEXT_MAX_ENTRIES = 64;
export declare const AGENT_CLIENT_CONTEXT_MAX_TOKENS = 20000;
export declare const AGENT_APPROXIMATE_BYTES_PER_TOKEN = 4;
export declare const AGENT_CLIENT_CONTEXT_MAX_BYTES: number;
/** Transport guard for model-facing client context. Semantic reduction happens before this boundary. */
export declare function isBoundedAgentClientContext(value: unknown): value is readonly string[];
//# sourceMappingURL=client-context.d.ts.map