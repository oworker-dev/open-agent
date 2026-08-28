import { strict as assert } from "node:assert";
import test from "node:test";

import { runBoundedJsonProcess } from "../../lib/bounded-json-process.ts";

const node = process.execPath;

test("bounded JSON process returns parsed output", async () => {
  const result = await runBoundedJsonProcess<{ ok: boolean }>({
    args: ["-e", "process.stdout.write(JSON.stringify({ok:true}))"],
    command: node,
    timeoutMs: 5_000,
  });
  assert.deepEqual(result, { ok: true });
});

test("bounded JSON process rejects and terminates on timeout", async () => {
  await assert.rejects(
    runBoundedJsonProcess({
      args: ["-e", "setTimeout(() => process.stdout.write('{}'), 10_000)"],
      command: node,
      timeoutMs: 1_000,
    }),
    /exceeded 1000ms/,
  );
});

test("bounded JSON process rejects when cancelled", async () => {
  const controller = new AbortController();
  const pending = runBoundedJsonProcess({
    args: ["-e", "setTimeout(() => process.stdout.write('{}'), 10_000)"],
    command: node,
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});
