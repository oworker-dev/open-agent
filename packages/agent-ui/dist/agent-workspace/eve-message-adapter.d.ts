import { type AppendMessage, type ThreadMessage } from "@assistant-ui/react";
import type { ClientSession } from "eve/client";
import type { EveMessage } from "eve/react";
type ConvertOptions = {
    readonly assetUrl?: (assetId: string) => string;
    readonly error?: unknown;
    readonly isRunning?: boolean;
};
export declare function convertEveMessages(messages: readonly EveMessage[], options?: ConvertOptions): ThreadMessage[];
export declare function getEveMessageContent(message: AppendMessage): Parameters<ClientSession["send"]>[0];
export {};
//# sourceMappingURL=eve-message-adapter.d.ts.map