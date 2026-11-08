import assert from "node:assert/strict";
import test from "node:test";
import { Client, SessionStore, type SessionStreamEvent } from "eve/client";
import { line, startTurn, reply, streamResponse } from "../helpers/session-events.ts";

const running = () => [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "turn", "delivery", "Run")];

test("SessionStore preserves every native hot-stream event", async (t) => {
  const events = running();
  for (let index = 0; index < 20_000; index++) events.push(...line(index + 4, { type: "content.delta", scope: { turnId: "turn", runId: "turn:run" }, data: { partId: "reply", kind: "text", delta: "x" } }));
  events.push(...reply(20_004, "turn", "delivery", "x".repeat(20_000)));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => streamResponse(events);
  const session = new Client({ baseUrl: "https://agent.example" }).sessions.attach("session");
  const store = new SessionStore({ session, optimistic: false });
  let observed = 0;
  store.setCallbacks({ onEvent: () => { observed++; } });
  await store.resume();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(observed, events.length);
  assert.equal(store.snapshot.events.length, events.length);
  assert.equal(store.snapshot.messages.at(-1)?.parts.find((part) => part.type === "text")?.text, "x".repeat(20_000));
});

test("SessionStore keeps published snapshots immutable during catch-up", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const events = running();
  globalThis.fetch = async () => streamResponse(events);
  const session = new Client({ baseUrl: "https://agent.example" }).sessions.attach("session");
  const store = new SessionStore({ session, optimistic: false });
  await store.resume();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const before = store.snapshot;
  const beforeEvents = [...before.events];
  const appended = reply(4, "turn", "delivery", "Done");
  globalThis.fetch = async () => streamResponse(appended);
  await store.resume();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(before.events, beforeEvents);
  assert.equal(store.snapshot.events.length, events.length + appended.length);
  assert.notEqual(before.events, store.snapshot.events);
});
