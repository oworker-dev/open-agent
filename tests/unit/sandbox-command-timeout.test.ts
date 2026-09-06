import assert from "node:assert/strict";
import test from "node:test";

import {
  SandboxCommandTimeoutError,
  withSandboxCommandTimeout,
} from "../../lib/sandbox-command-timeout.ts";

test("aborts a foreground sandbox operation at its wall-clock deadline", async () => {
  const parent = new AbortController();
  let observedSignal: AbortSignal | undefined;
  await assert.rejects(
    withSandboxCommandTimeout({
      parentSignal: parent.signal,
      timeoutMs: 20,
      execute: (signal) => {
        observedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    }),
    (error) => error instanceof SandboxCommandTimeoutError
      && error.code === "SANDBOX_COMMAND_TIMEOUT",
  );
  assert.equal(observedSignal?.aborted, true);
});

test("preserves user cancellation instead of relabeling it as a timeout", async () => {
  const parent = new AbortController();
  const cancellation = new DOMException("Cancelled by user.", "AbortError");
  const operation = withSandboxCommandTimeout({
    parentSignal: parent.signal,
    timeoutMs: 100,
    execute: (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  parent.abort(cancellation);
  await assert.rejects(operation, (error) => error === cancellation);
});

test("returns a normally completed command before the deadline", async () => {
  const parent = new AbortController();
  const result = await withSandboxCommandTimeout({
    parentSignal: parent.signal,
    timeoutMs: 100,
    execute: async () => "done",
  });
  assert.equal(result, "done");
});
