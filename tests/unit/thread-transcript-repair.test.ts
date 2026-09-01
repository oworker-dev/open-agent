import assert from "node:assert/strict";
import test from "node:test";
import type { MessageStreamEvent } from "eve/client";

import {
  rebuildSettledThreadTranscript,
  ThreadTranscriptCoverageError,
} from "../../server/thread-transcript-repair.ts";

test("rebuilds a 12k-event transcript at its absolute cursor without retaining cumulative prefixes", async () => {
  const partialCount = 12_000;
  const expectedEndIndex = partialCount + 6;
  const rebuilt = await rebuildSettledThreadTranscript(
    largeSettledToolStream(partialCount),
    expectedEndIndex,
  );

  assert.equal(rebuilt.endIndex, expectedEndIndex);
  const partials = rebuilt.events.filter((event) => event.type === "action.input.partial");
  assert.equal(partials.length, 1);
  assert.equal(partials[0]?.data.inputTextSoFar.length, partialCount);
  assert.equal(rebuilt.events.some((event) => event.type === "action.result"), true);
  assert.equal(rebuilt.events.at(-1)?.type, "session.waiting");
  assert.ok(rebuilt.events.length < 12);
});

test("rejects a finite repair stream that closes before the authoritative tail", async () => {
  await assert.rejects(
    rebuildSettledThreadTranscript(events(event("session.started", {})), 2),
    (error: unknown) =>
      error instanceof ThreadTranscriptCoverageError &&
      error.actualEndIndex === 1 &&
      error.expectedEndIndex === 2,
  );
});

