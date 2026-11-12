import type { LanguageModelMiddleware } from "ai";
import type { ApprovalPolicy } from "eve/tools/approval";
import { readAgentRunPolicy } from "./run-policy.ts";

type PolicyContext = Parameters<typeof readAgentRunPolicy>[0];

export function isAskQuestionEnabled(ctx: PolicyContext): boolean {
  const tools = readAgentRunPolicy(ctx).tools;
  return tools === undefined || tools.includes("ask_question");
}

// Eve 0.85 requires static workflow tools. Gate the official executor using
// its approval policy, including calls through the tool catalog.
export const askQuestionApproval: ApprovalPolicy = (ctx) =>
  isAskQuestionEnabled(ctx)
    ? "not-applicable"
    : { type: "denied", reason: "ask_question is disabled by this session's tool policy." };

// Also omit the schema from provider requests in disabled sessions.
export const withoutAskQuestion: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams: async ({ params }) => ({
    ...params,
    tools: params.tools?.filter((tool) => tool.name !== "ask_question"),
    ...(params.toolChoice?.type === "tool" && params.toolChoice.toolName === "ask_question"
      ? { toolChoice: { type: "auto" as const } }
      : {}),
  }),
};
