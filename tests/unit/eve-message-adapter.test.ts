import assert from "node:assert/strict";
import test from "node:test";

import type { AppendMessage } from "@assistant-ui/react";
import {
  convertEveMessages,
  getEveMessageContent,
} from "../../packages/agent-ui/src/agent-workspace/eve-message-adapter.ts";
import { defaultMessageReducer } from "eve/react";
import type { MessageStreamEvent } from "eve/client";

test("projects an Eve file through one attachment without duplicating an edited resend", () => {
  const url = "data:image/png;base64,AA==";
  const [message] = convertEveMessages({
    messages: [{
      id: "message-file",
      parts: [
        { text: "Use this reference", type: "text" },
        { filename: "reference.png", mediaType: "image/png", type: "file", url },
      ],
      role: "user",
    }],
  });
  assert.ok(message?.role === "user");
  assert.deepEqual(message.content, [{ text: "Use this reference", type: "text" }]);
  assert.equal(message.attachments.length, 1);

  const content = getEveMessageContent({
    attachments: message.attachments,
    content: message.content,
    createdAt: message.createdAt,
    metadata: message.metadata,
    parentId: null,
    role: "user",
    runConfig: {},
    sourceId: message.id,
  } satisfies AppendMessage);

  assert.deepEqual(content, [
    { text: "Use this reference", type: "text" },
    { data: url, filename: "reference.png", mediaType: "image/png", type: "file" },
  ]);
});

test("Eve partial tool snapshots remain active until the final action result", () => {
  const reducer = defaultMessageReducer();
  const action = {
    callId: "call-write",
    input: { content: "first line\n", path: "/workspace/site.css" },
    kind: "tool-call" as const,
    toolName: "write_file",
  };
  let data = reducer.initial();
  data = reducer.reduce(data, streamEvent("step.started", {
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-write",
  }));
  data = reducer.reduce(data, streamEvent("actions.requested", {
    actions: [action],
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-write",
  }));
  data = reducer.reduce(data, streamEvent("action.partial", {
    result: { ...action, kind: "tool-result", output: { content: "first line\nsecond line\n" } },
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-write",
  }));

  const partial = data.messages[0]?.parts.find((part) => part.type === "dynamic-tool");
  assert.equal(partial?.type, "dynamic-tool");
  assert.equal(partial?.state, "output-available");
  assert.equal(partial?.partial, true);
  assert.deepEqual(partial?.output, { content: "first line\nsecond line\n" });

  data = reducer.reduce(data, streamEvent("action.result", {
    result: { ...action, kind: "tool-result", output: { content: "first line\nsecond line\nthird line\n" } },
    sequence: 0,
    status: "completed",
    stepIndex: 0,
    turnId: "turn-write",
  }));
  const settled = data.messages[0]?.parts.find((part) => part.type === "dynamic-tool");
  assert.equal(settled?.type, "dynamic-tool");
  assert.equal(settled?.state, "output-available");
  assert.equal(settled?.partial, undefined);
  assert.deepEqual(settled?.output, { content: "first line\nsecond line\nthird line\n" });
});

test("provider tool arguments stream into one durable tool part before execution", () => {
  const reducer = defaultMessageReducer();
  let data = reducer.initial();
  data = reducer.reduce(data, streamEvent("step.started", {
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-stream",
  }));
  data = reducer.reduce(data, streamEvent("action.input.partial", {
    callId: "call-patch",
    input: { patch: "*** Begin Patch\n*** Update File: site.css" },
    inputTextDelta: "site.css",
    inputTextSoFar: '{"patch":"*** Begin Patch\\n*** Update File: site.css',
    sequence: 0,
    stepIndex: 0,
    toolName: "apply_patch",
    turnId: "turn-stream",
  }));

  const streaming = data.messages[0]?.parts.find((part) => part.type === "dynamic-tool");
  assert.equal(streaming?.type, "dynamic-tool");
  assert.equal(streaming?.state, "input-streaming");
  assert.equal(streaming?.toolName, "apply_patch");
  assert.equal(streaming?.inputText, '{"patch":"*** Begin Patch\\n*** Update File: site.css');
  assert.deepEqual(streaming?.input, { patch: "*** Begin Patch\n*** Update File: site.css" });

  const [converted] = convertEveMessages(data);
  assert.equal(converted?.role, "assistant");
  const tool = converted?.content.find((part) => part.type === "tool-call");
  assert.equal(tool?.type, "tool-call");
  assert.equal(tool?.argsText, streaming?.inputText);

  data = reducer.reduce(data, streamEvent("actions.requested", {
    actions: [{
      callId: "call-patch",
      input: { patch: "*** Begin Patch\n*** Update File: site.css\n*** End Patch" },
      kind: "tool-call",
      toolName: "apply_patch",
    }],
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-stream",
  }));
  const complete = data.messages[0]?.parts.find((part) => part.type === "dynamic-tool");
  assert.equal(complete?.type, "dynamic-tool");
  assert.equal(complete?.state, "input-available");
});

function streamEvent(
  type: MessageStreamEvent["type"],
  data: Record<string, unknown>,
): MessageStreamEvent {
  return {
    data,
    meta: { at: "2026-08-06T01:00:00.000Z", id: `evt-${type}` },
    type,
  } as MessageStreamEvent;
}
