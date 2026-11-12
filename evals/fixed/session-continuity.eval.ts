import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "Persists sandbox work and conversation identity across durable turns.",
  tags: ["fixed", "continuation", "sandbox"],
  async test(t) {
    const first = await t.send("EVAL_CONTEXT_STORE remember the fixture value.");
    first.messageIncludes("CONTEXT_STORED");

    const second = await first.session.send("EVAL_CONTEXT_RECALL read the remembered fixture value.");
    await t.require(second.sessionId, equals(first.sessionId));
    t.succeeded();
    t.toolOrder(["write_file", "read_file"]);
    t.messageIncludes("CONTEXT_RECALLED marigold");
  },
});
