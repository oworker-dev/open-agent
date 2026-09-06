import { defineTool } from "eve/tools";
import { bash } from "eve/tools/defaults";

import {
  bashApprovalDecision,
  readBashApprovalMode,
} from "../../lib/bash-approval-policy.ts";
import { readAgentSandboxCommandTimeoutMs } from "../../lib/production-config.ts";
import { withSandboxCommandTimeout } from "../../lib/sandbox-command-timeout.ts";
import { readAgentExecutionMode } from "../lib/run-policy.ts";

export default defineTool({
  ...bash,
  execute(input, ctx) {
    return withSandboxCommandTimeout({
      execute: async (signal) => await bash.execute(input, { ...ctx, abortSignal: signal }),
      parentSignal: ctx.abortSignal,
      timeoutMs: readAgentSandboxCommandTimeoutMs(),
    });
  },
  approval: ({ session, toolInput }) =>
    bashApprovalDecision({
      actorType: session.auth.current?.attributes.actorType,
      command:
        toolInput && typeof toolInput === "object" && "command" in toolInput
          ? toolInput.command
          : undefined,
      executionMode: readAgentExecutionMode({ session }),
      mode: readBashApprovalMode(),
      principalType: session.auth.current?.principalType,
    }),
});
