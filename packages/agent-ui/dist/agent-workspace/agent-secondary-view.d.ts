import { type ReactNode } from "react";
import type { AgentSessionAsset, AgentSessionDeliverable } from "./contracts.js";
import type { AgentLocale } from "./i18n.js";
export type AgentSecondaryTab = "home" | "children" | "assets" | "deliverables";
export type AgentSecondaryChild = {
    readonly childSessionId: string;
    readonly nickname: string;
    readonly status: string;
    readonly task?: string;
};
export declare function AgentSecondaryView({ assetUrl, assets, assetsError, assetsLoading, childContent, children, deliverables, deliverablesError, deliverablesLoading, locale, onClose, onOpenAsset, onOpenChild, onOpenDeliverable, onRefreshAssets, onRefreshDeliverables, onSelectTab, requestedDeliverable, requestedDeliverableRequestId, tab, }: {
    readonly assetUrl?: (assetId: string) => string;
    readonly assets?: readonly AgentSessionAsset[];
    readonly assetsError?: string;
    readonly assetsLoading?: boolean;
    readonly childContent?: ReactNode;
    readonly children: readonly AgentSecondaryChild[];
    readonly deliverables?: readonly AgentSessionDeliverable[];
    readonly deliverablesError?: string;
    readonly deliverablesLoading?: boolean;
    readonly locale: AgentLocale;
    readonly onClose: () => void;
    readonly onOpenAsset?: (asset: AgentSessionAsset) => void;
    readonly onOpenChild: (sessionId: string) => void;
    readonly onOpenDeliverable?: (deliverable: AgentSessionDeliverable) => void;
    readonly onRefreshAssets?: () => void;
    readonly onRefreshDeliverables?: () => void;
    readonly onSelectTab?: (tab: AgentSecondaryTab) => void;
    readonly requestedDeliverable?: AgentSessionDeliverable;
    readonly requestedDeliverableRequestId?: number;
    readonly tab?: AgentSecondaryTab;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=agent-secondary-view.d.ts.map