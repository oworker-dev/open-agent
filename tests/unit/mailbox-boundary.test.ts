import assert from "node:assert/strict";
import test from "node:test";
import type { MessageStreamEvent } from "eve/client";
import {
  inspectMailboxBoundary,
  MailboxBoundaryInspectionTimeoutError,
} from "../../agent/lib/mailbox-boundary.ts";

test("mailbox boundary inspection reads one absolute tail event and closes", async () => {
  let startIndex: number | undefined;
  let cancelled = false;
  const event = {
    data: { wait: "next-user-message" },
    meta: { at: "2026-08-27T00:00:00.000Z", id: "evt-waiting" },
    type: "session.waiting",
  } as MessageStreamEvent;
  const stream = new ReadableStream<MessageStreamEvent>({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      controller.enqueue(event);
    },
  });

  const boundary = await inspectMailboxBoundary({
    async getEventStream(input) {
      startIndex = input?.startIndex;
      return stream;
    },
    async getStreamTailIndex() {
      return 17;
    },
  }, 100);

  assert.deepEqual(boundary, { state: "waiting", tailIndex: 17 });
  assert.equal(startIndex, 17);
  assert.equal(cancelled, true);
});

test("mailbox boundary inspection cancels a half-open tail read at its deadline", async () => {
  let cancelled = false;
  const stream = new ReadableStream<MessageStreamEvent>({
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    inspectMailboxBoundary({
      async getEventStream() {
        return stream;
      },
      async getStreamTailIndex() {
        return 3;
      },
    }, 20),
    MailboxBoundaryInspectionTimeoutError,
  );
  assert.equal(cancelled, true);
});

test("mailbox boundary inspection shares one deadline across tail lookup and read", async () => {
  await assert.rejects(
    inspectMailboxBoundary({
      async getEventStream() {
        throw new Error("should not open after the deadline");
      },
      async getStreamTailIndex() {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 1;
      },
    }, 10),
    MailboxBoundaryInspectionTimeoutError,
  );
});
