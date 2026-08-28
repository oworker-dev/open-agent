import type { AgentExtensionRef, AgentRunLimits, JsonValue } from "./agent-run.js";

export const AGENT_RUNTIME_CONFIG_CONTRACT_VERSION = "0.1.0" as const;

export const AGENT_REASONING_LEVELS = ["low", "medium", "high", "xhigh"] as const;

export type AgentReasoningLevel = (typeof AGENT_REASONING_LEVELS)[number];

export type AgentRuntimeModel = {
  readonly id: string;
  readonly providerModelId: string;
  readonly label: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly reasoningLevels: readonly AgentReasoningLevel[];
  readonly defaultReasoning: AgentReasoningLevel;
};

/**
 * Framework session limits published by a host. Token lifetime limits may be
 * explicitly disabled with `false`; this maps directly to Eve's
 * uncapped-session semantics and is distinct from an omitted field.
 */
export type AgentRuntimeLimits = Omit<AgentRunLimits, "maxInputTokens" | "maxOutputTokens"> & {
  readonly maxInputTokens?: number | false;
  readonly maxOutputTokens?: number | false;
};

export type AgentRuntimeProfile = {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly outputMode: "json" | "text";
  readonly instructions?: string;
  readonly allowedSkills: readonly AgentExtensionRef[];
  readonly defaultSkills: readonly AgentExtensionRef[];
  readonly allowedMcpConnections: readonly AgentExtensionRef[];
  readonly defaultMcpConnections: readonly AgentExtensionRef[];
};

/**
 * Host-published extension metadata. Skill content is procedure text only;
 * credentials and opaque provider secrets are never valid in this contract.
 */
export type AgentRuntimeExtension = AgentExtensionRef & {
  readonly kind: "mcp" | "skill";
  readonly label: string;
  readonly description: string;
  readonly skill?: {
    readonly markdown: string;
  };
  readonly mcp?: {
    readonly endpoint: string;
    readonly authProvider?: string;
  };
};

/**
 * A credential-free, versioned execution snapshot supplied by the standalone
 * deployment or an authenticated integrator. Existing durable sessions pin the
 * exact snapshot; changing a Host default never mutates an active session.
 */
export type AgentRuntimeConfigSnapshot = {
  readonly contractVersion: typeof AGENT_RUNTIME_CONFIG_CONTRACT_VERSION;
  readonly id: string;
  readonly version: string;
  readonly defaultModelId: string;
  readonly models: readonly AgentRuntimeModel[];
  readonly profile: AgentRuntimeProfile;
  readonly compaction: {
    readonly thresholdPercent: number;
  };
  readonly limits: AgentRuntimeLimits;
  readonly extensions?: readonly AgentRuntimeExtension[];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export function parseAgentRuntimeConfigSnapshot(value: unknown): AgentRuntimeConfigSnapshot {
  if (!isRecord(value)) throw invalid("must be an object");
  assertOnlyKeys(value, [
    "compaction",
    "contractVersion",
    "defaultModelId",
    "id",
    "limits",
    "metadata",
    "models",
    "extensions",
    "profile",
    "version",
  ], "config");
  if (value.contractVersion !== AGENT_RUNTIME_CONFIG_CONTRACT_VERSION) {
    throw invalid(`must use contract ${AGENT_RUNTIME_CONFIG_CONTRACT_VERSION}`);
  }
  const id = text(value.id, "id", 120);
  const version = text(value.version, "version", 80);
  if (!Array.isArray(value.models) || value.models.length < 1 || value.models.length > 128) {
    throw invalid("models must contain between 1 and 128 entries");
  }
  const models = value.models.map(parseModel);
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) throw invalid(`model ${model.id} is duplicated`);
    modelIds.add(model.id);
  }
  const defaultModelId = text(value.defaultModelId, "defaultModelId", 160);
  if (!modelIds.has(defaultModelId)) throw invalid("defaultModelId is not present in models");
  const profile = parseProfile(value.profile);
  if (!isRecord(value.compaction)) throw invalid("compaction must be an object");
  assertOnlyKeys(value.compaction, ["thresholdPercent"], "compaction");
  const thresholdPercent = finite(value.compaction.thresholdPercent, "compaction.thresholdPercent");
  if (thresholdPercent < 0.5 || thresholdPercent > 0.95) {
    throw invalid("compaction.thresholdPercent must be from 0.5 to 0.95");
  }
  const limits = parseLimits(value.limits);
  const extensions = parseExtensions(value.extensions);
  assertProfileExtensions(profile, extensions);
  const metadata = value.metadata === undefined
    ? undefined
    : jsonRecord(value.metadata, "metadata", 64 * 1024);
  return {
    contractVersion: AGENT_RUNTIME_CONFIG_CONTRACT_VERSION,
    id,
    version,
    defaultModelId,
    models,
    profile,
    compaction: { thresholdPercent },
    limits,
    ...(extensions.length ? { extensions } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function parseExtensions(value: unknown): readonly AgentRuntimeExtension[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw invalid("extensions must contain at most 128 entries");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isRecord(item)) throw invalid("extensions contains an invalid entry");
    assertOnlyKeys(item, ["description", "id", "kind", "label", "mcp", "skill", "version"], "extension");
    const id = text(item.id, "extension.id", 120);
    const version = text(item.version, "extension.version", 80);
    const kind = item.kind === "skill" || item.kind === "mcp" ? item.kind : invalid("extension.kind is invalid");
    const key = `${kind}:${id}@${version}`;
    if (seen.has(key)) throw invalid(`extension ${key} is duplicated`);
    seen.add(key);
    const label = text(item.label, "extension.label", 120);
    const description = text(item.description, "extension.description", 2_000);
    const skill = item.skill === undefined
      ? undefined
      : parseSkill(item.skill);
    const mcp = item.mcp === undefined
      ? undefined
      : parseMcp(item.mcp);
    if (kind === "skill" && !skill) throw invalid(`skill extension ${key} is missing content`);
    if (kind === "mcp" && !mcp) throw invalid(`MCP extension ${key} is missing endpoint`);
    if (kind === "skill" && mcp || kind === "mcp" && skill) {
      throw invalid(`extension ${key} contains content for the wrong kind`);
    }
    return {
      id,
      version,
      kind,
      label,
      description,
      ...(skill ? { skill } : {}),
      ...(mcp ? { mcp } : {}),
    };
  });
}

