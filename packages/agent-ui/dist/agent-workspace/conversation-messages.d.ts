import { type SessionStreamEvent } from "eve/client";
import type { EveMessage } from "eve/react";
export declare function projectConversationMessages(messages: readonly EveMessage[], events: readonly SessionStreamEvent[], pendingEdit?: {
    readonly beforeTurnId: string;
    readonly clientMessageId: string;
}): readonly EveMessage[];
//# sourceMappingURL=conversation-messages.d.ts.map