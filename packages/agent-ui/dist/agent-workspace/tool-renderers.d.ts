import { type ComponentType, type ReactNode } from "react";
import type { SessionStreamEvent } from "eve/client";
import type { Answer } from "eve/events";
import type { EveToolPart } from "eve/react";
import type { AgentSessionDeliverable } from "./contracts.js";
import type { AgentLocale } from "./i18n.js";
export type AgentToolRendererProps = {
    readonly part: EveToolPart;
    readonly events: readonly SessionStreamEvent[];
    readonly locale: AgentLocale;
    readonly canRespond: boolean;
    readonly inputRequestClosed: boolean;
    readonly assetUrl?: (assetId: string) => string;
    readonly onInputResponses: (responses: readonly Answer[]) => void | Promise<void>;
    readonly onCloseInputRequest: (requestId: string) => void;
    readonly onOpenSubagent?: (sessionId: string) => void;
    readonly onOpenDeliverable?: (deliverable: AgentSessionDeliverable) => void;
    readonly defaultContent: ReactNode;
};
export type AgentToolRenderers = Readonly<Record<string, ComponentType<AgentToolRendererProps> | undefined>>;
export declare const AgentToolRenderersContext: import("react").Context<Readonly<Record<string, ComponentType<AgentToolRendererProps> | undefined>> | undefined>;
//# sourceMappingURL=tool-renderers.d.ts.map