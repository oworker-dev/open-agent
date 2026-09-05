import type {
  AgentExtensionRef,
  AgentRunLimits,
  AgentRunPolicy,
  AgentProfileRef as ContractAgentProfileRef,
} from "@oworker/open-agent-contracts/agent-run";
import type {
  AgentRuntimeConfigSnapshot,
  AgentRuntimeExtension,
  AgentRuntimeLimits,
} from "@oworker/open-agent-contracts/runtime-config";
import { DEFAULT_AGENT_RUNTIME_CONFIG } from "./agent-runtime-config.ts";

export type AgentExtensionKind = "mcp" | "skill";
export type AgentExtensionStatus = "published" | "revoked";
export type AgentExtensionCredentialMode = "none" | "reference-required";
export type AgentExtensionTenantDefault = "disabled" | "enabled";

/** Names of tools compiled into this deployment and safe to select by policy. */
export const COMPILED_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "agent",
  "apply_patch",
  "ask_question",
  "bash",
  "glob",
  "grep",
  "host_capabilities",
  "host_invoke",
  "import_asset",
  "load_skill",
  "publish_artifact",
  "publish_preview",
  "read_file",
  "record_checkpoint",
  "todo",
  "view_image",
  "web_fetch",
  "web_search",
  "write_file",
]);

export type AgentExtensionManifest = AgentExtensionRef & {
  readonly credentialMode: AgentExtensionCredentialMode;
  readonly defaultTenantStatus: AgentExtensionTenantDefault;
  readonly description: string;
  readonly kind: AgentExtensionKind;
  readonly requiredPermissions: readonly string[];
  readonly status: AgentExtensionStatus;
};

export const AGENT_EXTENSION_CATALOG: readonly AgentExtensionManifest[] = [
  {
    id: "software-task",
    version: "1.0.0",
    kind: "skill",
    credentialMode: "none",
    defaultTenantStatus: "enabled",
    requiredPermissions: [],
    status: "published",
    description: "Inspect, implement, test, and report a software workspace change.",
  },
];

export function agentExtensionCatalogForConfig(
  config: AgentRuntimeConfigSnapshot,
): readonly AgentExtensionManifest[] {
  const catalog = new Map(
    AGENT_EXTENSION_CATALOG.map((manifest) => [extensionRefKey(manifest), manifest]),
  );
  const defaultSkills = new Set(config.profile.defaultSkills.map(extensionRefKey));
  const defaultMcpConnections = new Set(
    config.profile.defaultMcpConnections.map(extensionRefKey),
  );
  for (const extension of config.extensions ?? []) {
    const key = extensionRefKey(extension);
    const existing = catalog.get(key);
    if (existing && existing.kind !== extension.kind) {
      throw new Error(`Extension ${key} is published as both ${existing.kind} and ${extension.kind}.`);
    }
    const isDefault = extension.kind === "skill"
      ? defaultSkills.has(key)
      : defaultMcpConnections.has(key);
    catalog.set(key, {
      credentialMode:
        extension.kind === "mcp" && extension.mcp?.authProvider
          ? "reference-required"
          : "none",
      defaultTenantStatus: isDefault ? "enabled" : "disabled",
      description: extension.description,
      id: extension.id,
      kind: extension.kind,
      requiredPermissions: [],
      status: "published",
      version: extension.version,
    });
  }
  return [...catalog.values()].sort((left, right) =>
    extensionRefKey(left).localeCompare(extensionRefKey(right)),
  );
}

/**
 * Resolves the exact extension grant recorded on an AgentRun. A request can
 * narrow a profile, but never add an extension that the published profile did
 * not allow. Revocation is checked again when a durable session starts.
 */
export function resolveAgentRunPolicy(
  profileRef: ContractAgentProfileRef,
  requested: AgentRunPolicy,
  revokedRefs: ReadonlySet<string> = revokedExtensionRefsFromEnvironment(),
  config: AgentRuntimeConfigSnapshot = DEFAULT_AGENT_RUNTIME_CONFIG,
): AgentRunPolicy {
  const profile = config.profile;
  if (profile.id !== profileRef.profileId || profile.version !== profileRef.version) {
    throw new Error("The Agent profile is not published by the active runtime config.");
  }

  const skills = resolveExtensionRefs(
    "skill",
    requested.skills ?? profile.defaultSkills,
    profile.allowedSkills,
    revokedRefs,
    config,
  );
  const mcpConnections = resolveExtensionRefs(
    "mcp",
    requested.mcpConnections ?? profile.defaultMcpConnections,
    profile.allowedMcpConnections,
    revokedRefs,
    config,
  );
  const tools = resolveAgentRunTools(requested.tools, profile.allowedTools, profile.defaultTools);
  const limits = mergeAgentRunLimits(config.limits, requested.limits);

  return {
    ...(requested.executionMode ? { executionMode: requested.executionMode } : {}),
    ...(requested.hostCapabilities ? { hostCapabilities: requested.hostCapabilities } : {}),
    ...(limits ? { limits } : {}),
    mcpConnections,
    skills,
    ...(tools !== undefined ? { tools } : {}),
  };
}

