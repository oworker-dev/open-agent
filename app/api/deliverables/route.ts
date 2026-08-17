import { createSessionDeliverableRegistryFromEnvironment } from "@/server/data/session-deliverable-registry";
import { authResponseHeaders, authenticateAssetRequest, requireAssetScope } from "@/server/http/asset-request-auth";

export const runtime = "nodejs";

/** List the authenticated caller's durable uploads and published turn results. */
export async function GET(request: Request): Promise<Response> {
  const authenticated = requireAssetScope(await authenticateAssetRequest(request), "asset:read");
  if (!authenticated.ok) return authenticated.response;
  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim();
  if (!sessionId || sessionId.length > 512) {
    return Response.json(
      { code: "invalid_session_id", error: "A valid sessionId is required.", ok: false },
      { headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) }, status: 400 },
    );
  }
  try {
    const deliverables = await createSessionDeliverableRegistryFromEnvironment().list(sessionId, authenticated.identity);
    return Response.json(
      { deliverables, ok: true },
      { headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) } },
    );
  } catch {
    return Response.json(
      { code: "deliverable_list_failed", error: "The session deliverables could not be listed.", ok: false },
      { headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) }, status: 500 },
    );
  }
}
