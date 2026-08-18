"use client";

import type { MessageStreamEvent } from "eve/client";
import { useRef } from "react";
import {
  ReasoningRoot,
  ReasoningTrigger,
} from "../assistant-ui/reasoning.js";
import { activityLabel } from "./agent-activity-state.js";
import type { AgentMessages } from "./i18n.js";

export function AgentActivity({
  events,
  messages,
  mode = "live",
}: {
  readonly events: readonly MessageStreamEvent[];
  readonly messages: AgentMessages;
  readonly mode?: "live" | "recovery";
}) {
  const mountedAt = useRef(Date.now());
  const label = activityLabel(events, messages, { mode, mountedAt: mountedAt.current, now: Date.now() });
  const hasReasoning = events.some((event) =>
    event.type === "reasoning.appended" || event.type === "reasoning.completed",
  );
  // Keep one calm reasoning disclosure visible from admission onward. The
  // label intentionally stays provider-neutral; transport retries belong in
  // the error/reconnect projection, not in the conversation body.
  return (
    <ReasoningRoot className="mb-1" role="status" streaming variant="ghost">
      <ReasoningTrigger active label={label} hideChevron={!hasReasoning} />
    </ReasoningRoot>
  );
}
