import { defineEval } from "eve/evals";

export default defineEval({
  description: "Parks an external-side-effect Shell command for durable human approval before execution.",
  tags: ["fixed", "hitl", "sandbox"],
  async test(t) {
    const parked = await t.send("EVAL_APPROVAL run the requested cleanup command.");
    parked.parked();
    t.requireInputRequest({ toolName: "bash" });

    await t.respondAll("approve");
    t.succeeded();
    t.calledTool("bash", {
      input: { command: /git push/u },
      output: /APPROVED/u,
      status: "completed",
      count: 1,
    });
    t.messageIncludes("APPROVAL_COMPLETED");
  },
});
