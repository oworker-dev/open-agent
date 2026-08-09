import type { MessageStreamEvent } from "eve/client";
export declare function recoveryContextTokenBudget(modelContextWindowTokens: number): number;
export declare function interruptedTurnContextsFromEvents(events: readonly MessageStreamEvent[], priorContext: readonly string[] | undefined, modelContextWindowTokens: number): readonly string[] | undefined;
export declare function interruptedTurnContextFromEvents(events: readonly MessageStreamEvent[], turnId: string, priorContext: readonly string[] | undefined, modelContextWindowTokens: number, fallbackPrompt?: string): readonly string[] | undefined;
export declare function rewriteContextFromEvents(events: readonly MessageStreamEvent[], modelContextWindowTokens: number): readonly string[] | undefined;
export declare function sanitizeRetainedContext(value: unknown, modelContextWindowTokens?: number): readonly string[] | undefined;
export declare function boundRetainedContext(entries: readonly string[], modelContextWindowTokens: number): readonly string[] | undefined;
export declare function approximateTokenCount(value: string): number;
export declare function truncateMiddleToTokenBudget(value: string, maxTokens: number): string;
//# sourceMappingURL=retained-context.d.ts.map