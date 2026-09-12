import { defaultDeliverResult, type Channel, type ChannelAdapter } from "eve/channels";
import type { AgentMailboxStore } from "../../server/data/agent-mailbox-store.ts";

/** Eve's inbound adapter runs in the durable step, before the harness rewind. */
export function withMailboxEditAdmission(
  channel: Channel,
  store: Pick<AgentMailboxStore, "consumeEdit">,
): Channel {
  const compiled = channel as Channel & { readonly adapter: ChannelAdapter };
  const adapter = compiled.adapter;
  if (!adapter || adapter.kind !== "http") throw new Error("The canonical Eve HTTP adapter is required.");
  return {
    ...compiled,
    adapter: {
      ...adapter,
      async deliver(payload, ctx) {
        const auth = ctx.session.auth.current;
        const itemId = auth?.authenticator === "agent-mailbox-dispatch"
          ? auth.attributes.agentMailboxItemId
          : undefined;
        if (payload.revert && typeof itemId === "string") {
          const revert = payload.revert;
          if (typeof revert !== "object" || !("beforeTurnId" in revert) || !("clientMessageId" in revert) ||
              typeof revert.beforeTurnId !== "string" || typeof revert.clientMessageId !== "string") {
            throw new Error("The edit delivery identity is invalid.");
          }
          const tenantId = auth?.attributes.tenantId;
          if (typeof tenantId !== "string" || !auth) throw new Error("The edit delivery owner is missing.");
          const allowed = await store.consumeEdit({
            beforeTurnId: revert.beforeTurnId,
            clientMessageId: revert.clientMessageId,
            itemId,
            owner: { tenantId, principalId: auth.principalId, principalType: auth.principalType },
            sessionId: ctx.session.id,
          });
          if (!allowed) return;
        }
        return adapter.deliver ? adapter.deliver(payload, ctx) : defaultDeliverResult(payload);
      },
    },
  } as Channel & { readonly adapter: ChannelAdapter };
}
