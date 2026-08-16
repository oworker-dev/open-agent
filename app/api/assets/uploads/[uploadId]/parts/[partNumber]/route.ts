import { AssetStoreError, MAX_ASSET_PART_BYTES, createAssetStoreFromEnvironment } from "@/server/data/asset-store";
import { authResponseHeaders, authenticateAssetRequest } from "@/server/http/asset-request-auth";
import { problem, readBoundedRequestBody, storeProblem } from "../../../route";

export const runtime = "nodejs";
type RouteContext = { readonly params: Promise<{ readonly uploadId: string; readonly partNumber: string }> };

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = await authenticateAssetRequest(request);
  if (!authenticated.ok) return authenticated.response;
  const { partNumber: rawPartNumber, uploadId } = await context.params;
  const partNumber = Number(rawPartNumber);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1) return problem(400, "invalid_asset_part", "The asset part number is invalid.");
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && (contentLength <= 0 || contentLength > MAX_ASSET_PART_BYTES)) {
    return problem(413, "asset_part_too_large", `Asset parts must be between 1 byte and ${MAX_ASSET_PART_BYTES} bytes.`);
  }
  let content: Uint8Array;
  try {
    const bytes = await readBoundedRequestBody(request, MAX_ASSET_PART_BYTES);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_PART_BYTES) return problem(413, "asset_part_too_large", `Asset parts must be between 1 byte and ${MAX_ASSET_PART_BYTES} bytes.`);
    content = bytes;
  } catch {
    return problem(400, "invalid_asset_part", "The asset part could not be read.");
  }
  try {
    const part = await createAssetStoreFromEnvironment().writePart({ content, owner: authenticated.identity, partNumber, uploadId });
    return Response.json({ ok: true, part }, { headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) }, status: 200 });
  } catch (error) {
    return storeProblem(error);
  }
}
