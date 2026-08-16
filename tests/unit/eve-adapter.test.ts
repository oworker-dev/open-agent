import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAgentRuntimeHost,
  readEveAgentEvents,
  resetEveAgentRun,
  resetEveSession,
} from "../../server/agent-runs/eve-adapter.ts";

test("keeps an Eve runtime origin for the client route prefix", () => {
  assert.equal(
    normalizeAgentRuntimeHost("https://agent.example"),
    "https://agent.example/",
  );
});

test("repairs an Agent runtime URL that includes Eve's own route prefix", () => {
  assert.equal(
    normalizeAgentRuntimeHost("https://agent.example/internal/eve/v1/"),
    "https://agent.example/internal",
  );
});

test("rejects a non-HTTP Agent runtime URL", () => {
  assert.throws(
    () => normalizeAgentRuntimeHost("file:///tmp/eve"),
    /absolute HTTP\(S\) URL/,
  );
});

test("resets an Eve session by stable ID", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalRuntimeUrl = process.env.AGENT_RUNTIME_URL;
  let body: unknown;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalRuntimeUrl === undefined) delete process.env.AGENT_RUNTIME_URL;
    else process.env.AGENT_RUNTIME_URL = originalRuntimeUrl;
  });
  process.env.AGENT_RUNTIME_URL = "https://agent.example";
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/eve\/v1\/session\/session-1\/reset$/);
    assert.equal(init?.method, "POST");
    body = init?.body;
    return Response.json({
      ok: true,
      previousSessionId: "session-1",
      status: "reset",
    });
  };

  const status = await resetEveAgentRun(
    "run-1",
    "correlation-1",
    "session-1",
    "token",
  );
  assert.equal(status, "reset");
  assert.equal(body, undefined);
});

test("uses the stable session ID as the reset handle", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalRuntimeUrl = process.env.AGENT_RUNTIME_URL;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalRuntimeUrl === undefined) delete process.env.AGENT_RUNTIME_URL;
    else process.env.AGENT_RUNTIME_URL = originalRuntimeUrl;
  });
  process.env.AGENT_RUNTIME_URL = "https://agent.example";
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/eve\/v1\/session\/session-1\/reset$/);
    return Response.json({ ok: true, previousSessionId: "session-1", status: "reset" });
  };
  assert.equal(
    await resetEveAgentRun("run-1", "correlation-1", "session-1", "token"),
    "reset",
  );
});

test("uses a valid AgentRun-shaped control id for sandbox session reset", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalRuntimeUrl = process.env.AGENT_RUNTIME_URL;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalRuntimeUrl === undefined) delete process.env.AGENT_RUNTIME_URL;
    else process.env.AGENT_RUNTIME_URL = originalRuntimeUrl;
  });
  process.env.AGENT_RUNTIME_URL = "https://agent.example";
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.match(headers.get("x-agent-run-id") ?? "", /^arun_[a-f0-9]{32}$/u);
    return Response.json({ ok: true, status: "no_active_session" });
  };
  assert.equal(
    await resetEveSession("session-1", "token", "sandbox-cleanup-1"),
    "no_active_session",
  );
});

test("reads a bounded no-store event page and closes at Eve's durable tail", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalRuntimeUrl = process.env.AGENT_RUNTIME_URL;
  let cancelled = false;
  let requestCache: RequestCache | undefined;
  let requestUrl = "";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalRuntimeUrl === undefined) delete process.env.AGENT_RUNTIME_URL;
    else process.env.AGENT_RUNTIME_URL = originalRuntimeUrl;
  });
  process.env.AGENT_RUNTIME_URL = "https://agent.example";
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer token");
    assert.equal(headers.get("x-agent-correlation-id"), "correlation-1");
    assert.equal(headers.get("x-agent-run-id"), "run-1");
    requestCache = init?.cache;
    requestUrl = String(input);
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `${JSON.stringify({
            data: {},
            meta: { at: "2026-08-03T00:00:00.000Z", id: "evt_01KZ0000000000000000000000" },
            type: "session.started",
          })}\n`,
        ));
      },
    });
    return new Response(stream, {
      headers: { "x-eve-stream-tail-index": "0" },
    });
  };

  const events = await readEveAgentEvents(
    "run-1",
    "correlation-1",
    "session-1",
    "token",
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "session.started");
  assert.equal(requestCache, "no-store");
  assert.match(requestUrl, /includeTailIndex=1/);
  assert.doesNotMatch(requestUrl, /stream%3F/);
  assert.equal(cancelled, true);
});

