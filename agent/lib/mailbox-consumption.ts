import { parseAssetPrompt, serializeAssetPrompt } from "@oworker/open-agent-contracts/asset";
import type { DeliveryConsumedData, Principal } from "eve/events";
import type { AgentMailboxItem, AgentMailboxStore } from "../../server/data/agent-mailbox-store.ts";
import { commitMailboxReceiptWithRetry } from "./mailbox-commit-retry.ts";

/** A same-turn steer/HITL delivery does not replace the turn's auth.current. */
export async function commitConsumedMailboxMessage(options: {
  readonly consumed: DeliveryConsumedData;
  readonly principal?: Principal;
  readonly sessionId: string;
  readonly store: Pick<AgentMailboxStore, "findByClientMessageId" | "commit">;
}): Promise<AgentMailboxItem | undefined> {
  const { principal, sessionId, store } = options;
  if (!principal) return;
  for (const part of options.consumed.parts) {
    if (part.kind !== "text") continue;
    const clientMessageId = parseAssetPrompt(part.text).clientMessageId;
    if (!clientMessageId) continue;
    const item = await store.findByClientMessageId(sessionId, clientMessageId);
    // Message markers alone are not authority. Match the authenticated delivery,
    // exact dispatched content and an admission that actually began.
    if (!item?.admissionStartedAt || item.principalId !== principal.id ||
        item.principalType !== principal.type || (item.issuer ?? "") !== (principal.issuer ?? "") ||
        item.payload.message === undefined) continue;
    const payload = parseAssetPrompt(item.payload.message);
    if (serializeAssetPrompt(payload.text, payload.assets, clientMessageId) !== part.text) continue;
    return await commitMailboxReceiptWithRetry({ itemId: item.itemId, sessionId, store });
  }
}
