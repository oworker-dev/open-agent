import type { ClientSession, SessionStreamEvent } from "eve/client";
export declare function readCommittedRange(session: Pick<ClientSession, "stream">, startIndex: number, endIndex: number, signal: AbortSignal): Promise<readonly SessionStreamEvent[]>;
//# sourceMappingURL=stream-range.d.ts.map