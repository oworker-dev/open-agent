import assert from "node:assert/strict";
import test from "node:test";

import type { SandboxBackend, SandboxBackendHandle } from "eve/sandbox";
import {
  SandboxAdmissionError,
  withSandboxAdmission,
} from "../../lib/sandbox-admission-backend.ts";
import { withIdleSandboxShutdown } from "../../lib/idle-sandbox-backend.ts";

test("admits at most the configured number of distinct sandbox sessions", async () => {
  const fixture = fakeBackend();
  const backend = withSandboxAdmission(fixture.backend, 2, 1_000);
  const first = await backend.create(createInput("session-a"));
  const second = await backend.create(createInput("session-b"));
  let thirdResolved = false;
  const thirdPromise = backend.create(createInput("session-c")).then((handle) => {
    thirdResolved = true;
    return handle;
  });

  await delay(20);
  assert.equal(thirdResolved, false);
  assert.deepEqual(fixture.creates, ["session-a", "session-b"]);

  await first.shutdown();
  const third = await thirdPromise;
  assert.equal(thirdResolved, true);
  assert.deepEqual(fixture.creates, ["session-a", "session-b", "session-c"]);
  await Promise.all([second.shutdown(), third.shutdown()]);
});

test("reattaching one session does not consume another permit", async () => {
  const fixture = fakeBackend();
  const backend = withSandboxAdmission(fixture.backend, 1, 1_000);
  const first = await backend.create(createInput("session-a"));
  const second = await backend.create(createInput("session-a"));

  assert.deepEqual(fixture.creates, ["session-a", "session-a"]);
  await first.shutdown();
  let otherResolved = false;
  const otherPromise = backend.create(createInput("session-b")).then((handle) => {
    otherResolved = true;
    return handle;
  });
  await delay(20);
  assert.equal(otherResolved, false);
  await second.shutdown();
  await (await otherPromise).shutdown();
});

test("coalesces concurrent admission for the same session", async () => {
  const fixture = fakeBackend();
  const backend = withSandboxAdmission(fixture.backend, 1, 1_000);
  const [first, second] = await Promise.all([
    backend.create(createInput("session-a")),
    backend.create(createInput("session-a")),
  ]);

  assert.deepEqual(fixture.creates, ["session-a", "session-a"]);
  let otherResolved = false;
  const otherPromise = backend.create(createInput("session-b")).then((handle) => {
    otherResolved = true;
    return handle;
  });
  await first.shutdown();
  await delay(20);
  assert.equal(otherResolved, false);
  await second.shutdown();
  await (await otherPromise).shutdown();
});

test("retains a shared permit when one concurrent backend create fails", async () => {
  const fixture = intermittentlyFailingBackend("session-a");
  const backend = withSandboxAdmission(fixture.backend, 1, 1_000);
  const results = await Promise.allSettled([
    backend.create(createInput("session-a")),
    backend.create(createInput("session-a")),
  ]);
  const handle = results.find((result): result is PromiseFulfilledResult<SandboxBackendHandle> => (
    result.status === "fulfilled"
  ))?.value;
  assert(handle, "one same-session create should remain active");
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);

  let otherResolved = false;
  const otherPromise = backend.create(createInput("session-b")).then((other) => {
    otherResolved = true;
    return other;
  });
  await delay(20);
  assert.equal(otherResolved, false);
  await handle.shutdown();
  await (await otherPromise).shutdown();
});

test("times out before allocating a backend when capacity stays full", async () => {
  const fixture = fakeBackend();
  const backend = withSandboxAdmission(fixture.backend, 1, 20);
  const first = await backend.create(createInput("session-a"));

  await assert.rejects(
    backend.create(createInput("session-b")),
    (error) => error instanceof SandboxAdmissionError && error.code === "SANDBOX_CAPACITY_TIMEOUT",
  );
  assert.deepEqual(fixture.creates, ["session-a"]);
  await first.shutdown();
});

test("releases a permit when backend creation fails", async () => {
  const fixture = fakeBackend(new Set(["session-a"]));
  const backend = withSandboxAdmission(fixture.backend, 1, 1_000);
  await assert.rejects(backend.create(createInput("session-a")), /create failed/u);
  const second = await backend.create(createInput("session-b"));
  assert.deepEqual(fixture.creates, ["session-a", "session-b"]);
  await second.shutdown();
});

test("releases admission when an idle durable sandbox stops", async () => {
  const fixture = fakeBackend();
  const admitted = withSandboxAdmission(fixture.backend, 1, 1_000);
  const backend = withIdleSandboxShutdown(admitted, 10);
  const first = await backend.create(createInput("session-a"));
  await first.captureState();
  await delay(30);

  const second = await backend.create(createInput("session-b"));
  assert.deepEqual(fixture.creates, ["session-a", "session-b"]);
  await second.shutdown();
});

test("validates admission configuration", () => {
  const fixture = fakeBackend();
  assert.throws(() => withSandboxAdmission(fixture.backend, 0, 1_000), /positive integer/u);
  assert.throws(() => withSandboxAdmission(fixture.backend, 1, 0), /positive integer/u);
});

function fakeBackend(failures = new Set<string>()): {
  readonly backend: SandboxBackend;
  readonly creates: string[];
} {
  const creates: string[] = [];
  const backend: SandboxBackend = {
    name: "fake",
    async create(input) {
      creates.push(input.sessionKey);
      if (failures.has(input.sessionKey)) throw new Error("create failed");
      const handle: SandboxBackendHandle = {
        session: {} as never,
        useSessionFn: async () => ({} as never),
        async captureState() {
          return { backendName: "fake", metadata: {}, sessionKey: input.sessionKey };
        },
        async shutdown() {},
      };
      return handle;
    },
    async prewarm() {
      return { reused: true };
    },
  };
  return { backend, creates };
}

function intermittentlyFailingBackend(sessionKey: string): {
  readonly backend: SandboxBackend;
} {
  let failed = false;
  return {
    backend: {
      name: "intermittent",
      async create(input) {
        if (input.sessionKey === sessionKey && !failed) {
          failed = true;
          throw new Error("create failed");
        }
        return {
          session: {} as never,
          useSessionFn: async () => ({} as never),
          async captureState() {
            return { backendName: "intermittent", metadata: {}, sessionKey: input.sessionKey };
          },
          async shutdown() {},
        };
      },
      async prewarm() {
        return { reused: true };
      },
    },
  };
}

function createInput(sessionKey: string) {
  return {
    runtimeContext: { appRoot: process.cwd() },
    sessionKey,
    templateKey: null,
  } as const;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
