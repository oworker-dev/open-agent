import { createEveAgentMailboxRuntime } from "@/server/agent-mailbox/eve-runtime";
import { createPostgresSessionOwnershipStoreFromEnvironment } from "@/server/data/session-ownership-store";
import { authenticateStandaloneRequest } from "@/server/http/standalone-request-auth";

export const runtime = "nodejs";

const ownershipStore = createPostgresSessionOwnershipStoreFromEnvironment();

type RouteContext = { readonly params: Promise<{ readonly sessionId: string }> };

/**
 * Return the current Eve lifecycle boundary without exposing the runtime
 * bearer token to a standalone browser. The opaque cookie and ownership table
 * remain the authorization boundary.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = authenticateStandaloneRequest(request);
  if (!ownershipStore) return problem(503, "agent_database_unavailable", "AGENT_DATABASE_URL is not configured.", authenticated.setCookie);
  const { sessionId } = await context.params;
  const ownership = await ownershipStore.verify(sessionId, authenticated.identity);
  if (ownership !== "owned") {
    return problem(ownership === "missing" ? 404 : 403, "agent_session_not_found", "The Agent session is not available for this principal.", authenticated.setCookie);
  }
  try {
    const boundary = await createEveAgentMailboxRuntime().inspect({ owner: authenticated.identity, sessionId });
    return Response.json({ ok: true, ...boundary }, { headers: responseHeaders(authenticated.setCookie) });
  } catch {
    return problem(502, "agent_session_boundary_unavailable", "The Agent runtime boundary could not be inspected.", authenticated.setCookie);
  }
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
