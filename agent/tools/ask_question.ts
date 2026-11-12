import { defineWorkflowTool } from "eve/tools";
import { askQuestion } from "eve/tools/ask_question";
import { askQuestionApproval } from "../lib/ask-question-policy.ts";

export default defineWorkflowTool({
  ...askQuestion,
  approval: askQuestionApproval,
});
