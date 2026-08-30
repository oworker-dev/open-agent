import assert from "node:assert/strict";
import test from "node:test";

import {
  EveOwnedProviderAttemptError,
  preventReplayAfterStreamStarts,
  ProviderStreamInterruptedError,
  oneProviderAttempt,
} from "../../lib/provider-retry-boundary.ts";

test("wraps one Provider attempt with safe diagnostics and no payload-bearing cause", async () => {
  const privateProbe = "private prompt must not reach telemetry";
  const providerError = Object.assign(new Error(`Rate limited; request=${privateProbe}`), {
    isRetryable: true,
    statusCode: 429,
  });
  await assert.rejects(
    oneProviderAttempt(async () => {
      throw providerError;
    }),
    (error: unknown) =>
      error instanceof EveOwnedProviderAttemptError &&
      error.message === "The model Provider request failed (HTTP 429)." &&
      error.cause === undefined &&
      error.statusCode === 429 &&
      error.isRetryable === true &&
      !error.stack?.includes(privateProbe),
  );
});

test("never copies an unknown Provider error message into the durable error", async () => {
  const privateProbe = "secret request body";
  await assert.rejects(
    oneProviderAttempt(async () => {
      throw new Error(privateProbe);
    }),
    (error: unknown) =>
      error instanceof EveOwnedProviderAttemptError &&
      error.message === "The model Provider request failed." &&
      error.cause === undefined &&
      !error.stack?.includes(privateProbe),
  );
});

test("classifies transient Provider HTTP, timeout, and network failures for Eve", async () => {
  const failures = [
    Object.assign(new Error("request timeout"), { statusCode: 408 }),
    Object.assign(new Error("rate limited"), { statusCode: 429 }),
    Object.assign(new Error("upstream unavailable"), { statusCode: 503 }),
    new DOMException("timed out", "TimeoutError"),
    new TypeError("fetch failed"),
    Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
  ];
  for (const failure of failures) {
    await assert.rejects(
      oneProviderAttempt(async () => { throw failure; }),
      (error: unknown) => error instanceof EveOwnedProviderAttemptError && error.isRetryable === true,
    );
  }
});

test("keeps known permanent Provider rejections out of the transient retry budget", async () => {
  for (const statusCode of [400, 401, 403]) {
    await assert.rejects(
      oneProviderAttempt(async () => { throw Object.assign(new Error("rejected"), { statusCode }); }),
      (error: unknown) => error instanceof EveOwnedProviderAttemptError && error.isRetryable === false,
    );
  }
});

test("treats an unclassified Provider 404 as bounded-retryable", async () => {
  await assert.rejects(
    oneProviderAttempt(async () => {
      throw Object.assign(new Error("route unavailable"), {
        isRetryable: false,
        responseBody: JSON.stringify({ error: { type: "temporary_route_unavailable" } }),
        statusCode: 404,
      });
    }),
    (error: unknown) => error instanceof EveOwnedProviderAttemptError && error.isRetryable === true,
  );
});

test("honors an explicit permanent Provider classification for 404", async () => {
  await assert.rejects(
    oneProviderAttempt(async () => {
      throw Object.assign(new Error("model not found"), {
        isRetryable: false,
        responseBody: JSON.stringify({ error: { type: "model_not_found" } }),
        statusCode: 404,
      });
    }),
    (error: unknown) => error instanceof EveOwnedProviderAttemptError && error.isRetryable === false,
  );
});

test("does not treat a temporary route-not-found message as permanent", async () => {
  await assert.rejects(
    oneProviderAttempt(async () => {
      throw Object.assign(new Error("route not found during deployment"), {
        isRetryable: false,
        responseBody: JSON.stringify({ error: { type: "temporary_route_unavailable" } }),
        statusCode: 404,
      });
    }),
    (error: unknown) => error instanceof EveOwnedProviderAttemptError && error.isRetryable === true,
  );
});

test("preserves abort errors for Eve cancellation", async () => {
  const abort = new DOMException("Cancelled", "AbortError");
  await assert.rejects(
    oneProviderAttempt(async () => {
      throw abort;
    }),
    (error: unknown) => error === abort,
  );
});

test("preserves a stream failure before Provider output so Eve may retry", async () => {
  const providerError = new TypeError("connection failed");
  const stream = preventReplayAfterStreamStarts(new ReadableStream({
    start(controller) {
      controller.error(providerError);
    },
  }));
  await assert.rejects(stream.getReader().read(), (error: unknown) => error === providerError);
});

test("allows Eve to retry an interrupted text-only Provider stream", async () => {
  const providerError = new TypeError("terminated");
  let pullCount = 0;
  const stream = preventReplayAfterStreamStarts(new ReadableStream({
    pull(controller) {
      pullCount += 1;
      if (pullCount === 1) controller.enqueue({ delta: "partial", id: "text-1", type: "text-delta" });
      else controller.error(providerError);
    },
  }));
  const reader = stream.getReader();
  assert.deepEqual(await reader.read(), {
    done: false,
    value: { delta: "partial", id: "text-1", type: "text-delta" },
  });
  await assert.rejects(
    reader.read(),
    (error: unknown) =>
      error instanceof ProviderStreamInterruptedError &&
      error.isRetryable === true &&
      error.cause === undefined,
  );
});

test("converts a post-start error part into a recoverable interruption", async () => {
  const stream = preventReplayAfterStreamStarts(new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start" });
      controller.enqueue({ type: "error", error: new TypeError("terminated") });
      controller.close();
    },
  }));
  const reader = stream.getReader();
  assert.deepEqual(await reader.read(), { done: false, value: { type: "stream-start" } });
  const errorPart = await reader.read();
  assert.equal(errorPart.done, false);
  assert(errorPart.value.error instanceof ProviderStreamInterruptedError);
  assert.equal(errorPart.value.error.cause, undefined);
  assert.equal(errorPart.value.error.isRetryable, true);
});

test("does not automatically replay after a tool boundary", async () => {
  const stream = preventReplayAfterStreamStarts(new ReadableStream({
    start(controller) {
      controller.enqueue({ id: "call-1", toolName: "bash", type: "tool-input-start" });
      controller.enqueue({ error: new TypeError("terminated"), type: "error" });
      controller.close();
    },
  }));
  const reader = stream.getReader();
  assert.equal((await reader.read()).done, false);
  const errorPart = await reader.read();
  assert.equal(errorPart.done, false);
  assert(errorPart.value.error instanceof ProviderStreamInterruptedError);
  assert.equal(errorPart.value.error.isRetryable, false);
  assert.equal(errorPart.value.error.statusCode, 422);
});
