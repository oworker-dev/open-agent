import { eveChannel } from "eve/channels/eve";
import { POST, type Session } from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import {
  type AuthFn,
  localDev,
  vercelOidc,
} from "eve/channels/auth";
import {
  findAgentRuntimeModel,
  isAgentProfileForConfig,
  isAgentReasoningLevelForModel,
  resolveAgentRuntimeConfig,
  serializeAgentRuntimeConfig,
} from "../../lib/agent-runtime-config";
import {
  agentExtensionCatalogForConfig,
  resolveAgentRunPolicy,
} from "../../lib/agent-extension-catalog";
import type { AgentRunPolicy } from "@oworker/open-agent-contracts/agent-run";
import { isBoundedAgentClientContext } from "@oworker/open-agent-contracts/client-context";
import { createPostgresSessionOwnershipStoreFromEnvironment } from "../../server/data/session-ownership-store";
import { createPostgresAgentExtensionStoreFromEnvironment } from "../../server/data/agent-extension-store";
import { hostJwtAuthFromEnvironment } from "../lib/host-auth";
import { standaloneCookieAuth } from "../lib/standalone-auth";
import { withSessionOwnership } from "../lib/session-ownership-auth";
import { parseAgentRunPolicy } from "../lib/run-policy";
import { parseRemoteTraceParent } from "../lib/observability";
import { verifyMailboxDispatchRequest } from "../lib/mailbox-dispatch-auth.ts";

const MODEL_HEADER = "x-agent-model";
const REASONING_HEADER = "x-agent-reasoning";
const EXECUTION_MODE_HEADER = "x-agent-execution-mode";
const PROFILE_ID_HEADER = "x-agent-profile-id";
const PROFILE_VERSION_HEADER = "x-agent-profile-version";
const RUN_POLICY_HEADER = "x-agent-run-policy";
const RUN_ID_HEADER = "x-agent-run-id";
const CORRELATION_ID_HEADER = "x-agent-correlation-id";
const TRACE_PARENT_HEADER = "traceparent";
const MAILBOX_ROUTE = "/eve/v1/internal/mailbox";
const MAX_MAILBOX_REQUEST_BYTES = 128 * 1024;
const sessionOwnershipStore = createPostgresSessionOwnershipStoreFromEnvironment();
const extensionStore = createPostgresAgentExtensionStoreFromEnvironment();

if (process.env.AGENT_HOST_JWT_SECRET?.trim() && !sessionOwnershipStore) {
  throw new Error("AGENT_DATABASE_URL is required when Host JWT authentication is enabled.");
}

function withAgentPreferences(authenticate: AuthFn<Request>): AuthFn<Request> {
  return async (request) => {
    const auth = await authenticate(request);
    if (auth == null) return null;

    const requestedModel = request.headers.get(MODEL_HEADER) ?? undefined;
    const requestedReasoning = request.headers.get(REASONING_HEADER) ?? undefined;
    const requestedExecutionMode = request.headers.get(EXECUTION_MODE_HEADER) ?? undefined;
    const attributes = { ...auth.attributes };
    const runtimeConfig = resolveAgentRuntimeConfig(attributes);
    const selectedModel = findAgentRuntimeModel(runtimeConfig, requestedModel) ??
      findAgentRuntimeModel(runtimeConfig, runtimeConfig.defaultModelId)!;

    if (requestedModel !== undefined && !findAgentRuntimeModel(runtimeConfig, requestedModel)) {
      throw new Error("The requested Agent model is not published by the active runtime config.");
    }
    attributes.agentModelId = selectedModel.id;
    if (requestedReasoning !== undefined && !isAgentReasoningLevelForModel(selectedModel, requestedReasoning)) {
      throw new Error("The requested reasoning level is not supported by the selected Agent model.");
    }
    if (isAgentReasoningLevelForModel(selectedModel, requestedReasoning)) {
      attributes.agentReasoning = requestedReasoning;
    } else {
      attributes.agentReasoning = selectedModel.defaultReasoning;
    }
    const profile = {
      profileId: request.headers.get(PROFILE_ID_HEADER)?.trim() || runtimeConfig.profile.id,
      version: request.headers.get(PROFILE_VERSION_HEADER)?.trim() || runtimeConfig.profile.version,
    };
    if (!isAgentProfileForConfig(runtimeConfig, profile)) {
      throw new Error("The Agent profile is invalid or unpublished by the active runtime config.");
    }
    attributes.agentProfileId = profile.profileId;
    attributes.agentProfileVersion = profile.version;
    attributes.agentRuntimeConfig = serializeAgentRuntimeConfig(runtimeConfig);
    const runPolicy = resolveAgentRunPolicy(
      profile,
      {
        ...parseRunPolicyHeader(request.headers.get(RUN_POLICY_HEADER)),
        ...(requestedExecutionMode ? { executionMode: parseExecutionModeHeader(requestedExecutionMode) } : {}),
      },
      undefined,
      runtimeConfig,
    );
    const tenantId = attributes.tenantId;
    if (extensionStore && typeof tenantId === "string" && tenantId.trim()) {
      await extensionStore.assertPolicyAllowed(
        tenantId,
        runPolicy,
        agentExtensionCatalogForConfig(runtimeConfig),
      );
    }
    attributes.agentRunPolicy = JSON.stringify(runPolicy);
    const agentRunId = request.headers.get(RUN_ID_HEADER)?.trim();
    if (agentRunId !== undefined && agentRunId !== "") {
      if (!/^arun_[a-zA-Z0-9-]{8,200}$/.test(agentRunId)) {
        throw new Error("The AgentRun id header is invalid.");
      }
      attributes.agentRunId = agentRunId;
    }
    const correlationId = request.headers.get(CORRELATION_ID_HEADER)?.trim();
    if (correlationId !== undefined && correlationId !== "") {
      if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(correlationId)) {
        throw new Error("The Agent correlation id header is invalid.");
      }
      attributes.agentCorrelationId = correlationId;
    }
    const traceParent = request.headers.get(TRACE_PARENT_HEADER)?.trim();
    if (traceParent && parseRemoteTraceParent(traceParent)) {
      attributes.agentUpstreamTraceParent = traceParent.toLowerCase();
    }

    return { ...auth, attributes };
  };
}

