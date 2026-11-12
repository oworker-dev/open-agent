import { defineEval } from "eve/evals";

export default [
  defineEval({
    description: "An empty host tool grant omits every optional tool, including provider search.",
    tags: ["fixed", "tool-policy"],
    async test(t) {
      await t.send("EVAL_TOOL_POLICY EMPTY", {
        headers: { "x-agent-run-policy": Buffer.from(JSON.stringify({ tools: [] })).toString("base64url") },
      });
      t.succeeded();
      t.messageIncludes("TOOL_POLICY_EMPTY");
      t.notEvent("interaction.opened");
    },
  }),
  defineEval({
    description: "Forced ordinary, workflow, child and indirect calls cannot bypass the host grant.",
    tags: ["fixed", "tool-policy"],
    async test(t) {
      await t.send("EVAL_TOOL_POLICY FORCED", {
        headers: { "x-agent-run-policy": Buffer.from(JSON.stringify({ tools: ["record_checkpoint"] })).toString("base64url") },
      });
      t.succeeded();
      t.messageIncludes("TOOL_POLICY_ENFORCED");
      t.notEvent("interaction.opened");
      t.calledTool("record_checkpoint", { count: 1, status: "completed" });
      for (const name of ["bash", "write_file", "ask_question", "agent"]) {
        t.notCalledTool(name);
      }
    },
  }),
];
