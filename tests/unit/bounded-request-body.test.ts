import assert from "node:assert/strict";
import test from "node:test";

import {
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
} from "../../server/http/bounded-request-body.ts";

test("reads a request body within the byte limit", async () => {
  const request = new Request("http://localhost", {
    method: "POST",
    body: "hello",
  });
  assert.equal(await readRequestTextWithinLimit(request, 5), "hello");
});

test("rejects a declared body before reading it", async () => {
  const request = new Request("http://localhost", {
    method: "POST",
    headers: { "content-length": "6" },
    body: "hello",
  });
  await assert.rejects(
    () => readRequestTextWithinLimit(request, 5),
    (error) => error instanceof RequestBodyTooLargeError && error.maxBytes === 5,
  );
});

test("cancels a chunked body as soon as it crosses the limit", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("1234"));
      controller.enqueue(new TextEncoder().encode("56"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://localhost", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    () => readRequestTextWithinLimit(request, 5),
    RequestBodyTooLargeError,
  );
  assert.equal(cancelled, true);
});

test("rejects an invalid byte limit", async () => {
  const request = new Request("http://localhost", { method: "POST", body: "hello" });
  await assert.rejects(
    () => readRequestTextWithinLimit(request, 0),
    /maxBytes must be a positive safe integer/u,
  );
});
