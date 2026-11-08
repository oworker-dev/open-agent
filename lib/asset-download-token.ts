import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { AgentSessionOwner } from "../server/data/session-ownership-store.ts";

export const ASSET_DOWNLOAD_TTL_MS = 5 * 60 * 1000;
type DownloadClaims = { readonly assetId: string; readonly owner: AgentSessionOwner; readonly expiresAt: number };

/** Opaque, single-asset, read-only grants; never a Host API credential. */
export function createAssetDownloadToken(assetId: string, owner: AgentSessionOwner, secret: string, now = Date.now()) {
  if (!validId(assetId) || !validOwner(owner)) throw new Error("Invalid asset download identity.");
  const expiresAt = now + ASSET_DOWNLOAD_TTL_MS;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(Buffer.from(`open-agent:asset-download:v1:${assetId}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ assetId, owner, expiresAt })), cipher.final()]);
  return { token: ["ad1", iv.toString("base64url"), encrypted.toString("base64url"), cipher.getAuthTag().toString("base64url")].join("."), expiresAt: new Date(expiresAt).toISOString() };
}

export function verifyAssetDownloadToken(token: string, assetId: string, secret: string, now = Date.now()): DownloadClaims | undefined {
  try {
    if (!validId(assetId) || token.length > 8192 || !/^ad1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) return undefined;
    const [, nonce, ciphertext, tag] = token.split(".");
    const iv = Buffer.from(nonce!, "base64url"), authTag = Buffer.from(tag!, "base64url");
    if (iv.length !== 12 || authTag.length !== 16) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", key(secret), iv);
    decipher.setAAD(Buffer.from(`open-agent:asset-download:v1:${assetId}`));
    decipher.setAuthTag(authTag);
    const claims = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext!, "base64url")), decipher.final()]).toString("utf8")) as Partial<DownloadClaims>;
    if (claims.assetId !== assetId || !validOwner(claims.owner) || typeof claims.expiresAt !== "number" ||
        !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= now || claims.expiresAt > now + ASSET_DOWNLOAD_TTL_MS) return undefined;
    return claims as DownloadClaims;
  } catch { return undefined; }
}

function key(secret: string): Buffer {
  if (secret.length < 32) throw new Error("Asset download signing requires a persistent secret.");
  return createHash("sha256").update("open-agent:asset-download:v1\0").update(secret).digest();
}
function validId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9_-]{1,512}$/u.test(value); }
function validIdentity(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 512; }
function validOwner(owner: unknown): owner is AgentSessionOwner {
  if (!owner || typeof owner !== "object") return false;
  const value = owner as AgentSessionOwner;
  return validIdentity(value.tenantId) && validIdentity(value.principalId) && validIdentity(value.principalType) &&
    (value.issuer === undefined || validIdentity(value.issuer));
}
