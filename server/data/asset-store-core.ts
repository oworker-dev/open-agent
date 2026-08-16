export const MAX_ASSET_BYTES = 10 * 1024 * 1024 * 1024;
export const ASSET_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const MAX_ASSET_PART_BYTES = 16 * 1024 * 1024;
export const DEFAULT_ASSET_TTL_SECONDS = 30 * 24 * 60 * 60;

import type {
  AssetMetadata,
  AssetScanStatus,
  AssetScanner,
} from "@oworker/open-agent-contracts/asset";

export class AssetStoreError extends Error {
  readonly code: "forbidden" | "invalid" | "not_found" | "conflict" | "quota";
  readonly status: number;

  constructor(
    code: AssetStoreError["code"],
    message: string,
  ) {
    super(message);
    this.name = "AssetStoreError";
    this.code = code;
    this.status = code === "forbidden" ? 403 : code === "not_found" ? 404 : code === "conflict" ? 409 : code === "quota" ? 413 : 400;
  }
}

export type AssetScanMode = "required" | "disabled";

/** Resolve one scanner result without exposing scanner diagnostics to clients. */
export async function scanAsset(
  metadata: AssetMetadata,
  mode: AssetScanMode,
  scanner: AssetScanner | undefined,
  openReadStream: () => Promise<ReadableStream<Uint8Array>>,
): Promise<AssetMetadata> {
  if (mode === "disabled") return { ...metadata, scanStatus: "disabled" };
  if (!scanner) return { ...metadata, scanStatus: "error" };
  try {
    const result = await scanner.scan({
      asset: { ...metadata, scanStatus: "scanning" },
      openReadStream,
    });
    const scanStatus: AssetScanStatus = result.status === "clean" ? "clean" : "rejected";
    return { ...metadata, scanStatus };
  } catch {
    // A scanner outage must never become implicit access to the bytes.
    return { ...metadata, scanStatus: "error" };
  }
}

/**
 * Validate values that are used as storage identifiers or path segments.
 * Tenant ids are included in S3 object keys, while asset/upload/session ids
 * are used to resolve filesystem paths, so these values must remain strict.
 */
export function assertAssetIdentifier(value: string, name: string): void {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || value.includes("/")
    || value.includes("\\")
    || value === "."
    || value === ".."
  ) {
    throw new AssetStoreError("invalid", `The ${name} is invalid.`);
  }
}

/**
 * Validate an authenticated principal identity. Eve qualifies JWT subjects
 * with the issuer (for example `https://issuer.example:user-1`), so this is
 * intentionally not a path-segment validator. The value is only persisted as
 * a database owner value and used for in-memory ownership locks.
 */
export function assertAssetPrincipalIdentifier(value: string, name: string): void {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new AssetStoreError("invalid", `The ${name} is invalid.`);
  }
}
