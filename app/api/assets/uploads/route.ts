import { problem, readBoundedRequestBody, storeProblem } from "@/server/http/asset-upload-response";
import { createAssetStoreFromEnvironment } from "@/server/data/asset-store";
import { authResponseHeaders, authenticateAssetRequest, requireAssetScope } from "@/server/http/asset-request-auth";
import { z } from "zod";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 64 * 1024;
const createUploadSchema = z.object({
  assetId: z.string().min(1).max(512).optional(),
  filename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(200),
  messageId: z.string().min(1).max(512).optional(),
  sessionId: z.string().min(1).max(512),
  sizeBytes: z.number().int().positive(),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const authenticated = requireAssetScope(await authenticateAssetRequest(request), "asset:write");
  if (!authenticated.ok) return authenticated.response;
  if (tooLarge(request, MAX_REQUEST_BYTES)) return problem(413, "asset_upload_request_too_large", "The upload initialization request is too large.");
  let input: unknown;
  try {
    const body = await readBoundedRequestBody(request, MAX_REQUEST_BYTES);
    input = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return problem(400, "invalid_json", "The request body must be valid JSON.");
  }
  const parsed = createUploadSchema.safeParse(input);
  if (!parsed.success) return problem(400, "invalid_asset_upload", "The upload metadata is invalid.");
  try {
    const store = createAssetStoreFromEnvironment();
    const upload = await store.createUpload({
      ...(parsed.data.assetId ? { assetId: parsed.data.assetId } : {}),
      filename: parsed.data.filename,
      mediaType: parsed.data.mediaType,
      ...(parsed.data.messageId ? { messageId: parsed.data.messageId } : {}),
      owner: authenticated.identity,
      sessionId: parsed.data.sessionId,
      sizeBytes: parsed.data.sizeBytes,
    });
    return Response.json({ ok: true, upload }, { headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) }, status: 201 });
  } catch (error) {
    return storeProblem(error);
  }
}

function tooLarge(request: Request, maxBytes: number): boolean {
  const value = Number(request.headers.get("content-length") ?? "0");
  return Number.isFinite(value) && value > maxBytes;
}
