import assert from "node:assert/strict";
import test from "node:test";

import { emitStreamContent } from "../../node_modules/eve/dist/src/harness/emission.js";
import { createOrderedStreamEmitter } from "../../node_modules/eve/dist/src/harness/ordered-stream-emitter.js";
import type { MessageStreamEvent } from "eve/client";
import type { TextStreamPart, ToolSet } from "ai";

test("Eve persists provider tool input deltas before the complete tool call", async () => {
  const events: MessageStreamEvent[] = [];
  await emitStreamContent(
    async (event) => {
      events.push(event as MessageStreamEvent);
    },
    {
      sequence: 0,
      sessionStarted: true,
      stepIndex: 0,
      turnId: "turn-tool-input",
    },
    stream([
      { id: "call-patch", toolName: "apply_patch", type: "tool-input-start" },
      { delta: '{"patch":"*** Begin Patch\\n', id: "call-patch", type: "tool-input-delta" },
      { delta: '*** End Patch"}', id: "call-patch", type: "tool-input-delta" },
      { id: "call-patch", type: "tool-input-end" },
      { finishReason: "tool-calls", type: "finish-step", usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ] as TextStreamPart<ToolSet>[]),
  );

  const inputEvents = events.filter((event) => event.type === "action.input.partial");
  assert.equal(inputEvents.length, 3);
  assert.equal(inputEvents[0]?.data.inputTextSoFar, "");
  assert.equal(inputEvents[1]?.data.inputTextDelta, '{"patch":"*** Begin Patch\\n');
  assert.deepEqual(inputEvents[2]?.data.input, {
    patch: "*** Begin Patch\n*** End Patch",
  });
  assert.equal(inputEvents[2]?.data.toolName, "apply_patch");
});

test("adjacent provider input snapshots coalesce behind a slow durable writer", async () => {
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const events: MessageStreamEvent[] = [];
  const emitter = createOrderedStreamEmitter(async (event) => {
    events.push(event as MessageStreamEvent);
    if (events.length === 1) await firstBlocked;
  });

  await emitter.emit(inputEvent("", ""));
  await emitter.emit(inputEvent("a", "a"));
  await emitter.emit(inputEvent("b", "ab"));
  releaseFirst();
  await emitter.closeAndDrain();

  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, "action.input.partial");
  assert.equal(events[1]?.data.inputTextDelta, "ab");
  assert.equal(events[1]?.data.inputTextSoFar, "ab");
});

async function* stream(
  parts: readonly TextStreamPart<ToolSet>[],
): AsyncGenerator<TextStreamPart<ToolSet>> {
  yield* parts;
}

function inputEvent(inputTextDelta: string, inputTextSoFar: string): MessageStreamEvent {
  return {
    data: {
      callId: "call-patch",
      inputTextDelta,
      inputTextSoFar,
      sequence: 0,
      stepIndex: 0,
      toolName: "apply_patch",
      turnId: "turn-tool-input",
    },
    meta: { at: "2026-08-17T00:00:00.000Z", id: `event-${inputTextSoFar.length}` },
    type: "action.input.partial",
  };
}
