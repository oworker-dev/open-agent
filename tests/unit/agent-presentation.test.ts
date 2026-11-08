import assert from "node:assert/strict";
import test from "node:test";
import { conversationOf, type EveMessage, type SessionStreamEvent } from "eve/client";
import {
  activeTurnIdAfterPendingSubmission, classifyAgentFailure, eventsBeforeLastUserTurn,
  eventsForAssistantSegment, failureForTurn, hasSettledLatestTurn, hasTerminalSessionBoundary,
  isRetryableAgentFailure, mergeSubagentSessions, presentAgentStep, presentAgentTurn,
  presentSubagentCall, reasoningContentForStep, unresolvedInputRequests, withThinkingPlaceholder,
} from "../../packages/agent-ui/dist/agent-workspace/turn-presentation.js";
import { summarizeUsage } from "../../packages/agent-ui/dist/agent-workspace/usage.js";
import { line, startTurn, reply } from "../helpers/session-events.ts";

const running = () => [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "turn", "delivery", "Run")];
const assistant = (events: readonly SessionStreamEvent[]): EveMessage => {
  const message = conversationOf(events).messages.findLast((message) => message.role === "assistant");
  assert.ok(message); return message;
};
const error = { code: "MODEL_CALL_FAILED", message: "Provider stream interrupted" };
const tool = () => line(4,
  { type: "call.requested", scope: { turnId: "turn" }, data: { callId: "call", owner: { runId: "turn:run" }, capability: { kind: "tool", name: "bash" }, input: { command: "npm test" } } },
  { type: "call.started", scope: { turnId: "turn" }, data: { callId: "call" } });

test("a native running turn has one stable thinking anchor", () => {
  const events = running(); const message = assistant(events);
  assert.equal(message.id, "turn:assistant");
  const presentation = presentAgentTurn(message, events);
  assert.equal(presentation?.status, "running");
  assert.equal(presentation?.showExecutionGroup, false);
  assert.equal(presentAgentStep(events, "turn", 0).status, "running");
  assert.equal(hasSettledLatestTurn(events), false);
});

test("final reply is separate from tool execution and narration", () => {
  const events = [...running(), ...line(4, { type: "content.completed", scope: { turnId: "turn" }, data: { partId: "narration", runId: "turn:run", kind: "text", phase: "narration", value: "Checking" } }),
    ...tool().map((event) => ({ ...event, meta: { ...event.meta, position: { ...event.meta.position, line: 5 } } })),
    ...line(6, { type: "call.settled", scope: { turnId: "turn" }, data: { callId: "call", outcome: "completed", output: "ok" } }), ...reply(7, "turn", "delivery", "Done")];
  const presentation = presentAgentTurn(assistant(events), events);
  assert.equal(presentation?.finalPart?.text, "Done");
  assert.equal(presentation?.showExecutionGroup, true);
  assert.deepEqual(presentation?.processParts.map((part) => part.type), ["text", "tool"]);
  assert.equal(presentation?.status, "completed");
  assert.ok(presentation?.startedAt); assert.ok(presentation?.endedAt);
});

test("plain imported assistant messages remain ordinary dialogue", () => {
  const message: EveMessage = { id: "imported", role: "assistant", parts: [{ type: "text", state: "done", text: "Hello" }] };
  assert.equal(presentAgentTurn(message, []), undefined);
});

test("historical reasoning is never borrowed by an optimistic placeholder", () => {
  const events = [...running(), ...line(4, { type: "content.completed", scope: { turnId: "turn" }, data: { partId: "reason", runId: "turn:run", kind: "reasoning", phase: "narration", value: "Old reasoning" } })];
  assert.equal(reasoningContentForStep(events, undefined, undefined), "");
  assert.equal(reasoningContentForStep(events, "other", 0), "");
  assert.equal(reasoningContentForStep(events, "turn", 0), "Old reasoning");
});

test("empty reasoning completion does not fabricate content", () => {
  const events = [...running(), ...line(4, { type: "content.completed", scope: { turnId: "turn" }, data: { partId: "reason", runId: "turn:run", kind: "reasoning", phase: "narration", value: "" } })];
  assert.equal(reasoningContentForStep(events, "turn", 0), "");
});

