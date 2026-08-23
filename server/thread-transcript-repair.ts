import type { MessageStreamEvent } from "eve/client";
import {
  appendThreadEventIndexed,
  compactThreadEvents,
} from "@oworker/open-agent-ui/agent-workspace";

export type RebuiltThreadTranscript = {
  readonly endIndex: number;
  readonly events: readonly MessageStreamEvent[];
};

/**
 * Projects Eve's append-only stream into the compact UI transcript while
 * retaining its absolute cursor. The expected end is authoritative: repair
 * must fail instead of checkpointing a silently truncated response as full
 * coverage.
 */
export async function rebuildSettledThreadTranscript(
  source: AsyncIterable<MessageStreamEvent>,
  expectedEndIndex: number,
): Promise<RebuiltThreadTranscript> {
  assertExpectedEndIndex(expectedEndIndex);
  const events: MessageStreamEvent[] = [];
  const eventIds = new Set<string>();
  let endIndex = 0;

  for await (const event of source) {
    appendThreadEventIndexed(events, eventIds, event);
    endIndex += 1;
  }

  if (endIndex !== expectedEndIndex) {
    throw new ThreadTranscriptCoverageError(expectedEndIndex, endIndex);
  }
  return {
    endIndex,
    // The server transcript is the durable audit history. Keep lifecycle
    // boundaries and failed tool attempts here; the UI applies its settled
    // projection when rendering and must not turn a display cleanup into data
    // loss during repair.
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
