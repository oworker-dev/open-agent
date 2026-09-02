import assert from "node:assert/strict";
import test from "node:test";

import type { MessageStreamEvent } from "eve/client";
import type { EveMessage } from "eve/react";
import { activityLabel } from "../../packages/agent-ui/src/agent-workspace/agent-activity-state.ts";
import { messagesFor } from "../../packages/agent-ui/src/agent-workspace/i18n.ts";
import {
  activeTurnIdAfterPendingSubmission,
  classifyAgentFailure,
  eventsBeforeLastUserTurn,
  hasTerminalSessionBoundary,
  hasSettledLatestTurn,
  hasUnresolvedInputRequests,
  isRetryableAgentFailure,
  isProxiedInputOnlyMessage,
  normalizeSettledAgentMessages,
  presentAgentStep,
  presentAgentTurn,
  presentSubagentCall,
  presentSubagentSessions,
  projectAgentDisplayTimeline,
  reasoningContentForStep,
  sanitizeSettledThreadEvents,
  shouldSuppressInterruptedTurnDisplayEvent,
  stableUserMessageId,
} from "../../packages/agent-ui/src/agent-workspace/turn-presentation.ts";
import { summarizeUsage } from "../../packages/agent-ui/src/agent-workspace/usage.ts";

const startedAt = "2026-08-06T01:00:00.000Z";
const endedAt = "2026-08-06T01:00:09.000Z";

test("a locally requested cancellation keeps post-request events visible until Eve confirms it", () => {
  const turnId = "turn-cancel-pending";
  const eventAfterCancel = event("message.appended", endedAt, {
    messageSoFar: "still streaming",
    sequence: 0,
    stepIndex: 0,
    turnId,
  });

  assert.equal(
    shouldSuppressInterruptedTurnDisplayEvent(eventAfterCancel, 3, [{
      eventCount: 3,
      settled: false,
      streamIndex: 3,
      turnId,
    }]),
    false,
  );
  // Legacy records without `settled` are authoritative historical markers and
  // continue to suppress the post-cancellation tail after a refresh.
  assert.equal(
    shouldSuppressInterruptedTurnDisplayEvent(eventAfterCancel, 3, [{
      eventCount: 3,
      streamIndex: 3,
      turnId,
    }]),
    true,
  );
});

test("failure classification keeps transient provider errors out of the generic turn failure label", () => {
  assert.equal(classifyAgentFailure({ code: "provider_rate_limit", message: "HTTP 429" }), "provider");
  assert.equal(classifyAgentFailure({ code: "provider_stream_interrupted", message: "network connection reset" }), "network");
  assert.equal(classifyAgentFailure({ code: "request_timeout", message: "The request timed out" }), "timeout");
  assert.equal(classifyAgentFailure({ code: "unexpected", message: "bad state" }), "unknown");
});

test("permanent provider failures never fabricate a retry", () => {
  const turnId = "turn-provider-404";
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId }),
    event("step.failed", endedAt, {
      code: "MODEL_CALL_FAILED",
      details: { isRetryable: false, statusCode: 404 },
      message: "The model Provider request failed (HTTP 404).",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("turn.failed", endedAt, {
      code: "MODEL_CALL_FAILED",
      details: { isRetryable: false, statusCode: 404 },
      message: "The model Provider request failed (HTTP 404).",
      sequence: 0,
      turnId,
    }),
  ];
  const presentation = presentAgentStep(events, turnId, 0);
  assert.equal(isRetryableAgentFailure(presentation.failure!), false);
  assert.equal(presentation.retry, undefined);
  assert.equal(presentation.failure?.statusCode, 404);
  assert.equal(presentation.failure?.retryable, false);
});

test("provider 404 failures without an explicit flag remain retryable", () => {
  assert.equal(isRetryableAgentFailure({
    code: "MODEL_CALL_FAILED",
    message: "The model Provider request failed (HTTP 404).",
    statusCode: 404,
  }), true);
});

