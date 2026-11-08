import { defineEval } from "eve/evals";

export default defineEval({
  description: "Runs a Python task and publishes its validated output as an expiring artifact.",
  tags: ["fixed", "sandbox", "python", "artifact", "delivery"],
  async test(t) {
    await t.send("EVAL_ARTIFACT_DELIVERY run the Python report task and deliver its result.");
    t.succeeded();
    t.toolOrder(["write_file", "bash", "publish_artifact"]);
    t.calledTool("publish_artifact", {
      input: { filename: "report.csv", path: "/workspace/result.csv" },
      output: {
        filename: "report.csv",
        kind: "artifact",
        mediaType: "text/csv; charset=utf-8",
        url: /\/api\/artifacts\/art_/u,
      },
      status: "completed",
      count: 1,
    });
    t.messageIncludes("ARTIFACT_DELIVERY_PUBLISHED");
    t.noFailedCalls();
  },
});
