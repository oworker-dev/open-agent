import { eveChannel } from "eve/channels/eve";
import { POST } from "eve/channels";
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
import {
  inspectMailboxBoundary,
  MailboxBoundaryInspectionTimeoutError,
  type MailboxBoundary,
} from "../lib/mailbox-boundary.ts";
import type { MessageStreamEvent } from "eve/client";

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
  const session = attachSession(input.sessionId);
  if (input.action === "transcript") {
    try {
      const tailIndex = await session.getStreamTailIndex();
      return new Response(
        boundedTranscriptStream(await session.getEventStream({ startIndex: input.startIndex }), input.startIndex, tailIndex),
        {
          headers: {
            "cache-control": "no-store, no-transform",
            "content-type": "application/x-ndjson; charset=utf-8",
            "x-agent-stream-tail-index": String(tailIndex),
            "x-accel-buffering": "no",
          },
        },
      );
    } catch {
      return mailboxProblem(404, "mailbox_session_not_found", "The Agent session was not found.");
    }
  }
  if (input.action === "cancel") {
    const result = await session.cancel(
      input.turnId ? { turnId: input.turnId } : undefined,
    );
    return Response.json(
      { ...result, ok: true },
      {
        headers: { "cache-control": "no-store" },
        status: result.status === "accepted" ? 202 : 200,
      },
    );
  }
  if (input.action === "reset") {
    const result = await session.reset(
      input.reason ? { reason: input.reason } : undefined,
    );
    return Response.json(
      { ...result, ok: true },
      { headers: { "cache-control": "no-store" } },
    );
  }
  let boundary: MailboxBoundary;
  try {
    boundary = await inspectMailboxBoundary(session);
  } catch (error) {
    if (error instanceof MailboxBoundaryInspectionTimeoutError) {
      return mailboxProblem(
        503,
        "mailbox_inspection_timeout",
        "The Agent runtime did not expose a mailbox boundary in time. Retry this request.",
      );
    }
    return mailboxProblem(404, "mailbox_session_not_found", "The Agent session was not found.");
  }
  if (input.action === "inspect") {
    return Response.json({ ...boundary, ok: true }, { headers: { "cache-control": "no-store" } });
  }
  if (boundary.state === "terminal" ||
      boundary.state === "running" && !canSteerMailboxRequest(input, boundary)) {
    return mailboxProblem(
      boundary.state === "terminal" ? 410 : 409,
      boundary.state === "terminal" ? "mailbox_session_terminal" : "mailbox_turn_active",
      boundary.state === "terminal"
        ? "The Agent session is terminal."
        : "The Agent session is still running. The queued message remains cancellable until it parks.",
    );
  }
  try {
    const steer = boundary.state === "running" && input.operationKind === "steer"
      ? input.expectedTurnId
        ? { clientMessageId: input.clientMessageId, expectedTurnId: input.expectedTurnId }
        : undefined
      : undefined;
    const revert = input.operationKind === "edit" && input.beforeTurnId
      ? { beforeTurnId: input.beforeTurnId, clientMessageId: input.clientMessageId }
      : undefined;
    if (boundary.state === "running" && input.operationKind === "steer" && !steer) {
      return mailboxProblem(400, "mailbox_expected_turn_missing", "A steering message requires the active turn id.");
    }
    const turnOptions = {
      auth: mailboxSessionAuth(input),
      ...(input.clientContext ? { clientContext: input.clientContext } : {}),
      ...(revert ? { revert } : {}),
      ...(steer ? { steer } : {}),
    };
    const accepted = input.operationKind === "respond"
      ? await session.respond(input.inputResponses!, turnOptions)
      : await session.send(input.message!, turnOptions);
    if (accepted.status === "session_not_active") {
      return mailboxProblem(
        410,
        "mailbox_session_terminal",
        "The Agent session is no longer active.",
      );
    }
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

type MailboxInspectRequest = {
  readonly action: "inspect";
  readonly sessionId: string;
};

type MailboxTranscriptRequest = {
  readonly action: "transcript";
  readonly sessionId: string;
  readonly startIndex: number;
};

type MailboxControlRequest =
  | {
      readonly action: "cancel";
      readonly sessionId: string;
      readonly turnId?: string;
    }
  | {
      readonly action: "reset";
      readonly reason?: string;
      readonly sessionId: string;
    };

type MailboxDeliverRequest = {
  readonly action: "deliver";
  readonly beforeTurnId?: string;
  readonly clientMessageId: string;
  readonly clientContext?: readonly string[];
  readonly executionMode?: AgentRunPolicy["executionMode"];
  readonly expectedTurnId?: string;
  readonly issuer?: string;
  readonly itemId: string;
  readonly inputResponses?: readonly import("eve/client").InputResponse[];
  readonly message?: string;
  readonly modelId?: string;
  readonly operationId?: string;
  readonly operationKind?: "send" | "steer" | "edit" | "respond";
  readonly principalId: string;
  readonly principalType: string;
  readonly reasoning?: string;
  readonly sessionId: string;
  readonly tenantId: string;
};

function parseMailboxRequest(body: string): MailboxInspectRequest | MailboxTranscriptRequest | MailboxControlRequest | MailboxDeliverRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !validText(value.sessionId, 512)) return undefined;
  if (value.action === "inspect") return { action: "inspect", sessionId: value.sessionId };
  if (
    value.action === "transcript" &&
    typeof value.startIndex === "number" &&
    Number.isSafeInteger(value.startIndex) &&
    value.startIndex >= 0
  ) {
    return { action: "transcript", sessionId: value.sessionId, startIndex: value.startIndex };
  }
  if (value.action === "cancel") {
    if (value.turnId !== undefined && !validText(value.turnId, 512)) return undefined;
    return {
      action: "cancel",
      sessionId: value.sessionId,
      ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
    };
  }
  if (value.action === "reset") {
    if (value.reason !== undefined && !validText(value.reason, 2_000)) return undefined;
    return {
      action: "reset",
      sessionId: value.sessionId,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    };
  }
  if (
    value.action !== "deliver" ||
    !validText(value.clientMessageId, 200) ||
    !validText(value.itemId, 512) ||
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
    value.operationId !== undefined && !validText(value.operationId, 200) ||
    value.operationKind !== undefined &&
      value.operationKind !== "send" &&
      value.operationKind !== "steer" &&
      value.operationKind !== "edit" &&
      value.operationKind !== "respond" ||
    value.expectedTurnId !== undefined && !validText(value.expectedTurnId, 512) ||
    value.beforeTurnId !== undefined && !validText(value.beforeTurnId, 512) ||
    value.operationKind === "steer" &&
      (typeof value.operationId !== "string" || typeof value.expectedTurnId !== "string") ||
    value.operationKind === "edit" &&
      (typeof value.operationId !== "string" || typeof value.beforeTurnId !== "string") ||
    value.operationKind === "respond" &&
      (typeof value.operationId !== "string" || !validInputResponses(value.inputResponses) || value.message !== undefined) ||
    value.operationKind !== "respond" &&
      (!validText(value.message, 65_536) || value.inputResponses !== undefined) ||
    value.operationId !== undefined && typeof value.operationKind !== "string" ||
    value.clientContext !== undefined && !validClientContext(value.clientContext)
  ) return undefined;
  return {
    action: "deliver",
    ...(value.beforeTurnId ? { beforeTurnId: value.beforeTurnId } : {}),
    clientMessageId: value.clientMessageId,
    ...(value.clientContext ? { clientContext: value.clientContext } : {}),
    ...(value.executionMode ? { executionMode: value.executionMode } : {}),
    ...(value.expectedTurnId ? { expectedTurnId: value.expectedTurnId } : {}),
    ...(value.issuer ? { issuer: value.issuer } : {}),
    itemId: value.itemId,
    ...(validInputResponses(value.inputResponses) ? { inputResponses: value.inputResponses } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(value.modelId ? { modelId: value.modelId } : {}),
    ...(value.operationId ? { operationId: value.operationId } : {}),
    ...(value.operationKind ? { operationKind: value.operationKind } : {}),
    principalId: value.principalId,
    principalType: value.principalType,
    ...(value.reasoning ? { reasoning: value.reasoning } : {}),
    sessionId: value.sessionId,
    tenantId: value.tenantId,
  };
}

