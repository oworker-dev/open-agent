"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { useRef } from "react";
import { ReasoningRoot, ReasoningTrigger, } from "../assistant-ui/reasoning.js";
import { activityLabel } from "./agent-activity-state.js";
export function AgentActivity({ events, messages, mode = "live", }) {
    const mountedAt = useRef(Date.now());
    const label = activityLabel(events, messages, { mode, mountedAt: mountedAt.current, now: Date.now() });
    return (_jsx(ReasoningRoot, { className: "mb-1", role: "status", streaming: true, variant: "ghost", children: _jsx(ReasoningTrigger, { active: true, label: label }) }));
}
//# sourceMappingURL=agent-activity.js.map