for (const outcome of ["failed", "interrupted", "completed"] as const) test(`a ${outcome} tool retains its durable identity and diagnostics`, () => {
  const events = [...running(), ...tool(), ...line(5, { type: "call.settled", scope: { turnId: "turn" }, data: { callId: "call", outcome, ...(outcome === "completed" ? { output: "ok" } : { error }) } })];
  const part = assistant(events).parts.find((part) => part.type === "tool");
  assert.equal(part?.callId, "call");
  assert.equal(part?.state, outcome === "interrupted" ? "cancelled" : outcome);
  if (outcome !== "completed") assert.deepEqual(part?.error, error);
});

test("failed model diagnostics attach to the owning step and turn", () => {
  const events = [...running(), ...line(4,
    { type: "model.settled", scope: { turnId: "turn" }, data: { runId: "turn:run", outcome: "failed", error } },
    { type: "turn.settled", data: { turnId: "turn", outcome: "failed", error } })];
  assert.deepEqual(failureForTurn(events, "turn"), error);
  assert.equal(presentAgentStep(events, "turn", 0).status, "failed");
  assert.equal(presentAgentTurn(assistant(events), events)?.status, "failed");
  assert.equal(hasSettledLatestTurn(events), true);
  assert.equal(hasTerminalSessionBoundary(events), false);
});

test("model-only failures do not create a tool execution group", () => {
  const events = [...running(), ...line(4,
    { type: "model.settled", scope: { turnId: "turn" }, data: { runId: "turn:run", outcome: "failed", error } },
    { type: "turn.settled", data: { turnId: "turn", outcome: "failed", error } })];
  assert.equal(presentAgentTurn(assistant(events), events)?.showExecutionGroup, false);
});

test("internal control calls stay out of the user-facing execution group", () => {
  const events = [...running(), ...line(4, { type: "call.requested", scope: { turnId: "turn" }, data: {
    callId: "control", owner: { runId: "turn:run" }, capability: { kind: "control", name: "wait" }, input: { taskId: "task" },
  } })];
  assert.equal(presentAgentTurn(assistant(events), events)?.showExecutionGroup, false);
});

test("only explicit model retry facts create retry attempts", () => {
  const events = [...running(), ...line(4, { type: "model.retried", scope: { turnId: "turn" }, data: { runId: "turn:run", attempt: 0, error } }),
    ...line(5, { type: "model.started", scope: { turnId: "turn" }, data: { runId: "turn:run", attempt: 1, modelId: "test" } })];
  assert.equal(presentAgentStep(events, "turn", 0).retry?.attempt, 1);
  assert.equal(presentAgentStep(running(), "turn", 0).retry, undefined);
});

test("exhausted retries preserve all real attempts and terminal failure", () => {
  const events = [...running(), ...line(4, { type: "model.retried", scope: { turnId: "turn" }, data: { runId: "turn:run", attempt: 0, error } }),
    ...line(5, { type: "model.retried", scope: { turnId: "turn" }, data: { runId: "turn:run", attempt: 1, error } }),
    ...line(6, { type: "model.settled", scope: { turnId: "turn" }, data: { runId: "turn:run", outcome: "failed", error } }, { type: "turn.settled", data: { turnId: "turn", outcome: "failed", error } })];
  const step = presentAgentStep(events, "turn", 0);
  assert.deepEqual(step.retries?.map((retry) => retry.attempt), [1, 2]);
  assert.equal(step.retry?.exhausted, true);
});

for (const [code, message, category] of [
  ["TIMEOUT", "Request timed out", "timeout"], ["FETCH", "socket closed", "network"],
  ["MODEL_CALL_FAILED", "Provider stream interrupted", "provider"], ["UNKNOWN", "Execution failed", "unknown"],
] as const) test(`failure classification preserves ${category} diagnostics`, () => assert.equal(classifyAgentFailure({ code, message }), category));

test("explicit terminal provider policy overrides retry heuristics", () => {
  assert.equal(isRetryableAgentFailure({ ...error, retryable: false, statusCode: 503 }), false);
  assert.equal(isRetryableAgentFailure({ ...error, retryable: true, statusCode: 400 }), true);
  assert.equal(isRetryableAgentFailure({ ...error, statusCode: 403 }), true);
  assert.equal(isRetryableAgentFailure({ ...error, statusCode: 404 }), true);
  assert.equal(isRetryableAgentFailure({ code: "INVALID_REQUEST", message: "Unauthorized", statusCode: 401 }), false);
});

const question = (id: string) => ({ type: "interaction.opened" as const, scope: { turnId: "turn" }, data: { interactionId: id, subject: { turnId: "turn" }, request: { kind: "question" as const, prompt: "Choose" } } });

