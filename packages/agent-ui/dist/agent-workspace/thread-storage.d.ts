import { type SessionStreamEvent } from "eve/client";
import type { AgentInputResponseSubmission, AgentPendingTurn, AgentThread, AgentThreadPreferences, AgentTranscriptWindow } from "./contracts.js";
export declare const AGENT_THREAD_STORAGE_VERSION = 2;
export declare function editOperationId(sessionId: string, beforeTurnId: string, text: string): string;
export type AgentThreadCollection = {
    readonly activeThreadId?: string;
    readonly threads: readonly AgentThread[];
    readonly version: number;
};
export type AgentThreadStorage = {
    load(storageKey: string): AgentThreadCollection | Promise<AgentThreadCollection>;
    loadThread?(storageKey: string, threadId: string): AgentThread | undefined | Promise<AgentThread | undefined>;
    loadThreadWindow?(storageKey: string, threadId: string, options?: {
        readonly before?: number;
        readonly limit?: number;
    }): Promise<{
        readonly thread: AgentThread;
        readonly window: AgentTranscriptWindow;
    } | undefined>;
    repairThread?(storageKey: string, threadId: string): AgentThread | undefined | Promise<AgentThread | undefined>;
    save(storageKey: string, collection: AgentThreadCollection): void | Promise<void>;
};
export declare function mergeThreadCollectionsForConflict(local: AgentThreadCollection, remote: AgentThreadCollection): AgentThreadCollection;
export declare const browserThreadStorage: AgentThreadStorage;
export declare function createAgentThread(now?: number, title?: string, preferences?: AgentThreadPreferences): AgentThread;
export declare function loadThreadCollection(storageKey: string): AgentThreadCollection;
export declare function parseThreadCollection(value: unknown): AgentThreadCollection;
export declare function saveThreadCollection(storageKey: string, threads: readonly AgentThread[], activeThreadId?: string): boolean;
export declare function titleFromPrompt(prompt: string): string;
export declare function mergeInputResponseSubmissions(left: readonly AgentInputResponseSubmission[], right: readonly AgentInputResponseSubmission[]): readonly AgentInputResponseSubmission[];
export declare function inputResponseSubmissionFailure(submission: AgentInputResponseSubmission, events: readonly SessionStreamEvent[]): string | undefined;
export declare function inputResponseSubmissionProjectsAnswer(submission: AgentInputResponseSubmission, events?: readonly SessionStreamEvent[]): boolean;
export declare function hasUnsettledInputResponseSubmission(submissions: readonly AgentInputResponseSubmission[]): boolean;
export declare function settleInputResponseSubmissions(submissions: readonly AgentInputResponseSubmission[], streamIndex: number): readonly AgentInputResponseSubmission[];
export declare function appendThreadEvent(events: readonly SessionStreamEvent[], event: SessionStreamEvent): readonly SessionStreamEvent[];
export declare function appendThreadEventIndexed(events: SessionStreamEvent[], eventIds: Set<string>, event: SessionStreamEvent): boolean;
export declare function mergeThreadEventSnapshots(left: readonly SessionStreamEvent[], right: readonly SessionStreamEvent[]): readonly SessionStreamEvent[];
export declare function eventIdentity(event: SessionStreamEvent): string;
export declare function isThreadEvent(value: unknown): value is SessionStreamEvent;
export declare function threadEventCursor(event: SessionStreamEvent): number | undefined;
export declare function compactThreadEvents(events: readonly SessionStreamEvent[]): readonly SessionStreamEvent[];
export declare function reconcilePendingTurnWithEvents(pendingTurn: AgentPendingTurn | undefined, events: readonly SessionStreamEvent[]): AgentPendingTurn | undefined;
export declare function receivedClientMessageId(event: Extract<SessionStreamEvent, {
    type: "delivery.consumed";
}>): string | undefined;
export declare function textFromDelivery(event: Extract<SessionStreamEvent, {
    type: "delivery.consumed";
}>): string;
export declare function reconcileHydratedPendingTurn(pendingTurn: AgentPendingTurn | undefined, events: readonly SessionStreamEvent[]): AgentPendingTurn | undefined;
export declare function latestEditableTurnId(events: readonly SessionStreamEvent[]): string | undefined;
export declare function dedupeThreadEvents(events: readonly SessionStreamEvent[]): readonly SessionStreamEvent[];
//# sourceMappingURL=thread-storage.d.ts.map