function resolveAgentRunTools(
  requested: readonly string[] | undefined,
  allowed: readonly string[] | undefined,
  defaults: readonly string[] | undefined,
): readonly string[] | undefined {
  const selected = requested ?? defaults ?? allowed;
  if (selected === undefined) return undefined;
  const allowedNames = allowed === undefined ? undefined : new Set(allowed);
  const resolved = [...new Set(selected)].sort();
  const unknown = resolved.find((name) => !COMPILED_AGENT_TOOL_NAMES.has(name));
  if (unknown !== undefined) {
    throw new Error(`Tool ${unknown} is not compiled into this Agent deployment.`);
  }
  if (allowedNames !== undefined) {
    const denied = resolved.find((name) => !allowedNames.has(name));
    if (denied !== undefined) {
      throw new Error(`Tool ${denied} is not allowed by the Agent profile.`);
    }
  }
  return resolved;
}

export function mergeAgentRunLimits(
  configured: AgentRuntimeLimits | AgentRunLimits | undefined,
  requested: AgentRunLimits | undefined,
): AgentRunLimits | undefined {
  if (!configured && !requested) return undefined;
  const merged: Partial<Record<keyof AgentRunLimits, number>> = {};
  for (const name of [
    "maxDurationMs",
    "maxInputTokens",
    "maxModelCalls",
    "maxOutputTokens",
    "maxToolCalls",
    "maxTurns",
  ] as const) {
    const configuredValue = configured?.[name];
    const requestedValue = requested?.[name];
    // `false` is the explicit uncapped value used by the runtime snapshot.
    // It contributes no request-policy limit; a numeric host or caller limit
    // still applies normally.
    const configuredNumber = typeof configuredValue === "number" ? configuredValue : undefined;
    if (configuredNumber !== undefined && requestedValue !== undefined) {
      merged[name] = Math.min(configuredNumber, requestedValue);
    } else if (configuredNumber !== undefined) {
      merged[name] = configuredNumber;
    } else if (requestedValue !== undefined) {
      merged[name] = requestedValue;
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

export function extensionRefKey(ref: AgentExtensionRef): string {
  return `${ref.id}@${ref.version}`;
}

export function revokedExtensionRefsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlySet<string> {
  const configured = environment.AGENT_REVOKED_EXTENSIONS?.trim();
  if (!configured) return new Set();
  return new Set(
    configured
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function resolveExtensionRefs(
  kind: AgentExtensionKind,
  requested: readonly AgentExtensionRef[],
  allowed: readonly AgentExtensionRef[],
  revokedRefs: ReadonlySet<string>,
  config: AgentRuntimeConfigSnapshot,
): readonly AgentExtensionRef[] {
  const allowedKeys = new Set(allowed.map(extensionRefKey));
  const resolved = new Map<string, AgentExtensionRef>();
  for (const ref of requested) {
    const key = extensionRefKey(ref);
    if (!allowedKeys.has(key)) {
      throw new Error(`Extension ${key} is not allowed by the Agent profile.`);
    }
    const runtimeManifest = config.extensions?.find(
      (candidate) =>
        candidate.id === ref.id &&
        candidate.version === ref.version &&
        candidate.kind === kind,
    );
    const staticManifest = AGENT_EXTENSION_CATALOG.find(
      (candidate) => extensionRefKey(candidate) === key && candidate.kind === kind,
    );
    if (kind === "mcp" && staticManifest === undefined) {
      throw new Error(`Extension ${key} has no compiled MCP connection adapter.`);
    }
    const manifest = kind === "mcp" ? staticManifest : runtimeManifest ?? staticManifest;
    if (!manifest) throw new Error(`Extension ${key} is not installed as ${kind}.`);
    if (
      revokedRefs.has(key) ||
      runtimeManifest === undefined && staticManifest?.status !== "published"
    ) {
      throw new Error(`Extension ${key} is revoked.`);
    }
    resolved.set(key, { id: manifest.id, version: manifest.version });
  }
  return [...resolved.values()].sort((left, right) =>
    extensionRefKey(left).localeCompare(extensionRefKey(right)),
  );
}

export function runtimeExtensionForRef(
  config: AgentRuntimeConfigSnapshot,
  kind: AgentExtensionKind,
  ref: AgentExtensionRef,
): AgentRuntimeExtension | undefined {
  return config.extensions?.find(
    (extension) =>
      extension.kind === kind &&
      extension.id === ref.id &&
      extension.version === ref.version,
  );
}
