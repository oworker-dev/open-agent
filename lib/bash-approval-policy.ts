import type { AgentExecutionMode } from "@oworker/open-agent-contracts/agent-run";

export type BashApprovalMode = "always" | "never" | "risky";

const SANDBOX_LOCAL_COMMANDS = [
  /(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm|rmdir|shred)\b/u,
  /(?:^|[;&|]\s*)(?:dd|mkfs(?:\.[a-z0-9]+)?|fdisk|parted)\b/u,
  /(?:^|[;&|]\s*)(?:shutdown|reboot|poweroff|halt)\b/u,
  /(?:^|[;&|]\s*)(?:kill|killall|pkill)\b/u,
  /\bgit\s+(?:clean\b|reset\s+--hard|checkout\s+--|restore\b)/u,
];

const EXTERNAL_SIDE_EFFECT_COMMANDS = [
  /\bgit\s+push\b/u,
  /\bgh\s+(?:pr\s+merge|release\s+(?:create|delete)|repo\s+delete)\b/u,
  /\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish)\b/u,
  /\bdocker\s+(?:rm|rmi|system\s+prune|volume\s+(?:prune|rm)|network\s+(?:prune|rm))\b/u,
  /\bkubectl\s+(?:apply|create|delete|edit|patch|replace|rollout|scale|set)\b/u,
  /\bterraform\s+(?:apply|destroy|import|state\s+(?:mv|rm))\b/u,
  /\bpulumi\s+(?:destroy|up)\b/u,
  /\b(?:curl|wget)\b[^\n]*(?:--request|-X)\s*(?:DELETE|PATCH|POST|PUT)\b/iu,
];

export function readBashApprovalMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BashApprovalMode {
  const configured = environment.AGENT_BASH_APPROVAL_MODE?.trim() || "risky";
  if (configured !== "always" && configured !== "never" && configured !== "risky") {
    throw new Error("AGENT_BASH_APPROVAL_MODE must be always, risky, or never.");
  }
  return configured;
}

export function bashCommandNeedsApproval(command: string): boolean {
  return classifyBashCommandRisk(command) !== "none";
}

export function bashApprovalDecision(input: {
  readonly actorType?: unknown;
  readonly command?: unknown;
  readonly executionMode?: AgentExecutionMode;
  readonly mode: BashApprovalMode;
  readonly principalType?: unknown;
}): "not-applicable" | "user-approval" | { readonly type: "denied"; readonly reason: string } {
  const risk = typeof input.command === "string"
    ? classifyBashCommandRisk(input.command)
    : "none";
  const requiresApproval =
    input.executionMode === "cautious"
    || input.mode === "always"
    || (input.mode === "risky"
      && risk === "external-side-effect"
      && input.executionMode !== "automation");
  if (!requiresApproval) return "not-applicable";
  if (input.actorType === "service" || input.principalType === "runtime") {
    return {
      type: "denied",
      reason: "Unattended Agent sessions cannot approve a high-impact shell command.",
    };
  }
  return "user-approval";
}

function classifyBashCommandRisk(
  command: string,
): "external-side-effect" | "none" | "sandbox-local" {
  const normalized = command.normalize("NFKC").toLowerCase();
  if (EXTERNAL_SIDE_EFFECT_COMMANDS.some((pattern) => pattern.test(normalized))) {
    return "external-side-effect";
  }
  return SANDBOX_LOCAL_COMMANDS.some((pattern) => pattern.test(normalized))
    ? "sandbox-local"
    : "none";
}
