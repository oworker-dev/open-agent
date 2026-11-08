import { otel } from "eve/instrumentation/otel";

// Keep prompts and output out of trace exports. Durable transcript retention is
// configured independently on the agent so completed conversations stay readable.
export default otel({
  functionId: "open-agent",
  tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
});