test("native questions keep one waiting execution and close on settlement", () => {
  const events = [...running(), ...line(4, question("question"), { type: "turn.paused", data: { turnId: "turn", awaiting: [{ interactionId: "question" }] } })];
  assert.equal(unresolvedInputRequests(events).length, 1);
  assert.equal(presentAgentTurn(assistant(events), events)?.status, "waiting");
  assert.equal(presentAgentTurn(assistant(events), events)?.waitingFor, "question");
  assert.equal(presentAgentTurn(assistant(events), events)?.showExecutionGroup, true);
  assert.equal(unresolvedInputRequests(events, new Set(["question"])).length, 0);
  events.push(...line(5, { type: "interaction.settled", data: { interactionId: "question", outcome: "accepted" } }));
  assert.equal(unresolvedInputRequests(events).length, 0);
});

test("consecutive questions preserve ordering and only the newest stays pending", () => {
  const events = [...running(), ...line(4, question("first")), ...line(5, { type: "interaction.settled", data: { interactionId: "first", outcome: "accepted" } }), ...line(6, question("second"))];
  assert.deepEqual(unresolvedInputRequests(events).map((request) => request.interactionId), ["second"]);
  assert.deepEqual(assistant(events).parts.filter((part) => part.type === "interaction").map((part) => part.interactionId), ["first", "second"]);
});

test("root approvals are attached to their tool once", () => {
  const events = [...running(), ...tool(), ...line(5, { type: "interaction.opened", scope: { turnId: "turn" }, data: { interactionId: "approval", subject: { callId: "call" }, request: { kind: "approval", prompt: "Approve?" } } })];
  const message = assistant(events);
  assert.equal(message.parts.filter((part) => part.type === "interaction").length, 0);
  assert.equal(message.parts.find((part) => part.type === "tool")?.interaction?.interactionId, "approval");
});

test("steering stays between the assistant content produced before and after admission", () => {
  const events = [...running(), ...line(4, { type: "content.completed", scope: { turnId: "turn" }, data: { partId: "before", runId: "turn:run", kind: "text", phase: "narration", value: "Before" } }),
    ...line(5, { type: "delivery.admitted", data: { deliveryId: "steer", source: { channel: "eve" } } }),
    ...line(6, { type: "delivery.consumed", scope: { turnId: "turn" }, data: { deliveryId: "steer", turnId: "turn", parts: [{ kind: "text", text: "Adjust" }] } }),
    ...line(7, { type: "content.completed", scope: { turnId: "turn" }, data: { partId: "after", runId: "turn:run", kind: "text", phase: "reply", value: "After" } })];
  const messages = conversationOf(events).messages;
  assert.deepEqual(messages.map((message) => message.id), ["delivery:user", "turn:assistant", "steer:user", "turn:steer:assistant"]);
  const first = messages[1]!; const last = messages[3]!;
  assert.ok(eventsForAssistantSegment(first, events).settledAt);
  assert.equal(eventsForAssistantSegment(last, events).events.some((event) => event.type === "content.completed" && event.data.partId === "before"), false);
  assert.equal(presentAgentTurn(first, events)?.finalPart, undefined);
  assert.equal(presentAgentTurn(last, events)?.finalPart?.text, "After");
});

test("steered thinking keeps the full turn's step index and never reinserts earlier reasoning", () => {
  const events = [...running(), ...line(4,
    { type: "content.completed", scope: { turnId: "turn" }, data: { partId: "old-thought", runId: "turn:run", kind: "reasoning", phase: "narration", value: "Earlier thought" } },
    { type: "model.settled", scope: { turnId: "turn" }, data: { runId: "turn:run", outcome: "interrupted" } },
  ), ...line(5,
    { type: "delivery.admitted", data: { deliveryId: "steer", source: { channel: "eve" } } },
    { type: "delivery.consumed", scope: { turnId: "turn" }, data: { deliveryId: "steer", turnId: "turn", parts: [{ kind: "text", text: "Correction" }] } },
    { type: "model.requested", scope: { turnId: "turn" }, data: { runId: "corrected-run", owner: { turnId: "turn" } } },
    { type: "model.started", scope: { turnId: "turn" }, data: { runId: "corrected-run", modelId: "test", attempt: 0 } },
  )];
  const before = conversationOf(events).messages[1]!;
  assert.deepEqual(withThinkingPlaceholder(before, events), before.parts);
  assert.deepEqual(withThinkingPlaceholder(assistant(events), events), [{ type: "reasoning", state: "streaming", stepIndex: 1, text: "" }]);
  events.push(...line(6, { type: "content.completed", scope: { turnId: "turn" }, data: { partId: "new-thought", runId: "corrected-run", kind: "reasoning", phase: "narration", value: "Corrected thought" } }));
  const after = assistant(events);
  assert.deepEqual(withThinkingPlaceholder(after, events), after.parts);
  assert.deepEqual(after.parts.map((part) => [part.type, "text" in part ? part.text : "", part.stepIndex]), [["reasoning", "Corrected thought", 1]]);
});

