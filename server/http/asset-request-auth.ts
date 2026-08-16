import { authenticateHostRequest, requireHostScope, type HostRequestAuthentication } from "./host-request-auth.ts";
import { authenticateStandaloneRequest } from "./standalone-request-auth.ts";

export type AssetRequestAuthentication =
  | HostRequestAuthentication
  | {
      readonly identity: import("../data/session-ownership-store").AgentSessionOwner;
      readonly ok: true;
      readonly setCookie?: string;
    }
  | { readonly ok: false; readonly response: Response };

/**
 * Assets are used by both the standalone Open Agent and embedded hosts. A
 * bearer request always goes through host JWT auth; a standalone browser uses
 * its opaque owner credential and never accepts host claims from a cookie.
 * Both surfaces may be enabled in one deployment, so environment configuration
 * cannot be used to infer which credential the caller intended to present.
 */
export async function authenticateAssetRequest(request: Request): Promise<AssetRequestAuthentication> {
  if (request.headers.get("authorization")) {
    return authenticateHostRequest(request);
  }
  const authenticated = authenticateStandaloneRequest(request);
  return { identity: authenticated.identity, ok: true, ...(authenticated.setCookie ? { setCookie: authenticated.setCookie } : {}) };
}

/**
 * Standalone browser credentials already represent the local owner. Embedded
 * hosts use bearer JWTs and must opt into the least-privilege asset scopes.
 */
export function requireAssetScope(
  authenticated: AssetRequestAuthentication,
  scope: "asset:read" | "asset:write",
): AssetRequestAuthentication {
  if (!authenticated.ok || !("scopes" in authenticated)) return authenticated;
  return requireHostScope(authenticated, scope);
}

export function authResponseHeaders(authenticated: AssetRequestAuthentication): HeadersInit {
  return authenticated.ok && "setCookie" in authenticated && authenticated.setCookie
    ? { "set-cookie": authenticated.setCookie }
    : {};
}
