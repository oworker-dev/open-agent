import {
  createUnauthorizedResponse,
  extractBearerToken,
  type ForbiddenError,
  type UnauthenticatedError,
} from "eve/channels/auth";
import { hostJwtAuthFromEnvironment } from "../../agent/lib/host-auth.ts";
import { sessionOwnerFromAuth } from "../../agent/lib/session-ownership-auth.ts";
import type { AgentSessionOwner } from "../data/session-ownership-store.ts";
import {
  resolveAgentRuntimeConfig,
  type AgentRuntimeConfigSnapshot,
} from "../../lib/agent-runtime-config.ts";

export type HostRequestAuthentication =
  | {
      readonly accessToken: string;
      readonly identity: AgentSessionOwner;
      readonly ok: true;
      readonly runtimeConfig: AgentRuntimeConfigSnapshot;
      readonly scopes: ReadonlySet<string>;
    }
  | { readonly ok: false; readonly response: Response };

export const HOST_AGENT_SCOPE = {
  approvalRead: "agent:approvals:read",
  mailboxRead: "agent:mailbox:read",
  mailboxWrite: "agent:mailbox:write",
  sessionDelete: "agent:sessions:delete",
  sessionRead: "agent:sessions:read",
  sessionWrite: "agent:sessions:write",
  subagentRead: "agent:subagents:read",
  subagentWrite: "agent:subagents:write",
} as const;

/** Apply a least-privilege endpoint scope after the shared Host JWT check. */
export function requireHostScope(
  authenticated: HostRequestAuthentication,
  scope: string,
): HostRequestAuthentication {
  if (!authenticated.ok || authenticated.scopes.has(scope)) return authenticated;
  return {
    ok: false,
    response: Response.json(
      {
        code: "host_scope_required",
        error: `The Host token requires the ${scope} scope.`,
        ok: false,
      },
      { headers: { "cache-control": "no-store" }, status: 403 },
    ),
  };
}

export async function authenticateHostRequest(
  request: Request,
): Promise<HostRequestAuthentication> {
  try {
    const accessToken = extractBearerToken(request.headers.get("authorization"));
    const auth = await hostJwtAuthFromEnvironment()(request);
    if (!auth || !accessToken) {
      return {
        ok: false,
        response: createUnauthorizedResponse({
          challenges: [{ scheme: "Bearer" }],
          code: "host_auth_required",
          message: "A valid Host access token is required.",
        }),
      };
    }
    let runtimeConfig: AgentRuntimeConfigSnapshot;
    try {
      runtimeConfig = resolveAgentRuntimeConfig(auth.attributes);
    } catch {
      return {
        ok: false,
        response: Response.json(
          {
            code: "host_runtime_config_invalid",
            error: "The Host token contains an invalid Agent Runtime Config snapshot.",
            ok: false,
          },
          { headers: { "cache-control": "no-store" }, status: 403 },
        ),
      };
    }
    return {
      accessToken,
      identity: sessionOwnerFromAuth(auth),
      ok: true,
      runtimeConfig,
      scopes: authScopes(auth.attributes.scope),
    };
  } catch (error) {
    if (hasAuthResponse(error)) return { ok: false, response: error.response };
    throw error;
  }
}

function authScopes(value: string | readonly string[] | undefined): ReadonlySet<string> {
  const scopes = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/u) : [];
  return new Set(scopes.map((scope) => scope.trim()).filter(Boolean));
}

function hasAuthResponse(
  error: unknown,
): error is ForbiddenError | UnauthenticatedError {
  return error instanceof Error && "response" in error && error.response instanceof Response;
}
