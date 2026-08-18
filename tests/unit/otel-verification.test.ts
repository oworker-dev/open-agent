import assert from "node:assert/strict";
import test from "node:test";

import { selectCorrelatedAgentIngress } from "../../scripts/otel-verification.mjs";

test("selects a complete AgentRun trace when older direct sessions lack run correlation", () => {
  const webSpans = [
    span("web-old", "web-old-span", "web.request"),
    span("web-new", "web-new-span", "web.request"),
  ];
  const agentSpans = [
    ingress("agent-old", "web-old", "web-old-span", {
      "open_agent.correlation_id": "",
      "open_agent.profile_id": "general-purpose",
      "open_agent.run_id": "",
      "open_agent.session_id": "session-old",
    }),
    span("agent-old", "eve-old", "ai.eve.turn"),
    ingress("agent-new", "web-new", "web-new-span", {
      "open_agent.correlation_id": "corr-new",
      "open_agent.profile_id": "general-purpose",
      "open_agent.run_id": "arun_new",
      "open_agent.session_id": "session-new",
    }),
    span("agent-new", "eve-new", "ai.eve.turn"),
  ];

  const selected = selectCorrelatedAgentIngress(agentSpans, webSpans);

  assert.equal(selected.traceId, "agent-new");
});

test("rejects a linked Eve trace when no candidate has complete correlation attributes", () => {
  const webSpans = [span("web-old", "web-old-span", "web.request")];
  const agentSpans = [
    ingress("agent-old", "web-old", "web-old-span", {
      "open_agent.correlation_id": "corr-old",
      "open_agent.profile_id": "general-purpose",
      "open_agent.run_id": "",
      "open_agent.session_id": "session-old",
    }),
    span("agent-old", "eve-old", "ai.eve.turn"),
  ];

  assert.throws(
    () => selectCorrelatedAgentIngress(agentSpans, webSpans),
    /missing correlation attribute open_agent\.run_id/u,
  );
});

function ingress(
  traceId: string,
  upstreamTraceId: string,
  upstreamSpanId: string,
  attributes: Readonly<Record<string, string>>,
) {
  return {
    ...span(traceId, `${traceId}-ingress`, "open_agent.turn.accepted"),
    attributes: Object.entries(attributes).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    })),
    links: [{ spanId: upstreamSpanId, traceId: upstreamTraceId }],
  };
}

function span(traceId: string, spanId: string, name: string) {
  return { attributes: [], links: [], name, spanId, traceId };
}
