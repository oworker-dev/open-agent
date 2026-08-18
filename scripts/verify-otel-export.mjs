import {
  anyValue,
  attributeValue,
  selectCorrelatedAgentIngress,
} from "./otel-verification.mjs";

const collectorUrl = process.env.OTEL_TEST_COLLECTOR_URL || "http://127.0.0.1:4318";
const probe = process.env.OTEL_TEST_PRIVATE_PROBE;

if (!probe) throw new Error("OTEL_TEST_PRIVATE_PROBE is required.");

const deadline = Date.now() + 15_000;
let requests = [];
while (Date.now() < deadline) {
  const response = await fetch(`${collectorUrl}/debug/traces`);
  const payload = await response.json();
  requests = Array.isArray(payload.requests) ? payload.requests : [];
  if (requests.length > 0) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const decoded = requests.flatMap((request) => {
  try {
    return [JSON.parse(request.body)];
  } catch {
    return [];
  }
});
const spans = decoded.flatMap((payload) =>
  (payload.resourceSpans || []).flatMap((resourceSpan) => {
    const serviceName = attributeValue(resourceSpan.resource?.attributes, "service.name");
    return (resourceSpan.scopeSpans || []).flatMap((scopeSpan) =>
      (scopeSpan.spans || []).map((span) => ({ ...span, serviceName })),
    );
  }),
);
if (spans.length === 0) throw new Error("The collector did not receive any OTLP spans.");

const serialized = JSON.stringify(decoded);
if (serialized.includes(probe)) {
  throw new Error("A private prompt or model output was exported in an OpenTelemetry span.");
}

const agentSpans = spans.filter((span) => span.serviceName === "open-agent");
const webSpans = spans.filter((span) => span.serviceName === "open-agent-web");
if (agentSpans.length === 0) throw new Error("No Eve Agent runtime spans were exported.");
if (webSpans.length === 0) throw new Error("No Agent Web service spans were exported.");

const linkedIngress = selectCorrelatedAgentIngress(agentSpans, webSpans);

console.log(JSON.stringify({
  durableTraceLink: true,
  privateContentExported: false,
  requestCount: requests.length,
  services: [...new Set(spans.map((span) => span.serviceName).filter(Boolean))].sort(),
  spanCount: spans.length,
  traceId: linkedIngress.traceId,
  verifiedRunId: attributeValue(linkedIngress.attributes, "open_agent.run_id"),
}));
