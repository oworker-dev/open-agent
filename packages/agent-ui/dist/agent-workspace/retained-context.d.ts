import { type SessionStreamEvent } from "eve/client";
export declare function recoveryContextTokenBudget(modelContextWindowTokens: number): number;
export declare function interruptedTurnContextsFromEvents(events: readonly SessionStreamEvent[], priorContext: readonly string[] | undefined, modelContextWindowTokens: number): readonly string[] | undefined;
export declare function interruptedTurnContextFromEvents(events: readonly SessionStreamEvent[], turnId: string, priorContext: readonly string[] | undefined, modelContextWindowTokens: number, fallbackPrompt?: string): readonly string[] | undefined;
export declare function rewriteContextFromEvents(events: readonly SessionStreamEvent[], modelContextWindowTokens: number): readonly string[] | undefined;
export declare function sanitizeRetainedContext(value: unknown, modelContextWindowTokens?: number): readonly string[] | undefined;
export declare function boundRetainedContext(entries: readonly string[], modelContextWindowTokens: number): readonly string[] | undefined;
export declare function approximateTokenCount(value: string): number;
export declare function truncateMiddleToTokenBudget(value: string, maxTokens: number): string;
//# sourceMappingURL=retained-context.d.ts.map