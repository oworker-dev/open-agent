import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentRuntimeHost, readEveAgentEvents, resetEveAgentRun, resetEveSession } from "../../server/agent-runs/eve-adapter.ts";
import { line, startTurn, reply, streamResponse, wireLines } from "../helpers/session-events.ts";

function setup(t: import("node:test").TestContext) {
  const original = globalThis.fetch; const url = process.env.AGENT_RUNTIME_URL;
  process.env.AGENT_RUNTIME_URL = "https://agent.example";
  t.after(() => { globalThis.fetch = original; if (url === undefined) delete process.env.AGENT_RUNTIME_URL; else process.env.AGENT_RUNTIME_URL = url; });
}
const read = (start = 0, limit = 200) => readEveAgentEvents("run-1", "correlation-1", "session-1", "token", start, limit);

test("normalizes an Eve runtime host and rejects non-HTTP endpoints", () => {
  assert.equal(normalizeAgentRuntimeHost("https://agent.example/eve/v1/"), "https://agent.example/");
  assert.throws(() => normalizeAgentRuntimeHost("file:///tmp/eve"), /absolute HTTP\(S\) URL/);
});

for (const sandbox of [false, true]) test(`reset awaits the native retirement delivery (${sandbox ? "sandbox" : "run"})`, async (t) => {
  setup(t); let posts = 0; let reads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      posts++; assert.equal(url.pathname, "/eve/v1/session/session-1/reset");
      if (sandbox) assert.match(new Headers(init.headers).get("x-agent-run-id") ?? "", /^arun_[a-f0-9]{32}$/);
      return Response.json({ ok: true, sessionId: "session-1", deliveryId: "reset-delivery" }, { status: 202 });
    }
    reads++;
    return streamResponse(line(0, { type: "delivery.admitted", data: { deliveryId: "reset-delivery", source: { channel: "eve" } } },
      { type: "session.ended", data: { outcome: "completed" } },
      { type: "delivery.settled", data: { deliveryId: "reset-delivery", outcome: "applied" } }));
  };
  assert.equal(await (sandbox ? resetEveSession("session-1", "token", "cleanup") : resetEveAgentRun("run-1", "correlation-1", "session-1", "token")), "reset");
  assert.equal(posts, 1); assert.equal(reads, 1);
});

test("reset accepts Eve's terminal event when its delivery settlement is omitted", async (t) => {
  setup(t);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      assert.equal(url.pathname, "/eve/v1/session/session-1/reset");
      return Response.json({ ok: true, sessionId: "session-1", deliveryId: "reset-delivery" }, { status: 202 });
    }
    return streamResponse(line(0,
      { type: "delivery.admitted", data: { deliveryId: "reset-delivery", source: { channel: "eve" } } },
      { type: "session.ended", data: { outcome: "completed" } }));
  };

  assert.equal(await resetEveAgentRun("run-1", "correlation-1", "session-1", "token"), "reset");
});

test("bounded pages use no-store, authorize every connection, and preserve atomic source lines", async (t) => {
  setup(t); let requested = "";
  const events = [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "turn", "delivery", "Run"), ...reply(4, "turn", "delivery", "Done")];
  globalThis.fetch = async (input, init) => {
    requested = String(input); assert.equal(init?.cache, "no-store");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer token");
    assert.equal(headers.get("x-agent-run-id"), "run-1");
    assert.equal(headers.get("x-agent-correlation-id"), "correlation-1");
    return streamResponse(events);
  };
  const page = await read(0, 3);
  assert.match(requested, /includeTailIndex=1/); assert.match(requested, /follow=false/);
  assert.equal(page.length, 5); // the three-fact turn-start commit is indivisible
  assert.deepEqual(page.at(-1)?.meta.position, { line: 2, index: 2 });
});

test("bounded pages reject missing and incompatible stream versions", async (t) => {
  setup(t);
  for (const version of [undefined, "25"]) {
    globalThis.fetch = async () => new Response("", { headers: version ? { "x-eve-stream-version": version } : {} });
    await assert.rejects(read(), /version/i);
  }
});

test("bounded pages reject a missing durable tail", async (t) => {
  setup(t); globalThis.fetch = async () => new Response("", { headers: { "x-eve-stream-version": "27" } });
  await assert.rejects(read(), /tail-index/);
});

test("an exhausted source cursor returns an empty page", async (t) => {
  setup(t); globalThis.fetch = async () => streamResponse([], 3);
  assert.deepEqual(await read(4), []);
});

test("transient stream-open failures retry from the same source cursor", async (t) => {
  setup(t); let calls = 0;
  globalThis.fetch = async (input) => {
    calls++; if (calls === 1) throw new TypeError("socket closed");
    assert.equal(new URL(String(input)).searchParams.get("startIndex"), "4");
    return streamResponse(line(4, { type: "session.started", data: {} }));
  };
  assert.equal((await read(4)).length, 1); assert.equal(calls, 2);
});

test("a disconnected bounded stream reconnects at the next complete source line", async (t) => {
  setup(t); let calls = 0;
  globalThis.fetch = async (input) => {
    calls++;
    if (calls === 1) return new Response(wireLines(line(0, { type: "session.started", data: {} })).replace('{"$eve":"stream.ended"}\n', ""), { headers: { "x-eve-stream-version": "27", "x-eve-stream-tail-index": "1" } });
    assert.equal(new URL(String(input)).searchParams.get("startIndex"), "1");
    return streamResponse(line(1, { type: "session.ended", data: { outcome: "completed" } }));
  };
  assert.equal((await read()).length, 2); assert.equal(calls, 2);
});
