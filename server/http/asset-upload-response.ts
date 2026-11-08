import { AssetStoreError } from "../data/asset-store.ts";

export function problem(status: number, code: string, error: string): Response {
  return Response.json({ code, error, ok: false }, { headers: { "cache-control": "no-store" }, status });
}

export function storeProblem(error: unknown): Response {
  if (error instanceof AssetStoreError) return problem(error.status, `asset_${error.code}`, error.message);
  return problem(500, "asset_store_failed", "The asset operation could not be completed.");
}

/** Read one bounded upload control body without trusting Content-Length. */
export async function readBoundedRequestBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request too large");
        throw new AssetStoreError("quota", `The request exceeds the ${maxBytes} byte limit.`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
