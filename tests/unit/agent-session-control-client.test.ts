import assert from "node:assert/strict";
import test from "node:test";
import { createAgentSessionControlClient } from "@oworker/open-agent-client/session-control";

test("session control client uses absolute cursors and stable operation metadata", async () => {
  const requests: Array<{ body?: string; method?: string; url: string }> = [];
  const client = createAgentSessionControlClient({
    baseUrl: "https://agent.example/",
    getAccessToken: () => "token",
  }, async (input, init) => {
    const url = String(input);
    requests.push({ body: typeof init?.body === "string" ? init.body : undefined, method: init?.method, url });
    if (init?.method === "GET") {
      return Response.json({
        events: [],
        hasMore: false,
        nextCursor: 3,
        session: {
          cursor: { eventCursor: 3, sessionId: "session-1" },
          sessionId: "session-1",
          status: "waiting",
        },
      });
    }
    return Response.json({
      clientMessageId: "client-1",
      itemId: "mail-1",
      ok: true,
      operationId: "operation-1",
      status: "queued",
    }, { status: 202 });
  });

  const history = await client.history("session-1", { after: 3, limit: 10 });
  assert.equal(history.nextCursor, 3);
  await client.steer("session-1", {
    clientMessageId: "client-1",
    expectedTurnId: "turn-1",
    message: "Continue",
    operationId: "operation-1",
  });
  assert.match(requests[0]?.url ?? "", /after=3&limit=10/);
  assert.deepEqual(JSON.parse(requests[1]?.body ?? "{}"), {
    action: "steer",
    clientMessageId: "client-1",
    expectedTurnId: "turn-1",
    message: "Continue",
    operationId: "operation-1",
    sessionId: "session-1",
  });
});

test("session control client validates cursors locally", async () => {
  const client = createAgentSessionControlClient({
    baseUrl: "https://agent.example",
    getAccessToken: () => "token",
  });
  await assert.rejects(client.history("session-1", { after: -1 }), RangeError);
});
