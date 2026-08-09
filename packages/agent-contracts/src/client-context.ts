export const AGENT_CLIENT_CONTEXT_MAX_ENTRIES = 64;
export const AGENT_CLIENT_CONTEXT_MAX_TOKENS = 20_000;
export const AGENT_APPROXIMATE_BYTES_PER_TOKEN = 4;
export const AGENT_CLIENT_CONTEXT_MAX_BYTES =
  AGENT_CLIENT_CONTEXT_MAX_TOKENS * AGENT_APPROXIMATE_BYTES_PER_TOKEN;

/** Transport guard for model-facing client context. Semantic reduction happens before this boundary. */
export function isBoundedAgentClientContext(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > AGENT_CLIENT_CONTEXT_MAX_ENTRIES) return false;
  let totalBytes = 0;
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) return false;
    totalBytes += utf8ByteLength(entry);
    if (totalBytes > AGENT_CLIENT_CONTEXT_MAX_BYTES) return false;
  }
  return true;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0;
    if (codePoint > 0xffff) index += 1;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}
