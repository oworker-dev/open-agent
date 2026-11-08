import { defineEval } from "eve/evals";

export default defineEval({
  description: "Cancels an in-flight sandbox command and reaches the durable cancellation boundary.",
  tags: ["fixed", "cancellation", "sandbox"],
  timeoutMs: 45_000,
  async test(t) {
    const session = await t.session();
    const live = await session.start("EVAL_CANCEL keep the sandbox command active.");
    await live.waitForEvent("call.requested");
    await live.cancel();
    const turn = await live.result();
    turn.eventOrder([
      { type: "turn.settled", data: { outcome: "cancelled" } },
      { type: "delivery.settled" },
    ]);
  },
});
