import { authenticateHostRequest, HOST_AGENT_SCOPE, requireHostScope } from "@/server/http/host-request-auth";
import { createPostgresSessionOwnershipStoreFromEnvironment } from "@/server/data/session-ownership-store";
import { createPostgresAgentSubagentStoreFromEnvironment } from "@/server/data/agent-subagent-store";
import { createPostgresAgentMailboxStoreFromEnvironment } from "@/server/data/agent-mailbox-store";
import {
  AgentSubagentError,
  closeAgentSubagent,
  inspectAgentSubagent,
  interruptAgentSubagent,
  sendAgentSubagentMessage,
  waitForAgentSubagent,
} from "@/server/agent-sessions/subagents";

export const runtime = "nodejs";
const ownershipStore = createPostgresSessionOwnershipStoreFromEnvironment();
const subagentStore = createPostgresAgentSubagentStoreFromEnvironment();
const mailboxStore = createPostgresAgentMailboxStoreFromEnvironment();
type RouteContext = { readonly params: Promise<{ readonly childSessionId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireHostScope(
    await authenticateHostRequest(request),
    HOST_AGENT_SCOPE.subagentRead,
  );
  if (!authenticated.ok) return authenticated.response;
  if (!subagentStore) return unavailable();
  const { childSessionId } = await context.params;
  const record = ownershipStore
    ? await inspectAgentSubagent({
        accessToken: authenticated.accessToken,
        identity: authenticated.identity,
        ownershipStore,
        runtime: undefined,
        store: subagentStore,
        childSessionId,
      })
    : await subagentStore.findOwned(authenticated.identity, childSessionId);
  return record ? Response.json({ ok: true, subagent: record }, { headers: noStore() }) : problem(404, "agent_subagent_not_found", "The subagent is not available.");
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireHostScope(
    await authenticateHostRequest(request),
    HOST_AGENT_SCOPE.subagentWrite,
  );
  if (!authenticated.ok) return authenticated.response;
  if (!ownershipStore || !subagentStore) return unavailable();
  const { childSessionId } = await context.params;
  let body: unknown;
  try { body = await request.json(); } catch { return problem(400, "invalid_json", "The subagent request must be valid JSON."); }
  if (!isRecord(body) || typeof body.action !== "string") return problem(400, "agent_subagent_request_invalid", "A subagent action is required.");
  const common = { accessToken: authenticated.accessToken, identity: authenticated.identity, ownershipStore, store: subagentStore, childSessionId } as const;
  try {
    if (body.action === "send" || body.action === "resume") {
      if (typeof body.message !== "string") return problem(400, "agent_subagent_message_invalid", "A message is required.");
      const record = await sendAgentSubagentMessage({ ...common, mailboxStore: mailboxStore ?? undefined, message: body.message, operationId: typeof body.operationId === "string" ? body.operationId : undefined, resume: body.action === "resume" });
      return record ? Response.json({ ok: true, subagent: record }, { headers: noStore(), status: 202 }) : problem(404, "agent_subagent_not_found", "The subagent is not available.");
    }
    if (body.action === "wait") {
      const record = await waitForAgentSubagent({ ...common, timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined });
      return record ? Response.json({ ok: true, subagent: record }, { headers: noStore() }) : problem(404, "agent_subagent_not_found", "The subagent is not available.");
    }
    if (body.action === "interrupt") {
      const record = await interruptAgentSubagent(common);
      return record ? Response.json({ ok: true, subagent: record }, { headers: noStore(), status: 202 }) : problem(404, "agent_subagent_not_found", "The subagent is not available.");
    }
    if (body.action === "close") {
      const record = await closeAgentSubagent(common);
      return record ? Response.json({ ok: true, subagent: record }, { headers: noStore(), status: 202 }) : problem(404, "agent_subagent_not_found", "The subagent is not available.");
    }
    return problem(400, "agent_subagent_action_invalid", "action must be send, resume, wait, interrupt, or close.");
  } catch (error) {
    return error instanceof AgentSubagentError ? problem(error.status, error.code, error.message) : problem(502, "agent_subagent_action_failed", "The subagent action failed.");
  }
}

function unavailable(): Response { return problem(503, "agent_subagent_store_unavailable", "The Agent database is not configured for subagent control."); }
function noStore(): HeadersInit { return { "cache-control": "no-store" }; }
function problem(status: number, code: string, error: string): Response { return Response.json({ code, error, ok: false }, { headers: noStore(), status }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
