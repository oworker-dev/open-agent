import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const FILLER = "context-evidence ".repeat(600);

export default defineEval({
  description:
    "Compacts a durable long-running session repeatedly without losing facts, todo state, sandbox state, or write safety.",
  tags: ["fixed", "compaction", "continuation", "sandbox"],
  timeoutMs: 60_000,
  async test(t) {
    const setup = await t.send(
      "EVAL_COMPACTION_SETUP remember exact facts CERULEAN-47 and ORBIT-73, the active todo, and the workspace file.",
    );
    setup.messageIncludes("COMPACTION_SETUP_COMPLETED");

    let fillIndex = 0;
    while (compactionCount(setup.session.events) < 1 && fillIndex < 12) {
      fillIndex += 1;
      const turn = await setup.session.send(`EVAL_COMPACTION_FILL ${fillIndex} ${FILLER}`);
      await t.require(turn.sessionId, equals(setup.sessionId));
    }

    const mutation = await setup.session.send(
      "EVAL_COMPACTION_MUTATE update the workspace fact only after satisfying write safety, then inspect the todo.",
    );
    await t.require(mutation.sessionId, equals(setup.sessionId));
    mutation.messageIncludes("COMPACTION_MUTATION_COMPLETED");

    while (compactionCount(setup.session.events) < 2 && fillIndex < 24) {
      fillIndex += 1;
      const turn = await setup.session.send(`EVAL_COMPACTION_FILL ${fillIndex} ${FILLER}`);
      await t.require(turn.sessionId, equals(setup.sessionId));
    }

    const verified = await setup.session.send(
      "EVAL_COMPACTION_VERIFY prove the checkpoint, active todo, and workspace facts survived.",
    );
    await t.require(verified.sessionId, equals(setup.sessionId));

    t.succeeded();
    t.event("context.started", { data: { kind: "compaction" }, count: (count) => count >= 2 });
    t.event("context.settled", { data: { kind: "compaction", outcome: "completed" }, count: (count) => count >= 2 });
    t.eventsSatisfy("every requested compaction completed in the same session", (events) => {
      const requested = events.filter((event) => event.type === "context.started" && event.data.kind === "compaction");
      const completed = events.filter((event) => event.type === "context.settled" && event.data.kind === "compaction" && event.data.outcome === "completed");
      return requested.length === completed.length && requested.every(
        (event) => event.type === "context.started" && completed.some((settled) => settled.type === "context.settled" && settled.data.changeId === event.data.changeId),
      );
    });
    t.notEvent("session.ended", { data: { outcome: "failed" } });
    t.calledTool("write_file", {
      input: { content: "CERULEAN-47 ORBIT-73 BETA-91\n" },
      status: "failed",
      count: 1,
    });
    t.calledTool("write_file", {
      input: { content: "CERULEAN-47 ORBIT-73 BETA-91\n" },
      status: "completed",
      count: 1,
    });
    t.calledTool("todo", { count: 3, status: "completed" });
    t.messageIncludes("COMPACTION_VERIFIED CERULEAN-47 ORBIT-73 BETA-91 TODO_PRESERVED");
  },
});

function compactionCount(events: readonly import("eve/client").SessionStreamEvent[]): number {
  return events.filter((event) => event.type === "context.settled" && event.data.kind === "compaction" && event.data.outcome === "completed").length;
}
