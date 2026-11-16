import { defineHook } from "eve/hooks";
import { call, children } from "eve/events";
import { sessionOwnerFromAuth } from "../lib/session-ownership-auth";
import { createPostgresAgentSubagentStoreFromEnvironment } from "../../server/data/agent-subagent-store";

const store = createPostgresAgentSubagentStoreFromEnvironment();

export default defineHook({
  events: {
    async "child.opened"(event, ctx) {
      const auth = ctx.session.auth.initiator ?? ctx.session.auth.current;
      if (!store || !auth || typeof auth.attributes.tenantId !== "string") return;
      const child = children(ctx.view).find((entry) => entry.sessionId === event.data.sessionId);
      const invocation = child?.callId ? call(ctx.view, child.callId) : undefined;
      const input = invocation?.input as { message?: unknown; nickname?: unknown } | undefined;
      try {
        await store.create({
          owner: sessionOwnerFromAuth(auth),
          parentSessionId: ctx.session.id,
          childSessionId: event.data.sessionId,
          ...(child?.callId ? { callId: child.callId } : {}),
          name: event.data.name,
          ...(typeof input?.nickname === "string" ? { nickname: input.nickname } : {}),
          ...(typeof input?.message === "string" ? { task: input.message } : {}),
          status: "running",
        });
      } catch {
        // A projection outage must not fail an otherwise healthy agent turn.
        console.warn("Sub-agent registration failed", { parentSessionId: ctx.session.id, childSessionId: event.data.sessionId });
      }
    },
  },
});
