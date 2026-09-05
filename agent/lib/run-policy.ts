import { defineState, type SessionContext } from "eve/context";

import type {
  AgentExtensionRef,
  AgentExecutionMode,
  AgentRunLimits,
  AgentRunPolicy,
} from "@oworker/open-agent-contracts/agent-run";

export type RunPolicyState = {
  readonly inputTokens: number;
  readonly modelCalls: number;
  readonly outputTokens: number;
  readonly startedAtMs: number;
  readonly toolCalls: number;
  readonly turns: number;
};

const LIMIT_NAMES = [
  "maxDurationMs",
  "maxInputTokens",
  "maxModelCalls",
  "maxOutputTokens",
  "maxToolCalls",
  "maxTurns",
] as const satisfies readonly (keyof AgentRunLimits)[];
const CAPABILITY_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const MAX_CAPABILITIES = 128;
const MAX_TOOLS = 256;
const MAX_EXTENSIONS = 64;
const EXECUTION_MODES = ["automation", "cautious", "standard"] as const satisfies readonly AgentExecutionMode[];
const EXTENSION_ID = /^[a-z0-9][a-z0-9._-]*$/;
const EXTENSION_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/;
const LIMIT_MAXIMUMS: Readonly<Record<keyof AgentRunLimits, number>> = {
  maxDurationMs: 24 * 60 * 60 * 1_000,
  maxInputTokens: 40_000_000,
  maxModelCalls: 10_000,
  maxOutputTokens: 10_000_000,
  maxToolCalls: 100_000,
  maxTurns: 10_000,
};

export const runPolicyState = defineState<RunPolicyState>(
  "open-agent.run-policy.v1",
  () => ({
    inputTokens: 0,
    modelCalls: 0,
    outputTokens: 0,
    startedAtMs: 0,
    toolCalls: 0,
    turns: 0,
  }),
);

type RunPolicyContext = {
  readonly session: {
    readonly auth: {
      readonly current?: { readonly attributes: Readonly<Record<string, unknown>> } | null;
      readonly initiator?: { readonly attributes: Readonly<Record<string, unknown>> } | null;
    };
  };
};

export function readAgentRunPolicy(session: RunPolicyContext): AgentRunPolicy {
  const value = session.session.auth.initiator?.attributes.agentRunPolicy ??
    session.session.auth.current?.attributes.agentRunPolicy;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parseAgentRunPolicy(parsed);
  } catch {
    return {};
  }
}

/** Strict parser shared by the public AgentRun API and the direct Eve channel. */
export function parseAgentRunPolicy(value: unknown): AgentRunPolicy {
  if (!isRecord(value)) throw new Error("The AgentRun policy must be a JSON object.");
  assertOnlyKeys(value, ["executionMode", "hostCapabilities", "limits", "mcpConnections", "skills", "tools"], "AgentRun policy");

  const executionMode = value.executionMode === undefined ? undefined : parseExecutionMode(value.executionMode);

  let hostCapabilities: readonly string[] | undefined;
  if (value.hostCapabilities !== undefined) {
    if (!Array.isArray(value.hostCapabilities) || value.hostCapabilities.length > MAX_CAPABILITIES) {
      throw new Error(`AgentRun hostCapabilities must contain at most ${MAX_CAPABILITIES} names.`);
    }
    const capabilities = value.hostCapabilities.map((item) => {
      if (
        typeof item !== "string" ||
        item.length < 1 ||
        item.length > 160 ||
        item.trim() !== item ||
        !CAPABILITY_NAME.test(item)
      ) {
        throw new Error("AgentRun hostCapabilities contains an invalid capability name.");
      }
      return item;
    });
    hostCapabilities = [...new Set(capabilities)].sort();
  }

  let limits: AgentRunLimits | undefined;
  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) throw new Error("AgentRun limits must be a JSON object.");
    assertOnlyKeys(value.limits, LIMIT_NAMES, "AgentRun limits");
    const parsedLimits: Partial<Record<keyof AgentRunLimits, number>> = {};
    for (const name of LIMIT_NAMES) {
      const limit = value.limits[name];
      if (limit === undefined) continue;
      if (
        !Number.isSafeInteger(limit) ||
        (limit as number) <= 0 ||
        (limit as number) > LIMIT_MAXIMUMS[name]
      ) {
        throw new Error(
          `AgentRun limit ${name} must be a positive safe integer no greater than ${LIMIT_MAXIMUMS[name]}.`,
        );
      }
      parsedLimits[name] = limit as number;
    }
    limits = parsedLimits;
  }

  const mcpConnections = parseExtensionRefs(value.mcpConnections, "mcpConnections");
  const skills = parseExtensionRefs(value.skills, "skills");
  const tools = parseToolNames(value.tools);

  return {
    ...(executionMode ? { executionMode } : {}),
    ...(hostCapabilities ? { hostCapabilities } : {}),
    ...(limits ? { limits } : {}),
    ...(mcpConnections ? { mcpConnections } : {}),
    ...(skills ? { skills } : {}),
    ...(tools ? { tools } : {}),
  };
}

