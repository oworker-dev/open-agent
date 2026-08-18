import type { AgentDeliverableEndpoint, AgentSessionDeliverable, AgentWorkspaceClientConfig } from "./contracts.js";
export declare function loadSessionDeliverables({ client, endpoint, fetcher, sessionId, signal, }: {
    readonly client?: AgentWorkspaceClientConfig;
    readonly endpoint?: AgentDeliverableEndpoint;
    readonly fetcher?: typeof fetch;
    readonly sessionId: string;
    readonly signal?: AbortSignal;
}): Promise<readonly AgentSessionDeliverable[]>;
export declare function resolveSessionDeliverableEndpoint(endpoint: AgentDeliverableEndpoint, sessionId: string): string;
export declare function parseSessionDeliverables(payload: unknown): readonly AgentSessionDeliverable[];
export declare function mergeSessionDeliverables(deliverables: readonly AgentSessionDeliverable[] | undefined, assets: readonly AgentSessionAssetLike[]): readonly AgentSessionDeliverable[];
export type AgentSessionAssetLike = {
    readonly assetId: string;
    readonly createdAt?: string;
    readonly downloadUrl?: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly previewUrl?: string;
    readonly sizeBytes: number;
    readonly url?: string;
};
//# sourceMappingURL=session-deliverables.d.ts.map