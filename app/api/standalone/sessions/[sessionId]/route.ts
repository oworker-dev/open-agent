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

/** Send cancellation through the server control plane so it is not delayed by
 * the browser's live response stream or its local Eve reducer. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = authenticateStandaloneRequest(request);
  if (!ownershipStore) return problem(503, "agent_database_unavailable", "AGENT_DATABASE_URL is not configured.", authenticated.setCookie);
  const { sessionId } = await context.params;
  const ownership = await ownershipStore.verify(sessionId, authenticated.identity);
  if (ownership !== "owned") {
    return problem(ownership === "missing" ? 404 : 403, "agent_session_not_found", "The Agent session is not available for this principal.", authenticated.setCookie);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(400, "invalid_json", "The session operation request must be valid JSON.", authenticated.setCookie);
  }
  if (!isRecord(body) || body.action !== "cancel" ||
      body.turnId !== undefined && (typeof body.turnId !== "string" || !body.turnId.trim())) {
    return problem(400, "agent_session_operation_invalid", "The session operation is invalid.", authenticated.setCookie);
  }
  try {
    const runtime = createEveAgentMailboxRuntime();
    if (!runtime.cancel) throw new Error("The Agent runtime does not expose session cancellation.");
    const status = await runtime.cancel({
      owner: authenticated.identity,
      sessionId,
      ...(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
    });
    return Response.json(
      { ok: true, status, ...(status === "accepted" ? { sessionId } : {}) },
      { headers: responseHeaders(authenticated.setCookie), status: status === "accepted" ? 202 : 200 },
    );
  } catch {
    return problem(502, "agent_session_cancellation_failed", "The Agent session could not be cancelled.", authenticated.setCookie);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
