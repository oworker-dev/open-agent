import type { SessionStreamEvent } from "eve/client";
import type { AgentMessages } from "./i18n.js";

export function activityLabel(
  _events: readonly SessionStreamEvent[],
  messages: AgentMessages,
  _options: {
    readonly mode?: "live" | "recovery";
    readonly mountedAt: number;
    readonly now: number;
  },
): string {
  return messages.thinking;
}
