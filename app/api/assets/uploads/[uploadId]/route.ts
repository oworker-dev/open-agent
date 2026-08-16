import { AssetStoreError, createAssetStoreFromEnvironment } from "@/server/data/asset-store";
import { authResponseHeaders, authenticateAssetRequest } from "@/server/http/asset-request-auth";
import { problem, storeProblem } from "../route";

export const runtime = "nodejs";
type RouteContext = { readonly params: Promise<{ readonly uploadId: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const authenticated = await authenticateAssetRequest(_request);
  if (!authenticated.ok) return authenticated.response;
  const { uploadId } = await context.params;
  try {
    const store = createAssetStoreFromEnvironment();
    const upload = await store.findUpload(uploadId, authenticated.identity);
    return upload
      ? Response.json({ ok: true, upload }, { headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) } })
      : problem(404, "asset_upload_not_found", "The asset upload was not found.");
  } catch (error) {
    if (error instanceof AssetStoreError && error.code === "not_found") return problem(404, "asset_upload_not_found", "The asset upload was not found.");
    return storeProblem(error);
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = await authenticateAssetRequest(request);
  if (!authenticated.ok) return authenticated.response;
  const { uploadId } = await context.params;
  try {
    const store = createAssetStoreFromEnvironment();
    await store.abortUpload({ owner: authenticated.identity, uploadId });
    return new Response(null, { headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) }, status: 204 });
  } catch (error) {
    if (error instanceof AssetStoreError && error.code === "not_found") return problem(404, "asset_upload_not_found", "The asset upload was not found.");
    return storeProblem(error);
  }
}