function validInputResponses(value: unknown): value is readonly import("eve/client").InputResponse[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return false;
  return value.every((response) => isRecord(response) &&
    validText(response.requestId, 512) &&
    (validText(response.optionId, 512) || validText(response.text, 65_536)) &&
    (response.optionId === undefined || validText(response.optionId, 512)) &&
    (response.text === undefined || validText(response.text, 65_536)));
}

function canSteerMailboxRequest(
  input: MailboxDeliverRequest,
  boundary: Extract<MailboxBoundary, { readonly state: "running" }>,
): boolean {
  return input.operationKind === "steer" &&
    typeof input.expectedTurnId === "string" &&
    input.expectedTurnId === boundary.turnId;
}

function validClientContext(value: unknown): value is readonly string[] {
  return isBoundedAgentClientContext(value);
}

/**
 * The normal Eve stream endpoint is intentionally reconnectable. Transcript
 * repair needs a different contract: snapshot the tail once, emit exactly the
 * events that existed at that boundary, then close. This prevents a completed
 * session from becoming an accidental infinite subscription.
 */
function boundedTranscriptStream(
  source: ReadableStream<MessageStreamEvent>,
  startIndex: number,
  tailIndex: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<MessageStreamEvent> | undefined;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        reader = source.getReader();
        let cursor = startIndex;
        try {
          while (!cancelled && cursor <= tailIndex) {
            const next = await reader.read();
            if (next.done) {
              throw new Error("The Agent transcript ended before its declared durable tail.");
            }
            controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
            cursor += 1;
          }
          if (!cancelled) controller.close();
        } catch (error) {
          if (!cancelled) controller.error(error);
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      })();
    },
    cancel() {
      cancelled = true;
      void reader?.cancel().catch(() => undefined);
    },
  });
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
