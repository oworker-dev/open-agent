import { receivedClientMessageId } from "./thread-storage.js";
import { conversationOf } from "eve/client";
import { conversation } from "eve/events";
export function projectConversationMessages(messages, events, pendingEdit) {
    const accepted = pendingEdit && events.some((event) => event.type === "delivery.consumed" && receivedClientMessageId(event) === pendingEdit.clientMessageId);
    const target = pendingEdit && !accepted ? events.find((event) => event.type === "turn.started" && event.data.turnId === pendingEdit.beforeTurnId) : undefined;
    const selectedEvents = target ? events.filter((event) => event.meta.position.line < target.meta.position.line) : events;
    const view = conversationOf(selectedEvents).view;
    const selected = new Set(conversation(view).map((turn) => turn.turnId));
    const importedIds = new Set(selectedEvents.flatMap((event) => event.type === "delivery.consumed" && selected.has(event.data.turnId)
        ? (event.data.history ?? []).map((_item, index) => `${event.data.deliveryId}:imported:${index}`)
        : []));
    const originals = new Map(messages.map((message) => [message.id, message]));
    const seen = new Set();
    return messages.flatMap((message) => {
        if (!message.metadata?.optimistic && !importedIds.has(message.id) &&
            (!message.metadata?.turnId || !selected.has(message.metadata.turnId)))
            return [];
        let rendered = message;
        const visited = new Set();
        while (rendered.metadata?.historyId && !visited.has(rendered.id)) {
            visited.add(rendered.id);
            const original = originals.get(rendered.metadata.historyId);
            if (!original || original.role !== rendered.role)
                break;
            rendered = original;
        }
        if (seen.has(rendered.id))
            return [];
        seen.add(rendered.id);
        return [rendered];
    });
}
//# sourceMappingURL=conversation-messages.js.map