function parseExecutionModeHeader(value: string): AgentRunPolicy["executionMode"] {
  if (value === "automation" || value === "cautious" || value === "standard") return value;
  throw new Error("The Agent execution mode is invalid.");
}

function parseRunPolicyHeader(value: string | null): AgentRunPolicy {
  if (!value) return {};
  if (value.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("The AgentRun policy header is invalid.");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parseAgentRunPolicy(parsed);
  } catch {
    throw new Error("The AgentRun policy header is invalid.");
  }
}

const channel = eveChannel({
  auth: [
    // Host-signed tenant identity is the primary production browser path.
    sessionOwnershipStore
      ? withSessionOwnership(
          withAgentPreferences(hostJwtAuthFromEnvironment()),
          sessionOwnershipStore,
        )
      : withAgentPreferences(hostJwtAuthFromEnvironment()),
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    withAgentPreferences(vercelOidc()),
    // Standalone Web sessions use an opaque browser credential issued by the
    // standalone thread API. This path is host-neutral and has no Muses logic.
    sessionOwnershipStore
      ? withSessionOwnership(
          withAgentPreferences(standaloneCookieAuth()),
          sessionOwnershipStore,
        )
      : withAgentPreferences(standaloneCookieAuth()),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    withAgentPreferences(localDev()),
  ],
});

const mailboxRoute = POST(MAILBOX_ROUTE, async (request, {
  attachSession,
}) => {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_MAILBOX_REQUEST_BYTES) {
    return mailboxProblem(413, "mailbox_request_too_large", "The mailbox request exceeds 128 KiB.");
  }
  let body: string;
  try {
    body = await request.text();
  } catch {
    return mailboxProblem(400, "mailbox_request_unreadable", "The mailbox request could not be read.");
  }
  if (Buffer.byteLength(body) > MAX_MAILBOX_REQUEST_BYTES) {
    return mailboxProblem(413, "mailbox_request_too_large", "The mailbox request exceeds 128 KiB.");
  }
  try {
    if (!verifyMailboxDispatchRequest(request, body)) {
      return mailboxProblem(401, "mailbox_auth_invalid", "The mailbox dispatcher signature is invalid.");
    }
  } catch {
    return mailboxProblem(503, "mailbox_auth_unconfigured", "The mailbox dispatcher is not configured.");
  }

  const input = parseMailboxRequest(body);
  if (!input) {
    return mailboxProblem(400, "mailbox_request_invalid", "The mailbox request is invalid.");
  }
  let boundary: MailboxBoundary;
  try {
    boundary = await inspectMailboxBoundary(attachSession(input.sessionId));
  } catch {
    return mailboxProblem(404, "mailbox_session_not_found", "The Agent session was not found.");
  }
  if (input.action === "inspect") {
    return Response.json({ ...boundary, ok: true }, { headers: { "cache-control": "no-store" } });
  }
  if (boundary.state === "terminal" || boundary.state === "running") {
    return mailboxProblem(
      boundary.state === "terminal" ? 410 : 409,
      boundary.state === "terminal" ? "mailbox_session_terminal" : "mailbox_turn_active",
      boundary.state === "terminal"
        ? "The Agent session is terminal."
        : "The Agent session is still running. The queued message remains cancellable until it parks.",
    );
  }
  try {
    const accepted = await attachSession(input.sessionId).send(
      input.message,
      {
        auth: mailboxSessionAuth(input),
        ...(input.clientContext ? { clientContext: input.clientContext } : {}),
      },
    );
    if (accepted.status !== "accepted" || accepted.sessionId !== input.sessionId) {
      return mailboxProblem(
        409,
        "mailbox_session_identity_changed",
        "The runtime admitted the message to an unexpected Agent session.",
      );
    }
    return Response.json(
      { ok: true, sessionId: input.sessionId },
      { headers: { "cache-control": "no-store" }, status: 202 },
    );
  } catch {
    return mailboxProblem(
      502,
      "mailbox_admission_unknown",
      "The runtime could not confirm mailbox admission.",
    );
  }
});

