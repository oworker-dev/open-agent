export const REQUIRED_AGENT_CORRELATION_ATTRIBUTES = [
  "open_agent.run_id",
  "open_agent.correlation_id",
  "open_agent.profile_id",
  "open_agent.session_id",
];

/**
 * Select one complete durable AgentRun trace. A long-lived collector can also
 * contain direct browser or load-test sessions that intentionally have no
 * AgentRun id, so verification must not depend on ingestion order.
 */
export function selectCorrelatedAgentIngress(agentSpans, webSpans) {
  const webSpanContexts = new Set(
    webSpans.map((span) => `${span.traceId}:${span.spanId}`),
  );
  const linkedIngress = agentSpans.filter(
    (span) => span.name === "open_agent.turn.accepted" &&
      (span.links || []).some((link) =>
        webSpanContexts.has(`${link.traceId}:${link.spanId}`),
      ),
  );
  if (linkedIngress.length === 0) {
    throw new Error("The durable Agent turn did not link back to the Agent Web W3C span context.");
  }

  const joinedIngress = linkedIngress.filter((ingress) =>
    agentSpans.some(
      (span) => span.name === "ai.eve.turn" && span.traceId === ingress.traceId,
    ),
  );
  if (joinedIngress.length === 0) {
    throw new Error("The Agent ingress link and Eve turn were not recorded in the same Agent trace.");
  }

  const completeIngress = joinedIngress.find((span) =>
    REQUIRED_AGENT_CORRELATION_ATTRIBUTES.every((name) =>
      hasNonEmptyAttribute(span, name),
    ),
  );
  if (completeIngress) return completeIngress;

  const bestIngress = [...joinedIngress].sort(
    (left, right) => correlationAttributeCount(right) - correlationAttributeCount(left),
  )[0];
  const missing = REQUIRED_AGENT_CORRELATION_ATTRIBUTES.find(
    (name) => !hasNonEmptyAttribute(bestIngress, name),
  );
  throw new Error(`Agent runtime spans are missing correlation attribute ${missing}.`);
}

export function attributeValue(attributes, key) {
  const attribute = (attributes || []).find((candidate) => candidate.key === key);
  return attribute ? anyValue(attribute.value) : undefined;
}

export function anyValue(value) {
  if (!value || typeof value !== "object") return undefined;
  return value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue;
}

function correlationAttributeCount(span) {
  return REQUIRED_AGENT_CORRELATION_ATTRIBUTES.filter((name) =>
    hasNonEmptyAttribute(span, name),
  ).length;
}

function hasNonEmptyAttribute(span, name) {
  const value = attributeValue(span.attributes, name);
  return value !== undefined && String(value) !== "";
}
