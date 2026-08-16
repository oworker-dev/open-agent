import { createPostgresAgentRunStoreFromEnvironment } from "@/server/data/agent-run-store";
import {
  agentRunHeaders,
  databaseUnavailable,
  isAgentRunId,
  problem,
} from "@/server/agent-runs/http-response";
import {
  AgentRunOperationError,
  readAgentRunEvents,
  toAgentRunSnapshot,
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
  const after = parseCursor(new URL(request.url).searchParams.get("after"));
  if (after === undefined) {
    return problem(400, "agent_run_cursor_invalid", "after must be a non-negative integer.");
  }

  try {
    const result = await readAgentRunEvents({
      accessToken: authenticated.accessToken,
      after,
      identity: authenticated.identity,
      runId,
      store,
    });
    if (!result) return notFound();
    return Response.json(
      {
        events: result.events,
        nextCursor: result.nextCursor,
        ok: true,
        run: toAgentRunSnapshot(result.record),
      },
      { headers: agentRunHeaders(result.record) },
    );
  } catch (error) {
    return error instanceof AgentRunOperationError
      ? problem(error.status, error.code, error.message)
      : problem(502, "agent_run_events_failed", "The AgentRun events could not be read.");
  }
}

function parseCursor(value: string | null): number | undefined {
  if (value === null || value === "") return 0;
  if (!/^\d+$/.test(value)) return undefined;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : undefined;
}

function notFound(): Response {
  return problem(404, "agent_run_not_found", "The AgentRun was not found for this principal.");
}
