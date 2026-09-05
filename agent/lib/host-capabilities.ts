import { defineState, type SessionContext } from "eve/context";
import { createAgentHostCapabilityClient } from "@oworker/open-agent-host/client";
import type { AgentHostInvocationIdentity } from "@oworker/open-agent-contracts/host";
import type { AgentHostCapabilityDescriptor } from "@oworker/open-agent-contracts/host-capability";
import type { JsonValue } from "@oworker/open-agent-contracts/agent-run";
import { allowedHostCapabilities, readAgentRunPolicy } from "./run-policy.ts";

// Host-owned media and workflow calls can legitimately outlive a normal chat
// turn. Keep the default inside the public upper bound so a host can still
// choose a shorter timeout for read-only capabilities.
const DEFAULT_TIMEOUT_MS = 120_000;
const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_GATEWAY_REGISTRY_BYTES = 256 * 1024;
const MAX_GATEWAYS = 256;

export type HostCapabilityGateway = {
  readonly baseUrl: string;
  readonly secret: string;
  readonly timeoutMs: number;
};

export const hostCapabilityCatalogState = defineState<
  readonly AgentHostCapabilityDescriptor[]
>("open-agent.host-capability-catalog.v1", () => []);

export function isHostCapabilityConfigured(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  try {
    return parseHostGatewayRegistry(environment) !== undefined || Boolean(
      environment.AGENT_HOST_TOOLS_URL?.trim() &&
        environment.AGENT_HOST_TOOLS_SECRET?.trim(),
    );
  } catch {
    return false;
  }
}

type HostCapabilityResolverContext = {
  readonly session: {
    readonly auth: {
      readonly current?: { readonly attributes: Readonly<Record<string, unknown>> } | null;
      readonly initiator?: { readonly attributes: Readonly<Record<string, unknown>> } | null;
    };
  };
};

export function shouldExposeHostCapabilities(
  session: HostCapabilityResolverContext,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const principal = session.session.auth.initiator ?? session.session.auth.current;
  const allowed = readAgentRunPolicy(session).hostCapabilities;
  return Boolean(
    principal &&
      allowed?.length &&
      resolveHostGateway(session, environment),
  );
}

export async function listHostCapabilities(
  session: SessionContext,
  signal?: AbortSignal,
): Promise<readonly AgentHostCapabilityDescriptor[]> {
  const capabilities = await hostClient(session).list({ signal });
  const allowed = allowedHostCapabilities(session);
  const visible = allowed
    ? capabilities.filter((capability) => allowed.has(capability.name))
    : capabilities;
  return visible;
}

export function rememberHostCapabilities(
  capabilities: readonly AgentHostCapabilityDescriptor[],
): void {
  hostCapabilityCatalogState.update(() => capabilities);
}

export function hostCapabilityApprovalDecision(input: {
  readonly actorType: unknown;
  readonly capability: unknown;
}): "not-applicable" | "user-approval" {
  if (input.actorType === "service") return "not-applicable";
  if (typeof input.capability !== "string") return "user-approval";
  const descriptor = hostCapabilityCatalogState
    .get()
    .find((candidate) => candidate.name === input.capability);
  return approvalForHostCapability({
    actorType: input.actorType,
    sideEffect: descriptor?.sideEffect,
  });
}

export function approvalForHostCapability(input: {
  readonly actorType: unknown;
  readonly sideEffect: AgentHostCapabilityDescriptor["sideEffect"] | undefined;
}): "not-applicable" | "user-approval" {
  return input.actorType === "service" || input.sideEffect === "none"
    ? "not-applicable"
    : "user-approval";
}

export async function invokeHostCapability(
  session: SessionContext,
  input: {
    readonly capability: string;
    readonly input: Readonly<Record<string, JsonValue>>;
    readonly correlationId?: string;
  },
  signal?: AbortSignal,
): Promise<JsonValue> {
  const allowed = allowedHostCapabilities(session);
  if (allowed && !allowed.has(input.capability)) {
    throw new Error(
      `Host capability "${input.capability}" is not allowed by this AgentRun policy.`,
    );
  }
  const response = await hostClient(session).invoke({
    capability: input.capability,
    input: input.input,
    runId:
      typeof session.session.auth.current?.attributes.agentRunId === "string"
        ? session.session.auth.current.attributes.agentRunId
        : session.session.id,
    sessionId: session.session.id,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  }, { signal });
  return response.output;
}

function hostClient(session: SessionContext) {
  const gateway = resolveHostGateway(session);
  if (!gateway) {
    throw new Error("No Host capability gateway is configured for this Agent host.");
  }
  return createAgentHostCapabilityClient({
    baseUrl: gateway.baseUrl,
    identity: hostIdentity(session),
    secret: gateway.secret,
    timeoutMs: gateway.timeoutMs,
  });
}

