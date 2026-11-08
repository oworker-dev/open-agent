import type { SessionStreamEvent } from "eve/client";
import type { AgentMessages } from "./i18n.js";
export declare function AgentActivity({ events, messages, mode, }: {
    readonly events: readonly SessionStreamEvent[];
    readonly messages: AgentMessages;
    readonly mode?: "live" | "recovery";
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=agent-activity.d.ts.map