test("later tools, approval, and failure cannot change an earlier segment's presentation", () => {
  const events = [...running(), ...line(4,
    { type: "content.completed", scope: { turnId: "turn" }, data: { partId: "before", runId: "turn:run", kind: "text", phase: "narration", value: "Before correction" } },
    { type: "model.settled", scope: { turnId: "turn" }, data: { runId: "turn:run", outcome: "completed" } },
  ), ...line(5,
    { type: "delivery.admitted", data: { deliveryId: "steer", source: { channel: "eve" } } },
    { type: "delivery.consumed", scope: { turnId: "turn" }, data: { deliveryId: "steer", turnId: "turn", parts: [{ kind: "text", text: "Correction" }] } },
    { type: "model.requested", scope: { turnId: "turn" }, data: { runId: "next-run", owner: { turnId: "turn" } } },
    { type: "model.started", scope: { turnId: "turn" }, data: { runId: "next-run", modelId: "test", attempt: 0 } },
  ), ...line(6,
    { type: "call.requested", scope: { turnId: "turn" }, data: { callId: "next-call", owner: { runId: "next-run" }, capability: { kind: "tool", name: "bash" }, input: { command: "printf ok" } } },
    { type: "interaction.opened", scope: { turnId: "turn" }, data: { interactionId: "next-approval", subject: { callId: "next-call" }, request: { kind: "approval", prompt: "Allow?" } } },
  )];
  const first = conversationOf(events).messages[1]!;
  const before = presentAgentTurn(first, events);
  assert.equal(before?.status, "completed");
  assert.equal(before?.showExecutionGroup, false);
  assert.equal(before?.waitingFor, undefined);
  assert.equal(presentAgentTurn(assistant(events), events)?.status, "waiting");
  assert.equal(presentAgentTurn(assistant(events), events)?.showExecutionGroup, true);
  events.push(...line(7, { type: "turn.settled", data: { turnId: "turn", outcome: "failed", error } }));
  assert.deepEqual(presentAgentTurn(first, events), before);
  assert.equal(presentAgentTurn(assistant(events), events)?.status, "failed");
});

test("coalesced corrections before output anchor the root assistant to the latest user", () => {
  const events = [...running(), ...line(4,
    { type: "model.settled", scope: { turnId: "turn" }, data: { runId: "turn:run", outcome: "interrupted" } },
    { type: "delivery.admitted", data: { deliveryId: "steer-1", source: { channel: "eve" } } },
    { type: "delivery.consumed", scope: { turnId: "turn" }, data: { deliveryId: "steer-1", turnId: "turn", parts: [{ kind: "text", text: "First correction" }] } },
    { type: "delivery.admitted", data: { deliveryId: "steer-2", source: { channel: "eve" } } },
    { type: "delivery.consumed", scope: { turnId: "turn" }, data: { deliveryId: "steer-2", turnId: "turn", parts: [{ kind: "text", text: "Second correction" }] } },
    { type: "model.requested", scope: { turnId: "turn" }, data: { runId: "next-run", owner: { turnId: "turn" } } },
  ), ...line(5, { type: "model.started", scope: { turnId: "turn" }, data: { runId: "next-run", modelId: "test", attempt: 0 } })];
  const message = assistant(events);
  assert.equal(message.id, "turn:assistant");
  const segment = eventsForAssistantSegment({ ...message, id: "pending:assistant" }, events);
  assert.ok(segment.events[0]?.type === "delivery.consumed");
  assert.equal(segment.events[0]?.data.deliveryId, "steer-2");
  assert.equal(segment.settledAt, undefined);
  assert.equal(presentAgentTurn(message, events)?.status, "running");
  assert.deepEqual(withThinkingPlaceholder(message, events).map((part) => part.stepIndex), [1]);
});