test("a failed step without settled assistant parts keeps a display anchor", () => {
  const turnId = "turn-failed-anchor";
  const message: EveMessage = {
    id: `${turnId}:assistant`,
    metadata: { status: "complete", turnId },
    parts: [],
    role: "assistant",
  };
  const events = [
    event("actions.requested", startedAt, {
      actions: [{ callId: "call-failed", input: { command: "npm test" }, kind: "tool-call", toolName: "bash" }],
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("step.failed", endedAt, {
      code: "provider_rejected",
      message: "The model Provider rejected this turn.",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("turn.failed", endedAt, {
      code: "provider_rejected",
      message: "The model Provider rejected this turn.",
      sequence: 0,
      turnId,
    }),
  ];
  const presentation = presentAgentTurn(message, events);
  assert.equal(presentation?.status, "failed");
  assert.equal(presentation?.failureAnchored, true);
  assert.deepEqual(presentation?.processParts.map((part) => part.type), ["step-start"]);
});

test("plain assistant replies remain normal dialogue without a task execution group", () => {
  const message: EveMessage = {
    id: "turn-chat:assistant",
    metadata: { status: "complete", turnId: "turn-chat" },
    parts: [{ state: "done", stepIndex: 0, text: "Hello", type: "text" }],
    role: "assistant",
  };

  assert.equal(presentAgentTurn(message, []), undefined);
});

test("empty reasoning boundaries do not fabricate completed reasoning content", () => {
  const events = [
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-empty-reasoning" }),
    event("reasoning.completed", endedAt, {
      reasoning: "",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-empty-reasoning",
    }),
    event("step.completed", endedAt, {
      finishReason: "tool-calls",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-empty-reasoning",
    }),
  ];
  assert.equal(reasoningContentForStep(events, "turn-empty-reasoning", 0), "");
  assert.equal(
    reasoningContentForStep([
      ...events,
      event("reasoning.appended", endedAt, {
        reasoningDelta: "Inspect the workspace.",
        reasoningSoFar: "Inspect the workspace.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-empty-reasoning",
      }),
    ], "turn-empty-reasoning", 0),
    "Inspect the workspace.",
  );
});

test("an optimistic placeholder never reads reasoning from a historical turn", () => {
  const events = [
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-history" }),
    event("reasoning.appended", endedAt, {
      reasoningDelta: "Preparing the previous response.",
      reasoningSoFar: "Preparing the previous response.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-history",
    }),
  ];

  assert.equal(reasoningContentForStep(events, undefined, 0), "");
  assert.equal(reasoningContentForStep(events, "turn-current", 0), "");
  assert.equal(reasoningContentForStep(events, "turn-history", 0), "Preparing the previous response.");
});

test("reasoning content starts fresh when eve retries the same step", () => {
  const turnId = "turn-reasoning-retry";
  const events = [
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId }),
    event("reasoning.appended", startedAt, {
      reasoningDelta: "Inspect the old attempt.",
      reasoningSoFar: "Inspect the old attempt.",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("reasoning.completed", startedAt, {
      reasoning: "Inspect the old attempt.",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("step.failed", endedAt, {
      code: "provider_stream_interrupted",
      message: "Provider stream interrupted.",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    // eve reuses the same turn/step coordinates for the retry.
    event("step.started", endedAt, { sequence: 0, stepIndex: 0, turnId }),
    event("reasoning.appended", endedAt, {
      reasoningDelta: "Retry with the current state.",
      reasoningSoFar: "",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
  ];

  assert.equal(
    reasoningContentForStep(events, turnId, 0),
    "Retry with the current state.",
  );
});

test("tool turns separate the execution process from the final delivery", () => {
  const message: EveMessage = {
    id: "turn-task:assistant",
    metadata: { status: "complete", turnId: "turn-task" },
    parts: [
      { type: "step-start" },
      { state: "done", stepIndex: 0, text: "Inspecting the workspace.", type: "text" },
      {
        input: { command: "find . -maxdepth 2 -type f" },
        output: "./package.json",
        state: "output-available",
        stepIndex: 0,
        toolCallId: "call-1",
        toolName: "bash",
        type: "dynamic-tool",
      },
      { type: "step-start" },
      { state: "done", stepIndex: 1, text: "The website is ready.", type: "text" },
    ],
    role: "assistant",
  };
  const events = [
    event("actions.requested", startedAt, {
      actions: [{ callId: "call-1", input: { command: "find ." }, kind: "tool-call", toolName: "bash" }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-task",
    }),
    event("message.completed", endedAt, {
      finishReason: "stop",
      message: "The website is ready.",
      sequence: 0,
      stepIndex: 1,
      turnId: "turn-task",
    }),
    event("turn.completed", endedAt, { sequence: 0, turnId: "turn-task" }),
  ];

  const presentation = presentAgentTurn(message, events);
  assert.ok(presentation);
  assert.equal(presentation.status, "completed");
  assert.equal(presentation.startedAt, Date.parse(startedAt));
  assert.equal(presentation.endedAt, Date.parse(endedAt));
  assert.equal(presentation.finalPart?.text, "The website is ready.");
  assert.deepEqual(presentation.processParts.map((part) => part.type), [
    "step-start",
    "text",
    "dynamic-tool",
    "step-start",
  ]);
});

test("pre-tool narration stays in execution order until a later delivery exists", () => {
  const turnId = "turn-narration-before-tool";
  const message: EveMessage = {
    id: `${turnId}:assistant`,
    metadata: { status: "streaming", turnId },
    parts: [
      { type: "step-start" },
      { state: "done", stepIndex: 0, text: "I will inspect the workspace first.", type: "text" },
      { type: "step-start" },
      {
        input: { command: "pwd" },
        state: "input-streaming",
        stepIndex: 1,
        toolCallId: "call-pwd",
        toolName: "bash",
        type: "dynamic-tool",
      },
    ],
    role: "assistant",
  };
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId }),
    event("message.completed", endedAt, {
      finishReason: "stop",
      message: "I will inspect the workspace first.",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("step.started", endedAt, { sequence: 1, stepIndex: 1, turnId }),
    event("action.input.partial", endedAt, {
      callId: "call-pwd",
      input: { command: "pwd" },
      inputTextDelta: "}",
      inputTextSoFar: '{"command":"pwd"}',
      sequence: 1,
      stepIndex: 1,
      toolName: "bash",
      turnId,
    }),
  ];

  const running = presentAgentTurn(message, events);
  assert.ok(running);
  assert.equal(running.finalPart, undefined);
  assert.deepEqual(running.processParts.map((part) => part.type), [
    "step-start",
    "text",
    "step-start",
    "dynamic-tool",
  ]);

  const completedMessage: EveMessage = {
    ...message,
    metadata: { status: "complete", turnId },
    parts: [
      ...message.parts,
      { type: "step-start" },
      { state: "done", stepIndex: 2, text: "The workspace is ready.", type: "text" },
    ],
  };
  const completed = presentAgentTurn(completedMessage, [
    ...events,
    event("action.result", endedAt, {
      result: { callId: "call-pwd", kind: "tool-result", output: "/workspace", toolName: "bash" },
      sequence: 2,
      status: "completed",
      stepIndex: 1,
      turnId,
    }),
    event("step.completed", endedAt, { finishReason: "tool-calls", sequence: 2, stepIndex: 1, turnId }),
    event("step.started", endedAt, { sequence: 3, stepIndex: 2, turnId }),
    event("message.completed", endedAt, {
      finishReason: "stop",
      message: "The workspace is ready.",
      sequence: 3,
      stepIndex: 2,
      turnId,
    }),
    event("turn.completed", endedAt, { sequence: 3, turnId }),
  ]);
  assert.ok(completed);
  assert.equal(completed.finalPart?.text, "The workspace is ready.");
  assert.deepEqual(completed.processParts.map((part) => part.type), [
    "step-start",
    "text",
    "step-start",
    "dynamic-tool",
    "step-start",
  ]);
});

test("reconciles a transient reducer reorder back to the Eve event order", () => {
  const turnId = "turn-reordered-live-snapshot";
  const message: EveMessage = {
    id: `${turnId}:assistant`,
    metadata: { status: "streaming", turnId },
    // This is the transient shape observed when the tool part is published
    // before the message snapshot catches up. The durable stream says the
    // narration happened first, so the presentation must restore that order.
    parts: [
      { type: "step-start" },
      {
        input: { filename: "hero.jpg" },
        state: "input-streaming",
        stepIndex: 1,
        toolCallId: "call-import",
        toolName: "import_remote_asset",
        type: "dynamic-tool",
      },
      { state: "done", stepIndex: 0, text: "The workspace is empty, so I will import the hero asset first.", type: "text" },
    ],
    role: "assistant",
  };
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId }),
    event("message.completed", endedAt, {
      finishReason: "stop",
      message: "The workspace is empty, so I will import the hero asset first.",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("step.started", endedAt, { sequence: 1, stepIndex: 1, turnId }),
    event("action.input.partial", endedAt, {
      callId: "call-import",
      input: { filename: "hero.jpg" },
      inputTextDelta: "}",
      inputTextSoFar: '{"filename":"hero.jpg"}',
      sequence: 1,
      stepIndex: 1,
      toolName: "import_remote_asset",
      turnId,
    }),
  ];

  const presentation = presentAgentTurn(message, events);
  assert.ok(presentation);
  assert.deepEqual(
    presentation.processParts.map((part) => part.type),
    ["step-start", "text", "dynamic-tool"],
  );
});

test("anchors reasoning before tools when a legacy checkpoint kept only completion", () => {
  const turnId = "turn-reasoning-anchor-fallback";
  const message: EveMessage = {
    id: `${turnId}:assistant`,
    metadata: { status: "complete", turnId },
    // This is the persisted shape from the affected sessions: the reducer
    // receives the tool part and a completed reasoning part, but the original
    // reasoning.appended event was lost from the compact event log.
    parts: [
      { type: "step-start" },
      {
        input: { command: "pwd" },
        output: "/workspace",
        state: "output-available",
        stepIndex: 0,
        toolCallId: "call-pwd",
        toolName: "bash",
        type: "dynamic-tool",
      },
      { state: "done", stepIndex: 0, text: "Planning the verification", type: "reasoning" },
    ],
    role: "assistant",
  };
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId }),
    event("actions.requested", startedAt, {
      actions: [{ callId: "call-pwd", input: { command: "pwd" }, kind: "tool-call", toolName: "bash" }],
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("action.result", endedAt, {
      result: { callId: "call-pwd", kind: "tool-result", output: "/workspace", toolName: "bash" },
      sequence: 0,
      status: "completed",
      stepIndex: 0,
      turnId,
    }),
    event("reasoning.completed", endedAt, {
      reasoning: "Planning the verification",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("turn.completed", endedAt, { sequence: 0, turnId }),
  ];

  const presentation = presentAgentTurn(message, events);
  assert.ok(presentation);
  assert.deepEqual(presentation.processParts.map((part) => part.type), [
    "step-start",
    "reasoning",
    "dynamic-tool",
  ]);
});

test("settled failed turns retain orphaned tool input snapshots as failed tools", () => {
  const messages: EveMessage[] = [{
    id: "turn-settled:assistant",
    metadata: { status: "complete", turnId: "turn-settled" },
    parts: [{
      input: { path: "/workspace/index.html" },
      inputText: '{"path":"/workspace/index.html"}',
      state: "input-streaming",
      stepIndex: 5,
      toolCallId: "call-write",
      toolName: "write_file",
      type: "dynamic-tool",
    }],
    role: "assistant",
  }];
  const events = [
    event("action.input.partial", startedAt, {
      callId: "call-write",
      input: { path: "/workspace/index.html" },
      inputTextDelta: "}",
      inputTextSoFar: '{"path":"/workspace/index.html"}',
      sequence: 0,
      stepIndex: 5,
      toolName: "write_file",
      turnId: "turn-settled",
    }),
    event("turn.completed", endedAt, { sequence: 0, turnId: "turn-settled" }),
  ];

  const settled = normalizeSettledAgentMessages(messages, events);
  const part = settled[0]?.parts[0];
  assert.equal(part?.type, "dynamic-tool");
  assert.equal(part?.state, "output-error");
  assert.equal((part as { readonly errorText?: string }).errorText, "Open Agent: tool call did not complete.");
});

test("recovery projects a failed partial tool call when Eve never emitted actions.requested", () => {
  const turnId = "turn-partial-failure";
  const messages: EveMessage[] = [{
    id: `${turnId}:assistant`,
    metadata: { status: "complete", turnId },
    parts: [{ type: "step-start" }],
    role: "assistant",
  }];
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId }),
    event("action.input.partial", endedAt, {
      callId: "call-partial",
      input: { path: "/workspace/index.html", patch: "@@" },
      inputTextDelta: "}",
      inputTextSoFar: '{"path":"/workspace/index.html","patch":"@@"}',
      sequence: 0,
      stepIndex: 0,
      toolName: "apply_patch",
      turnId,
    }),
    event("step.failed", endedAt, {
      code: "provider_stream_interrupted",
      message: "Provider stream interrupted.",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("turn.failed", endedAt, {
      code: "provider_stream_interrupted",
      message: "Provider stream interrupted.",
      turnId,
    }),
  ];

  const part = normalizeSettledAgentMessages(messages, events)[0]?.parts.at(-1);
  assert.equal(part?.type, "dynamic-tool");
  assert.equal(part?.state, "output-error");
  assert.equal((part as { readonly toolCallId?: string }).toolCallId, "call-partial");
  assert.equal((part as { readonly errorText?: string }).errorText, "Provider stream interrupted.");
});

test("cancelled turns retain the last tool input snapshot as an interrupted call", () => {
  const turnId = "turn-cancelled-tool";
  const callId = "call-edit";
  const messages: EveMessage[] = [{
    id: `${turnId}:assistant`,
    metadata: { status: "complete", turnId },
    parts: [{
      input: { path: "/workspace/index.html", patch: "@@ -1 +1 @@" },
      inputText: '{"path":"/workspace/index.html","patch":"@@ -1 +1 @@"}',
      state: "input-streaming",
      stepIndex: 0,
      toolCallId: callId,
      toolName: "apply_patch",
      type: "dynamic-tool",
    }],
    role: "assistant",
  }];
  const events = [
    event("action.input.partial", startedAt, {
      callId,
      input: { path: "/workspace/index.html", patch: "@@ -1 +1 @@" },
      inputTextDelta: "}",
      inputTextSoFar: '{"path":"/workspace/index.html","patch":"@@ -1 +1 @@"}',
      sequence: 0,
      stepIndex: 0,
      toolName: "apply_patch",
      turnId,
    }),
    event("turn.cancelled", endedAt, { sequence: 0, turnId }),
  ];

  const settled = normalizeSettledAgentMessages(messages, events);
  const part = settled[0]?.parts[0];
  assert.equal(part?.type, "dynamic-tool");
  assert.equal(part?.state, "output-error");
  assert.equal((part as { readonly input?: unknown }).input !== undefined, true);
  assert.equal((part as { readonly errorText?: string }).errorText, "Open Agent: tool call cancelled before completion.");
  assert.equal(sanitizeSettledThreadEvents(events).some((candidate) => candidate.type === "action.input.partial"), true);
});

test("settled turns close text deltas left in a streaming state", () => {
  const messages: EveMessage[] = [{
    id: "turn-text-settled:assistant",
    metadata: { status: "streaming", turnId: "turn-text-settled" },
    parts: [{ state: "streaming", stepIndex: 0, text: "partial", type: "text" }],
    role: "assistant",
  }];
  const settled = normalizeSettledAgentMessages(messages, [
    event("turn.completed", endedAt, { sequence: 0, turnId: "turn-text-settled" }),
  ]);
  assert.equal(settled[0]?.parts[0]?.type, "text");
  assert.equal(settled[0]?.parts[0]?.state, "done");
});

test("settled event projections remove failed tool input and its empty step marker", () => {
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-clean" }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-clean" }),
    event("actions.requested", startedAt, {
      actions: [{ callId: "call-good", input: { path: "/workspace/index.html" }, kind: "tool-call", toolName: "write_file" }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-clean",
    }),
    event("action.result", endedAt, {
      result: { callId: "call-good", kind: "tool-result", output: { path: "/workspace/index.html" }, toolName: "write_file" },
      sequence: 0,
      status: "completed",
      stepIndex: 0,
      turnId: "turn-clean",
    }),
    event("step.completed", endedAt, { finishReason: "tool-calls", sequence: 0, stepIndex: 0, turnId: "turn-clean" }),
    event("step.started", endedAt, { sequence: 1, stepIndex: 1, turnId: "turn-clean" }),
    event("action.input.partial", endedAt, {
      callId: "call-orphan",
      input: { path: "/workspace/styles.css", content: "partial" },
      inputTextDelta: "partial",
      inputTextSoFar: "{\"content\":\"partial\"}",
      sequence: 1,
      stepIndex: 1,
      toolName: "write_file",
      turnId: "turn-clean",
    }),
    event("turn.completed", endedAt, { sequence: 2, turnId: "turn-clean" }),
  ];
  const settled = sanitizeSettledThreadEvents(events);
  assert.equal(settled.some((event) => event.type === "action.input.partial"), false);
  assert.equal(settled.some((event) => event.type === "step.started" && event.data.stepIndex === 1), false);
  assert.equal(settled.some((event) => event.type === "action.result"), true);
});

test("settled projection drops orphan turns left after an interrupted admission", () => {
  const anchored = "turn-anchored";
  const orphan = "turn-orphan";
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: anchored }),
    event("message.received", startedAt, { message: "品牌名称改成妙思", parts: [], sequence: 0, turnId: anchored }),
    event("turn.completed", endedAt, { sequence: 0, turnId: anchored }),
    event("session.waiting", endedAt, { wait: "next-user-message" }),
    // No message.received exists for this turn. It is residual provider work,
    // not a second user submission, and must not reappear after refresh.
    event("reasoning.completed", endedAt, { reasoning: "残余思考", sequence: 1, stepIndex: 0, turnId: orphan }),
    event("message.completed", endedAt, { finishReason: "stop", message: "品牌名称已确认为妙思", sequence: 1, stepIndex: 0, turnId: orphan }),
    event("turn.completed", endedAt, { sequence: 1, turnId: orphan }),
    event("session.waiting", endedAt, { wait: "next-user-message" }),
    event("session.waiting", endedAt, { wait: "next-user-message" }),
  ];
  const settled = sanitizeSettledThreadEvents(events);
  assert.equal(settled.some((candidate) => "data" in candidate && candidate.data && "turnId" in candidate.data && candidate.data.turnId === orphan), false);
  assert.equal(settled.filter((candidate) => candidate.type === "session.waiting").length, 1);
  assert.equal(settled.some((candidate) => candidate.type === "message.received" && candidate.data.turnId === anchored), true);
});

test("settled projection keeps a real turn when only its message anchor was lost", () => {
  const turnId = "turn-anchor-lost";
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId }),
    event("message.completed", endedAt, {
      finishReason: "stop",
      message: "交付结果仍然存在",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("turn.completed", endedAt, { sequence: 0, turnId }),
  ];
  const settled = sanitizeSettledThreadEvents(events);
  assert.equal(settled.some((candidate) => candidate.type === "message.completed" && candidate.data.turnId === turnId), true);
  assert.equal(settled.some((candidate) => candidate.type === "turn.completed" && candidate.data.turnId === turnId), true);
});

test("settled turns keep a tool only when a durable result exists", () => {
  const messages: EveMessage[] = [{
    id: "turn-settled-result:assistant",
    metadata: { status: "complete", turnId: "turn-settled-result" },
    parts: [
      { type: "step-start" },
      {
        input: { path: "/workspace/index.html" },
        inputText: '{"path":"/workspace/index.html"}',
        state: "input-streaming",
        stepIndex: 0,
        toolCallId: "call-write",
        toolName: "write_file",
        type: "dynamic-tool",
      },
    ],
    role: "assistant",
  }];
  const events = [
    event("action.input.partial", startedAt, {
      callId: "call-write",
      input: { path: "/workspace/index.html" },
      inputTextDelta: "}",
      inputTextSoFar: '{"path":"/workspace/index.html"}',
      sequence: 0,
      stepIndex: 0,
      toolName: "write_file",
      turnId: "turn-settled-result",
    }),
    event("actions.requested", startedAt, {
      actions: [{ callId: "call-write", input: { path: "/workspace/index.html" }, kind: "tool-call", toolName: "write_file" }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-settled-result",
    }),
    event("action.result", endedAt, {
      result: { callId: "call-write", kind: "tool-result", output: { path: "/workspace/index.html", existed: false }, toolName: "write_file" },
      sequence: 0,
      status: "completed",
      stepIndex: 0,
      turnId: "turn-settled-result",
    }),
    event("step.completed", endedAt, { finishReason: "tool-calls", sequence: 0, stepIndex: 0, turnId: "turn-settled-result" }),
    event("turn.completed", endedAt, { sequence: 0, turnId: "turn-settled-result" }),
  ];

  const part = normalizeSettledAgentMessages(messages, events)[0]?.parts[1];
  assert.equal(part?.type, "dynamic-tool");
  assert.equal(part?.state, "output-available");
  assert.deepEqual((part as { output?: unknown }).output, { path: "/workspace/index.html", existed: false });
});

test("settled same-turn assistant segments keep tool results in their own segment", () => {
  const turnId = "turn-steered-settled";
  const messages: EveMessage[] = [
    {
      id: `${turnId}:assistant`,
      metadata: { status: "complete", turnId },
      parts: [{ type: "step-start" }, {
        input: { command: "pwd" },
        state: "input-available",
        stepIndex: 0,
        toolCallId: "call-before",
        toolName: "bash",
        type: "dynamic-tool",
      }],
      role: "assistant",
    },
    {
      id: `${turnId}:assistant:steer-1`,
      metadata: { status: "complete", turnId },
      parts: [{ type: "step-start" }, {
        input: { command: "npm test" },
        state: "input-available",
        stepIndex: 1,
        toolCallId: "call-after",
        toolName: "bash",
        type: "dynamic-tool",
      }],
      role: "assistant",
    },
  ];
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId }),
    event("message.received", startedAt, { message: "Build the site", parts: [], sequence: 0, turnId }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId }),
    event("actions.requested", startedAt, {
      actions: [{ callId: "call-before", input: { command: "pwd" }, kind: "tool-call", toolName: "bash" }],
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("action.result", startedAt, {
      result: { callId: "call-before", kind: "tool-result", output: "/workspace", toolName: "bash" },
      sequence: 0,
      status: "completed",
      stepIndex: 0,
      turnId,
    }),
    event("message.received", endedAt, {
      clientMessageId: "steer-1",
      message: "Use the blue design",
      parts: [],
      sequence: 0,
      turnId,
    }),
    event("step.started", endedAt, { sequence: 0, stepIndex: 1, turnId }),
    event("actions.requested", endedAt, {
      actions: [{ callId: "call-after", input: { command: "npm test" }, kind: "tool-call", toolName: "bash" }],
      sequence: 0,
      stepIndex: 1,
      turnId,
    }),
    event("action.result", endedAt, {
      result: { callId: "call-after", kind: "tool-result", output: "passed", toolName: "bash" },
      sequence: 0,
      status: "completed",
      stepIndex: 1,
      turnId,
    }),
    event("turn.completed", endedAt, { sequence: 0, turnId }),
  ];

  const settled = normalizeSettledAgentMessages(messages, events);
  const tools = settled.flatMap((message) => message.parts.filter((part) => part.type === "dynamic-tool"));
  assert.deepEqual(tools.map((part) => [part.toolCallId, part.state, part.errorText]), [
    ["call-before", "output-available", undefined],
    ["call-after", "output-available", undefined],
  ]);
});

test("settled transcripts retain an abandoned file write as a failed tool", () => {
  const messages: EveMessage[] = [{
    id: "turn-phantom:assistant",
    metadata: { status: "complete", turnId: "turn-phantom" },
    parts: [
      { type: "step-start" },
      { state: "done", stepIndex: 0, text: "Plan", type: "text" },
      { type: "step-start" },
      {
        input: { content: "partial file contents" },
        state: "input-streaming",
        stepIndex: 1,
        toolCallId: "call-orphan",
        toolName: "write_file",
        type: "dynamic-tool",
      },
      { type: "step-start" },
      { state: "done", stepIndex: 2, text: "Done", type: "text" },
    ],
    role: "assistant",
  }];
  const settled = normalizeSettledAgentMessages(messages, [
    event("turn.completed", endedAt, { sequence: 0, turnId: "turn-phantom" }),
  ]);
  assert.deepEqual(settled[0]?.parts.map((part) => part.type), ["step-start", "text", "step-start", "dynamic-tool", "step-start", "text"]);
  const failedTool = settled[0]?.parts[3];
  assert.equal(failedTool?.type, "dynamic-tool");
  assert.equal(failedTool?.state, "output-error");
});

test("tool turns retain every model-step boundary for live thinking activity", () => {
  const message: EveMessage = {
    id: "turn-running:assistant",
    metadata: { status: "streaming", turnId: "turn-running" },
    parts: [
      { type: "step-start" },
      {
        input: { command: "npm test" },
        output: "Tests passed",
        state: "output-available",
        stepIndex: 0,
        toolCallId: "call-test",
        toolName: "bash",
        type: "dynamic-tool",
      },
      { type: "step-start" },
    ],
    role: "assistant",
  };
  const events = [
    event("step.started", startedAt, {
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-running",
    }),
    event("actions.requested", startedAt, {
      actions: [{ callId: "call-test", input: { command: "npm test" }, kind: "tool-call", toolName: "bash" }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-running",
    }),
    event("step.completed", endedAt, {
      finishReason: "tool-calls",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-running",
    }),
    event("step.started", endedAt, {
      sequence: 0,
      stepIndex: 1,
      turnId: "turn-running",
    }),
  ];

  const presentation = presentAgentTurn(message, events);
  assert.ok(presentation);
  assert.equal(presentation.status, "running");
  assert.deepEqual(
    presentation.processParts.map((part) => part.type),
    ["step-start", "dynamic-tool", "step-start"],
  );
  assert.equal(presentAgentStep(events, "turn-running", 0).status, "completed");
  assert.equal(presentAgentStep(events, "turn-running", 1).status, "running");
});

test("a proxied child approval keeps its parent task visibly waiting", () => {
  const parent: EveMessage = {
    id: "turn-parent:assistant",
    metadata: { status: "complete", turnId: "turn-parent" },
    parts: [{
      input: { message: "Build the stylesheet" },
      state: "input-available",
      stepIndex: 0,
      toolCallId: "call-agent",
      toolMetadata: { eve: { kind: "subagent-call", name: "agent" } },
      toolName: "agent",
      type: "dynamic-tool",
    }],
    role: "assistant",
  };
  const child: EveMessage = {
    id: "turn-child:assistant",
    metadata: { status: "streaming", turnId: "turn-child" },
    parts: [
      { type: "step-start" },
      approvalPart("request-child", "call-bash"),
    ],
    role: "assistant",
  };
  const events = childApprovalEvents();

  const presentation = presentAgentTurn(parent, events);
  assert.ok(presentation);
  assert.equal(presentation.status, "waiting");
  assert.equal(presentation.proxiedInputParts.length, 1);
  assert.equal(presentation.proxiedInputParts[0]?.approval?.id, "request-child");
  assert.equal(hasUnresolvedInputRequests(events), true);
  assert.equal(isProxiedInputOnlyMessage(child, events), true);
});

test("subagent lifecycle stays distinct from generic provider waiting", () => {
  const running = childApprovalEvents().slice(0, 3);
  assert.deepEqual(presentSubagentCall(running, "call-agent"), {
    childSessionId: "child-session",
    name: "agent",
    startedAt: Date.parse(startedAt),
    status: "running",
  });

  const completed = [
    ...running,
    event("subagent.completed", endedAt, {
      callId: "call-agent",
      output: "Stylesheet complete",
      subagentName: "agent",
    }),
  ];
  assert.deepEqual(presentSubagentCall(completed, "call-agent"), {
    childSessionId: "child-session",
    endedAt: Date.parse(endedAt),
    name: "agent",
    startedAt: Date.parse(startedAt),
    status: "completed",
  });
  assert.deepEqual(presentSubagentCall([], "call-pending"), { status: "starting" });
});

test("a cancelled parent turn waits for the child cancellation boundary", () => {
  const running = childApprovalEvents().slice(0, 3);
  const cancelledAt = "2026-08-06T01:00:12.000Z";
  const events = [
    ...running,
    event("turn.cancelled", cancelledAt, { sequence: 0, turnId: "turn-parent" }),
    event("session.waiting", cancelledAt, { wait: "next-user-message" }),
  ];

  assert.deepEqual(presentSubagentCall(events, "call-agent"), {
    childSessionId: "child-session",
    name: "agent",
    startedAt: Date.parse(startedAt),
    status: "waiting",
  });
  assert.deepEqual(presentSubagentSessions(events), [{
    callId: "call-agent",
    childSessionId: "child-session",
    name: "agent",
    startedAt: Date.parse(startedAt),
    status: "waiting",
    task: "Build the stylesheet",
  }]);
});

test("the next root turn resolves a proxied child approval", () => {
  const events = [
    ...childApprovalEvents(),
    event("turn.started", "2026-08-06T01:00:10.000Z", { sequence: 1, turnId: "turn-next" }),
  ];
  assert.equal(hasUnresolvedInputRequests(events), false);

  const parent: EveMessage = {
    id: "turn-parent:assistant",
    metadata: { status: "complete", turnId: "turn-parent" },
    parts: [approvalPart("request-child", "call-bash")],
    role: "assistant",
  };
  assert.equal(presentAgentTurn(parent, events)?.status, "completed");
});

test("a root approval is not rendered twice", () => {
  const message: EveMessage = {
    id: "turn-parent:assistant",
    metadata: { status: "complete", turnId: "turn-parent" },
    parts: [approvalPart("request-root", "call-bash")],
    role: "assistant",
  };
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-parent" }),
    inputRequested("turn-parent", "request-root", "call-bash"),
    event("turn.completed", endedAt, { sequence: 0, turnId: "turn-parent" }),
    event("session.waiting", endedAt, { wait: "next-user-message" }),
  ];
  const presentation = presentAgentTurn(message, events);
  assert.ok(presentation);
  assert.equal(presentation.status, "waiting");
  assert.equal(presentation.processParts.length, 1);
  assert.equal(presentation.proxiedInputParts.length, 0);
});

test("a closed question is no longer blocking while its history remains presentable", () => {
  const message: EveMessage = {
    id: "turn-question:assistant",
    metadata: { status: "complete", turnId: "turn-question" },
    parts: [approvalPart("request-question", "call-question")],
    role: "assistant",
  };
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-question" }),
    inputRequested("turn-question", "request-question", "ask_question"),
    event("turn.completed", endedAt, { sequence: 0, turnId: "turn-question" }),
    event("session.waiting", endedAt, { wait: "input" }),
  ];

  assert.equal(hasUnresolvedInputRequests(events), true);
  assert.equal(hasUnresolvedInputRequests(events, new Set(["request-question"])), false);
  assert.equal(presentAgentTurn(message, events, new Set(["request-question"]))?.status, "completed");
});

test("a structured HITL continuation stays in one visual execution cycle", () => {
  const resumedAt = "2026-08-06T01:00:10.000Z";
  const deliveredAt = "2026-08-06T01:00:14.000Z";
  const messages: EveMessage[] = [
    {
      id: "turn-root:user",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [{ state: "done", text: "Clean the build output", type: "text" }],
      role: "user",
    },
    {
      id: "turn-root:assistant",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [
        { type: "step-start" },
        {
          input: { command: "rm -f /workspace/build.tmp" },
          output: "",
          state: "output-available",
          stepIndex: 0,
          toolCallId: "call-bash",
          toolName: "bash",
          type: "dynamic-tool",
        },
      ],
      role: "assistant",
    },
    {
      id: "turn-resume:assistant",
      metadata: { status: "complete", turnId: "turn-resume" },
      parts: [
        { type: "step-start" },
        { state: "done", stepIndex: 0, text: "The temporary output was removed.", type: "text" },
      ],
      role: "assistant",
    },
  ];
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-root" }),
    event("message.received", startedAt, {
      message: "Clean the build output",
      parts: [{ text: "Clean the build output", type: "text" }],
      sequence: 0,
      turnId: "turn-root",
    }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-root" }),
    event("actions.requested", startedAt, {
      actions: [{ callId: "call-bash", input: { command: "rm -f /workspace/build.tmp" }, kind: "tool-call", toolName: "bash" }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-root",
    }),
    inputRequested("turn-root", "request-bash", "call-bash"),
    event("turn.completed", endedAt, { sequence: 0, turnId: "turn-root" }),
    event("session.waiting", endedAt, { wait: "input" }),
    event("turn.started", resumedAt, { sequence: 1, turnId: "turn-resume" }),
    event("action.result", resumedAt, {
      result: { callId: "call-bash", kind: "tool-result", output: "", toolName: "bash" },
      sequence: 1,
      status: "completed",
      stepIndex: 0,
      turnId: "turn-resume",
    }),
    event("step.started", resumedAt, { sequence: 1, stepIndex: 0, turnId: "turn-resume" }),
    event("message.completed", deliveredAt, {
      finishReason: "stop",
      message: "The temporary output was removed.",
      sequence: 1,
      stepIndex: 0,
      turnId: "turn-resume",
    }),
    event("step.completed", deliveredAt, {
      finishReason: "stop",
      sequence: 1,
      stepIndex: 0,
      turnId: "turn-resume",
    }),
    event("turn.completed", deliveredAt, { sequence: 1, turnId: "turn-resume" }),
    event("session.waiting", deliveredAt, { wait: "next-user-message" }),
  ];

  const projection = projectAgentDisplayTimeline(messages, events);
  assert.equal(projection.messages.length, 2);
  const assistant = projection.messages[1];
  assert.equal(assistant?.role, "assistant");
  assert.equal(assistant?.metadata?.turnId, "turn-root");
  assert.equal(assistant?.parts.filter((part) => part.type === "step-start").length, 2);
  assert.equal(
    assistant?.parts.find((part) => part.type === "text")?.stepIndex,
    1,
  );
  assert.equal(projection.events.filter((candidate) => candidate.type === "turn.completed").length, 1);
  assert.equal(projection.events.filter((candidate) => candidate.type === "session.waiting").length, 1);
  assert.ok(projection.events
    .filter((candidate) => candidate.type === "step.started")
    .some((candidate) => candidate.data.turnId === "turn-root" && candidate.data.stepIndex === 1));
  const presentation = presentAgentTurn(assistant!, projection.events);
  assert.equal(presentation?.status, "completed");
  assert.equal(presentation?.finalPart?.text, "The temporary output was removed.");
});

test("same-turn steering remains between the Agent output produced before and after admission", () => {
  const messages: EveMessage[] = [
    {
      id: "turn-root:user",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [{ state: "done", text: "Build the site", type: "text" }],
      role: "user",
    },
    {
      id: "turn-root:assistant",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [
        { type: "step-start" },
        { state: "done", stepIndex: 0, text: "I inspected the existing files.", type: "text" },
      ],
      role: "assistant",
    },
    {
      id: "turn-root:user:client-steer-1",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [{ state: "done", text: "Use the blue design", type: "text" }],
      role: "user",
    },
    {
      id: "turn-root:assistant:client-steer-1",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [
        { type: "step-start" },
        { state: "done", stepIndex: 1, text: "The blue design is ready.", type: "text" },
      ],
      role: "assistant",
    },
  ];
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-root" }),
    event("message.received", startedAt, {
      message: "Build the site",
      sequence: 0,
      turnId: "turn-root",
    }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-root" }),
    event("message.completed", startedAt, {
      finishReason: "tool-calls",
      message: "I inspected the existing files.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-root",
    }),
    event("message.received", endedAt, {
      clientMessageId: "client-steer-1",
      message: "Use the blue design",
      sequence: 0,
      turnId: "turn-root",
    }),
    event("step.started", endedAt, { sequence: 0, stepIndex: 1, turnId: "turn-root" }),
    event("message.completed", endedAt, {
      finishReason: "stop",
      message: "The blue design is ready.",
      sequence: 0,
      stepIndex: 1,
      turnId: "turn-root",
    }),
  ];

  const projection = projectAgentDisplayTimeline(messages, events);

  assert.deepEqual(projection.messages.map((message) => ({ id: message.id, role: message.role })), [
    { id: "turn-root:user", role: "user" },
    { id: "turn-root:assistant", role: "assistant" },
    { id: "turn-root:user:client-steer-1", role: "user" },
    { id: "turn-root:assistant:client-steer-1", role: "assistant" },
  ]);
  const beforeSteering = projection.messages[1];
  const afterSteering = projection.messages[3];
  assert.ok(beforeSteering);
  assert.ok(afterSteering);
  assert.equal(presentAgentTurn(beforeSteering, projection.events), undefined);
  assert.equal(presentAgentTurn(afterSteering, projection.events), undefined);
});

test("same-turn steering shares one visual execution timer while preserving message order", () => {
  const steeredAt = "2026-08-06T01:00:05.000Z";
  const deliveredAt = "2026-08-06T01:00:12.000Z";
  const messages: EveMessage[] = [
    {
      id: "turn-root:assistant",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [
        { type: "step-start" },
        { state: "done", stepIndex: 0, text: "I inspected the existing files.", type: "text" },
      ],
      role: "assistant",
    },
    {
      id: "turn-root:assistant:client-steer-1",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [
        { type: "step-start" },
        { state: "done", stepIndex: 1, text: "The blue design is ready.", type: "text" },
      ],
      role: "assistant",
    },
  ];
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-root" }),
    event("message.received", startedAt, { message: "Build the site", sequence: 0, turnId: "turn-root" }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-root" }),
    event("actions.requested", startedAt, {
      actions: [{ callId: "call-before", input: { command: "find ." }, kind: "tool-call", toolName: "bash" }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-root",
    }),
    event("message.completed", startedAt, {
      finishReason: "tool-calls",
      message: "I inspected the existing files.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-root",
    }),
    event("message.received", steeredAt, {
      clientMessageId: "client-steer-1",
      message: "Use the blue design",
      sequence: 0,
      turnId: "turn-root",
    }),
    event("step.started", steeredAt, { sequence: 0, stepIndex: 1, turnId: "turn-root" }),
    event("message.completed", deliveredAt, {
      finishReason: "stop",
      message: "The blue design is ready.",
      sequence: 0,
      stepIndex: 1,
      turnId: "turn-root",
    }),
    event("turn.completed", deliveredAt, { sequence: 0, turnId: "turn-root" }),
  ];

  const projection = projectAgentDisplayTimeline([
    {
      id: "turn-root:user",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [{ state: "done", text: "Build the site", type: "text" }],
      role: "user",
    },
    {
      id: "turn-root:assistant",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [{ type: "step-start" }, { state: "done", stepIndex: 0, text: "I inspected the existing files.", type: "text" }],
      role: "assistant",
    },
    {
      id: "turn-root:user:client-steer-1",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [{ state: "done", text: "Use the blue design", type: "text" }],
      role: "user",
    },
    {
      id: "turn-root:assistant:client-steer-1",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [{ type: "step-start" }, { state: "done", stepIndex: 1, text: "The blue design is ready.", type: "text" }],
      role: "assistant",
    },
  ], events);
  const before = projection.messages[1]!;
  const after = projection.messages[3]!;
  const beforeTask = presentAgentTurn(before, projection.events, new Set(), { mergeSameTurn: true });
  const afterTask = presentAgentTurn(after, projection.events, new Set(), { mergeSameTurn: true });

  assert.equal(beforeTask?.status, "completed");
  assert.equal(beforeTask?.startedAt, Date.parse(startedAt));
  assert.equal(beforeTask?.endedAt, Date.parse(deliveredAt));
  assert.equal(beforeTask?.finalPart, undefined);
  assert.equal(afterTask?.startedAt, Date.parse(startedAt));
  assert.equal(afterTask?.endedAt, Date.parse(deliveredAt));
  assert.equal(afterTask?.finalPart?.text, "The blue design is ready.");
  const liveProjection = projectAgentDisplayTimeline(
    [
      projection.messages[0]!,
      projection.messages[1]!,
      projection.messages[2]!,
      projection.messages[3]!,
    ],
    events.slice(0, -1),
  );
  assert.equal(
    presentAgentTurn(liveProjection.messages[1]!, liveProjection.events, new Set(), { mergeSameTurn: true })?.status,
    "running",
  );
  assert.deepEqual(
    projection.messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
});

test("same-turn user messages retain distinct stable ids during the optimistic handoff", () => {
  assert.equal(
    stableUserMessageId("turn-root:user", "turn-root", "pending-root"),
    "pending-root:user",
  );
  assert.equal(
    stableUserMessageId("turn-root:user:client-steer-1", "turn-root", "pending-root"),
    "pending-root:user:client-steer-1",
  );
  assert.notEqual(
    stableUserMessageId("turn-root:user", "turn-root", "pending-root"),
    stableUserMessageId("turn-root:user:client-steer-1", "turn-root", "pending-root"),
  );
});

test("unanchored independent turns are not merged into the previous execution", () => {
  const messages: EveMessage[] = [
    {
      id: "turn-root:assistant",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [{ type: "step-start" }, { state: "done", stepIndex: 0, text: "First result", type: "text" }],
      role: "assistant",
    },
    {
      id: "turn-orphan:assistant",
      metadata: { status: "complete", turnId: "turn-orphan" },
      parts: [{ type: "step-start" }, { state: "done", stepIndex: 0, text: "Second result", type: "text" }],
      role: "assistant",
    },
  ];
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-root" }),
    event("message.received", startedAt, { message: "First", sequence: 0, turnId: "turn-root" }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-root" }),
    event("message.completed", endedAt, { finishReason: "stop", message: "First result", sequence: 0, stepIndex: 0, turnId: "turn-root" }),
    event("turn.completed", endedAt, { sequence: 0, turnId: "turn-root" }),
    event("turn.started", endedAt, { sequence: 1, turnId: "turn-orphan" }),
    event("step.started", endedAt, { sequence: 1, stepIndex: 0, turnId: "turn-orphan" }),
    event("message.completed", endedAt, { finishReason: "stop", message: "Second result", sequence: 1, stepIndex: 0, turnId: "turn-orphan" }),
    event("turn.completed", endedAt, { sequence: 1, turnId: "turn-orphan" }),
  ];
  const projection = projectAgentDisplayTimeline(messages, events);
  assert.deepEqual(projection.messages.map((message) => message.metadata?.turnId), ["turn-root", "turn-orphan"]);
});

test("an unanchored HITL continuation stays in the owning execution", () => {
  const messages: EveMessage[] = [
    {
      id: "turn-root:assistant",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [{ type: "step-start" }, { state: "done", stepIndex: 0, text: "Before approval", type: "text" }],
      role: "assistant",
    },
    {
      id: "turn-resume:assistant",
      metadata: { status: "complete", turnId: "turn-resume" },
      parts: [{ type: "step-start" }, { state: "done", stepIndex: 0, text: "After approval", type: "text" }],
      role: "assistant",
    },
  ];
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-root" }),
    event("message.received", startedAt, { message: "First", sequence: 0, turnId: "turn-root" }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-root" }),
    event("input.requested", endedAt, { requests: [], sequence: 0, stepIndex: 0, turnId: "turn-root" }),
    event("turn.completed", endedAt, { sequence: 0, turnId: "turn-root" }),
    event("turn.started", endedAt, { sequence: 1, turnId: "turn-resume" }),
    event("step.started", endedAt, { sequence: 1, stepIndex: 0, turnId: "turn-resume" }),
    event("message.completed", endedAt, { finishReason: "stop", message: "After approval", sequence: 1, stepIndex: 0, turnId: "turn-resume" }),
    event("turn.completed", endedAt, { sequence: 1, turnId: "turn-resume" }),
  ];
  const projection = projectAgentDisplayTimeline(messages, events);
  assert.equal(projection.messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(projection.messages.find((message) => message.role === "assistant")?.metadata?.turnId, "turn-root");
});

test("HITL continuation snapshots keep an earlier approval response", () => {
  const messages: EveMessage[] = [
    {
      id: "turn-root:assistant",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [approvalPart("request-tool", "call-tool")],
      role: "assistant",
    },
    {
      id: "turn-resume:assistant",
      metadata: { status: "complete", turnId: "turn-resume" },
      parts: [{
        input: { command: "npm test" },
        output: "passed",
        state: "output-available",
        stepIndex: 0,
        toolCallId: "call-tool",
        toolName: "bash",
        type: "dynamic-tool",
      }],
      role: "assistant",
    },
  ];
  const first = messages[0]!.parts[0];
  if (first?.type !== "dynamic-tool") throw new Error("expected a dynamic tool part");
  const withResponse = {
    ...first,
    toolMetadata: {
      ...first.toolMetadata,
      eve: {
        ...first.toolMetadata?.eve,
        kind: first.toolMetadata?.eve?.kind ?? "tool-call",
        name: first.toolMetadata?.eve?.name ?? first.toolName,
        inputResponse: { optionId: "approve", requestId: "request-tool" },
      },
    },
  };
  messages[0] = { ...messages[0]!, parts: [withResponse] };

  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-root" }),
    event("message.received", startedAt, { message: "Run the command", sequence: 0, turnId: "turn-root" }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-root" }),
    event("input.requested", endedAt, { requests: [], sequence: 0, stepIndex: 0, turnId: "turn-root" }),
    event("turn.started", endedAt, { sequence: 1, turnId: "turn-resume" }),
    event("step.started", endedAt, { sequence: 1, stepIndex: 0, turnId: "turn-resume" }),
  ];
  const projection = projectAgentDisplayTimeline(messages, events);
  const merged = projection.messages.find((message) => message.role === "assistant");
  assert.ok(merged);
  const tool = merged.parts.find((part) => part.type === "dynamic-tool");
  assert.equal(tool?.type, "dynamic-tool");
  assert.equal(tool?.state, "output-available");
  assert.equal(tool?.toolMetadata?.eve?.inputResponse?.optionId, "approve");
});

test("same-turn steering scopes tool process groups to their assistant segment", () => {
  const steeredAt = "2026-08-06T01:00:05.000Z";
  const deliveredAt = "2026-08-06T01:00:12.000Z";
  const messages: EveMessage[] = [
    {
      id: "turn-root:user",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [{ state: "done", text: "Build the site", type: "text" }],
      role: "user",
    },
    {
      id: "turn-root:assistant",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [
        { type: "step-start" },
        {
          input: { command: "find . -type f" },
          output: "./index.html",
          state: "output-available",
          stepIndex: 0,
          toolCallId: "call-before",
          toolName: "bash",
          type: "dynamic-tool",
        },
      ],
      role: "assistant",
    },
    {
      id: "turn-root:user:client-steer-1",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [{ state: "done", text: "Use the blue design", type: "text" }],
      role: "user",
    },
    {
      id: "turn-root:assistant:client-steer-1",
      metadata: { status: "complete", turnId: "turn-root" },
      parts: [
        { type: "step-start" },
        {
          input: { command: "npm test" },
          output: "passed",
          state: "output-available",
          stepIndex: 1,
          toolCallId: "call-after",
          toolName: "bash",
          type: "dynamic-tool",
        },
        { type: "step-start" },
        { state: "done", stepIndex: 2, text: "The blue design is ready.", type: "text" },
      ],
      role: "assistant",
    },
  ];
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-root" }),
    event("message.received", startedAt, { message: "Build the site", sequence: 0, turnId: "turn-root" }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-root" }),
    event("actions.requested", startedAt, {
      actions: [{ callId: "call-before", input: { command: "find . -type f" }, kind: "tool-call", toolName: "bash" }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-root",
    }),
    event("message.received", steeredAt, {
      clientMessageId: "client-steer-1",
      message: "Use the blue design",
      sequence: 0,
      turnId: "turn-root",
    }),
    event("step.started", steeredAt, { sequence: 0, stepIndex: 1, turnId: "turn-root" }),
    event("actions.requested", steeredAt, {
      actions: [{ callId: "call-after", input: { command: "npm test" }, kind: "tool-call", toolName: "bash" }],
      sequence: 0,
      stepIndex: 1,
      turnId: "turn-root",
    }),
    event("message.completed", deliveredAt, {
      finishReason: "stop",
      message: "The blue design is ready.",
      sequence: 0,
      stepIndex: 2,
      turnId: "turn-root",
    }),
    event("turn.completed", deliveredAt, { sequence: 0, turnId: "turn-root" }),
  ];

  const projection = projectAgentDisplayTimeline(messages, events);
  const before = presentAgentTurn(projection.messages[1]!, projection.events);
  const after = presentAgentTurn(projection.messages[3]!, projection.events);

  assert.equal(before?.status, "completed");
  assert.equal(before?.endedAt, Date.parse(steeredAt));
  assert.deepEqual(
    before?.processParts.filter((part) => part.type === "dynamic-tool").map((part) => part.toolCallId),
    ["call-before"],
  );
  assert.equal(before?.finalPart, undefined);
  assert.equal(after?.status, "completed");
  assert.deepEqual(
    after?.processParts.filter((part) => part.type === "dynamic-tool").map((part) => part.toolCallId),
    ["call-after"],
  );
  assert.equal(after?.finalPart?.text, "The blue design is ready.");
});

test("an interrupted durable model step remains visibly retrying", () => {
  const failedAt = "2026-08-06T01:00:03.000Z";
  const retriedAt = "2026-08-06T01:00:04.000Z";
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-retry" }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-retry" }),
    event("step.failed", failedAt, {
      code: "provider_stream_interrupted",
      message: "The Provider stream ended before completion.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-retry",
    }),
    event("step.started", retriedAt, { sequence: 0, stepIndex: 0, turnId: "turn-retry" }),
  ];

  assert.deepEqual(presentAgentStep(events, "turn-retry", 0), {
    retries: [{
      attempt: 1,
      error: {
        code: "MODEL_CALL_FAILED",
        message: "The Provider stream ended before completion.",
      },
      maximum: 3,
    }],
    retry: {
      attempt: 1,
      error: {
        code: "MODEL_CALL_FAILED",
        message: "The Provider stream ended before completion.",
      },
      maximum: 3,
    },
    startedAt: Date.parse(retriedAt),
    status: "running",
  });
});

test("a terminal step failure is attached to its step and does not masquerade as a retry", () => {
  const failedAt = "2026-08-06T01:00:03.000Z";
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-failed" }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-failed" }),
    event("step.failed", failedAt, {
      code: "provider_rejected",
      message: "The model Provider rejected this turn.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-failed",
    }),
    event("turn.failed", failedAt, {
      code: "provider_rejected",
      message: "The model Provider rejected this turn.",
      sequence: 0,
      turnId: "turn-failed",
    }),
  ];

  assert.deepEqual(presentAgentStep(events, "turn-failed", 0), {
    endedAt: Date.parse(failedAt),
    failure: {
      code: "provider_rejected",
      message: "The model Provider rejected this turn.",
    },
    startedAt: Date.parse(startedAt),
    status: "failed",
  });
});

