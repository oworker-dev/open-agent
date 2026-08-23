import {
  AGENT_RUNTIME_CONFIG_CONTRACT_VERSION,
  parseAgentRuntimeConfigSnapshot,
  type AgentReasoningLevel,
  type AgentRuntimeConfigSnapshot,
  type AgentRuntimeModel,
} from "@oworker/open-agent-contracts/runtime-config";

export type { AgentRuntimeConfigSnapshot } from "@oworker/open-agent-contracts/runtime-config";

export const DEFAULT_AGENT_RUNTIME_CONFIG: AgentRuntimeConfigSnapshot = {
  contractVersion: AGENT_RUNTIME_CONFIG_CONTRACT_VERSION,
  id: "standalone-default",
  version: "0.1.0",
  defaultModelId: "gpt-5.6-sol",
  models: [
    {
      id: "gpt-5.6-sol",
      providerModelId: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      contextWindowTokens: 272_000,
      maxOutputTokens: 4_096,
      reasoningLevels: ["low", "medium", "high", "xhigh"],
      defaultReasoning: "high",
    },
    {
      id: "gpt-5.6-terra",
      providerModelId: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      contextWindowTokens: 272_000,
      maxOutputTokens: 4_096,
      reasoningLevels: ["low", "medium", "high", "xhigh"],
      defaultReasoning: "high",
    },
  ],
  profile: {
    id: "general-purpose",
    version: "0.1.0",
    label: "General purpose",
    outputMode: "text",
    // The standalone runtime has no product-specific procedure by default.
    // Hosts may publish and enable a skill explicitly in their snapshot.
    allowedSkills: [],
    defaultSkills: [],
    allowedMcpConnections: [],
    defaultMcpConnections: [],
  },
  compaction: { thresholdPercent: 0.9 },
  limits: {
    // Match Eve's root-session defaults. Context-window compaction remains
    // the mechanism that keeps a long conversation usable; these are lifetime
    // safety budgets, not the model context window.
    maxInputTokens: 40_000_000,
    maxOutputTokens: 10_000_000,
  },
};

export type AgentRuntimeDefinitionLimits = {
  readonly maxInputTokensPerSession?: number | false;
  readonly maxOutputTokensPerSession?: number | false;
};

export function runtimeDefinitionLimits(
  config: AgentRuntimeConfigSnapshot,
): AgentRuntimeDefinitionLimits {
  return {
    maxInputTokensPerSession: config.limits.maxInputTokens ?? 40_000_000,
    maxOutputTokensPerSession: config.limits.maxOutputTokens ?? 10_000_000,
  };
}

export function readDeploymentAgentRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentRuntimeConfigSnapshot {
  const configured = environment.AGENT_RUNTIME_CONFIG_JSON?.trim();
  if (configured) {
    try {
      return parseAgentRuntimeConfigSnapshot(JSON.parse(configured));
    } catch (error) {
      throw new Error("AGENT_RUNTIME_CONFIG_JSON is not a valid Agent runtime config.", {
        cause: error,
      });
    }
  }
  const requestedDefault = environment.AGENT_MODEL_ID?.trim();
  if (!requestedDefault) return DEFAULT_AGENT_RUNTIME_CONFIG;
  if (!DEFAULT_AGENT_RUNTIME_CONFIG.models.some((model) => model.id === requestedDefault)) {
    throw new Error("AGENT_MODEL_ID is not present in the standalone Agent model catalog.");
  }
  return { ...DEFAULT_AGENT_RUNTIME_CONFIG, defaultModelId: requestedDefault };
}

export function resolveAgentRuntimeConfig(
  attributes: Readonly<Record<string, unknown>> | null | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentRuntimeConfigSnapshot {
  const supplied = attributes?.agentRuntimeConfig;
  if (supplied === undefined) return readDeploymentAgentRuntimeConfig(environment);
  try {
    return parseAgentRuntimeConfigSnapshot(
      typeof supplied === "string" ? JSON.parse(supplied) : supplied,
    );
  } catch (error) {
    throw new Error("The authenticated integrator supplied an invalid Agent runtime config.", {
      cause: error,
    });
  }
}

export function findAgentRuntimeModel(
  config: AgentRuntimeConfigSnapshot,
  modelId: unknown,
): AgentRuntimeModel | undefined {
  return typeof modelId === "string"
    ? config.models.find((model) => model.id === modelId)
    : undefined;
}

export function resolveAgentRuntimeModel(
  config: AgentRuntimeConfigSnapshot,
  modelId: unknown,
): AgentRuntimeModel {
  return findAgentRuntimeModel(config, modelId) ??
    findAgentRuntimeModel(config, config.defaultModelId)!;
}

export function isAgentReasoningLevelForModel(
  model: AgentRuntimeModel,
  value: unknown,
): value is AgentReasoningLevel {
  return typeof value === "string" && model.reasoningLevels.includes(value as AgentReasoningLevel);
}

export function isAgentProfileForConfig(
  config: AgentRuntimeConfigSnapshot,
  value: { readonly profileId?: unknown; readonly version?: unknown },
): boolean {
  return value.profileId === config.profile.id && value.version === config.profile.version;
}

export function serializeAgentRuntimeConfig(config: AgentRuntimeConfigSnapshot): string {
  return JSON.stringify(config);
}
