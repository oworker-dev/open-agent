import type { AgentWorkspaceClientConfig } from "./contracts.js";

const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
export const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;

/** Only service-owned asset endpoints may receive the Host credential. */
export function authenticatedAssetPreviewUrl(source: string, serviceOrigin: string): string | undefined {
  try {
    const base = new URL(serviceOrigin);
    const url = new URL(source, base);
    if (!["https:", "http:"].includes(base.protocol) || url.origin !== base.origin || url.username || url.password ||
        !/^\/api\/assets\/[^/]+$/u.test(url.pathname) || /%2f|%5c/iu.test(url.pathname)) return undefined;
    return url.toString();
  } catch { return undefined; }
}

export async function readBrowserAssetPreview(
  url: string,
  config: AgentWorkspaceClientConfig | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Blob> {
  const response = await requestBrowserAsset(url, config, signal, fetcher);
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Image preview failed (${response.status}).`); }
  const mediaType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!mediaType.startsWith("image/") || mediaType === "image/svg+xml") { await response.body?.cancel(); throw new Error("This asset cannot be previewed as an image."); }
  if (Number(response.headers.get("content-length")) > MAX_PREVIEW_BYTES) {
    await response.body?.cancel();
    throw new Error("Image previews must be 32 MiB or smaller.");
  }
  if (!response.body) throw new Error("The image preview is empty.");
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_PREVIEW_BYTES) throw new Error("Image previews must be 32 MiB or smaller.");
      parts.push(new Uint8Array(part.value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!size) throw new Error("The image preview is empty.");
  return new Blob(parts, { type: mediaType });
}

/** One bounded, credentialed request; never follow an asset redirect with Host credentials. */
async function requestBrowserAsset(
  url: string, config: AgentWorkspaceClientConfig | undefined, signal: AbortSignal,
  fetcher: typeof fetch, action?: "download",
): Promise<Response> {
  const base = config?.host || (typeof window !== "undefined" ? window.location.origin : new URL(url).origin);
  const endpoint = authenticatedAssetPreviewUrl(url, base);
  if (!endpoint) throw new Error("Asset requests must use the configured asset service.");
  const headers = new Headers(typeof config?.headers === "function" ? await config.headers() : config?.headers);
  if (config?.auth && "bearer" in config.auth) {
    const token = typeof config.auth.bearer === "function" ? await config.auth.bearer() : config.auth.bearer;
    headers.set("authorization", `Bearer ${token}`);
  }
  signal.throwIfAborted();
  const target = new URL(endpoint);
  if (action) { target.pathname += "/download"; target.search = ""; target.hash = ""; }
  return fetcher(target.toString(), { method: action ? "POST" : "GET", credentials: "include", headers, redirect: "error", signal });
}

/** Signed publications/custom URLs receive no Host credentials; text never loads the full file. */
export async function readBrowserAssetText(
  url: string, config: AgentWorkspaceClientConfig | undefined, signal: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<{ text: string; truncated: boolean }> {
  const endpoint = authenticatedAssetPreviewUrl(url, config?.host || (typeof window !== "undefined" ? window.location.origin : new URL(url).origin));
  signal.throwIfAborted();
  const response = endpoint ? await requestBrowserAsset(endpoint, config, signal, fetcher)
    : await fetcher(url, { credentials: "omit", redirect: "error", signal });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`File preview failed (${response.status}).`); }
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) return { text: parts.join("") + decoder.decode(), truncated: false };
      const remaining = MAX_TEXT_PREVIEW_BYTES - size;
      parts.push(decoder.decode(part.value.subarray(0, remaining), { stream: true }));
      size += part.value.byteLength;
      // Avoid adding a replacement character for a partial UTF-8 character at the boundary.
      if (size > MAX_TEXT_PREVIEW_BYTES) return { text: parts.join(""), truncated: true };
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Prepare a single-asset link, then let the browser stream bytes without a Host token in its URL. */
export async function prepareBrowserAssetDownload(
  source: string, config: AgentWorkspaceClientConfig | undefined, signal: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<string> {
  const base = config?.host || (typeof window !== "undefined" ? window.location.origin : new URL(source).origin);
  const endpoint = authenticatedAssetPreviewUrl(source, base);
  if (!endpoint) {
    const url = new URL(source, base);
    if (!["https:", "http:", "blob:"].includes(url.protocol) || url.username || url.password) throw new Error("This file cannot be downloaded.");
    return url.toString();
  }
  const response = await requestBrowserAsset(endpoint, config, signal, fetcher, "download");
  if (!response.ok) { await response.body?.cancel(); throw new Error(`File download failed (${response.status}).`); }
  const result = await response.json() as { url?: unknown };
  const url = typeof result.url === "string" ? authenticatedAssetPreviewUrl(result.url, base) : undefined;
  if (!url || new URL(url).pathname !== new URL(endpoint).pathname || !new URL(url).searchParams.has("downloadGrant")) throw new Error("The asset service returned an invalid download link.");
  return url;
}
