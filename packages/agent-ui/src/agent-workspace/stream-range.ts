import type { ClientSession, SessionStreamEvent } from "eve/client";

/** Read whole source lines. A line can contain any number of atomic facts. */
export async function readCommittedRange(
  session: Pick<ClientSession, "stream">,
  startIndex: number,
  endIndex: number,
  signal: AbortSignal,
): Promise<readonly SessionStreamEvent[]> {
  if (endIndex <= startIndex) return [];
  const events: SessionStreamEvent[] = [];
  let completeLength = 0;
  for await (const event of session.stream({
    follow: false, signal, startIndex, streamReconnectPolicy: { reconnect: false },
  })) {
    if (event.meta.position.line >= endIndex) break;
    events.push(event);
    if (event.meta.endOfLine !== false) {
      completeLength = events.length;
      if ((event.meta.next ?? event.meta.position.line + 1) >= endIndex) break;
    }
  }
  // A disconnected transport can end halfway through a commit. Re-read that
  // line next time instead of persisting an apparently complete fragment.
  return events.slice(0, completeLength);
}
