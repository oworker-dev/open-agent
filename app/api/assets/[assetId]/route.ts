import { AssetStoreError, createAssetStoreFromEnvironment } from "@/server/data/asset-store";
import { authResponseHeaders, authenticateAssetRequest, requireAssetScope } from "@/server/http/asset-request-auth";
import { assetContentDisposition, safeAssetContentType } from "@/server/http/asset-content";
import { verifyAssetDownloadToken } from "@/lib/asset-download-token";
import { readPreviewSigningSecret } from "@/lib/preview-token";
import type { AssetRequestAuthentication } from "@/server/http/asset-request-auth";

export const runtime = "nodejs";
type RouteContext = { readonly params: Promise<{ readonly assetId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { assetId } = await context.params;
  const grant = new URL(request.url).searchParams.get("downloadGrant");
  let authenticated: AssetRequestAuthentication;
  if (grant !== null && !request.headers.has("authorization")) {
    // Missing signing configuration must fail closed without leaking details.
    let claims;
    try { claims = verifyAssetDownloadToken(grant, assetId, readPreviewSigningSecret()); }
    catch { return response(503, "Asset downloads are temporarily unavailable."); }
    if (!claims) return response(401, "The asset download link has expired or is invalid.");
    authenticated = { ok: true, identity: claims.owner };
  } else authenticated = requireAssetScope(await authenticateAssetRequest(request), "asset:read");
  if (!authenticated.ok) return authenticated.response;
  const rangeHeader = request.headers.get("range");
  const range = parseRange(rangeHeader);
  if (rangeHeader && !range) return response(416, "The requested asset byte range is invalid.");
  try {
    const store = createAssetStoreFromEnvironment();
    const asset = await store.findAsset(assetId, authenticated.identity);
    if (!asset) return response(404, "Asset not found.");
    const download = await store.openReadStream(assetId, authenticated.identity, range ?? undefined);
    if (!download) return response(404, "Asset not found.");
    const status = range ? 206 : 200;
    const headers = new Headers({
      "cache-control": grant !== null ? "private, no-store" : "private, max-age=60",
      "content-disposition": assetContentDisposition(download.contentType, download.filename, grant !== null),
      "content-length": String(download.contentLength),
      "content-type": safeAssetContentType(download.contentType),
      "cross-origin-resource-policy": "same-site",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    for (const [key, value] of Object.entries(authResponseHeaders(authenticated))) headers.set(key, String(value));
    if (range) headers.set("content-range", `bytes ${range.start}-${range.start + download.contentLength - 1}/${asset.sizeBytes}`);
    headers.set("accept-ranges", "bytes");
    return new Response(download.stream, { headers, status });
  } catch (error) {
    if (error instanceof AssetStoreError) return response(error.status, error.message);
    return response(500, "The asset could not be read.");
  }
}

/** Delete one test/user asset after an explicit owner check. */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireAssetScope(await authenticateAssetRequest(request), "asset:write");
  if (!authenticated.ok) return authenticated.response;
  const { assetId } = await context.params;
  try {
    const store = createAssetStoreFromEnvironment();
    await store.deleteAsset({ assetId, owner: authenticated.identity });
    return new Response(null, {
      headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) },
      status: 204,
    });
  } catch (error) {
    if (error instanceof AssetStoreError && error.code === "not_found") return response(404, "Asset not found.");
    if (error instanceof AssetStoreError) return response(error.status, error.message);
    return response(500, "The asset could not be deleted.");
  }
}

function parseRange(value: string | null): { end?: number; start: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  return Number.isSafeInteger(start) && (end === undefined || (Number.isSafeInteger(end) && end >= start)) ? { start, ...(end === undefined ? {} : { end }) } : null;
}

function response(status: number, message: string): Response {
  return new Response(message, { headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" }, status });
}