/**
 * Resolve a gateway from the signed Host identity. Registry entries are
 * deployment configuration, never browser input; the legacy global URL/secret
 * remains the fallback for single-host deployments.
 */
export function resolveHostGateway(
  session: HostCapabilityResolverContext,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): HostCapabilityGateway | undefined {
  const registry = parseHostGatewayRegistry(environment);
  if (registry !== undefined) {
    const hostId = readHostId(session);
    return hostId ? registry.get(hostId) : undefined;
  }
  const baseUrl = environment.AGENT_HOST_TOOLS_URL?.trim();
  const secret = environment.AGENT_HOST_TOOLS_SECRET?.trim();
  if (!baseUrl || !secret) return undefined;
  if (secret.length < 32) {
    throw new Error("AGENT_HOST_TOOLS_SECRET must contain at least 32 characters.");
  }
  return {
    baseUrl,
    secret,
    timeoutMs: readHostCapabilityTimeoutMs(environment),
  };
}

function readHostId(session: HostCapabilityResolverContext): string | undefined {
  const principal = session.session.auth.current ?? session.session.auth.initiator;
  const value = principal?.attributes.hostId ?? principal?.attributes.agentHostId;
  return typeof value === "string" && HOST_ID_PATTERN.test(value) ? value : undefined;
}

function parseHostGatewayRegistry(
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, HostCapabilityGateway> | undefined {
  const raw = environment.AGENT_HOST_GATEWAYS_JSON?.trim();
  if (!raw) return undefined;
  if (Buffer.byteLength(raw) > MAX_GATEWAY_REGISTRY_BYTES) {
    throw new Error("AGENT_HOST_GATEWAYS_JSON exceeds 256 KiB.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_HOST_GATEWAYS_JSON must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AGENT_HOST_GATEWAYS_JSON must be an object keyed by hostId.");
  }
  const gateways = new Map<string, HostCapabilityGateway>();
  for (const [hostId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (gateways.size >= MAX_GATEWAYS) {
      throw new Error(`AGENT_HOST_GATEWAYS_JSON may contain at most ${MAX_GATEWAYS} hosts.`);
    }
    if (!HOST_ID_PATTERN.test(hostId)) throw new Error("AGENT_HOST_GATEWAYS_JSON contains an invalid hostId.");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Host gateway ${hostId} must be an object.`);
    }
    const entry = value as Record<string, unknown>;
    const unknown = Object.keys(entry).find((key) => !["url", "secret", "timeoutMs"].includes(key));
    if (unknown) throw new Error(`Host gateway ${hostId} contains unknown field ${unknown}.`);
    const baseUrl = typeof entry.url === "string" ? entry.url.trim() : "";
    const secret = typeof entry.secret === "string" ? entry.secret.trim() : "";
    if (!baseUrl || !secret || secret.length < 32) {
      throw new Error(`Host gateway ${hostId} requires a URL and a 32+ character secret.`);
    }
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error(`Host gateway ${hostId} URL is invalid.`);
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password) {
      throw new Error(`Host gateway ${hostId} URL must be an HTTP(S) URL without credentials.`);
    }
    const timeoutMs = entry.timeoutMs === undefined
      ? DEFAULT_TIMEOUT_MS
      : typeof entry.timeoutMs === "number"
        ? entry.timeoutMs
        : Number.NaN;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > DEFAULT_TIMEOUT_MS) {
      throw new Error(`Host gateway ${hostId} timeoutMs must be from 1000 to 120000.`);
    }
    gateways.set(hostId, { baseUrl, secret, timeoutMs });
  }
  return gateways;
}

/** Validate the optional registry during production boot/doctor checks. */
export function validateHostGatewayRegistry(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  parseHostGatewayRegistry(environment);
}

function hostIdentity(session: SessionContext): AgentHostInvocationIdentity {
  const auth = session.session.auth.current;
  const tenantId = auth?.attributes.tenantId;
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    throw new Error("A tenant-scoped authenticated Agent session is required for Host capabilities.");
  }
  const principalId = auth?.subject ?? auth?.principalId;
  if (typeof principalId !== "string" || !principalId.trim()) {
    throw new Error("An authenticated Agent principal is required for Host capabilities.");
  }
  const scope = parseScopeAttribute(auth?.attributes.agentHostScope);
  return {
    actorType: auth?.attributes.actorType === "service" ? "service" : "user",
    principalId,
    tenantId,
    ...(scope ? { scope } : {}),
  };
}

function parseScopeAttribute(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    if (!Object.values(parsed).every((item) => typeof item === "string")) return undefined;
    return parsed as Readonly<Record<string, string>>;
  } catch {
    return undefined;
  }
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for Host capabilities.`);
  return normalized;
}

export function readHostCapabilityTimeoutMs(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = environment.AGENT_HOST_TOOLS_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new Error("AGENT_HOST_TOOLS_TIMEOUT_MS must be an integer from 1000 to 120000.");
  }
  return parsed;
}
