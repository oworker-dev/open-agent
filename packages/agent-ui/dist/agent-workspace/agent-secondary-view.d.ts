import { type ReactNode } from "react";
import type { AgentSessionAsset } from "./contracts.js";
import type { AgentLocale } from "./i18n.js";
export type AgentSecondaryTab = "home" | "children" | "assets" | "child" | "asset";
export type AgentSecondaryChild = {
    readonly childSessionId: string;
    readonly nickname: string;
    readonly status: string;
    readonly task?: string;
};
export declare function AgentSecondaryView({ assets, assetsError, assetsLoading, children, childContent, locale, onClose, onOpenAsset, onOpenChild, onRefreshAssets, onSelectTab, tab, assetUrl, }: {
    readonly assets: readonly AgentSessionAsset[];
    readonly assetsError?: string;
    readonly assetsLoading: boolean;
    readonly children: readonly AgentSecondaryChild[];
    readonly childContent?: ReactNode;
    readonly locale: AgentLocale;
    readonly onClose: () => void;
    readonly onOpenAsset?: (asset: AgentSessionAsset) => void;
    readonly onOpenChild: (sessionId: string) => void;
    readonly onRefreshAssets: () => void;
    readonly onSelectTab: (tab: AgentSecondaryTab) => void;
    readonly tab: AgentSecondaryTab;
    readonly assetUrl?: (assetId: string) => string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=agent-secondary-view.d.ts.map