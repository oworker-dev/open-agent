import assert from "node:assert/strict";
import test from "node:test";

import { emitStreamContent } from "../../node_modules/eve/dist/src/harness/emission.js";
import { createOrderedStreamEmitter } from "../../node_modules/eve/dist/src/harness/ordered-stream-emitter.js";
import type { SessionEvent } from "eve/client";
import { jsonSchema, type TextStreamPart, type ToolSet } from "ai";

test("Eve persists provider tool input deltas before the complete tool call", async () => {
  const events: SessionEvent[] = [];
  await emitStreamContent(
    async (event) => {
      events.push(...(Array.isArray(event) ? event : [event]) as SessionEvent[]);
    },
    {
      sequence: 0,
      sessionStarted: true,
      stepIndex: 0,
      turnId: "turn-tool-input",
      runId: "run-input",
    },
    stream([
      { id: "call-patch", toolName: "apply_patch", type: "tool-input-start" },
      { delta: '{"patch":"*** Begin Patch\\n', id: "call-patch", type: "tool-input-delta" },
      { delta: '*** End Patch"}', id: "call-patch", type: "tool-input-delta" },
      { id: "call-patch", type: "tool-input-end" },
      { toolCallId: "call-patch", toolName: "apply_patch", input: { patch: "*** Begin Patch\n*** End Patch" }, type: "tool-call" },
      { finishReason: "tool-calls", type: "finish-step", usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ] as TextStreamPart<ToolSet>[]),
    { excludedActionToolNames: new Set(), tools: new Map([["apply_patch", {
      name: "apply_patch", description: "Edit files", inputSchema: jsonSchema({ type: "object" }),
    }]]) },
  );

  const inputEvents = events.filter((event) => event.type === "call.input");
  assert.ok(inputEvents.length > 0);
  assert.equal(events.at(-1)?.type, "call.requested");
  assert.equal(inputEvents.map((event) => event.data.delta).join(""), JSON.stringify({ patch: "*** Begin Patch\n*** End Patch" }));
  assert.equal(inputEvents[0]?.data.name, "apply_patch");
});

test("adjacent provider input snapshots coalesce behind a slow durable writer", async () => {
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const events: SessionEvent[] = [];
  const emitter = createOrderedStreamEmitter(async (event) => {
    events.push(...(Array.isArray(event) ? event : [event]) as SessionEvent[]);
    if (events.length === 1) await firstBlocked;
  });

  await emitter.emit(messageEvent("Starting"));
  await emitter.emit(inputEvent("a", "a"));
  await emitter.emit(inputEvent("b", "ab"));
  releaseFirst();
  await emitter.closeAndDrain();

  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, "call.input");
  assert.equal(events[1]?.data.delta, "ab");
});

test("character-granular tool input stays near-linear with a fast durable writer", async () => {
  const events: SessionEvent[] = [];
  const emitter = createOrderedStreamEmitter(async (event) => {
    events.push(...(Array.isArray(event) ? event : [event]) as SessionEvent[]);
  });
  const input = "x".repeat(16_384);

  await emitter.emit(inputEvent("", ""));
  for (let index = 1; index <= input.length; index += 1) {
    await emitter.emit(inputEvent("x", input.slice(0, index)));
  }
  await emitter.closeAndDrain();

  const inputEvents = events.filter((event) => event.type === "call.input");
  assert.ok(inputEvents.length <= input.length + 1);
  assert.equal(inputEvents.map((event) => event.data.delta).join(""), input);
  assert.ok(
    Buffer.byteLength(JSON.stringify(inputEvents)) < input.length * 200,
    "the durable stream should grow approximately linearly with tool input",
  );
});

test("an ordering barrier flushes the latest partial input before the next event", async () => {
  const events: SessionEvent[] = [];
  const emitter = createOrderedStreamEmitter(async (event) => {
    events.push(...(Array.isArray(event) ? event : [event]) as SessionEvent[]);
  });

  await emitter.emit(inputEvent("a", "a"));
  await emitter.emit(messageEvent("After input"));
  await emitter.closeAndDrain();

  assert.deepEqual(events.map((event) => event.type), ["call.input", "content.delta"]);
  assert.equal(events[0]?.type, "call.input");
  assert.equal(events[0]?.data.delta, "a");
});

async function* stream(
  parts: readonly TextStreamPart<ToolSet>[],
): AsyncGenerator<TextStreamPart<ToolSet>> {
  yield* parts;
}

function inputEvent(delta: string, _inputTextSoFar: string): SessionEvent {
  return { type: "call.input", scope: { turnId: "turn-tool-input", runId: "run-input" }, data: { callId: "call-patch", name: "apply_patch", kind: "tool", delta } };
}

function messageEvent(delta: string): SessionEvent {
  return { type: "content.delta", scope: { turnId: "turn-tool-input", runId: "run-input" }, data: { partId: "message", kind: "text", delta } };
}
