import { createPostgresAgentRunInputStoreFromEnvironment } from "@/server/data/agent-run-input-store";
import { createPostgresAgentRunStoreFromEnvironment } from "@/server/data/agent-run-store";
import {
  agentRunResponse,
  databaseUnavailable,
  isAgentRunId,
  problem,
} from "@/server/agent-runs/http-response";
import { parseRespondAgentRun } from "@/server/agent-runs/input";
import {
  AgentRunOperationError,
  respondAgentRun,
} from "@/server/agent-runs/service";
import { authenticateHostRequest, requireHostScope } from "@/server/http/host-request-auth";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 128 * 1024;
const store = createPostgresAgentRunStoreFromEnvironment();
const inputStore = createPostgresAgentRunInputStoreFromEnvironment();
type RouteContext = { readonly params: Promise<{ readonly runId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireHostScope(
    await authenticateHostRequest(request),
    "agent:runs",
  );
  if (!authenticated.ok) return authenticated.response;
  if (!store || !inputStore) return databaseUnavailable();
  const { runId } = await context.params;
  if (!isAgentRunId(runId)) return notFound();

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return problem(413, "agent_run_input_too_large", "The AgentRun input response exceeds 128 KiB.");
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return problem(400, "invalid_json", "The AgentRun input response must be valid JSON.");
  }
  const parsed = parseRespondAgentRun(value);
  if (!parsed.ok) return problem(400, "invalid_agent_run_input", parsed.error);

  try {
    const outcome = await respondAgentRun({
      accessToken: authenticated.accessToken,
      identity: authenticated.identity,
      inputStore,
      request: parsed.value,
      runId,
      store,
    });
    return outcome
      ? agentRunResponse(
          outcome.record,
          { disposition: outcome.disposition, ok: true },
          outcome.disposition === "accepted" ? 202 : 200,
        )
      : notFound();
  } catch (error) {
    return error instanceof AgentRunOperationError
      ? problem(error.status, error.code, error.message)
      : problem(502, "agent_run_input_failed", "The AgentRun input response could not be accepted.");
  }
}

function notFound(): Response {
  return problem(404, "agent_run_not_found", "The AgentRun was not found for this principal.");
}
