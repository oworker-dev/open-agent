// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  dispatchDynamicSkillEvent,
} from "../../node_modules/eve/dist/src/context/dynamic-skill-lifecycle.js";
import {
  DynamicSkillManifestKey,
  SandboxKey,
} from "../../node_modules/eve/dist/src/context/keys.js";
import {
  countActiveSandboxHandles,
  clearActiveSandboxHandlesForTest,
  trackActiveSandboxHandle,
} from "../../node_modules/eve/dist/src/execution/sandbox/active-handles.js";
import {
  ensureSandboxAccess,
} from "../../node_modules/eve/dist/src/execution/sandbox/ensure.js";
import {
  createSession,
} from "../../node_modules/eve/dist/src/channel/session.js";
import { withIdleSandboxShutdown } from "../../lib/idle-sandbox-backend.ts";

test("an empty dynamic Skill manifest does not materialize a sandbox", async () => {
  const values = new Map();
  let sandboxRequests = 0;
  const ctx = fakeContext(values, () => {
    sandboxRequests += 1;
    throw new Error("an empty Skill manifest must not request a sandbox");
  });

  await dispatchDynamicSkillEvent({
    ctx,
    event: { type: "session.started" },
    messages: [],
    resolvers: [dynamicSkillResolver(async () => ({}))],
  });

  assert.equal(sandboxRequests, 0);
  assert.deepEqual(values.get(DynamicSkillManifestKey), {});
});

test("a non-empty dynamic Skill manifest is still materialized", async () => {
  const values = new Map();
  const writes = [];
  let sandboxRequests = 0;
  const sandbox = {
    async run() {
      return { exitCode: 0, stderr: "", stdout: "/home/eve\n" };
    },
    async writeBinaryFile(input) {
      writes.push({ content: Buffer.from(input.content).toString("utf8"), path: input.path });
    },
  };
  const ctx = fakeContext(values, async () => {
    sandboxRequests += 1;
    return sandbox;
  });

  await dispatchDynamicSkillEvent({
    ctx,
    event: { type: "session.started" },
    messages: [],
    resolvers: [dynamicSkillResolver(async () => ({
      diagnostics: {
        description: "Inspect a runtime safely.",
        markdown: "# Diagnostics\n\nInspect before changing state.\n",
      },
    }))],
  });

  assert.equal(sandboxRequests, 2, "materialization and announcement should share the lazy sandbox");
  assert.deepEqual(writes, [{
    content: "# Diagnostics\n\nInspect before changing state.\n",
    path: "/home/eve/.agents/skills/diagnostics/SKILL.md",
  }]);
  assert.deepEqual(values.get(DynamicSkillManifestKey), {
    fixture: [{ description: "Inspect a runtime safely.", name: "diagnostics" }],
  });
});

test("session reset releases handles registered through another module graph", async () => {
  const moduleUrl = pathToFileURL(
    new URL("../../node_modules/eve/dist/src/execution/sandbox/active-handles.js", import.meta.url).pathname,
  );
  const registryA = await import(`${moduleUrl.href}?graph=a`);
  const registryB = await import(`${moduleUrl.href}?graph=b`);
  registryA.clearActiveSandboxHandlesForTest();

  const shutdowns = [];
  await registryA.trackActiveSandboxHandle({
    backendName: "fixture",
    handle: { async shutdown() { shutdowns.push("session-a"); } },
    sessionId: "session-a",
    sessionKey: "sandbox-a",
  });
  await registryA.trackActiveSandboxHandle({
    backendName: "fixture",
    handle: { async shutdown() { shutdowns.push("session-b"); } },
    sessionId: "session-b",
    sessionKey: "sandbox-b",
  });

  assert.equal(registryB.countActiveSandboxHandles(), 2);
  const session = createSession("session-a", {
    async dispatchSession(input) {
      assert.equal(input.sessionId, "session-a");
      assert.equal(input.command.kind, "reset");
      return { previousSessionId: "session-a", status: "reset" };
    },
  });
  await session.reset({ reason: "unit-test" });

  assert.deepEqual(shutdowns, ["session-a"]);
  assert.equal(registryA.countActiveSandboxHandles(), 1);
  await registryB.shutdownActiveSandboxHandles();
  assert.deepEqual(shutdowns, ["session-a", "session-b"]);
});

