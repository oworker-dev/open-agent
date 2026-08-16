import { listAgentSubagents } from "@/server/agent-sessions/subagents";
import { createPostgresAgentSubagentStoreFromEnvironment } from "@/server/data/agent-subagent-store";
import { createPostgresSessionOwnershipStoreFromEnvironment } from "@/server/data/session-ownership-store";
import { authenticateStandaloneRequest } from "@/server/http/standalone-request-auth";

export const runtime = "nodejs";

const ownershipStore = createPostgresSessionOwnershipStoreFromEnvironment();
const subagentStore = createPostgresAgentSubagentStoreFromEnvironment();

type RouteContext = {
  readonly params: Promise<{ readonly sessionId: string }>;
};

/**
 * Standalone browsers authenticate with their opaque owner cookie. Embedded
 * hosts use the separate /api/agent route and its scoped Host JWT contract.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = authenticateStandaloneRequest(request);
  if (!ownershipStore || !subagentStore) {
    return problem(
      503,
      "agent_subagent_store_unavailable",
      "The Agent database is not configured for subagent control.",
      authenticated.setCookie,
    );
  }

  const { sessionId } = await context.params;
  const result = await listAgentSubagents({
    // Runtime inspection uses the persisted standalone owner. No Host bearer
    // credential is forwarded through this endpoint.
    accessToken: "",
    identity: authenticated.identity,
    ownershipStore,
    parentSessionId: sessionId,
    store: subagentStore,
  });
  return result
    ? Response.json(
        { ok: true, ...result },
        { headers: responseHeaders(authenticated.setCookie) },
      )
    : problem(
        404,
        "agent_session_not_found",
        "The parent Agent session was not found.",
        authenticated.setCookie,
      );
}

function responseHeaders(setCookie?: string): HeadersInit {
  return {
    "cache-control": "no-store",
    ...(setCookie ? { "set-cookie": setCookie } : {}),
  };
}

function problem(status: number, code: string, error: string, setCookie?: string): Response {
  return Response.json(
    { code, error, ok: false },
    { headers: responseHeaders(setCookie), status },
  );
}
