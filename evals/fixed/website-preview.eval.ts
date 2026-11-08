import { defineEval } from "eve/evals";

export default defineEval({
  description: "Builds, validates, publishes, and returns a browser-ready static website preview.",
  tags: ["fixed", "sandbox", "website", "delivery"],
  async test(t) {
    await t.send("EVAL_WEBSITE_PREVIEW build and deliver the static website fixture.");
    t.succeeded();
    t.toolOrder(["write_file", "write_file", "bash", "publish_preview"]);
    t.calledTool("publish_preview", {
      input: { entrypoint: "index.html", root: "site" },
      output: {
        kind: "website-preview",
        fileCount: 2,
        url: /\/api\/previews\/prv_/u,
      },
      status: "completed",
      count: 1,
    });
    t.messageIncludes("WEBSITE_PREVIEW_PUBLISHED");
    t.noFailedCalls();
  },
});