test("tracked handles unregister only after shutdown succeeds", async () => {
  clearActiveSandboxHandlesForTest();
  let attempts = 0;
  const handle = await trackActiveSandboxHandle({
    backendName: "fixture",
    handle: {
      async shutdown() {
        attempts += 1;
        if (attempts === 1) throw new Error("stop failed");
      },
    },
    sessionId: "session-a",
    sessionKey: "sandbox-a",
  });

  await assert.rejects(handle.shutdown(), /stop failed/u);
  assert.equal(countActiveSandboxHandles(), 1);
  await handle.shutdown();
  assert.equal(countActiveSandboxHandles(), 0);
});

test("idle shutdown unregisters the tracked Eve handle", async () => {
  clearActiveSandboxHandlesForTest();
  let shutdowns = 0;
  const backend = withIdleSandboxShutdown({
    name: "fixture",
    async create(input) {
      return {
        session: {},
        async useSessionFn() { return {}; },
        async captureState() {
          return { backendName: "fixture", metadata: {}, sessionKey: input.sessionKey };
        },
        async shutdown() { shutdowns += 1; },
      };
    },
  }, 10);
  const idleHandle = await backend.create({
    runtimeContext: { appRoot: process.cwd() },
    sessionKey: "sandbox-a",
    templateKey: null,
  });
  const tracked = await trackActiveSandboxHandle({
    backendName: "fixture",
    handle: idleHandle,
    sessionId: "session-a",
    sessionKey: "sandbox-a",
  });

  await tracked.captureState();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(shutdowns, 1);
  assert.equal(countActiveSandboxHandles(), 0);
});

test("a conflicting handle cannot replace compute whose shutdown still fails", async () => {
  clearActiveSandboxHandlesForTest();
  let replacementShutdowns = 0;
  await trackActiveSandboxHandle({
    backendName: "fixture",
    handle: { async shutdown() { throw new Error("stop failed"); } },
    sessionId: "session-a",
    sessionKey: "sandbox-a",
  });

  await assert.rejects(trackActiveSandboxHandle({
    backendName: "fixture",
    handle: { async shutdown() { replacementShutdowns += 1; } },
    sessionId: "session-a",
    sessionKey: "sandbox-a",
  }), /stop failed/u);
  assert.equal(replacementShutdowns, 1);
  assert.equal(countActiveSandboxHandles(), 1);
  clearActiveSandboxHandlesForTest();
});

test("an onSession failure closes and unregisters the created handle", async () => {
  clearActiveSandboxHandlesForTest();
  let shutdowns = 0;
  const access = await ensureSandboxAccess({
    compiledArtifactsSource: { kind: "bundled" },
    nodeId: "__root__",
    registry: {
      sandbox: {
        definition: {
          backend: {
            name: "fixture",
            async create() {
              return {
                session: {},
                async useSessionFn() { return {}; },
                async captureState() {
                  return { backendName: "fixture", metadata: {}, sessionKey: "sandbox-a" };
                },
                async shutdown() { shutdowns += 1; },
              };
            },
          },
          logicalPath: "fixture/sandbox.ts",
          async onSession() { throw new Error("onSession failed"); },
          sourceId: "fixture",
        },
        workspaceResourceRoot: { rootEntries: [] },
      },
    },
    async runOnSession() { throw new Error("onSession failed"); },
    sessionId: "session-a",
    tags: {},
  });

  await assert.rejects(access.get(), /onSession failed/u);
  assert.equal(shutdowns, 1);
  assert.equal(countActiveSandboxHandles(), 0);
});

function dynamicSkillResolver(handler) {
  return {
    eventNames: ["session.started"],
    events: { "session.started": handler },
    slug: "fixture",
  };
}

function fakeContext(values, getSandbox) {
  return {
    get(key) {
      return values.get(key);
    },
    require(key) {
      assert.equal(key, SandboxKey);
      return { get: getSandbox };
    },
    set(key, value) {
      values.set(key, value);
    },
    setVirtualContext(key, value) {
      values.set(key, value);
    },
  };
}
