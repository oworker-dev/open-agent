import assert from "node:assert/strict";
import test from "node:test";
import type { AppendMessage } from "@assistant-ui/react";
import { conversationOf, type SessionStreamEvent } from "eve/client";
import { convertEveMessages, getEveMessageContent } from "../../packages/agent-ui/dist/agent-workspace/eve-message-adapter.js";
import { line, startTurn } from "../helpers/session-events.ts";

const running = () => [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "turn", "delivery", "Write")];

test("projects an Eve file through one attachment without duplicating an edited resend", () => {
  const url = "data:image/png;base64,AA==";
  const [message] = convertEveMessages([{ id: "message-file", parts: [
    { text: "Use this reference", type: "text", state: "done" },
    { filename: "reference.png", mediaType: "image/png", type: "file", url },
  ], role: "user" }]);
  assert.ok(message?.role === "user");
  assert.deepEqual(message.content, [{ text: "Use this reference", type: "text" }]);
  assert.equal(message.attachments.length, 1);
  const content = getEveMessageContent({ attachments: message.attachments, content: message.content,
    createdAt: message.createdAt, metadata: message.metadata, parentId: null, role: "user",
    runConfig: {}, sourceId: message.id } satisfies AppendMessage);
  assert.deepEqual(content, [{ text: "Use this reference", type: "text" },
    { data: url, filename: "reference.png", mediaType: "image/png", type: "file" }]);
});

test("native output previews remain running until the final call settlement", () => {
  const events = [...running(), ...line(4, { type: "call.requested", scope: { turnId: "turn" }, data: { callId: "write", owner: { runId: "turn:run" }, capability: { kind: "tool", name: "write_file" }, input: { path: "site.css" } } }),
    ...line(5, { type: "call.progress", scope: { turnId: "turn", runId: "turn:run" }, data: { callId: "write", output: { content: "first line" } } })];
  const preview = conversationOf(events).messages.at(-1)?.parts.find((part) => part.type === "tool");
  assert.equal(preview?.state, "requested");
  assert.deepEqual(preview?.output, { content: "first line" });
  events.push(...line(6, { type: "call.settled", scope: { turnId: "turn" }, data: { callId: "write", outcome: "completed", output: { content: "final" } } }));
  const settled = conversationOf(events).messages.at(-1)?.parts.find((part) => part.type === "tool");
  assert.equal(settled?.state, "completed");
  const tool = convertEveMessages(conversationOf(events).messages).at(-1)?.content.find((part) => part.type === "tool-call");
  assert.deepEqual(tool?.result, { content: "final" });
});

test("native tool input deltas become one validated call with the same identity", () => {
  const events: SessionStreamEvent[] = [...running(), ...line(4, { type: "call.input", scope: { turnId: "turn", runId: "turn:run" }, data: { callId: "patch", kind: "tool", name: "apply_patch", delta: '{"patch":"half' } }),
    ...line(5, { type: "call.input", scope: { turnId: "turn", runId: "turn:run" }, data: { callId: "patch", delta: '"}' } })];
  const converted = convertEveMessages(conversationOf(events).messages).at(-1)?.content.find((part) => part.type === "tool-call");
  assert.equal(converted?.argsText, '{"patch":"half"}');
  events.push(...line(6, { type: "call.requested", scope: { turnId: "turn" }, data: { callId: "patch", owner: { runId: "turn:run" }, capability: { kind: "tool", name: "apply_patch" }, input: { patch: "half" } } }));
  const tools = conversationOf(events).messages.at(-1)?.parts.filter((part) => part.type === "tool");
  assert.equal(tools?.length, 1);
  assert.equal(tools?.[0]?.state, "requested");
  assert.deepEqual(tools?.[0]?.input, { patch: "half" });
});
