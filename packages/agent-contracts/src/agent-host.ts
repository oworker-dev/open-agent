import type { JsonValue } from "./agent-run.js";

export const AGENT_HOST_CONTRACT_VERSION = "0.1.0-draft" as const;

export type AgentHostTokenClaims = {
  readonly sub: string;
  readonly tenantId: string;
  readonly actorType: "user" | "service";
  /** Stable server-side Host Registry key used to route Host capabilities. */
  readonly hostId?: string;
  /** Opaque host-defined scope values. The Agent never interprets their keys. */
  readonly hostScope?: Readonly<Record<string, string>>;
  readonly permissions?: readonly string[];
};

export type AgentHostInvocationIdentity = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly actorType: "user" | "service";
  /** Opaque host-defined scope values carried through the signed adapter call. */
  readonly scope?: Readonly<Record<string, string>>;
};

export type AgentHostToolDescriptor = {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
  readonly requiredPermissions: readonly string[];
};

export type AgentHostContext = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly actorType: "user" | "service";
  readonly tools?: readonly AgentHostToolDescriptor[];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};
