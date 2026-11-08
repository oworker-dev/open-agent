import assert from "node:assert/strict";
import test from "node:test";
import { conversationOf, type SessionStreamEvent } from "eve/client";
import { idle, position, turn } from "eve/events";
import { eventsForMessagePresentation, projectInterruptedMessages, presentAgentTurn, presentationSnapshot, reasoningContentForStep, unresolvedInputRequests } from "../../packages/agent-ui/dist/agent-workspace/turn-presentation.js";
import { convertEveMessages } from "../../packages/agent-ui/dist/agent-workspace/eve-message-adapter.js";
import { line, reply, startTurn } from "../helpers/session-events.ts";

function runningEvents(): SessionStreamEvent[] {
  return [
    ...line(0, { type: "session.started", data: {} }),
    ...startTurn(1, "first", "d1", "Original prompt"),
    ...line(4, { type: "content.delta", scope: { turnId: "first", runId: "first:run" }, data: { partId: "first:reply", kind: "text", delta: "Already visible" } }),
  ];
}

test("Stop freezes output immediately while a complete cancellation commit still folds", () => {
  const events = runningEvents();
  events.push(...line(5,
    { type: "content.completed", scope: { turnId: "first" }, data: { partId: "first:reply", runId: "first:run", kind: "text", phase: "reply", value: "Already visible LATE OUTPUT", interrupted: true } },
    { type: "model.settled", scope: { turnId: "first" }, data: { runId: "first:run", outcome: "interrupted" } },
    { type: "turn.settled", data: { turnId: "first", outcome: "cancelled" } },
    { type: "delivery.settled", data: { deliveryId: "d1", turnId: "first", outcome: "handled" } },
  ));
  const authoritative = conversationOf(events);
  const stopped = projectInterruptedMessages(authoritative.messages, events, [{ turnId: "first", streamIndex: 5, eventCount: 7, settled: false }]);
  assert.equal(position(authoritative.view), 6);
  assert.equal(idle(authoritative.view), true);
  assert.equal(turn(authoritative.view, "first")?.outcome, "cancelled");
  assert.equal(stopped.filter((message) => message.role === "user").length, 1);
  assert.deepEqual(stopped.at(-1)?.parts, [{ type: "text", id: "first:reply", state: "done", stepIndex: 0, text: "Already visible" }]);
  assert.equal(presentAgentTurn(stopped.at(-1)!, events)?.status, "cancelled");
  assert.deepEqual(convertEveMessages(stopped, { isRunning: true }).at(-1)?.status, { reason: "cancelled", type: "incomplete" });
  // The authoritative stream and its replay remain unchanged by presentation.
  assert.match(JSON.stringify(conversationOf(events).messages), /LATE OUTPUT/);
});

test("a stopped turn cannot freeze later receipts or the next turn", () => {
  const events = [...runningEvents(), ...reply(5, "first", "d1", "Late reply"), ...startTurn(6, "second", "d2", "Next prompt", "first"), ...reply(9, "second", "d2", "Next reply")];
  const projected = projectInterruptedMessages(conversationOf(events).messages, events, [{ turnId: "first", streamIndex: 5, eventCount: 7 }]);
  assert.deepEqual(projected.filter((message) => message.role === "user").flatMap((message) => message.parts.flatMap((part) => part.type === "text" ? part.text : [])), ["Original prompt", "Next prompt"]);
  assert.match(JSON.stringify(projected.at(-1)), /Next reply/);
  assert.equal(projected.at(-1)?.metadata?.localStatus, undefined);
});

test("a stop before the durable receipt retains one user row and an empty stopped assistant", () => {
  const events = [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "first", "d1", "Edited prompt"), ...reply(4, "first", "d1", "Should never flash")];
  const stopped = projectInterruptedMessages(conversationOf(events).messages, events, [{ turnId: "first", streamIndex: 1, eventCount: 1 }]);
  assert.equal(stopped.filter((message) => message.role === "user").length, 1);
  assert.deepEqual(stopped.at(-1)?.parts, []);
  assert.equal(presentAgentTurn(stopped.at(-1)!, events)?.status, "cancelled");
});

test("standalone sign-in and budget interactions survive the message projection", () => {
  for (const kind of ["sign-in", "budget"] as const) {
    const events = [...runningEvents(), ...line(5,
      { type: "interaction.opened", scope: { turnId: "first" }, data: { interactionId: kind, subject: { turnId: "first" }, request: { kind, prompt: `Need ${kind}` } } },
      { type: "turn.paused", data: { turnId: "first", awaiting: [{ interactionId: kind }] } },
    )];
    const { messages } = conversationOf(events);
    assert.ok(messages.some((message) => message.parts.some((part) => part.type === "interaction" && part.request.kind === kind)));
    assert.equal(unresolvedInputRequests(events)[0]?.request.kind, kind);
    assert.equal(convertEveMessages(messages).at(-1)?.status?.type, "requires-action");
  }
});

test("presentation queries invalidate after an imperative log append", () => {
  const events = runningEvents();
  assert.equal(idle(presentationSnapshot(events).view), false);
  events.push(...reply(5, "first", "d1", "Done"));
  assert.equal(idle(presentationSnapshot(events).view), true);
  assert.equal(position(presentationSnapshot(events).view), 6);
});

test("message-local reasoning queries cannot bypass the Stop boundary", () => {
  const events = [...runningEvents(),
    ...line(5, { type: "content.delta", scope: { turnId: "first", runId: "first:run" }, data: { partId: "thought", kind: "reasoning", delta: "Visible thought" } }),
    ...line(6, { type: "content.delta", scope: { turnId: "first", runId: "first:run" }, data: { partId: "thought", kind: "reasoning", delta: " LATE THOUGHT" } }),
  ];
  const messages = projectInterruptedMessages(conversationOf(events).messages, events, [{ turnId: "first", streamIndex: 6, eventCount: events.length - 1 }]);
  const stopped = messages.findLast((message) => message.role === "assistant")!;
  assert.equal(reasoningContentForStep(eventsForMessagePresentation(stopped, events), "first", 0), "Visible thought");
  assert.match(reasoningContentForStep(events, "first", 0), /LATE THOUGHT/);
  const user = messages.find((message) => message.role === "user")!;
  assert.equal(eventsForMessagePresentation(user, events), events);
});