test("rejects a bounded event page without a valid durable tail", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalRuntimeUrl = process.env.AGENT_RUNTIME_URL;
  let cancelled = false;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalRuntimeUrl === undefined) delete process.env.AGENT_RUNTIME_URL;
    else process.env.AGENT_RUNTIME_URL = originalRuntimeUrl;
  });
  process.env.AGENT_RUNTIME_URL = "https://agent.example";
  globalThis.fetch = async () => new Response(new ReadableStream({
    cancel() {
      cancelled = true;
    },
  }));

  await assert.rejects(
    readEveAgentEvents("run-1", "correlation-1", "session-1", "token"),
    /requires the server to report the x-eve-stream-tail-index header/,
  );
  assert.equal(cancelled, true);
});

test("reconnects a bounded event page until it reaches the declared durable tail", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalRuntimeUrl = process.env.AGENT_RUNTIME_URL;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalRuntimeUrl === undefined) delete process.env.AGENT_RUNTIME_URL;
    else process.env.AGENT_RUNTIME_URL = originalRuntimeUrl;
  });
  process.env.AGENT_RUNTIME_URL = "https://agent.example";
  let requestCount = 0;
  globalThis.fetch = async (input) => {
    const startIndex = Number(new URL(String(input)).searchParams.get("startIndex") ?? "0");
    requestCount += 1;
    const event = startIndex === 0
      ? { data: {}, meta: { at: "2026-08-03T00:00:00.000Z", id: "evt_01KZ0000000000000000000001" }, type: "session.started" }
      : { data: { wait: "next-user-message" }, meta: { at: "2026-08-03T00:00:01.000Z", id: "evt_01KZ0000000000000000000002" }, type: "session.waiting" };
    return new Response(`${JSON.stringify(event)}\n`, { headers: { "x-eve-stream-tail-index": "1" } });
  };

  const events = await readEveAgentEvents("run-1", "correlation-1", "session-1", "token");
  assert.deepEqual(events.map((event) => event.type), ["session.started", "session.waiting"]);
  assert.equal(requestCount, 2);
});

test("returns immediately when an exhausted cursor is at the durable tail", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalRuntimeUrl = process.env.AGENT_RUNTIME_URL;
  let cancelled = false;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalRuntimeUrl === undefined) delete process.env.AGENT_RUNTIME_URL;
    else process.env.AGENT_RUNTIME_URL = originalRuntimeUrl;
  });
  process.env.AGENT_RUNTIME_URL = "https://agent.example";
  globalThis.fetch = async () => new Response(new ReadableStream({
    cancel() {
      cancelled = true;
    },
  }), { headers: { "x-eve-stream-tail-index": "0" } });

  const events = await readEveAgentEvents("run-1", "correlation-1", "session-1", "token", 1);

  assert.deepEqual(events, []);
  assert.equal(cancelled, true);
});

test("retries transient Eve stream transport failures from the same cursor", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalRuntimeUrl = process.env.AGENT_RUNTIME_URL;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalRuntimeUrl === undefined) delete process.env.AGENT_RUNTIME_URL;
    else process.env.AGENT_RUNTIME_URL = originalRuntimeUrl;
  });
  process.env.AGENT_RUNTIME_URL = "https://agent.example";
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    if (calls === 1) throw new TypeError("socket closed");
    assert.equal(new URL(String(input)).searchParams.get("startIndex"), "0");
    return new Response(JSON.stringify({
      data: {},
      meta: { at: "2026-08-03T00:00:00.000Z", id: "evt_retry" },
      type: "session.started",
    }) + "\n", { headers: { "x-eve-stream-tail-index": "0" } });
  };

  const events = await readEveAgentEvents("run-1", "correlation-1", "session-1", "token");
  assert.equal(events.length, 1);
  assert.equal(calls, 2);
});
