import type { MessageStreamEvent } from "eve/client";
import type { AgentThread, AgentThreadPreferences } from "./contracts.js";
export declare const AGENT_THREAD_STORAGE_VERSION = 2;
export type AgentThreadCollection = {
    readonly activeThreadId?: string;
    readonly threads: readonly AgentThread[];
    readonly version: number;
};
export type AgentThreadStorage = {
    load(storageKey: string): AgentThreadCollection | Promise<AgentThreadCollection>;
    loadThread?(storageKey: string, threadId: string): AgentThread | undefined | Promise<AgentThread | undefined>;
    save(storageKey: string, collection: AgentThreadCollection): void | Promise<void>;
};
export declare const browserThreadStorage: AgentThreadStorage;
export declare function createAgentThread(now?: number, title?: string, preferences?: AgentThreadPreferences): AgentThread;
export declare function loadThreadCollection(storageKey: string): AgentThreadCollection;
export declare function parseThreadCollection(value: unknown): AgentThreadCollection;
export declare function saveThreadCollection(storageKey: string, threads: readonly AgentThread[], activeThreadId?: string): boolean;
export declare function titleFromPrompt(prompt: string): string;
export declare function appendThreadEvent(events: readonly MessageStreamEvent[], event: MessageStreamEvent): readonly MessageStreamEvent[];
export declare function compactThreadEvents(events: readonly MessageStreamEvent[]): readonly MessageStreamEvent[];
//# sourceMappingURL=thread-storage.d.ts.map