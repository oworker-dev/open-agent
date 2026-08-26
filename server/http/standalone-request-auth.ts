import { createHash, randomBytes } from "node:crypto";

import type { AgentSessionOwner } from "../data/session-ownership-store.ts";

const COOKIE_NAME = "open_agent_anonymous";
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export type StandaloneRequestIdentity = {
  readonly identity: AgentSessionOwner;
  readonly setCookie?: string;
};

/**
 * Resolves an identity only when the browser already owns a valid standalone
 * credential. Authentication middleware must not mint credentials because it
 * cannot attach Set-Cookie to Eve's auth result.
 */
export function resolveStandaloneRequestIdentity(
  request: Request,
): AgentSessionOwner | undefined {
  const credential = parseCookies(request.headers.get("cookie")).get(COOKIE_NAME);
  return isValidCredential(credential) ? identityForCredential(credential) : undefined;
}

/**
 * Standalone Open Agent uses an opaque, unguessable browser credential. The
 * database only receives its hash, so the cookie itself remains a bearer
 * secret and contains no trusted claims that need to be decoded or signed.
 */
export function authenticateStandaloneRequest(request: Request): StandaloneRequestIdentity {
  const existing = parseCookies(request.headers.get("cookie")).get(COOKIE_NAME);
  const credential = isValidCredential(existing) ? existing : randomBytes(32).toString("base64url");

  return {
    identity: identityForCredential(credential),
    ...(credential === existing
      ? {}
      : { setCookie: serializeCookie(request, credential) }),
  };
}

function identityForCredential(credential: string): AgentSessionOwner {
  return {
    principalId: `anonymous:${createHash("sha256").update(credential).digest("base64url")}`,
    principalType: "user",
    tenantId: "open-agent-standalone",
  };
}

function parseCookies(value: string | null): Map<string, string> {
  const result = new Map<string, string>();
  if (!value) return result;
  for (const item of value.split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const cookieValue = item.slice(separator + 1).trim();
    if (name) result.set(name, cookieValue);
  }
  return result;
}

function isValidCredential(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function serializeCookie(request: Request, value: string): string {
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure = forwardedProtocol === "https" || new URL(request.url).protocol === "https:";
  return [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
