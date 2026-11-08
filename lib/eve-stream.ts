import type { SessionStreamEvent } from "eve/client";

/** Exclusive coverage of a complete v27 source line; never an event count. */
export function eveEventCursor(event: SessionStreamEvent): number {
  return event.meta.endOfLine === false
    ? event.meta.position.line
    : event.meta.next ?? event.meta.position.line + 1;
}

export function eveEventsCursor(events: readonly SessionStreamEvent[], startIndex = 0): number {
  return events.reduce((cursor, event) => Math.max(cursor, eveEventCursor(event)), startIndex);
}
