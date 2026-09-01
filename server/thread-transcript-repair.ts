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
    // Eve remains the append-only audit source. The thread store is the
    // logical UI transcript, so an edit boundary removes the superseded turn
    // while the absolute Eve cursor above continues to cover the full stream.
    events: compactThreadEvents(projectEditedBranches(events)),
  };
}

/**
 * Applies Open Agent's edit semantics to a complete Eve audit stream.
 *
 * New edit boundaries address the superseded turn exactly. Legacy Open Agent
 * clear() events carried a clear-turn id instead, so they fall back to the
 * immediately preceding user turn. Processing boundaries in order also
 * handles repeated edits without deleting the earlier retained prefix.
 */
export function projectEditedBranches(
  events: readonly MessageStreamEvent[],
): readonly MessageStreamEvent[] {
  const projected: MessageStreamEvent[] = [];

  for (const event of events) {
    if (event.type === "context.cleared") {
      const targetTurnId = event.data.turnId;
      // Server-owned edits can retry the same exact target. Replace the
      // earlier branch before projecting the new one so repaired transcripts
      // cannot expose each retry as an independent interaction.
      const previousClearIndex = projected.findLastIndex((candidate) =>
        candidate.type === "context.cleared" && candidate.data.turnId === targetTurnId,
      );
      if (previousClearIndex >= 0) projected.splice(previousClearIndex);
      let userIndex = projected.findLastIndex((candidate) =>
        candidate.type === "message.received" && candidate.data.turnId === targetTurnId
      );
      // Once an exact marker has already established this target's branch,
      // its original user turn is intentionally gone from the projection.
      // Do not apply the legacy positional fallback in that case, or a
      // repeated exact edit would remove the preceding valid turn as well.
      if (userIndex < 0 && previousClearIndex < 0) {
        userIndex = projected.findLastIndex((candidate) => candidate.type === "message.received");
      }
      if (userIndex >= 0) {
        const userEvent = projected[userIndex];
        const turnId = userEvent?.type === "message.received" ? userEvent.data.turnId : undefined;
        const turnStartIndex = turnId
          ? projected.findLastIndex((candidate, index) =>
              index <= userIndex && candidate.type === "turn.started" && candidate.data.turnId === turnId
            )
          : -1;
        projected.splice(turnStartIndex >= 0 ? turnStartIndex : userIndex);
      }
    }
    projected.push(event);
  }

  return projected;
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
