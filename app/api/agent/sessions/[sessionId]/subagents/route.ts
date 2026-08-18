import { authenticateHostRequest, HOST_AGENT_SCOPE, requireHostScope } from "@/server/http/host-request-auth";
import { createPostgresSessionOwnershipStoreFromEnvironment } from "@/server/data/session-ownership-store";
import { createPostgresAgentSubagentStoreFromEnvironment } from "@/server/data/agent-subagent-store";
import { createPostgresAgentRunStoreFromEnvironment } from "@/server/data/agent-run-store";
import { createPostgresAgentMailboxStoreFromEnvironment } from "@/server/data/agent-mailbox-store";
import { AgentSubagentError, listAgentSubagents, spawnAgentSubagent } from "@/server/agent-sessions/subagents";

export const runtime = "nodejs";
const ownershipStore = createPostgresSessionOwnershipStoreFromEnvironment();
const subagentStore = createPostgresAgentSubagentStoreFromEnvironment();
const runStore = createPostgresAgentRunStoreFromEnvironment();
const mailboxStore = createPostgresAgentMailboxStoreFromEnvironment();
type RouteContext = { readonly params: Promise<{ readonly sessionId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireHostScope(
    await authenticateHostRequest(request),
    HOST_AGENT_SCOPE.subagentRead,
  );
  if (!authenticated.ok) return authenticated.response;
  if (!ownershipStore || !subagentStore) return unavailable();
  const { sessionId } = await context.params;
  const result = await listAgentSubagents({
    accessToken: authenticated.accessToken,
    identity: authenticated.identity,
    ownershipStore,
    parentSessionId: sessionId,
    runStore: runStore ?? undefined,
    store: subagentStore,
  });
  return result ? Response.json({ ok: true, ...result }, { headers: noStore() }) : problem(404, "agent_session_not_found", "The parent Agent session was not found.");
}

/** Explicit spawning is available to hosts that provide an Eve spawn adapter. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireHostScope(
    await authenticateHostRequest(request),
    HOST_AGENT_SCOPE.subagentWrite,
  );
  if (!authenticated.ok) return authenticated.response;
  if (!ownershipStore || !subagentStore) return unavailable();
  const { sessionId } = await context.params;
  let body: unknown;
  try { body = await request.json(); } catch { return problem(400, "invalid_json", "The subagent request must be valid JSON."); }
  if (!isRecord(body) || body.action !== "spawn" || typeof body.task !== "string") return problem(400, "agent_subagent_request_invalid", "action=spawn and a task are required.");
  try {
    const record = await spawnAgentSubagent({
      accessToken: authenticated.accessToken,
      identity: authenticated.identity,
      mailboxStore: mailboxStore ?? undefined,
      name: typeof body.name === "string" ? body.name : undefined,
      nickname: typeof body.nickname === "string" ? body.nickname : undefined,
      ownershipStore,
      parentSessionId: sessionId,
      runStore: runStore ?? undefined,
      store: subagentStore,
      task: body.task,
      waitPolicy: body.waitPolicy === "no-wait" ? "no-wait" : "wait",
    });
    return Response.json({ ok: true, subagent: record }, { headers: noStore(), status: 202 });
  } catch (error) {
    return error instanceof AgentSubagentError ? problem(error.status, error.code, error.message) : problem(502, "agent_subagent_spawn_failed", "The subagent could not be started.");
  }
}

function unavailable(): Response { return problem(503, "agent_subagent_store_unavailable", "The Agent database is not configured for subagent control."); }
function noStore(): HeadersInit { return { "cache-control": "no-store" }; }
function problem(status: number, code: string, error: string): Response { return Response.json({ code, error, ok: false }, { headers: noStore(), status }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
