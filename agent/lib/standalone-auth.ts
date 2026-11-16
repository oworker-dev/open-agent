import type { AuthFn } from "eve/channels/auth";
import { resolveStandaloneRequestIdentity, standaloneSessionAuth } from "../../server/http/standalone-request-auth.ts";

/**
 * Authenticates the standalone Web app's opaque browser credential. Host
 * integrations remain responsible for their own JWT/OIDC identity adapters.
 */
export function standaloneCookieAuth(): AuthFn<Request> {
  return (request) => {
    const identity = resolveStandaloneRequestIdentity(request);
    if (!identity) return null;
    return standaloneSessionAuth(identity);
  };
}
