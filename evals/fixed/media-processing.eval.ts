import { defineEval } from "eve/evals";

export default defineEval({
  description: "Renders an image, encodes a video, validates it, and publishes the media artifact.",
  tags: ["fixed", "sandbox", "media", "artifact", "delivery"],
  async test(t) {
    await t.send("EVAL_MEDIA_PROCESSING render and deliver the media fixture.");
    t.succeeded();
    t.toolOrder(["write_file", "bash", "publish_artifact"]);
    t.calledTool("publish_artifact", {
      input: { filename: "preview.mp4", path: "/workspace/preview.mp4" },
      output: {
        filename: "preview.mp4",
        kind: "artifact",
        mediaType: "video/mp4",
        url: /\/api\/artifacts\/art_/u,
      },
      status: "completed",
      count: 1,
    });
    t.messageIncludes("MEDIA_PROCESSING_PUBLISHED");
    t.noFailedCalls();
  },
});
