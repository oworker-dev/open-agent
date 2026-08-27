import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { docker } from "eve/sandbox/docker";
import { withIdleSandboxShutdown } from "../lib/idle-sandbox-backend.ts";
import { withSandboxAdmission } from "../lib/sandbox-admission-backend.ts";

if (process.env.RUN_SANDBOX_DOCKER_EVAL !== "1") {
  console.log("sandbox docker eval skipped (set RUN_SANDBOX_DOCKER_EVAL=1)");
  process.exit(0);
}

assertDockerAvailable();

const suffix = randomUUID().replaceAll("-", "");
const templateKey = `open-agent-sandbox-eval-${suffix}`;
const sessionAKey = `open-agent-sandbox-eval-a-${suffix}`;
const sessionBKey = `open-agent-sandbox-eval-b-${suffix}`;
const backend = withIdleSandboxShutdown(
  withSandboxAdmission(
    docker({ networkPolicy: "deny-all", pullPolicy: "never" }),
    1,
    5_000,
  ),
  250,
);
const handles = [];

try {
  const prewarm = await backend.prewarm({
    templateKey,
    runtimeContext: { appRoot: process.cwd() },
    seedFiles: [{ path: "seed/README.txt", content: "seeded by open-agent\n" }],
  });
  assert.equal(prewarm.reused, false, "the isolated eval must build a fresh template");

  const first = await backend.create({
    templateKey,
    sessionKey: sessionAKey,
    runtimeContext: { appRoot: process.cwd() },
    tags: { eval: "sandbox-isolation" },
  });
  handles.push(first);

  assert.equal(first.session.resolvePath("notes/result.txt"), "/workspace/notes/result.txt");
  assert.equal(
    await first.session.readTextFile({ path: "seed/README.txt" }),
    "seeded by open-agent\n",
  );

  await first.session.writeTextFile({ path: "notes/result.txt", content: "session-a-secret\n" });
  const shell = await first.session.run({
    command: "set -eu; pwd; test -f notes/result.txt; grep -R session-a-secret notes; find /workspace -name '*.txt' | sort",
  });
  assert.equal(shell.exitCode, 0, shell.stderr);
  assert.match(shell.stdout, /\/workspace/);
  assert.match(shell.stdout, /session-a-secret/);
  assert.match(shell.stdout, /notes\/result\.txt/);

  // The same durable sandbox keeps /workspace across separate tool calls.
  assert.equal(await first.session.readTextFile({ path: "notes/result.txt" }), "session-a-secret\n");

  const captured = await first.captureState();
  const containerName = captured.metadata.containerName;
  assert.equal(typeof containerName, "string");
  await waitFor(() => !containerRunning(containerName), 5_000);

  const restored = await backend.create({
    existingMetadata: captured.metadata,
    templateKey,
    sessionKey: sessionAKey,
    runtimeContext: { appRoot: process.cwd() },
    tags: { eval: "sandbox-isolation" },
  });
  handles.push(restored);
  assert.equal(
    await restored.session.readTextFile({ path: "notes/result.txt" }),
    "session-a-secret\n",
    "the durable workspace did not survive idle compute shutdown",
  );

  const network = await restored.session.run({
    command: "set -eu; test -z \"$(getent hosts example.com || true)\"; test -z \"$(cat /proc/net/route | awk 'NR > 1 && $2 != \\\"00000000\\\" { print }')\"",
  });
  assert.equal(network.exitCode, 0, `deny-all egress was not enforced: ${network.stderr}`);

  let secondResolved = false;
  const secondPromise = backend.create({
    templateKey,
    sessionKey: sessionBKey,
    runtimeContext: { appRoot: process.cwd() },
    tags: { eval: "sandbox-isolation" },
  }).then((handle) => {
    secondResolved = true;
    return handle;
  });
  await delay(50);
  assert.equal(secondResolved, false, "sandbox admission did not queue the second live session");
  const restoredState = await restored.captureState();
  const restoredContainerName = restoredState.metadata.containerName;
  assert.equal(typeof restoredContainerName, "string");
  await waitFor(() => !containerRunning(restoredContainerName), 5_000);

  const second = await secondPromise;
  handles.push(second);
  const crossSession = await second.session.run({
    command: "test ! -e notes/result.txt && test -f seed/README.txt",
  });
  assert.equal(crossSession.exitCode, 0, "session B observed session A's workspace");
  assert.equal(
    await second.session.readTextFile({ path: "seed/README.txt" }),
    "seeded by open-agent\n",
  );

  const containerNames = execFileSync("docker", ["ps", "-a", "--filter", "label=eve.sandbox=1", "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  assert.match(containerNames, new RegExp(sessionAKey));
  assert.match(containerNames, new RegExp(sessionBKey));

  console.log(JSON.stringify({
    backend: "docker",
    admission: "fifo-single-live-session",
    idleCompute: "stopped-and-restored",
    networkPolicy: "deny-all",
    persistence: "same-session",
    isolation: "cross-session",
    seed: "template",
    sessions: [sessionAKey, sessionBKey],
  }));
} finally {
  for (const handle of handles.reverse()) {
    await handle.shutdown().catch(() => undefined);
    const name = (await handle.captureState().catch(() => undefined))?.metadata?.containerName;
    if (typeof name === "string") {
      try {
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      } catch {
        // Multiple handles can refer to the same durable session container.
      }
    }
  }
}

function assertDockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    throw new Error("RUN_SANDBOX_DOCKER_EVAL=1 requires a reachable Docker daemon.");
  }
}

function containerRunning(name) {
  try {
    return execFileSync(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", name],
      { encoding: "utf8" },
    ).trim() === "true";
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Docker sandbox lifecycle state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