function parseSkill(value: unknown): AgentRuntimeExtension["skill"] {
  if (!isRecord(value)) throw invalid("extension.skill must be an object");
  assertOnlyKeys(value, ["markdown"], "extension.skill");
  return { markdown: text(value.markdown, "extension.skill.markdown", 100_000) };
}

function parseMcp(value: unknown): AgentRuntimeExtension["mcp"] {
  if (!isRecord(value)) throw invalid("extension.mcp must be an object");
  assertOnlyKeys(value, ["authProvider", "endpoint"], "extension.mcp");
  const endpoint = text(value.endpoint, "extension.mcp.endpoint", 2_048);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalid("extension.mcp.endpoint must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "https:") throw invalid("extension.mcp.endpoint must use HTTPS");
  const authProvider = value.authProvider === undefined
    ? undefined
    : text(value.authProvider, "extension.mcp.authProvider", 120);
  return { endpoint, ...(authProvider ? { authProvider } : {}) };
}

function assertProfileExtensions(
  profile: AgentRuntimeProfile,
  extensions: readonly AgentRuntimeExtension[],
) {
  const available = new Set(extensions.map((item) => `${item.kind}:${item.id}@${item.version}`));
  for (const ref of profile.allowedSkills) {
    if (!available.has(`skill:${ref.id}@${ref.version}`)) {
      throw invalid(`profile skill ${ref.id}@${ref.version} has no published extension manifest`);
    }
  }
  for (const ref of profile.allowedMcpConnections) {
    if (!available.has(`mcp:${ref.id}@${ref.version}`)) {
      throw invalid(`profile MCP connection ${ref.id}@${ref.version} has no published extension manifest`);
    }
  }
}

function parseModel(value: unknown): AgentRuntimeModel {
  if (!isRecord(value)) throw invalid("each model must be an object");
  assertOnlyKeys(value, [
    "contextWindowTokens",
    "defaultReasoning",
    "id",
    "label",
    "maxOutputTokens",
    "providerModelId",
    "reasoningLevels",
  ], "model");
  const id = text(value.id, "model.id", 160);
  const providerModelId = text(value.providerModelId, "model.providerModelId", 160);
  const label = text(value.label, "model.label", 120);
  const contextWindowTokens = integer(value.contextWindowTokens, "model.contextWindowTokens", 2_048, 4_000_000);
  const maxOutputTokens = integer(value.maxOutputTokens, "model.maxOutputTokens", 256, 128_000);
  if (maxOutputTokens > contextWindowTokens) {
    throw invalid(`model ${id} maxOutputTokens exceeds its context window`);
  }
  if (
    !Array.isArray(value.reasoningLevels) ||
    value.reasoningLevels.length < 1 ||
    value.reasoningLevels.length > AGENT_REASONING_LEVELS.length
  ) {
    throw invalid(`model ${id} reasoningLevels is invalid`);
  }
  const reasoningLevels = [...new Set(value.reasoningLevels.map((item) => reasoning(item, `model ${id}`)))];
  const defaultReasoning = reasoning(value.defaultReasoning, `model ${id}`);
  if (!reasoningLevels.includes(defaultReasoning)) {
    throw invalid(`model ${id} defaultReasoning is not supported`);
  }
  return {
    id,
    providerModelId,
    label,
    contextWindowTokens,
    maxOutputTokens,
    reasoningLevels,
    defaultReasoning,
  };
}

function parseProfile(value: unknown): AgentRuntimeProfile {
  if (!isRecord(value)) throw invalid("profile must be an object");
  assertOnlyKeys(value, [
    "allowedMcpConnections",
    "allowedSkills",
    "defaultMcpConnections",
    "defaultSkills",
    "id",
    "instructions",
    "label",
    "outputMode",
    "version",
  ], "profile");
  const profile: AgentRuntimeProfile = {
    id: text(value.id, "profile.id", 120),
    version: text(value.version, "profile.version", 80),
    label: text(value.label, "profile.label", 120),
    outputMode: value.outputMode === "json" ? "json" : value.outputMode === "text" ? "text" : invalid("profile.outputMode is invalid"),
    ...(value.instructions === undefined
      ? {}
      : { instructions: text(value.instructions, "profile.instructions", 100_000) }),
    allowedSkills: extensionRefs(value.allowedSkills, "profile.allowedSkills"),
    defaultSkills: extensionRefs(value.defaultSkills, "profile.defaultSkills"),
    allowedMcpConnections: extensionRefs(value.allowedMcpConnections, "profile.allowedMcpConnections"),
    defaultMcpConnections: extensionRefs(value.defaultMcpConnections, "profile.defaultMcpConnections"),
  };
  assertDefaultsAllowed(profile.defaultSkills, profile.allowedSkills, "Skill");
  assertDefaultsAllowed(profile.defaultMcpConnections, profile.allowedMcpConnections, "MCP connection");
  return profile;
}

function extensionRefs(value: unknown, name: string): readonly AgentExtensionRef[] {
  if (!Array.isArray(value) || value.length > 64) throw invalid(`${name} is invalid`);
  const refs = value.map((item) => {
    if (!isRecord(item)) throw invalid(`${name} contains an invalid reference`);
    assertOnlyKeys(item, ["id", "version"], `${name} reference`);
    return {
      id: text(item.id, `${name}.id`, 120),
      version: text(item.version, `${name}.version`, 80),
    };
  });
  return [...new Map(refs.map((ref) => [`${ref.id}@${ref.version}`, ref])).values()];
}

function assertDefaultsAllowed(
  defaults: readonly AgentExtensionRef[],
  allowed: readonly AgentExtensionRef[],
  kind: string,
) {
  const keys = new Set(allowed.map((ref) => `${ref.id}@${ref.version}`));
  for (const ref of defaults) {
    if (!keys.has(`${ref.id}@${ref.version}`)) {
      throw invalid(`${kind} ${ref.id}@${ref.version} is defaulted but not allowed`);
    }
  }
}

function parseLimits(value: unknown): AgentRuntimeLimits {
  if (!isRecord(value)) throw invalid("limits must be an object");
  const maximums = {
    maxDurationMs: 24 * 60 * 60 * 1_000,
    maxInputTokens: 40_000_000,
    maxModelCalls: 10_000,
    maxOutputTokens: 10_000_000,
    maxToolCalls: 100_000,
    maxTurns: 10_000,
  } as const;
  assertOnlyKeys(value, Object.keys(maximums), "limits");
  const limits: Record<string, number | false> = {};
  for (const [name, maximum] of Object.entries(maximums)) {
    const item = value[name];
    if (item === undefined) continue;
    if ((name === "maxInputTokens" || name === "maxOutputTokens") && item === false) {
      limits[name] = false;
      continue;
    }
    limits[name] = integer(item, `limits.${name}`, 1, maximum);
  }
  return limits as AgentRuntimeLimits;
}

function reasoning(value: unknown, owner: string): AgentReasoningLevel {
  if (typeof value === "string" && AGENT_REASONING_LEVELS.includes(value as AgentReasoningLevel)) {
    return value as AgentReasoningLevel;
  }
  throw invalid(`${owner} contains an invalid reasoning level`);
}

function jsonRecord(value: unknown, name: string, maximumBytes: number): Readonly<Record<string, JsonValue>> {
  if (!isRecord(value)) throw invalid(`${name} must be an object`);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalid(`${name} must be JSON serializable`);
  }
  if (!serialized || !isJsonValue(value)) throw invalid(`${name} must contain only JSON values`);
  if (new TextEncoder().encode(serialized).byteLength > maximumBytes) throw invalid(`${name} is too large`);
  return value as Readonly<Record<string, JsonValue>>;
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value)
  ) return true;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  owner: string,
): void {
  const allowlist = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowlist.has(key));
  if (unknown) throw invalid(`${owner} contains unknown field ${unknown}`);
}

function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(`${name} must be finite`);
  return value;
}

function invalid(message: string): never {
  throw new Error(`Agent runtime config ${message}.`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
