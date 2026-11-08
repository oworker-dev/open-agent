import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxConnection } from "eve/sandbox/provider";
import { createManagedDockerProvider } from "../../agent/lib/docker-sandbox-provider.ts";

const docker = promisify(execFile);
const image = process.env.TEST_DOCKER_SANDBOX_IMAGE;
const text = (stream: ReadableStream<Uint8Array>) => new Response(stream).text();
async function run(connection: SandboxConnection, command: string, signal?: AbortSignal) {
  const process = await connection.spawn({ command, env: {}, workingDirectory: "/workspace", signal });
  const [result, stdout, stderr] = await Promise.all([process.wait(), text(process.stdout), text(process.stderr)]);
  return { ...result, stdout, stderr };
}

test("Docker public provider enforces limits, preserves files, and kills process trees", { skip: !image, timeout: 60_000 }, async () => {
  const provider = createManagedDockerProvider({
    image: image!, limits: { memoryBytes: 256 * 1024 * 1024, cpus: 0.5, pidsLimit: 64 },
    admission: { maxActive: 1, maxQueued: 2, timeoutMs: 1000 }, idleTimeoutMs: 50,
  });
  const id = `sandbox-provider-test-${randomUUID()}`;
  const ctx = { session: { id }, kind: "session" } as Parameters<typeof provider.start>[0];
  // Exercise the real connection and lifecycle without building a template.
  // Runtime preparation has a separate test below.
  let connection: SandboxConnection | undefined;
  let state: { name: string } | null = null;
  try {
    const started = await provider.start(ctx, { networkPolicy: "deny-all" }, { image: image! });
    connection = started.connection; state = started.state;
    const { stdout } = await docker("docker", ["inspect", state.name]);
    const container = JSON.parse(stdout)[0];
    assert.equal(container.HostConfig.Memory, 256 * 1024 * 1024);
    assert.equal(container.HostConfig.MemorySwap, 256 * 1024 * 1024);
    assert.equal(container.HostConfig.NanoCpus, 500_000_000);
    assert.equal(container.HostConfig.PidsLimit, 64);
    assert.equal(container.HostConfig.NetworkMode, "none");
    assert.equal((await run(connection, "printf 'hello'; printf 'error' >&2")).stdout, "hello");
    // Docker may start setsid as a process-group leader, causing it to fork.
    // wait() must include the actual command and preserve its exit status.
    const delayed = await run(connection, "sleep 0.2; printf completed; exit 7");
    assert.equal(delayed.stdout, "completed");
    assert.equal(delayed.exitCode, 7);
    const path = `/workspace/provider-test-${randomUUID()}/data.bin`;
    const bytes = new Uint8Array([0, 1, 255, 10, 128]);
    await connection.writeFiles({ files: [{ path, content: bytes }] });
    assert.deepEqual(await connection.readFile({ path }), Buffer.from(bytes));
    assert.equal(await connection.readFile({ path: `${path}-missing` }), null);
    await assert.rejects(async () => connection!.readFile({ path: "/workspace" }));
    await connection.close?.();
    assert.equal(JSON.parse((await docker("docker", ["inspect", state.name])).stdout)[0].State.Running, true);
    await delay(150);
    assert.equal(JSON.parse((await docker("docker", ["inspect", state.name])).stdout)[0].State.Running, false);
    connection = await provider.resume(ctx, { image: image! }, state);
    assert.deepEqual(await connection.readFile({ path }), Buffer.from(bytes));
    for (const detached of [false, true]) {
      const controller = new AbortController();
      const process = await connection.spawn({
        // Eve's Bash launcher uses job control. A process-group-only kill
        // misses these descendants, including another setsid session.
        command: `${detached ? "set -m; setsid --wait bash -c 'sleep 60 & echo $! > /workspace/child.pid; wait; touch /workspace/late'" : "bash -c 'sleep 60 & echo $! > /workspace/child.pid; wait; touch /workspace/late'"} & wait`,
        env: {}, workingDirectory: "/workspace", signal: controller.signal,
      });
      const drained = Promise.all([text(process.stdout), text(process.stderr)]);
      while (!await connection.readFile({ path: "/workspace/child.pid" })) await delay(10);
      // Cancelling one connection must not kill another connection's work.
      const other = await provider.resume(ctx, { image: image! }, state);
      const independent = run(other, "sleep 0.3; printf independent");
      controller.abort();
      await assert.rejects(async () => process.wait(), /abort/i);
      await drained;
      assert.equal((await independent).stdout, "independent");
      await other.close?.();
      assert.equal((await run(connection, 'pid=$(cat /workspace/child.pid); test ! -e /proc/$pid/stat || test "$(cut -d " " -f 3 /proc/$pid/stat)" = Z')).exitCode, 0);
      assert.equal(await connection.readFile({ path: "/workspace/late" }), null);
      await connection.removePath({ path: "/workspace/child.pid", force: true });
    }
    await connection.removePath({ path, force: true });
    assert.equal(await connection.readFile({ path }), null);
  } finally {
    await connection?.close?.();
    await provider.onSessionEnd?.(ctx, state, { reason: "deleted", signal: new AbortController().signal });
  }
});
