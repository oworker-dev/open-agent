import { createAssetStoreFromEnvironment } from "@/server/data/asset-store";
import { authResponseHeaders, authenticateAssetRequest, requireAssetScope } from "@/server/http/asset-request-auth";

export const runtime = "nodejs";

/** List ready assets for one authenticated session without exposing bytes. */
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
  const store = createAssetStoreFromEnvironment();
  if (!store.listAssets) {
    return Response.json(
      { assets: [], ok: true },
      { headers: { "cache-control": "no-store", "x-agent-asset-list": "unsupported", ...authResponseHeaders(authenticated) } },
    );
  }
  try {
    const assets = await store.listAssets(sessionId, authenticated.identity);
    return Response.json({ assets, ok: true }, { headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) } });
  } catch {
    return Response.json(
      { code: "asset_list_failed", error: "The session assets could not be listed.", ok: false },
      { headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) }, status: 500 },
    );
  }
}
