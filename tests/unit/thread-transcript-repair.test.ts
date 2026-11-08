import assert from "node:assert/strict";
import test from "node:test";
import { conversationOf, type SessionStreamEvent } from "eve/client";
import { position } from "eve/events";
import { rebuildSettledThreadTranscript, ThreadTranscriptCoverageError } from "../../server/thread-transcript-repair.ts";
import { projectConversationMessages } from "../../packages/agent-ui/dist/agent-workspace/conversation-messages.js";
import { line, reply, startTurn } from "../helpers/session-events.ts";

async function* source(events: readonly SessionStreamEvent[]) { yield* events; }
const running = () => [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "first", "d1", "Original")];

test("rebuilds a 12k-line tool transcript without losing deltas or source coverage", async () => {
  const events = running(); const count = 12_000;
  for (let index = 0; index < count; index++) events.push(...line(index + 4, { type: "call.input", scope: { turnId: "first", runId: "first:run" }, data: { callId: "patch", ...(index === 0 ? { name: "apply_patch", kind: "tool" as const } : {}), delta: "x" } }));
  events.push(...line(count + 4,
    { type: "call.requested", scope: { turnId: "first" }, data: { callId: "patch", owner: { runId: "first:run" }, capability: { kind: "tool", name: "apply_patch" }, input: { patch: "x".repeat(count) } } },
    { type: "call.settled", scope: { turnId: "first" }, data: { callId: "patch", outcome: "completed", output: "Done" } },
    { type: "model.settled", scope: { turnId: "first" }, data: { runId: "first:run", outcome: "completed" } },
    { type: "turn.settled", data: { turnId: "first", outcome: "completed" } }));
  const rebuilt = await rebuildSettledThreadTranscript(source([...events, ...events.slice(-4)]), count + 5);
  assert.equal(rebuilt.endIndex, count + 5);
  assert.equal(rebuilt.events.length, events.length);
  assert.equal(rebuilt.events.filter((event) => event.type === "call.input").length, count);
  assert.equal(position(conversationOf(rebuilt.events).view), count + 5);
  assert.ok(JSON.stringify(rebuilt.events).length < count * 350);
});

test("rejects a finite repair stream that ends before the authoritative tail", async () => {
  await assert.rejects(rebuildSettledThreadTranscript(source(line(0, { type: "session.started", data: {} })), 2),
    (error: unknown) => error instanceof ThreadTranscriptCoverageError && error.actualEndIndex === 1 && error.expectedEndIndex === 2);
});

test("a partial atomic commit is never reported as complete coverage", async () => {
  const commit = reply(4, "first", "d1", "Done");
  await assert.rejects(rebuildSettledThreadTranscript(source([...running(), ...commit.slice(0, -1)]), 5), ThreadTranscriptCoverageError);
});

test("a failed tool remains visible after a provider interruption", async () => {
  const error = { code: "MODEL_CALL_FAILED", message: "Provider stream interrupted" };
  const events = [...running(), ...line(4, { type: "call.input", scope: { turnId: "first", runId: "first:run" }, data: { callId: "patch", name: "apply_patch", kind: "tool", delta: '{"patch":"half' } }),
    ...line(5, { type: "call.requested", scope: { turnId: "first" }, data: { callId: "patch", owner: { runId: "first:run" }, capability: { kind: "tool", name: "apply_patch" }, input: { patch: "half" } } }, { type: "call.settled", scope: { turnId: "first" }, data: { callId: "patch", outcome: "failed", error } }, { type: "model.settled", scope: { turnId: "first" }, data: { runId: "first:run", outcome: "failed", error } }, { type: "turn.settled", data: { turnId: "first", outcome: "failed", error } })];
  const rebuilt = await rebuildSettledThreadTranscript(source(events), 6);
  const part = conversationOf(rebuilt.events).messages.at(-1)?.parts.find((part) => part.type === "tool");
  assert.equal(part?.state, "failed");
  assert.deepEqual(rebuilt.events, events);
});

test("repair keeps the audit log intact while the selected edit branch renders once", async () => {
  const original = [...running(), ...reply(4, "first", "d1", "Old reply")];
  const clear = line(5, { type: "context.started", data: { changeId: "clear", kind: "clear" } }, { type: "context.settled", data: { changeId: "clear", kind: "clear", outcome: "completed", selects: null } });
  const events = [...original, ...clear, ...startTurn(6, "edited", "d2", "Edited"), ...reply(9, "edited", "d2", "New reply")];
  const rebuilt = await rebuildSettledThreadTranscript(source(events), 10);
  assert.deepEqual(rebuilt.events, events);
  const { messages } = conversationOf(rebuilt.events);
  const display = projectConversationMessages(messages, rebuilt.events);
  assert.deepEqual(display.map((message) => message.id), ["d2:user", "edited:assistant"]);
});
