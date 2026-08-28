/**
 * Read a request body without allowing a chunked client to allocate an
 * unbounded string before the route can reject it. The caller can translate
 * the typed errors into its own HTTP contract.
 */
export class RequestBodyTooLargeError extends Error {
  readonly code = "request_body_too_large";
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`The request body exceeds the ${maxBytes}-byte limit.`);
    this.name = "RequestBodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export async function readRequestTextWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer.");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }

  if (!request.body) {
    const text = await request.text();
    if (Buffer.byteLength(text) > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
    return text;
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("request body exceeds limit").catch(() => undefined);
        throw new RequestBodyTooLargeError(maxBytes);
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}
