import type { SessionAuthContext } from "eve/context";
import type { AgentSessionOwner } from "../../server/data/session-ownership-store.ts";
import {
  findAgentRuntimeModel,
  isAgentReasoningLevelForModel,
  resolveAgentRuntimeConfig,
} from "../../lib/agent-runtime-config.ts";
import { parseAgentRunPolicy } from "./run-policy.ts";
import type { AgentRunPolicy } from "@oworker/open-agent-contracts/agent-run";

// Persist only verified principal metadata used by the runtime. JWT claims,
// bearer credentials and arbitrary Host attributes never enter the mailbox.
const ATTRIBUTE_NAMES = [
  "actorType", "tenantId", "hostId", "agentHostId", "agentHostScope",
  "agentRuntimeConfig", "agentRunPolicy", "agentRunId", "agentProfileId",
  "agentProfileVersion", "agentCorrelationId", "agentUpstreamTraceParent",
] as const;

export function snapshotMailboxSessionAuth(
  auth: SessionAuthContext,
  owner: AgentSessionOwner,
): SessionAuthContext {
  if (auth.principalId !== owner.principalId ||
      auth.principalType !== owner.principalType ||
      (auth.issuer ?? "") !== (owner.issuer ?? "") ||
      auth.attributes.tenantId !== owner.tenantId) {
    throw new Error("The mailbox caller does not match the session owner.");
  }
  if (auth.subject !== undefined && !validText(auth.subject, 512)) {
    throw new Error("The mailbox caller subject is invalid.");
  }
  if (!validText(auth.authenticator, 128)) {
    throw new Error("The mailbox caller authenticator is invalid.");
  }
  const attributes: Record<string, string> = {};
  for (const name of ATTRIBUTE_NAMES) {
    const value = auth.attributes[name];
    if (value === undefined) continue;
    if (!validText(value, 65_536)) throw new Error("The mailbox caller attributes are invalid.");
    attributes[name] = value;
  }
  const snapshot = {
    attributes,
    authenticator: auth.authenticator,
    ...(owner.issuer ? { issuer: owner.issuer } : {}),
    principalId: owner.principalId,
    principalType: owner.principalType,
    ...(auth.subject ? { subject: auth.subject } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 96 * 1024) {
    throw new Error("The mailbox caller context is too large.");
  }
  return snapshot;
}

export function parseMailboxSessionAuth(
  value: unknown,
  owner: AgentSessionOwner,
): SessionAuthContext | undefined {
  if (!isRecord(value) || !isRecord(value.attributes)) return undefined;
  try {
    return snapshotMailboxSessionAuth(value as unknown as SessionAuthContext, owner);
  } catch {
    return undefined;
  }
}

export function mailboxSessionAuth(input: AgentSessionOwner & {
  readonly callerAuth?: SessionAuthContext;
  readonly executionMode?: AgentRunPolicy["executionMode"];
  readonly itemId: string;
  readonly modelId?: string;
  readonly reasoning?: string;
}): SessionAuthContext {
  const caller = input.callerAuth ? snapshotMailboxSessionAuth(input.callerAuth, input) : undefined;
  const config = resolveAgentRuntimeConfig(caller?.attributes ?? {});
  const model = input.modelId ? findAgentRuntimeModel(config, input.modelId) : undefined;
  if (input.modelId && !model) throw new Error("The mailbox model is not published by this runtime.");
  if (model && input.reasoning && !isAgentReasoningLevelForModel(model, input.reasoning)) {
    throw new Error("The mailbox reasoning level is not supported by this model.");
  }
  const policy = caller?.attributes.agentRunPolicy;
  return {
    ...caller,
    attributes: {
      ...caller?.attributes,
      actorType: input.principalType === "service" ? "service" : "user",
      tenantId: input.tenantId,
      agentMailboxItemId: input.itemId,
      agentMailboxDispatch: "1",
      ...(model ? { agentModelId: model.id } : {}),
      ...(input.reasoning ? { agentReasoning: input.reasoning } : {}),
      ...(input.executionMode ? {
        agentRunPolicy: JSON.stringify({
          ...(typeof policy === "string" ? parseAgentRunPolicy(JSON.parse(policy)) : {}),
          executionMode: input.executionMode,
        }),
      } : {}),
    },
    authenticator: caller?.authenticator ?? "agent-mailbox-dispatch",
    ...(input.issuer ? { issuer: input.issuer } : {}),
    principalId: input.principalId,
    principalType: input.principalType,
  };
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
