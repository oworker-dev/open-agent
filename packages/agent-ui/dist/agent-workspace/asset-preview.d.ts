import { type ReactNode } from "react";
import type { AgentWorkspaceClientConfig } from "./contracts.js";
export declare function AssetPreviewProvider({ client, children }: {
    readonly client?: AgentWorkspaceClientConfig;
    readonly children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export declare function useAssetPreview(source: string | undefined): {
    url: string | undefined;
    error: string | undefined;
    retry: () => void;
};
export declare function useAssetText(source: string | undefined): {
    retry: () => void;
    source?: string | undefined;
    text?: string;
    truncated?: boolean;
    error?: string;
};
export declare function useAssetDownload(source: string | undefined, filename: string): {
    download: () => Promise<void>;
    loading: boolean;
    error: string | undefined;
};
//# sourceMappingURL=asset-preview.d.ts.map