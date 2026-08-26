import { createPostgresAgentRunStoreFromEnvironment } from "@/server/data/agent-run-store";
import { isAgentRuntimeConfigured } from "@/server/agent-runs/eve-adapter";
import { parseStartAgentRun } from "@/server/agent-runs/input";
import {
  agentRunHeaders,
  agentRunResponse,
  databaseUnavailable,
  problem,
  runtimeUnavailable,
} from "@/server/agent-runs/http-response";
import {
  AgentRunOperationError,
  startAgentRun,
  toAgentRunSnapshot,
} from "@/server/agent-runs/service";
import { authenticateHostRequest, requireHostScope } from "@/server/http/host-request-auth";
import { createPostgresAgentExtensionStoreFromEnvironment } from "@/server/data/agent-extension-store";
import { AgentExtensionAccessError } from "@/lib/agent-extension-lifecycle";
import { agentExtensionCatalogForConfig } from "@/lib/agent-extension-catalog";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 256 * 1024;
const store = createPostgresAgentRunStoreFromEnvironment();
const extensionStore = createPostgresAgentExtensionStoreFromEnvironment();

export async function POST(request: Request): Promise<Response> {
  const authenticated = requireHostScope(
    await authenticateHostRequest(request),
    "agent:runs",
  );
  if (!authenticated.ok) return authenticated.response;
  if (!store) return databaseUnavailable();
  if (!isAgentRuntimeConfigured()) return runtimeUnavailable();

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return problem(413, "agent_run_too_large", "The AgentRun request exceeds 256 KiB.");
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return problem(400, "invalid_json", "The request body must be valid JSON.");
  }
  const parsed = parseStartAgentRun(input, authenticated.runtimeConfig);
  if (!parsed.ok) return problem(400, "invalid_agent_run", parsed.error);
  if (!extensionStore) return databaseUnavailable();

  try {
    await extensionStore.assertPolicyAllowed(
      authenticated.identity.tenantId,
      parsed.value.policy ?? {},
      agentExtensionCatalogForConfig(authenticated.runtimeConfig),
    );
  } catch (error) {
    if (error instanceof AgentExtensionAccessError) {
      return problem(403, error.code, error.message);
    }
    return problem(503, "agent_extension_policy_unavailable", "The extension policy could not be verified.");
  }

  try {
    const outcome = await startAgentRun({
      accessToken: authenticated.accessToken,
      identity: authenticated.identity,
      request: parsed.value,
      store,
    });
    if (outcome.disposition === "rejected" || outcome.disposition === "ambiguous") {
      const status = outcome.disposition === "rejected" ? 502 : 503;
      return problem(
        status,
        outcome.record.failure?.code ?? "agent_run_submission_failed",
        outcome.record.failure?.message ?? "The AgentRun could not be submitted.",
        { run: toAgentRunSnapshot(outcome.record) },
        agentRunHeaders(outcome.record),
      );
    }
    return agentRunResponse(
      outcome.record,
      { disposition: outcome.disposition, ok: true },
      outcome.disposition === "started" ? 202 : 200,
    );
  } catch (error) {
    if (error instanceof AgentRunOperationError) {
      return problem(
        error.status,
        error.code,
        error.message,
        {},
        error.code === "agent_run_capacity" ? { "retry-after": "2" } : {},
      );
    }
    return problem(500, "agent_run_start_failed", "The AgentRun could not be started.");
  }
}
