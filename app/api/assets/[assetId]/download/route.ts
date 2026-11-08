import { createAssetStoreFromEnvironment } from "@/server/data/asset-store";
import { authenticateAssetRequest, requireAssetScope } from "@/server/http/asset-request-auth";
import { issueAssetDownload } from "@/server/http/asset-download";
import { readPreviewSigningSecret } from "@/lib/preview-token";
import { AssetStoreError } from "@/server/data/asset-store";

export const runtime = "nodejs";

export async function POST(request: Request, context: { readonly params: Promise<{ readonly assetId: string }> }): Promise<Response> {
  const authenticated = requireAssetScope(await authenticateAssetRequest(request), "asset:read");
  if (!authenticated.ok) return authenticated.response;
  const { assetId } = await context.params;
  try {
    return await issueAssetDownload({ assetId, authenticated, store: createAssetStoreFromEnvironment(), secret: readPreviewSigningSecret() });
  } catch (error) {
    if (error instanceof AssetStoreError) return Response.json({ ok: false, error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
    return Response.json({ ok: false, error: "The asset download could not be prepared." }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
