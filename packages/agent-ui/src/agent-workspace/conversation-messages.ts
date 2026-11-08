import { receivedClientMessageId } from "./thread-storage.js";
import { conversationOf, type SessionStreamEvent } from "eve/client";
import { conversation } from "eve/events";
import type { EveMessage } from "eve/react";

/** Select render rows from the official conversation; never filter its facts. */
export function projectConversationMessages(
  messages: readonly EveMessage[],
  events: readonly SessionStreamEvent[],
  pendingEdit?: { readonly beforeTurnId: string; readonly clientMessageId: string },
): readonly EveMessage[] {
  const accepted = pendingEdit && events.some((event) =>
    event.type === "delivery.consumed" && receivedClientMessageId(event) === pendingEdit.clientMessageId,
  );
  const target = pendingEdit && !accepted ? events.find((event) =>
    event.type === "turn.started" && event.data.turnId === pendingEdit.beforeTurnId,
  ) : undefined;
  // An unconsumed edit keeps its prefix visible even while clear is settling.
  // This is only a display query; the full source log still feeds every fold.
  const selectedEvents = target ? events.filter((event) => event.meta.position.line < target.meta.position.line) : events;
  const view = conversationOf(selectedEvents).view;
  const selected = new Set(conversation(view).map((turn) => turn.turnId));
  const importedIds = new Set(selectedEvents.flatMap((event) =>
    event.type === "delivery.consumed" && selected.has(event.data.turnId)
      ? (event.data.history ?? []).map((_item, index) => `${event.data.deliveryId}:imported:${index}`)
      : [],
  ));
  const originals = new Map(messages.map((message) => [message.id, message]));
  const seen = new Set<string>();
  return messages.flatMap((message) => {
    if (!message.metadata?.optimistic && !importedIds.has(message.id) &&
        (!message.metadata?.turnId || !selected.has(message.metadata.turnId))) return [];
    // Text-only imported history names its original rich row. Restore that
    // row's tools/files for display without adding tool facts to model history.
    let rendered = message;
    const visited = new Set<string>();
    while (rendered.metadata?.historyId && !visited.has(rendered.id)) {
      visited.add(rendered.id);
      const original = originals.get(rendered.metadata.historyId);
      if (!original || original.role !== rendered.role) break;
      rendered = original;
    }
    if (seen.has(rendered.id)) return [];
    seen.add(rendered.id);
    return [rendered];
  });
}
