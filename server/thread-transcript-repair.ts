import type { SessionStreamEvent } from "eve/client";
import { eveEventCursor } from "../lib/eve-stream.ts";
import {
  appendThreadEventIndexed,
  compactThreadEvents,
} from "@oworker/open-agent-ui/agent-workspace";

export type RebuiltThreadTranscript = {
  readonly endIndex: number;
  readonly events: readonly SessionStreamEvent[];
};

/**
 * Projects Eve's append-only stream into the compact UI transcript while
 * retaining its absolute cursor. The expected end is authoritative: repair
 * must fail instead of checkpointing a silently truncated response as full
 * coverage.
 */
export async function rebuildSettledThreadTranscript(
  source: AsyncIterable<SessionStreamEvent>,
  expectedEndIndex: number,
): Promise<RebuiltThreadTranscript> {
  assertExpectedEndIndex(expectedEndIndex);
  const events: SessionStreamEvent[] = [];
  const eventIds = new Set<string>();
  let endIndex = 0;

  for await (const event of source) {
    appendThreadEventIndexed(events, eventIds, event);
    endIndex = Math.max(endIndex, eveEventCursor(event));
  }

  if (endIndex !== expectedEndIndex) {
    throw new ThreadTranscriptCoverageError(expectedEndIndex, endIndex);
  }
  return {
    endIndex,
    // Retain complete commits. Branch selection belongs to the message
    // projection; removing facts here breaks deterministic replay.
    events: compactThreadEvents(events),
  };
}

export class ThreadTranscriptCoverageError extends Error {
  readonly actualEndIndex: number;
  readonly expectedEndIndex: number;

  constructor(expectedEndIndex: number, actualEndIndex: number) {
    super(`Agent transcript ended at ${actualEndIndex}; expected ${expectedEndIndex}.`);
    this.name = "ThreadTranscriptCoverageError";
    this.actualEndIndex = actualEndIndex;
    this.expectedEndIndex = expectedEndIndex;
  }
}

function assertExpectedEndIndex(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("expectedEndIndex must be a non-negative safe integer.");
  }
}