// Keep the canonical Eve channel identity so this internal route resumes the
// same continuation namespace instead of creating a second transport session.
export default {
  ...channel,
  routes: [...channel.routes, mailboxRoute],
};

type MailboxBoundary =
  | { readonly state: "running"; readonly turnId?: string }
  | { readonly state: "waiting" }
  | { readonly state: "terminal" };

type MailboxInspectRequest = {
  readonly action: "inspect";
  readonly sessionId: string;
};

type MailboxDeliverRequest = {
  readonly action: "deliver";
  readonly clientMessageId: string;
  readonly clientContext?: readonly string[];
  readonly executionMode?: AgentRunPolicy["executionMode"];
  readonly issuer?: string;
  readonly itemId: string;
  readonly message: string;
  readonly modelId?: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly reasoning?: string;
  readonly sessionId: string;
  readonly tenantId: string;
};

function parseMailboxRequest(body: string): MailboxInspectRequest | MailboxDeliverRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !validText(value.sessionId, 512)) return undefined;
  if (value.action === "inspect") return { action: "inspect", sessionId: value.sessionId };
  if (
    value.action !== "deliver" ||
    !validText(value.clientMessageId, 200) ||
    !validText(value.itemId, 512) ||
    !validText(value.message, 65_536) ||
    !validText(value.principalId, 512) ||
    !validText(value.principalType, 512) ||
    !validText(value.tenantId, 512) ||
    value.issuer !== undefined && !validText(value.issuer, 512) ||
    value.modelId !== undefined && !validText(value.modelId, 200) ||
    value.reasoning !== undefined && !validText(value.reasoning, 100) ||
    value.executionMode !== undefined &&
      value.executionMode !== "automation" &&
      value.executionMode !== "cautious" &&
      value.executionMode !== "standard" ||
    value.clientContext !== undefined && !validClientContext(value.clientContext)
  ) return undefined;
  return {
    action: "deliver",
    clientMessageId: value.clientMessageId,
    ...(value.clientContext ? { clientContext: value.clientContext } : {}),
    ...(value.executionMode ? { executionMode: value.executionMode } : {}),
    ...(value.issuer ? { issuer: value.issuer } : {}),
    itemId: value.itemId,
    message: value.message,
    ...(value.modelId ? { modelId: value.modelId } : {}),
    principalId: value.principalId,
    principalType: value.principalType,
    ...(value.reasoning ? { reasoning: value.reasoning } : {}),
    sessionId: value.sessionId,
    tenantId: value.tenantId,
  };
}

function validClientContext(value: unknown): value is readonly string[] {
  return isBoundedAgentClientContext(value);
}

async function inspectMailboxBoundary(
  session: Session,
): Promise<MailboxBoundary> {
  const stream = await session.getEventStream({ startIndex: -1 });
  const reader = stream.getReader();
  try {
    const latest = await reader.read();
    if (latest.done || !latest.value) return { state: "running" };
    if (latest.value.type === "session.waiting") {
      return { state: "waiting" };
    }
    if (latest.value.type === "session.completed" || latest.value.type === "session.failed") {
      return { state: "terminal" };
    }
    const turnId = "turnId" in latest.value.data &&
        validText(latest.value.data.turnId, 512)
      ? latest.value.data.turnId
      : undefined;
    return { state: "running", ...(turnId ? { turnId } : {}) };
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function mailboxSessionAuth(input: MailboxDeliverRequest): SessionAuthContext {
  const config = resolveAgentRuntimeConfig({});
  const model = input.modelId
    ? findAgentRuntimeModel(config, input.modelId)
    : undefined;
  if (input.modelId && !model) {
    throw new Error("The mailbox model is not published by this runtime.");
  }
  if (model && input.reasoning && !isAgentReasoningLevelForModel(model, input.reasoning)) {
    throw new Error("The mailbox reasoning level is not supported by this model.");
  }
  return {
    attributes: {
      actorType: input.principalType === "service" ? "service" : "user",
      tenantId: input.tenantId,
      agentMailboxItemId: input.itemId,
      ...(model ? { agentModelId: model.id } : {}),
      ...(input.reasoning ? { agentReasoning: input.reasoning } : {}),
      ...(input.executionMode
        ? { agentRunPolicy: JSON.stringify({ executionMode: input.executionMode }) }
        : {}),
    },
    authenticator: "agent-mailbox-dispatch",
    ...(input.issuer ? { issuer: input.issuer } : {}),
    principalId: input.principalId,
    principalType: input.principalType,
  };
}

function mailboxProblem(status: number, code: string, error: string): Response {
  return Response.json(
    { code, error, ok: false },
    { headers: { "cache-control": "no-store" }, status },
  );
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
