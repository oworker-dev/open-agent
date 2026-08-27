import assert from "node:assert/strict";
import test from "node:test";

import type { SandboxBackend, SandboxBackendHandle } from "eve/sandbox";
import { withIdleSandboxShutdown } from "../../lib/idle-sandbox-backend.ts";

test("stops idle compute after durable state capture", async () => {
  const fixture = fakeBackend();
  const backend = withIdleSandboxShutdown(fixture.backend, 10);
  const handle = await backend.create(createInput("session-a"));

  await handle.captureState();
  await delay(30);

  assert.equal(fixture.shutdowns.get("session-a"), 1);
});

test("reattach cancels the previous idle stop and hands off to the new handle", async () => {
  const fixture = fakeBackend();
  const backend = withIdleSandboxShutdown(fixture.backend, 20);
  const first = await backend.create(createInput("session-a"));
  await first.captureState();

  const second = await backend.create(createInput("session-a"));
  await delay(30);
  assert.equal(fixture.shutdowns.get("session-a") ?? 0, 0);

  await second.captureState();
  await delay(40);
  assert.equal(fixture.shutdowns.get("session-a"), 1);
});

test("explicit shutdown cancels the idle timer and remains idempotent", async () => {
  const fixture = fakeBackend();
  const backend = withIdleSandboxShutdown(fixture.backend, 10);
  const handle = await backend.create(createInput("session-a"));
  await handle.captureState();

  await Promise.all([handle.shutdown(), handle.shutdown()]);
  await delay(30);

  assert.equal(fixture.shutdowns.get("session-a"), 1);
});

test("rejects an invalid idle timeout", () => {
  const fixture = fakeBackend();
  assert.throws(() => withIdleSandboxShutdown(fixture.backend, 0), /positive integer/u);
});

function fakeBackend(): {
  backend: SandboxBackend;
  shutdowns: Map<string, number>;
} {
  const shutdowns = new Map<string, number>();
  const backend: SandboxBackend = {
    name: "fake",
    async create(input) {
      const handle: SandboxBackendHandle = {
        session: {} as never,
        useSessionFn: async () => ({} as never),
        async captureState() {
          return { backendName: "fake", metadata: {}, sessionKey: input.sessionKey };
        },
        async shutdown() {
          shutdowns.set(input.sessionKey, (shutdowns.get(input.sessionKey) ?? 0) + 1);
        },
      };
      return handle;
    },
    async prewarm() {
      return { reused: true };
    },
  };
  return { backend, shutdowns };
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
