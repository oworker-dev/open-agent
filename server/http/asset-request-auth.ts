import { authenticateHostRequest, type HostRequestAuthentication } from "./host-request-auth";
import { authenticateStandaloneRequest } from "./standalone-request-auth";

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
 * bearer request always goes through host JWT auth; a standalone deployment
 * uses its opaque browser credential and never accepts host claims from a
 * cookie. The presence of a configured host secret keeps a production host
 * fail-closed even when a caller forgets its bearer token.
 */
export async function authenticateAssetRequest(request: Request): Promise<AssetRequestAuthentication> {
  if (request.headers.get("authorization") || process.env.AGENT_HOST_JWT_SECRET?.trim()) {
    return authenticateHostRequest(request);
  }
  const authenticated = authenticateStandaloneRequest(request);
  return { identity: authenticated.identity, ok: true, ...(authenticated.setCookie ? { setCookie: authenticated.setCookie } : {}) };
}

export function authResponseHeaders(authenticated: AssetRequestAuthentication): HeadersInit {
  return authenticated.ok && "setCookie" in authenticated && authenticated.setCookie
    ? { "set-cookie": authenticated.setCookie }
    : {};
}
