import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxConnection } from "eve/sandbox/provider";
import { createSandboxComputePool, getSandboxAdmissionStats, SandboxAdmissionError, SandboxAdmissionQueueFullError } from "../../lib/sandbox-compute-pool.ts";

function connection(onClose = () => {}): SandboxConnection {
  return { spawn: async () => { throw new Error("unused"); }, readFile: async () => null, writeFiles: async () => {}, removePath: async () => {}, stop: async () => {}, close: async () => onClose() };
}
const config = { maxActive: 1, maxQueued: 1, timeoutMs: 100, idleTimeoutMs: 20 };

test("closing a step releases its connection, then idle stop releases compute", async () => {
  let stopped = 0; let closed = 0;
  const pool = createSandboxComputePool(config);
  const first = await pool.open("a", async () => connection(() => closed++), async () => { stopped++; });
  await first.close?.();
  assert.equal(closed, 1); assert.equal(stopped, 0);
  assert.equal(getSandboxAdmissionStats()?.activeSessions, 1);
  await delay(40);
  assert.equal(stopped, 1); assert.equal(getSandboxAdmissionStats()?.activeSessions, 0);
});

test("resuming a session shares its permit and cancels the old idle timer", async () => {
  let stopped = 0;
  const pool = createSandboxComputePool(config);
  const stop = async () => { stopped++; };
  const first = await pool.open("a", async () => connection(), stop);
  await first.close?.();
  const next = await pool.open("a", async () => connection(), stop);
  await delay(35);
  assert.equal(stopped, 0); assert.equal(getSandboxAdmissionStats()?.activeSessions, 1);
  await next.stop(); await next.close?.();
  assert.equal(getSandboxAdmissionStats()?.activeSessions, 0);
});

test("capacity queues distinct sessions in FIFO order with a bounded wait list", async () => {
  const pool = createSandboxComputePool(config);
  const first = await pool.open("a", async () => connection(), async () => {});
  let secondConnected = false;
  const second = pool.open("b", async () => { secondConnected = true; return connection(); }, async () => {});
  await assert.rejects(pool.open("c", async () => connection(), async () => {}), SandboxAdmissionQueueFullError);
  assert.equal(secondConnected, false);
  await first.stop(); await first.close?.();
  const admitted = await second;
  assert.equal(secondConnected, true);
  await admitted.stop(); await admitted.close?.();
});

test("failed compute stop keeps its capacity permit until a retry succeeds", async () => {
  const pool = createSandboxComputePool({ ...config, timeoutMs: 20 });
  let fail = true;
  const first = await pool.open("a", async () => connection(), async () => { if (fail) throw new Error("stop failed"); });
  await assert.rejects(first.stop(), /stop failed/);
  const queued = pool.open("b", async () => connection(), async () => {});
  await Promise.all([assert.rejects(queued, SandboxAdmissionError), delay(30)]);
  assert.equal(getSandboxAdmissionStats()?.activeSessions, 1);
  fail = false; await first.stop(); await first.close?.();
  assert.equal(getSandboxAdmissionStats()?.activeSessions, 0);
});

test("deletion releases capacity only after the backend confirms removal", async () => {
  const pool = createSandboxComputePool(config);
  const first = await pool.open("a", async () => connection(), async () => {});
  await assert.rejects(pool.destroy("a", async () => { throw new Error("delete failed"); }), /delete failed/);
  assert.equal(getSandboxAdmissionStats()?.activeSessions, 1);
  await pool.destroy("a", async () => {});
  assert.throws(() => first.readFile({ path: "/workspace/a" }), /connection is closed/);
  await first.close?.();
  assert.equal(getSandboxAdmissionStats()?.activeSessions, 0);
});

test("resume waits for idle stop before reconnecting", async () => {
  const pool = createSandboxComputePool(config);
  let finishStop!: () => void;
  let stopStarted!: () => void;
  const started = new Promise<void>((resolve) => { stopStarted = resolve; });
  const first = await pool.open("race", async () => connection(), async () => {
    stopStarted(); await new Promise<void>((resolve) => { finishStop = resolve; });
  });
  await first.close?.();
  await Promise.all([started, delay(30)]);
  let connected = false;
  const resume = pool.open("race", async () => { connected = true; return connection(); }, async () => {});
  await delay(5); assert.equal(connected, false);
  finishStop();
  const next = await resume;
  assert.equal(getSandboxAdmissionStats()?.activeSessions, 1);
  await next.stop(); await next.close?.();
});

test("deletion waits for opening connection and blocks concurrent resume", async () => {
  const pool = createSandboxComputePool(config);
  let finishConnect!: () => void;
  const opening = pool.open("race", async () => {
    await new Promise<void>((resolve) => { finishConnect = resolve; }); return connection();
  }, async () => {});
  await delay(1);
  let deleted = false;
  const deleting = pool.destroy("race", async () => { deleted = true; });
  let resumed = false;
  const resuming = pool.open("race", async () => { assert.equal(deleted, true); resumed = true; return connection(); }, async () => {});
  assert.equal(deleted, false); assert.equal(resumed, false);
  finishConnect();
  const old = await opening;
  await deleting;
  const current = await resuming;
  assert.throws(() => old.readFile({ path: "/workspace/a" }), /connection is closed/);
  // A stale connection must not stop the replacement compute.
  await old.stop(); await old.close?.();
  assert.equal(getSandboxAdmissionStats()?.activeSessions, 1);
  await current.stop(); await current.close?.();
});

test("failed connection close remains retryable without releasing its reference", async () => {
  const pool = createSandboxComputePool(config);
  let fail = true; let stopped = 0;
  const first = await pool.open("a", async () => connection(() => { if (fail) throw new Error("close failed"); }), async () => { stopped++; });
  await assert.rejects(first.close!(), /close failed/);
  await delay(35); assert.equal(stopped, 0);
  fail = false;
  await first.close?.();
  await delay(35); assert.equal(stopped, 1);
});

test("a failed open releases new compute but preserves another live connection", async () => {
  const pool = createSandboxComputePool(config);
  let stopped = 0;
  const stop = async () => { stopped++; };
  await assert.rejects(pool.open("a", async () => { throw new Error("connect failed"); }, stop), /connect failed/);
  assert.equal(getSandboxAdmissionStats()?.activeSessions, 0);
  const first = await pool.open("a", async () => connection(), stop);
  await assert.rejects(pool.open("a", async () => { throw new Error("connect failed"); }, stop), /connect failed/);
  assert.equal(stopped, 1);
  assert.equal(getSandboxAdmissionStats()?.activeSessions, 1);
  await first.stop(); await first.close?.();
});

test("concurrent same-session opens share one permit and idle waits for every connection", async () => {
  const pool = createSandboxComputePool(config);
  let stopped = 0;
  const stop = async () => { stopped++; };
  const [first, second] = await Promise.all([pool.open("a", async () => connection(), stop), pool.open("a", async () => connection(), stop)]);
  assert.equal(getSandboxAdmissionStats()?.activeSessions, 1);
  await first.close?.(); await delay(30); assert.equal(stopped, 0);
  await second.close?.(); await delay(30); assert.equal(stopped, 1);
});

test("rejects invalid pool configuration before allocating compute", () => {
  for (const property of ["maxActive", "maxQueued", "timeoutMs", "idleTimeoutMs"]) {
    for (const value of [0, -1, NaN, Infinity, 0.5]) assert.throws(() => createSandboxComputePool({ ...config, [property]: value }), /Invalid sandbox pool/);
  }
});
