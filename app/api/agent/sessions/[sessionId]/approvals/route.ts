import { authenticateHostRequest, HOST_AGENT_SCOPE, requireHostScope } from "@/server/http/host-request-auth";
import { readAgentSession, AgentSessionDeletionError } from "@/server/agent-sessions/service";
import { syncAgentSessionApprovalsFromEvents } from "@/server/agent-sessions/approval";
import { createPostgresSessionOwnershipStoreFromEnvironment } from "@/server/data/session-ownership-store";
import { createPostgresAgentSessionApprovalStoreFromEnvironment } from "@/server/agent-sessions/approval";

export const runtime = "nodejs";
const ownershipStore = createPostgresSessionOwnershipStoreFromEnvironment();
const approvalStore = createPostgresAgentSessionApprovalStoreFromEnvironment();
type RouteContext = { readonly params: Promise<{ readonly sessionId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireHostScope(
    await authenticateHostRequest(request),
    HOST_AGENT_SCOPE.approvalRead,
  );
  if (!authenticated.ok) return authenticated.response;
  if (!ownershipStore || !approvalStore) return problem(503, "agent_database_unavailable", "AGENT_DATABASE_URL is not configured.");
  const { sessionId } = await context.params;
  try {
    const pages: import("@oworker/open-agent-contracts/agent-session").AgentSessionEvent[] = [];
    let after = 0;
    let history: Awaited<ReturnType<typeof readAgentSession>>;
    for (let page = 0; page < 100; page += 1) {
      history = await readAgentSession({
        accessToken: authenticated.accessToken,
        after,
        identity: authenticated.identity,
        limit: 1_000,
        ownershipStore,
        sessionId,
      });
      if (!history) break;
      pages.push(...history.events);
      after = history.nextCursor;
      if (!history.hasMore) break;
    }
    if (!history) return problem(404, "agent_session_not_found", "The Agent session was not found.");
    const pending = await syncAgentSessionApprovalsFromEvents({ events: pages, sessionId, store: approvalStore });
    return Response.json({ ok: true, pendingApprovals: pending, session: history.session }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return error instanceof AgentSessionDeletionError
      ? problem(error.status, error.code, error.message)
      : problem(502, "agent_session_approvals_failed", "The Agent approval state could not be read.");
  }
}

function problem(status: number, code: string, error: string): Response {
  return Response.json({ code, error, ok: false }, { headers: { "cache-control": "no-store" }, status });
}