function parseToolNames(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TOOLS) {
    throw new Error(`AgentRun tools must contain at most ${MAX_TOOLS} names.`);
  }
  const names = value.map((item) => {
    if (
      typeof item !== "string" ||
      item.length < 1 ||
      item.length > 160 ||
      item.trim() !== item ||
      !CAPABILITY_NAME.test(item)
    ) {
      throw new Error("AgentRun tools contains an invalid tool name.");
    }
    return item;
  });
  return [...new Set(names)].sort();
}

export function readAgentExecutionMode(session: RunPolicyContext): AgentExecutionMode {
  return readAgentRunPolicy(session).executionMode ?? "standard";
}

function parseExecutionMode(value: unknown): AgentExecutionMode {
  if (typeof value !== "string" || !(EXECUTION_MODES as readonly string[]).includes(value)) {
    throw new Error("AgentRun executionMode must be automation, cautious, or standard.");
  }
  return value as AgentExecutionMode;
}

function parseExtensionRefs(value: unknown, field: string): readonly AgentExtensionRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_EXTENSIONS) {
    throw new Error(`AgentRun ${field} must contain at most ${MAX_EXTENSIONS} extension refs.`);
  }
  const refs = value.map((item) => {
    if (!isRecord(item)) throw new Error(`AgentRun ${field} contains an invalid extension ref.`);
    assertOnlyKeys(item, ["id", "version"], `AgentRun ${field} extension ref`);
    if (
      typeof item.id !== "string" || item.id.length > 120 || !EXTENSION_ID.test(item.id) ||
      typeof item.version !== "string" || item.version.length > 80 || !EXTENSION_VERSION.test(item.version)
    ) {
      throw new Error(`AgentRun ${field} contains an invalid extension ref.`);
    }
    return { id: item.id, version: item.version };
  });
  const deduplicated = new Map(refs.map((ref) => [`${ref.id}@${ref.version}`, ref]));
  return [...deduplicated.values()].sort((left, right) =>
    `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`),
  );
}

export function allowedHostCapabilities(
  session: SessionContext,
): ReadonlySet<string> | undefined {
  const configured = readAgentRunPolicy(session).hostCapabilities;
  return configured ? new Set(configured) : undefined;
}

export function initializeRunPolicy(now = Date.now()): void {
  runPolicyState.update((state) => ({
    ...state,
    startedAtMs: state.startedAtMs || now,
  }));
}

export function recordRunPolicyBoundary(
  policy: AgentRunPolicy,
  boundary: "model" | "tool" | "turn",
  increment = 1,
  now = Date.now(),
): void {
  const current = runPolicyState.get();
  const next = {
    ...current,
    modelCalls: current.modelCalls + (boundary === "model" ? increment : 0),
    toolCalls: current.toolCalls + (boundary === "tool" ? increment : 0),
    turns: current.turns + (boundary === "turn" ? increment : 0),
  };
  enforceAgentRunPolicy(policy.limits, next, now);
  runPolicyState.update(() => next);
}

export function recordRunPolicyUsage(
  policy: AgentRunPolicy,
  usage: { readonly inputTokens: number; readonly outputTokens: number },
  now = Date.now(),
): void {
  const current = runPolicyState.get();
  const next = {
    ...current,
    inputTokens: current.inputTokens + usage.inputTokens,
    outputTokens: current.outputTokens + usage.outputTokens,
  };
  enforceAgentRunPolicy(policy.limits, next, now);
  runPolicyState.update(() => next);
}

export function enforceAgentRunPolicy(
  limits: AgentRunLimits | undefined,
  state: RunPolicyState,
  now: number,
): void {
  if (!limits) return;
  const checks: Array<[number | undefined, number, keyof AgentRunLimits]> = [
    [limits.maxTurns, state.turns, "maxTurns"],
    [limits.maxModelCalls, state.modelCalls, "maxModelCalls"],
    [limits.maxToolCalls, state.toolCalls, "maxToolCalls"],
    [limits.maxInputTokens, state.inputTokens, "maxInputTokens"],
    [limits.maxOutputTokens, state.outputTokens, "maxOutputTokens"],
    [
      limits.maxDurationMs,
      state.startedAtMs > 0 ? Math.max(0, now - state.startedAtMs) : 0,
      "maxDurationMs",
    ],
  ];
  const exceeded = checks.find(([limit, actual]) => limit !== undefined && actual > limit);
  if (exceeded) {
    throw new Error(
      `AgentRun policy exceeded ${exceeded[2]} (${exceeded[1]} > ${exceeded[0]}).`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} contains unknown field ${unknown}.`);
}
