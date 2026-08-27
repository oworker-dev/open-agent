import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { EveAgentStore } from "eve/client";
import type { ClientSession, MessageStreamEvent } from "eve/client";

test("Eve appends private reducer history without copying the full projection per event", async () => {
  const chunksDirectory = resolve("node_modules/eve/dist/src/chunks");
  const chunkNames = (await readdir(chunksDirectory))
    .filter((name) => /^use-eve-agent-.*\.js$/u.test(name));

  assert.ok(chunkNames.length > 0, "The installed Eve React store chunks were not found.");
  for (const chunkName of chunkNames) {
    const source = await readFile(resolve(chunksDirectory, chunkName), "utf8");
    assert.doesNotMatch(
      source,
      /this\.#projectionEvents\s*=\s*\[\.\.\.this\.#projectionEvents,\s*event\]/u,
      `${chunkName} restored quadratic projection-event copying`,
    );
    assert.match(
      source,
      /this\.#projectionEvents\.push\(event\)/u,
      `${chunkName} does not contain the patched private projection append`,
    );
    assert.match(
      source,
      /this\.#schedulePublish\(\)/u,
      `${chunkName} does not batch immutable stream snapshots`,
    );
  }
});

test("Eve batches hot subscriber snapshots while preserving every event", async () => {
  const eventCount = 20_000;
  let observedEvents = 0;
  let publications = 0;
  const store = new EveAgentStore({
    optimistic: false,
    reducer: { initial: () => 0, reduce: (count) => count + 1 },
    session: sessionFrom(async function* () {
      for (let index = 0; index < eventCount; index += 1) yield event(index);
    }),
  });
  store.setCallbacks({ onEvent: () => { observedEvents += 1; } });
  store.subscribe(() => { publications += 1; });

  await store.send({ message: "run" });

  assert.equal(observedEvents, eventCount);
  assert.equal(store.snapshot.events.length, eventCount);
  assert.equal(store.snapshot.data, eventCount);
  assert.ok(publications < 100, `expected frame-batched snapshots, received ${publications}`);
});

test("Eve does not mutate a previously published event snapshot", async () => {
  let releaseSecondEvent!: () => void;
  const secondEvent = new Promise<void>((resolveSecondEvent) => {
    releaseSecondEvent = resolveSecondEvent;
  });
  let observedFirstEvent!: () => void;
  const firstEvent = new Promise<void>((resolveFirstEvent) => {
    observedFirstEvent = resolveFirstEvent;
  });
  const store = new EveAgentStore({
    optimistic: false,
    reducer: { initial: () => 0, reduce: (count) => count + 1 },
    session: sessionFrom(async function* () {
      yield event(0);
      await secondEvent;
      yield event(1);
    }),
  });
  store.setCallbacks({ onEvent: () => { observedFirstEvent(); } });

  const sending = store.send({ message: "run" });
  await firstEvent;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  const firstSnapshot = store.snapshot;
  assert.equal(firstSnapshot.events.length, 1);

  releaseSecondEvent();
  await sending;

  assert.equal(firstSnapshot.events.length, 1);
  assert.equal(store.snapshot.events.length, 2);
  assert.notEqual(firstSnapshot.events, store.snapshot.events);
});

function sessionFrom(events: () => AsyncGenerator<MessageStreamEvent>): ClientSession {
  return {
    respond: async () => { throw new Error("not used"); },
    send: async () => ({ [Symbol.asyncIterator]: events }),
    state: { sessionId: "session", streamIndex: 0 },
  } as unknown as ClientSession;
}

function event(index: number): MessageStreamEvent {
  return {
    data: {
      messageDelta: "x",
      messageSoFar: "x",
      sequence: index,
      stepIndex: index,
      turnId: "turn",
    },
    meta: { at: new Date(0).toISOString(), id: `event-${index}` },
    type: "message.appended",
  };
}
