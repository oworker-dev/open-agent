import {
  AgentSubagentError,
  closeAgentSubagent,
  inspectAgentSubagent,
  interruptAgentSubagent,
  sendAgentSubagentMessage,
  waitForAgentSubagent,
} from "@/server/agent-sessions/subagents";
import { createPostgresAgentMailboxStoreFromEnvironment } from "@/server/data/agent-mailbox-store";
import { createPostgresAgentSubagentStoreFromEnvironment } from "@/server/data/agent-subagent-store";
import { createPostgresSessionOwnershipStoreFromEnvironment } from "@/server/data/session-ownership-store";
import { authenticateStandaloneRequest } from "@/server/http/standalone-request-auth";

export const runtime = "nodejs";

const ownershipStore = createPostgresSessionOwnershipStoreFromEnvironment();
const subagentStore = createPostgresAgentSubagentStoreFromEnvironment();
const mailboxStore = createPostgresAgentMailboxStoreFromEnvironment();

type RouteContext = {
  readonly params: Promise<{ readonly childSessionId: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = authenticateStandaloneRequest(request);
  if (!ownershipStore || !subagentStore) return unavailable(authenticated.setCookie);
  const { childSessionId } = await context.params;
  const record = await inspectAgentSubagent({
    accessToken: "",
    childSessionId,
    identity: authenticated.identity,
    ownershipStore,
    store: subagentStore,
  });
  return record
    ? Response.json({ ok: true, subagent: record }, { headers: responseHeaders(authenticated.setCookie) })
    : problem(404, "agent_subagent_not_found", "The subagent is not available.", authenticated.setCookie);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = authenticateStandaloneRequest(request);
  if (!ownershipStore || !subagentStore) return unavailable(authenticated.setCookie);
  const { childSessionId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(400, "invalid_json", "The subagent request must be valid JSON.", authenticated.setCookie);
  }
  if (!isRecord(body) || typeof body.action !== "string") {
    return problem(400, "agent_subagent_request_invalid", "A subagent action is required.", authenticated.setCookie);
  }
  const common = {
    accessToken: "",
    childSessionId,
    identity: authenticated.identity,
    ownershipStore,
    store: subagentStore,
  } as const;
  try {
    if (body.action === "send" || body.action === "resume") {
      if (typeof body.message !== "string") {
        return problem(400, "agent_subagent_message_invalid", "A message is required.", authenticated.setCookie);
      }
      const record = await sendAgentSubagentMessage({
        ...common,
        mailboxStore: mailboxStore ?? undefined,
        message: body.message,
        operationId: typeof body.operationId === "string" ? body.operationId : undefined,
        resume: body.action === "resume",
      });
      return subagentResponse(record, 202, authenticated.setCookie);
    }
    if (body.action === "wait") {
      const record = await waitForAgentSubagent({
        ...common,
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      });
      return subagentResponse(record, 200, authenticated.setCookie);
    }
    if (body.action === "interrupt") {
      return subagentResponse(
        await interruptAgentSubagent(common),
        202,
        authenticated.setCookie,
      );
    }
    if (body.action === "close") {
      return subagentResponse(
        await closeAgentSubagent(common),
        202,
        authenticated.setCookie,
      );
    }
    return problem(
      400,
      "agent_subagent_action_invalid",
      "action must be send, resume, wait, interrupt, or close.",
      authenticated.setCookie,
    );
  } catch (error) {
    return error instanceof AgentSubagentError
      ? problem(error.status, error.code, error.message, authenticated.setCookie)
      : problem(502, "agent_subagent_action_failed", "The subagent action failed.", authenticated.setCookie);
  }
}

function subagentResponse(
  record: Awaited<ReturnType<typeof inspectAgentSubagent>>,
  status: number,
  setCookie?: string,
): Response {
  return record
    ? Response.json({ ok: true, subagent: record }, { headers: responseHeaders(setCookie), status })
    : problem(404, "agent_subagent_not_found", "The subagent is not available.", setCookie);
}

function unavailable(setCookie?: string): Response {
  return problem(
    503,
    "agent_subagent_store_unavailable",
    "The Agent database is not configured for subagent control.",
    setCookie,
  );
}

function responseHeaders(setCookie?: string): HeadersInit {
  return {
    "cache-control": "no-store",
    ...(setCookie ? { "set-cookie": setCookie } : {}),
  };
}

function problem(status: number, code: string, error: string, setCookie?: string): Response {
  return Response.json(
    { code, error, ok: false },
    { headers: responseHeaders(setCookie), status },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
