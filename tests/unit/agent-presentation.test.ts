import assert from "node:assert/strict";
import test from "node:test";

import type { MessageStreamEvent } from "eve/client";
import type { EveMessage } from "eve/react";
import { activityLabel } from "../../packages/agent-ui/src/agent-workspace/agent-activity-state.ts";
import { messagesFor } from "../../packages/agent-ui/src/agent-workspace/i18n.ts";
import {
  eventsBeforeLastUserTurn,
  hasSettledLatestTurn,
  hasUnresolvedInputRequests,
  isProxiedInputOnlyMessage,
  presentAgentStep,
  presentAgentTurn,
  presentSubagentCall,
  presentSubagentSessions,
  projectAgentDisplayTimeline,
} from "../../packages/agent-ui/src/agent-workspace/turn-presentation.ts";
import { summarizeUsage } from "../../packages/agent-ui/src/agent-workspace/usage.ts";

const startedAt = "2026-08-06T01:00:00.000Z";
const endedAt = "2026-08-06T01:00:09.000Z";

test("plain assistant replies remain normal dialogue without a task execution group", () => {
  const message: EveMessage = {
    id: "turn-chat:assistant",
    metadata: { status: "complete", turnId: "turn-chat" },
    parts: [{ state: "done", stepIndex: 0, text: "Hello", type: "text" }],
    role: "assistant",
  };

  assert.equal(presentAgentTurn(message, []), undefined);
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

test("a cancelled parent turn stops orphaned subagent timers", () => {
  const running = childApprovalEvents().slice(0, 3);
  const cancelledAt = "2026-08-06T01:00:12.000Z";
  const events = [
    ...running,
    event("turn.cancelled", cancelledAt, { sequence: 0, turnId: "turn-parent" }),
    event("session.waiting", cancelledAt, { wait: "next-user-message" }),
  ];

  assert.deepEqual(presentSubagentCall(events, "call-agent"), {
    childSessionId: "child-session",
    endedAt: Date.parse(cancelledAt),
    name: "agent",
    startedAt: Date.parse(startedAt),
    status: "cancelled",
  });
  assert.deepEqual(presentSubagentSessions(events), [{
    callId: "call-agent",
    childSessionId: "child-session",
    endedAt: Date.parse(cancelledAt),
    name: "agent",
    startedAt: Date.parse(startedAt),
    status: "cancelled",
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
    retry: {
      attempt: 1,
      error: {
        code: "provider_stream_interrupted",
        message: "The Provider stream ended before completion.",
      },
      maximum: 3,
    },
    startedAt: Date.parse(retriedAt),
    status: "running",
  });
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

test("a persisted turn boundary overrides stale client stream state for editing", () => {
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
  assert.equal(hasSettledLatestTurn([
    ...running,
    event("turn.failed", endedAt, { code: "provider_error", message: "Failed", sequence: 0, turnId: "turn-edit" }),
    event("session.failed", endedAt, { code: "provider_error", message: "Failed" }),
  ]), false);
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
