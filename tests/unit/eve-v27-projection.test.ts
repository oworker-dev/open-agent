import assert from "node:assert/strict";
import test from "node:test";
import { conversationOf } from "eve/client";
import { compactThreadEvents, appendThreadEventIndexed } from "../../packages/agent-ui/dist/agent-workspace/thread-storage.js";
import { line, startTurn, reply } from "../helpers/session-events.ts";

test("v27 live and persisted replay preserve text, reasoning, and all source positions", () => {
  const source = [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "turn", "delivery", "你好"),
    ...line(4, { type: "content.delta", scope: { turnId: "turn", runId: "turn:run" }, data: { partId: "reason", kind: "reasoning", delta: "思考中" } }),
    ...line(5, { type: "content.completed", scope: { turnId: "turn" }, data: { partId: "reason", runId: "turn:run", kind: "reasoning", phase: "narration", value: "思考中" } }),
    ...reply(6, "turn", "delivery", "你好世界")];
  const saved = compactThreadEvents(source);
  assert.equal(saved.length, source.length);
  assert.deepEqual(conversationOf(saved), conversationOf(source));
  const replayed: typeof source = []; const identities = new Set<string>();
  for (const event of [...source, ...source]) appendThreadEventIndexed(replayed, identities, event);
  assert.deepEqual(conversationOf(replayed), conversationOf(source));
  assert.deepEqual(compactThreadEvents(saved), saved);
});

test("abandoned retry attempts stay in the audit log and are omitted by Eve's display projector", () => {
  const source = [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "turn", "delivery", "Run"), ...line(4,
    { type: "call.requested", scope: { turnId: "turn" }, data: { callId: "partial", owner: { runId: "turn:run" }, capability: { kind: "tool", name: "bash" }, input: {} } },
    { type: "call.settled", scope: { turnId: "turn" }, data: { callId: "partial", outcome: "abandoned" } })];
  assert.deepEqual(compactThreadEvents(source), source);
  assert.equal(conversationOf(source).messages.flatMap((message) => message.parts).some((part) => part.type === "tool"), false);
});
