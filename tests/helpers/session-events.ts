import type { SessionEvent, SessionStreamEvent } from "eve/client";

/** Valid v27 source lines, including multi-fact atomic commits. */
export function line(position: number, ...facts: SessionEvent[]): SessionStreamEvent[] {
  return facts.map((fact, index) => ({
    ...fact,
    meta: {
      at: new Date(Date.UTC(2026, 9, 29, 0, 0, position)).toISOString(),
      position: { line: position, index },
      ...(index < facts.length - 1 ? { endOfLine: false } : {}),
    },
  }));
}

export function startTurn(position: number, turnId: string, deliveryId: string, text: string, follows: string | null = null) {
  return [
    ...line(position, { type: "delivery.admitted", data: { deliveryId, source: { channel: "eve" } } }),
    ...line(position + 1,
      { type: "turn.started", data: { turnId, cause: { deliveryId }, follows } },
      { type: "delivery.consumed", scope: { turnId }, data: { deliveryId, turnId, parts: [{ kind: "text", text }] } },
      { type: "model.requested", scope: { turnId }, data: { runId: `${turnId}:run`, owner: { turnId } } },
    ),
    ...line(position + 2, { type: "model.started", scope: { turnId }, data: { runId: `${turnId}:run`, modelId: "test", attempt: 0 } }),
  ];
}

export function reply(position: number, turnId: string, deliveryId: string, text: string) {
  return line(position,
    { type: "content.completed", scope: { turnId }, data: { partId: `${turnId}:reply`, runId: `${turnId}:run`, kind: "text", phase: "reply", value: text } },
    { type: "model.settled", scope: { turnId }, data: { runId: `${turnId}:run`, outcome: "completed", finishReason: "stop" } },
    { type: "turn.settled", data: { turnId, outcome: "completed", reply: [`${turnId}:reply`] } },
    { type: "delivery.settled", data: { deliveryId, turnId, outcome: "handled" } },
  );
}

/** Encode native v27 source lines for HTTP fixtures; no legacy event adapter. */
export function wireLines(events: readonly SessionStreamEvent[]): string {
  const lines: string[] = [];
  let cursor = 0;
  for (let index = 0; index < events.length;) {
    const event = events[index]!;
    const position = event.meta.position.line;
    if (position !== cursor) lines.push(JSON.stringify({ $eve: "position", next: position }));
    const group: SessionStreamEvent[] = [];
    while (index < events.length && events[index]!.meta.position.line === position) group.push(events[index++]!);
    const publications = group.map(({ meta: _meta, ...fact }) => fact);
    const progress = ["content.delta", "call.input", "call.progress"].includes(event.type);
    lines.push(JSON.stringify(progress ? { progress: publications[0] } : { at: event.meta.at, facts: publications }));
    cursor = event.meta.next ?? position + 1;
  }
  lines.push(JSON.stringify({ $eve: "stream.ended" }));
  return lines.join("\n") + "\n";
}

export function streamResponse(events: readonly SessionStreamEvent[], tail = events.at(-1)?.meta.position.line ?? -1): Response {
  return new Response(wireLines(events), { headers: {
    "content-type": "application/x-ndjson", "x-eve-stream-version": "27", "x-eve-stream-tail-index": String(tail),
  } });
}
