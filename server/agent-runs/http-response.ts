import type { AgentRunRecord } from "../data/agent-run-store";
import { toAgentRunSnapshot } from "./service.ts";

export function agentRunResponse(
  record: AgentRunRecord,
  body: Readonly<Record<string, unknown>>,
  status = 200,
): Response {
  return Response.json(
    { ...body, run: toAgentRunSnapshot(record) },
    { status, headers: agentRunHeaders(record) },
  );
}

export function agentRunHeaders(record: AgentRunRecord): HeadersInit {
  return {
    "cache-control": "no-store",
    etag: `"${record.revision}"`,
    location: `/api/agent/runs/${encodeURIComponent(record.runId)}`,
  };
}

export function problem(
  status: number,
  code: string,
  message: string,
  extra: Readonly<Record<string, unknown>> = {},
  headers: HeadersInit = {},
): Response {
  return Response.json(
    { code, error: message, ok: false, ...extra },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

export function databaseUnavailable(): Response {
  return problem(
    503,
    "agent_database_unavailable",
    "AGENT_DATABASE_URL is not configured for this deployment.",
  );
}

export function runtimeUnavailable(): Response {
  return problem(
    503,
    "agent_runtime_unavailable",
    "AGENT_RUNTIME_URL is not configured for this deployment.",
  );
}

export function isAgentRunId(value: string): boolean {
  return /^arun_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