test("an exhausted transient provider failure is presented as retry failed with its diagnostics", () => {
  const failedAt = "2026-08-06T01:00:03.000Z";
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-retry-exhausted" }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-retry-exhausted" }),
    event("step.failed", failedAt, {
      code: "MODEL_CALL_FAILED",
      message: "The model Provider request timed out.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-retry-exhausted",
    }),
    event("turn.failed", failedAt, {
      code: "MODEL_CALL_FAILED",
      message: "The model Provider request timed out.",
      sequence: 0,
      turnId: "turn-retry-exhausted",
    }),
  ];

  assert.deepEqual(presentAgentStep(events, "turn-retry-exhausted", 0), {
    endedAt: Date.parse(failedAt),
    failure: {
      code: "MODEL_CALL_FAILED",
      message: "The model Provider request timed out.",
    },
    retry: {
      attempt: 1,
      error: {
        code: "MODEL_CALL_FAILED",
        message: "The model Provider request timed out.",
      },
      exhausted: true,
      maximum: 3,
    },
    retries: [{
      attempt: 1,
      error: {
        code: "MODEL_CALL_FAILED",
        message: "The model Provider request timed out.",
      },
      exhausted: true,
      maximum: 3,
    }],
    startedAt: Date.parse(startedAt),
    status: "failed",
  });
});

