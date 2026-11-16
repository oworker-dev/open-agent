import { defineHook } from "eve/hooks";
import { delivery } from "eve/events";
import { createPostgresAgentMailboxStoreFromEnvironment } from "../../server/data/agent-mailbox-store";
import { commitConsumedMailboxMessage } from "../lib/mailbox-consumption.ts";

const mailboxStore = createPostgresAgentMailboxStoreFromEnvironment();

export default defineHook({
  events: {
    async "delivery.consumed"(event, ctx) {
      if (!mailboxStore) return;
      const item = await commitConsumedMailboxMessage({
        consumed: event.data,
        principal: delivery(ctx.view, event.data.deliveryId)?.principal,
        sessionId: ctx.session.id,
        store: mailboxStore,
      });
      if (item?.cancellationRequestedAt) ctx.cancel("The user stopped this mailbox delivery before it began responding.");
    },
  },
});
