import { createAssetStoreFromEnvironment } from "@/server/data/asset-store";
import { authResponseHeaders, authenticateAssetRequest } from "@/server/http/asset-request-auth";
import { problem, readBoundedRequestBody, storeProblem } from "../../route";
import { z } from "zod";

export const runtime = "nodejs";
type RouteContext = { readonly params: Promise<{ readonly uploadId: string }> };
const schema = z.object({ checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict().default({});

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = await authenticateAssetRequest(request);
  if (!authenticated.ok) return authenticated.response;
  const { uploadId } = await context.params;
  let input: unknown = {};
  try {
    if (Number(request.headers.get("content-length") ?? "0") > 64 * 1024) return problem(413, "asset_upload_request_too_large", "The completion request is too large.");
    const body = new TextDecoder().decode(await readBoundedRequestBody(request, 64 * 1024));
    input = body.trim().length === 0 ? {} : JSON.parse(body);
  } catch {
    return problem(400, "invalid_json", "The completion request must be valid JSON.");
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) return problem(400, "invalid_asset_completion", "The asset completion payload is invalid.");
  try {
    const asset = await createAssetStoreFromEnvironment().completeUpload({
      owner: authenticated.identity,
      uploadId,
      ...(parsed.data.checksumSha256 ? { checksumSha256: parsed.data.checksumSha256 } : {}),
    });
    return Response.json({ asset, ok: true }, { headers: { "cache-control": "no-store", ...authResponseHeaders(authenticated) }, status: 201 });
  } catch (error) {
    return storeProblem(error);
  }
}