test("explicit model retry events preserve each real attempt number", () => {
  const turnId = "turn-explicit-retries";
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId }),
    event("model.retrying" as MessageStreamEvent["type"], "2026-08-06T01:00:01.000Z", {
      attempt: 1,
      maximum: 3,
      error: { code: "EveOwnedProviderAttemptError", message: "The model Provider request failed (HTTP 404).", statusCode: 404 },
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("model.retrying" as MessageStreamEvent["type"], "2026-08-06T01:00:02.000Z", {
      attempt: 2,
      maximum: 3,
      error: { code: "EveOwnedProviderAttemptError", message: "The model Provider request failed (HTTP 404).", statusCode: 404 },
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("model.retrying" as MessageStreamEvent["type"], "2026-08-06T01:00:03.000Z", {
      attempt: 3,
      maximum: 3,
      error: { code: "EveOwnedProviderAttemptError", message: "The model Provider request failed (HTTP 404).", statusCode: 404 },
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("step.failed", endedAt, {
      code: "MODEL_CALL_FAILED",
      details: { statusCode: 404 },
      message: "The model Provider request failed (HTTP 404).",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("turn.failed", endedAt, {
      code: "MODEL_CALL_FAILED",
      details: { statusCode: 404 },
      message: "The model Provider request failed (HTTP 404).",
      sequence: 0,
      turnId,
    }),
  ];
  const presentation = presentAgentStep(events, turnId, 0);
  assert.deepEqual(presentation.retries?.map((retry) => [retry.attempt, retry.maximum]), [[1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(presentation.retries?.map((retry) => retry.error.code), ["MODEL_CALL_FAILED", "MODEL_CALL_FAILED", "MODEL_CALL_FAILED"]);
  assert.equal(presentation.retry?.attempt, 3);
  assert.equal(presentation.retry?.exhausted, true);
});

test("preserves earlier failed tool attempts when Eve reuses a call id", () => {
  const turnId = "turn-retry-tool";
  const message: EveMessage = {
    id: `${turnId}:assistant`,
    metadata: { status: "complete", turnId },
    parts: [{ type: "step-start" }, {
      input: { path: "index.html", content: "final" },
      output: { path: "index.html", content: "final" },
      state: "output-available",
      stepIndex: 0,
      toolCallId: "call-edit",
      toolName: "edit_file",
      type: "dynamic-tool",
    }],
    role: "assistant",
  };
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId }),
    event("actions.requested", startedAt, {
      actions: [{ callId: "call-edit", input: { path: "index.html", content: "partial" }, kind: "tool-call", toolName: "edit_file" }],
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("step.failed", endedAt, {
      code: "PATCH_INVALID",
      message: "Patch failed",
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("step.started", endedAt, { sequence: 0, stepIndex: 0, turnId }),
    event("actions.requested", endedAt, {
      actions: [{ callId: "call-edit", input: { path: "index.html", content: "final" }, kind: "tool-call", toolName: "edit_file" }],
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("action.result", endedAt, {
      result: { callId: "call-edit", kind: "tool-result", output: { path: "index.html", content: "final" }, toolName: "edit_file" },
      sequence: 0,
      status: "completed",
      stepIndex: 0,
      turnId,
    }),
    event("step.completed", endedAt, { finishReason: "tool-calls", sequence: 0, stepIndex: 0, turnId }),
    event("turn.completed", endedAt, { sequence: 0, turnId }),
  ];

  const projected = normalizeSettledAgentMessages([message], events)[0]!;
  assert.equal(projected.parts.filter((part) => part.type === "dynamic-tool").length, 2);
  const failed = projected.parts.find((part) => part.type === "dynamic-tool" && part.state === "output-error");
  assert.equal(failed?.type, "dynamic-tool");
  if (failed?.type === "dynamic-tool") {
    assert.match(failed.toolCallId, /^retry:turn-retry-tool:0:/);
    assert.equal(failed.errorText, "Patch failed");
  }
});

test("an unknown terminal failure remains an execution failure instead of a retry failure", () => {
  const failedAt = "2026-08-06T01:00:03.000Z";
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-unknown-failure" }),
    event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-unknown-failure" }),
    event("step.failed", failedAt, {
      code: "WORKSPACE_CORRUPTED",
      message: "The workspace state is inconsistent.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-unknown-failure",
    }),
    event("turn.failed", failedAt, {
      code: "WORKSPACE_CORRUPTED",
      message: "The workspace state is inconsistent.",
      sequence: 0,
      turnId: "turn-unknown-failure",
    }),
  ];

  const presentation = presentAgentStep(events, "turn-unknown-failure", 0);
  assert.equal(presentation.retry, undefined);
  assert.equal(presentation.failure?.code, "WORKSPACE_CORRUPTED");
  assert.equal(presentation.status, "failed");
});

test("normal and recovery activity use one calm thinking state without transport details", () => {
  const messages = messagesFor("en");
  const events = [event("step.started", startedAt, { sequence: 0, stepIndex: 0, turnId: "turn-task" })];
  const base = Date.parse(startedAt);
  assert.equal(activityLabel(events, messages, { mountedAt: base, now: base + 16_000 }), messages.thinking);
  assert.equal(activityLabel(events, messages, { mountedAt: base, now: base + 46_000 }), messages.thinking);
  assert.equal(activityLabel(events, messages, { mode: "recovery", mountedAt: base, now: base + 10_000 }), messages.thinking);
  assert.equal(activityLabel(events, messages, { mode: "recovery", mountedAt: base, now: base + 46_000 }), messages.thinking);
});

test("edit and resend keeps only events settled before the latest user turn", () => {
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-1" }),
    event("message.received", startedAt, { message: "First", parts: [{ text: "First", type: "text" }], sequence: 0, turnId: "turn-1" }),
    event("turn.completed", startedAt, { sequence: 0, turnId: "turn-1" }),
    event("session.waiting", startedAt, { wait: "next-user-message" }),
    event("turn.started", endedAt, { sequence: 1, turnId: "turn-2" }),
    event("message.received", endedAt, { message: "Edit me", parts: [{ text: "Edit me", type: "text" }], sequence: 1, turnId: "turn-2" }),
    event("turn.completed", endedAt, { sequence: 1, turnId: "turn-2" }),
  ];

  assert.deepEqual(eventsBeforeLastUserTurn(events), events.slice(0, 4));
  assert.deepEqual(eventsBeforeLastUserTurn(events.slice(4)), []);
  assert.deepEqual(eventsBeforeLastUserTurn([]), []);
});

test("a persisted turn failure overrides stale client stream state for editing", () => {
  const running = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-edit" }),
    event("message.received", startedAt, { message: "Edit me", parts: [{ text: "Edit me", type: "text" }], sequence: 0, turnId: "turn-edit" }),
  ];
  assert.equal(hasSettledLatestTurn(running), false);
  assert.equal(hasSettledLatestTurn([
    ...running,
    event("turn.completed", endedAt, { sequence: 0, turnId: "turn-edit" }),
  ]), true);
  assert.equal(hasSettledLatestTurn([
    ...running,
    event("session.waiting", endedAt, { wait: "next-user-message" }),
  ]), true);
  // Eve may append a non-lifecycle observation after the waiting boundary
  // while a client checkpoint is being committed. The completed turn remains
  // settled in that snapshot.
  assert.equal(hasSettledLatestTurn([
    ...running,
    event("session.waiting", endedAt, { wait: "next-user-message" }),
    event("message.appended", endedAt, { messageSoFar: "checkpoint flushed", sequence: 0, stepIndex: 0, turnId: "turn-edit" }),
  ]), true);
  // A historical boundary must never settle a newer turn that started after
  // it, even when the newer turn has not emitted its first model step yet.
  assert.equal(hasSettledLatestTurn([
    ...running,
    event("session.waiting", endedAt, { wait: "next-user-message" }),
    event("turn.started", endedAt, { sequence: 1, turnId: "turn-next" }),
  ]), false);
  assert.equal(hasSettledLatestTurn([
    ...running,
    event("turn.failed", endedAt, { code: "provider_error", message: "Failed", sequence: 0, turnId: "turn-edit" }),
    event("session.failed", endedAt, { code: "provider_error", message: "Failed" }),
  ]), true);
  assert.equal(hasSettledLatestTurn([
    ...running,
    event("session.completed", endedAt, { sequence: 0 }),
  ]), true);
  // A provider can fail while the first turn is being admitted, before Eve
  // publishes `turn.started`. The session failure still settles that request.
  assert.equal(hasSettledLatestTurn([
    event("session.started", startedAt, { sessionId: "session-failed-before-turn" }),
    event("session.failed", endedAt, { code: "MODEL_CALL_FAILED", message: "HTTP 404" }),
  ]), true);
});

test("terminal session boundaries disable edit capability without hiding waiting sessions", () => {
  assert.equal(hasTerminalSessionBoundary([
    event("session.started", startedAt, { sessionId: "waiting-session" }),
    event("session.waiting", endedAt, { wait: "next-user-message" }),
  ]), false);
  assert.equal(hasTerminalSessionBoundary([
    event("session.started", startedAt, { sessionId: "failed-session" }),
    event("session.failed", endedAt, { code: "MODEL_CALL_FAILED", message: "HTTP 404" }),
  ]), true);
  assert.equal(hasTerminalSessionBoundary([
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-next" }),
    event("session.failed", endedAt, { code: "MODEL_CALL_FAILED", message: "HTTP 404" }),
    event("turn.started", endedAt, { sequence: 1, turnId: "turn-newer" }),
  ]), false);
});

test("a terminal provider failure without a turn boundary anchors to its final step", () => {
  const turnId = "turn-session-failed";
  const message: EveMessage = {
    id: `${turnId}:assistant`,
    metadata: { status: "streaming", turnId },
    parts: [{ type: "step-start" }],
    role: "assistant",
  };
  const events = [
    event("turn.started", startedAt, { sequence: 0, turnId }),
    event("actions.requested", startedAt, {
      actions: [{ callId: "call-session-failed", input: { command: "npm test" }, kind: "tool-call", toolName: "bash" }],
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    event("session.failed", endedAt, { code: "provider_stream_interrupted", message: "The Provider stream ended before completion." }),
  ];
  const presentation = presentAgentTurn(message, events);
  assert.equal(presentation?.status, "failed");
  assert.equal(presentation?.failureAnchored, true);
});

test("context usage moves during a streamed step and reconciles to Provider usage", () => {
  const initial = [
    event("step.completed", startedAt, {
      finishReason: "tool-calls",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-task",
      usage: { inputTokens: 1_000, outputTokens: 200 },
    }),
  ];
  const streaming = [
    ...initial,
    event("message.appended", endedAt, {
      messageDelta: "x".repeat(80),
      messageSoFar: "x".repeat(80),
      sequence: 0,
      stepIndex: 1,
      turnId: "turn-task",
    }),
  ];

  assert.deepEqual(summarizeUsage(initial), {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextInputTokens: 1_000,
    costUsd: 0,
    inputTokens: 1_000,
    isEstimated: false,
    outputTokens: 200,
    steps: 1,
  });
  const live = summarizeUsage(streaming);
  assert.equal(live.contextInputTokens, 1_020);
  assert.equal(live.outputTokens, 220);
  assert.equal(live.isEstimated, true);

  const reconciled = summarizeUsage([
    ...streaming,
    event("step.completed", endedAt, {
      finishReason: "stop",
      sequence: 0,
      stepIndex: 1,
      turnId: "turn-task",
      usage: { inputTokens: 1_250, outputTokens: 30 },
    }),
  ]);
  assert.equal(reconciled.contextInputTokens, 1_250);
  assert.equal(reconciled.outputTokens, 230);
  assert.equal(reconciled.isEstimated, false);
});

test("pending admission never aliases a historical turn whose terminal event is delayed", () => {
  const submittedAt = Date.parse("2026-08-06T01:01:00.000Z");
  const historical = [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-previous" }),
    event("reasoning.appended", endedAt, {
      reasoningDelta: "stale reasoning",
      reasoningSoFar: "stale reasoning",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-previous",
    }),
  ];
  const pending = {
    eventCountAtSubmission: historical.length,
    submittedAt,
  };

  // The throttled snapshot is missing the previous turn's terminal event.
  assert.equal(activeTurnIdAfterPendingSubmission(historical, pending), undefined);
  assert.equal(
    activeTurnIdAfterPendingSubmission([
      ...historical,
      event("turn.started", "2026-08-06T01:01:01.000Z", { sequence: 1, turnId: "turn-current" }),
    ], pending),
    "turn-current",
  );
});

function event(
  type: MessageStreamEvent["type"],
  at: string,
  data: Record<string, unknown>,
): MessageStreamEvent {
  return { data, meta: { at }, type } as MessageStreamEvent;
}

function childApprovalEvents(): MessageStreamEvent[] {
  return [
    event("turn.started", startedAt, { sequence: 0, turnId: "turn-parent" }),
    event("actions.requested", startedAt, {
      actions: [{ callId: "call-agent", input: { message: "Build the stylesheet" }, kind: "subagent-call", name: "agent" }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-parent",
    }),
    event("subagent.called", startedAt, {
      callId: "call-agent",
      childSessionId: "child-session",
      name: "agent",
      sequence: 0,
      sessionId: "parent-session",
      toolName: "agent",
      turnId: "turn-parent",
      workflowId: "child-workflow",
    }),
    inputRequested("turn-child", "request-child", "call-bash"),
    event("turn.completed", endedAt, { sequence: 0, turnId: "turn-parent" }),
    event("session.waiting", endedAt, { wait: "next-user-message" }),
  ];
}

function inputRequested(turnId: string, requestId: string, callId: string): MessageStreamEvent {
  return event("input.requested", endedAt, {
    requests: [{
      action: { callId, input: { command: "npm test && rm -f /tmp/test-output" }, kind: "tool-call", toolName: "bash" },
      display: "confirmation",
      options: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
      prompt: "Allow this terminal command?",
      requestId,
    }],
    sequence: 0,
    stepIndex: 0,
    turnId,
  });
}

function approvalPart(requestId: string, callId: string): EveMessage["parts"][number] {
  return {
    approval: { id: requestId },
    input: { command: "npm test && rm -f /tmp/test-output" },
    state: "approval-requested",
    stepIndex: 0,
    toolCallId: callId,
    toolMetadata: {
      eve: {
        inputRequest: {
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "deny", label: "Deny", style: "danger" },
          ],
          prompt: "Allow this terminal command?",
          requestId,
        },
        kind: "tool-call",
        name: "bash",
      },
    },
    toolName: "bash",
    type: "dynamic-tool",
  };
}