test("preserves an abandoned tool prefix in the durable failed-turn transcript", async () => {
  const turnId = "turn-failed";
  const source = events(
    event("turn.started", { sequence: 0, turnId }),
    event("step.started", { sequence: 0, stepIndex: 0, turnId }),
    event("action.input.partial", {
      callId: "call-abandoned",
      input: { patch: "half" },
      inputTextDelta: "half",
      inputTextSoFar: "half",
      sequence: 0,
      stepIndex: 0,
      toolName: "apply_patch",
      turnId,
    }),
    event("step.failed", {
      code: "provider_stream_interrupted",
      message: "Provider stream interrupted.",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("turn.failed", {
      code: "provider_stream_interrupted",
      message: "Provider stream interrupted.",
      turnId,
    }),
    event("session.waiting", {}),
  );

  const rebuilt = await rebuildSettledThreadTranscript(source, 6);

  assert.equal(rebuilt.events.some((item) => item.type === "action.input.partial"), true);
  assert.deepEqual(rebuilt.events.map((item) => item.type), [
    "turn.started",
    "step.started",
    "action.input.partial",
    "step.failed",
    "turn.failed",
    "session.waiting",
  ]);
});

test("repair preserves a reasoning anchor when Eve completes it after tool results", async () => {
  const turnId = "turn-reasoning-order";
  const source = events(
    event("turn.started", { sequence: 0, turnId }),
    event("step.started", { sequence: 0, stepIndex: 0, turnId }),
    event("reasoning.appended", {
      reasoningDelta: "Planning rebranding verification",
      reasoningSoFar: "Planning rebranding verification",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("actions.requested", {
      actions: [{ callId: "call-1", input: { command: "pwd" }, kind: "tool-call", toolName: "bash" }],
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("action.result", {
      result: { callId: "call-1", kind: "tool-result", output: "/workspace", toolName: "bash" },
      sequence: 0,
      status: "completed",
      stepIndex: 0,
      turnId,
    }),
    event("reasoning.completed", {
      reasoning: "Planning rebranding verification",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("step.completed", { finishReason: "tool-calls", sequence: 0, stepIndex: 0, turnId }),
    event("turn.completed", { turnId }),
    event("session.waiting", {}),
  );

  const rebuilt = await rebuildSettledThreadTranscript(source, 9);
  assert.deepEqual(rebuilt.events.map((item) => item.type), [
    "turn.started",
    "step.started",
    "reasoning.appended",
    "actions.requested",
    "action.result",
    "reasoning.completed",
    "step.completed",
    "turn.completed",
    "session.waiting",
  ]);
});

test("repair keeps only the final branch after repeated edits while retaining the Eve cursor", async () => {
  const source = events(
    ...settledTurn("turn-0", 0, "Hello", "Hello reply"),
    ...settledTurn("turn-1", 1, "What are you doing?", "First reply"),
    event("context.cleared", { sequence: 2, turnId: "clear-1" }),
    event("session.waiting", {}),
    ...settledTurn("turn-2", 2, "What are you doing?", "Second reply"),
    event("context.cleared", { sequence: 3, turnId: "clear-2" }),
    event("session.waiting", {}),
    ...settledTurn("turn-3", 3, "What are you doing?", "Final reply"),
  );
  const expectedEndIndex = 24;

  const rebuilt = await rebuildSettledThreadTranscript(source, expectedEndIndex);

  assert.equal(rebuilt.endIndex, expectedEndIndex);
  assert.deepEqual(
    rebuilt.events
      .filter((item) => item.type === "message.received" || item.type === "message.completed")
      .map((item) => item.type === "message.received" ? item.data.message : item.data.message),
    ["Hello", "Hello reply", "What are you doing?", "Final reply"],
  );
  assert.equal(rebuilt.events.some((item) =>
    item.type === "message.completed" && item.data.message === "First reply"
  ), false);
  assert.equal(rebuilt.events.some((item) =>
    item.type === "message.completed" && item.data.message === "Second reply"
  ), false);
});

async function* largeSettledToolStream(partialCount: number): AsyncGenerator<MessageStreamEvent> {
  const turnId = "turn-large";
  yield event("turn.started", { sequence: 0, turnId });
  yield event("step.started", { sequence: 0, stepIndex: 0, turnId });
  for (let index = 1; index <= partialCount; index += 1) {
    yield event("action.input.partial", {
      callId: "call-large",
      input: { patch: "x".repeat(index) },
      inputTextDelta: "x",
      inputTextSoFar: "x".repeat(index),
      sequence: 0,
      stepIndex: 0,
      toolName: "apply_patch",
      turnId,
    });
  }
  yield event("action.result", {
    result: {
      callId: "call-large",
      kind: "tool-result",
      output: { changedLines: partialCount },
      toolName: "apply_patch",
    },
    sequence: 0,
    status: "completed",
    stepIndex: 0,
    turnId,
  });
  yield event("step.completed", {
    finishReason: "tool-calls",
    sequence: 0,
    stepIndex: 0,
    turnId,
    usage: {},
  });
  yield event("turn.completed", { turnId });
  yield event("session.waiting", {});
}

async function* events(...items: readonly MessageStreamEvent[]): AsyncGenerator<MessageStreamEvent> {
  yield* items;
}

function settledTurn(
  turnId: string,
  sequence: number,
  request: string,
  reply: string,
): readonly MessageStreamEvent[] {
  return [
    event("turn.started", { sequence, turnId }),
    event("message.received", {
      message: request,
      parts: [{ text: request, type: "text" }],
      sequence,
      turnId,
    }),
    event("message.completed", {
      finishReason: "stop",
      message: reply,
      sequence,
      stepIndex: 0,
      turnId,
    }),
    event("turn.completed", { sequence, turnId }),
    event("session.waiting", {}),
  ] as readonly MessageStreamEvent[];
}

let eventSequence = 0;

function event(type: MessageStreamEvent["type"], data: Record<string, unknown>): MessageStreamEvent {
  eventSequence += 1;
  return {
    data,
    meta: {
      at: new Date(eventSequence).toISOString(),
      id: `evt-repair-${eventSequence}`,
    },
    type,
  } as MessageStreamEvent;
}
