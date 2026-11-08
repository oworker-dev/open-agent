import type { EveMessage } from "eve/react";
import type { SessionStreamEvent } from "eve/client";
import { type Answer } from "eve/events";
import type { AgentLocale } from "./i18n.js";
import type { AgentSessionDeliverable } from "./contracts.js";
export type AgentInputResponse = Answer;
export declare function AgentMessage({ assetUrl, canRespond, closedInputRequestIds, events: sourceEvents, fallbackStartedAt, isStreaming: sourceStreaming, locale, message, onOpenDeliverable, onOpenSubagent, onInputResponses, onCloseInputRequest, showCopyAction, }: {
    readonly assetUrl?: (assetId: string) => string;
    readonly canRespond: boolean;
    readonly closedInputRequestIds?: ReadonlySet<string>;
    readonly events: readonly SessionStreamEvent[];
    readonly fallbackStartedAt?: number;
    readonly isStreaming: boolean;
    readonly locale: AgentLocale;
    readonly message: EveMessage;
    readonly onOpenDeliverable?: (deliverable: AgentSessionDeliverable) => void;
    readonly onOpenSubagent?: (sessionId: string) => void;
    readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
    readonly onCloseInputRequest?: (requestId: string) => void;
    readonly showCopyAction?: boolean;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=agent-message.d.ts.map