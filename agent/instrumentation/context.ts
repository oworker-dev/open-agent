import { otelIntegration } from "eve/instrumentation/otel";
import { agentCorrelationAttributes } from "../lib/observability.ts";

export default otelIntegration({
  runtimeContext: ({ session, turn, run, channel }) => ({
    ...agentCorrelationAttributes(session),
    "open_agent.turn_id": turn?.id ?? "",
    "open_agent.turn_sequence": turn?.sequence ?? -1,
    "open_agent.model_run_id": run.id,
    "open_agent.model_attempt": run.attempt,
    "open_agent.channel": channel.kind,
  }),
});
