import assert from "node:assert/strict";
import test from "node:test";
import { defaultMessageReducer, type MessageStreamEvent } from "eve/client";
import { compactThreadEvents, appendThreadEventIndexed } from "../../packages/agent-ui/dist/agent-workspace/thread-storage.js";

function event(id: string, type: "message.appended" | "reasoning.appended", delta: string): MessageStreamEvent {
  const data = { sequence: 0, stepIndex: 0, turnId: "turn_0" };
  return type === "message.appended"
    ? { type, meta: { id, at: "2026-09-16T00:00:00Z" }, data: { ...data, messageDelta: delta } }
    : { type, meta: { id, at: "2026-09-16T00:00:00Z" }, data: { ...data, reasoningDelta: delta } };
}

test("v25 live deltas and compacted reload produce identical text and reasoning", () => {
  const source = [event("r1", "reasoning.appended", "思考"), event("r2", "reasoning.appended", "中"),
    event("m1", "message.appended", "你好"), event("m2", "message.appended", "世界")];
  const compacted = compactThreadEvents(source);
  const reducer = defaultMessageReducer();
  const reduce = (events: readonly MessageStreamEvent[]) => events.reduce(reducer.reduce, reducer.initial());
  assert.deepEqual(reduce(compacted), reduce(source));
  assert.equal(compacted.length, 2);
  assert.deepEqual(compactThreadEvents(compacted), compacted);
  const recovered: MessageStreamEvent[] = [];
  const ids = new Set<string>();
  for (const e of [...source, ...source]) appendThreadEventIndexed(recovered, ids, e);
  assert.deepEqual(reduce(recovered), reduce(source));
});

test("legacy cumulative checkpoints retain their complete text", () => {
  const last = event("legacy", "message.appended", "界");
  assert.equal(last.type, "message.appended");
  if (last.type !== "message.appended") return;
  const snapshot = { ...last, data: { ...last.data, messageSoFar: "你好世界" } };
  const reducer = defaultMessageReducer();
  assert.equal(reducer.reduce(reducer.initial(), snapshot).messages[0]?.parts.find(p=>p.type==="text")?.text, "你好世界");
});

test("completed runs form a barrier when a step emits further text", () => {
  const source: MessageStreamEvent[] = [event("a", "message.appended", "first"),
    { type: "message.completed", meta: { id: "done", at: "2026-09-16T00:00:00Z" },
      data: { sequence: 0, stepIndex: 0, turnId: "turn_0", message: "first", finishReason: "tool-calls" } },
    event("b", "message.appended", "second")];
  const reducer = defaultMessageReducer();
  assert.deepEqual(compactThreadEvents(source).reduce(reducer.reduce, reducer.initial()), source.reduce(reducer.reduce, reducer.initial()));
});
