import { ConnectionAuthorizationFailedError, defineMcpClientConnection } from "eve/connections";
import type { SessionContext } from "eve/context";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_POLICY_BYTES = 16 * 1024;
const MAX_POLICY_CONNECTIONS = 256;
const MAX_SESSION_ID_BYTES = 512;
const MAX_SUBJECT_ATTRIBUTE_BYTES = 512;

export type ServiceTokenResolver = () => string | Promise<string>;

const secureHttpUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
  );
}, "must use HTTPS unless it targets a loopback development server");

const adapterRefSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u),
}).strict();

const adapterConfigSchema = z.object({
  adapter: adapterRefSchema,
  broker: z.object({
    getServiceToken: z.custom<ServiceTokenResolver>(
      (value) => typeof value === "function",
      "must be a runtime service-token resolver",
    ),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
    url: secureHttpUrl,
  }).strict(),
  connection: z.object({
    description: z.string().min(1).max(2_000),
    displayName: z.string().min(1).max(120),
    endpoint: secureHttpUrl,
    tools: z.object({
      allow: z.array(z.string().min(1).max(160)).min(1).max(256),
      requireApproval: z.array(z.string().min(1).max(160)).max(256).default([]),
    }).strict(),
  }).strict(),
}).strict().superRefine((config, context) => {
  const allowed = new Set(config.connection.tools.allow);
  if (allowed.size !== config.connection.tools.allow.length) {
    context.addIssue({
      code: "custom",
      message: "compiled allowlist entries must be unique",
      path: ["connection", "tools", "allow"],
    });
  }
  const approval = new Set(config.connection.tools.requireApproval);
  if (approval.size !== config.connection.tools.requireApproval.length) {
    context.addIssue({
      code: "custom",
      message: "approval entries must be unique",
      path: ["connection", "tools", "requireApproval"],
    });
  }
  const unknown = config.connection.tools.requireApproval.find((tool) => !allowed.has(tool));
  if (unknown) {
    context.addIssue({
      code: "custom",
      message: `approval tool ${unknown} is not present in the compiled allowlist`,
      path: ["connection", "tools", "requireApproval"],
    });
  }
});

export type McpAdapterConfig = z.input<typeof adapterConfigSchema>;

export type AdapterRef = {
  readonly id: string;
  readonly version: string;
};

export type CredentialBrokerSubject = {
  readonly actorType: string;
  readonly principalId: string;
  readonly tenantId: string;
};

export type CredentialBrokerRequest = {
  readonly adapter: AdapterRef;
  readonly contractVersion: "0.1.0";
  readonly sessionId: string;
  readonly subject: CredentialBrokerSubject;
};

export function createBrokeredMcpConnection(input: McpAdapterConfig) {
  const config = adapterConfigSchema.parse(input);
  return defineMcpClientConnection({
    approval: ({ toolName }) =>
      approvalForMcpTool(toolName, config.connection.tools.requireApproval),
    auth: (ctx) => {
      const request = authorizeMcpSession(ctx, config.adapter);
      return {
        displayName: config.connection.displayName,
        getToken: () => resolveBrokeredCredential({
          getServiceToken: config.broker.getServiceToken,
          request,
          timeoutMs: config.broker.timeoutMs,
          url: config.broker.url,
        }),
        principalType: "app" as const,
      };
    },
    description: config.connection.description,
    tools: { allow: config.connection.tools.allow },
    url: config.connection.endpoint,
  });
}

export function authorizeMcpSession(
  ctx: SessionContext,
  adapter: AdapterRef,
): CredentialBrokerRequest {
  const current = ctx.session.auth.current;
  const initiator = ctx.session.auth.initiator;
  const principal = current ?? initiator;
  if (!principal) throw new Error("An authenticated Agent session is required for MCP access.");

  const tenantId = textAttribute(principal.attributes.tenantId);
  const initiatorTenantId = textAttribute(initiator?.attributes.tenantId);
  if (!tenantId || initiatorTenantId && initiatorTenantId !== tenantId) {
    throw new Error("The MCP caller does not match the session tenant.");
  }

  const policy = parsePolicy(textAttribute(initiator?.attributes.agentRunPolicy));
  if (!policy.mcpConnections.some(
    (connection) => connection.id === adapter.id && connection.version === adapter.version,
  )) {
    throw new Error(`MCP adapter ${adapter.id}@${adapter.version} is not granted to this AgentRun.`);
  }

  return {
    adapter,
    contractVersion: "0.1.0",
    sessionId: boundedText(ctx.session.id, "MCP session id", MAX_SESSION_ID_BYTES),
    subject: {
      actorType: boundedText(
        textAttribute(principal.attributes.actorType) ?? principal.principalType,
        "MCP actor type",
        MAX_SUBJECT_ATTRIBUTE_BYTES,
      ),
      principalId: boundedText(
        principal.principalId,
        "MCP principal id",
        MAX_SUBJECT_ATTRIBUTE_BYTES,
      ),
      tenantId: boundedText(tenantId, "MCP tenant id", MAX_SUBJECT_ATTRIBUTE_BYTES),
    },
  };
}

