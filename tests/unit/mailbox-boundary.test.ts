import assert from "node:assert/strict";
import test from "node:test";
import type { SessionReader } from "eve/sessions";
import type { SessionStreamEvent } from "eve/client";
import { inspectMailboxBoundary, MailboxBoundaryInspectionTimeoutError } from "../../agent/lib/mailbox-boundary.ts";
import { line, reply, startTurn } from "../helpers/session-events.ts";

function reader(id: string, events: readonly SessionStreamEvent[], onRead?: (index: number) => void): SessionReader {
  return { id, async *stream(options) {
    onRead?.(options?.startIndex ?? 0);
    assert.equal(options?.follow, false);
    for (const event of events) if (event.meta.position.line >= (options?.startIndex ?? 0)) yield event;
  } };
}

test("mailbox inspection folds complete multi-fact commits and resumes by source line", async () => {
  const events = [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "t", "d", "Run"), ...reply(4, "t", "d", "Done")];
  const starts: number[] = [];
  const source = reader("boundary-resume", events, (start) => starts.push(start));
  assert.deepEqual(await inspectMailboxBoundary(source), { state: "waiting", tailIndex: 4 });
  assert.deepEqual(await inspectMailboxBoundary(source), { state: "waiting", tailIndex: 4 });
  assert.deepEqual(starts, [0, 5]);
});

test("delivery settlement does not declare idleness while the turn is active", async () => {
  const events = [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "t", "d", "Run"), ...line(4, { type: "delivery.settled", data: { deliveryId: "d", turnId: "t", outcome: "awaiting-input" } })];
  const result = await inspectMailboxBoundary(reader("boundary-busy", events));
  assert.equal(result.state, "running");
  assert.equal(result.state === "running" && result.turnId, "t");
});

test("a read deadline also bounds a reader that ignores its abort signal", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(inspectMailboxBoundary({ id: "boundary-timeout", stream(options) {
    signal = options?.signal;
    return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } };
  } }, 20), MailboxBoundaryInspectionTimeoutError);
  assert.equal(signal?.aborted, true);
});

test("a failed partial read never contaminates the cached committed boundary", async () => {
  const base = line(0, { type: "session.started", data: {} });
  const commit = startTurn(1, "t", "d", "Run");
  const source = reader("boundary-partial", base);
  await inspectMailboxBoundary(source);
  const partial = reader(source.id, [...base, ...commit.slice(0, 2)]);
  await assert.rejects(inspectMailboxBoundary(partial), /inside a commit/);
  let start: number | undefined;
  assert.equal((await inspectMailboxBoundary(reader(source.id, [...base, ...commit], (value) => { start = value; }))).state, "running");
  assert.equal(start, 1);
});

test("terminal state and missing history remain distinct from an idle live session", async () => {
  const events = [...line(0, { type: "session.started", data: {} }), ...line(1, { type: "session.ended", data: { outcome: "failed", error: { code: "FAIL", message: "Unavailable" } } })];
  assert.deepEqual(await inspectMailboxBoundary(reader("boundary-terminal", events)), { state: "terminal", tailIndex: 1, terminalStatus: "failed" });
  await assert.rejects(inspectMailboxBoundary(reader("boundary-missing", [])), /no recorded history/);
});
