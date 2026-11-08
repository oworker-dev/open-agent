import { defineHook } from "eve/hooks";
import { createPostgresAgentMailboxStoreFromEnvironment } from "../../server/data/agent-mailbox-store";
import { commitMailboxReceiptWithRetry } from "../lib/mailbox-commit-retry";

const mailboxStore = createPostgresAgentMailboxStoreFromEnvironment();

export default defineHook({
  events: {
    async "delivery.consumed"(_event, ctx) {
      const auth = ctx.session.auth.current;
      const itemId = auth?.attributes.agentMailboxDispatch === "1" || auth?.authenticator === "agent-mailbox-dispatch"
        ? auth.attributes.agentMailboxItemId
        : undefined;
      if (!mailboxStore || typeof itemId !== "string" || !itemId.trim()) return;
      const item = await commitMailboxReceiptWithRetry({
        itemId,
        onRetry: ({ attempt, delayMs }) => console.warn("Mailbox commit confirmation unavailable; retrying.", {
          attempt,
          delayMs,
          sessionId: ctx.session.id,
        }),
        sessionId: ctx.session.id,
        store: mailboxStore,
      });
      if (item.cancellationRequestedAt) ctx.cancel("The user stopped this mailbox delivery before it began responding.");
    },
  },
});
