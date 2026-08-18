import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type AgentRunInputResponse,
  type RespondAgentRunRequest,
  type JsonValue,
  type StartAgentRunRequest,
} from "@oworker/open-agent-contracts/agent-run";
import {
  DEFAULT_AGENT_RUNTIME_CONFIG,
  isAgentProfileForConfig,
  type AgentRuntimeConfigSnapshot,
} from "../../lib/agent-runtime-config.ts";
import { parseAgentRunPolicy } from "../../agent/lib/run-policy.ts";
import { resolveAgentRunPolicy } from "../../lib/agent-extension-catalog.ts";

const MAX_JSON_BYTES = 64 * 1024;
export const MAX_AGENT_RUN_DEPTH = 8;
const capabilityNameSchema = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const positiveLimit = z.number().int().positive();
const extensionRefSchema = z.object({
  id: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/),
  version: z.string().min(1).max(80).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/),
}).strict();

const startSchema = z.object({
  clientContext: z.record(z.string(), z.unknown()).optional(),
  correlationId: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
  message: z.string().trim().min(1).max(100_000),
  metadata: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  parent: z.object({
    depth: z.number().int().min(1).max(MAX_AGENT_RUN_DEPTH),
    parentRunId: z.string().trim().min(1).max(200),
    rootRunId: z.string().trim().min(1).max(200),
    source: z.enum(["agent", "workflow"]),
  }).strict().optional(),
  policy: z.object({
    executionMode: z.enum(["automation", "cautious", "standard"]).optional(),
    hostCapabilities: z.array(capabilityNameSchema).max(128).optional(),
    limits: z.object({
      maxDurationMs: positiveLimit.max(24 * 60 * 60 * 1_000).optional(),
      maxInputTokens: positiveLimit.max(40_000_000).optional(),
      maxModelCalls: positiveLimit.max(10_000).optional(),
      maxOutputTokens: positiveLimit.max(10_000_000).optional(),
      maxToolCalls: positiveLimit.max(100_000).optional(),
      maxTurns: positiveLimit.max(10_000).optional(),
    }).strict().optional(),
    mcpConnections: z.array(extensionRefSchema).max(64).optional(),
    skills: z.array(extensionRefSchema).max(64).optional(),
  }).strict().optional(),
  profile: z.object({
    profileId: z.string().trim().min(1).max(120),
    version: z.string().trim().min(1).max(40),
  }).strict(),
}).strict();

const inputResponseSchema = z.object({
  optionId: z.string().trim().min(1).max(512).optional(),
  requestId: z.string().trim().min(1).max(512),
  text: z.string().trim().min(1).max(65_536).optional(),
}).strict().superRefine((response, context) => {
  if (response.optionId === undefined && response.text === undefined) {
    context.addIssue({
      code: "custom",
      message: "An input response requires optionId or text.",
    });
  }
});

const respondSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/),
  inputResponses: z.array(inputResponseSchema).min(1).max(16),
}).strict();

export type ParsedStartAgentRun = StartAgentRunRequest & { readonly correlationId: string };
export type ParsedRespondAgentRun = RespondAgentRunRequest & {
  readonly inputResponses: readonly AgentRunInputResponse[];
};

export function parseStartAgentRun(
  value: unknown,
  config: AgentRuntimeConfigSnapshot = DEFAULT_AGENT_RUNTIME_CONFIG,
):
  | { readonly ok: true; readonly value: ParsedStartAgentRun }
  | { readonly error: string; readonly ok: false } {
  const schema = startSchema.superRefine((candidate, context) => {
    if (!isAgentProfileForConfig(config, candidate.profile)) {
      context.addIssue({
        code: "custom",
        path: ["profile"],
        message: `The profile must be ${config.profile.id}@${config.profile.version}.`,
      });
    }
  });
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { error: "The AgentRun request does not match contract 0.1.0-draft.", ok: false };
  }
  for (const [name, candidate] of [
    ["clientContext", parsed.data.clientContext],
    ["metadata", parsed.data.metadata],
    ["outputSchema", parsed.data.outputSchema],
  ] as const) {
    if (candidate !== undefined && !isJsonObject(candidate, MAX_JSON_BYTES)) {
      return { error: `${name} must be a JSON object no larger than 64 KiB.`, ok: false };
    }
  }

  try {
    const policy = resolveAgentRunPolicy(
      parsed.data.profile,
      parseAgentRunPolicy(parsed.data.policy ?? {}),
      undefined,
      config,
    );
    return {
      ok: true,
      value: {
        ...parsed.data,
        clientContext: parsed.data.clientContext as Readonly<Record<string, JsonValue>> | undefined,
        correlationId: parsed.data.correlationId ?? `corr_${randomUUID()}`,
        metadata: parsed.data.metadata as Readonly<Record<string, JsonValue>> | undefined,
        outputSchema: parsed.data.outputSchema as Readonly<Record<string, JsonValue>> | undefined,
        policy,
      },
    };
  } catch {
    return { error: "The AgentRun policy requests an unavailable or invalid extension.", ok: false };
  }
}

export function requestFingerprint(request: ParsedStartAgentRun): string {
  const { correlationId: _correlationId, idempotencyKey: _idempotencyKey, ...semanticRequest } = request;
  return createHash("sha256").update(canonicalJson(semanticRequest)).digest("hex");
}

export function parseRespondAgentRun(
  value: unknown,
): { readonly ok: true; readonly value: ParsedRespondAgentRun }
  | { readonly error: string; readonly ok: false } {
  const parsed = respondSchema.safeParse(value);
  if (!parsed.success) {
    return { error: "The AgentRun input response does not match contract 0.1.0-draft.", ok: false };
  }
  const requestIds = parsed.data.inputResponses.map((response) => response.requestId);
  if (new Set(requestIds).size !== requestIds.length) {
    return { error: "inputResponses must contain unique requestId values.", ok: false };
  }
  return { ok: true, value: parsed.data };
}

export function inputResponseFingerprint(input: ParsedRespondAgentRun): string {
  return createHash("sha256")
    .update(canonicalJson([...input.inputResponses].sort((left, right) => left.requestId.localeCompare(right.requestId))))
    .digest("hex");
}

function isJsonObject(value: unknown, maximumBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized) > maximumBytes) return false;
    const parsed = JSON.parse(serialized);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}
