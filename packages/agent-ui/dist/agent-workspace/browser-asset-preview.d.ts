import type { AgentWorkspaceClientConfig } from "./contracts.js";
export declare const MAX_TEXT_PREVIEW_BYTES: number;
export declare function authenticatedAssetPreviewUrl(source: string, serviceOrigin: string): string | undefined;
export declare function readBrowserAssetPreview(url: string, config: AgentWorkspaceClientConfig | undefined, signal: AbortSignal, fetcher?: typeof fetch): Promise<Blob>;
export declare function readBrowserAssetText(url: string, config: AgentWorkspaceClientConfig | undefined, signal: AbortSignal, fetcher?: typeof fetch): Promise<{
    text: string;
    truncated: boolean;
}>;
export declare function prepareBrowserAssetDownload(source: string, config: AgentWorkspaceClientConfig | undefined, signal: AbortSignal, fetcher?: typeof fetch): Promise<string>;
//# sourceMappingURL=browser-asset-preview.d.ts.map