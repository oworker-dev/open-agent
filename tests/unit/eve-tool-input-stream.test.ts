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
  assert.equal(inputEvents.length, 1);
  assert.equal(inputEvents[0]?.data.inputTextDelta, '{"patch":"*** Begin Patch\\n*** End Patch"}');
  assert.deepEqual(inputEvents[0]?.data.input, {
    patch: "*** Begin Patch\n*** End Patch",
  });
  assert.equal(inputEvents[0]?.data.toolName, "apply_patch");
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

  await emitter.emit(messageEvent("Starting"));
  await emitter.emit(inputEvent("a", "a"));
  await emitter.emit(inputEvent("b", "ab"));
  releaseFirst();
  await emitter.closeAndDrain();

  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, "action.input.partial");
  assert.equal(events[1]?.data.inputTextDelta, "ab");
  assert.equal(events[1]?.data.inputTextSoFar, "ab");
});

test("character-granular tool input stays near-linear with a fast durable writer", async () => {
  const events: MessageStreamEvent[] = [];
  const emitter = createOrderedStreamEmitter(async (event) => {
    events.push(event as MessageStreamEvent);
  });
  const input = "x".repeat(16_384);

  await emitter.emit(inputEvent("", ""));
  for (let index = 1; index <= input.length; index += 1) {
    await emitter.emit(inputEvent("x", input.slice(0, index)));
  }
  await emitter.closeAndDrain();

  const inputEvents = events.filter((event) => event.type === "action.input.partial");
  assert.ok(inputEvents.length < 80, `expected fewer than 80 snapshots, received ${inputEvents.length}`);
  assert.equal(inputEvents.at(-1)?.data.inputTextSoFar, input);
  assert.equal(inputEvents.map((event) => event.data.inputTextDelta).join(""), input);
  assert.ok(
    Buffer.byteLength(JSON.stringify(inputEvents)) < input.length * 20,
    "the durable stream should grow approximately linearly with tool input",
  );
});

test("an ordering barrier flushes the latest partial input before the next event", async () => {
  const events: MessageStreamEvent[] = [];
  const emitter = createOrderedStreamEmitter(async (event) => {
    events.push(event as MessageStreamEvent);
  });

  await emitter.emit(inputEvent("a", "a"));
  await emitter.emit(messageEvent("After input"));
  await emitter.closeAndDrain();

  assert.deepEqual(events.map((event) => event.type), ["action.input.partial", "message.appended"]);
  assert.equal(events[0]?.type, "action.input.partial");
  assert.equal(events[0]?.data.inputTextSoFar, "a");
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

function messageEvent(message: string): MessageStreamEvent {
  return {
    data: {
      messageDelta: message,
      messageSoFar: message,
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-tool-input",
    },
    meta: { at: "2026-08-17T00:00:00.000Z", id: `message-${message}` },
    type: "message.appended",
  };
}