test("steering leaves an earlier background call and its approval live until that call settles", () => {
  const events = [...running(), ...tool(), ...line(5,
    { type: "model.settled", scope: { turnId: "turn" }, data: { runId: "turn:run", outcome: "completed" } },
    { type: "delivery.admitted", data: { deliveryId: "steer", source: { channel: "eve" } } },
    { type: "delivery.consumed", scope: { turnId: "turn" }, data: { deliveryId: "steer", turnId: "turn", parts: [{ kind: "text", text: "Continue with another task" }] } },
    { type: "model.requested", scope: { turnId: "turn" }, data: { runId: "next-run", owner: { turnId: "turn" } } },
  )];
  const first = () => conversationOf(events).messages[1]!;
  assert.equal(presentAgentTurn(first(), events)?.status, "running");
  assert.equal(presentAgentTurn(first(), events)?.endedAt, undefined);
  events.push(...line(6, { type: "interaction.opened", scope: { turnId: "turn" }, data: {
    interactionId: "earlier-approval", subject: { callId: "call" }, request: { kind: "approval", prompt: "Allow the earlier task?" },
  } }));
  assert.equal(presentAgentTurn(first(), events)?.status, "waiting");
  assert.equal(presentAgentTurn(assistant(events), events)?.waitingFor, undefined);
  events.push(...line(7,
    { type: "interaction.settled", data: { interactionId: "earlier-approval", outcome: "accepted" } },
    { type: "call.settled", scope: { turnId: "turn" }, data: { callId: "call", outcome: "completed", output: "Complete" } },
  ));
  assert.equal(presentAgentTurn(first(), events)?.status, "completed");
  assert.equal(presentAgentTurn(first(), events)?.endedAt, Date.parse(events.at(-1)!.meta.at));
});

test("subagent call lifecycle uses the durable child id", () => {
  const events = [...running(), ...line(4,
    { type: "call.requested", scope: { turnId: "turn" }, data: { callId: "child-call", owner: { runId: "turn:run" }, capability: { kind: "agent", name: "researcher" }, input: { message: "Investigate" } } },
    { type: "child.opened", scope: { turnId: "turn" }, data: { sessionId: "child", owner: { callId: "child-call" }, name: "researcher", stream: "/sessions/child/stream" } })];
  assert.equal(presentSubagentCall(events, "child-call").childSessionId, "child");
  assert.equal(mergeSubagentSessions(events)[0]?.task, "Investigate");
  events.push(...line(5, { type: "call.settled", scope: { turnId: "turn" }, data: { callId: "child-call", outcome: "interrupted" } }));
  assert.equal(presentSubagentCall(events, "child-call").status, "cancelled");
});

test("terminal session boundaries remain distinct from settled live sessions", () => {
  const events = [...running(), ...reply(4, "turn", "delivery", "Done")];
  assert.equal(hasTerminalSessionBoundary(events), false);
  assert.equal(hasSettledLatestTurn(events), true);
  events.push(...line(5, { type: "session.ended", data: { outcome: "completed" } }));
  assert.equal(hasTerminalSessionBoundary(events), true);
});

test("pending admissions never alias a prior turn from timestamp proximity", () => {
  const events = running();
  assert.equal(activeTurnIdAfterPendingSubmission(events, { eventCountAtSubmission: events.length, submittedAt: 0 }), undefined);
  assert.equal(activeTurnIdAfterPendingSubmission(events, { eventCountAtSubmission: 0, submittedAt: 0 }), "turn");
});

test("edit prefix ends before the latest turn and retains earlier complete commits", () => {
  const first = [...running(), ...reply(4, "turn", "delivery", "Done")];
  const events = [...first, ...startTurn(5, "next", "next-delivery", "Edit", "turn")];
  const prefix = eventsBeforeLastUserTurn(events);
  assert.deepEqual(prefix, [...first, events[first.length]!]); // admitted, but not consumed
  assert.equal(prefix.at(-1)?.meta.endOfLine, undefined);
});

test("usage reconciles streamed estimates to recorded provider usage", () => {
  const events = [...running(), ...line(4, { type: "content.delta", scope: { turnId: "turn", runId: "turn:run" }, data: { partId: "answer", kind: "text", delta: "x".repeat(400) } })];
  assert.equal(summarizeUsage(events).isEstimated, true);
  events.push(...line(5, { type: "usage.recorded", data: { kind: "model", owner: { runId: "turn:run" }, usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0, costUsd: 0.01 } } }));
  assert.equal(summarizeUsage(events).isEstimated, false);
  assert.equal(summarizeUsage(events).contextInputTokens, 200);
  assert.equal(summarizeUsage(events).outputTokens, 100);
});
