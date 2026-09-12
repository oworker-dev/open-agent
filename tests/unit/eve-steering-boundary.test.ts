import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

type Payload = Record<string, any>;
type InboxValue = IteratorResult<Payload>;
let fixture: ReturnType<typeof createFixture>;
const scope = globalThis as typeof globalThis & { __eveSteeringFixture?: () => typeof fixture };
scope.__eveSteeringFixture = () => fixture;

// Run Eve's actual inbox and receiver. Only the durable I/O primitives are
// replaced, allowing both replay-ready hooks and live arrival to be tested.
const modules: Record<string, string> = {
  "#compiled/@workflow/core/index.js": "export const createHook = (options) => globalThis.__eveSteeringFixture().hook(options.token);",
  "#execution/hook-ownership.js": "export const claimHookOwnership = async () => {}; export const disposeHook = async () => {}; export const closeHookIterator = async () => {};",
  "#execution/forward-turn-delivery-step.js": "export const forwardTurnDeliveryStep = async (input) => globalThis.__eveSteeringFixture().forward(input);",
  "#execution/forward-turn-cancellation-step.js": "export const forwardTurnCancellationStep = async (input) => globalThis.__eveSteeringFixture().cancellations.push(input);",
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes("/eve/dist/src/") && modules[specifier]) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(modules[specifier])}` };
    }
    return next(specifier, context);
  },
});
const { TurnControlReceiver } = await import("../../node_modules/eve/dist/src/execution/turn-control-receiver.js");
const { createSessionCommandInbox } = await import("../../node_modules/eve/dist/src/execution/session-command-inbox.js");
test.after(() => { hooks.deregister(); delete scope.__eveSteeringFixture; });

test("a replay-ready steer is consumed at the first safe boundary, without interrupting tools", async () => {
  fixture = createFixture();
  const inbox = createSessionCommandInbox();
  await inbox.claimStable("session");
  fixture.push("session", steer("first"));
  fixture.push("control", boundary("boundary-1"));
  const buffered: ConstructorParameters<typeof TurnControlReceiver>[0]["bufferedDeliveries"] = [];
  const receiver = new TurnControlReceiver({ bufferedDeliveries: buffered, bufferedSessionControls: [], commandInbox: inbox, token: "control" });
  const done = receiver.waitForAction(true);
  try {
    await fixture.forwarded;
    assert.equal(fixture.deliveries[0]?.payload.kind, "driver-delivery");
    assert.equal(fixture.deliveries[0]?.payload.delivery.steer.clientMessageId, "first");
    assert.equal(fixture.cancellations.length, 0);
  } finally {
    fixture.push("control", { kind: "turn-result", action: { kind: "park" } });
    await done;
    await receiver.dispose();
    await inbox.dispose();
  }
});

test("an empty steering boundary does not wait for a future user message", async () => {
  fixture = createFixture();
  const inbox = createSessionCommandInbox();
  await inbox.claimStable("session");
  fixture.push("control", boundary("boundary-empty"));
  const receiver = new TurnControlReceiver({ bufferedDeliveries: [], bufferedSessionControls: [], commandInbox: inbox, token: "control" });
  const done = receiver.waitForAction(true);
  try {
    await fixture.forwarded;
    assert.equal(fixture.deliveries[0]?.payload.kind, "driver-delivery-empty");
  } finally {
    fixture.push("control", { kind: "turn-result", action: { kind: "park" } });
    await done;
    await receiver.dispose();
    await inbox.dispose();
  }
});

for (const scenario of [
  { name: "a stale turn target", command: { ...steer("stale"), steer: { expectedTurnId: "older-turn", clientMessageId: "stale" } }, readySteering: true },
  { name: "a normal next-turn message", command: { kind: "deliver", payload: { message: "later" }, payloads: [{ message: "later" }] }, readySteering: true },
  { name: "an existing dispatch recorded before the ready-steering protocol", command: steer("legacy"), readySteering: false },
]) {
  test(`does not retarget or consume ${scenario.name}`, async () => {
    fixture = createFixture();
    const inbox = createSessionCommandInbox();
    await inbox.claimStable("session");
    fixture.push("session", scenario.command);
    fixture.push("control", boundary("boundary-guard"));
    const receiver = new TurnControlReceiver({ bufferedDeliveries: [], bufferedSessionControls: [], commandInbox: inbox, token: "control" });
    const done = receiver.waitForAction(scenario.readySteering);
    try {
      await fixture.forwarded;
      assert.equal(fixture.deliveries[0]?.payload.kind, "driver-delivery-empty");
      assert.equal(fixture.cancellations.length, 0);
    } finally {
      fixture.push("control", { kind: "turn-result", action: { kind: "park" } });
      await done;
      await receiver.dispose();
      await inbox.dispose();
    }
  });
}

test("ready steering consumes each message once in FIFO order across safe boundaries", async () => {
  fixture = createFixture();
  const inbox = createSessionCommandInbox();
  await inbox.claimStable("session");
  fixture.push("session", steer("first"));
  fixture.push("session", steer("second"));
  fixture.push("control", boundary("first-boundary"));
  const receiver = new TurnControlReceiver({ bufferedDeliveries: [], bufferedSessionControls: [], commandInbox: inbox, token: "control" });
  const done = receiver.waitForAction(true);
  try {
    await fixture.forwarded;
    assert.equal(fixture.deliveries[0]?.payload.delivery.steer.clientMessageId, "first");
    fixture.push("control", boundary("second-boundary"));
    const deadline = Date.now() + 1_000;
    while (fixture.deliveries.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.deepEqual(fixture.deliveries.map((input) => input.payload.delivery?.steer.clientMessageId), ["first", "second"]);
    assert.equal(fixture.cancellations.length, 0);
  } finally {
    fixture.push("control", { kind: "turn-result", action: { kind: "park" } });
    await done;
    await receiver.dispose();
    await inbox.dispose();
  }
});

function steer(id: string): Payload {
  return { kind: "deliver", payload: { message: id }, payloads: [{ message: id }], steer: { expectedTurnId: "turn-0", clientMessageId: id } };
}
function boundary(requestId: string): Payload {
  return { kind: "turn-delivery-request", continuationToken: "", inboxToken: "turn-inbox", requestId, steerTurnId: "turn-0" };
}
function createFixture() {
  const queues = new Map<string, { values: InboxValue[]; resolve?: (value: InboxValue) => void }>();
  const get = (token: string) => {
    let queue = queues.get(token);
    if (!queue) { queue = { values: [] }; queues.set(token, queue); }
    return queue;
  };
  let resolveForwarded!: () => void;
  const forwarded = new Promise<void>((resolve) => { resolveForwarded = resolve; });
  const result = {
    deliveries: [] as Payload[],
    cancellations: [] as Payload[],
    forwarded,
    hook(token: string) {
      return {
        token,
        [Symbol.asyncIterator]() {
          return { next: () => {
            const queue = get(token);
            const value = queue.values.shift();
            return value ? Promise.resolve(value) : new Promise<InboxValue>((resolve) => { queue.resolve = resolve; });
          } };
        },
      };
    },
    push(token: string, value: Payload) {
      const queue = get(token);
      if (queue.resolve) { const resolve = queue.resolve; queue.resolve = undefined; resolve({ done: false, value }); }
      else queue.values.push({ done: false, value });
    },
    forward(input: Payload) {
      result.deliveries.push(input);
      if (input.payload.kind === "driver-delivery") result.push("control", { kind: "turn-delivery-accepted", requestId: input.payload.requestId });
      resolveForwarded();
    },
  };
  return result;
}
