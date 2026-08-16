/** Browser-safe response headers for user-controlled asset bytes. */
export function safeAssetContentType(value: string): string {
  return isSafeInlineType(value) ? value : "application/octet-stream";
}

export function assetContentDisposition(value: string, filename: string): string {
  return `${isSafeInlineType(value) ? "inline" : "attachment"}; filename="${safeHeaderFilename(filename)}"`;
}

function isSafeInlineType(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) return false;
  // Never let an uploaded document become an executable browser resource.
  if (normalized === "image/svg+xml" || normalized === "text/html" || normalized === "application/xhtml+xml") return false;
  if (normalized.includes("javascript") || normalized.includes("ecmascript") || normalized.includes("xml")) return false;
  return normalized.startsWith("image/") || normalized.startsWith("audio/") || normalized.startsWith("video/") || normalized === "application/pdf" || normalized.startsWith("text/plain") || normalized.startsWith("text/markdown");
}

function safeHeaderFilename(value: string): string {
  return value.replace(/["\\\r\n]/gu, "_");
}
