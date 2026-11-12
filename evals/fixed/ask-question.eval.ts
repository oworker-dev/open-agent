import { defineEval } from "eve/evals";

export default [
  ...["Markdown", "Use plain text"].map((answer) => defineEval({
    description: `The official question workflow accepts ${answer === "Markdown" ? "an option" : "free text"} and resumes.`,
    tags: ["fixed", "hitl", "ask"],
    async test(t) {
      const parked = await t.send("EVAL_ASK choose an output format.");
      parked.awaitingInput();
      const interaction = parked.session.requireInteraction({ toolName: "ask_question" });
      await parked.session.respond([{ interactionId: interaction.interactionId, text: answer }]);
      t.succeeded();
      t.calledTool("ask_question", { count: 1, status: "completed" });
      t.messageIncludes(`ASK_COMPLETED {"answer":"${answer}","status":"answered"}`);
    },
  })),
  defineEval({
    description: "A host tool policy hides questions and rejects a call even if the model attempts it anyway.",
    tags: ["fixed", "hitl", "ask"],
    async test(t) {
      await t.send("EVAL_ASK_DISABLED continue without human input.", {
        headers: { "x-agent-run-policy": Buffer.from(JSON.stringify({ tools: ["web_fetch"] })).toString("base64url") },
      });
      t.succeeded();
      t.notEvent("interaction.opened");
      t.calledTool("ask_question", { count: 1, status: "rejected" });
      t.messageIncludes("ASK_DENIED_WITHOUT_INTERACTION");
    },
  }),
  defineEval({
    description: "Stopping a question withdraws it and the session accepts a new message.",
    tags: ["fixed", "hitl", "ask", "cancellation"],
    async test(t) {
      const parked = await t.send("EVAL_ASK choose an output format.");
      parked.awaitingInput();
      await parked.session.cancel();
      await parked.session.nextTurn();
      parked.session.event("turn.settled", { data: { outcome: "cancelled" } });
      const next = await parked.session.send("EVAL_COMPACTION_FILL continue after cancellation.");
      next.messageIncludes("COMPACTION_FILL_ACK");
      next.succeeded();
    },
  }),
];
