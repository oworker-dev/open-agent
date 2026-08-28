import assert from "node:assert/strict";
import test from "node:test";

import { dispatchMailboxTick } from "../../scripts/lib/mailbox-worker.mjs";

const endpoint = new URL("https://web.example/internal/dispatch");
const secret = "mailbox-worker-test-secret";
type CapturedRequest = { input: RequestInfo | URL; init: RequestInit | undefined };

test("mailbox worker dispatch cancels a successful response body", async () => {
  let cancelled = 0;
  let request: CapturedRequest | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { input, init };
    return {
      body: { cancel: async () => { cancelled += 1; } },
      ok: true,
      status: 200,
    };
  }) as unknown as typeof fetch;
  await dispatchMailboxTick(endpoint, secret, fetchImpl);

  assert.equal(cancelled, 1);
  assert.ok(request);
  assert.equal(request.input, endpoint);
  assert.equal(request.init?.method, "POST");
  assert.equal((request.init?.headers as Record<string, string>).authorization, `Bearer ${secret}`);
  assert.ok(request.init?.signal instanceof AbortSignal);
});

test("mailbox worker dispatch cancels a failed response body and preserves the HTTP error", async () => {
  let cancelled = 0;
  const fetchImpl = (async () => ({
    body: { cancel: async () => { cancelled += 1; } },
    ok: false,
    status: 503,
  })) as unknown as typeof fetch;
  await assert.rejects(
    dispatchMailboxTick(endpoint, secret, fetchImpl),
    /Mailbox dispatcher returned HTTP 503\./u,
  );
  assert.equal(cancelled, 1);
});

test("mailbox worker dispatch ignores response-body cleanup failures", async () => {
  const successFetch = (async () => ({
    body: { cancel: async () => { throw new Error("body already closed"); } },
    ok: true,
    status: 200,
  })) as unknown as typeof fetch;
  await dispatchMailboxTick(endpoint, secret, successFetch);

  const failureFetch = (async () => ({
    body: { cancel: async () => { throw new Error("body already closed"); } },
    ok: false,
    status: 502,
  })) as unknown as typeof fetch;
  await assert.rejects(
    dispatchMailboxTick(endpoint, secret, failureFetch),
    /Mailbox dispatcher returned HTTP 502\./u,
  );
});
