import { defineDynamic, defineTool } from "eve/tools";

import {
  listHostCapabilities,
  rememberHostCapabilities,
  shouldExposeHostCapabilities,
} from "../lib/host-capabilities";

const tool = defineTool({
  description:
    "List the capabilities explicitly exposed by the authenticated host for this Agent session. Discover the active contract before invoking a host capability.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const capabilities = await listHostCapabilities(ctx);
    rememberHostCapabilities(capabilities);
    return {
      capabilities,
    };
  },
});

export default defineDynamic((ctx) => shouldExposeHostCapabilities(ctx) ? tool : null);
