import assert from "node:assert/strict";
import test from "node:test";
import { Client, SessionStore, type SessionStreamEvent } from "eve/client";
import { line, startTurn, reply, streamResponse, wireLines } from "../helpers/session-events.ts";

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

test("hot progress folds every event while publishing bounded immutable snapshots", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const initial = running();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const push = (events: SessionStreamEvent[]) => controller.enqueue(encoder.encode(wireLines(events).replace('{"$eve":"stream.ended"}\n', "")));
  globalThis.fetch = async () => new Response(new ReadableStream({ start(value) { controller = value; push(initial); } }), {
    headers: { "content-type": "application/x-ndjson", "x-eve-stream-version": "27", "x-eve-stream-tail-index": "3" },
  });
  const store = new SessionStore({ session: new Client({ baseUrl: "https://agent.example" }).sessions.attach("session"), optimistic: false });
  t.after(() => store.newSession());
  await store.resume();
  const before = store.snapshot;
  const beforeEvents = [...before.events];
  let notifications = 0;
  store.subscribe(() => { notifications++; });
  const observed = Promise.withResolvers<void>();
  let count = 0;
  store.setCallbacks({ onEvent: () => { if (++count === 1000) observed.resolve(); } });
  const progress: SessionStreamEvent[] = [];
  for (let index = 0; index < 1000; index++) progress.push(...line(4 + index, { type: "call.input", scope: { turnId: "turn", runId: "turn:run" }, data: {
    callId: "file", ...(index === 0 ? { kind: "tool" as const, name: "edit_file" } : {}), delta: "x",
  } }));
  push(progress);
  await observed.promise;
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(count, progress.length);
  assert.ok(notifications <= 3, `expected coalesced progress, received ${notifications} notifications`);
  assert.equal(store.snapshot.events.length, initial.length + progress.length);
  assert.equal(store.snapshot.messages.at(-1)?.parts.find((part) => part.type === "tool")?.inputText, "x".repeat(1000));
  assert.deepEqual(before.events, beforeEvents);
  const published = store.snapshot;
  // A lifecycle boundary flushes pending progress without waiting for the timer.
  push([...line(1004, { type: "content.delta", scope: { turnId: "turn", runId: "turn:run" }, data: { partId: "turn:reply", kind: "text", delta: "Done" } }), ...reply(1005, "turn", "delivery", "Done")]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.snapshot.status, "idle");
  assert.equal(store.snapshot.messages.at(-1)?.parts.find((part) => part.type === "text")?.text, "Done");
  assert.equal(published.events.length, initial.length + progress.length);
  controller.close();
});
