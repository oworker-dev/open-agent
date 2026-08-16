import { AssetStoreError, MAX_ASSET_PART_BYTES, createAssetStoreFromEnvironment } from "@/server/data/asset-store";
import { authResponseHeaders, authenticateAssetRequest, requireAssetScope } from "@/server/http/asset-request-auth";
import { problem, readBoundedRequestBody, storeProblem } from "../../../route";
import { z } from "zod";

export const runtime = "nodejs";
type RouteContext = { readonly params: Promise<{ readonly uploadId: string; readonly partNumber: string }> };
const partControlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sign"), sizeBytes: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("acknowledge"), etag: z.string().min(1).max(258), sizeBytes: z.number().int().positive() }).strict(),
]);

/** Issue or acknowledge a direct object-store part without proxying bytes. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireAssetScope(await authenticateAssetRequest(request), "asset:write");
  if (!authenticated.ok) return authenticated.response;
  const { partNumber: rawPartNumber, uploadId } = await context.params;
  const partNumber = Number(rawPartNumber);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1) return problem(400, "invalid_asset_part", "The asset part number is invalid.");
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, 16 * 1024)));
  } catch {
    return problem(400, "invalid_json", "The part control request must be valid JSON.");
  }
  const parsed = partControlSchema.safeParse(input);
  if (!parsed.success) return problem(400, "invalid_asset_part_control", "The part control payload is invalid.");
  try {
    const store = createAssetStoreFromEnvironment();
    if (parsed.data.action === "sign") {
      if (!store.createPartUpload) return problem(409, "asset_direct_upload_unsupported", "This asset store does not support direct uploads.");
      const target = await store.createPartUpload({
        owner: authenticated.identity,
        partNumber,
        sizeBytes: parsed.data.sizeBytes,
        uploadId,
      });
      return Response.json({ ok: true, target }, { headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) } });
    }
    if (!store.acknowledgePart) return problem(409, "asset_direct_upload_unsupported", "This asset store does not support direct uploads.");
    const part = await store.acknowledgePart({
      etag: parsed.data.etag,
      owner: authenticated.identity,
      partNumber,
      sizeBytes: parsed.data.sizeBytes,
      uploadId,
    });
    return Response.json({ ok: true, part }, { headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) } });
  } catch (error) {
    return storeProblem(error);
  }
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireAssetScope(await authenticateAssetRequest(request), "asset:write");
  if (!authenticated.ok) return authenticated.response;
  const { partNumber: rawPartNumber, uploadId } = await context.params;
  const partNumber = Number(rawPartNumber);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1) return problem(400, "invalid_asset_part", "The asset part number is invalid.");
  const store = createAssetStoreFromEnvironment();
  try {
    const upload = await store.findUpload(uploadId, authenticated.identity);
    if (!upload) return problem(404, "asset_upload_not_found", "The asset upload was not found.");
    if (upload.transferStrategy === "direct") {
      return problem(409, "asset_direct_upload_required", "Upload this part to its short-lived object-store target.");
    }
  } catch (error) {
    return storeProblem(error);
  }
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
    const part = await store.writePart({ content, owner: authenticated.identity, partNumber, uploadId });
    return Response.json({ ok: true, part }, { headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) }, status: 200 });
  } catch (error) {
    return storeProblem(error);
  }
}
