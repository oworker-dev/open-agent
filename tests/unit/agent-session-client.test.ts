import assert from "node:assert/strict";
import test from "node:test";
import { createEveAgentSessionClient } from "@oworker/open-agent-client/eve-session";

test("Eve session adapter exposes a host-neutral durable cursor and events", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ init?: RequestInit; url: string }> = [];
  let tokenReads = 0;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ init, url });
    const path = new URL(url).pathname;
    if (init?.method === "POST" && path === "/eve/v1/session") {
      return Response.json(
        { sessionId: "session-1" },
        { headers: { "x-eve-session-id": "session-1" }, status: 202 },
      );
    }
    if (path === "/eve/v1/session/session-1/stream") {
      return ndjsonResponse([
        { type: "session.started", data: {} },
        { type: "turn.started", data: { sequence: 1, turnId: "turn-1" } },
        {
          type: "message.completed",
          data: { finishReason: "stop", message: "Done", sequence: 1, stepIndex: 0, turnId: "turn-1" },
        },
        { type: "turn.completed", data: { sequence: 1, turnId: "turn-1" } },
        { type: "session.waiting", data: { wait: "next-user-message" } },
      ]);
    }
    if (init?.method === "POST" && path === "/eve/v1/session/session-1/cancel") {
      return Response.json({ ok: true, sessionId: "session-1", status: "accepted" });
    }
    if (init?.method === "POST" && path === "/eve/v1/session/session-1/reset") {
      return Response.json({ ok: true, previousSessionId: "session-1", status: "reset" });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const client = createEveAgentSessionClient({
      baseUrl: "https://agent.example/",
      getAccessToken: async () => `token-${++tokenReads}`,
    });
    const session = client.session();
    const turn = await session.send("Complete this task.");
    const result = await turn.result();

    assert.equal(result.message, "Done");
    assert.equal(result.status, "waiting");
    assert.deepEqual(result.events.map((event) => event.cursor), [1, 2, 3, 4, 5]);
    assert.deepEqual(session.cursor, {
      eventCursor: 5,
      sessionId: "session-1",
    });
    assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer token-1");
    assert.equal(requests[0]?.init?.redirect, "error");
    assert.equal(new Headers(requests[1]?.init?.headers).get("authorization"), "Bearer token-2");

    const cancellation = await session.cancel({ turnId: "turn-1" });
    assert.equal(cancellation.status, "accepted");
    const reset = await session.reset();
    assert.deepEqual(reset, { previousSessionId: "session-1", status: "reset" });
    assert.deepEqual(session.cursor, { eventCursor: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Eve session adapter rejects invalid public cursors before transport", () => {
  const client = createEveAgentSessionClient({
    baseUrl: "https://agent.example",
    getAccessToken: () => "token",
  });
  assert.throws(
    () => client.session({ eventCursor: -1 }),
    (error: unknown) => error instanceof RangeError,
  );
});

function ndjsonResponse(events: readonly unknown[]) {
  return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
    headers: { "content-type": "application/x-ndjson", "x-eve-stream-version": "25" },
  });
}
