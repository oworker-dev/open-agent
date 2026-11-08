import { defineDynamic, defineInstructions } from "eve/instructions";
import { readAgentRuntimeConfig } from "../lib/runtime-config.ts";

export default defineDynamic((ctx) => {
  const instructions = readAgentRuntimeConfig(ctx).profile.instructions;
  return instructions ? defineInstructions({ content: instructions }) : null;
});
