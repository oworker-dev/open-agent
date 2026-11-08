import { defineEval } from "eve/evals";

export default defineEval({
  description: "Completes a file, Shell, read, and checkpoint loop without a host-specific default Skill.",
  tags: ["fixed", "sandbox"],
  async test(t) {
    await t.send("EVAL_AUTONOMY_FILE complete the autonomous workspace task.");
    t.succeeded();
    t.notCalledTool("load_skill");
    t.toolOrder(["write_file", "bash", "read_file", "record_checkpoint"]);
    t.calledTool("write_file", {
      input: { filePath: "/workspace/autonomy.txt" },
      count: 1,
    });
    t.calledTool("bash", { input: { command: /^sha256sum /u }, count: 1 });
    t.calledTool("read_file", {
      input: { filePath: "/workspace/autonomy.txt" },
      count: 1,
    });
    t.noFailedCalls();
    t.messageIncludes("AUTONOMY_FILE_COMPLETED");
  },
});
