import {
  AGENT_REASONING_LEVELS,
  type AgentReasoningLevel,
} from "@oworker/open-agent-contracts/runtime-config";
import {
  DEFAULT_AGENT_RUNTIME_CONFIG,
} from "./agent-runtime-config.ts";

export { AGENT_REASONING_LEVELS };
export type { AgentReasoningLevel };

export const DEFAULT_CONTEXT_WINDOW_TOKENS =
  DEFAULT_AGENT_RUNTIME_CONFIG.models[0]!.contextWindowTokens;
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS =
  DEFAULT_AGENT_RUNTIME_CONFIG.models[0]!.maxOutputTokens;
const DEFAULT_AGENT_OUTPUT_BUDGET_TOKENS = 4_096;

export function readAgentModelMaxOutputTokens(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const configured = environment.AGENT_MODEL_MAX_OUTPUT_TOKENS?.trim();
  if (!configured) {
    return Math.min(DEFAULT_MODEL_MAX_OUTPUT_TOKENS, DEFAULT_AGENT_OUTPUT_BUDGET_TOKENS);
  }
  const tokens = Number(configured);
  if (!Number.isInteger(tokens) || tokens < 256 || tokens > 128_000) {
    throw new Error(
      "AGENT_MODEL_MAX_OUTPUT_TOKENS must be an integer from 256 to 128000.",
    );
  }
  return tokens;
}

export function readAgentEvalContextWindowTokens(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const configured = environment.AGENT_EVAL_CONTEXT_WINDOW_TOKENS?.trim();
  if (!configured) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  const tokens = Number(configured);
  if (!Number.isInteger(tokens) || tokens < 2_048 || tokens > 2_000_000) {
    throw new Error(
      "AGENT_EVAL_CONTEXT_WINDOW_TOKENS must be an integer from 2048 to 2000000.",
    );
  }
  return tokens;
}
