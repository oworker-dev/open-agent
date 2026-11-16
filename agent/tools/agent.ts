import agent from "eve/tools/agent";
import { z } from "zod";

// Clone all descriptors: Eve's official dispatch and root-only metadata must
// survive the schema extension, including its non-enumerable properties.
const namedAgent: typeof agent = Object.create(Object.getPrototypeOf(agent), Object.getOwnPropertyDescriptors(agent));
namedAgent.inputSchema = z.object({
  message: z.string().describe("The message to send to the agent, with everything it needs to do the work."),
  nickname: z.string().trim().min(1).max(80)
    .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), "Must not contain control characters")
    .optional()
    .describe("A short role name for a new child, such as Code review or Research. Continuing a task keeps its original name."),
});
namedAgent.description += " Give each new child a short, descriptive role name in nickname.";

export default namedAgent;
