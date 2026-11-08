import assert from "node:assert/strict";
import test from "node:test";
import type { ClientSession, SessionStreamEvent } from "eve/client";
import { readCommittedRange } from "../../packages/agent-ui/dist/agent-workspace/stream-range.js";
import { line } from "../helpers/session-events.ts";

function reader(events: readonly SessionStreamEvent[]): Pick<ClientSession, "stream"> {
  return { async *stream() { yield* events; } };
}

test("range limits count source lines rather than facts", async () => {
  const events = line(5,
    { type: "context.started", data: { changeId: "clear", kind: "clear" } },
    { type: "context.settled", data: { changeId: "clear", kind: "clear", outcome: "completed", selects: null } },
    { type: "delivery.settled", data: { deliveryId: "clear", outcome: "applied" } },
  );
  assert.deepEqual(await readCommittedRange(reader(events), 5, 6, new AbortController().signal), events);
});

test("a truncated final commit is retried as a whole line", async () => {
  const first = line(3, { type: "delivery.admitted", data: { deliveryId: "d" } });
  const incomplete = line(4,
    { type: "turn.settled", data: { turnId: "t", outcome: "cancelled" } },
    { type: "delivery.settled", data: { deliveryId: "d", outcome: "handled", turnId: "t" } },
  ).slice(0, 1);
  assert.deepEqual(await readCommittedRange(reader([...first, ...incomplete]), 3, 5, new AbortController().signal), first);
});