export function approvalForMcpTool(
  qualifiedToolName: string,
  toolsRequiringApproval: readonly string[],
): "not-applicable" | "user-approval" {
  return toolsRequiringApproval.some((tool) => qualifiedToolName.endsWith(`__${tool}`))
    ? "user-approval"
    : "not-applicable";
}

export async function resolveBrokeredCredential(input: {
  readonly getServiceToken: ServiceTokenResolver;
  readonly request: CredentialBrokerRequest;
  readonly timeoutMs: number;
  readonly url: string;
}): Promise<{ readonly expiresAt?: number; readonly token: string }> {
  let response: Response;
  try {
    const serviceToken = await input.getServiceToken();
    if (typeof serviceToken !== "string" || serviceToken.length < 32) {
      throw new Error("invalid service token");
    }
    response = await fetch(input.url, {
      body: JSON.stringify(input.request),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json",
        "x-open-agent-credential-contract": input.request.contractVersion,
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch {
    throw unavailable(input.request.adapter.id, "credential_broker_unavailable", true);
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw unavailable(input.request.adapter.id, "credential_broker_invalid_response", false);
  }
  let body: string;
  try {
    body = await readBoundedBody(response, input.request.adapter.id);
  } catch (error) {
    if (error instanceof ConnectionAuthorizationFailedError) throw error;
    throw unavailable(input.request.adapter.id, "credential_broker_unavailable", true);
  }
  if (!response.ok) {
    throw unavailable(
      input.request.adapter.id,
      response.status === 401 || response.status === 403
        ? "credential_revoked_or_forbidden"
        : "credential_broker_unavailable",
      response.status >= 500,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw unavailable(input.request.adapter.id, "credential_broker_invalid_response", false);
  }
  if (!isRecord(parsed) || typeof parsed.token !== "string" || parsed.token.length < 1) {
    throw unavailable(input.request.adapter.id, "credential_broker_invalid_response", false);
  }
  const expiresAt = parsed.expiresAt;
  if (expiresAt !== undefined && (
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now()
  )) {
    throw unavailable(input.request.adapter.id, "credential_broker_invalid_response", false);
  }
  return { token: parsed.token, ...(typeof expiresAt === "number" ? { expiresAt } : {}) };
}

function parsePolicy(value: string | undefined): {
  readonly mcpConnections: readonly AdapterRef[];
} {
  if (!value) return { mcpConnections: [] };
  if (Buffer.byteLength(value) > MAX_POLICY_BYTES) {
    throw new Error("The AgentRun MCP policy is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The AgentRun MCP policy is invalid.");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.mcpConnections)) {
    return { mcpConnections: [] };
  }
  const result = z.array(adapterRefSchema).max(MAX_POLICY_CONNECTIONS).safeParse(
    parsed.mcpConnections,
  );
  if (!result.success) throw new Error("The AgentRun MCP policy is invalid.");
  return { mcpConnections: result.data };
}

async function readBoundedBody(response: Response, connection: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw unavailable(connection, "credential_broker_invalid_response", false);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function unavailable(
  connection: string,
  reason: string,
  retryable: boolean,
): ConnectionAuthorizationFailedError {
  return new ConnectionAuthorizationFailedError(connection, {
    message: "The MCP credential could not be authorized.",
    reason,
    retryable,
  });
}

function textAttribute(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  const text = textAttribute(value);
  if (!text || Buffer.byteLength(text) > maximumBytes) {
    throw new Error(`${label} is invalid.`);
  }
  return text;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
