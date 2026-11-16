import { defineWorkflowTool, toolOutput, type ToolAnswer, type WorkflowToolContext } from "eve/tools";
import { parseMultiSelectAnswer } from "@oworker/open-agent-contracts";
import { z } from "zod";

const inputSchema = z.object({
  question: z.string().min(1).max(2000).describe("The focused question to show the user, with enough context to decide."),
  options: z.array(z.object({
    description: z.string().min(1).max(200),
    label: z.string().min(1).max(80),
  })).min(2).max(3).optional().describe("Two or three choices, with a short description for each. Omit for an open-ended question."),
  multiple: z.boolean().optional().default(false).describe("Set true only when the user should be able to choose more than one option."),
}).strict().superRefine((input, context) => {
  const labels = input.options?.map((option) => option.label);
  if (labels && new Set(labels).size !== labels.length) {
    context.addIssue({ code: "custom", message: "Option labels must be unique.", path: ["options"] });
  }
  if (input.multiple && !input.options?.length) {
    context.addIssue({ code: "custom", message: "Multiple selection requires options.", path: ["options"] });
  }
});

const outputSchema = z.union([
  z.object({ status: z.literal("answered"), answer: z.string() }).strict(),
  z.object({ interrupted: z.literal(true) }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);

type AskQuestionInput = z.infer<typeof inputSchema>;
type AskQuestionOutput = z.infer<typeof outputSchema>;

export async function executeAskQuestion(input: AskQuestionInput, context: WorkflowToolContext): Promise<AskQuestionOutput> {
  "use workflow";
  const options = input.options?.map(({ label, description }) => ({ id: label, label, description }));
  const answer = await context.ask({
    allowFreeform: true,
    display: options ? "select" : "text",
    ...(options ? { options } : {}),
    prompt: input.question,
  });
  return formatAnswer(input, answer);
}

export default defineWorkflowTool({
  description: [
    "Ask the user a focused question and wait for the answer. Use this only when missing information prevents good progress.",
    "Offer two or three options for a decision and omit an Other option because free text is always available.",
    "Set multiple to true only when choices are non-exclusive and the user should be able to select any combination.",
    "The result answer contains the chosen label, the user's words, or a readable list of selected labels and any additional information.",
    "If a new message interrupts the question, respond to that message instead. If input is unavailable, continue using your best judgment and state your assumption.",
  ].join("\n"),
  inputSchema,
  outputSchema,
  execute: executeAskQuestion,
  toModelOutput(output) {
    return "interrupted" in output
      ? toolOutput.text("Stopped early because a new message arrived.")
      : toolOutput.json(output);
  },
});

function formatAnswer(input: AskQuestionInput, answer: ToolAnswer): AskQuestionOutput {
  if (answer.status === "cancelled") return { interrupted: true };
  if (answer.status === "unavailable") return { status: "unavailable" };
  if (!input.multiple) return { answer: answer.optionId ?? answer.text ?? "", status: "answered" };

  const options = input.options ?? [];
  if (answer.optionId) {
    const label = options.find((option) => option.label === answer.optionId)?.label ?? answer.optionId;
    return { answer: `Selected options:\n- ${label}`, status: "answered" };
  }

  const encoded = answer.text ? parseMultiSelectAnswer(answer.text) : undefined;
  if (!encoded || encoded.optionIds.some((id) => !options.some((option) => option.label === id))) {
    return { answer: answer.text ?? "", status: "answered" };
  }

  const selectedLabels = encoded.optionIds.map((id) => options.find((option) => option.label === id)!.label);
  const sections = [
    selectedLabels.length ? `Selected options:\n${selectedLabels.map((label) => `- ${label}`).join("\n")}` : undefined,
    encoded.additionalText ? `Additional information:\n${encoded.additionalText}` : undefined,
  ].filter((section): section is string => section !== undefined);
  return { answer: sections.join("\n\n") || answer.text!, status: "answered" };
}
