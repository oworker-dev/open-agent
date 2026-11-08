import assert from "node:assert/strict";
import test from "node:test";
import { conversationOf, type SessionStreamEvent } from "eve/client";
import { position } from "eve/events";
import { projectConversationMessages } from "../../packages/agent-ui/dist/agent-workspace/conversation-messages.js";
import { serializeAssetPrompt } from "../../packages/agent-contracts/dist/asset.js";
import { line, reply, startTurn } from "../helpers/session-events.ts";

function originalBranch(): SessionStreamEvent[] {
  return [...line(0, { type: "session.started", data: {} }),
    ...startTurn(1, "a", "d1", "First"), ...reply(4, "a", "d1", "First reply"),
    ...startTurn(5, "b", "d2", "Original", "a"), ...reply(8, "b", "d2", "Superseded reply")];
}

function cleared() {
  return line(9,
    { type: "context.started", data: { changeId: "clear", kind: "clear" } },
    { type: "context.settled", data: { changeId: "clear", kind: "clear", outcome: "completed", selects: null } },
  );
}

test("unmodified conversation keeps every ordered message", () => {
  const events = originalBranch();
  const { messages } = conversationOf(events);
  assert.deepEqual(projectConversationMessages(messages, events), messages);
});

test("a pending edit keeps only its prior messages, including while clear settles", () => {
  for (const events of [originalBranch(), [...originalBranch(), ...cleared()]]) {
    const { messages } = conversationOf(events);
    const projected = projectConversationMessages(messages, events, { beforeTurnId: "b", clientMessageId: "client-edit-123" });
    assert.deepEqual(projected.map((message) => message.id), ["d1:user", "a:assistant"]);
    assert.equal(messages.length, 4);
  }
});

test("clear changes visible selection without deleting any atomic facts", () => {
  const events = [...originalBranch(), ...cleared()];
  const { messages, view } = conversationOf(events);
  assert.equal(position(view), 10);
  assert.equal(messages.length, 4);
  assert.deepEqual(projectConversationMessages(messages, events), []);
  assert.equal(events.at(-2)?.meta.endOfLine, false);
});

test("edited history restores rich original messages once and removes the superseded branch", () => {
  const replacement = startTurn(10, "c", "different-native-delivery", serializeAssetPrompt("Edited", [], "client-edit-123"));
  const receipt = replacement.find((event) => event.type === "delivery.consumed")!;
  const importedHistory = [
    { id: "d1:user", role: "user" as const, text: "First" },
    { id: "a:assistant", role: "assistant" as const, text: "First reply" },
  ];
  const events = [...originalBranch(), ...cleared(), ...replacement.map((event) => event === receipt ? { ...event, data: { ...receipt.data, history: importedHistory } } : event)];
  const { messages } = conversationOf(events);
  const rich = messages.map((message) => message.id === "a:assistant"
    ? { ...message, parts: [...message.parts, { type: "file" as const, mediaType: "image/png", url: "asset://evidence" }] }
    : message);
  const projected = projectConversationMessages(rich, events, { beforeTurnId: "b", clientMessageId: "client-edit-123" });
  assert.deepEqual(projected.map((message) => message.id), ["d1:user", "a:assistant", "different-native-delivery:user", "c:assistant"]);
  assert.equal(projected[1]?.parts.at(-1)?.type, "file");
  assert.match(JSON.stringify(messages), /Superseded reply/);
});
