import type { SessionStreamEvent } from "eve/client";
export type AgentUsageSummary = {
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly contextInputTokens: number;
    readonly costUsd: number;
    readonly inputTokens: number;
    readonly isEstimated: boolean;
    readonly outputTokens: number;
    readonly steps: number;
};
export declare function summarizeUsage(events: readonly SessionStreamEvent[]): AgentUsageSummary;
export declare function formatTokenCount(value: number): string;
//# sourceMappingURL=usage.d.ts.map