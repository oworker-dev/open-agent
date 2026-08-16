import { enqueueAgentMailboxHttpRequest } from "@/server/agent-mailbox/http";
import { createPostgresAgentMailboxStoreFromEnvironment } from "@/server/data/agent-mailbox-store";
import {
  cancelAgentSession,
  deleteAgentSession,
  AgentSessionDeletionError,
  readAgentSession,
} from "@/server/agent-sessions/service";
import { createPostgresSessionOwnershipStoreFromEnvironment } from "@/server/data/session-ownership-store";
import { createPostgresSandboxDeletionStoreFromEnvironment } from "@/server/data/sandbox-deletion-store";
import { authenticateHostRequest, HOST_AGENT_SCOPE, requireHostScope } from "@/server/http/host-request-auth";
import { createPostgresAgentSubagentStoreFromEnvironment } from "@/server/data/agent-subagent-store";
import { syncAgentSubagentsFromEvents } from "@/server/agent-sessions/subagents";
import {
  createPostgresAgentSessionApprovalStoreFromEnvironment,
  syncAgentSessionApprovalsFromEvents,
} from "@/server/agent-sessions/approval";

export const runtime = "nodejs";

const ownershipStore = createPostgresSessionOwnershipStoreFromEnvironment();
const mailboxStore = createPostgresAgentMailboxStoreFromEnvironment();
const deletionStore = createPostgresSandboxDeletionStoreFromEnvironment();
const subagentStore = createPostgresAgentSubagentStoreFromEnvironment();
const approvalStore = createPostgresAgentSessionApprovalStoreFromEnvironment();
type RouteContext = { readonly params: Promise<{ readonly sessionId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireHostScope(
    await authenticateHostRequest(request),
    HOST_AGENT_SCOPE.sessionRead,
  );
  if (!authenticated.ok) return authenticated.response;
  if (!ownershipStore) return databaseUnavailable();
  const { sessionId } = await context.params;
  const url = new URL(request.url);
  const after = parseUnsigned(url.searchParams.get("after"), 0);
  const limit = parseUnsigned(url.searchParams.get("limit"), 200);
  if (after === undefined || limit === undefined || limit < 1 || limit > 1_000) {
    return problem(400, "agent_session_cursor_invalid", "after must be non-negative and limit must be between 1 and 1000.");
  }
  try {
    const result = await readAgentSession({
      accessToken: authenticated.accessToken,
      after,
      identity: authenticated.identity,
      limit,
      ownershipStore,
      sessionId,
    });
    if (!result) return problem(404, "agent_session_not_found", "The Agent session was not found for this principal.");
    const subagents = subagentStore
      ? await syncAgentSubagentsFromEvents({
          accessToken: authenticated.accessToken,
          events: result.events,
          identity: authenticated.identity,
          ownershipStore,
          parentSessionId: sessionId,
          store: subagentStore,
        })
      : undefined;
    const pendingApprovals = approvalStore
      ? await syncAgentSessionApprovalsFromEvents({
          events: result.events,
          sessionId,
          store: approvalStore,
        })
      : undefined;
    return Response.json(
      {
        events: result.events,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        ok: true,
        session: result.session,
        ...(subagents ? { subagents } : {}),
        ...(pendingApprovals ? { pendingApprovals } : {}),
      },
      {
        headers: {
          "cache-control": "no-store",
          etag: `"${result.nextCursor}"`,
        },
      },
    );
  } catch (error) {
    return error instanceof AgentSessionDeletionError
      ? problem(error.status, error.code, error.message)
      : problem(502, "agent_session_history_failed", "The Agent session history could not be read.");
  }
}

/**
 * Session control endpoint. `steer` is persisted in the same FIFO mailbox as
 * other follow-ups; `cancel` crosses the Eve boundary without cancelling an
 * unrelated queued message.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireHostScope(
    await authenticateHostRequest(request),
    HOST_AGENT_SCOPE.sessionWrite,
  );
  if (!authenticated.ok) return authenticated.response;
  const { sessionId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(400, "invalid_json", "The session operation request must be valid JSON.");
  }
  if (!isRecord(body) || body.sessionId !== undefined && body.sessionId !== sessionId) {
    return problem(400, "agent_session_operation_invalid", "The session operation is invalid.");
  }
  if (body.action === "cancel") {
    if (!ownershipStore) return databaseUnavailable();
    try {
      const result = await cancelAgentSession({
        accessToken: authenticated.accessToken,
        identity: authenticated.identity,
        ownershipStore,
        sessionId,
      });
      return result
        ? Response.json(
            { ...result, ok: true },
            {
              headers: { "cache-control": "no-store" },
              status: result.status === "accepted" ? 202 : 200,
            },
          )
        : problem(404, "agent_session_not_found", "The Agent session was not found for this principal.");
    } catch (error) {
      return error instanceof AgentSessionDeletionError
        ? problem(error.status, error.code, error.message)
        : problem(502, "agent_session_cancellation_failed", "The Agent session could not be cancelled.");
    }
  }
  if (body.action !== "steer" && body.action !== "send") {
    return problem(400, "agent_session_operation_invalid", "action must be steer, send, or cancel.");
  }
  if (!mailboxStore) return databaseUnavailable();
  // Reuse the mailbox parser and its runtime-config validation. The action is
  // intentionally ignored by that parser and operation metadata is retained
  // in the payload fingerprint for idempotent replay.
  const forwarded = new Request(request.url, {
    body: JSON.stringify({ ...body, sessionId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return await enqueueAgentMailboxHttpRequest({
    owner: authenticated.identity,
    ...(ownershipStore ? { ownershipStore } : {}),
    request: forwarded,
    runtimeConfig: authenticated.runtimeConfig,
    store: mailboxStore,
  });
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireHostScope(
    await authenticateHostRequest(request),
    HOST_AGENT_SCOPE.sessionDelete,
  );
  if (!authenticated.ok) return authenticated.response;
  if (!ownershipStore || !deletionStore) return databaseUnavailable();
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 8 * 1024) {
    return problem(413, "request_too_large", "The session deletion request is too large.");
  }

  const { sessionId } = await context.params;
  try {
    const outcome = await deleteAgentSession({
      accessToken: authenticated.accessToken,
      deletionStore,
      identity: authenticated.identity,
      ownershipStore,
      sessionId,
    });
    return outcome
      ? Response.json({ deletion: outcome.deletion, disposition: outcome.disposition, ok: true, reset: outcome.reset }, {
          headers: { "cache-control": "no-store" },
          status: 202,
        })
      : problem(404, "agent_session_not_found", "The Agent session was not found for this principal.");
  } catch (error) {
    return error instanceof AgentSessionDeletionError
      ? problem(error.status, error.code, error.message)
      : problem(502, "agent_session_deletion_failed", "The Agent session could not be deleted.");
  }
}

function databaseUnavailable(): Response {
  return problem(503, "agent_database_unavailable", "AGENT_DATABASE_URL is not configured for this deployment.");
}

function parseUnsigned(value: string | null, fallback: number): number | undefined {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function problem(status: number, code: string, message: string): Response {
  return Response.json(
    { code, error: message, ok: false },
    { headers: { "cache-control": "no-store" }, status },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
