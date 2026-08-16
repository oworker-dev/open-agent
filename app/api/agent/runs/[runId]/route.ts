import { createPostgresAgentRunStoreFromEnvironment } from "@/server/data/agent-run-store";
import {
  agentRunResponse,
  databaseUnavailable,
  isAgentRunId,
  problem,
} from "@/server/agent-runs/http-response";
import {
  AgentRunOperationError,
  cancelAgentRun,
  inspectAgentRun,
} from "@/server/agent-runs/service";
import { authenticateHostRequest, requireHostScope } from "@/server/http/host-request-auth";

export const runtime = "nodejs";

const store = createPostgresAgentRunStoreFromEnvironment();
type RouteContext = { readonly params: Promise<{ readonly runId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireHostScope(
    await authenticateHostRequest(request),
    "agent:runs",
  );
  if (!authenticated.ok) return authenticated.response;
  if (!store) return databaseUnavailable();
  const { runId } = await context.params;
  if (!isAgentRunId(runId)) return notFound();

  try {
    const record = await inspectAgentRun({
      accessToken: authenticated.accessToken,
      identity: authenticated.identity,
      runId,
      store,
    });
    return record ? agentRunResponse(record, { ok: true }) : notFound();
  } catch (error) {
    return operationFailure(error, "agent_run_inspection_failed", "The AgentRun could not be inspected.");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireHostScope(
    await authenticateHostRequest(request),
    "agent:runs",
  );
  if (!authenticated.ok) return authenticated.response;
  if (!store) return databaseUnavailable();
  const { runId } = await context.params;
  if (!isAgentRunId(runId)) return notFound();

  try {
    const outcome = await cancelAgentRun({
      accessToken: authenticated.accessToken,
      identity: authenticated.identity,
      runId,
      store,
    });
    return outcome
      ? agentRunResponse(outcome.record, { cancellation: outcome.cancellation, ok: true }, 202)
      : notFound();
  } catch (error) {
    return operationFailure(error, "agent_run_cancellation_failed", "The AgentRun could not be cancelled.");
  }
}

function notFound(): Response {
  return problem(404, "agent_run_not_found", "The AgentRun was not found for this principal.");
}

function operationFailure(error: unknown, code: string, message: string): Response {
  return error instanceof AgentRunOperationError
    ? problem(error.status, error.code, error.message)
    : problem(502, code, message);
}
