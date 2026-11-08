import type { AssetStore } from "@oworker/open-agent-contracts/asset";
import type { AssetRequestAuthentication } from "./asset-request-auth.ts";
import { authResponseHeaders, requireAssetScope } from "./asset-request-auth.ts";
import { createAssetDownloadToken } from "../../lib/asset-download-token.ts";

export async function issueAssetDownload(input: {
  readonly assetId: string;
  readonly authenticated: AssetRequestAuthentication;
  readonly store: Pick<AssetStore, "findAsset">;
  readonly secret: string;
  readonly now?: number;
}): Promise<Response> {
  const authenticated = requireAssetScope(input.authenticated, "asset:read");
  if (!authenticated.ok) return authenticated.response;
  const asset = await input.store.findAsset(input.assetId, authenticated.identity);
  if (!asset) return problem(404, "The asset was not found.");
  if (asset.status !== "ready" || !["clean", "disabled"].includes(asset.scanStatus ?? "")) return problem(409, "The asset is not ready for download.");
  const grant = createAssetDownloadToken(asset.assetId, authenticated.identity, input.secret, input.now);
  return Response.json({ ok: true, url: `/api/assets/${encodeURIComponent(asset.assetId)}?downloadGrant=${encodeURIComponent(grant.token)}`, expiresAt: grant.expiresAt }, {
    headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) },
  });
}

function problem(status: number, error: string) { return Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } }); }
