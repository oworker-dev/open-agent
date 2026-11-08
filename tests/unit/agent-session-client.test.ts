import assert from "node:assert/strict";
import test from "node:test";
import { createEveAgentSessionClient } from "@oworker/open-agent-client/eve-session";
import { line, startTurn, reply, streamResponse } from "../helpers/session-events.ts";

test("Eve session adapter preserves source cursors, delivery receipts and turn-scoped cancellation", async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const requests: Array<{ init?: RequestInit; url: string }> = [];
  const events = [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "turn-1", "delivery-1", "Complete this task"), ...reply(4, "turn-1", "delivery-1", "Done")];
  let tokenReads = 0; let reset = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push({ init, url: String(input) });
    if (init?.method === "POST") {
      if (url.pathname.endsWith("/cancel")) {
        assert.deepEqual(JSON.parse(String(init.body)), { turnId: "turn-1" });
        return Response.json({ ok: true, sessionId: "session-1", deliveryId: "cancel-delivery" }, { status: 202 });
      }
      if (url.pathname.endsWith("/reset")) {
        reset = true; return Response.json({ ok: true, sessionId: "session-1", deliveryId: "reset-delivery" }, { status: 202 });
      }
      return Response.json({ sessionId: "session-1", deliveryId: "delivery-1" }, { status: 202 });
    }
    return reset ? streamResponse(line(5,
      { type: "delivery.admitted", data: { deliveryId: "reset-delivery", source: { control: "reset" } } },
      { type: "session.ended", data: { outcome: "completed" } },
      { type: "delivery.settled", data: { deliveryId: "reset-delivery", outcome: "applied" } })) : streamResponse(events);
  };
  const client = createEveAgentSessionClient({ baseUrl: "https://agent.example/", getAccessToken: async () => `token-${++tokenReads}` });
  const session = client.session();
  const delivery = await session.send("Complete this task");
  const result = await delivery.result();
  assert.equal(result.message, "Done"); assert.equal(result.status, "completed");
  assert.deepEqual(result.events.map((event) => event.cursor), [2, 2, 2, 3, 4, 4, 4, 4, 5]);
  assert.deepEqual(session.cursor, { streamIndex: 5, sessionId: "session-1" });
  assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer token-1");
  assert.equal(requests[0]?.init?.redirect, "error");
  assert.ok(tokenReads >= 3);
  assert.equal((await session.cancel({ turnId: "turn-1" })).status, "accepted");
  assert.deepEqual(await session.reset(), { previousSessionId: "session-1", status: "reset" });
  assert.deepEqual(session.cursor, { streamIndex: 0 });
});

test("Eve session adapter rejects invalid public source cursors before transport", () => {
  const client = createEveAgentSessionClient({ baseUrl: "https://agent.example", getAccessToken: () => "token" });
  for (const streamIndex of [-1, 0.5, NaN, Infinity]) assert.throws(() => client.session({ streamIndex }), RangeError);
});
